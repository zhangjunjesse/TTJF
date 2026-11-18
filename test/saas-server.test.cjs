'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../model.js');
const H = require('../saas/testing.cjs');
const S = require('../saas/security.cjs');

test('real SQLite all business endpoints, replays and conflicts are tenant-authorized before returning data', async t => {
  const f = await H.fixture(t), second = await f.start();
  const a = await H.family(f, await H.register(f, 'tenant-a@example.test'), 'A', 'A孩子');
  const b = await H.family(f, await H.register(f, 'tenant-b@example.test'), 'B', 'B孩子');
  await H.setup(f, a); await H.setup(f, b);
  const action = H.credit('same-object-action', 7);
  for (const user of [a, b]) {
    const token = await H.grant(f, user, action);
    const applied = await H.request(f.server, 'POST', '/api/action', { revision: 2, action, grant: token }, user);
    assert.equal(applied.status, 200); assert.equal(applied.body.familyId, user.familyId); assert.equal(applied.body.userId, user.userId);
  }
  for (const user of [a, b]) {
    const replay = await H.request(second, 'POST', '/api/action', { revision: 2, action }, user);
    assert.equal(replay.status, 200); assert.equal(replay.body.revision, 3);
    assert.equal(M.totals(replay.body.state).earned, 7); assert.equal(replay.body.state.childName, user === a ? 'A孩子' : 'B孩子');
    const conflict = await H.request(second, 'POST', '/api/action', { revision: 2, action: H.credit('new-' + user.userId) }, user);
    assert.equal(conflict.status, 409); assert.equal(conflict.body.familyId, user.familyId); assert.equal(conflict.body.userId, user.userId);
  }
  const routes = [['GET', '/api/state'], ['GET', '/api/meta'], ['POST', '/api/action', { revision: 2, action }],
    ['POST', '/api/action', { revision: 1, action: H.credit('conflict') }],
    ['POST', '/api/parent/challenge', { revision: 1, action: H.credit('challenge') }],
    ['POST', '/api/parent/verify', { challengeId: S.token(), answer: H.PIN }], ['POST', '/api/assistant', { text: '积分多少' }]];
  for (const [method, route, body] of routes) {
    const denied = await H.request(second, method, route, body, { ...a, familyId: b.familyId });
    assert.equal(denied.status, 403, route); assert.equal(denied.body.code, 'FAMILY_FORBIDDEN');
    assert.equal(denied.body.state, undefined); assert.equal(denied.body.parent, undefined); assert.equal(denied.body.revision, undefined);
    assert.equal(denied.body.userId, a.userId); assert.equal(denied.body.familyId, b.familyId);
    const anonymous = await H.request(second, method, route, body, null, { headers: { 'X-Family-ID': b.familyId } });
    assert.equal(anonymous.status, 401, route); assert.equal(anonymous.body.state, undefined);
  }
  const altered = await H.request(second, 'POST', '/api/action', { revision: 3, action: { ...action, points: 900 } }, a);
  assert.equal(altered.body.code, 'ACTION_ID_REUSED');
  const secret = JSON.stringify((await H.request(f.server, 'GET', '/api/state', undefined, a)).body);
  for (const key of ['salt', 'hash', 'receipt', H.PIN]) { assert.ok(!secret.includes('"' + key + '"')); }
  const privateReceipt = (await f.database.query("SELECT receipt FROM saas_action_receipts WHERE family_id=$1 AND action_id='setup'", [a.familyId])).rows[0].receipt;
  assert.equal(privateReceipt.algorithm, 'scrypt'); assert.equal(privateReceipt.n, 32768);
});

