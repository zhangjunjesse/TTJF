'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../saas/testing.cjs');
const M = require('../model.js');
const S = require('../saas/security.cjs');

const URL = '/api/parent/device';
const state = async (f, user) => (await H.request(f.server, 'GET', '/api/state', undefined, user)).body;
const setting = (f, user, body, server = f.server) => H.request(server, body === undefined ? 'GET' : 'POST', URL, body, user);
async function enable(f, user, credential = H.PIN, server = f.server) {
  const response = await setting(f, user, { enabled: true, credential }, server);
  assert.equal(response.status, 200, response.body.code);
  assert.deepEqual(response.body, { enabled: true, familyId: user.familyId, userId: user.userId });
}
async function protectedAction(f, user, action, revision) {
  const grant = await H.grant(f, user, action, revision);
  const result = await H.request(f.server, 'POST', '/api/action', { revision, action, grant }, user);
  assert.equal(result.status, 200, result.body.code);
  return result.body;
}
const count = async (f, suffix = '', values = []) => (await f.database.query('SELECT count(*) AS n FROM saas_parent_devices ' + suffix, values)).rows[0].n;

test('parent device defaults, credentials and API boundary preserve private family state', async t => {
  const f = await H.fixture(t), owner = await H.family(f, await H.register(f, 'device-boundary@example.test'));
  const off = { enabled: false, familyId: owner.familyId, userId: owner.userId };
  assert.deepEqual((await setting(f, owner)).body, off);
  assert.equal((await setting(f, owner, { enabled: true, credential: H.PIN })).body.code, 'PARENT_SETUP_REQUIRED');
  assert.deepEqual((await setting(f, owner, { enabled: false })).body, off);
  await H.setup(f, owner);
  const before = await state(f, owner);
  for (const body of [{}, { enabled: 'true' }, { enabled: 1 }, { enabled: true, credential: 123456 },
    { enabled: true, credential: 'x'.repeat(129) }, { enabled: false, familyId: owner.familyId }]) {
    assert.equal((await setting(f, owner, body)).body.code, 'VALIDATION_ERROR');
  }
  for (const credential of [undefined, H.PASSWORD, '000000']) {
    assert.equal((await setting(f, owner, { enabled: true, ...(credential === undefined ? {} : { credential }) })).body.code, 'VERIFICATION_FAILED');
  }
  await enable(f, owner);
  await enable(f, owner);
  assert.equal(await count(f), 1, 'enable retries do not duplicate the scoped preference');
  assert.deepEqual(await state(f, owner), before, 'preference changes do not change the ledger, version or parent projection');
  const meta = await H.request(f.server, 'GET', '/api/meta', undefined, owner);
  assert.deepEqual(meta.body.parent, { configured: true, method: 'pin' });
  assert.deepEqual((await setting(f, owner)).body, { enabled: true, familyId: owner.familyId, userId: owner.userId });
  for (const options of [{ noCsrf: true }, { noOrigin: true }, { headers: { Origin: 'https://other.example.test' } }]) {
    const denied = await H.request(f.server, 'POST', URL, { enabled: false }, owner, options);
    assert.equal(denied.status, 403);
    assert.equal((await setting(f, owner)).body.enabled, true);
  }
  const wrongMethod = await H.request(f.server, 'PATCH', URL, { enabled: false }, owner);
  assert.equal(wrongMethod.status, 405); assert.equal(wrongMethod.headers.allow, 'GET, POST');
  assert.equal((await setting(f, { ...owner, familyId: undefined })).body.code, 'FAMILY_REQUIRED');
  const outsider = await H.register(f, 'device-outsider@example.test');
  for (const method of ['GET', 'POST']) {
    const body = method === 'POST' ? { enabled: true, credential: H.PIN } : undefined;
    for (const [actor, status] of [[{ ...outsider, familyId: owner.familyId }, 403], [null, 401]]) {
      const denied = await H.request(f.server, method, URL, body, actor, { headers: { 'X-Family-ID': owner.familyId } });
      assert.equal(denied.status, status); assert.equal(denied.body.enabled, undefined);
      assert.equal(denied.body.parent, undefined); assert.equal(denied.body.state, undefined);
    }
  }
  await f.database.query('UPDATE saas_users SET verified_at=NULL WHERE id=$1', [owner.userId]);
  assert.equal((await setting(f, owner)).body.code, 'EMAIL_UNVERIFIED');
  assert.equal((await setting(f, owner, { enabled: false })).body.code, 'EMAIL_UNVERIFIED');
  await f.database.query('UPDATE saas_users SET verified_at=$2 WHERE id=$1', [owner.userId, new Date(f.clock.value)]);
  const stored = (await f.database.query('SELECT * FROM saas_parent_devices')).rows[0];
  assert.deepEqual(Object.keys(stored).sort(), ['created_at', 'family_id', 'session_hash', 'user_id']);
  assert.equal(stored.session_hash, S.digest(owner.cookie.split('=')[1]));
  assert.ok(!JSON.stringify(stored).includes(H.PIN));
  assert.ok(!JSON.stringify(stored).includes(H.PASSWORD));
  assert.ok(!JSON.stringify(stored).includes(owner.cookie.split('=')[1]));
  assert.equal((await H.request(f.server, 'GET', '/saas/migrations/004-parent-devices.sql')).status, 404);
});

