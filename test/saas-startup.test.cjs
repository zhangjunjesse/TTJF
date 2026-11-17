'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createSaasServer } = require('../saas-server.cjs');

test('removed PostgreSQL constructor options fail before opening a new database', async () => {
  await assert.rejects(createSaasServer({ databaseUrl: 'postgresql://old-database' }), /no longer supported/);
  await assert.rejects(createSaasServer({ pool: {} }), /no longer supported/);
});

test('direct Node startup initializes the configured account and explicit test mail, preserving accounts after restart', { timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ttjf-startup-'));
  const databasePath = path.join(directory, 'app.sqlite'), mailDirectory = path.join(directory, 'mail');
  const portProbe = net.createServer();
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(NODE_ENV|NODE_OPTIONS|PUBLIC_ORIGIN|DATABASE_URL|SQLITE_FILE|DEV_MAIL_DIR|MAIL_FROM|SMTP_.*|SAAS_.*|INITIAL_ACCOUNT_.*|HOST|PORT|AI_.*)$/i.test(name)) delete env[name];
  }
  Object.assign(env, { SQLITE_FILE: databasePath, DEV_MAIL_DIR: mailDirectory, SAAS_PORT: String(port), SAAS_HOST: '127.0.0.1' });
  const initialAccount = { email: 'operator-startup@example.test', password: 'Synthetic-initial-startup-password' };
  Object.assign(env, { INITIAL_ACCOUNT_EMAIL: initialAccount.email, INITIAL_ACCOUNT_PASSWORD: initialAccount.password });
  let child, exited;
  async function stop() {
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    child = undefined;
  }
  t.after(async () => {
    await stop();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^ttjf-startup-[A-Za-z0-9]+$/);
    assert.equal(fs.realpathSync(directory), directory);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function start() {
    child = spawn(process.execPath, [path.resolve(__dirname, '..', 'saas-server.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    exited = once(child, 'exit');
    let output = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CLI startup timed out: ' + output)), 10000);
      const receive = chunk => {
        output += chunk;
        if (output.includes('SaaS listening on')) { clearTimeout(timer); resolve(); }
      };
      child.stdout.on('data', receive); child.stderr.on('data', receive);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('CLI exited before startup: ' + output)); });
    });
  }
  async function post(route, body) {
    return fetch(origin + route, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  }
  await start();
  assert.deepEqual(await (await fetch(origin + '/api/health', { signal: AbortSignal.timeout(5000) })).json(), { ok: true });
  const initialLogin = await post('/api/auth/login', initialAccount);
  assert.equal(initialLogin.status, 200);
  const initialSession = await initialLogin.json();
  assert.equal(initialSession.user.email, initialAccount.email);
  assert.equal(initialSession.user.verified, true);
  const account = { email: 'startup@example.test', password: 'SQLite-startup-password-15' };
  assert.equal((await post('/api/auth/register', account)).status, 202);
  const messages = fs.readdirSync(mailDirectory).map(file => JSON.parse(fs.readFileSync(path.join(mailDirectory, file), 'utf8')));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, account.email);
  assert.ok(messages[0].text.includes(origin + '/#verify='));
  const token = /#verify=([A-Za-z0-9_-]{43})/.exec(messages[0].text)[1];
  assert.equal((await post('/api/auth/verify-email', { token })).status, 200);
  assert.equal(fs.readFileSync(databasePath).subarray(0, 16).toString(), 'SQLite format 3\0');
  await stop();
  await start();
  const restartedInitialLogin = await post('/api/auth/login', initialAccount);
  assert.equal(restartedInitialLogin.status, 200);
  assert.equal((await restartedInitialLogin.json()).user.id, initialSession.user.id);
  const login = await post('/api/auth/login', account);
  assert.equal(login.status, 200);
  const session = await login.json();
  assert.equal(session.user.email, account.email);
  assert.equal(session.user.verified, true);
});

test('ordinary CLI startup fails without SMTP instead of silently creating a file mailbox', { timeout: 15000 }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ttjf-no-smtp-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^ttjf-no-smtp-[A-Za-z0-9]+$/);
    assert.equal(fs.realpathSync(directory), directory);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(NODE_ENV|NODE_OPTIONS|PUBLIC_ORIGIN|DATABASE_URL|SQLITE_FILE|DEV_MAIL_DIR|MAIL_FROM|SMTP_.*|SAAS_.*|INITIAL_ACCOUNT_.*|HOST|PORT|AI_.*)$/i.test(name)) delete env[name];
  }
  env.SQLITE_FILE = path.join(directory, 'app.sqlite');
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'saas-server.cjs')], {
    env, cwd: directory, encoding: 'utf8', timeout: 10000, windowsHide: true
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Configure SMTP/);
  assert.equal(fs.existsSync(env.SQLITE_FILE), false);
  assert.deepEqual(fs.readdirSync(directory), []);
});
