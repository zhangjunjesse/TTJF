'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const TRANSPORT = fs.readFileSync(path.join(__dirname, '..', 'voice-input.js'), 'utf8');
const WORKLET = fs.readFileSync(path.join(__dirname, '..', 'voice-pcm-worklet.js'), 'utf8');
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function target(value = {}) {
  const listeners = new Map();
  return Object.assign(value, {
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    dispatch(name) { for (const fn of Array.from(listeners.get(name) || [])) fn(); },
    pending(name) { return Array.from(listeners.get(name) || []); },
    listenerCount() { return Array.from(listeners.values()).reduce((n, set) => n + set.size, 0); }
  });
}
function harness(options = {}) {
  const requests = [], contexts = [], nodes = [], sockets = [], trace = [], timers = new Map();
  let nextTimer = 0, clock = 0, captureCalls = 0;
  const track = target({ stopped: 0, stop() { this.stopped++; } });
  const stream = { getTracks: () => [track] };
  const mic = options.mic || { promise: Promise.resolve(stream) };
  const moduleLoad = options.moduleLoad || { promise: Promise.resolve() };
  const audioResume = options.audioResume || { promise: Promise.resolve() };
  const graphNode = () => ({ connections: [], disconnected: false,
    connect(other) { this.connections.push(other); }, disconnect() { this.disconnected = true; } });
  class AudioContext {
    constructor(config) {
      if (options.rejectOptions && config) { const e = Error('unsupported audio options'); e.name = options.rejectOptions; throw e; }
      this.config = config; this.sampleRate = config?.sampleRate || options.actualRate || 48000; this.state = 'suspended';
      this.destination = {}; this.closed = 0; this.graph = [];
      this.audioWorklet = { addModule: url => { trace.push(['module', url]); return moduleLoad.promise; } };
      target(this); contexts.push(this);
    }
    resume() { trace.push(['resume']); return audioResume.promise.then(() => { this.state = 'running'; }); }
    close() { this.closed++; this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamSource(value) {
      assert.equal(value, stream);
      if (this.sampleRate !== (options.actualRate || 48000)) throw Object.assign(Error('cross-rate capture unsupported'), { name: 'NotSupportedError' });
      const node = graphNode(); this.graph.push(node); return node;
    }
    createGain() { const node = Object.assign(graphNode(), { gain: { value: 1 } }); this.graph.push(node); return node; }
  }
  class AudioWorkletNode {
    constructor(context, name, config) {
      this.context = context; this.name = name; this.config = config;
      Object.assign(this, graphNode());
      this.port = { sent: [], closed: false, onmessage: null,
        postMessage(message) { this.sent.push(message); }, close() { this.closed = true; } };
      this.emit = data => this.port.onmessage?.({ data });
      nodes.push(this);
    }
  }
  class WebSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; this.closed = 0; sockets.push(this); }
    send(value) {
      if (this.throwSend) throw Error('disconnected');
      assert.equal(this.readyState, 1);
      this.sent.push(typeof value === 'string' ? JSON.parse(value) : value);
      if (this.countBuffer && typeof value !== 'string') this.bufferedAmount += value.byteLength;
    }
    close() { this.closed++; this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.(); }
    message(body) { this.onmessage?.({ data: JSON.stringify(body) }); }
    drop() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
  }
  const document = target({ hidden: false });
  const root = target({ document, isSecureContext: true, location: { protocol: 'https:', host: 'family.test' },
    AudioContext, AudioWorkletNode, WebSocket,
    navigator: { mediaDevices: { getUserMedia(constraints) { captureCalls++; trace.push(['microphone', constraints]); return mic.promise; } } },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInNewContext(TRANSPORT, { window: root, Promise, ArrayBuffer, console }, { filename: 'voice-input.js' });
  const request = (method, url, body, callback) => {
    const entry = { method, url, body, callback, aborted: 0, abort() { this.aborted++; } };
    requests.push(entry); trace.push(['ticket']); return entry;
  };
  const events = [];
  function recognition(config = {}) {
    const value = root.FamilyVolcVoice.create({ request, hotwords: ['晶叶龙', '阅读', '阅读', '', 3], ...config });
    value.onstart = () => events.push({ type: 'start' });
    value.onresult = event => events.push({ type: 'result', text: event.results[0][0].transcript,
      final: event.results[0].isFinal, alternatives: event.results[0].length, confidence: event.results[0][0].confidence });
    value.onerror = event => events.push({ type: 'error', ...event });
    value.onend = () => events.push({ type: 'end' });
    return value;
  }
  const rec = recognition();
  async function started() {
    rec.start(); await settle();
    requests[0].callback(200, { ticket: 'one/use+ticket' });
    const socket = sockets[0]; assert.ok(socket); socket.open(); return socket;
  }
  async function ready() { const socket = await started(); socket.message({ type: 'ready' }); return socket; }
  function advance(ms) {
    const until = clock + ms;
    for (let count = 0; count < 1000; count++) {
      let chosen = null;
      for (const [id, timer] of timers) if (timer.at <= until && (!chosen || timer.at < chosen[1].at)) chosen = [id, timer];
      if (!chosen) { clock = until; return; }
      clock = chosen[1].at; timers.delete(chosen[0]); chosen[1].fn();
    }
    throw Error('timer loop did not settle');
  }
  function released() {
    assert.equal(track.stopped, 1, 'microphone track is stopped exactly once');
    assert.equal(contexts[0].closed, 1, 'AudioContext is closed exactly once');
    assert.equal(contexts[0].listenerCount(), 0);
    assert.ok(contexts[0].graph.every(node => node.disconnected));
    assert.equal(nodes[0].port.closed, true);
    assert.equal(root.listenerCount() + document.listenerCount(), 0);
    assert.equal(timers.size, 0);
  }
  return { root, rec, recognition, events, requests, contexts, nodes, sockets, trace, track, stream, mic,
    timers, advance, started, ready, released, captureCalls: () => captureCalls };
}
const frame = (bytes = 1600) => ({ type: 'pcm', buffer: new ArrayBuffer(bytes) });
const errors = h => h.events.filter(event => event.type === 'error');
const results = h => h.events.filter(event => event.type === 'result');

test('gesture resumes audio synchronously, requests mono processed capture, and uses only the same-origin ticket', async () => {
  const h = harness();
  assert.equal(h.root.FamilyVolcVoice.isSupported(), true);
  h.rec.start();
  assert.deepEqual(h.trace.map(row => row[0]), ['resume', 'module', 'microphone', 'ticket']);
  const constraints = h.trace.find(row => row[0] === 'microphone')[1];
  assert.equal(constraints.audio.channelCount.ideal, 1);
  for (const feature of ['echoCancellation', 'autoGainControl', 'noiseSuppression']) assert.equal(constraints.audio[feature], true);
  assert.equal(h.contexts[0].config.sampleRate, undefined);
  assert.equal(h.contexts[0].config.latencyHint, 'interactive');
  assert.equal(h.requests[0].method, 'POST'); assert.equal(h.requests[0].url, '/api/assistant/voice/ticket');
  await settle();
  h.requests[0].callback(200, { ticket: 'one/use+ticket' });
  assert.equal(h.sockets[0].url, 'wss://family.test/api/assistant/voice/stream?ticket=one%2Fuse%2Bticket');
  h.sockets[0].open();
  assert.deepEqual(JSON.parse(JSON.stringify(h.sockets[0].sent[0])), { type: 'start', hotwords: ['晶叶龙', '阅读'] });
  assert.equal(h.contexts[0].graph[1].gain.value, 0, 'capture never feeds microphone sound to the speaker');
  assert.equal(h.nodes[0].config.processorOptions.frameSamples, 800, 'browser packets contain 50 ms of PCM');
  h.rec.abort(); h.released();
});

test('buffers the first syllable before ready and flushes a short tail before end; only terminal final is final', async () => {
  const h = harness(), socket = await h.started();
  const first = frame(), tail = frame(96);
  h.nodes[0].emit(first);
  assert.equal(socket.sent.length, 1, 'PCM waits for backend ready');
  socket.message({ type: 'ready' });
  assert.equal(socket.sent[1], first.buffer);
  socket.message({ type: 'partial', text: '阅读加五分' });
  socket.message({ type: 'partial', text: '阅读加五分' });
  socket.message({ type: 'final', text: '阅读加五分' });
  assert.equal(results(h).length, 1, 'identical provider hypotheses are emitted once');
  assert.equal(results(h)[0].final, false, 'provider final before release cannot submit a turn');
  h.rec.stop();
  assert.equal(socket.sent.some(value => value.type === 'end'), false);
  assert.equal(h.track.stopped, 0, 'worklet may flush its in-flight samples');
  h.nodes[0].emit(tail); h.nodes[0].emit({ type: 'flushed' });
  assert.equal(socket.sent[2], tail.buffer);
  assert.deepEqual(socket.sent[3], { type: 'end' });
  assert.equal(h.track.stopped, 1);
  socket.message({ type: 'final', text: '阅读加五分' });
  assert.deepEqual(results(h).map(row => [row.text, row.final]), [['阅读加五分', false], ['阅读加五分', true]]);
  assert.equal(results(h)[1].confidence, undefined);
  assert.equal(results(h)[1].alternatives, 1);
  assert.equal(h.rec.provider, 'volc'); assert.equal(h.rec.finalized, true);
  assert.equal(h.events.filter(event => event.type === 'end').length, 1);
  h.released();
});

test('releasing while opening still sends the queued short recording after ready', async () => {
  const h = harness(); h.rec.start(); await settle();
  h.nodes[0].emit(frame(160)); h.rec.stop(); h.nodes[0].emit({ type: 'flushed' });
  assert.equal(h.track.stopped, 1); assert.equal(h.sockets.length, 0);
  h.requests[0].callback(200, { ticket: 'short' });
  h.sockets[0].open(); h.sockets[0].message({ type: 'ready' });
  assert.deepEqual(h.sockets[0].sent.map(value => value instanceof ArrayBuffer ? value.byteLength : value.type), ['start', 160, 'end']);
  h.sockets[0].message({ type: 'final', text: '好' }); h.released();
});

test('explicit text callbacks receive preview and terminal text once without duplicate Web Speech results', async () => {
  const h = harness(), partial = [], final = [];
  const rec = h.recognition({ onPartialText: text => partial.push(text), onFinalText: text => final.push(text) });
  rec.start(); await settle(); h.requests[0].callback(200, { ticket: 'callbacks' });
  const socket = h.sockets[0]; socket.open(); socket.message({ type: 'ready' }); h.nodes[0].emit(frame());
  socket.message({ type: 'partial', text: '阅读' }); socket.message({ type: 'partial', text: '阅读' });
  socket.message({ type: 'final', text: '阅读' });
  assert.deepEqual(partial, ['阅读']); assert.deepEqual(final, []);
  rec.stop(); h.nodes[0].emit({ type: 'flushed' });
  const queuedFinal = socket.onmessage;
  socket.message({ type: 'final', text: '阅读加五分' }); queuedFinal({ data: JSON.stringify({ type: 'final', text: 'duplicate' }) });
  assert.deepEqual(final, ['阅读加五分']); assert.equal(results(h).length, 0); assert.equal(rec.finalized, true); h.released();
  const disconnected = harness(), preview = [];
  const previewRec = disconnected.recognition({ onPartialText: text => preview.push(text), onFinalText: () => assert.fail('disconnected result cannot finalize') });
  previewRec.start(); await settle(); disconnected.requests[0].callback(200, { ticket: 'preview' });
  const ws = disconnected.sockets[0]; ws.open(); ws.message({ type: 'ready' }); disconnected.nodes[0].emit(frame());
  ws.message({ type: 'partial', text: '临时文字' }); ws.drop();
  assert.deepEqual(preview, ['临时文字', '']); assert.equal(results(disconnected).length, 0); disconnected.released();
});

test('hotwords satisfy gateway bounds without controls, duplicates, or unbounded JSON', async () => {
  const h = harness(), words = [' bad\u0000word ', 'bad\u0085word', '  晶叶龙  ', '晶叶龙', 'a'.repeat(70)];
  words.push(...Array.from({ length: 150 }, (_, i) => 'term' + i));
  const rec = h.recognition({ hotwords: words }); rec.start(); await settle();
  h.requests[0].callback(200, { ticket: 'hints' }); h.sockets[0].open();
  const sent = Array.from(h.sockets[0].sent[0].hotwords);
  assert.ok(sent.length <= 100); assert.ok(sent.every(word => word.length <= 50 && !/[\u0000-\u001f\u007f-\u009f]/.test(word)));
  assert.ok(sent.reduce((sum, word) => sum + word.length, 0) <= 1000);
  assert.equal(sent.filter(word => word === '晶叶龙').length, 1); assert.ok(sent.includes('a'.repeat(50)));
  rec.abort(); h.released();
});

test('gateway errors distinguish absent speech, connection failures, rate limits and unavailable service', async () => {
  for (const [code, expected] of [['NO_SPEECH', 'no-speech'], ['ASR_TIMEOUT', 'network'], ['ASR_CONNECTION_FAILED', 'network'],
    ['ASR_UNAVAILABLE', 'service-unavailable'], ['ASR_FAILED', 'service-unavailable'], ['VOICE_TOO_LONG', 'service-unavailable'],
    ['BACKPRESSURE', 'service-unavailable'], ['VOICE_BUSY', 'busy']]) {
    const h = harness(), socket = await h.ready(); h.nodes[0].emit(frame());
    socket.message({ type: 'error', code });
    assert.deepEqual([errors(h)[0].error, errors(h)[0].code], [expected, code]);
    assert.equal(h.requests.length, 1); h.released();
  }
});

test('cancel and stop during microphone permission prevent late capture and overlapping permissions', async () => {
  for (const action of ['abort', 'stop']) {
    const pending = deferred(), h = harness({ mic: pending });
    h.rec.start(); h.rec[action]();
    const other = h.recognition(); other.start();
    assert.equal(errors(h).at(-1).code, 'VOICE_BUSY');
    assert.equal(h.captureCalls(), 1);
    pending.resolve(h.stream); await settle();
    assert.equal(h.track.stopped, 1); assert.equal(h.nodes.length, 0); assert.equal(h.sockets.length, 0);
    const before = h.events.length;
    h.requests[0].callback(200, { ticket: 'late' });
    assert.equal(h.events.length, before);
    assert.equal(h.contexts[0].closed, 1); assert.equal(h.timers.size, 0);
    const next = h.recognition(); next.start(); assert.equal(h.captureCalls(), 2); next.abort(); await settle();
  }
});

test('stop during worklet load closes the context and stops any granted microphone', async () => {
  const load = deferred(), h = harness({ moduleLoad: load });
  h.rec.start(); await settle(); h.rec.stop();
  load.resolve(); await settle();
  assert.equal(h.track.stopped, 1); assert.equal(h.nodes.length, 0); assert.equal(h.contexts[0].closed, 1);
  assert.equal(h.requests[0].aborted, 1); assert.equal(h.timers.size, 0);
});

test('keeps native capture clocks and falls back when the audio constructor rejects options', async () => {
  for (const rate of [44100, 48000]) {
    const native = harness({ actualRate: rate }); await native.ready();
    assert.equal(native.contexts[0].sampleRate, rate);
    assert.equal(native.nodes[0].config.processorOptions.targetSampleRate, 16000);
    native.rec.abort(); native.released();
  }
  for (const rejection of ['NotSupportedError', 'TypeError']) {
    const fallback = harness({ rejectOptions: rejection, actualRate: 44100 }); await fallback.ready();
    assert.equal(fallback.contexts[0].config, undefined); assert.equal(fallback.contexts[0].sampleRate, 44100);
    fallback.rec.abort(); fallback.released();
  }
});

test('one fresh ticket retry before audio keeps the pre-ready recording and suppresses old socket callbacks', async () => {
  const h = harness(), firstSocket = await h.started();
  const oldOpen = firstSocket.onopen, oldMessage = firstSocket.onmessage, oldClose = firstSocket.onclose;
  const captured = frame(); h.nodes[0].emit(captured); firstSocket.drop();
  h.advance(250);
  assert.equal(h.requests.length, 2); assert.equal(h.captureCalls(), 1);
  h.requests[1].callback(200, { ticket: 'fresh' });
  const second = h.sockets[1]; second.open(); second.message({ type: 'ready' });
  assert.equal(second.sent[1], captured.buffer); assert.equal(firstSocket.sent.length, 1);
  oldOpen(); oldMessage({ data: JSON.stringify({ type: 'final', text: 'stale' }) }); oldClose();
  assert.equal(h.requests.length, 2); assert.equal(results(h).length, 0);
  h.rec.stop(); h.nodes[0].emit({ type: 'flushed' }); second.message({ type: 'final', text: '阅读' });
  assert.equal(results(h)[0].text, '阅读'); h.released();
});

test('a transient ticket failure retries once, configuration and auth errors do not retry', async () => {
  const h = harness(); h.rec.start(); await settle();
  h.requests[0].callback(503, { code: 'UPSTREAM_UNAVAILABLE' }); h.advance(250);
  assert.equal(h.requests.length, 2);
  h.requests[1].callback(0, {}); h.advance(1000);
  assert.equal(h.requests.length, 2); assert.equal(errors(h).length, 1); h.released();
  for (const [status, code] of [[503, 'VOICE_NOT_CONFIGURED'], [401, 'AUTH_REQUIRED'], [429, 'RATE_LIMITED']]) {
    const item = harness(); item.rec.start(); await settle(); item.requests[0].callback(status, { code }); item.advance(9000);
    assert.equal(item.requests.length, 1); assert.equal(errors(item)[0].code, code); item.released();
  }
});

test('synchronous ticket callbacks and missing request handles do not leak or imply microphone denial', async () => {
  const h = harness();
  const rec = h.recognition({ request(method, url, body, callback) { callback(200, { ticket: 'sync' }); return { abort() {} }; } });
  rec.start(); await settle();
  assert.equal(h.sockets.length, 1); h.sockets[0].open(); h.sockets[0].message({ type: 'ready' });
  rec.abort(); h.released();
  const absent = harness(), unavailable = absent.recognition({ request() { return null; } });
  unavailable.start(); await settle();
  assert.deepEqual([errors(absent)[0].error, errors(absent)[0].code], ['service-unavailable', 'VOICE_TICKET_UNAVAILABLE']);
  assert.equal(absent.track.stopped, 1); assert.equal(absent.contexts[0].closed, 1); assert.equal(absent.timers.size, 0);
});

test('releasing during suspended context resume never starts delayed capture or a WebSocket', async () => {
  const resume = deferred(), h = harness({ audioResume: resume });
  h.rec.start(); await settle(); h.requests[0].callback(200, { ticket: 'suspended' });
  h.rec.stop(); resume.resolve(); await settle();
  assert.equal(h.nodes.length, 0); assert.equal(h.sockets.length, 0); assert.equal(h.track.stopped, 1);
  assert.equal(h.contexts[0].closed, 1); assert.equal(h.timers.size, 0);
});

test('a dropped turn after any PCM send is discarded and never replayed', async () => {
  const h = harness(), socket = await h.ready(); h.nodes[0].emit(frame());
  socket.message({ type: 'partial', text: '尚未确认的加分' }); socket.drop(); h.advance(10000);
  assert.deepEqual(results(h).map(row => [row.text, row.final]), [['尚未确认的加分', false], ['', false]]);
  assert.equal(errors(h)[0].discarded, true); assert.equal(h.rec.finalized, false);
  assert.equal(h.requests.length, 1); assert.equal(h.captureCalls(), 1); h.released();
});

test('a disconnect after release never retries even before the first PCM was sent', async () => {
  const h = harness(), socket = await h.started(); h.rec.stop(); socket.drop(); h.advance(10000);
  assert.equal(h.requests.length, 1); assert.equal(errors(h)[0].code, 'VOICE_DISCONNECTED'); h.released();
});

test('release during the scheduled reconnect cancels the fresh ticket and ends promptly', async () => {
  const h = harness(), socket = await h.started(); socket.drop();
  h.rec.stop(); h.advance(10000);
  assert.equal(h.requests.length, 1); assert.equal(errors(h)[0].code, 'VOICE_DISCONNECTED'); h.released();
});

test('ticket and connection timeouts abort the old request and ignore late callbacks', async () => {
  const h = harness(); h.rec.start(); await settle();
  h.advance(8000); assert.equal(h.requests[0].aborted, 1); h.advance(250);
  h.requests[0].callback(200, { ticket: 'expired' }); assert.equal(h.sockets.length, 0);
  h.requests[1].callback(200, { ticket: 'fresh' });
  h.requests[1].callback(200, { ticket: 'duplicate' }); assert.equal(h.sockets.length, 1);
  h.advance(3750);
  assert.equal(errors(h)[0].code, 'VOICE_SETUP_TIMEOUT'); assert.equal(h.sockets[0].closed, 1); h.released();
  const connection = harness(), socket = await connection.started();
  connection.advance(8000); assert.equal(socket.closed, 1); connection.advance(250);
  assert.equal(connection.requests.length, 2); connection.rec.abort(); connection.released();
});

test('queued lifecycle or processor callbacks from an old run cannot stop or alter a new recording', async () => {
  const h = harness(); await h.ready();
  const oldPagehide = h.root.pending('pagehide')[0], oldPCM = h.nodes[0].port.onmessage;
  h.rec.abort(); h.rec.start(); await settle();
  const before = h.events.length;
  oldPagehide(); oldPCM({ data: frame() });
  assert.equal(h.events.length, before); assert.equal(h.contexts[1].closed, 0);
  h.rec.abort(); assert.equal(h.contexts[1].closed, 1); assert.equal(h.timers.size, 0);
});

test('malformed provider messages, premature worklet flush and empty audio cannot finalize a turn', async () => {
  for (const mode of ['bad-json', 'unknown', 'empty', 'early-flush']) {
    const h = harness(), socket = await h.ready();
    if (mode === 'bad-json') socket.onmessage({ data: '{' });
    if (mode === 'unknown') socket.message({ type: 'unexpected', text: 'cannot submit' });
    if (mode === 'early-flush') h.nodes[0].emit({ type: 'flushed' });
    if (mode === 'empty') { h.rec.stop(); h.nodes[0].emit({ type: 'flushed' }); }
    assert.equal(h.rec.finalized, false); assert.equal(results(h).some(row => row.final), false);
    assert.equal(errors(h).length, 1); h.released();
  }
});

test('backpressure has a bounded queue, drains in order, and never sends end ahead of PCM', async () => {
  const h = harness(), socket = await h.ready(); socket.countBuffer = true;
  const packets = Array.from({ length: 43 }, () => frame()); packets.forEach(packet => h.nodes[0].emit(packet));
  assert.equal(socket.sent.filter(value => value instanceof ArrayBuffer).length, 40);
  h.rec.stop(); h.nodes[0].emit({ type: 'flushed' });
  assert.equal(socket.sent.some(value => value.type === 'end'), false);
  socket.bufferedAmount = 0; h.advance(25);
  assert.deepEqual(socket.sent.filter(value => value instanceof ArrayBuffer), packets.map(packet => packet.buffer));
  assert.equal(socket.sent.at(-1).type, 'end');
  socket.message({ type: 'final', text: '完整音频' }); h.released();
  const overflow = harness(); await overflow.started();
  for (let i = 0; i < 61; i++) overflow.nodes[0].emit(frame());
  assert.equal(errors(overflow)[0].code, 'BACKPRESSURE'); overflow.released();
});

test('setup, worklet flush, and terminal final each have a bounded timeout', async () => {
  const pending = deferred(), permission = harness({ mic: pending });
  permission.rec.start(); permission.advance(12000);
  assert.equal(errors(permission)[0].code, 'VOICE_SETUP_TIMEOUT');
  pending.resolve(permission.stream); await settle();
  assert.equal(permission.track.stopped, 1); assert.equal(permission.timers.size, 0);
  const flush = harness(); await flush.ready(); flush.rec.stop(); flush.advance(1000);
  assert.equal(errors(flush)[0].code, 'VOICE_FLUSH_TIMEOUT'); flush.released();
  const final = harness(), socket = await final.ready(); final.nodes[0].emit(frame());
  final.rec.stop(); final.nodes[0].emit({ type: 'flushed' }); final.advance(10000);
  assert.equal(errors(final)[0].code, 'VOICE_FINAL_TIMEOUT'); assert.equal(socket.closed, 1); final.released();
});

test('permission denial, missing hardware, insecure context and unsupported browsers are distinct', async () => {
  for (const [name, error, code] of [['NotAllowedError', 'not-allowed', 'MICROPHONE_PERMISSION_DENIED'], ['NotFoundError', 'audio-capture', 'MICROPHONE_NOT_FOUND']]) {
    const pending = deferred(), h = harness({ mic: pending }); h.rec.start(); pending.reject({ name }); await settle();
    assert.deepEqual([errors(h)[0].error, errors(h)[0].code], [error, code]); assert.equal(h.contexts[0].closed, 1);
  }
  const insecure = harness(); insecure.root.isSecureContext = false; insecure.rec.start();
  assert.equal(errors(insecure)[0].code, 'VOICE_INSECURE_CONTEXT'); assert.equal(insecure.captureCalls(), 0);
  const unsupported = harness(); unsupported.root.AudioWorkletNode = undefined; unsupported.rec.start();
  assert.equal(errors(unsupported)[0].code, 'VOICE_UNSUPPORTED'); assert.equal(unsupported.captureCalls(), 0);
});

test('visibility, page exit, microphone loss and audio interruption release every resource', async () => {
  for (const event of ['visibility', 'pagehide', 'track', 'context']) {
    const h = harness(); await h.ready();
    if (event === 'visibility') { h.root.document.hidden = true; h.root.document.dispatch('visibilitychange'); }
    if (event === 'pagehide') h.root.dispatch('pagehide');
    if (event === 'track') h.track.dispatch('ended');
    if (event === 'context') { h.contexts[0].state = 'interrupted'; h.contexts[0].dispatch('statechange'); }
    h.released(); assert.equal(h.events.filter(item => item.type === 'end').length, 1);
  }
});

function processor(rate, config) {
  let Processor;
  const messages = [];
  class AudioWorkletProcessor { constructor() { this.port = { onmessage: null, postMessage(message) { messages.push(message); } }; } }
  vm.runInNewContext(WORKLET, { AudioWorkletProcessor, sampleRate: rate, ArrayBuffer, DataView, Float32Array,
    Float64Array, Math, Number, registerProcessor(name, value) { assert.equal(name, 'family-voice-pcm'); Processor = value; } }, { filename: 'voice-pcm-worklet.js' });
  const value = new Processor({ processorOptions: config || {} });
  function push(channels, block = 128) {
    for (let from = 0; from < channels[0].length; from += block) value.process([channels.map(channel => channel.subarray(from, from + block))], [[new Float32Array(Math.min(block, channels[0].length - from))]]);
  }
  function flush() { value.port.onmessage({ data: { type: 'flush' } }); }
  function samples() {
    const data = messages.filter(message => message.type === 'pcm');
    const joined = Buffer.concat(data.map(message => Buffer.from(message.buffer)));
    return Array.from({ length: joined.length / 2 }, (_, i) => joined.readInt16LE(i * 2));
  }
  return { value, messages, push, flush, samples };
}
function tone(rate, frequency, seconds = 0.4, amplitude = 0.5) {
  return Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amplitude * Math.sin(2 * Math.PI * frequency * i / rate));
}
function rms(samples) { const trimmed = samples.slice(400, -400); return Math.sqrt(trimmed.reduce((sum, n) => sum + n * n, 0) / trimmed.length); }