test('parent device whitelist preserves action validation, receipts, versions and explicit grants', async t => {
  const f = await H.fixture(t), second = await f.start();
  const owner = await H.family(f, await H.register(f, 'device-actions@example.test'));
  await H.setup(f, owner); await enable(f, owner);
  let revision = 2;
  const award = { ...H.credit('device-award', 20), saveAsTemplate: true };
  const first = await H.request(f.server, 'POST', '/api/action', { revision, action: award }, owner);
  assert.equal(first.status, 200); revision = first.body.revision;
  assert.equal(M.totals(first.body.state).earned, 20); assert.equal(first.body.state.pointItems.length, 1);
  const replay = await H.request(second, 'POST', '/api/action', { revision: 2, action: award }, owner);
  assert.equal(replay.status, 200); assert.equal(replay.body.revision, revision);
  assert.equal(replay.body.state.points.length, 1);
  assert.equal((await H.request(second, 'POST', '/api/action', { revision, action: { ...award, points: 50 } }, owner)).body.code, 'ACTION_ID_REUSED');
  const raced = await Promise.all([f.server, second].map((server, i) => H.request(server, 'POST', '/api/action',
    { revision, action: H.credit('device-race-' + i, 5) }, owner)));
  assert.deepEqual(raced.map(item => item.status).sort(), [200, 409]);
  revision++;
  assert.equal((await state(f, owner)).state.points.length, 2);
  const rejected = [
    { id: 'device-template-save', type: 'pointItem.save', item: { name: '额外模板', points: 2 } },
    { id: 'device-template-delete', type: 'pointItem.delete', itemId: first.body.state.pointItems[0].id },
    { id: 'device-parent-change', type: 'parent.configure', method: 'pin', pin: '135790' },
    { id: 'device-profile', type: 'profile.update', childName: '更名' },
    { id: 'device-settings', type: 'settings.update', settings: {} },
    { id: 'device-task', type: 'task.save', task: { title: '任务' } },
    { id: 'device-unknown', type: 'future.action' },
    { id: 'device-reward-save-denied', type: 'reward.save', reward: { name: '礼物', points: 2 } }
  ];
  for (const action of rejected) {
    assert.equal((await H.request(f.server, 'POST', '/api/action', { revision, action }, owner)).body.code, 'PARENT_REQUIRED', action.type);
  }
  const invalidGrant = await H.request(f.server, 'POST', '/api/action', { revision, action: H.credit('device-forged'), grant: S.token() }, owner);
  assert.equal(invalidGrant.body.code, 'GRANT_INVALID', 'an explicit grant is still validated while bypass is enabled');
  const rewardAction = { id: 'device-reward-save', type: 'reward.save', reward: { name: '小礼物', points: 2, category: 'daily' } };
  const withReward = await protectedAction(f, owner, rewardAction, revision++);
  const rewardId = withReward.state.rewards[0].id;
  const direct = { id: 'device-redeem', type: 'reward.redeem', rewardId, expectedPoints: 2 };
  const redeemed = await H.request(f.server, 'POST', '/api/action', { revision, action: direct }, owner);
  assert.equal(redeemed.status, 200); revision++;
  assert.equal(M.totals(redeemed.body.state).spent, 2);
  const request = await H.request(f.server, 'POST', '/api/action', { revision, action: { id: 'device-request', type: 'redemption.request', rewardId } }, owner);
  assert.equal(request.status, 200); revision++;
  const approve = { id: 'device-approve', type: 'redemption.approve', requestId: request.body.state.requests[0].id, expectedPoints: 2 };
  const approved = await H.request(f.server, 'POST', '/api/action', { revision, action: approve }, owner);
  assert.equal(approved.status, 200); revision++;
  assert.equal(M.totals(approved.body.state).spent, 4);
  const stable = await state(f, owner);
  for (const action of [H.credit('device-negative', -1), { ...direct, id: 'device-wrong-price', expectedPoints: 1 },
    { ...approve, id: 'device-already-approved' }, { ...direct, id: 'device-missing-reward', rewardId: 'missing' }]) {
    assert.equal((await H.request(f.server, 'POST', '/api/action', { revision, action }, owner)).body.code, 'VALIDATION_ERROR');
  }
  assert.deepEqual(await state(f, owner), stable);
  const expensive = await protectedAction(f, owner, { id: 'device-expensive-save', type: 'reward.save', reward: { name: '大礼物', points: 999, category: 'daily' } }, revision++);
  assert.equal((await H.request(f.server, 'POST', '/api/action', { revision,
    action: { id: 'device-insufficient', type: 'reward.redeem', rewardId: expensive.state.rewards[1].id } }, owner)).body.code, 'VALIDATION_ERROR');
  const authorized = H.credit('device-normal-grant');
  const grant = await H.grant(f, owner, authorized, revision);
  assert.equal((await H.request(second, 'POST', '/api/action', { revision, action: authorized, grant }, owner)).status, 200);
  assert.equal((await f.database.query('SELECT count(*) AS n FROM saas_parent_grants WHERE token_hash=$1', [S.digest(grant)])).rows[0].n, 0);
});

