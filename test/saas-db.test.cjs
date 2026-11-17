'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const H = require('../saas/testing.cjs');
const S = require('../saas/security.cjs');
const { createDatabase } = require('../saas/sqlite.cjs');
const { createStore } = require('../saas/store.cjs');
const { backupDatabase, restoreDatabase } = require('../tools/saas-db.cjs');
const count = async (database, table) => (await database.query('SELECT count(*) AS count FROM ' + table)).rows[0].count;

test('whole database backup reopens consistently and restore preserves business while invalidating every temporary credential', async t => {
  const f = await H.fixture(t);
  const owner = await H.family(f, await H.register(f, 'snapshot-owner@example.test'));
  await H.setup(f, owner);
  const action = H.credit('snapshot-real-credit', 17);
  const authorization = await H.grant(f, owner, action);
  const committed = await H.request(f.server, 'POST', '/api/action', { revision: 2, action, grant: authorization }, owner);
  assert.equal(committed.status, 200);
  await H.grant(f, owner, H.credit('snapshot-pending-credit'), 3);
  const challenge = await H.request(f.server, 'POST', '/api/parent/challenge', { revision: 3, action: H.credit('snapshot-pending-challenge') }, owner);
  assert.equal(challenge.status, 200);
  const invitation = await H.request(f.server, 'POST', '/api/families/' + owner.familyId + '/invitations', { email: 'snapshot-invitee@example.test' }, owner);
  assert.equal(invitation.status, 200);
  const sessionHash = S.digest(owner.cookie.split('=')[1]);
  await f.database.query('INSERT INTO saas_assistant_leases(id,family_id,user_id,session_hash,expires_at) VALUES($1,$2,$3,$4,$5)',
    [crypto.randomUUID(), owner.familyId, owner.userId, sessionHash, new Date(f.clock.value + 60000)]);
  const transient = ['saas_sessions', 'saas_email_tokens', 'saas_invitations', 'saas_parent_grants', 'saas_parent_challenges', 'saas_assistant_leases'];
  for (const table of transient) assert.ok(await count(f.database, table) > 0, table + ' was populated by real workflows');
  const permanent = (await f.database.query('SELECT * FROM saas_families WHERE id=$1', [owner.familyId])).rows[0];
  const receipts = (await f.database.query('SELECT * FROM saas_action_receipts ORDER BY action_id')).rows;
  const directory = path.dirname(f.databasePath), output = path.join(directory, 'consistent-backup.sqlite');
  const saved = await backupDatabase({ databasePath: f.databasePath, output });
  assert.equal(saved.mode, 'backup'); assert.ok(saved.bytes > 0);
  const bytes = fs.readFileSync(output);
  const reopened = await createStore({ databasePath: output, migrate: false });
  try {
    assert.deepEqual((await reopened.database.query('SELECT * FROM saas_families WHERE id=$1', [owner.familyId])).rows[0], permanent);
    assert.equal(await count(reopened.database, 'saas_sessions'), await count(f.database, 'saas_sessions'));
  } finally { await reopened.close(); }
  // Stop every HTTP application before restore, matching the operator contract.
  await f.server.closeSaas();
  const target = path.join(directory, 'restored-new-path.sqlite');
  const restored = await restoreDatabase({ source: output, output: target, appStopped: true });
  assert.equal(restored.credentialsInvalidated, true);
  assert.deepEqual(fs.readFileSync(output), bytes, 'read-only source backup was never changed');
  const database = await createDatabase({ databasePath: target, mustExist: true });
  try {
    for (const table of transient) assert.equal(await count(database, table), 0, table + ' must not revive credentials from the backup');
    assert.deepEqual((await database.query('SELECT * FROM saas_families WHERE id=$1', [owner.familyId])).rows[0], permanent);
    assert.deepEqual((await database.query('SELECT * FROM saas_action_receipts ORDER BY action_id')).rows, receipts);
    const server = await f.start({ database });
    assert.equal((await H.request(server, 'GET', '/api/state', undefined, owner)).status, 401, 'old cookie cannot be reused');
    const fresh = { ...await H.login(f, owner.email, H.PASSWORD, server), familyId: owner.familyId };
    const state = await H.request(server, 'GET', '/api/state', undefined, fresh);
    assert.equal(state.status, 200); assert.deepEqual(state.body.state, permanent.state);
    const replay = await H.request(server, 'POST', '/api/action', { revision: 3, action }, fresh);
    assert.equal(replay.status, 200); assert.equal(replay.body.revision, 3, 'permanent action receipt still prevents a duplicate award');
    await server.closeSaas();
  } finally { await database.close(); }
});

