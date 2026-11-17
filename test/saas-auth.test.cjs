'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSaasServer } = require('../saas-server.cjs');
const { createMailer } = require('../saas/mail.cjs');
const S = require('../saas/security.cjs');
const H = require('../saas/testing.cjs');

test('real SQLite registration verifies once, hashes credentials/tokens, preserves empty account and revocable opaque sessions', async t => {
  const f = await H.fixture(t);
  for (const email of ['a,b@example.test', 'a;other@example.test', '"quoted"@example.test', 'a@example.test\r\nBcc:other@example.test']) {
    const invalid = await H.request(f.server, 'POST', '/api/auth/register', { email, password: H.PASSWORD });
    assert.equal(invalid.status, 400);
  }
  assert.equal(f.mail.length, 0);
  const user = await H.register(f, 'owner@example.test', false);
  assert.equal(user.session.user.verified, false);
  assert.deepEqual(user.session.families, []);
  const denied = await H.request(f.server, 'POST', '/api/families', { name: '家', childName: '新孩子', requestId: 'before-verify' }, user);
  assert.equal(denied.status, 403); assert.equal(denied.body.code, 'EMAIL_UNVERIFIED');
  assert.equal((await f.database.query('SELECT count(*) AS n FROM saas_families')).rows[0].n, 0);
  const token = H.mailToken(f, user.email, 'verify');
  const stored = (await f.database.query('SELECT * FROM saas_email_tokens')).rows[0];
  assert.equal(stored.token_hash, S.digest(token)); assert.notEqual(stored.token_hash, token);
  const row = (await f.database.query('SELECT * FROM saas_users')).rows[0];
  assert.equal(row.password_hash.algorithm, 'scrypt'); assert.equal(row.password_hash.n, 32768);
  assert.ok(!JSON.stringify(row).includes(H.PASSWORD));
  assert.equal((await H.request(f.server, 'POST', '/api/auth/verify-email', { token }, user, { noCsrf: true })).status, 403);
  assert.equal((await H.request(f.server, 'POST', '/api/auth/verify-email', { token }, user)).status, 200);
  assert.equal((await H.request(f.server, 'POST', '/api/auth/verify-email', { token }, user)).body.code, 'TOKEN_INVALID');
  const session = await H.request(f.server, 'GET', '/api/session', undefined, user);
  assert.equal(session.body.user.verified, true); assert.equal(session.headers['cache-control'], 'no-store');
  const second = await f.start();
  assert.equal((await H.request(second, 'GET', '/api/session', undefined, user)).body.user.id, user.userId);
  const sessionRow = (await f.database.query('SELECT * FROM saas_sessions')).rows[0];
  const raw = user.cookie.split('=')[1];
  assert.equal(sessionRow.token_hash, S.digest(raw)); assert.equal(sessionRow.csrf_hash, S.digest(user.csrfToken));
  assert.equal((await H.request(second, 'POST', '/api/auth/logout', {}, user)).status, 200);
  assert.deepEqual((await H.request(f.server, 'GET', '/api/session', undefined, user)).body, { authenticated: false });
  assert.ok((await f.database.query('SELECT revoked_at FROM saas_sessions')).rows[0].revoked_at);
});

test('real SQLite password reset, expiry and password change revoke sessions across request handlers with one-use tokens', async t => {
  const f = await H.fixture(t);
  const user = await H.register(f, 'password@example.test');
  const other = await H.login(f, user.email);
  const second = await f.start();
  const unknown = await H.request(f.server, 'POST', '/api/auth/forgot-password', { email: 'unknown@example.test' });
  const known = await H.request(second, 'POST', '/api/auth/forgot-password', { email: user.email });
  assert.equal(unknown.status, 202); assert.deepEqual(known.body, unknown.body);
  const token = H.mailToken(f, user.email, 'reset');
  const newPassword = 'Updated-family-password';
  const [a, b] = await Promise.all([f.server, second].map(server => H.request(server, 'POST', '/api/auth/reset-password', { token, password: newPassword })));
  assert.deepEqual([a.status, b.status].sort(), [200, 400]);
  assert.equal((await H.request(second, 'GET', '/api/session', undefined, user)).body.authenticated, false);
  assert.equal((await H.request(second, 'GET', '/api/session', undefined, other)).body.authenticated, false);
  assert.equal((await H.request(f.server, 'POST', '/api/auth/login', { email: user.email, password: H.PASSWORD })).status, 401);
  const current = await H.login(f, user.email, newPassword), sibling = await H.login(f, user.email, newPassword, second);
  assert.equal((await H.request(f.server, 'POST', '/api/auth/change-password', { currentPassword: 'wrong-password', password: H.PASSWORD }, current)).body.code, 'PASSWORD_INVALID');
  assert.equal((await H.request(f.server, 'POST', '/api/auth/change-password', { currentPassword: newPassword, password: H.PASSWORD }, current)).status, 200);
  assert.equal((await H.request(second, 'GET', '/api/session', undefined, sibling)).body.authenticated, false);
  assert.equal((await H.request(second, 'GET', '/api/session', undefined, current)).body.authenticated, true);
  await H.request(f.server, 'POST', '/api/auth/forgot-password', { email: user.email });
  const expired = H.mailToken(f, user.email, 'reset');
  f.clock.value += 30 * 60000 + 1;
  assert.equal((await H.request(second, 'POST', '/api/auth/reset-password', { token: expired, password: newPassword })).status, 410);
  f.clock.value += 14 * 86400000;
  assert.equal((await H.request(second, 'GET', '/api/session', undefined, current)).body.authenticated, false);
});