test('real DSP produces explicit little-endian clipped PCM, downmixes channels and flushes short recordings', () => {
  const h = processor(16000);
  h.push([Float32Array.from([1, -1, 0.5, -0.5, NaN, 3, -3])]); h.flush();
  assert.deepEqual(h.samples(), [32767, -32768, 16384, -16384, 0, 32767, -32768]);
  assert.deepEqual(Array.from(new Uint8Array(h.messages[0].buffer).slice(0, 4)), [255, 127, 0, 128]);
  assert.equal(h.messages.at(-1).type, 'flushed');
  const stereo = processor(48000), input = tone(48000, 500, 0.2);
  stereo.push([input, Float32Array.from(input, value => -value)], 127); stereo.flush();
  assert.equal(stereo.samples().length, 3200); assert.ok(stereo.samples().every(value => value === 0));
  const short = processor(44100); short.push([new Float32Array(220).fill(0.25)], 31); short.flush();
  assert.equal(short.samples().length, Math.round(220 * 16000 / 44100));
  assert.equal(short.messages.filter(message => message.type === 'pcm').length, 1);
  assert.equal(short.value.process([[]], [[]]), false);
  short.flush(); assert.equal(short.messages.filter(message => message.type === 'flushed').length, 1, 'duplicate stop never flushes audio twice');
});

test('real DSP preserves duration and passband amplitude for actual 16/44.1/48 kHz rates across render blocks', () => {
  for (const rate of [16000, 44100, 48000]) {
    const h = processor(rate); h.push([tone(rate, 1000)], 173); h.flush();
    assert.equal(h.samples().length, 6400, String(rate));
    assert.ok(h.messages.filter(message => message.type === 'pcm').every(message => message.buffer.byteLength === 1600));
    assert.ok(Math.abs(rms(h.samples()) / 32768 - 0.5 / Math.sqrt(2)) < 0.005, 'speech tone amplitude at ' + rate);
  }
});

test('real DSP suppresses above-Nyquist microphone noise instead of aliasing it into speech', () => {
  for (const rate of [44100, 48000]) {
    const passband = processor(rate), rejected = processor(rate);
    passband.push([tone(rate, 1000)]); rejected.push([tone(rate, 12000)]); passband.flush(); rejected.flush();
    assert.ok(rms(rejected.samples()) / rms(passband.samples()) < 0.002, '12 kHz rejection at ' + rate);
  }
});