test('database tools refuse existing outputs, public paths and missing databases without provisioning data', async t => {
  const f = await H.fixture(t), directory = path.dirname(f.databasePath);
  const snapshot = path.join(directory, 'private.sqlite');
  await backupDatabase({ databasePath: f.databasePath, output: snapshot });
  const bytes = fs.readFileSync(snapshot);
  await assert.rejects(backupDatabase({ databasePath: f.databasePath, output: snapshot }), /already exists/);
  await assert.rejects(restoreDatabase({ source: snapshot, output: snapshot, appStopped: true }), /already exists/);
  const target = path.join(directory, 'not-created.sqlite');
  await assert.rejects(restoreDatabase({ source: snapshot, output: target }), /Stop every application/);
  assert.equal(fs.existsSync(target), false);
  const missing = path.join(directory, 'missing.sqlite');
  await assert.rejects(createStore({ databasePath: missing, migrate: false }), /does not exist/);
  await assert.rejects(backupDatabase({ databasePath: missing, output: target }), /does not exist/);
  assert.equal(fs.existsSync(missing), false); assert.equal(fs.existsSync(target), false);
  for (const output of ['assets/operator-private.sqlite', '.env.sqlite-secret', 'file:unsafe.sqlite']) {
    await assert.rejects(backupDatabase({ databasePath: f.databasePath, output }), /private|path|env|URL/i);
    await assert.rejects(restoreDatabase({ source: snapshot, output, appStopped: true }), /private|path|env|URL/i);
  }
  assert.deepEqual(fs.readFileSync(snapshot), bytes);
});

test('restore rejects invalid, corrupt and foreign-key-broken backups before creating a target', async t => {
  const f = await H.fixture(t), directory = path.dirname(f.databasePath);
  const bad = path.join(directory, 'bad.sqlite'), target = path.join(directory, 'should-not-exist.sqlite');
  fs.writeFileSync(bad, 'not a sqlite database');
  await assert.rejects(restoreDatabase({ source: bad, output: target, appStopped: true }), /database|SQLite/i);
  assert.equal(fs.existsSync(target), false);
  const empty = path.join(directory, 'unrelated.sqlite');
  const unrelated = new DatabaseSync(empty); unrelated.exec('CREATE TABLE unrelated(id INTEGER PRIMARY KEY)'); unrelated.close();
  await assert.rejects(restoreDatabase({ source: empty, output: target, appStopped: true }), /schema is missing|incomplete/);
  assert.equal(fs.existsSync(target), false);
  const incomplete = path.join(directory, 'missing-required-column.sqlite');
  await backupDatabase({ databasePath: f.databasePath, output: incomplete });
  const schema = new DatabaseSync(incomplete);
  schema.exec('ALTER TABLE saas_users DROP COLUMN created_at'); schema.close();
  await assert.rejects(restoreDatabase({ source: incomplete, output: target, appStopped: true }), /schema|column|incomplete/i);
  assert.equal(fs.existsSync(target), false);
  const broken = path.join(directory, 'broken-foreign-key.sqlite');
  await backupDatabase({ databasePath: f.databasePath, output: broken });
  const raw = new DatabaseSync(broken);
  raw.exec('PRAGMA foreign_keys=OFF');
  raw.prepare('INSERT INTO saas_sessions(token_hash,user_id,csrf_hash,created_at,expires_at) VALUES(?,?,?,?,?)').run('a'.repeat(64), crypto.randomUUID(), 'b'.repeat(64), new Date().toISOString(), new Date(Date.now() + 10000).toISOString());
  raw.close();
  await assert.rejects(restoreDatabase({ source: broken, output: target, appStopped: true }), /foreign_key_check/);
  assert.equal(fs.existsSync(target), false);
  const corrupt = path.join(directory, 'truncated.sqlite');
  const bytes = fs.readFileSync(broken); fs.writeFileSync(corrupt, bytes.subarray(0, 512));
  await assert.rejects(restoreDatabase({ source: corrupt, output: target, appStopped: true }), /database|SQLite|malformed/i);
  assert.equal(fs.existsSync(target), false);
});

