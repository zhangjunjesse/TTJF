'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../saas/testing.cjs');
const S = require('../saas/security.cjs');
const M = require('../model.js');
const route = who => '/api/families/' + who.familyId;
const confirmAccount = user => ({ email: user.email, currentPassword: user.password });
async function owners(f, id) {
  return (await f.pool.query("SELECT user_id FROM saas_memberships WHERE family_id=$1 AND role='owner'", [id])).rows.map(r => r.user_id);
}

test('v14 rename/leave require verified role, origin and CSRF, preserve business and reject stale membership', async t => {
  const f = await H.fixture(t);
  const owner = await H.family(f, await H.register(f, 'life-owner@example.test'), '原家庭');
  const parent = await H.invite(f, owner, await H.register(f, 'life-parent@example.test'));
  const outsider = await H.family(f, await H.register(f, 'life-outsider@example.test'), '其他家庭');
  await H.setup(f, owner);
  const before = (await H.request(f.server, 'GET', '/api/state', undefined, owner)).body;
  for (const [actor, expected] of [[parent, 'OWNER_REQUIRED'], [outsider, 'FAMILY_FORBIDDEN']]) {
    const denied = await H.request(f.server, 'PATCH', route(owner), { name: '冒名' }, actor);
    assert.equal(denied.body.code, expected); assert.equal(denied.body.state, undefined);
  }
  assert.equal((await H.request(f.server, 'PATCH', route(owner), { name: '新家庭' }, owner, { noCsrf: true })).body.code, 'CSRF_INVALID');
  assert.equal((await H.request(f.server, 'PATCH', route(owner), { name: '新家庭' }, owner, { noOrigin: true })).body.code, 'ORIGIN_DENIED');
  assert.equal((await H.request(f.server, 'PATCH', route(owner), { name: '新家庭' }, owner)).body.family.name, '新家庭');
  assert.equal((await H.request(f.server, 'PATCH', route(owner), { name: '新家庭' }, owner)).status, 200);
  const after = (await H.request(f.server, 'GET', '/api/state', undefined, owner)).body;
  assert.deepEqual(after.state, before.state); assert.equal(after.revision, before.revision);
  assert.equal((await H.request(f.server, 'POST', route(owner) + '/leave', {}, owner)).body.code, 'OWNER_MUST_TRANSFER');
  const action = H.credit('stale-after-leave'), grant = await H.grant(f, parent, action);
  assert.equal((await H.request(f.server, 'POST', route(parent) + '/leave', {}, parent)).status, 200);
  for (const [method, url, body] of [['POST', route(parent) + '/leave', {}], ['GET', '/api/state'], ['POST', '/api/action', { revision: 2, action, grant }]]) {
    assert.equal((await H.request(f.server, method, url, body, parent)).body.code, 'FAMILY_FORBIDDEN');
  }
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM saas_parent_grants WHERE user_id=$1', [parent.userId])).rows[0].n, 0);
  assert.deepEqual(await owners(f, owner.familyId), [owner.userId]);
});