test('parent device scope isolates accounts, logins and families and disabling takes effect at submission', async t => {
  const f = await H.fixture(t), second = await f.start();
  const owner = await H.family(f, await H.register(f, 'device-scope@example.test'), '家庭A');
  const otherFamily = await H.family(f, owner, '家庭B');
  await H.setup(f, owner); await H.setup(f, otherFamily);
  const otherLogin = { ...await H.login(f, owner.email), familyId: owner.familyId };
  const parent = await H.invite(f, owner, await H.register(f, 'device-parent@example.test'));
  await enable(f, owner);
  for (const actor of [otherLogin, parent, otherFamily]) {
    assert.equal((await setting(f, actor)).body.enabled, false);
    assert.equal((await H.request(f.server, 'POST', '/api/action', { revision: 2, action: H.credit('device-scope-denied') }, actor)).body.code, 'PARENT_REQUIRED');
  }
  assert.equal((await setting(f, owner, undefined, second)).body.enabled, true, 'a server restart does not erase the current login preference');
  await enable(f, otherFamily); await enable(f, otherLogin); await enable(f, parent);
  const draft = { revision: 2, action: H.credit('device-before-off') };
  assert.equal((await setting(f, owner, { enabled: false }, second)).body.enabled, false);
  assert.equal((await H.request(f.server, 'POST', '/api/action', draft, owner)).body.code, 'PARENT_REQUIRED');
  assert.equal((await H.request(f.server, 'POST', '/api/action', { ...draft, deviceEnabled: true }, owner)).body.code, 'PARENT_REQUIRED');
  assert.equal((await setting(f, owner, { enabled: false })).body.enabled, false, 'disable retry stays disabled');
  for (const actor of [otherLogin, parent, otherFamily]) assert.equal((await setting(f, actor)).body.enabled, true);
  const grant = await H.grant(f, owner, draft.action);
  assert.equal((await H.request(f.server, 'POST', '/api/action', { ...draft, grant }, owner)).status, 200, 'normal verification works immediately after disabling');
});

