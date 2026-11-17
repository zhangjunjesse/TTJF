'use strict';
// Real PostgreSQL fixtures only. Each test gets a fresh, disposable schema in
// TEST_DATABASE_URL, never the development database or legacy data directory.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { Pool } = require('pg');
const { createSaasServer } = require('../saas-server.cjs');
const ORIGIN = 'http://127.0.0.1:4980';
const PASSWORD = 'Family-test-password-13';
const PIN = '246810';
function request(server, method, pathname, body, user, options = {}) {
  const headers = { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !options.noOrigin) { headers.Origin = options.origin || ORIGIN; }
  if (user) {
    headers.Cookie = user.cookie;
    if (user.familyId) { headers['X-Family-ID'] = user.familyId; }
    if (!options.noCsrf) { headers['X-CSRF-Token'] = user.csrfToken; }
  }
  Object.assign(headers, options.headers || {});
  const text = body === undefined ? undefined : JSON.stringify(body);
  if (text !== undefined) { headers['Content-Length'] = Buffer.byteLength(text); }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: pathname, method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c)); res.on('error', reject);
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = raw; try { body = JSON.parse(raw); } catch (_) { /* static resource */ }
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
    });
    req.on('error', reject); req.setTimeout(10000, () => req.destroy(new Error('SaaS test request timed out'))); req.end(text);
  });
}
async function fixture(t, overrides = {}) {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString, 'Real PostgreSQL required: set TEST_DATABASE_URL (no mock or skipped substitute)');
  const schema = 'v14_test_' + process.pid + '_' + crypto.randomBytes(8).toString('hex');
  const control = new Pool({ connectionString, max: 2 });
  await control.query('CREATE SCHEMA "' + schema + '"');
  const pools = [], servers = [], mail = [];
  const clock = { value: Date.parse('2026-11-16T14:30:00.000Z') };
  const options = { publicOrigin: ORIGIN, environment: 'test', now: () => new Date(clock.value),
    mailer: { sendMail: async message => { mail.push(message); } }, onError() {},
    assistantService: { status: () => ({ mode: 'local', label: '指令演示' }), interpret: async () => ({ kind: 'clarify', question: '请补充具体内容' }) }, ...overrides };
  async function start(extra = {}) {
    const pool = new Pool({ connectionString, options: '-c search_path=' + schema, max: 6 });
    pools.push(pool);
    const server = await createSaasServer({ ...options, ...extra, pool });
    servers.push(server);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return server;
  }
  t.after(async () => {
    for (const server of servers) { await server.closeSaas(); }
    for (const pool of pools) { await pool.end(); }
    assert.match(schema, /^v14_test_[0-9]+_[a-f0-9]{16}$/);
    await control.query('DROP SCHEMA "' + schema + '" CASCADE');
    await control.end();
  });
  const server = await start();
  return { server, pool: pools[0], mail, clock, start, schema };
}
function mailToken(f, email, purpose) {
  const message = f.mail.filter(m => m.to === email && m.text.includes('/#' + purpose + '=')).at(-1);
  assert.ok(message, 'expected captured ' + purpose + ' mail');
  return new RegExp('/#' + purpose + '=([A-Za-z0-9_-]{43})').exec(message.text)[1];
}
async function login(f, email, password = PASSWORD, server = f.server) {
  const result = await request(server, 'POST', '/api/auth/login', { email, password });
  assert.equal(result.status, 200, result.body.code);
  return { email, password, cookie: result.headers['set-cookie'][0].split(';')[0], csrfToken: result.body.csrfToken,
    userId: result.body.user.id, session: result.body };
}
async function register(f, email, verified = true) {
  const result = await request(f.server, 'POST', '/api/auth/register', { email, password: PASSWORD });
  assert.equal(result.status, 202, result.body.code);
  if (verified) {
    const verifiedResponse = await request(f.server, 'POST', '/api/auth/verify-email', { token: mailToken(f, email, 'verify') });
    assert.equal(verifiedResponse.status, 200, verifiedResponse.body.code);
  }
  return login(f, email);
}
async function family(f, user, name = '测试家庭', childName = '测试孩子', requestId = crypto.randomUUID()) {
  const response = await request(f.server, 'POST', '/api/families', { name, childName, requestId }, user);
  assert.equal(response.status, 200, response.body.code);
  return { ...user, familyId: response.body.family.id };
}
async function setup(f, user, method = 'pin', server = f.server) {
  const response = await request(server, 'POST', '/api/action', { revision: 1, action: { id: 'setup', type: 'parent.setup', method,
    ...(method === 'pin' ? { pin: PIN, confirmPin: PIN } : {}) } }, user);
  assert.equal(response.status, 200, response.body.code); return response;
}
function credit(id, points = 5) { return { id, type: 'points.add', name: '阅读', points, reason: '主动分享故事' }; }
async function grant(f, user, action, revision = 2, server = f.server) {
  const challenge = await request(server, 'POST', '/api/parent/challenge', { revision, action }, user);
  assert.equal(challenge.status, 200, challenge.body.code);
  const numbers = challenge.body.question && challenge.body.question.match(/\d+/g);
  const answer = numbers ? String(Number(numbers[0]) + Number(numbers[1])) : PIN;
  const verified = await request(server, 'POST', '/api/parent/verify', { challengeId: challenge.body.challengeId, answer }, user);
  assert.equal(verified.status, 200, verified.body.code);
  return verified.body.grant;
}
async function invite(f, owner, member) {
  const sent = await request(f.server, 'POST', '/api/families/' + owner.familyId + '/invitations', { email: member.email }, owner);
  assert.equal(sent.status, 200, sent.body.code);
  const token = mailToken(f, member.email, 'invite');
  const accepted = await request(f.server, 'POST', '/api/invitations/accept', { token }, member);
  assert.equal(accepted.status, 200, accepted.body.code);
  return { ...member, familyId: owner.familyId };
}
module.exports = { fixture, request, register, login, family, setup, credit, grant, invite, mailToken, PASSWORD, PIN, ORIGIN };