test('v14 ownership transfers atomically only to a verified same-family parent using current password', async t => {
  const f = await H.fixture(t), second = await f.start();
  const a = await H.family(f, await H.register(f, 'transfer-a@example.test'), '移交家庭');
  const b = await H.invite(f, a, await H.register(f, 'transfer-b@example.test'));
  const foreign = await H.register(f, 'transfer-foreign@example.test');
  const url = route(a) + '/transfer-owner';
  const foreignLock = await f.pool.connect();
  let deadline;
  try {
    await foreignLock.query('BEGIN');
    await foreignLock.query('SELECT id FROM saas_users WHERE id=$1 FOR UPDATE', [foreign.userId]);
    const fastDenied = await Promise.race([
      H.request(second, 'POST', url, { userId: foreign.userId, currentPassword: H.PASSWORD }, a),
      new Promise((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Unauthorized transfer waited on a foreign user lock')), 2000); })
    ]);
    assert.equal(fastDenied.body.code, 'TRANSFER_TARGET_INVALID');
  } finally { clearTimeout(deadline); await foreignLock.query('ROLLBACK'); foreignLock.release(); }
  for (const [body, actor, code] of [
    [{ userId: b.userId, currentPassword: 'wrong' }, a, 'PASSWORD_INVALID'],
    [{ userId: foreign.userId, currentPassword: H.PASSWORD }, a, 'TRANSFER_TARGET_INVALID'],
    [{ userId: a.userId, currentPassword: H.PASSWORD }, a, 'TRANSFER_TARGET_INVALID'],
    [{ userId: a.userId, currentPassword: H.PASSWORD }, b, 'OWNER_REQUIRED']]) {
    assert.equal((await H.request(second, 'POST', url, body, actor)).body.code, code);
    assert.deepEqual(await owners(f, a.familyId), [a.userId]);
  }
  await f.pool.query('UPDATE saas_users SET verified_at=NULL WHERE id=$1', [b.userId]);
  assert.equal((await H.request(second, 'POST', url, { userId: b.userId, currentPassword: H.PASSWORD }, a)).body.code, 'TRANSFER_TARGET_INVALID');
  await f.pool.query('UPDATE saas_users SET verified_at=$2 WHERE id=$1', [b.userId, new Date(f.clock.value)]);
  const moved = await H.request(second, 'POST', url, { userId: b.userId, currentPassword: H.PASSWORD }, a);
  assert.equal(moved.status, 200); assert.equal(moved.body.family.role, 'parent');
  assert.deepEqual(await owners(f, a.familyId), [b.userId]);
  assert.equal((await H.request(f.server, 'POST', url, { userId: b.userId, currentPassword: H.PASSWORD }, a)).body.code, 'OWNER_REQUIRED');
  assert.equal((await H.request(f.server, 'GET', '/api/session', undefined, b)).body.families[0].role, 'owner');
  assert.equal((await H.request(f.server, 'POST', route(a) + '/leave', {}, a)).status, 200);
});

test('v14 family deletion requires exact name/password and cascades only the confirmed synthetic family', async t => {
  const f = await H.fixture(t);
  const a = await H.family(f, await H.register(f, 'delete-family@example.test'), '待删家庭');
  const b = await H.family(f, a, '保留家庭');
  const parent = await H.invite(f, a, await H.register(f, 'delete-parent@example.test'));
  await H.setup(f, a); await H.setup(f, b);
  const action = H.credit('same-ledger-action');
  for (const user of [a, b]) {
    const grant = await H.grant(f, user, action);
    assert.equal((await H.request(f.server, 'POST', '/api/action', { revision: 2, action, grant }, user)).status, 200);
  }
  const beforeB = (await H.request(f.server, 'GET', '/api/state', undefined, b)).body;
  await f.pool.query('INSERT INTO saas_family_imports(family_id,source_sha256,source_revision,imported_at) VALUES($1,$2,1,$3)', [a.familyId, 'a'.repeat(64), new Date(f.clock.value)]);
  for (const [body, actor, code] of [
    [{ name: '待删家庭 ', currentPassword: H.PASSWORD }, a, 'CONFIRMATION_MISMATCH'],
    [{ name: '待删家庭', currentPassword: 'incorrect' }, a, 'PASSWORD_INVALID'],
    [{ name: '待删家庭', currentPassword: H.PASSWORD }, parent, 'OWNER_REQUIRED']]) {
    assert.equal((await H.request(f.server, 'DELETE', route(a), body, actor)).body.code, code);
  }
  assert.equal((await H.request(f.server, 'DELETE', route(a), { name: '待删家庭', currentPassword: H.PASSWORD }, a)).status, 200);
  for (const table of ['saas_memberships', 'saas_family_requests', 'saas_invitations', 'saas_family_imports', 'saas_action_receipts', 'saas_parent_challenges', 'saas_parent_grants', 'saas_assistant_leases']) {
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM ' + table + ' WHERE family_id=$1', [a.familyId])).rows[0].n, 0, table);
  }
  assert.equal((await H.request(f.server, 'POST', '/api/action', { revision: 2, action }, a)).body.code, 'FAMILY_FORBIDDEN');
  assert.equal((await H.request(f.server, 'DELETE', route(a), { name: '保留家庭', currentPassword: H.PASSWORD }, a)).body.code, 'FAMILY_FORBIDDEN');
  const afterB = (await H.request(f.server, 'GET', '/api/state', undefined, b)).body;
  assert.deepEqual(afterB.state, beforeB.state); assert.equal(M.totals(afterB.state).earned, 5);
  assert.equal((await H.request(f.server, 'GET', '/api/session', undefined, a)).body.authenticated, true);
});

test('v14 account deletion handles former inviter, all credential revocation, unverified accounts and owner refusal', async t => {
  const f = await H.fixture(t);
  const a = await H.family(f, await H.register(f, 'delete-account-a@example.test'));
  const b = await H.invite(f, a, await H.register(f, 'delete-account-b@example.test'));
  const extra = await H.family(f, a, '仍由本人拥有');
  assert.equal((await H.request(f.server, 'POST', '/api/auth/delete-account', confirmAccount(a), a)).body.code, 'ACCOUNT_OWNS_FAMILIES');
  await H.request(f.server, 'POST', route(a) + '/transfer-owner', { userId: b.userId, currentPassword: H.PASSWORD }, a);
  assert.equal((await H.request(f.server, 'POST', '/api/auth/delete-account', confirmAccount(a), a)).body.code, 'ACCOUNT_OWNS_FAMILIES');
  assert.equal((await H.request(f.server, 'DELETE', route(extra), { name: '仍由本人拥有', currentPassword: H.PASSWORD }, a)).status, 200);
  const recipient = await H.register(f, 'post-delete-recipient@example.test');
  // Existing invitations belong to the family, including a pending one issued
  // by the former owner. Simulate its pre-transfer creation with real SQL.
  const pending = S.token();
  await f.pool.query(`INSERT INTO saas_invitations(id,family_id,email,token_hash,invited_by,created_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [require('node:crypto').randomUUID(), a.familyId, recipient.email, S.digest(pending), a.userId,
    new Date(f.clock.value), new Date(f.clock.value + 60000)]);
  assert.equal((await H.request(f.server, 'POST', '/api/auth/delete-account', { ...confirmAccount(a), email: b.email }, a)).body.code, 'CONFIRMATION_MISMATCH');
  assert.equal((await H.request(f.server, 'POST', '/api/auth/delete-account', { ...confirmAccount(a), currentPassword: 'wrong' }, a)).body.code, 'PASSWORD_INVALID');
  const session2 = await H.login(f, a.email);
  const reset = await H.request(f.server, 'POST', '/api/auth/forgot-password', { email: a.email }); assert.equal(reset.status, 202);
  const deleted = await H.request(f.server, 'POST', '/api/auth/delete-account', confirmAccount(a), a);
  assert.equal(deleted.status, 200); assert.match(deleted.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM saas_users WHERE id=$1', [a.userId])).rows[0].n, 0);
  for (const table of ['saas_sessions', 'saas_email_tokens', 'saas_memberships']) {
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM ' + table + ' WHERE user_id=$1', [a.userId])).rows[0].n, 0);
  }
  assert.equal((await H.request(f.server, 'GET', '/api/session', undefined, session2)).body.authenticated, false);
  assert.equal((await H.request(f.server, 'POST', '/api/auth/delete-account', confirmAccount(a), a)).status, 401);
  assert.equal((await H.request(f.server, 'POST', '/api/auth/reset-password', { token: H.mailToken(f, a.email, 'reset'), password: H.PASSWORD })).body.code, 'TOKEN_INVALID');
  assert.equal((await f.pool.query('SELECT invited_by FROM saas_invitations WHERE token_hash=$1', [S.digest(pending)])).rows[0].invited_by, null);
  assert.equal((await H.request(f.server, 'POST', '/api/invitations/accept', { token: pending }, recipient)).status, 200);
  assert.deepEqual(await owners(f, a.familyId), [b.userId]);
  const unverified = await H.register(f, 'unverified-delete@example.test', false);
  assert.equal((await H.request(f.server, 'POST', '/api/auth/delete-account', confirmAccount(unverified), unverified)).status, 200);
});

test('v14 reciprocal cross-family owner transfers follow one user lock order without deadlock', async t => {
  const f = await H.fixture(t), second = await f.start();
  const a = await H.family(f, await H.register(f, 'inverse-a@example.test'), 'A');
  const b = await H.family(f, await H.register(f, 'inverse-b@example.test'), 'B');
  await H.invite(f, a, b); await H.invite(f, b, a);
  const results = await Promise.all([
    H.request(f.server, 'POST', route(a) + '/transfer-owner', { userId: b.userId, currentPassword: H.PASSWORD }, a),
    H.request(second, 'POST', route(b) + '/transfer-owner', { userId: a.userId, currentPassword: H.PASSWORD }, b)
  ]);
  assert.deepEqual(results.map(r => r.status), [200, 200]);
  assert.deepEqual(await owners(f, a.familyId), [b.userId]); assert.deepEqual(await owners(f, b.familyId), [a.userId]);
});

test('v14 concurrent transfer versus target leave or account deletion never loses the family owner', async t => {
  const f = await H.fixture(t), second = await f.start();
  for (const ending of ['leave', 'delete']) {
    for (let turn = 0; turn < 2; turn++) {
      const a = await H.family(f, await H.register(f, ending + '-a-' + turn + '@example.test'));
      const b = await H.invite(f, a, await H.register(f, ending + '-b-' + turn + '@example.test'));
      const transfer = () => H.request(f.server, 'POST', route(a) + '/transfer-owner', { userId: b.userId, currentPassword: H.PASSWORD }, a);
      const leave = () => H.request(second, 'POST', ending === 'leave' ? route(a) + '/leave' : '/api/auth/delete-account', ending === 'leave' ? {} : confirmAccount(b), b);
      const operations = turn ? [leave(), transfer()] : [transfer(), leave()];
      const results = await Promise.all(operations);
      const moved = results[turn ? 1 : 0], exited = results[turn ? 0 : 1];
      if (moved.status === 200) {
        assert.equal(exited.status, 409); assert.equal(exited.body.code, ending === 'leave' ? 'OWNER_MUST_TRANSFER' : 'ACCOUNT_OWNS_FAMILIES');
        assert.deepEqual(await owners(f, a.familyId), [b.userId]);
      } else {
        assert.equal(moved.body.code, 'TRANSFER_TARGET_INVALID'); assert.equal(exited.status, 200);
        assert.deepEqual(await owners(f, a.familyId), [a.userId]);
      }
    }
  }
});

test('v14 invite acceptance racing account deletion cannot recreate deleted membership or revive old invitation', async t => {
  const f = await H.fixture(t), second = await f.start();
  const owner = await H.family(f, await H.register(f, 'invite-delete-owner@example.test'));
  const user = await H.register(f, 'invite-delete-target@example.test');
  assert.equal((await H.request(f.server, 'POST', route(owner) + '/invitations', { email: user.email }, owner)).status, 200);
  const token = H.mailToken(f, user.email, 'invite');
  const [accepted, deleted] = await Promise.all([
    H.request(f.server, 'POST', '/api/invitations/accept', { token }, user),
    H.request(second, 'POST', '/api/auth/delete-account', confirmAccount(user), user)
  ]);
  assert.equal(deleted.status, 200); assert.ok([200, 401].includes(accepted.status), accepted.body.code);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM saas_memberships WHERE user_id=$1', [user.userId])).rows[0].n, 0);
  assert.deepEqual(await owners(f, owner.familyId), [owner.userId]);
  const replacement = await H.register(f, user.email);
  assert.equal((await H.request(f.server, 'POST', '/api/invitations/accept', { token }, replacement)).body.code, 'INVITATION_INVALID');
});

test('v14 mutually invited former owners can concurrently delete accounts without invitation-row deadlocks', async t => {
  const f = await H.fixture(t), second = await f.start();
  const a = await H.family(f, await H.register(f, 'mutual-a@example.test'), 'A');
  const b = await H.family(f, await H.register(f, 'mutual-b@example.test'), 'B');
  const c = await H.register(f, 'mutual-successor@example.test');
  await H.invite(f, a, b); await H.invite(f, b, a);
  await H.invite(f, a, c); await H.invite(f, b, c);
  for (const former of [a, b]) {
    assert.equal((await H.request(f.server, 'POST', route(former) + '/transfer-owner', { userId: c.userId, currentPassword: H.PASSWORD }, former)).status, 200);
  }
  for (const user of [a, b]) {
    for (const family of [a, b]) {
      assert.equal((await H.request(f.server, 'POST', route(family) + '/leave', {}, user)).status, 200);
    }
  }
  const results = await Promise.all([a, b].map((user, i) => H.request(i ? second : f.server, 'POST', '/api/auth/delete-account', confirmAccount(user), user)));
  assert.deepEqual(results.map(r => r.status), [200, 200]);
  assert.deepEqual(await owners(f, a.familyId), [c.userId]); assert.deepEqual(await owners(f, b.familyId), [c.userId]);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM saas_invitations WHERE invited_by IS NOT NULL')).rows[0].n, 0);
});

test('v14 synthetic deletion failures roll back whole family cascades and account invitation revocation', async t => {
  const f = await H.fixture(t);
  const owner = await H.family(f, await H.register(f, 'rollback-delete-owner@example.test'));
  await H.setup(f, owner);
  const before = (await f.pool.query('SELECT * FROM saas_families')).rows;
  await f.pool.query(`CREATE FUNCTION fail_delete_v14() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic deletion failure'; END $$`);
  await f.pool.query('CREATE TRIGGER fail_delete_v14 BEFORE DELETE ON saas_action_receipts FOR EACH ROW EXECUTE FUNCTION fail_delete_v14()');
  assert.equal((await H.request(f.server, 'DELETE', route(owner), { name: '测试家庭', currentPassword: H.PASSWORD }, owner)).status, 503);
  assert.deepEqual((await f.pool.query('SELECT * FROM saas_families')).rows, before);
  assert.deepEqual(await owners(f, owner.familyId), [owner.userId]);
  await f.pool.query('DROP TRIGGER fail_delete_v14 ON saas_action_receipts');
  const target = await H.register(f, 'rollback-delete-target@example.test');
  await H.request(f.server, 'POST', route(owner) + '/invitations', { email: target.email }, owner);
  const hash = S.digest(H.mailToken(f, target.email, 'invite'));
  await f.pool.query('CREATE TRIGGER fail_delete_v14 BEFORE DELETE ON saas_users FOR EACH ROW EXECUTE FUNCTION fail_delete_v14()');
  assert.equal((await H.request(f.server, 'POST', '/api/auth/delete-account', confirmAccount(target), target)).status, 503);
  assert.equal((await f.pool.query('SELECT revoked_at FROM saas_invitations WHERE token_hash=$1', [hash])).rows[0].revoked_at, null);
  assert.equal((await H.request(f.server, 'GET', '/api/session', undefined, target)).body.authenticated, true);
});

for (const ending of ['leave', 'delete-account']) {
  test('v14 in-flight assistant leases survive ' + ending + ' and session cleanup until provider returns', async t => {
    let signal;
    const entered = new Promise(resolve => { signal = resolve; }), releases = [];
    const f = await H.fixture(t, { maintenanceIntervalMs: 0, assistantService: {
      status: () => ({ mode: 'local', label: '测试' }), interpret: text => {
        if (text !== 'wait') { return Promise.resolve({ kind: 'clarify', question: 'ready' }); }
        return new Promise(resolve => { releases.push(resolve); if (releases.length === 2) { signal(); } });
      }
    } });
    const second = await f.start();
    const owner = await H.family(f, await H.register(f, ending + '-lease-owner@example.test'));
    const parent = await H.invite(f, owner, await H.register(f, ending + '-lease-parent@example.test'));
    const pending = [f.server, second].map(server => H.request(server, 'POST', '/api/assistant', { text: 'wait' }, parent));
    await entered;
    try {
      assert.equal((await H.request(f.server, 'POST', ending === 'leave' ? route(parent) + '/leave' : '/api/auth/delete-account',
        ending === 'leave' ? {} : confirmAccount(parent), parent)).status, 200);
      assert.equal((await H.request(second, 'POST', '/api/assistant', { text: 'third' }, owner)).status, 429);
      if (ending === 'leave') { assert.equal((await H.request(f.server, 'POST', '/api/auth/logout', {}, parent)).status, 200); }
      await f.server.ops.cleanupExpired();
      const leases = (await f.pool.query('SELECT user_id,session_hash FROM saas_assistant_leases WHERE family_id=$1', [owner.familyId])).rows;
      assert.equal(leases.length, 2); assert.ok(leases.every(row => row.session_hash === null));
      if (ending === 'delete-account') { assert.ok(leases.every(row => row.user_id === null)); }
      assert.equal((await H.request(second, 'POST', '/api/assistant', { text: 'third-after-cleanup' }, owner)).status, 429);
    } finally { for (const release of releases) { release({ kind: 'clarify', question: 'private old response' }); } }
    assert.deepEqual((await Promise.all(pending)).map(response => response.status), [401, 401]);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM saas_assistant_leases')).rows[0].n, 0);
    assert.equal((await H.request(second, 'POST', '/api/assistant', { text: 'available again' }, owner)).status, 200);
  });
}

test('v14 database constraint rejects ownerless commits and failed transfer rolls back both roles', async t => {
  const f = await H.fixture(t);
  const a = await H.family(f, await H.register(f, 'atomic-a@example.test'));
  const b = await H.invite(f, a, await H.register(f, 'atomic-b@example.test'));
  await assert.rejects(f.server.store.transaction(client => client.query(`INSERT INTO saas_families(id,name,state,created_at,updated_at)
    VALUES($1,'orphan',$2,$3,$3)`, [require('node:crypto').randomUUID(), M.createEmptyFamily({ childName: '孤立测试' }, new Date(f.clock.value)), new Date(f.clock.value)])), error => error.code === '23514');
  await assert.rejects(f.server.store.transaction(client => client.query("UPDATE saas_memberships SET role='parent' WHERE family_id=$1", [a.familyId])), error => error.code === '23514');
  await f.pool.query(`CREATE FUNCTION fail_transfer_v14() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.role='owner' AND OLD.role='parent' THEN RAISE EXCEPTION 'synthetic transfer failure'; END IF; RETURN NEW; END $$`);
  await f.pool.query('CREATE TRIGGER fail_transfer_v14 BEFORE UPDATE ON saas_memberships FOR EACH ROW EXECUTE FUNCTION fail_transfer_v14()');
  const failed = await H.request(f.server, 'POST', route(a) + '/transfer-owner', { userId: b.userId, currentPassword: H.PASSWORD }, a);
  assert.equal(failed.status, 503); assert.equal(failed.body.code, 'DATABASE_UNAVAILABLE');
  assert.deepEqual(await owners(f, a.familyId), [a.userId]);
  assert.equal((await f.pool.query('SELECT role FROM saas_memberships WHERE family_id=$1 AND user_id=$2', [a.familyId, b.userId])).rows[0].role, 'parent');
});
