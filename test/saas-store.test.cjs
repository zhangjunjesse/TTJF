'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const M = require('../model.js');
const { migrate } = require('../saas/store.cjs');
const H = require('../saas/testing.cjs');

test('real PG migration is concurrent/idempotent and family creation is atomic, empty and idempotent', async t => {
  const f = await H.fixture(t);
  await Promise.all([migrate(f.pool), migrate(f.pool)]);
  assert.deepEqual((await f.pool.query('SELECT version FROM saas_schema_migrations ORDER BY version')).rows, [{ version: 1 }, { version: 2 }]);
  const user = await H.register(f, 'create@example.test'), second = await f.start();
  const payload = { name: '新家', childName: '小新', requestId: 'same-create' };
  const responses = await Promise.all([f.server, second].map(server => H.request(server, 'POST', '/api/families', payload, user)));
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  assert.equal(responses[0].body.family.id, responses[1].body.family.id);
  const conflict = await H.request(second, 'POST', '/api/families', { ...payload, childName: '不能替换' }, user);
  assert.equal(conflict.body.code, 'REQUEST_ID_REUSED');
  const rows = (await f.pool.query('SELECT * FROM saas_families')).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual(M.totals(rows[0].state), { earned: 0, spent: 0, available: 0 });
  assert.equal(rows[0].state.farm, null); assert.equal(rows[0].state.childName, '小新');
  for (const key of ['tasks', 'points', 'pointItems', 'redemptions', 'rewards', 'requests', 'petPurchases', 'petCare', 'appliedActions']) { assert.deepEqual(rows[0].state[key], [], key); }
  const members = (await f.pool.query('SELECT role FROM saas_memberships')).rows;
  assert.deepEqual(members, [{ role: 'owner' }]);
});

test('real PG competing first setup and action retries across instances commit one receipt and one business effect', async t => {
  const f = await H.fixture(t), second = await f.start();
  const owner = await H.family(f, await H.register(f, 'atomic@example.test'));
  const setups = [{ id: 'setup-a', type: 'parent.setup', method: 'math' }, { id: 'setup-b', type: 'parent.setup', method: 'math' }];
  const configured = await Promise.all([f.server, second].map((server, i) => H.request(server, 'POST', '/api/action', { revision: 1, action: setups[i] }, owner)));
  assert.deepEqual(configured.map(r => r.status).sort(), [200, 409]);
  const action = H.credit('same-credit');
  const token = await H.grant(f, owner, action);
  const commands = await Promise.all([f.server, second].map(server => H.request(server, 'POST', '/api/action', { revision: 2, action, grant: token }, owner)));
  assert.deepEqual(commands.map(r => r.status), [200, 200]);
  assert.equal(commands[0].body.revision, 3); assert.equal(commands[1].body.revision, 3);
  assert.equal(commands[0].body.state.points.length, 1);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM saas_action_receipts WHERE family_id=$1', [owner.familyId])).rows[0].n, 2);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM saas_parent_grants')).rows[0].n, 0);
  const left = H.credit('race-left', 2), right = H.credit('race-right', 3);
  const [leftGrant, rightGrant] = await Promise.all([H.grant(f, owner, left, 3), H.grant(f, owner, right, 3, second)]);
  const competing = await Promise.all([
    H.request(f.server, 'POST', '/api/action', { revision: 3, action: left, grant: leftGrant }, owner),
    H.request(second, 'POST', '/api/action', { revision: 3, action: right, grant: rightGrant }, owner)
  ]);
  assert.deepEqual(competing.map(r => r.status).sort(), [200, 409]);
  assert.equal(competing[0].body.revision, 4); assert.equal(competing[1].body.revision, 4);
  await f.server.closeSaas();
  const restarted = await f.start();
  const snapshot = await H.request(restarted, 'GET', '/api/state', undefined, owner);
  assert.equal(snapshot.body.revision, 4); assert.equal(snapshot.body.state.points.length, 2);
});

