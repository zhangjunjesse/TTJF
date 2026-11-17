'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const S = require('../saas/security.cjs');
const H = require('../saas/testing.cjs');
const { DEFAULT_ACCOUNT_EMAIL, initialAccountFromEnv, ensureInitialAccount } = require('../saas/initial-account.cjs');

const PASSWORD = 'Synthetic-initial-password-17';
const NEXT_PASSWORD = 'Synthetic-changed-password-17';
const AT = new Date('2026-11-17T01:02:03.000Z');

async function accountState(database) {
  const result = {};
  for (const table of ['saas_users', 'saas_families', 'saas_memberships', 'saas_family_requests',
    'saas_action_receipts', 'saas_sessions', 'saas_email_tokens']) {
    result[table] = (await database.query('SELECT * FROM ' + table)).rows;
  }
  return result;
}

test('initial account configuration is opt-in, defaults only the email and normalizes an explicit email', () => {
  assert.equal(DEFAULT_ACCOUNT_EMAIL, '391504704@qq.com');
  assert.equal(initialAccountFromEnv({}), null);
  assert.equal(initialAccountFromEnv({ SMTP_HOST: 'smtp.example.test' }), null);
  assert.deepEqual(initialAccountFromEnv({ INITIAL_ACCOUNT_PASSWORD: PASSWORD }),
    { email: DEFAULT_ACCOUNT_EMAIL, password: PASSWORD });
  assert.deepEqual(initialAccountFromEnv({ INITIAL_ACCOUNT_EMAIL: '  Operator@Example.Test  ', INITIAL_ACCOUNT_PASSWORD: PASSWORD }),
    { email: 'operator@example.test', password: PASSWORD });
  assert.deepEqual(initialAccountFromEnv({ INITIAL_ACCOUNT_EMAIL: '', INITIAL_ACCOUNT_PASSWORD: PASSWORD }),
    { email: DEFAULT_ACCOUNT_EMAIL, password: PASSWORD });
});

test('incomplete or invalid initial account configuration fails without echoing configured values', () => {
  const invalid = [
    { INITIAL_ACCOUNT_EMAIL: 'operator@example.test' },
    { INITIAL_ACCOUNT_PASSWORD: '' },
    { INITIAL_ACCOUNT_PASSWORD: 'short-key' },
    { INITIAL_ACCOUNT_PASSWORD: 'x'.repeat(129) },
    { INITIAL_ACCOUNT_PASSWORD: 1234567890 },
    { INITIAL_ACCOUNT_EMAIL: 'invalid-address-value', INITIAL_ACCOUNT_PASSWORD: PASSWORD },
    { INITIAL_ACCOUNT_EMAIL: 'a@example.test,b@example.test', INITIAL_ACCOUNT_PASSWORD: PASSWORD },
    { INITIAL_ACCOUNT_EMAIL: 'a@example.test\r\nBcc: b@example.test', INITIAL_ACCOUNT_PASSWORD: PASSWORD }
  ];
  for (const env of invalid) {
    assert.throws(() => initialAccountFromEnv(env), error => {
      assert.match(error.message, /INITIAL_ACCOUNT_(?:EMAIL|PASSWORD)/);
      for (const value of Object.values(env)) {
        if (String(value)) assert.ok(!String(error).includes(String(value)), 'configuration errors omit supplied values');
      }
      return true;
    });
  }
});

test('real SQLite provisioning creates one verified account with a usable scrypt hash and no mail or family', async t => {
  const f = await H.fixture(t, { maintenanceIntervalMs: 0 });
  const config = initialAccountFromEnv({ INITIAL_ACCOUNT_PASSWORD: PASSWORD });
  assert.deepEqual(await ensureInitialAccount(f.server.store, config, () => AT), { created: true });
  const rows = (await f.database.query('SELECT * FROM saas_users')).rows;
  assert.equal(rows.length, 1);
  const user = rows[0];
  assert.match(user.id, S.UUID);
  assert.equal(user.email, DEFAULT_ACCOUNT_EMAIL);
  assert.deepEqual(user.created_at, AT);
  assert.deepEqual(user.verified_at, AT);
  assert.equal(user.password_hash.algorithm, 'scrypt');
  assert.equal(user.password_hash.n, 32768);
  assert.equal(await S.checkPassword(PASSWORD, user.password_hash), true);
  assert.equal(await S.checkPassword(NEXT_PASSWORD, user.password_hash), false);
  assert.ok(!fs.readFileSync(f.databasePath).includes(Buffer.from(PASSWORD)));
  assert.equal((await f.database.query('SELECT count(*) AS count FROM saas_email_tokens')).rows[0].count, 0);
  assert.equal((await f.database.query('SELECT count(*) AS count FROM saas_families')).rows[0].count, 0);
  assert.equal(f.mail.length, 0);
  const login = await H.login(f, DEFAULT_ACCOUNT_EMAIL, PASSWORD);
  assert.equal(login.session.user.verified, true);
  assert.deepEqual(login.session.families, []);
});