test('real SQLite login counters span request handlers and ignore forwarded IP spoofing', async t => {
  const f = await H.fixture(t), second = await f.start();
  const user = await H.register(f, 'rates@example.test');
  // Registration helper has consumed one login attempt; nine more are allowed.
  for (let i = 0; i < 9; i++) {
    const response = await H.request(i % 2 ? second : f.server, 'POST', '/api/auth/login', { email: user.email, password: 'incorrect-password' }, null,
      { headers: { 'X-Forwarded-For': '198.51.100.' + i } });
    assert.equal(response.status, 401);
  }
  const rate = await H.request(second, 'POST', '/api/auth/login', { email: user.email, password: H.PASSWORD });
  assert.equal(rate.status, 429); assert.equal(rate.body.code, 'RATE_LIMITED'); assert.ok(Number(rate.headers['retry-after']) > 0);
  f.clock.value += 15 * 60000 + 1;
  assert.equal((await H.request(second, 'POST', '/api/auth/login', { email: user.email, password: H.PASSWORD })).status, 200);
});

test('unverified invited email cannot join; resend invalidates the previous verification link', async t => {
  const f = await H.fixture(t);
  const owner = await H.family(f, await H.register(f, 'verified-owner@example.test'));
  const target = await H.register(f, 'unverified-parent@example.test', false);
  const sent = await H.request(f.server, 'POST', '/api/families/' + owner.familyId + '/invitations', { email: target.email }, owner);
  assert.equal(sent.status, 200);
  const token = H.mailToken(f, target.email, 'invite'), oldVerification = H.mailToken(f, target.email, 'verify');
  assert.equal((await H.request(f.server, 'POST', '/api/invitations/accept', { token }, target)).body.code, 'EMAIL_UNVERIFIED');
  assert.equal((await H.request(f.server, 'POST', '/api/auth/resend-verification', { email: target.email }, target)).status, 202);
  const currentVerification = H.mailToken(f, target.email, 'verify');
  assert.notEqual(currentVerification, oldVerification);
  assert.equal((await H.request(f.server, 'POST', '/api/auth/verify-email', { token: oldVerification }, target)).body.code, 'TOKEN_INVALID');
  assert.equal((await H.request(f.server, 'POST', '/api/auth/verify-email', { token: currentVerification }, target)).status, 200);
  assert.equal((await H.request(f.server, 'POST', '/api/invitations/accept', { token }, target)).status, 200);
});

test('configured nodemailer transport delivers over a real local SMTP connection', async t => {
  const net = require('node:net');
  const received = [];
  const smtp = net.createServer(socket => {
    socket.setEncoding('utf8');
    socket.write('220 local-v13-test ESMTP\r\n');
    let buffer = '', dataMode = false, content = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (dataMode) {
          if (line === '.') { received.push(content); content = ''; dataMode = false; socket.write('250 accepted\r\n'); }
          else { content += line + '\r\n'; }
        } else if (/^EHLO /.test(line)) { socket.write('250-local-v13-test\r\n250 SIZE 262144\r\n'); }
        else if (line === 'DATA') { dataMode = true; socket.write('354 send message\r\n'); }
        else if (line === 'QUIT') { socket.end('221 bye\r\n'); }
        else { socket.write('250 ok\r\n'); }
      }
    });
    socket.on('error', () => {});
  });
  await new Promise(resolve => smtp.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => smtp.close(resolve)));
  const mail = createMailer({ environment: 'test', publicOrigin: H.ORIGIN,
    env: { SMTP_URL: 'smtp://127.0.0.1:' + smtp.address().port, MAIL_FROM: 'sender@example.test' } });
  try {
    await mail.send({ to: 'recipient@example.test', subject: 'verify', text: H.ORIGIN + '/#verify=opaque-local-test-token' });
    assert.equal(received.length, 1);
    assert.match(received[0], /To: recipient@example\.test/);
    assert.ok(received[0].replace(/=\r\n/g, '').replace(/=3D/g, '=').includes('/#verify=opaque-local-test-token'));
  } finally { mail.close(); }
});

test('production fails closed without HTTPS/SMTP and capture is explicitly local development only', async () => {
  const mailer = { sendMail() {} };
  await assert.rejects(createSaasServer({ environment: 'production', publicOrigin: 'http://127.0.0.1:4180', mailer }), /HTTPS/);
  await assert.rejects(createSaasServer({ environment: 'production', publicOrigin: 'https://example.test', mailer }), /injected\/test/);
  assert.throws(() => createMailer({ environment: 'production', publicOrigin: 'https://example.test', devMailDir: 'unused', env: {} }), /SMTP/);
  assert.throws(() => createMailer({ environment: 'development', publicOrigin: 'https://example.test', devMailDir: 'unused', env: {} }), /loopback/);
  assert.throws(() => createMailer({ environment: 'test', publicOrigin: H.ORIGIN, devMailDir: 'unused', env: {} }), /development/);
});
