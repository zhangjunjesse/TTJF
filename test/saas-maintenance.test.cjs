'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('../saas/testing.cjs');
const S = require('../saas/security.cjs');
const { createClientAddress, normalizeIp } = require('../saas/network.cjs');
const { maintenanceConfig } = require('../saas/maintenance.cjs');

test('v14 maintenance batch environment accepts bounds and rejects invalid startup configuration', () => {
  const prior = process.env.SAAS_CLEANUP_BATCH_SIZE;
  try {
    process.env.SAAS_CLEANUP_BATCH_SIZE = '1'; assert.equal(maintenanceConfig().batchSize, 1);
    process.env.SAAS_CLEANUP_BATCH_SIZE = '1000'; assert.equal(maintenanceConfig().batchSize, 1000);
    for (const value of ['0', '1001', 'not-a-number']) {
      process.env.SAAS_CLEANUP_BATCH_SIZE = value;
      assert.throws(() => maintenanceConfig(), /batchSize/);
    }
  } finally {
    if (prior === undefined) { delete process.env.SAAS_CLEANUP_BATCH_SIZE; } else { process.env.SAAS_CLEANUP_BATCH_SIZE = prior; }
  }
});

function networkRequest(remoteAddress, forwarded, rawHeaders) { return { socket: { remoteAddress }, headers: { 'x-forwarded-for': forwarded }, rawHeaders }; }
test('v14 proxy parser trusts exact peers, stops at first untrusted hop and rejects ambiguous headers', () => {
  const trusted = createClientAddress(['127.0.0.1', '2001:db8::1']);
  assert.equal(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeIp('2001:0db8:0:0:0:0:0:1'), '2001:db8::1');
  assert.equal(createClientAddress()(networkRequest('::ffff:127.0.0.1', '203.0.113.1')), '127.0.0.1');
  assert.equal(trusted(networkRequest('203.0.113.9', '203.0.113.1')), '203.0.113.9');
  assert.equal(trusted(networkRequest('::ffff:127.0.0.1', '198.51.100.7, 2001:db8::1')), '198.51.100.7');
  assert.equal(trusted(networkRequest('127.0.0.1', '198.51.100.8, 203.0.113.5, 2001:db8::1')), '203.0.113.5');
  for (const value of [undefined, '', '127.0.0.1', 'unknown', '1.2.3.4:1234', '1.2.3.4,', ',1.2.3.4', 'bad, 1.2.3.4', '1.2.3.4, '.repeat(33)]) {
    assert.equal(trusted(networkRequest('127.0.0.1', value)), '127.0.0.1');
  }
  assert.equal(trusted(networkRequest('127.0.0.1', '1.2.3.4, 5.6.7.8', ['X-Forwarded-For', '1.2.3.4', 'X-Forwarded-For', '5.6.7.8'])), '127.0.0.1');
  for (const entry of ['*', '127.0.0.0/8', 'localhost', '127.0.0.1,', [''], ['127.0.0.1:12']]) { assert.throws(() => createClientAddress(entry)); }
});

test('v14 HTTP rate counters split only for explicitly trusted proxy clients and reject spoofed prefixes', async t => {
  const f = await H.fixture(t, { trustedProxies: ['127.0.0.1'], maintenanceIntervalMs: 0 });
  await f.server.store.rate('login:ip:203.0.113.1', 1, 900000, new Date(f.clock.value));
  await f.pool.query('UPDATE saas_rate_limits SET count=50 WHERE scope=$1', [S.digest('login:ip:203.0.113.1')]);
  const blocked = await H.request(f.server, 'POST', '/api/auth/login', { email: 'no-user@example.test', password: H.PASSWORD }, null,
    { headers: { 'X-Forwarded-For': '198.51.100.99, 203.0.113.1' } });
  assert.equal(blocked.status, 429);
  assert.equal((await H.request(f.server, 'POST', '/api/auth/login', { email: 'no-user@example.test', password: H.PASSWORD }, null,
    { headers: { 'X-Forwarded-For': '203.0.113.2' } })).status, 401);
  const untrusted = await f.start({ trustedProxies: [] });
  await f.server.store.rate('login:ip:127.0.0.1', 1, 900000, new Date(f.clock.value));
  await f.pool.query('UPDATE saas_rate_limits SET count=50 WHERE scope=$1', [S.digest('login:ip:127.0.0.1')]);
  assert.equal((await H.request(untrusted, 'POST', '/api/auth/login', { email: 'no-user@example.test', password: H.PASSWORD }, null,
    { headers: { 'X-Forwarded-For': '203.0.113.2' } })).status, 429);
  assert.equal((await H.request(f.server, 'POST', '/api/auth/login', { email: 'no-user@example.test', password: H.PASSWORD }, null,
    { headers: { 'X-Forwarded-For': 'garbage, 203.0.113.2' } })).status, 429);
});