test('operator CLI creates a consistent snapshot and restores only to an explicit unused private path', async t => {
  const f = await H.fixture(t), directory = path.dirname(f.databasePath);
  const output = path.join(directory, 'cli-whole-backup.sqlite'), restored = path.join(directory, 'cli-restored.sqlite');
  function cli(args, expected = 0) {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../tools/saas-db.cjs'), ...args], {
      env: { ...process.env, DATABASE_URL: '', TEST_DATABASE_URL: '', SQLITE_FILE: f.databasePath }, encoding: 'utf8', timeout: 10000, windowsHide: true
    });
    assert.equal(result.error, undefined); assert.equal(result.status, expected, result.stderr);
    return expected === 0 ? JSON.parse(result.stdout) : result.stderr;
  }
  assert.equal(cli(['backup', '--output', output]).mode, 'backup');
  assert.match(cli(['backup', '--output', output], 1), /already exists/);
  assert.match(cli(['restore', '--source', output, '--output', restored], 1), /Stop every application/);
  await f.server.closeSaas();
  assert.equal(cli(['restore', '--source', output, '--output', restored, '--app-stopped']).mode, 'restored');
  assert.match(cli(['restore', '--source', output, '--output', restored, '--app-stopped'], 1), /already exists/);
  const store = await createStore({ databasePath: restored, migrate: false });
  try { assert.equal((await store.database.query('PRAGMA integrity_check')).rows[0].integrity_check, 'ok'); }
  finally { await store.close(); }
});

test('unknown backup triggers cannot erase family business during restore and never publish an output', async t => {
  const f = await H.fixture(t), owner = await H.family(f, await H.register(f, 'failed-restore@example.test'));
  const directory = path.dirname(f.databasePath), source = path.join(directory, 'reject-cleanup.sqlite');
  const target = path.join(directory, 'partial-must-not-exist.sqlite');
  await backupDatabase({ databasePath: f.databasePath, output: source });
  const raw = new DatabaseSync(source);
  raw.exec('CREATE TRIGGER surprising_session_cleanup AFTER DELETE ON saas_sessions BEGIN DELETE FROM saas_families; END');
  raw.close();
  const bytes = fs.readFileSync(source);
  await f.server.closeSaas();
  await assert.rejects(restoreDatabase({ source, output: target, appStopped: true }), /unrecognized triggers/);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fs.readFileSync(source), bytes);
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.includes('.restore-')), [], 'unrecognized schema was rejected before creating staging');
  const backupOfBad = path.join(directory, 'must-not-back-up-triggers.sqlite');
  await assert.rejects(backupDatabase({ databasePath: source, output: backupOfBad }), /unrecognized triggers/);
  assert.equal(fs.existsSync(backupOfBad), false); assert.deepEqual(fs.readFileSync(source), bytes);
  const resumed = await f.start();
  assert.equal((await H.request(resumed, 'GET', '/api/state', undefined, owner)).status, 200, 'rejected restore did not change the original family database');
  assert.equal(await count(f.database, 'saas_families'), 1);
});

test('fixture shares its injected database across handlers and persists after a real connection reopen', async t => {
  const f = await H.fixture(t), second = await f.start();
  const owner = await H.family(f, await H.register(f, 'fixture-reopen@example.test'));
  await f.server.closeSaas(); await second.closeSaas();
  const connection = await f.openDatabase();
  const restarted = await f.start({ database: connection });
  assert.notEqual(connection, f.database);
  const response = await H.request(restarted, 'GET', '/api/state', undefined, owner);
  assert.equal(response.status, 200); assert.equal(response.body.familyId, owner.familyId);
  assert.equal((await f.database.query('SELECT count(*) AS count FROM saas_families')).rows[0].count, 1, 'server closure did not close an injected database');
});

test('restore never removes an existing staging directory entry when exclusive creation fails', async t => {
  const f = await H.fixture(t), directory = path.dirname(f.databasePath);
  const source = path.join(directory, 'staging-source.sqlite'), output = path.join(directory, 'new-restored.sqlite');
  await backupDatabase({ databasePath: f.databasePath, output: source });
  await f.server.closeSaas();
  const sentinel = Buffer.from('existing private staging contents must remain untouched');
  const stage = output + '.restore-' + Buffer.alloc(12, 0xab).toString('hex');
  fs.writeFileSync(stage, sentinel, { flag: 'wx', mode: 0o600 });
  const randomBytes = crypto.randomBytes;
  try {
    // Only the random filename is fixed; SQLite and all filesystem operations are real.
    crypto.randomBytes = size => Buffer.alloc(size, 0xab);
    await assert.rejects(restoreDatabase({ source, output, appStopped: true }), error => error.code === 'EEXIST');
  } finally { crypto.randomBytes = randomBytes; }
  assert.equal(fs.existsSync(output), false);
  assert.deepEqual(fs.readFileSync(stage), sentinel, 'failed exclusive creation did not grant cleanup ownership');
});