test('real SQLite optional credit reasons keep grants, idempotency and durable empty ledger text', async t => {
  const f = await H.fixture(t);
  const owner = await H.family(f, await H.register(f, 'optional-reason@example.test'));
  await H.setup(f, owner, 'math');
  const independent = await f.openDatabase();
  const second = await f.start({ database: independent });
  const commands = [
    { id: 'optional-missing', type: 'points.add', name: '阅读', points: 3 },
    { id: 'optional-null', type: 'points.add', name: '专心练习', points: 3, reason: null },
    { id: 'optional-whitespace', type: 'points.add', name: '整理文具', points: 3, reason: ' \t\n ', saveAsTemplate: true }
  ];
  let revision = 2;
  for (const action of commands) {
    const denied = await H.request(f.server, 'POST', '/api/action', { revision, action }, owner);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'PARENT_REQUIRED');
    const grant = await H.grant(f, owner, action, revision);
    const changed = await H.request(second, 'POST', '/api/action', {
      revision, action: { ...action, reason: '后来补充的原因' }, grant
    }, owner);
    assert.equal(changed.status, 403);
    assert.equal(changed.body.code, 'GRANT_INVALID');
    const applied = await H.request(f.server, 'POST', '/api/action', { revision, action, grant }, owner);
    assert.equal(applied.status, 200);
    assert.equal(applied.body.revision, revision + 1);
    assert.equal(applied.body.state.points.at(-1).reason, '');
    const replay = await H.request(second, 'POST', '/api/action', { revision, action }, owner);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, applied.body);
    assert.equal(replay.body.state.points.length, revision - 1);
    revision += 1;
  }
  const stored = (await independent.query('SELECT state,revision FROM saas_families WHERE id=$1', [owner.familyId])).rows[0];
  assert.deepEqual(stored.state.points.map(row => row.reason), ['', '', '']);
  assert.equal(stored.state.pointItems.at(-1).reason, '');
  assert.deepEqual(M.totals(stored.state), { earned: 9, spent: 0, available: 9 });
  assert.equal((await independent.query('SELECT count(*) AS n FROM saas_parent_grants WHERE family_id=$1', [owner.familyId])).rows[0].n, 0);
  await f.server.closeSaas();
  const reloaded = await H.request(second, 'GET', '/api/state', undefined, owner);
  assert.equal(reloaded.status, 200);
  assert.equal(reloaded.body.revision, revision);
  assert.deepEqual(reloaded.body.state, stored.state);
});

test('real SQLite challenges and grants bind family, user, session, full action and revision across request handlers', async t => {
  const f = await H.fixture(t), second = await f.start();
  const owner = await H.family(f, await H.register(f, 'grants-owner@example.test'));
  const parent = await H.invite(f, owner, await H.register(f, 'grants-parent@example.test'));
  const otherFamily = await H.family(f, owner, '其他家');
  await H.setup(f, owner); await H.setup(f, otherFamily);
  const session2 = { ...await H.login(f, owner.email), familyId: owner.familyId };
  const action = H.credit('bind-action');
  const challenge = await H.request(f.server, 'POST', '/api/parent/challenge', { revision: 2, action }, owner);
  assert.equal(challenge.status, 200);
  for (const outsider of [parent, session2, otherFamily]) {
    const response = await H.request(second, 'POST', '/api/parent/verify', { challengeId: challenge.body.challengeId, answer: H.PIN }, outsider);
    assert.equal(response.status, 410);
  }
  const verify = await H.request(second, 'POST', '/api/parent/verify', { challengeId: challenge.body.challengeId, answer: H.PIN }, owner);
  assert.equal(verify.status, 200);
  assert.equal((await H.request(f.server, 'POST', '/api/parent/verify', { challengeId: challenge.body.challengeId, answer: H.PIN }, owner)).status, 410);
  for (const outsider of [parent, session2, otherFamily]) {
    assert.equal((await H.request(second, 'POST', '/api/action', { revision: 2, action, grant: verify.body.grant }, outsider)).body.code, 'GRANT_INVALID');
  }
  assert.equal((await H.request(second, 'POST', '/api/action', { revision: 2, action: { ...action, points: 50 }, grant: verify.body.grant }, owner)).body.code, 'GRANT_INVALID');
  assert.equal((await H.request(f.server, 'POST', '/api/action', { revision: 2, action, grant: verify.body.grant }, owner)).status, 200);
  const later = H.credit('expired-grant'), token = await H.grant(f, owner, later, 3);
  f.clock.value += 60001;
  assert.equal((await H.request(second, 'POST', '/api/action', { revision: 3, action: later, grant: token }, owner)).body.code, 'GRANT_EXPIRED');
});

