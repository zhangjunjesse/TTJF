'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { setImmediate: immediate } = require('node:timers/promises');
const { createDatabase, resolveDatabasePath } = require('../saas/sqlite.cjs');
const { createStore, migrate, assertDatabaseSchema } = require('../saas/store.cjs');

const AT = new Date('2026-11-17T00:00:00.000Z');
const AFTER = new Date(+AT + 3600000);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ttjf-sqlite-test-'));
  const resources = [];
  t.after(async () => {
    const results = await Promise.allSettled(resources.reverse().map(resource => resource.close()));
    const actual = fs.realpathSync(root), temporary = fs.realpathSync(os.tmpdir());
    const relative = path.relative(temporary, actual);
    assert.ok(!path.isAbsolute(relative) && !relative.startsWith('..') && path.basename(actual).startsWith('ttjf-sqlite-test-'));
    fs.rmSync(actual, { recursive: true, force: true });
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });
  return {
    root,
    file: name => path.join(root, name || 'authority.sqlite'),
    async open(name = 'authority.sqlite', options = {}) {
      const database = await createDatabase({ databasePath: path.join(root, name), ...options });
      resources.push(database);
      return database;
    },
    async store(options = {}) {
      const store = await createStore({ databasePath: path.join(root, 'authority.sqlite'), ...options });
      resources.push(store);
      return store;
    }
  };
}
async function user(client, email) {
  const id = crypto.randomUUID();
  await client.query('INSERT INTO saas_users(id,email,password_hash,verified_at,created_at) VALUES($1,$2,$3,$4,$4)',
    [id, email, { algorithm: 'scrypt', digest: 'private' }, AT]);
  return id;
}
async function family(store) {
  return store.transaction(async client => {
    const owner = await user(client, 'owner@example.test'), parent = await user(client, 'parent@example.test');
    const id = crypto.randomUUID();
    await client.query('INSERT INTO saas_families(id,name,state,owner_user_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)',
      [id, 'Family', { points: [], label: '秘密' }, owner, AT]);
    await client.query("INSERT INTO saas_memberships(family_id,user_id,role,created_at) VALUES($1,$2,'owner',$4),($1,$3,'parent',$4)", [id, owner, parent, AT]);
    return { id, owner, parent };
  });
}
function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('SQLite persists bound JSON/dates, typed aliases and row counts across reopen', async t => {
  const f = fixture(t), store = await f.store(), database = store.database;
  const hash = { algorithm: 'scrypt', salt: '保密', digest: 'quoted\'value' };
  const id = crypto.randomUUID();
  const inserted = await database.query('INSERT INTO saas_users(id,email,password_hash,created_at) VALUES($1,$2,$3,$4) RETURNING id,password_hash,created_at',
    [id, 'persist@example.test', hash, AT]);
  assert.equal(inserted.rowCount, 1);
  assert.deepEqual(inserted.rows[0], { id, password_hash: hash, created_at: AT });
  assert.equal(Object.getPrototypeOf(inserted.rows[0]), Object.prototype);
  const bound = await database.query('SELECT $2 AS second,$1 AS first,$2 AS repeated', ["'; DROP TABLE saas_users; --", 42]);
  assert.deepEqual(bound.rows, [{ second: 42, first: "'; DROP TABLE saas_users; --", repeated: 42 }]);
  assert.deepEqual(await database.query('UPDATE saas_users SET verified_at=$2 WHERE id=$1', [id, AT]), { rows: [], rowCount: 1 });
  assert.equal((await database.query('UPDATE saas_users SET verified_at=$2 WHERE id=$1', [crypto.randomUUID(), AT])).rowCount, 0);
  await store.close();
  const reopened = await f.store({ migrate: false });
  assert.deepEqual((await reopened.database.query('SELECT password_hash AS credentials,created_at AS created,verified_at FROM saas_users WHERE id=$1', [id])).rows,
    [{ credentials: hash, created: AT, verified_at: AT }]);
  assert.deepEqual((await reopened.database.query('SELECT count(*) AS n FROM saas_users')).rows, [{ n: 1 }]);
  await assert.rejects(database.query('SELECT 1'), /closed/);
});