test('parent device math mode requires the current account password rather than a math answer or stale PIN', async t => {
  const f = await H.fixture(t), owner = await H.family(f, await H.register(f, 'device-math@example.test'));
  await H.setup(f, owner, 'math');
  const challenge = await H.request(f.server, 'POST', '/api/parent/challenge', { revision: 2, action: H.credit('device-math-challenge') }, owner);
  const numbers = challenge.body.question.match(/\d+/g), answer = String(+numbers[0] + +numbers[1]);
  for (const credential of [answer, H.PIN]) assert.equal((await setting(f, owner, { enabled: true, credential })).body.code, 'VERIFICATION_FAILED');
  await enable(f, owner, H.PASSWORD);
  const applied = await H.request(f.server, 'POST', '/api/action', { revision: 2, action: H.credit('device-math-award') }, owner);
  assert.equal(applied.status, 200); assert.equal(M.totals(applied.body.state).earned, 5);
  const parent = await H.register(f, 'device-math-parent@example.test');
  const ownPassword = 'Different-account-password-17';
  assert.equal((await H.request(f.server, 'POST', '/api/auth/change-password', { currentPassword: H.PASSWORD, password: ownPassword }, parent)).status, 200);
  const member = await H.invite(f, owner, parent);
  assert.equal((await setting(f, member, { enabled: true, credential: H.PASSWORD })).body.code, 'VERIFICATION_FAILED');
  await enable(f, member, ownPassword);
  assert.equal((await setting(f, member, { enabled: false })).body.enabled, false);
});

test('parent device enabling is throttled across current-family sessions while disabling remains available', async t => {
  const f = await H.fixture(t), owner = await H.family(f, await H.register(f, 'device-rates@example.test'));
  await H.setup(f, owner); await enable(f, owner);
  const otherLogin = { ...await H.login(f, owner.email), familyId: owner.familyId };
  for (let i = 0; i < 5; i++) {
    assert.equal((await setting(f, i % 2 ? otherLogin : owner, { enabled: true, credential: '000000' })).body.code, 'VERIFICATION_FAILED');
  }
  const blocked = await setting(f, otherLogin, { enabled: true, credential: H.PIN });
  assert.equal(blocked.status, 429); assert.equal(blocked.body.code, 'RATE_LIMITED'); assert.ok(+blocked.headers['retry-after'] > 0);
  assert.equal((await setting(f, owner, { enabled: false })).body.enabled, false);
  assert.equal((await H.request(f.server, 'POST', '/api/action', { revision: 2, action: H.credit('device-rate-disabled') }, owner)).body.code, 'PARENT_REQUIRED');
  f.clock.value += 300001;
  for (let i = 0; i < 10; i++) await enable(f, owner);
  assert.equal((await setting(f, owner, { enabled: true, credential: H.PIN })).body.code, 'RATE_LIMITED', 'successful enable requests are bounded too');
  assert.equal((await setting(f, owner, { enabled: false })).status, 200);
});