test('real SQLite invitations are owner-only, email-bound, expiring, revocable and consumed atomically once', async t => {
  const f = await H.fixture(t), second = await f.start();
  const owner = await H.family(f, await H.register(f, 'invite-owner@example.test'));
  const target = await H.register(f, 'target@example.test'), wrong = await H.register(f, 'wrong@example.test');
  const url = '/api/families/' + owner.familyId + '/invitations';
  const sent = await H.request(f.server, 'POST', url, { email: target.email }, owner);
  assert.equal(sent.status, 200); assert.equal(sent.body.invitation.token, undefined);
  const token = H.mailToken(f, target.email, 'invite');
  assert.equal((await H.request(second, 'POST', '/api/invitations/accept', { token }, wrong)).body.code, 'INVITATION_INVALID');
  const accepted = await Promise.all([f.server, second].map(server => H.request(server, 'POST', '/api/invitations/accept', { token }, target)));
  assert.deepEqual(accepted.map(r => r.status).sort(), [200, 400]);
  const parent = { ...target, familyId: owner.familyId };
  const setup = await H.request(second, 'POST', '/api/action', { revision: 1, action: { id: 'parent-setup', type: 'parent.setup', method: 'math' } }, parent);
  assert.equal(setup.body.code, 'OWNER_REQUIRED');
  assert.equal((await H.request(second, 'POST', url, { email: wrong.email }, parent)).body.code, 'OWNER_REQUIRED');
  assert.equal((await H.request(second, 'GET', url, undefined, parent)).body.code, 'OWNER_REQUIRED');
  assert.equal((await H.request(second, 'DELETE', '/api/families/' + owner.familyId + '/members/' + owner.userId, {}, owner)).body.code, 'OWNER_PROTECTED');
  await H.setup(f, owner, 'math');
  const action = H.credit('parent-credit');
  const grant = await H.grant(f, parent, action);
  assert.equal((await H.request(f.server, 'POST', '/api/action', { revision: 2, action, grant }, parent)).status, 200);
  const unusedAction = H.credit('unused-after-removal');
  const unusedGrant = await H.grant(f, parent, unusedAction, 3);
  const pending = await H.request(f.server, 'POST', '/api/parent/challenge', { revision: 3, action: H.credit('pending') }, parent);
  assert.equal(pending.status, 200);
  const removed = await H.request(second, 'DELETE', '/api/families/' + owner.familyId + '/members/' + target.userId, {}, owner);
  assert.equal(removed.status, 200);
  assert.equal((await f.database.query('SELECT count(*) AS n FROM saas_parent_grants WHERE user_id=$1', [target.userId])).rows[0].n, 0);
  for (const [path, body] of [['/api/action', { revision: 1, action, grant }], ['/api/action', { revision: 3, action: unusedAction, grant: unusedGrant }], ['/api/parent/verify', { challengeId: pending.body.challengeId, answer: '1' }]]) {
    const denied = await H.request(second, 'POST', path, body, parent);
    assert.equal(denied.body.code, 'FAMILY_FORBIDDEN'); assert.equal(denied.body.state, undefined);
  }
  assert.equal((await H.request(second, 'GET', '/api/state', undefined, parent)).body.code, 'FAMILY_FORBIDDEN');
  const resent = await H.request(f.server, 'POST', url, { email: target.email }, owner);
  const revokedToken = H.mailToken(f, target.email, 'invite');
  assert.equal((await H.request(second, 'DELETE', url + '/' + resent.body.invitation.id, {}, owner)).status, 200);
  assert.equal((await H.request(second, 'POST', '/api/invitations/accept', { token: revokedToken }, target)).body.code, 'INVITATION_INVALID');
  await H.request(f.server, 'POST', url, { email: target.email }, owner);
  const expiredToken = H.mailToken(f, target.email, 'invite');
  f.clock.value += 7 * 86400000 + 1;
  assert.equal((await H.request(second, 'POST', '/api/invitations/accept', { token: expiredToken }, target)).body.code, 'INVITATION_INVALID');
  const listed = await H.request(second, 'GET', url, undefined, owner);
  assert.equal(listed.status, 200); assert.ok(listed.body.invitations.some(i => i.status === 'expired'));
  assert.ok(!JSON.stringify(listed.body).includes(expiredToken));
});