test('v14 PG cleanup is bounded, preserves active credentials and all durable family business', async t => {
  const f = await H.fixture(t, { maintenanceIntervalMs: 0 });
  const owner = await H.family(f, await H.register(f, 'cleanup@example.test'));
  await H.setup(f, owner);
  const current = new Date(f.clock.value), past = new Date(f.clock.value - 1), future = new Date(f.clock.value + 60000);
  const sessionHash = S.digest(owner.cookie.split('=')[1]);
  const keep = {};
  for (let i = 0; i < 4; i++) {
    const expiry = i === 3 ? future : past, hash = S.digest('cleanup-v14-' + i), uuid = crypto.randomUUID();
    await f.pool.query('INSERT INTO saas_sessions(token_hash,user_id,csrf_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5)', [hash, owner.userId, S.digest('csrf'), current, expiry]);
    await f.pool.query("INSERT INTO saas_email_tokens(token_hash,user_id,purpose,created_at,expires_at) VALUES($1,$2,'reset',$3,$4)", [hash, owner.userId, current, expiry]);
    await f.pool.query('INSERT INTO saas_invitations(id,family_id,email,token_hash,invited_by,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [uuid, owner.familyId, 'pending-' + i + '@example.test', hash, owner.userId, current, expiry]);
    await f.pool.query("INSERT INTO saas_parent_challenges(token_hash,family_id,user_id,session_hash,revision,action_receipt,method,expires_at) VALUES($1,$2,$3,$4,2,$5,'pin',$6)",
      [hash, owner.familyId, owner.userId, sessionHash, { algorithm: 'sha256', digest: 'a'.repeat(64) }, expiry]);
    await f.pool.query('INSERT INTO saas_parent_grants(token_hash,family_id,user_id,session_hash,revision,action_receipt,expires_at) VALUES($1,$2,$3,$4,2,$5,$6)',
      [hash, owner.familyId, owner.userId, sessionHash, { algorithm: 'sha256', digest: 'a'.repeat(64) }, expiry]);
    await f.pool.query('INSERT INTO saas_assistant_leases(id,family_id,user_id,session_hash,expires_at) VALUES($1,$2,$3,$4,$5)', [uuid, owner.familyId, owner.userId, sessionHash, expiry]);
    await f.pool.query('INSERT INTO saas_rate_limits(scope,count,expires_at) VALUES($1,1,$2)', [hash, expiry]);
    if (i === 3) { keep.hash = hash; keep.id = uuid; }
  }
  await f.pool.query('INSERT INTO saas_family_imports(family_id,source_sha256,source_revision,imported_at) VALUES($1,$2,1,$3)', [owner.familyId, 'f'.repeat(64), current]);
  const durable = {};
  for (const table of ['saas_families', 'saas_action_receipts', 'saas_family_imports', 'saas_family_requests', 'saas_memberships']) {
    durable[table] = (await f.pool.query('SELECT * FROM ' + table)).rows;
  }
  const first = await f.server.ops.cleanupExpired({ batchSize: 2 });
  assert.equal(first.skipped, false); assert.equal(first.batchSize, 2);
  assert.ok(Object.values(first.deleted).every(n => n <= 2));
  assert.ok(Object.values(first.deleted).every(n => n > 0));
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM saas_sessions WHERE expires_at<=$1', [current])).rows[0].n, 1);
  await f.server.ops.cleanupExpired({ batchSize: 2 });
  for (const [table, key, value] of [['saas_sessions', 'token_hash', keep.hash], ['saas_email_tokens', 'token_hash', keep.hash],
    ['saas_invitations', 'id', keep.id], ['saas_parent_challenges', 'token_hash', keep.hash], ['saas_parent_grants', 'token_hash', keep.hash],
    ['saas_assistant_leases', 'id', keep.id], ['saas_rate_limits', 'scope', keep.hash]]) {
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM ' + table + ' WHERE expires_at<=$1', [current])).rows[0].n, 0, table);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM ' + table + ' WHERE ' + key + '=$1', [value])).rows[0].n, 1, table);
  }
  for (const table of Object.keys(durable)) { assert.deepEqual((await f.pool.query('SELECT * FROM ' + table)).rows, durable[table], table); }
  assert.equal((await H.request(f.server, 'GET', '/api/state', undefined, owner)).status, 200);
});

test('v14 PG maintenance coordinates instances, rolls back errors and closes its timer', async t => {
  const f = await H.fixture(t, { maintenanceIntervalMs: 0 });
  const second = await f.start({ maintenanceIntervalMs: 60000 });
  assert.equal(second.ops.status().timerActive, true);
  const hold = await f.pool.connect();
  try {
    await hold.query('BEGIN'); await hold.query('SELECT pg_advisory_xact_lock(1329434014,hashtext(current_schema()))');
    assert.equal((await second.ops.cleanupExpired()).skipped, true);
  } finally { await hold.query('ROLLBACK'); hold.release(); }
  const user = await H.register(f, 'cleanup-failure@example.test');
  const hash = S.digest('cleanup-failure');
  await f.pool.query('INSERT INTO saas_sessions(token_hash,user_id,csrf_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$4)', [hash, user.userId, hash, new Date(f.clock.value)]);
  await f.pool.query(`CREATE FUNCTION stop_cleanup_v14() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic cleanup failure'; END $$`);
  await f.pool.query('CREATE TRIGGER stop_cleanup_v14 BEFORE DELETE ON saas_email_tokens FOR EACH ROW EXECUTE FUNCTION stop_cleanup_v14()');
  await assert.rejects(f.server.ops.cleanupExpired(), /synthetic cleanup failure/);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM saas_sessions WHERE token_hash=$1', [hash])).rows[0].n, 1);
  await f.pool.query('DROP TRIGGER stop_cleanup_v14 ON saas_email_tokens');
  await f.server.ops.cleanupExpired();
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM saas_sessions WHERE token_hash=$1', [hash])).rows[0].n, 0);
  await second.closeSaas(); await second.closeSaas();
  assert.deepEqual(second.ops.status(), { closed: true, running: false, timerActive: false, intervalMs: 60000, batchSize: 200 });
  await assert.rejects(second.ops.cleanupExpired(), /closed/);
  assert.equal((await f.pool.query('SELECT 1 AS n')).rows[0].n, 1);
});