test('init creates private real SMTP settings and bootstrap provisions SQLite with the configured account', async t => {
  const f = await H.fixture(t), directory = path.join(path.dirname(f.databasePath), 'isolated-project');
  const project = path.resolve(__dirname, '..');
  for (const file of ['tools/saas-local.cjs', 'saas/initial-account.cjs', 'saas/sqlite.cjs', 'saas/store.cjs', 'saas/security.cjs', 'saas/migrations/001-initial.sql', 'saas/migrations/002-lifecycle.sql']) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.copyFileSync(path.join(project, file), path.join(directory, file));
  }
  function cli(command, expected = 0) {
    const env = { ...process.env, DATABASE_URL: '', TEST_DATABASE_URL: '', SQLITE_FILE: '' };
    delete env.INITIAL_ACCOUNT_EMAIL; delete env.INITIAL_ACCOUNT_PASSWORD;
    const result = spawnSync(process.execPath, ['tools/saas-local.cjs', command], {
      cwd: directory, env, encoding: 'utf8', timeout: 10000, windowsHide: true
    });
    assert.equal(result.error, undefined); assert.equal(result.status, expected, result.stderr);
    return result;
  }
  assert.match(cli('init').stdout, /Created private/);
  const local = path.join(directory, '.env.saas.local'), bytes = fs.readFileSync(local);
  assert.match(bytes.toString(), /^SQLITE_FILE=data\/ttjf.sqlite$/m);
  assert.match(bytes.toString(), /^NODE_ENV=development$/m);
  assert.match(bytes.toString(), /^PUBLIC_ORIGIN=http:\/\/127.0.0.1:4180$/m);
  assert.match(bytes.toString(), /^SMTP_HOST=smtp.qq.com$/m);
  assert.match(bytes.toString(), /^SMTP_PORT=465$/m);
  assert.match(bytes.toString(), /^INITIAL_ACCOUNT_EMAIL=391504704@qq.com$/m);
  assert.equal(bytes.toString().includes('DEV_MAIL_DIR'), false);
  assert.equal(bytes.toString().includes('DATABASE_URL'), false);
  assert.equal(fs.existsSync(path.join(directory, '.env.saas.test')), false);
  assert.equal(fs.existsSync(path.join(directory, '.env.saas.postgres')), false);
  assert.match(cli('init').stdout, /already exists/);
  assert.deepEqual(fs.readFileSync(local), bytes, 'repeat init preserves existing settings');
  assert.match(cli('bootstrap', 1).stderr, /INITIAL_ACCOUNT_PASSWORD/);
  fs.writeFileSync(local, bytes.toString().replace('INITIAL_ACCOUNT_PASSWORD=\n', 'INITIAL_ACCOUNT_PASSWORD=Synthetic-initial-password-17\n'));
  const result = JSON.parse(cli('bootstrap').stdout);
  assert.equal(result.ready, true); assert.equal(result.storage, 'sqlite');
  assert.equal(result.databasePath, path.join(directory, 'data', 'ttjf.sqlite'));
  const raw = new DatabaseSync(result.databasePath, { readOnly: true });
  try {
    assert.deepEqual(raw.prepare('SELECT version FROM saas_schema_migrations ORDER BY version').all().map(row => row.version), [1, 2]);
    const account = raw.prepare('SELECT email,verified_at FROM saas_users').get();
    assert.equal(account.email, '391504704@qq.com');
    assert.ok(account.verified_at);
  }
  finally { raw.close(); }
  fs.unlinkSync(local);
  fs.writeFileSync(path.join(directory, '.env.saas.postgres'), 'POSTGRES_PASSWORD=synthetic-only\n');
  assert.match(cli('init', 1).stderr, /Previous PostgreSQL environment/);
  assert.equal(fs.existsSync(local), false, 'legacy settings require explicit archival rather than silent replacement');
});
