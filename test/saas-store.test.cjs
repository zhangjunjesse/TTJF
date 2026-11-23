'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const M = require('../model.js');
const { migrate } = require('../saas/store.cjs');
const H = require('../saas/testing.cjs');

test('real SQLite migration is queued/idempotent and family creation is atomic, empty and idempotent', async t => {
  const f = await H.fixture(t);
  await Promise.all([migrate(f.database), migrate(f.database)]);
  assert.deepEqual((await f.database.query('SELECT version FROM saas_schema_migrations ORDER BY version')).rows, [{ version: 1 }, { version: 2 }, { version: 3 }]);
  const user = await H.register(f, 'create@example.test'), second = await f.start();
  const payload = { name: '新家', childName: '小新', requestId: 'same-create' };
  const responses = await Promise.all([f.server, second].map(server => H.request(server, 'POST', '/api/families', payload, user)));
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  assert.equal(responses[0].body.family.id, responses[1].body.family.id);
  const conflict = await H.request(second, 'POST', '/api/families', { ...payload, childName: '不能替换' }, user);
  assert.equal(conflict.body.code, 'REQUEST_ID_REUSED');
  const rows = (await f.database.query('SELECT * FROM saas_families')).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual(M.totals(rows[0].state), { earned: 0, spent: 0, available: 0 });
  assert.equal(rows[0].state.farm, null); assert.equal(rows[0].state.childName, '小新');
  for (const key of ['tasks', 'points', 'pointItems', 'redemptions', 'rewards', 'requests', 'petPurchases', 'petCare', 'appliedActions']) { assert.deepEqual(rows[0].state[key], [], key); }
  const members = (await f.database.query('SELECT role FROM saas_memberships')).rows;
  assert.deepEqual(members, [{ role: 'owner' }]);
});

test('real SQLite competing setup and action retries across request handlers commit one receipt and one business effect', async t => {
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
  assert.equal((await f.database.query('SELECT count(*) AS n FROM saas_action_receipts WHERE family_id=$1', [owner.familyId])).rows[0].n, 2);
  assert.equal((await f.database.query('SELECT count(*) AS n FROM saas_parent_grants')).rows[0].n, 0);
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

test('real SQLite transaction failure rolls back ledger, receipt and consumed grant, then retry succeeds', async t => {
  const f = await H.fixture(t);
  const owner = await H.family(f, await H.register(f, 'rollback@example.test'));
  await H.setup(f, owner);
  const action = H.credit('rollback-action'), token = await H.grant(f, owner, action);
  const before = (await f.database.query('SELECT state,parent,revision FROM saas_families WHERE id=$1', [owner.familyId])).rows[0];
  // Real database fault at the last write, after the aggregate update. No SQL mock.
  await f.database.exec(`CREATE TRIGGER v13_fail_receipt BEFORE INSERT ON saas_action_receipts
    BEGIN SELECT RAISE(ABORT, 'v13 injected persistence failure'); END`);
  const failed = await H.request(f.server, 'POST', '/api/action', { revision: 2, action, grant: token }, owner);
  assert.equal(failed.status, 503); assert.equal(failed.body.state, undefined);
  const after = (await f.database.query('SELECT state,parent,revision FROM saas_families WHERE id=$1', [owner.familyId])).rows[0];
  assert.deepEqual(after, before);
  assert.equal((await f.database.query('SELECT count(*) AS n FROM saas_parent_grants')).rows[0].n, 1);
  assert.equal((await f.database.query('SELECT count(*) AS n FROM saas_action_receipts')).rows[0].n, 1);
  await f.database.exec('DROP TRIGGER v13_fail_receipt');
  const retried = await H.request(f.server, 'POST', '/api/action', { revision: 2, action, grant: token }, owner);
  assert.equal(retried.status, 200); assert.equal(M.totals(retried.body.state).earned, 5);
});

test('closeSaas closes its owned SQLite file, keeps the supplied database usable, and is idempotent', async t => {
  const f = await H.fixture(t);
  const ownedPath = path.join(path.dirname(f.databasePath), 'owned.sqlite');
  const owned = await require('../saas-server.cjs').createSaasServer({ databasePath: ownedPath, publicOrigin: H.ORIGIN,
    environment: 'test', mailer: { sendMail: async () => {} } });
  try {
    assert.equal((await owned.store.database.query('SELECT 1 AS value')).rows[0].value, 1);
    await owned.closeSaas(); await owned.closeSaas();
    await assert.rejects(owned.store.database.query('SELECT 1'), /closed/);
  } finally { await owned.closeSaas(); }
  await f.server.closeSaas();
  assert.equal((await f.database.query('SELECT 1 AS value')).rows[0].value, 1);
});

test('SQLite scoped counters isolate families and queued outsider requests return no family data', async t => {
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
  let unlock, entered;
  const held = new Promise(resolve => { unlock = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const blocker = f.database.transaction(async client => {
    await client.query('SELECT id FROM saas_families WHERE id=$1', [b.familyId]);
    entered(); await held;
  });
  await started;
  try {
    // One process owns the file: all database access waits for its transaction,
    // including requests for other families, then rechecks authorization.
    let queryFinished = false, requestFinished = false;
    const queued = f.database.query('SELECT 1').then(() => { queryFinished = true; });
    const received = new Promise(resolve => { second.once('request', resolve); });
    const request = H.request(second, 'GET', '/api/state', undefined, { ...a, familyId: b.familyId })
      .then(response => { requestFinished = true; return response; });
    await received;
    await new Promise(setImmediate);
    assert.equal(queryFinished, false);
    assert.equal(requestFinished, false);
    unlock(); await blocker; await queued;
    const forbidden = await request;
    assert.equal(forbidden.status, 403); assert.equal(forbidden.body.state, undefined);
  } finally { unlock(); await blocker; }
  const missing = await H.request(f.server, 'GET', '/api/state', undefined, { ...a, familyId: crypto.randomUUID() });
  assert.equal(missing.status, 403); assert.equal(missing.body.state, undefined);
});