test('UUID case variants identify the same family, invitation and member through HTTP', async t => {
  const f = await H.fixture(t), second = await f.start();
  const owner = await H.family(f, await H.register(f, 'uuid-owner@example.test'));
  const target = await H.register(f, 'uuid-parent@example.test');
  const upperOwner = { ...owner, familyId: owner.familyId.toUpperCase() };
  const route = '/api/families/' + upperOwner.familyId;
  const lowerState = await H.request(f.server, 'GET', '/api/state', undefined, owner);
  const upperState = await H.request(second, 'GET', '/api/state', undefined, upperOwner);
  assert.equal(upperState.status, 200); assert.deepEqual(upperState.body, lowerState.body);
  const members = await H.request(second, 'GET', route + '/members', undefined, upperOwner);
  assert.equal(members.status, 200); assert.equal(members.body.members[0].userId, owner.userId);
  const sent = await H.request(second, 'POST', route + '/invitations', { email: target.email }, upperOwner);
  assert.equal(sent.status, 200);
  const oldToken = H.mailToken(f, target.email, 'invite');
  assert.equal((await H.request(f.server, 'DELETE', route + '/invitations/' + sent.body.invitation.id.toUpperCase(), {}, upperOwner)).status, 200);
  assert.equal((await H.request(f.server, 'POST', '/api/invitations/accept', { token: oldToken }, target)).body.code, 'INVITATION_INVALID');
  const parent = await H.invite(f, owner, target);
  const removed = await H.request(second, 'DELETE', route + '/members/' + parent.userId.toUpperCase(), {}, upperOwner);
  assert.equal(removed.status, 200);
  assert.equal((await H.request(f.server, 'GET', '/api/state', undefined, parent)).body.code, 'FAMILY_FORBIDDEN');
});

test('delayed assistant output is re-authorized after member removal and never returns stale family data', async t => {
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const output = new Promise(resolve => { release = resolve; });
  let passedState;
  const f = await H.fixture(t, { assistantService: { status: () => ({ mode: 'local', label: '测试' }),
    interpret: async (_text, state) => { passedState = state; started(); return output; } } });
  const owner = await H.family(f, await H.register(f, 'async-owner@example.test'));
  const parent = await H.invite(f, owner, await H.register(f, 'async-parent@example.test'));
  const pending = H.request(f.server, 'POST', '/api/assistant', { text: '积分多少' }, parent);
  await began;
  assert.equal(passedState.childAvatar, undefined);
  assert.equal((await H.request(f.server, 'DELETE', '/api/families/' + owner.familyId + '/members/' + parent.userId, {}, owner)).status, 200);
  release({ kind: 'query', privateEcho: 'old family data' });
  const response = await pending;
  assert.equal(response.body.code, 'FAMILY_FORBIDDEN'); assert.equal(response.body.privateEcho, undefined);
});