test('SQLite queue isolates an async transaction, rolls back all writes and keeps later work usable', async t => {
  const f = fixture(t), database = await f.open();
  await database.exec('CREATE TABLE ledger(id TEXT PRIMARY KEY,value INTEGER NOT NULL) STRICT;');
  const entered = gate(), release = gate();
  const transaction = database.transaction(async client => {
    await client.query('INSERT INTO ledger VALUES($1,$2)', ['uncommitted', 1]);
    entered.resolve();
    await release.promise;
    assert.deepEqual((await client.query('SELECT id FROM ledger')).rows, [{ id: 'uncommitted' }]);
    throw new Error('injected failure');
  });
  await entered.promise;
  let observed = false;
  const outsideWrite = database.query('INSERT INTO ledger VALUES($1,$2)', ['committed', 2]);
  const outsideRead = database.query('SELECT * FROM ledger').then(result => { observed = true; return result; });
  await immediate();
  assert.equal(observed, false);
  release.resolve();
  await assert.rejects(transaction, /injected failure/);
  assert.equal((await outsideWrite).rowCount, 1);
  assert.deepEqual((await outsideRead).rows, [{ id: 'committed', value: 2 }]);
  await database.transaction(client => client.query('UPDATE ledger SET value=3 WHERE id=$1', ['committed']));
  assert.equal((await database.query('SELECT value FROM ledger')).rows[0].value, 3);
});

test('SQLite automatic rollback cannot turn a caught transaction failure into autocommitted writes or a successful commit', async t => {
  const f = fixture(t), database = await f.open();
  await database.exec('CREATE TABLE ledger(id INTEGER PRIMARY KEY) STRICT;');
  await assert.rejects(database.transaction(async client => {
    await client.query('INSERT INTO ledger VALUES(1)');
    await assert.rejects(client.query('INSERT OR ROLLBACK INTO ledger VALUES(1)'), /UNIQUE/);
    await assert.rejects(client.query('INSERT INTO ledger VALUES(2)'), /rolled back/);
    await assert.rejects(client.exec('INSERT INTO ledger VALUES(3);'), /rolled back/);
    throw new Error('callback also failed');
  }), /callback also failed/);
  assert.deepEqual((await database.query('SELECT * FROM ledger')).rows, []);
  await assert.rejects(database.transaction(async client => {
    await client.query('INSERT INTO ledger VALUES(1)');
    await assert.rejects(client.exec('INSERT OR ROLLBACK INTO ledger VALUES(1);'), /UNIQUE/);
    return 'cannot commit';
  }), /rolled back/);
  assert.deepEqual((await database.query('SELECT * FROM ledger')).rows, []);
  await database.transaction(client => client.query('INSERT INTO ledger VALUES(4)'));
  assert.deepEqual((await database.query('SELECT * FROM ledger')).rows, [{ id: 4 }]);
});

