'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once, EventEmitter } = require('node:events');
const http = require('node:http');
const { gzipSync, gunzipSync } = require('node:zlib');
const { WebSocketServer } = require('ws');
const { readVolcConfig, createVolcSession } = require('../saas/volc-asr.cjs');

const credentials = { VOLC_ASR_API_KEY: 'local-test-key' };
const pcm = size => Buffer.alloc(size, 7);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function withTimeout(promise, milliseconds = 1500) {
  let timer;
  return Promise.race([promise, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Local ASR test timed out')), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
async function until(predicate) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 1500) throw new Error('Local ASR condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function callbacks(extra = {}) {
  const ready = deferred(), final = deferred(), error = deferred(), events = [];
  return { ready, final, error, events, hooks: { ...extra,
    onReady: () => { events.push(['ready']); ready.resolve(); },
    onPartial: text => events.push(['partial', text]),
    onFinal: text => { events.push(['final', text]); final.resolve(text); },
    onError: value => { events.push(['error', value]); error.resolve(value); } } };
}

// Independent fixture implementation of the documented v3 wire layout. No remote service is used.
function serverFrame(body, options = {}) {
  const { flags = 1, sequence = 1, type = 9, serialization = 1, compression = 1,
    errorCode = 45000081, headerWords = 1, event = 0 } = options;
  const raw = options.raw === undefined ? Buffer.from(JSON.stringify(body)) : options.raw;
  const payload = compression === 1 ? gzipSync(raw) : raw;
  const header = Buffer.alloc(headerWords * 4);
  header[0] = 0x10 | headerWords;
  header[1] = type * 16 | flags;
  header[2] = serialization * 16 | compression;
  const metadata = [];
  const integer = (value, signed = false) => {
    const bytes = Buffer.alloc(4);
    if (signed) bytes.writeInt32BE(value); else bytes.writeUInt32BE(value);
    metadata.push(bytes);
  };
  if (flags & 1) integer(sequence, true);
  if (flags & 4) integer(event, true);
  if (type === 15) integer(errorCode);
  integer(payload.length);
  return Buffer.concat([header, ...metadata, payload]);
}
function clientFrame(bytes) {
  assert.equal(bytes[0], 0x11);
  const type = bytes[1] >> 4, flags = bytes[1] & 15;
  assert.ok(flags === 1 || flags === 3);
  assert.equal(bytes[2], type === 1 ? 0x11 : 0x01);
  assert.equal(bytes[3], 0);
  const sequence = bytes.readInt32BE(4), length = bytes.readUInt32BE(8);
  assert.equal(length, bytes.length - 12);
  assert.ok(flags === 3 ? sequence < 0 : sequence > 0);
  const payload = gunzipSync(bytes.subarray(12));
  return { type, flags, sequence, payload, body: type === 1 ? JSON.parse(payload) : null, wire: bytes };
}
async function localProvider(t, config = {}, hooks = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const received = [], connected = deferred();
  let peer, request;
  server.on('connection', (socket, upgrade) => {
    peer = socket; request = upgrade;
    socket.on('message', data => received.push(clientFrame(data)));
    connected.resolve();
  });
  const observation = callbacks(hooks);
  const session = createVolcSession({ ...readVolcConfig(credentials), ...config,
    url: 'ws://127.0.0.1:' + server.address().port }, observation.hooks);
  t.after(async () => {
    session.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  await withTimeout(connected.promise);
  await withTimeout(observation.ready.promise);
  await until(() => received.length === 1);
  return { ...observation, session, received, peer, request, server };
}
function scriptedProvider(t, config = {}, hooks = {}) {
  const sockets = [], observation = callbacks(hooks);
  class Socket extends EventEmitter {
    constructor(_url, options) {
      super(); this.options = options; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this);
    }
    open() { this.readyState = 1; this.emit('open'); }
    send(bytes, _options, done) { this.sent.push(clientFrame(bytes)); if (done) done(); }
    terminate() {
      if (this.readyState === 3) return;
      this.readyState = 3; this.terminated = true;
      queueMicrotask(() => this.emit('close'));
    }
  }
  const session = createVolcSession({ ...readVolcConfig(credentials), WebSocket: Socket, ...config }, observation.hooks);
  t.after(() => session.close());
  return { ...observation, session, sockets };
}

test('Volc configuration defaults to 2.0 async, supports both auth versions and browser opt-out', () => {
  assert.equal(readVolcConfig({}), null);
  assert.equal(readVolcConfig({ VOLC_ASR_MODE: 'bigmodel' }), null);
  assert.equal(readVolcConfig({ ASR_PROVIDER: 'browser', VOLC_ASR_API_KEY: 'bad\ncredential', VOLC_ASR_MODE: 'bad' }), null);
  const config = readVolcConfig(credentials);
  assert.equal(config.mode, 'bigmodel_async');
  assert.equal(config.resourceId, 'volc.seedasr.sauc.duration');
  assert.equal(config.url, 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async');
  assert.deepEqual(config.hotwords, []);
  for (const mode of ['bigmodel', 'bigmodel_nostream', 'bigmodel_async']) {
    const legacy = readVolcConfig({ ASR_PROVIDER: 'volc', VOLC_ASR_APP_KEY: '12345', VOLC_ASR_ACCESS_KEY: 'token', VOLC_ASR_MODE: mode });
    assert.equal(legacy.mode, mode); assert.equal(legacy.appKey, '12345'); assert.equal(legacy.accessKey, 'token');
  }
});

test('Volc configuration fails descriptively for incomplete/invalid settings without echoing secrets', () => {
  const secret = 'never-print-this-secret';
  for (const [env, expected] of [
    [{ VOLC_ASR_APP_KEY: secret }, /configured together/],
    [{ VOLC_ASR_ACCESS_KEY: secret }, /configured together/],
    [{ VOLC_ASR_API_KEY: secret + '\ninvalid' }, /VOLC_ASR_API_KEY/],
    [{ VOLC_ASR_API_KEY: secret, VOLC_ASR_MODE: 'unknown' }, /VOLC_ASR_MODE/],
    [{ VOLC_ASR_API_KEY: secret, VOLC_ASR_RESOURCE_ID: 'bad/resource' }, /VOLC_ASR_RESOURCE_ID/],
    [{ ASR_PROVIDER: 'unknown' }, /ASR_PROVIDER/],
    [{ VOLC_ASR_HOTWORDS: '[broken-secret-json' }, /VOLC_ASR_HOTWORDS/]
  ]) {
    assert.throws(() => readVolcConfig(env), error => {
      assert.equal(error.code, 'VOLC_ASR_CONFIG'); assert.match(error.message, expected);
      assert.ok(!error.message.includes(secret)); assert.ok(!error.message.includes('broken-secret-json')); return true;
    });
  }
});

test('Volc hotwords accept documented JSON/list forms, deduplicate and enforce fixed bounds', () => {
  for (const value of ['["小明","积分宝箱","小明"]', '{"hotwords":[{"word":"小明"},{"word":"积分宝箱"}]}', '小明,积分宝箱', '小明，积分宝箱\n小明']) {
    assert.deepEqual(readVolcConfig({ ...credentials, VOLC_ASR_HOTWORDS: value }).hotwords, ['小明', '积分宝箱']);
  }
  for (const value of ['[""]', '[1]', '{"wrong":[]}', '[{"word":"小明","other":1}]', JSON.stringify(['x'.repeat(51)]),
    JSON.stringify(Array.from({ length: 101 }, (_, i) => '词' + i)), JSON.stringify(Array.from({ length: 30 }, (_, i) => i + 'x'.repeat(40)))]) {
    assert.throws(() => readVolcConfig({ ...credentials, VOLC_ASR_HOTWORDS: value }), /VOLC_ASR_HOTWORDS/);
  }
});

test('local Volc session sends authenticated v3 JSON+gzip config and 200 ms PCM frames, then terminal text', async t => {
  const f = await localProvider(t, { hotwords: ['小明', '积分宝箱'] }, { hotwords: ['小明', '晶叶龙'] });
  const headers = f.request.headers;
  assert.equal(headers['x-api-key'], credentials.VOLC_ASR_API_KEY);
  assert.equal(headers['x-api-app-key'], undefined);
  assert.equal(headers['x-api-access-key'], undefined);
  assert.equal(headers['x-api-resource-id'], 'volc.seedasr.sauc.duration');
  assert.match(headers['x-api-request-id'], /^[a-f\d-]{36}$/);
  assert.equal(headers['x-api-connect-id'], headers['x-api-request-id']);
  assert.equal(headers['x-api-sequence'], '-1');
  const first = f.received[0];
  assert.equal(first.type, 1); assert.equal(first.sequence, 1);
  assert.deepEqual(first.body.audio, { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 });
  assert.equal(first.body.request.result_type, 'full');
  assert.equal(first.body.request.enable_nonstream, true);
  assert.equal(first.body.request.show_utterances, true);
  assert.deepEqual(JSON.parse(first.body.request.corpus.context), { hotwords: [{ word: '小明' }, { word: '积分宝箱' }, { word: '晶叶龙' }] });
  for (let i = 0; i < 5; i++) assert.equal(f.session.write(pcm(1280)), true); // five 40 ms chunks
  await until(() => f.received.length === 2);
  assert.equal(f.received[1].type, 2); assert.equal(f.received[1].sequence, 2);
  assert.deepEqual(f.received[1].payload, pcm(6400));
  f.peer.send(serverFrame({ result: { text: '给小明加5分' } }, { sequence: 2 }));
  await until(() => f.events.some(event => event[0] === 'partial'));
  assert.equal(f.session.write(pcm(1600)), true);
  assert.equal(f.session.finish(), true);
  assert.equal(f.session.finish(), true);
  assert.equal(f.session.write(pcm(2)), false);
  await until(() => f.received.length === 3);
  assert.equal(f.received[2].flags, 3); assert.equal(f.received[2].sequence, -3);
  assert.deepEqual(f.received[2].payload, pcm(1600));
  f.peer.send(serverFrame({ result: { text: '给小明加7分。' } }, { flags: 3, sequence: -3 }));
  assert.equal(await withTimeout(f.final.promise), '给小明加7分。');
  assert.deepEqual(f.events.filter(event => event[0] !== 'ready'), [['partial', '给小明加5分'], ['final', '给小明加7分。']]);
  await until(() => f.server.clients.size === 0);
});

test('legacy auth is used only without an API key, and old modes do not enable unsupported second pass', async t => {
  for (const mode of ['bigmodel', 'bigmodel_nostream']) await t.test(mode, async sub => {
    const f = await localProvider(sub, readVolcConfig({ VOLC_ASR_APP_KEY: 'legacy-app', VOLC_ASR_ACCESS_KEY: 'legacy-token', VOLC_ASR_MODE: mode }));
    assert.equal(f.request.headers['x-api-key'], undefined);
    assert.equal(f.request.headers['x-api-app-key'], 'legacy-app');
    assert.equal(f.request.headers['x-api-access-key'], 'legacy-token');
    assert.equal(f.received[0].body.request.enable_nonstream, undefined);
  });
});

test('a configured new API key takes precedence over a complete legacy credential pair', async t => {
  const f = scriptedProvider(t, readVolcConfig({ ...credentials, VOLC_ASR_APP_KEY: 'legacy-app', VOLC_ASR_ACCESS_KEY: 'legacy-token' }));
  await Promise.resolve();
  const headers = f.sockets[0].options.headers;
  assert.equal(headers['X-Api-Key'], credentials.VOLC_ASR_API_KEY);
  assert.equal(headers['X-Api-App-Key'], undefined);
  assert.equal(headers['X-Api-Access-Key'], undefined);
});

test('valid configured and dynamic hotwords fit a shared budget with configured vocabulary first', async t => {
  const configuredCount = Array.from({ length: 98 }, (_, index) => '配置词' + index);
  const configuredCharacters = Array.from({ length: 20 }, (_, index) => String(index).padStart(2, '0') + 'x'.repeat(47));
  for (const [name, configured, requested, accepted] of [
    ['count', configuredCount, [configuredCount[0], '家庭新词甲', '家庭新词乙', '家庭新词丙'], ['家庭新词甲', '家庭新词乙']],
    ['characters', configuredCharacters, ['太长'.repeat(20), '小明', '积分宝箱', '晶叶龙'], ['小明', '积分宝箱', '晶叶龙']]
  ]) await t.test(name, async sub => {
    const f = await localProvider(sub, { hotwords: configured }, { hotwords: requested });
    const transmitted = JSON.parse(f.received[0].body.request.corpus.context).hotwords.map(item => item.word);
    assert.deepEqual(transmitted, [...configured, ...accepted]);
    assert.ok(transmitted.length <= 100);
    assert.ok(transmitted.reduce((count, word) => count + word.length, 0) <= 1000);
    assert.equal(f.events.filter(event => event[0] === 'error').length, 0);
  });
});

test('partial revisions replace snapshots, sentence definite never finalizes, and alternatives are not concatenated', async t => {
  const f = await localProvider(t);
  f.peer.send(serverFrame({ result: { text: '给小名加五', utterances: [{ text: '给小名加五', definite: false }] } }, { sequence: 2 }));
  f.peer.send(serverFrame({ result: { text: '给小明加5分。', utterances: [{ text: '给小明加5分。', definite: true }] } }, { sequence: 3 }));
  f.peer.send(serverFrame({ result: [{ text: '给小明加5分。然后看记录。' }, { text: '备选文本不应拼接' }] }, { sequence: 4, compression: 0 }));
  await until(() => f.events.filter(event => event[0] === 'partial').length === 3);
  assert.deepEqual(f.events.filter(event => event[0] === 'partial').map(event => event[1]), ['给小名加五', '给小明加5分。', '给小明加5分。然后看记录。']);
  assert.equal(f.events.filter(event => event[0] === 'final').length, 0);
  f.session.write(pcm(6400)); f.session.finish();
  await until(() => f.received.length === 3);
  assert.equal(f.received[2].payload.length, 0, 'an exact packet boundary still sends the required final audio packet');
  f.peer.send(serverFrame({ result: { utterances: [{ text: '给小明加5分。', definite: true }, { text: '然后看记录。', definite: true }] } }, { flags: 2 }));
  assert.equal(await withTimeout(f.final.promise), '给小明加5分。然后看记录。');
});

test('terminal aliases and optional header extension/event fields preserve whole-session completion', async t => {
  for (const [name, body, options] of [
    ['is_last_package', { is_last_package: true, payload_msg: { code: 20000000, result: { text: '定稿' } } }, {}],
    ['is_last', { is_last: true, result: { text: '定稿' } }, {}],
    ['payload_sequence', { payload_sequence: -4, payload_msg: JSON.stringify({ result: [{ text: '定稿' }] }) }, {}],
    ['negative sequence', { result: { text: '定稿' } }, { flags: 1, sequence: -4 }],
    ['extension/event', { result: { text: '定稿' } }, { flags: 7, sequence: -4, event: 50, headerWords: 2 }]
  ]) await t.test(name, async sub => {
    const f = await localProvider(sub);
    f.session.write(pcm(1600)); f.session.finish();
    await until(() => f.received.length === 2);
    f.peer.send(serverFrame(body, options));
    assert.equal(await withTimeout(f.final.promise), '定稿');
    assert.equal(f.events.filter(event => event[0] === 'final').length, 1);
  });
});

test('empty final or a disconnect cannot promote the latest partial into a final result', async t => {
  for (const action of ['empty-final', 'disconnect']) await t.test(action, async sub => {
    const f = await localProvider(sub);
    f.peer.send(serverFrame({ result: { text: '这只是临时文字' } }));
    await until(() => f.events.some(event => event[0] === 'partial'));
    f.session.write(pcm(1600)); f.session.finish();
    await until(() => f.received.length === 2);
    if (action === 'empty-final') f.peer.send(serverFrame({}, { flags: 2 })); else f.peer.close();
    const error = await withTimeout(f.error.promise);
    assert.equal(error.code, action === 'empty-final' ? 'VOLC_ASR_EMPTY_RESULT' : 'VOLC_ASR_CONNECTION');
    assert.equal(f.events.filter(event => event[0] === 'final').length, 0);
    assert.equal(f.session.write(pcm(2)), false);
    await until(() => f.server.clients.size === 0);
  });
});

test('provider terminal before finish is an error and never emits onFinal', async t => {
  const f = await localProvider(t);
  f.peer.send(serverFrame({ result: { text: '尚未松手' } }, { flags: 2 }));
  assert.equal((await withTimeout(f.error.promise)).code, 'VOLC_ASR_EARLY_END');
  assert.equal(f.events.filter(event => event[0] === 'final').length, 0);
});

test('binary provider errors and JSON status failures return safe errors without provider text', async t => {
  for (const type of ['binary-error', 'json-error']) await t.test(type, async sub => {
    const f = await localProvider(sub);
    const secret = 'provider-must-not-echo-this-secret';
    const bytes = type === 'binary-error' ? serverFrame(null, { type: 15, flags: 0, compression: 0, serialization: 0,
      raw: Buffer.from(secret), errorCode: 45000081 }) : serverFrame({ code: 45000001, message: secret });
    f.peer.send(bytes);
    const error = await withTimeout(f.error.promise);
    assert.equal(error.code, 'VOLC_ASR_PROVIDER_ERROR');
    assert.equal(error.providerCode, type === 'binary-error' ? 45000081 : 45000001);
    assert.ok(!error.message.includes(secret));
    await until(() => f.server.clients.size === 0);
  });
});

test('HTTP upgrade rejection closes the connection and exposes no response body or credentials', async t => {
  for (const status of [401, 403, 503]) await t.test(String(status), async sub => {
    const server = http.createServer(), sockets = new Set(), observation = callbacks();
    const secret = 'sensitive-provider-response';
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('upgrade', (_request, socket) => {
      socket.end('HTTP/1.1 ' + status + ' Rejected\r\nContent-Length: ' + Buffer.byteLength(secret) + '\r\nConnection: close\r\n\r\n' + secret);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const session = createVolcSession({ ...readVolcConfig(credentials), url: 'ws://127.0.0.1:' + server.address().port }, observation.hooks);
    sub.after(async () => { session.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
    const error = await withTimeout(observation.error.promise);
    assert.equal(error.code, status === 503 ? 'VOLC_ASR_CONNECTION' : 'VOLC_ASR_AUTH');
    assert.ok(!error.message.includes(secret)); assert.ok(!error.message.includes(credentials.VOLC_ASR_API_KEY));
    assert.equal(observation.events.filter(event => event[0] === 'ready').length, 0);
    await until(() => sockets.size === 0);
  });
});

test('malformed, unsupported or decompression-expanded provider packets fail closed', async t => {
  const lengthMismatch = serverFrame({ result: { text: '错误长度' } });
  lengthMismatch.writeUInt32BE(1, 8);
  const invalidVersion = serverFrame({}); invalidVersion[0] = 0x21;
  const invalidGzip = serverFrame({}, { compression: 0 }); invalidGzip[2] = 0x11;
  const invalidUtf8 = serverFrame({}, { raw: Buffer.from([0xff]), compression: 0 });
  for (const [name, bytes, binary = true] of [
    ['truncated', Buffer.from([0x11, 0x91, 0x11, 0])], ['length', lengthMismatch], ['version', invalidVersion],
    ['gzip', invalidGzip], ['utf8', invalidUtf8], ['serialization', serverFrame({}, { serialization: 0 })],
    ['status', serverFrame({ code: { invalid: true } })], ['text-type', serverFrame({ result: { text: [] } })],
    ['json-root', serverFrame([])], ['expanded', serverFrame({ result: { text: 'x'.repeat(1024 * 1024 + 1) } })],
    ['text-websocket', Buffer.from('{"result":{"text":"wrong transport"}}'), false]
  ]) await t.test(name, async sub => {
    const f = await localProvider(sub);
    f.peer.send(bytes, { binary });
    assert.equal((await withTimeout(f.error.promise)).code, 'VOLC_ASR_PROTOCOL');
    assert.equal(f.events.filter(event => event[0] === 'final').length, 0);
    await until(() => f.server.clients.size === 0);
  });
});

test('oversized WebSocket messages are bounded by the actual transport', async t => {
  const f = await localProvider(t);
  f.peer.send(Buffer.alloc(256 * 1024 + 1));
  const error = await withTimeout(f.error.promise);
  assert.equal(error.code, 'VOLC_ASR_CONNECTION');
  assert.equal(f.events.filter(event => event[0] === 'final').length, 0);
  await until(() => f.server.clients.size === 0);
});

test('ready is asynchronous; pre-open PCM is copied and flushed only after the config frame', async t => {
  const f = scriptedProvider(t);
  assert.deepEqual(f.events, []); assert.equal(f.sockets.length, 0);
  const input = pcm(1600);
  assert.equal(f.session.write(input), true); input.fill(99);
  assert.equal(f.session.finish(), true);
  await Promise.resolve();
  const socket = f.sockets[0]; assert.equal(socket.sent.length, 0);
  socket.open();
  assert.deepEqual(f.events, [['ready']]);
  assert.equal(socket.sent.length, 2); assert.equal(socket.sent[0].type, 1);
  assert.equal(socket.sent[1].sequence, -2); assert.deepEqual(socket.sent[1].payload, pcm(1600));
  socket.emit('message', serverFrame({ result: { text: '完成' } }, { flags: 2 }), true);
  assert.equal(await withTimeout(f.final.promise), '完成'); assert.equal(socket.terminated, true);
});

test('construction/config errors are asynchronous and cancellation before connection emits nothing', async t => {
  const failing = callbacks();
  const invalid = createVolcSession(null, failing.hooks);
  assert.deepEqual(failing.events, []);
  assert.equal((await withTimeout(failing.error.promise)).code, 'VOLC_ASR_CONFIG'); invalid.close();
  const f = scriptedProvider(t);
  f.session.close(); f.session.close();
  await Promise.resolve();
  assert.equal(f.sockets.length, 0); assert.deepEqual(f.events, []);
  assert.equal(f.session.finish(), false); assert.equal(f.session.write(pcm(2)), false);
});

test('socket construction and send failures are cleaned up and do not echo transport secrets', async t => {
  const secret = 'never-expose-socket-credential';
  const construction = callbacks();
  const failed = createVolcSession({ ...readVolcConfig(credentials), WebSocket: class { constructor() { throw new Error(secret); } } }, construction.hooks);
  assert.deepEqual(construction.events, []);
  const constructionError = await withTimeout(construction.error.promise);
  assert.equal(constructionError.code, 'VOLC_ASR_CONNECTION'); assert.ok(!constructionError.message.includes(secret)); failed.close();
  for (const kind of ['throw', 'callback']) await t.test(kind, async sub => {
    const f = scriptedProvider(sub);
    await Promise.resolve(); const socket = f.sockets[0];
    socket.send = (_bytes, _options, done) => { if (kind === 'throw') throw new Error(secret); done(new Error(secret)); };
    socket.open();
    const error = await withTimeout(f.error.promise);
    assert.equal(error.code, 'VOLC_ASR_CONNECTION'); assert.ok(!error.message.includes(secret));
    assert.equal(socket.terminated, true); assert.equal(f.events.filter(event => event[0] === 'ready').length, 0);
  });
});

test('local connect, audio-idle, result and session expiry deadlines close the provider exactly once', async t => {
  for (const [name, config, expected] of [
    ['connect', { connectTimeoutMs: 30 }, 'VOLC_ASR_CONNECT_TIMEOUT'],
    ['idle', { idleTimeoutMs: 30 }, 'VOLC_ASR_IDLE_TIMEOUT'],
    ['result', { finalTimeoutMs: 30 }, 'VOLC_ASR_FINAL_TIMEOUT'],
    ['lifetime', { maxDurationMs: 30 }, 'VOLC_ASR_EXPIRED']
  ]) await t.test(name, async sub => {
    const f = scriptedProvider(sub, config);
    await Promise.resolve(); const socket = f.sockets[0];
    if (name !== 'connect') socket.open();
    if (name === 'result') { f.session.write(pcm(1600)); f.session.finish(); }
    const error = await withTimeout(f.error.promise);
    assert.equal(error.code, expected); assert.equal(socket.terminated, true);
    socket.emit('error', new Error('late transport error'));
    assert.equal(f.events.filter(event => event[0] === 'error').length, 1);
    assert.equal(f.events.filter(event => event[0] === 'final').length, 0);
  });
});

test('input bounds and provider backpressure reject writes and close sessions instead of buffering indefinitely', async t => {
  for (const scenario of ['odd', 'type', 'chunk', 'preopen', 'outgoing', 'duration', 'empty']) await t.test(scenario, async sub => {
    const f = scriptedProvider(sub);
    await Promise.resolve(); const socket = f.sockets[0];
    if (['outgoing', 'duration'].includes(scenario)) socket.open();
    let accepted;
    if (scenario === 'odd') accepted = f.session.write(pcm(3));
    if (scenario === 'type') accepted = f.session.write(new Uint8Array(2));
    if (scenario === 'chunk') accepted = f.session.write(pcm(65538));
    if (scenario === 'preopen') { for (let i = 0; i < 4; i++) assert.equal(f.session.write(pcm(65536)), true); accepted = f.session.write(pcm(2)); }
    if (scenario === 'outgoing') { socket.bufferedAmount = 300000; accepted = f.session.write(pcm(1600)); }
    if (scenario === 'duration') { for (let i = 0; i < 300; i++) assert.equal(f.session.write(pcm(6400)), true); accepted = f.session.write(pcm(2)); }
    if (scenario === 'empty') accepted = f.session.finish();
    assert.equal(accepted, false);
    const error = await withTimeout(f.error.promise);
    assert.equal(error.code, ['preopen', 'outgoing'].includes(scenario) ? 'VOLC_ASR_BACKPRESSURE' :
      scenario === 'duration' ? 'VOLC_ASR_AUDIO_LIMIT' : scenario === 'empty' ? 'VOLC_ASR_EMPTY_AUDIO' : 'VOLC_ASR_AUDIO');
    assert.equal(socket.terminated, true); assert.equal(f.events.filter(event => event[0] === 'error').length, 1);
  });
});

test('cancellation after a partial drops all late results and removes the provider connection', async t => {
  const f = await localProvider(t);
  f.peer.send(serverFrame({ result: { text: '用户准备取消' } }));
  await until(() => f.events.some(event => event[0] === 'partial'));
  const before = f.events.length;
  f.session.close();
  f.peer.send(serverFrame({ result: { text: '迟到的结果' } }, { flags: 2 }));
  await until(() => f.server.clients.size === 0);
  assert.equal(f.events.length, before);
});