test('repeated initialization keeps an existing verified account and all family data unchanged', async t => {
  const config = { email: 'existing-initial@example.test', password: PASSWORD };
  const f = await H.fixture(t, { initialAccount: config, maintenanceIntervalMs: 0 });
  const owner = await H.family(f, await H.login(f, config.email, PASSWORD));
  await H.setup(f, owner);
  const before = await accountState(f.database);
  f.clock.value += 86400000;
  assert.deepEqual(await ensureInitialAccount(f.server.store, { ...config, password: NEXT_PASSWORD }, () => new Date(f.clock.value)),
    { created: false });
  assert.deepEqual(await accountState(f.database), before);
  assert.equal(await S.checkPassword(PASSWORD, before.saas_users[0].password_hash), true);
  assert.equal(await S.checkPassword(NEXT_PASSWORD, before.saas_users[0].password_hash), false);
  assert.equal(f.mail.length, 0);
});

test('initialization does not verify or replace a pre-existing unverified account', async t => {
  const f = await H.fixture(t, { maintenanceIntervalMs: 0 });
  const user = await H.register(f, 'unverified-initial@example.test', false);
  const before = await accountState(f.database), messages = f.mail.length;
  assert.equal(before.saas_users[0].verified_at, null);
  assert.deepEqual(await ensureInitialAccount(f.server.store, { email: user.email, password: PASSWORD }), { created: false });
  assert.deepEqual(await accountState(f.database), before);
  assert.equal(f.mail.length, messages);
  assert.equal(await S.checkPassword(H.PASSWORD, before.saas_users[0].password_hash), true);
});

test('a password changed through auth survives a real SQLite close, reopen and server restart', async t => {
  const config = { email: 'changed-initial@example.test', password: PASSWORD };
  const f = await H.fixture(t, { initialAccount: config, maintenanceIntervalMs: 0 });
  const owner = await H.family(f, await H.login(f, config.email, PASSWORD));
  const changed = await H.request(f.server, 'POST', '/api/auth/change-password',
    { currentPassword: PASSWORD, password: NEXT_PASSWORD }, owner);
  assert.equal(changed.status, 200);
  const before = await accountState(f.database);
  await f.server.closeSaas();
  await f.database.close();
  const database = await f.openDatabase();
  f.clock.value += 3600000;
  const restarted = await f.start({ database });
  assert.deepEqual(await accountState(database), before);
  const login = await H.login(f, config.email, NEXT_PASSWORD, restarted);
  assert.equal(login.userId, owner.userId);
  assert.equal(login.session.user.verified, true);
  assert.deepEqual(login.session.families.map(family => family.id), [owner.familyId]);
  assert.equal((await H.request(restarted, 'POST', '/api/auth/login', config)).status, 401);
  assert.equal(f.mail.length, 0);
});

test('no initial account configuration leaves real SQLite empty', async t => {
  const f = await H.fixture(t, { maintenanceIntervalMs: 0 });
  assert.deepEqual(await ensureInitialAccount(f.server.store, initialAccountFromEnv({})), { created: false });
  assert.deepEqual(await ensureInitialAccount(f.server.store, undefined), { created: false });
  assert.equal((await f.database.query('SELECT count(*) AS count FROM saas_users')).rows[0].count, 0);
  assert.equal(f.mail.length, 0);
});

test('concurrent same-email provisioning through the shared SQLite queue creates exactly one account', async t => {
  const f = await H.fixture(t, { maintenanceIntervalMs: 0 }), second = await f.start();
  const stores = [f.server.store, second.store];
  const configs = Array.from({ length: 8 }, (_, index) =>
    ({ email: index % 2 ? '  Race@Example.Test  ' : 'race@example.test', password: PASSWORD + '-' + index }));
  const results = await Promise.all(configs.map((config, index) => ensureInitialAccount(stores[index % stores.length], config, () => AT)));
  assert.equal(results.filter(result => result.created).length, 1);
  for (const result of results) assert.deepEqual(Object.keys(result), ['created']);
  const rows = (await f.database.query('SELECT * FROM saas_users')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'race@example.test');
  assert.deepEqual(rows[0].verified_at, AT);
  assert.equal(await S.checkPassword(configs[results.findIndex(result => result.created)].password, rows[0].password_hash), true);
  assert.equal(f.mail.length, 0);
});

test('invalid explicit configuration and clock never leave a partially initialized account', async t => {
  const f = await H.fixture(t, { maintenanceIntervalMs: 0 });
  await assert.rejects(ensureInitialAccount(f.server.store, { email: 'invalid-initial-address', password: PASSWORD }), /INITIAL_ACCOUNT_EMAIL/);
  await assert.rejects(ensureInitialAccount(f.server.store, { email: 'invalid-initial@example.test' }), /INITIAL_ACCOUNT_PASSWORD/);
  const config = { email: 'valid-after-failure@example.test', password: PASSWORD };
  await assert.rejects(ensureInitialAccount(f.server.store, config, () => new Date(NaN)), /valid date/);
  assert.equal((await f.database.query('SELECT count(*) AS count FROM saas_users')).rows[0].count, 0);
  assert.deepEqual(await ensureInitialAccount(f.server.store, config, () => AT), { created: true });
});