test('real PostgreSQL transaction failure rolls back ledger, receipt and consumed grant, then retry succeeds', async t => {
  const f = await H.fixture(t);
  const owner = await H.family(f, await H.register(f, 'rollback@example.test'));
  await H.setup(f, owner);
  const action = H.credit('rollback-action'), token = await H.grant(f, owner, action);
  const before = (await f.pool.query('SELECT state,parent,revision FROM saas_families WHERE id=$1', [owner.familyId])).rows[0];
  // Real database fault at the last write, after the aggregate update. No SQL mock.
  await f.pool.query(`CREATE FUNCTION v13_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'v13 injected persistence failure'; END $$;
    CREATE TRIGGER v13_fail_receipt BEFORE INSERT ON saas_action_receipts FOR EACH ROW EXECUTE FUNCTION v13_fail_receipt()`);
  const failed = await H.request(f.server, 'POST', '/api/action', { revision: 2, action, grant: token }, owner);
  assert.equal(failed.status, 503); assert.equal(failed.body.state, undefined);
  const after = (await f.pool.query('SELECT state,parent,revision FROM saas_families WHERE id=$1', [owner.familyId])).rows[0];
  assert.deepEqual(after, before);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM saas_parent_grants')).rows[0].n, 1);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM saas_action_receipts')).rows[0].n, 1);
  await f.pool.query('DROP TRIGGER v13_fail_receipt ON saas_action_receipts; DROP FUNCTION v13_fail_receipt()');
  const retried = await H.request(f.server, 'POST', '/api/action', { revision: 2, action, grant: token }, owner);
  assert.equal(retried.status, 200); assert.equal(M.totals(retried.body.state).earned, 5);
});

test('closeSaas releases its owned real PG pool, keeps supplied pools usable, and is idempotent', async t => {
  const f = await H.fixture(t);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options', '-c search_path=' + f.schema);
  const owned = await require('../saas-server.cjs').createSaasServer({ databaseUrl: url.toString(), publicOrigin: H.ORIGIN,
    environment: 'test', mailer: { sendMail: async () => {} } });
  assert.equal((await owned.store.pool.query('SELECT 1 AS value')).rows[0].value, 1);
  await owned.closeSaas(); await owned.closeSaas();
  await assert.rejects(owned.store.pool.query('SELECT 1'), /after calling end/);
  await f.server.closeSaas();
  assert.equal((await f.pool.query('SELECT 1 AS value')).rows[0].value, 1);
});

test('real PG scoped counters isolate families and outsider requests never wait for foreign family row locks', async t => {
  const f = await H.fixture(t);
  const a = await H.family(f, await H.register(f, 'a@example.test'), 'A');
  const b = await H.family(f, await H.register(f, 'b@example.test'), 'B');
  await H.setup(f, a); await H.setup(f, b);
  const second = await f.start();
  for (let i = 0; i < 5; i++) {
    const c = await H.request(i % 2 ? second : f.server, 'POST', '/api/parent/challenge', { revision: 2, action: H.credit('bad-' + i) }, a);
    assert.equal(c.status, 200);
    assert.equal((await H.request(second, 'POST', '/api/parent/verify', { challengeId: c.body.challengeId, answer: '000000' }, a)).status, 403);
  }
  assert.equal((await H.request(second, 'POST', '/api/parent/challenge', { revision: 2, action: H.credit('locked') }, a)).status, 429);
  assert.equal((await H.request(second, 'POST', '/api/parent/challenge', { revision: 2, action: H.credit('allowed') }, b)).status, 200);
  const blocker = await f.pool.connect();
  try {
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM saas_families WHERE id=$1 FOR UPDATE', [b.familyId]);
    const forbidden = await H.request(f.server, 'GET', '/api/state', undefined, { ...a, familyId: b.familyId });
    assert.equal(forbidden.status, 403); assert.equal(forbidden.body.state, undefined);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  const missing = await H.request(f.server, 'GET', '/api/state', undefined, { ...a, familyId: crypto.randomUUID() });
  assert.equal(missing.status, 403); assert.equal(missing.body.state, undefined);
});
