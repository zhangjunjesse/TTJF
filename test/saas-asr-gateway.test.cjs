'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { WebSocket } = require('ws');
const H = require('../saas/testing.cjs');
const S = require('../saas/security.cjs');

const TICKET = '/api/assistant/voice/ticket';
const STREAM = '/api/assistant/voice/stream';
const CONFIG = Object.freeze({ privateValue: 'PRIVATE_PROVIDER_SENTINEL' });
const FINAL = '今天读了两页书。然后把书收好了，加五分。';

function mockProvider() {
  const calls = [];
  const mode = { ready: true, final: true, pressure: false };
  function connect(config, callbacks) {
    const call = { config, callbacks, writes: [], finishes: 0, closes: 0 };
    calls.push(call);
    if (mode.ready) { queueMicrotask(callbacks.onReady); }
    return {
      write(bytes) { call.writes.push(Buffer.from(bytes)); return !mode.pressure; },
      finish() { call.finishes++; if (mode.final) { queueMicrotask(() => callbacks.onFinal(FINAL)); } },
      close() { call.closes++; }
    };
  }
  return { calls, mode, connect };
}

function within(promise, timeoutMs = 2500) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('WebSocket test timed out')), timeoutMs); })])
    .finally(() => clearTimeout(timer));
}

function socket(f, user, ticket, options = {}) {
  const headers = { Origin: H.ORIGIN, ...(user ? { Cookie: user.cookie } : {}), ...options.headers };
  for (const key of Object.keys(headers)) { if (headers[key] === undefined) { delete headers[key]; } }
  const pathname = options.pathname || STREAM + '?ticket=' + encodeURIComponent(ticket);
  const ws = new WebSocket('ws://127.0.0.1:' + f.server.address().port + pathname,
    { handshakeTimeout: 2000, ...options.ws, headers });
  const received = [], queued = [], waiting = [];
  const closed = new Promise(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  ws.on('message', data => {
    const value = JSON.parse(data.toString());
    received.push(value);
    if (waiting.length) { waiting.shift()(value); } else { queued.push(value); }
  });
  return within(new Promise((resolve, reject) => {
    let settled = false;
    ws.once('open', () => {
      settled = true;
      resolve({ status: 101, ws, received, next: () => within(queued.length ? Promise.resolve(queued.shift()) : new Promise(done => waiting.push(done))),
        closed: () => within(closed) });
    });
    ws.once('unexpected-response', (request, response) => {
      settled = true;
      response.resume();
      response.once('end', () => { ws.terminate(); resolve({ status: response.statusCode }); });
    });
    ws.on('error', error => { if (!settled) { settled = true; reject(error); } });
  }));
}

async function ticketFor(f, user) {
  const response = await H.request(f.server, 'POST', TICKET, {}, user);
  assert.equal(response.status, 200, response.body.code);
  assert.deepEqual(Object.keys(response.body).sort(), ['familyId', 'ticket', 'userId']);
  assert.equal(response.body.familyId, user.familyId);
  assert.equal(response.body.userId, user.userId);
  assert.match(response.body.ticket, S.TOKEN);
  return response.body.ticket;
}

async function recording(f, user, options = {}) {
  const client = await socket(f, user, await ticketFor(f, user), options);
  assert.equal(client.status, 101);
  client.ws.send(JSON.stringify({ type: 'start', hotwords: ['阅读', '小明', '阅读'] }));
  assert.deepEqual(await client.next(), { type: 'ready' });
  return client;
}

test('voice ticket uses real SaaS origin, CSRF, verified account and family authorization before any provider access', async t => {
  const provider = mockProvider(), f = await H.fixture(t, { asrConfig: CONFIG, asrConnect: provider.connect });
  const owner = await H.family(f, await H.register(f, 'voice-auth@example.test'));
  const unverified = await H.register(f, 'voice-unverified@example.test', false);
  const outsider = await H.register(f, 'voice-outsider@example.test');
  const cases = [
    [null, { headers: { 'X-Family-ID': owner.familyId } }, 401, 'AUTH_REQUIRED'],
    [owner, { noCsrf: true }, 403, 'CSRF_INVALID'],
    [owner, { origin: 'https://unrelated.example' }, 403, 'ORIGIN_DENIED'],
    [owner, { noOrigin: true }, 403, 'ORIGIN_DENIED'],
    [{ ...owner, familyId: undefined }, {}, 400, 'FAMILY_REQUIRED'],
    [{ ...unverified, familyId: owner.familyId }, {}, 403, 'EMAIL_UNVERIFIED'],
    [{ ...outsider, familyId: owner.familyId }, {}, 403, 'FAMILY_FORBIDDEN']
  ];
  for (const [user, options, status, code] of cases) {
    const response = await H.request(f.server, 'POST', TICKET, {}, user, options);
    assert.equal(response.status, status);
    assert.equal(response.body.code, code);
    assert.equal(response.body.ticket, undefined);
  }
  assert.equal((await H.request(f.server, 'GET', TICKET, undefined, owner)).status, 405);
  const runtime = await H.request(f.server, 'GET', '/runtime.js');
  assert.equal(runtime.body, 'window.__TTJF_SAAS__=true;\nwindow.__TTJF_VOLC_ASR__=true;\n');
  assert.doesNotMatch(runtime.body, /PRIVATE_PROVIDER_SENTINEL|privateValue/);
  const ticket = await ticketFor(f, owner);
  assert.equal((await socket(f, owner, ticket, { headers: { Origin: undefined } })).status, 403);
  assert.equal((await socket(f, owner, ticket, { headers: { Origin: 'https://unrelated.example' } })).status, 403);
  assert.equal((await socket(f, owner, ticket, { pathname: '/api/assistant/voice/other?ticket=' + ticket })).status, 404);
  assert.equal((await socket(f, null, ticket)).status, 401);
  assert.equal(provider.calls.length, 0);
});

test('voice tickets expire, are bound to the login cookie, and cannot race or replay a provider connection', async t => {
  const provider = mockProvider(), f = await H.fixture(t, { asrConfig: CONFIG, asrConnect: provider.connect });
  const owner = await H.family(f, await H.register(f, 'voice-tickets@example.test'));
  const sibling = { ...await H.login(f, owner.email), familyId: owner.familyId };
  let ticket = await ticketFor(f, owner);
  assert.equal((await socket(f, sibling, ticket)).status, 401);
  assert.equal((await socket(f, owner, ticket)).status, 401);
  ticket = await ticketFor(f, owner);
  f.clock.value += 30001;
  assert.equal((await socket(f, owner, ticket)).status, 401);
  const superseded = await ticketFor(f, owner);
  ticket = await ticketFor(f, owner);
  assert.equal((await socket(f, owner, superseded)).status, 401);
  const raced = await Promise.all([socket(f, owner, ticket), socket(f, owner, ticket)]);
  assert.deepEqual(raced.map(value => value.status).sort(), [101, 401]);
  const live = raced.find(value => value.status === 101);
  assert.equal(provider.calls.length, 0, 'a handshake alone never starts the paid provider');
  live.ws.send(JSON.stringify({ type: 'start', hotwords: [] }));
  assert.deepEqual(await live.next(), { type: 'ready' });
  assert.equal(provider.calls.length, 1);
  live.ws.close(); await live.closed();
  assert.equal((await socket(f, owner, ticket)).status, 401);
  ticket = await ticketFor(f, sibling);
  assert.equal((await H.request(f.server, 'POST', '/api/auth/logout', {}, sibling)).status, 200);
  assert.equal((await socket(f, sibling, ticket)).status, 401, 'upgrade revalidates a revoked session');
  const parent = await H.invite(f, owner, await H.register(f, 'voice-ticket-member@example.test'));
  ticket = await ticketFor(f, parent);
  await f.database.query('DELETE FROM saas_memberships WHERE family_id=$1 AND user_id=$2', [parent.familyId, parent.userId]);
  assert.equal((await socket(f, parent, ticket)).status, 403, 'upgrade revalidates current membership');
  assert.equal(provider.calls.length, 1);
});

test('live WebSocket streams PCM, emits replacement partials and one complete final turn, and never changes the family ledger', async t => {
  const provider = mockProvider(), f = await H.fixture(t, { asrConfig: CONFIG, asrConnect: provider.connect });
  const owner = await H.family(f, await H.register(f, 'voice-final@example.test'));
  const before = (await H.request(f.server, 'GET', '/api/state', undefined, owner)).body;
  const client = await recording(f, owner), call = provider.calls[0];
  assert.deepEqual(call.callbacks.hotwords, ['阅读', '小明']);
  const pcm = Buffer.alloc(6400); pcm.writeInt16LE(-1234, 0); pcm.writeInt16LE(2345, 2);
  client.ws.send(pcm);
  await within(new Promise(resolve => {
    const timer = setInterval(() => { if (call.writes.length) { clearInterval(timer); resolve(); } }, 5);
    t.after(() => clearInterval(timer));
  }));
  call.callbacks.onPartial('今天读了两页书。');
  assert.deepEqual(await client.next(), { type: 'partial', text: '今天读了两页书。' });
  call.callbacks.onPartial(FINAL);
  assert.deepEqual(await client.next(), { type: 'partial', text: FINAL });
  assert.equal(call.finishes, 0);
  assert.equal(client.received.some(message => message.type === 'final'), false, 'sentence boundaries do not finish a capture');
  client.ws.send(JSON.stringify({ type: 'end' }));
  assert.deepEqual(await client.next(), { type: 'final', text: FINAL });
  assert.equal((await client.closed()).code, 1000);
  assert.deepEqual(call.writes, [pcm]);
  assert.equal(call.finishes, 1);
  assert.equal(call.closes, 1);
  call.callbacks.onFinal('late result'); call.callbacks.onError(new Error('PRIVATE_PROVIDER_SENTINEL'));
  assert.deepEqual(client.received.map(message => message.type), ['ready', 'partial', 'partial', 'final']);
  assert.doesNotMatch(JSON.stringify(client.received), /PRIVATE_PROVIDER_SENTINEL|privateValue|ticket/);
  assert.deepEqual((await H.request(f.server, 'GET', '/api/state', undefined, owner)).body, before);
});

test('cancel and server shutdown close the provider once and release a user slot without finishing a cancelled turn', async t => {
  const provider = mockProvider(), f = await H.fixture(t, { asrConfig: CONFIG, asrConnect: provider.connect });
  const owner = await H.family(f, await H.register(f, 'voice-cancel@example.test'));
  const unopened = await socket(f, owner, await ticketFor(f, owner));
  unopened.ws.close(); await unopened.closed();
  assert.equal(provider.calls.length, 0);
  const cancelled = await recording(f, owner), first = provider.calls[0];
  cancelled.ws.close(); await cancelled.closed();
  const active = await recording(f, owner), second = provider.calls[1];
  assert.equal(first.closes, 1); assert.equal(first.finishes, 0);
  first.callbacks.onReady(); first.callbacks.onFinal('ignored after cancel');
  assert.deepEqual(cancelled.received, [{ type: 'ready' }]);
  await f.server.closeSaas(); await active.closed(); await f.server.closeSaas();
  assert.equal(second.closes, 1); assert.equal(second.finishes, 0);
});

test('voice concurrency and persistent daily start quotas reject extra sessions before connecting to a provider', async t => {
  const provider = mockProvider(), f = await H.fixture(t, { asrConfig: CONFIG, asrConnect: provider.connect,
    asrLimits: { userStartsPerDay: 2 } });
  const owner = await H.family(f, await H.register(f, 'voice-quota@example.test'));
  const sibling = { ...await H.login(f, owner.email), familyId: owner.familyId };
  const firstTicket = await ticketFor(f, owner), secondTicket = await ticketFor(f, sibling);
  const first = await socket(f, owner, firstTicket);
  first.ws.send(JSON.stringify({ type: 'start' })); assert.deepEqual(await first.next(), { type: 'ready' });
  assert.equal((await socket(f, sibling, secondTicket)).status, 429);
  assert.equal((await H.request(f.server, 'POST', TICKET, {}, owner)).body.code, 'VOICE_BUSY');
  first.ws.close(); await first.closed();
  const secondServer = await f.start(), alternate = { ...f, server: secondServer };
  const denied = await socket(alternate, sibling, await ticketFor(alternate, sibling));
  assert.equal(denied.status, 429, 'daily quota is shared through SQLite across request handlers');
  assert.equal(provider.calls.length, 1);
  f.clock.value += 24 * 60 * 60000 + 1;
  const nextDay = await recording(alternate, sibling);
  nextDay.ws.close(); await nextDay.closed();
  assert.equal(provider.calls.length, 2);
});

test('voice ticket issuance has a persistent per-minute limit and no configuration exposes only a false runtime flag', async t => {
  const provider = mockProvider(), f = await H.fixture(t, { asrConfig: CONFIG, asrConnect: provider.connect,
    asrLimits: { ticketsPerMinute: 2 } });
  const owner = await H.family(f, await H.register(f, 'voice-ticket-quota@example.test'));
  await ticketFor(f, owner); await ticketFor(f, owner);
  const second = await f.start();
  const response = await H.request(second, 'POST', TICKET, {}, owner);
  assert.equal(response.status, 429); assert.equal(response.body.code, 'RATE_LIMITED');
  assert.ok(Number(response.headers['retry-after']) > 0);
  assert.equal(provider.calls.length, 0);
  const disabled = await f.start({ asrConfig: undefined,
    env: { ASR_PROVIDER: 'browser', VOLC_ASR_API_KEY: 'PRIVATE_PROVIDER_SENTINEL' } });
  assert.equal((await H.request(disabled, 'GET', '/runtime.js')).body,
    'window.__TTJF_SAAS__=true;\nwindow.__TTJF_VOLC_ASR__=false;\n');
  assert.equal((await H.request(disabled, 'POST', TICKET, {}, owner)).status, 503);
  assert.equal((await H.request(disabled, 'POST', TICKET, {})).status, 401);
});

test('voice stream enforces control order, PCM bounds, provider pressure, generic errors, and phase timeouts', async t => {
  const provider = mockProvider(), f = await H.fixture(t, { asrConfig: CONFIG, asrConnect: provider.connect,
    asrLimits: { maxAudioBytes: 6400, startTimeoutMs: 200, connectTimeoutMs: 200, idleTimeoutMs: 1500,
      finalTimeoutMs: 200, lifetimeMs: 4000 } });
  const owner = await H.family(f, await H.register(f, 'voice-protocol@example.test'));
  async function expectError(client, code) {
    assert.deepEqual(await client.next(), { type: 'error', code });
    await client.closed();
    assert.equal(client.received.some(message => message.type === 'final'), false);
    assert.doesNotMatch(JSON.stringify(client.received), /PRIVATE_PROVIDER_SENTINEL/);
  }
  let client = await socket(f, owner, await ticketFor(f, owner));
  client.ws.send(Buffer.alloc(2)); await expectError(client, 'VOICE_PROTOCOL');
  assert.equal(provider.calls.length, 0);
  client = await socket(f, owner, await ticketFor(f, owner));
  client.ws.send(JSON.stringify({ type: 'start', hotwords: ['x'.repeat(51)] })); await expectError(client, 'VOICE_PROTOCOL');
  assert.equal(provider.calls.length, 0);
  client = await recording(f, owner);
  client.ws.send(Buffer.alloc(3)); await expectError(client, 'VOICE_PROTOCOL');
  client = await recording(f, owner);
  client.ws.send(Buffer.alloc(6402)); await expectError(client, 'VOICE_TOO_LONG');
  provider.mode.pressure = true;
  client = await recording(f, owner);
  client.ws.send(Buffer.alloc(6400)); await expectError(client, 'BACKPRESSURE');
  provider.mode.pressure = false;
  client = await recording(f, owner);
  provider.calls.at(-1).callbacks.onError(new Error('PRIVATE_PROVIDER_SENTINEL'));
  await expectError(client, 'ASR_FAILED');
  client = await recording(f, owner);
  provider.calls.at(-1).callbacks.onFinal('premature sentence'); await expectError(client, 'ASR_FAILED');
  client = await socket(f, owner, await ticketFor(f, owner)); await expectError(client, 'ASR_TIMEOUT');
  provider.mode.ready = false;
  client = await socket(f, owner, await ticketFor(f, owner));
  client.ws.send(JSON.stringify({ type: 'start' })); await expectError(client, 'ASR_CONNECTION_FAILED');
  provider.mode.ready = true; provider.mode.final = false;
  client = await recording(f, owner);
  client.ws.send(JSON.stringify({ type: 'end' })); await expectError(client, 'ASR_TIMEOUT');
  assert.ok(provider.calls.every(call => call.closes === 1));
});

test('active voice streams recheck authentication, stop after membership loss, and close clients that do not pong', async t => {
  const provider = mockProvider(), f = await H.fixture(t, { asrConfig: CONFIG, asrConnect: provider.connect,
    asrLimits: { heartbeatMs: 100, startTimeoutMs: 2000, idleTimeoutMs: 2000, lifetimeMs: 4000 } });
  const owner = await H.family(f, await H.register(f, 'voice-revoke-owner@example.test'));
  const parent = await H.invite(f, owner, await H.register(f, 'voice-revoke-parent@example.test'));
  let client = await recording(f, owner);
  assert.equal((await H.request(f.server, 'POST', '/api/auth/logout', {}, owner)).status, 200);
  assert.deepEqual(await client.next(), { type: 'error', code: 'SESSION_EXPIRED' }); await client.closed();
  client = await recording(f, parent, { ws: { autoPong: false } });
  assert.deepEqual(await client.next(), { type: 'error', code: 'ASR_TIMEOUT' }); await client.closed();
  client = await recording(f, parent);
  await f.database.query('DELETE FROM saas_memberships WHERE family_id=$1 AND user_id=$2', [parent.familyId, parent.userId]);
  assert.deepEqual(await client.next(), { type: 'error', code: 'SESSION_EXPIRED' }); await client.closed();
  assert.ok(provider.calls.every(call => call.closes === 1 && call.finishes === 0));
});

test('typed provider failures expose only stable public codes, including synchronous failures before audio', async t => {
  const provider = mockProvider(); provider.mode.ready = false;
  let failure, throws = false;
  const f = await H.fixture(t, { asrConfig: CONFIG,
    asrLimits: { ticketsPerMinute: 30, familyTicketsPerMinute: 60 },
    asrConnect(config, callbacks) {
      if (throws) { throw failure; }
      const session = provider.connect(config, callbacks);
      callbacks.onError(failure);
      return session;
    } });
  const owner = await H.family(f, await H.register(f, 'voice-public-errors@example.test'));
  const cases = [
    ['VOLC_ASR_CONNECTION', 'ASR_CONNECTION_FAILED'], ['VOLC_ASR_CONNECT_TIMEOUT', 'ASR_CONNECTION_FAILED'],
    ['VOLC_ASR_EMPTY_AUDIO', 'NO_SPEECH'], ['VOLC_ASR_EMPTY_RESULT', 'NO_SPEECH'],
    ['VOLC_ASR_PROVIDER_ERROR', 'NO_SPEECH', 45000002],
    ['VOLC_ASR_AUTH', 'ASR_UNAVAILABLE'], ['VOLC_ASR_CONFIG', 'ASR_UNAVAILABLE'],
    ['VOLC_ASR_IDLE_TIMEOUT', 'ASR_TIMEOUT'], ['VOLC_ASR_FINAL_TIMEOUT', 'ASR_TIMEOUT'], ['VOLC_ASR_EXPIRED', 'ASR_TIMEOUT'],
    ['VOLC_ASR_BACKPRESSURE', 'BACKPRESSURE'], ['VOLC_ASR_AUDIO_LIMIT', 'VOICE_TOO_LONG'], ['unknown-private-code', 'ASR_FAILED']
  ];
  for (const [code, expected, providerCode] of cases) {
    failure = Object.assign(new Error('PRIVATE_PROVIDER_SENTINEL'), { code, providerCode });
    const client = await socket(f, owner, await ticketFor(f, owner));
    client.ws.send(JSON.stringify({ type: 'start' }));
    assert.deepEqual(await client.next(), { type: 'error', code: expected }); await client.closed();
    assert.deepEqual(client.received, [{ type: 'error', code: expected }]);
  }
  throws = true; failure = Object.assign(new Error('PRIVATE_PROVIDER_SENTINEL'), { code: 'VOLC_ASR_CONNECTION' });
  const client = await socket(f, owner, await ticketFor(f, owner));
  client.ws.send(JSON.stringify({ type: 'start' }));
  assert.deepEqual(await client.next(), { type: 'error', code: 'ASR_CONNECTION_FAILED' }); await client.closed();
  assert.ok(provider.calls.every(call => call.closes === 1 && call.writes.length === 0));
});

test('voice lifetime remains bounded while PCM keeps arriving and provider never finishes', async t => {
  const provider = mockProvider(), f = await H.fixture(t, { asrConfig: CONFIG, asrConnect: provider.connect,
    asrLimits: { lifetimeMs: 300, idleTimeoutMs: 1500, heartbeatMs: 1000 } });
  const owner = await H.family(f, await H.register(f, 'voice-lifetime@example.test'));
  const client = await recording(f, owner);
  const interval = setInterval(() => { if (client.ws.readyState === WebSocket.OPEN) { client.ws.send(Buffer.alloc(6400)); } }, 30);
  try {
    assert.deepEqual(await client.next(), { type: 'error', code: 'VOICE_TOO_LONG' }); await client.closed();
  } finally { clearInterval(interval); }
  assert.equal(provider.calls[0].closes, 1);
});

test('rejected voice upgrades close a peer that keeps its TCP write side open', async t => {
  const provider = mockProvider(), f = await H.fixture(t, { asrConfig: CONFIG, asrConnect: provider.connect });
  const peer = net.createConnection({ host: '127.0.0.1', port: f.server.address().port, allowHalfOpen: true });
  let response = '';
  peer.on('data', bytes => { response += bytes.toString(); }); peer.on('error', () => {});
  const closed = new Promise(resolve => peer.once('close', resolve));
  await within(new Promise(resolve => peer.once('connect', resolve)));
  peer.write('GET ' + STREAM + '?ticket=' + S.token() + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: ' + H.ORIGIN +
    '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
  const interval = setInterval(() => { if (!peer.destroyed) { peer.write('keep-open'); } }, 30);
  try { await within(closed, 2000); }
  finally { clearInterval(interval); peer.destroy(); }
  assert.match(response, /^HTTP\/1\.1 401 Unauthorized\r\n/);
  assert.equal(provider.calls.length, 0);
});