test('SQLite backup and close wait for a transaction and preserve a consistent committed snapshot', async t => {
  const f = fixture(t), database = await f.open();
  await database.exec('CREATE TABLE ledger(id INTEGER PRIMARY KEY) STRICT;');
  const entered = gate(), release = gate();
  const transaction = database.transaction(async client => {
    await client.query('INSERT INTO ledger VALUES(1)');
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const destination = f.file('backup.sqlite');
  const backup = database.backup(destination);
  const laterWrite = database.query('INSERT INTO ledger VALUES(2)');
  const close = database.close();
  assert.equal(fs.existsSync(destination), false);
  await assert.rejects(database.query('SELECT 1'), /closed/);
  release.resolve();
  await transaction;
  const result = await backup;
  assert.equal(result.databasePath, destination);
  assert.ok(result.pages > 0);
  await laterWrite;
  await close;
  await database.close();
  const snapshot = await f.open('backup.sqlite', { mustExist: true });
  const source = await f.open('authority.sqlite', { mustExist: true });
  assert.deepEqual((await snapshot.query('SELECT * FROM ledger')).rows, [{ id: 1 }]);
  assert.deepEqual((await source.query('SELECT * FROM ledger ORDER BY id')).rows, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual((await snapshot.query('PRAGMA integrity_check')).rows, [{ integrity_check: 'ok' }]);
  const before = fs.readFileSync(destination);
  await assert.rejects(source.backup(destination), /already exists/);
  assert.deepEqual(fs.readFileSync(destination), before);
});

test('SQLite enforces exactly one owner at commit and supports an atomic ownership transfer', async t => {
  const f = fixture(t), store = await f.store(), database = store.database;
  const current = await family(store);
  const ownerlessId = crypto.randomUUID();
  await assert.rejects(store.transaction(client => client.query('INSERT INTO saas_families(id,name,state,owner_user_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)',
    [ownerlessId, 'Ownerless', {}, current.owner, AT])), /FOREIGN KEY/);
  assert.equal((await database.query('SELECT 1 FROM saas_families WHERE id=$1', [ownerlessId])).rowCount, 0);
  await assert.rejects(store.transaction(client => client.query('DELETE FROM saas_memberships WHERE family_id=$1 AND user_id=$2', [current.id, current.owner])), /FOREIGN KEY/);
  await assert.rejects(store.transaction(client => client.query('UPDATE saas_families SET owner_user_id=$2 WHERE id=$1', [current.id, current.parent])), /FOREIGN KEY/);
  await assert.rejects(store.transaction(client => client.query("UPDATE saas_memberships SET role='owner' WHERE family_id=$1 AND user_id=$2", [current.id, current.parent])), /UNIQUE/);
  await assert.rejects(store.transaction(client => client.query("UPDATE saas_families SET owner_role='parent' WHERE id=$1", [current.id])), /CHECK/);
  await store.transaction(async client => {
    await client.query("UPDATE saas_memberships SET role='parent' WHERE family_id=$1 AND user_id=$2", [current.id, current.owner]);
    await client.query("UPDATE saas_memberships SET role='owner' WHERE family_id=$1 AND user_id=$2", [current.id, current.parent]);
    await client.query('UPDATE saas_families SET owner_user_id=$2 WHERE id=$1', [current.id, current.parent]);
  });
  assert.deepEqual((await database.query("SELECT user_id FROM saas_memberships WHERE family_id=$1 AND role='owner'", [current.id])).rows, [{ user_id: current.parent }]);
  assert.equal((await database.query('SELECT owner_user_id FROM saas_families WHERE id=$1', [current.id])).rows[0].owner_user_id, current.parent);
  assert.equal((await database.query('PRAGMA foreign_key_check')).rowCount, 0);
  // A failed deferred COMMIT must have been rolled back: later transactions
  // succeeded and no ownerless family or deleted original member leaked out.
  assert.equal((await database.query('SELECT 1 FROM saas_memberships WHERE family_id=$1 AND user_id=$2', [current.id, current.owner])).rowCount, 1);
});

test('SQLite foreign keys retain in-flight leases while cascading revoked permissions and deleted families', async t => {
  const f = fixture(t), store = await f.store(), database = store.database;
  const current = await family(store), session = '1'.repeat(64), invitation = crypto.randomUUID(), lease = crypto.randomUUID();
  await store.transaction(async client => {
    await client.query('INSERT INTO saas_sessions(token_hash,user_id,csrf_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5)', [session, current.parent, '2'.repeat(64), AT, AFTER]);
    await client.query('INSERT INTO saas_invitations(id,family_id,email,token_hash,invited_by,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [invitation, current.id, 'invite@example.test', '3'.repeat(64), current.parent, AT, AFTER]);
    await client.query('INSERT INTO saas_assistant_leases(id,family_id,user_id,session_hash,expires_at) VALUES($1,$2,$3,$4,$5)', [lease, current.id, current.parent, session, AFTER]);
    await client.query('INSERT INTO saas_parent_grants(token_hash,family_id,user_id,session_hash,revision,action_receipt,expires_at) VALUES($1,$2,$3,$4,1,$5,$6)',
      ['grant', current.id, current.parent, session, { digest: 'action' }, AFTER]);
    await client.query("INSERT INTO saas_parent_challenges(token_hash,family_id,user_id,session_hash,revision,action_receipt,method,expires_at) VALUES($1,$2,$3,$4,1,$5,'math',$6)",
      ['challenge', current.id, current.parent, session, { digest: 'action' }, AFTER]);
    await client.query('INSERT INTO saas_action_receipts(family_id,action_id,receipt,revision,created_at) VALUES($1,$2,$3,1,$4)', [current.id, 'action', { digest: 'receipt' }, AT]);
    await client.query('DELETE FROM saas_memberships WHERE family_id=$1 AND user_id=$2', [current.id, current.parent]);
  });
  assert.equal((await database.query('SELECT 1 FROM saas_parent_grants')).rowCount, 0);
  assert.equal((await database.query('SELECT 1 FROM saas_parent_challenges')).rowCount, 0);
  assert.equal((await database.query('SELECT 1 FROM saas_assistant_leases')).rowCount, 1);
  await database.query('DELETE FROM saas_sessions WHERE token_hash=$1', [session]);
  assert.equal((await database.query('SELECT session_hash FROM saas_assistant_leases')).rows[0].session_hash, null);
  await database.query('DELETE FROM saas_users WHERE id=$1', [current.parent]);
  assert.equal((await database.query('SELECT user_id FROM saas_assistant_leases')).rows[0].user_id, null);
  assert.equal((await database.query('SELECT invited_by FROM saas_invitations')).rows[0].invited_by, null);
  await database.query('DELETE FROM saas_families WHERE id=$1', [current.id]);
  for (const table of ['saas_memberships', 'saas_invitations', 'saas_assistant_leases', 'saas_action_receipts']) {
    assert.equal((await database.query('SELECT count(*) AS n FROM ' + table)).rows[0].n, 0, table);
  }
  assert.equal((await database.query('PRAGMA foreign_key_check')).rowCount, 0);
});

test('SQLite UUID comparisons, foreign keys and unique identities preserve case-insensitive UUID semantics', async t => {
  const f = fixture(t), store = await f.store(), database = store.database;
  const current = await family(store);
  assert.equal((await database.query('SELECT id FROM saas_families WHERE id=$1', [current.id.toUpperCase()])).rows[0].id, current.id);
  assert.equal((await database.query('SELECT user_id FROM saas_memberships WHERE family_id=$1 AND user_id=$2',
    [current.id.toUpperCase(), current.owner.toUpperCase()])).rows[0].user_id, current.owner);
  await assert.rejects(database.query('INSERT INTO saas_users(id,email,password_hash,created_at) VALUES($1,$2,$3,$4)',
    [current.owner.toUpperCase(), 'duplicate@example.test', {}, AT]), /UNIQUE/);
  await store.transaction(async client => {
    await client.query("UPDATE saas_memberships SET role='parent' WHERE family_id=$1 AND user_id=$2", [current.id.toUpperCase(), current.owner.toUpperCase()]);
    await client.query("UPDATE saas_memberships SET role='owner' WHERE family_id=$1 AND user_id=$2", [current.id.toUpperCase(), current.parent.toUpperCase()]);
    await client.query('UPDATE saas_families SET owner_user_id=$2 WHERE id=$1', [current.id.toUpperCase(), current.parent.toUpperCase()]);
    await client.query('INSERT INTO saas_action_receipts(family_id,action_id,receipt,revision,created_at) VALUES($1,$2,$3,1,$4),($1,$5,$3,1,$4)',
      [current.id.toUpperCase(), 'CaseSensitive', {}, AT, 'casesensitive']);
  });
  assert.equal((await database.query('PRAGMA foreign_key_check')).rowCount, 0);
  assert.equal((await database.query('SELECT 1 FROM saas_action_receipts')).rowCount, 2);
  await database.query('DELETE FROM saas_families WHERE id=$1', [current.id.toUpperCase()]);
  assert.equal((await database.query('SELECT 1 FROM saas_memberships')).rowCount, 0);
});

test('SQLite migrations are queued/idempotent, preserve supplied databases and refuse unrelated schemas', async t => {
  const f = fixture(t), database = await f.open();
  await Promise.all([migrate(database), migrate(database)]);
  assert.deepEqual((await database.query('SELECT version FROM saas_schema_migrations ORDER BY version')).rows, [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
  const supplied = await f.store({ database });
  await supplied.close();
  assert.equal((await database.query('SELECT 1 AS value')).rows[0].value, 1);
  await assertDatabaseSchema(database);
  const other = await f.open('unrelated.sqlite');
  await other.exec('CREATE TABLE unrelated(value TEXT) STRICT;');
  await assert.rejects(migrate(other), /another schema/);
  assert.deepEqual((await other.query("SELECT name FROM sqlite_schema WHERE type='table'")).rows, [{ name: 'unrelated' }]);
  await database.query('INSERT INTO saas_schema_migrations(version) VALUES(5)');
  await assert.rejects(migrate(database), /unsupported/);
});

test('SQLite schema validation rejects missing columns and reports broken foreign keys without decoding metadata as JSON', async t => {
  const f = fixture(t), store = await f.store(), database = store.database;
  await database.exec('PRAGMA foreign_keys=OFF;');
  await database.query('INSERT INTO saas_sessions(token_hash,user_id,csrf_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5)',
    ['a'.repeat(64), crypto.randomUUID(), 'b'.repeat(64), AT, AFTER]);
  await database.exec('PRAGMA foreign_keys=ON;');
  const broken = await database.query('PRAGMA foreign_key_check');
  assert.equal(broken.rows[0].parent, 'saas_users');
  await assert.rejects(assertDatabaseSchema(database), /broken foreign key/);
  await database.query('DELETE FROM saas_sessions');
  await database.exec('ALTER TABLE saas_users DROP COLUMN verified_at;');
  await assert.rejects(assertDatabaseSchema(database), /missing required columns in saas_users/);
});

test('SQLite version 3 upgrades to current parent-device schema without changing existing account or family data', async t => {
  const f = fixture(t), database = await f.open();
  for (const file of ['001-initial.sql', '002-lifecycle.sql', '003-assistant-chat.sql']) {
    await database.exec(fs.readFileSync(path.join(__dirname, '../saas/migrations', file), 'utf8'));
  }
  const store = { transaction: callback => database.transaction(callback) };
  const existing = await family(store);
  const accounts = (await database.query('SELECT * FROM saas_users')).rows;
  const families = (await database.query('SELECT * FROM saas_families')).rows;
  await assert.rejects(assertDatabaseSchema(database), /unsupported/);
  await assertDatabaseSchema(database, { allowV3Backup: true });
  await Promise.all([migrate(database), migrate(database)]);
  assert.deepEqual((await database.query('SELECT version FROM saas_schema_migrations ORDER BY version')).rows.map(row => row.version), [1, 2, 3, 4]);
  assert.deepEqual((await database.query('SELECT * FROM saas_users')).rows, accounts);
  assert.deepEqual((await database.query('SELECT * FROM saas_families')).rows, families);
  assert.deepEqual((await database.query('SELECT * FROM saas_parent_devices')).rows, []);
  assert.ok(existing);
  await database.exec('DROP TABLE saas_parent_devices');
  await assert.rejects(assertDatabaseSchema(database), /missing or incomplete/);
  await assert.rejects(assertDatabaseSchema(database, { allowV3Backup: true }), /missing or incomplete/, 'v4 cannot omit its current authorization table');
});

test('SQLite uses DELETE journaling, FULL synchronization, foreign keys and a bounded busy wait', async t => {
  const f = fixture(t), database = await f.open();
  assert.deepEqual((await database.query('PRAGMA journal_mode')).rows, [{ journal_mode: 'delete' }]);
  assert.deepEqual((await database.query('PRAGMA synchronous')).rows, [{ synchronous: 2 }]);
  assert.deepEqual((await database.query('PRAGMA foreign_keys')).rows, [{ foreign_keys: 1 }]);
  assert.deepEqual((await database.query('PRAGMA busy_timeout')).rows, [{ timeout: 5000 }]);
});

test('SQLite SQL scripts support triggers while transaction controls and escaped clients cannot bypass the queue', async t => {
  const f = fixture(t), database = await f.open();
  await database.exec(`CREATE TABLE values_table(value TEXT) STRICT;
    CREATE TABLE audit(value TEXT) STRICT;
    CREATE TRIGGER value_audit AFTER INSERT ON values_table BEGIN
      INSERT INTO audit(value) VALUES(NEW.value);
      INSERT INTO audit(value) VALUES('; COMMIT;');
    END;`);
  await database.query('INSERT INTO values_table VALUES($1)', ['bound']);
  assert.deepEqual((await database.query('SELECT value FROM audit ORDER BY rowid')).rows, [{ value: 'bound' }, { value: '; COMMIT;' }]);
  await assert.rejects(database.query('SELECT 1; SELECT 2'), /one SQLite statement/);
  await assert.rejects(database.exec('-- managed\nBEGIN IMMEDIATE;'), /database.transaction/);
  await assert.rejects(database.exec('INSERT INTO values_table VALUES(\'first\'); COMMIT;'), /database.transaction/);
  let escaped;
  await database.transaction(async client => {
    escaped = client;
    await assert.rejects(database.query('SELECT 1'), /supplied transaction client/);
    await assert.rejects(database.transaction(() => {}), /supplied transaction client/);
    await assert.rejects(database.close(), /supplied transaction client/);
    await client.query('SELECT 1');
  });
  await assert.rejects(escaped.query('SELECT 1'), /no longer active/);
  assert.equal((await database.query('SELECT count(*) AS n FROM values_table')).rows[0].n, 2);
});

test('SQLite paths reject public sources, URLs and symlink escapes without creating missing databases', async t => {
  const f = fixture(t), project = path.resolve(__dirname, '..');
  for (const target of [path.join(project, 'assets', 'example.png'), path.join(project, '.env.saas.local'), ':memory:', 'file:authority.sqlite', 'postgresql://user:secret@localhost/private']) {
    await assert.rejects(createDatabase({ databasePath: target }), /private|file path/);
  }
  const missing = f.file('not-created/database.sqlite');
  await assert.rejects(createDatabase({ databasePath: missing, mustExist: true }), /does not exist/);
  assert.equal(fs.existsSync(path.dirname(missing)), false);
  const publicLink = f.file('public-link');
  const danglingLink = f.file('dangling-link');
  fs.symlinkSync(path.join(project, 'assets'), publicLink, process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(f.file('missing-target'), danglingLink, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => resolveDatabasePath(path.join(publicLink, 'exposed.sqlite')), /assets|source/);
  assert.throws(() => resolveDatabasePath(path.join(danglingLink, 'broken.sqlite')), /dangling/);
  const database = await f.open();
  await assert.rejects(database.backup(path.join(publicLink, 'backup.sqlite')), /assets|source/);
  await assert.rejects(database.backup(danglingLink), /dangling/);
});

test('SQLite startup rejects legacy URLs safely and migrate:false never provisions a database', async t => {
  const f = fixture(t), previousUrl = process.env.DATABASE_URL, previousFile = process.env.SQLITE_FILE;
  t.after(() => {
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
    if (previousFile === undefined) delete process.env.SQLITE_FILE; else process.env.SQLITE_FILE = previousFile;
  });
  process.env.DATABASE_URL = 'postgresql://username:very-private-password@localhost/old';
  delete process.env.SQLITE_FILE;
  await assert.rejects(createStore(), error => /DATABASE_URL/.test(error.message) && !error.message.includes('very-private-password'));
  const missing = f.file('not-created.sqlite');
  // Container defaults must not silently turn an old PostgreSQL deployment
  // into an apparently empty new SQLite installation.
  process.env.SQLITE_FILE = missing;
  await assert.rejects(async () => {
    const unexpected = await createStore();
    await unexpected.close();
  }, /DATABASE_URL/);
  assert.equal(fs.existsSync(missing), false);
  delete process.env.DATABASE_URL;
  await assert.rejects(createStore({ databasePath: missing, migrate: false }), /does not exist/);
  assert.equal(fs.existsSync(missing), false);
  process.env.SQLITE_FILE = f.file();
  const store = await f.store();
  const shared = await f.store({ database: store.database, migrate: false });
  await shared.close();
  assert.equal((await store.database.query('SELECT 1 AS value')).rows[0].value, 1);
  const unrelated = await f.open('other.sqlite');
  await unrelated.exec('CREATE TABLE other(value TEXT) STRICT;');
  await assert.rejects(f.store({ database: unrelated, migrate: false }), /missing or incomplete/);
  assert.deepEqual((await unrelated.query("SELECT name FROM sqlite_schema WHERE type='table'")).rows, [{ name: 'other' }]);
});