test('parent device changing family PIN revokes every family login and leaves other families independent', async t => {
  const f = await H.fixture(t), owner = await H.family(f, await H.register(f, 'device-pin-change@example.test'));
  const otherFamily = await H.family(f, owner, '其他家庭');
  await H.setup(f, owner); await H.setup(f, otherFamily);
  const parent = await H.invite(f, owner, await H.register(f, 'device-pin-change-parent@example.test'));
  const otherLogin = { ...await H.login(f, owner.email), familyId: owner.familyId };
  for (const actor of [owner, parent, otherLogin, otherFamily]) await enable(f, actor);
  const action = { id: 'device-new-pin', type: 'parent.configure', method: 'pin', pin: '135790', confirmPin: '135790' };
  assert.equal((await H.request(f.server, 'POST', '/api/action', { revision: 2, action }, owner)).body.code, 'PARENT_REQUIRED');
  await protectedAction(f, owner, action, 2);
  for (const actor of [owner, parent, otherLogin]) {
    assert.equal((await setting(f, actor)).body.enabled, false);
    assert.equal((await H.request(f.server, 'POST', '/api/action', { revision: 3, action: H.credit('device-revoked-pin') }, actor)).body.code, 'PARENT_REQUIRED');
  }
  assert.equal((await setting(f, otherFamily)).body.enabled, true);
  assert.equal((await setting(f, owner, { enabled: true, credential: H.PIN })).body.code, 'VERIFICATION_FAILED');
  await enable(f, owner, '135790');
  const switchToMath = { id: 'device-switch-math', type: 'parent.configure', method: 'math' };
  const challenge = await H.request(f.server, 'POST', '/api/parent/challenge', { revision: 3, action: switchToMath }, owner);
  const verified = await H.request(f.server, 'POST', '/api/parent/verify', { challengeId: challenge.body.challengeId, answer: '135790' }, owner);
  assert.equal((await H.request(f.server, 'POST', '/api/action', { revision: 3, action: switchToMath, grant: verified.body.grant }, owner)).status, 200);
  assert.equal((await setting(f, owner)).body.enabled, false, 'changing verification method revokes bypass too');
});

test('parent device changing and resetting account password revokes scoped preferences', async t => {
  const f = await H.fixture(t), owner = await H.family(f, await H.register(f, 'device-password@example.test'));
  const otherFamily = await H.family(f, owner, '密码家庭B');
  await H.setup(f, owner); await H.setup(f, otherFamily);
  const otherLogin = { ...await H.login(f, owner.email), familyId: owner.familyId };
  const parent = await H.invite(f, owner, await H.register(f, 'device-password-parent@example.test'));
  for (const actor of [owner, otherFamily, otherLogin, parent]) await enable(f, actor);
  const newPassword = 'Current-session-password-42';
  assert.equal((await H.request(f.server, 'POST', '/api/auth/change-password', { currentPassword: H.PASSWORD, password: newPassword }, owner)).status, 200);
  assert.equal(await count(f, 'WHERE user_id=$1', [owner.userId]), 0);
  for (const actor of [owner, otherFamily]) assert.equal((await setting(f, actor)).body.enabled, false);
  assert.equal((await setting(f, otherLogin)).status, 401);
  assert.equal((await setting(f, parent)).body.enabled, true);
  await enable(f, owner);
  assert.equal((await H.request(f.server, 'POST', '/api/auth/forgot-password', { email: owner.email })).status, 202);
  const token = H.mailToken(f, owner.email, 'reset');
  assert.equal((await H.request(f.server, 'POST', '/api/auth/reset-password', { token, password: 'Reset-session-password-42' })).status, 200);
  assert.equal(await count(f, 'WHERE user_id=$1', [owner.userId]), 0);
  assert.equal((await setting(f, owner)).status, 401);
  const fresh = { ...await H.login(f, owner.email, 'Reset-session-password-42'), familyId: owner.familyId };
  assert.equal((await setting(f, fresh)).body.enabled, false);
  assert.equal((await H.request(f.server, 'POST', '/api/action', { revision: 2, action: H.credit('device-after-reset') }, fresh)).body.code, 'PARENT_REQUIRED');
});