test('real HTTP business loop keeps farm welcome gift, eight-hour crop timing and no-grant point protection', async t => {
  const f = await H.fixture(t);
  const owner = await H.family(f, await H.register(f, 'farm@example.test'));
  let revision = 1;
  async function apply(action) {
    const response = await H.request(f.server, 'POST', '/api/action', { revision, action }, owner);
    if (response.status === 200) { revision = response.body.revision; }
    return response;
  }
  const started = await apply({ id: 'start', type: 'farm.start' });
  assert.equal(started.status, 200); assert.equal(started.body.familyDay, '2026-11-16');
  assert.equal((await apply({ id: 'second-start', type: 'farm.start' })).status, 400);
  const harvested = await apply({ id: 'welcome', type: 'farm.harvest', plotIds: ['p1'] });
  assert.equal(harvested.body.state.farm.inventory.carrot, 3);
  const replay = await H.request(f.server, 'POST', '/api/action', { revision: 1, action: { id: 'welcome', type: 'farm.harvest', plotIds: ['p1'] } }, owner);
  assert.equal(replay.body.state.farm.inventory.carrot, 3);
  const planted = await apply({ id: 'plant', type: 'farm.plant', cropId: 'carrot', plotIds: ['p1'] });
  assert.equal(Date.parse(planted.body.state.farm.plots[0].readyAt) - Date.parse(planted.body.state.farm.plots[0].plantedAt), 8 * 3600000);
  assert.equal((await apply({ id: 'early', type: 'farm.harvest', plotIds: ['p1'] })).status, 400);
  f.clock.value += 8 * 3600000;
  const matured = await apply({ id: 'grown', type: 'farm.harvest', plotIds: ['p1'] });
  assert.equal(matured.body.state.farm.inventory.carrot, 6); assert.equal(matured.body.familyDay, '2026-11-17');
  assert.deepEqual(M.totals(matured.body.state), { earned: 0, spent: 0, available: 0 });
  assert.equal((await apply(H.credit('forged-points'))).body.code, 'PARENT_SETUP_REQUIRED');
  assert.equal((await apply({ id: 'forged-plant', type: 'farm.plant', cropId: 'carrot', points: 900 })).status, 400);
});

test('assistant concurrency leases are shared across request handlers, family scoped and recover after lease expiry', async t => {
  let entered;
  const bothEntered = new Promise(resolve => { entered = resolve; });
  const releases = [];
  const f = await H.fixture(t, { assistantService: { status: () => ({ mode: 'local', label: '测试' }),
    interpret: async text => {
      if (text !== 'wait') { return { kind: 'clarify', question: 'ready' }; }
      return new Promise(resolve => { releases.push(resolve); if (releases.length === 2) { entered(); } });
    } } });
  const second = await f.start();
  const a = await H.family(f, await H.register(f, 'lease-a@example.test'));
  const b = await H.family(f, await H.register(f, 'lease-b@example.test'));
  const pending = [f.server, second].map(server => H.request(server, 'POST', '/api/assistant', { text: 'wait' }, a));
  await bothEntered;
  try {
    assert.equal((await H.request(second, 'POST', '/api/assistant', { text: 'third' }, a)).status, 429);
    assert.equal((await H.request(second, 'POST', '/api/assistant', { text: 'other family' }, b)).status, 200);
    assert.equal((await f.database.query('SELECT count(*) AS n FROM saas_assistant_leases')).rows[0].n, 2);
  } finally { for (const release of releases) { release({ kind: 'clarify', question: 'done' }); } }
  assert.deepEqual((await Promise.all(pending)).map(r => r.status), [200, 200]);
  assert.equal((await f.database.query('SELECT count(*) AS n FROM saas_assistant_leases')).rows[0].n, 0);
  const sessionHash = S.digest(a.cookie.split('=')[1]);
  for (let i = 0; i < 2; i++) {
    await f.database.query('INSERT INTO saas_assistant_leases(id,family_id,user_id,session_hash,expires_at) VALUES($1,$2,$3,$4,$5)',
      [require('node:crypto').randomUUID(), a.familyId, a.userId, sessionHash, new Date(f.clock.value + 30000)]);
  }
  assert.equal((await H.request(second, 'POST', '/api/assistant', { text: 'crashed workers' }, a)).status, 429);
  f.clock.value += 30001;
  assert.equal((await H.request(second, 'POST', '/api/assistant', { text: 'recovered' }, a)).status, 200);
  assert.equal((await f.database.query('SELECT count(*) AS n FROM saas_assistant_leases')).rows[0].n, 0);
});