test('parent device logout and expired sessions cannot keep a trusted login alive', async t => {
  const f = await H.fixture(t, { maintenanceIntervalMs: 0 });
  const owner = await H.family(f, await H.register(f, 'device-session@example.test'));
  const otherFamily = await H.family(f, owner, '会话家庭B');
  await H.setup(f, owner); await H.setup(f, otherFamily);
  const otherLogin = { ...await H.login(f, owner.email), familyId: owner.familyId };
  for (const actor of [owner, otherFamily, otherLogin]) await enable(f, actor);
  assert.equal((await H.request(f.server, 'POST', '/api/auth/logout', {}, owner)).status, 200);
  assert.equal((await setting(f, owner)).status, 401); assert.equal(await count(f), 1);
  assert.equal((await setting(f, otherLogin)).body.enabled, true);
  const fresh = { ...await H.login(f, owner.email), familyId: owner.familyId };
  assert.equal((await setting(f, fresh)).body.enabled, false); await enable(f, fresh);
  f.clock.value += 14 * 86400000 + 1;
  for (const actor of [fresh, otherLogin]) {
    assert.equal((await setting(f, actor)).status, 401);
    assert.equal((await setting(f, actor, { enabled: true, credential: H.PIN })).status, 401);
    assert.equal((await H.request(f.server, 'POST', '/api/action', { revision: 2, action: H.credit('device-expired') }, actor)).status, 401);
  }
  await f.server.ops.cleanupExpired();
  assert.equal(await count(f), 0, 'session maintenance cascades its obsolete preferences');
});

test('parent device membership removal, leaving, account and family deletion revoke preference', async t => {
  const f = await H.fixture(t), owner = await H.family(f, await H.register(f, 'device-members@example.test'));
  await H.setup(f, owner);
  let parent = await H.invite(f, owner, await H.register(f, 'device-member-parent@example.test'));
  const otherLogin = { ...await H.login(f, parent.email), familyId: owner.familyId };
  for (const actor of [owner, parent, otherLogin]) await enable(f, actor);
  const membership = '/api/families/' + owner.familyId + '/members/' + parent.userId;
  assert.equal((await H.request(f.server, 'DELETE', membership, {}, owner)).status, 200);
  assert.equal(await count(f, 'WHERE user_id=$1', [parent.userId]), 0);
  for (const actor of [parent, otherLogin]) {
    assert.equal((await setting(f, actor)).body.code, 'FAMILY_FORBIDDEN');
    assert.equal((await H.request(f.server, 'POST', '/api/action', { revision: 2, action: H.credit('device-removed') }, actor)).body.code, 'FAMILY_FORBIDDEN');
  }
  parent = await H.invite(f, owner, parent);
  assert.equal((await setting(f, parent)).body.enabled, false, 'rejoining never revives previous approval');
  await enable(f, parent);
  assert.equal((await H.request(f.server, 'POST', '/api/families/' + owner.familyId + '/leave', {}, parent)).status, 200);
  assert.equal(await count(f, 'WHERE user_id=$1', [parent.userId]), 0);
  parent = await H.invite(f, owner, parent); await enable(f, parent);
  assert.equal((await H.request(f.server, 'POST', '/api/auth/delete-account', { email: parent.email, currentPassword: H.PASSWORD }, parent)).status, 200);
  assert.equal(await count(f, 'WHERE user_id=$1', [parent.userId]), 0);
  assert.equal((await H.request(f.server, 'DELETE', '/api/families/' + owner.familyId, { name: '测试家庭', currentPassword: H.PASSWORD }, owner)).status, 200);
  assert.equal(await count(f), 0);
});