test('PIN-changing challenges, grants and receipts never introduce a fast PIN fingerprint', async t => {
  const f = await H.fixture(t);
  const owner = await H.family(f, await H.register(f, 'pin-change@example.test'));
  await H.setup(f, owner);
  const action = { id: 'new-pin', type: 'parent.configure', method: 'pin', pin: '135790', confirmPin: '135790' };
  const challenge = await H.request(f.server, 'POST', '/api/parent/challenge', { revision: 2, action }, owner);
  assert.equal(challenge.status, 200);
  const storedChallenge = (await f.database.query('SELECT action_receipt FROM saas_parent_challenges')).rows[0].action_receipt;
  assert.equal(storedChallenge.algorithm, 'scrypt'); assert.equal(storedChallenge.n, 32768);
  assert.ok(!JSON.stringify(storedChallenge).includes(action.pin));
  const verify = await H.request(f.server, 'POST', '/api/parent/verify', { challengeId: challenge.body.challengeId, answer: H.PIN }, owner);
  assert.equal(verify.status, 200);
  const storedGrant = (await f.database.query('SELECT action_receipt FROM saas_parent_grants')).rows[0].action_receipt;
  assert.deepEqual(storedGrant, storedChallenge);
  assert.equal((await H.request(f.server, 'POST', '/api/action', { revision: 2, action, grant: verify.body.grant }, owner)).status, 200);
  assert.equal((await H.request(f.server, 'POST', '/api/action', { revision: 2, action }, owner)).status, 200);
  const receipt = (await f.database.query("SELECT receipt FROM saas_action_receipts WHERE action_id='new-pin'")).rows[0].receipt;
  assert.equal(receipt.algorithm, 'scrypt'); assert.notEqual(receipt.salt, storedChallenge.salt);
});

test('SaaS static runtime, no-store, origin and CSRF enforcement expose no private resources', async t => {
  const f = await H.fixture(t);
  const user = await H.family(f, await H.register(f, 'transport@example.test'));
  assert.deepEqual((await H.request(f.server, 'GET', '/api/health')).body, { ok: true });
  assert.equal((await H.request(f.server, 'GET', '/runtime.js')).body, 'window.__TTJF_SAAS__=true;\n');
  for (const route of ['/data/state.json', '/saas/migrations/001-initial.sql', '/.env.saas.local', '/saas-server.cjs', '/assets/../../saas-server.cjs']) {
    const response = await H.request(f.server, 'GET', route);
    assert.ok([400, 404].includes(response.status), route);
  }
  const command = { revision: 1, action: { id: 'first-start', type: 'farm.start' } };
  assert.equal((await H.request(f.server, 'POST', '/api/action', command, user, { noCsrf: true })).body.code, 'CSRF_INVALID');
  assert.equal((await H.request(f.server, 'POST', '/api/action', command, user, { noOrigin: true })).body.code, 'ORIGIN_DENIED');
  assert.equal((await H.request(f.server, 'POST', '/api/action', command, user, { origin: 'https://attacker.example' })).body.code, 'ORIGIN_DENIED');
  assert.equal((await H.request(f.server, 'POST', '/api/action', command, { ...user, csrfToken: 'forged' })).body.code, 'CSRF_INVALID');
  assert.equal((await H.request(f.server, 'POST', '/api/action', command, user)).status, 200);
  assert.equal((await H.request(f.server, 'GET', '/api/state', undefined, user)).headers['cache-control'], 'no-store');
});
