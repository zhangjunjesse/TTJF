'use strict';
const { WebSocket, WebSocketServer } = require('ws');
const S = require('./security.cjs');

const TICKET_PATH = '/api/assistant/voice/ticket';
const STREAM_PATH = '/api/assistant/voice/stream';
const DEFAULT_LIMITS = Object.freeze({
  ticketTtlMs: 30000, maxPendingTickets: 256, maxStreams: 8, maxUserStreams: 1, maxFamilyStreams: 2,
  ticketsPerMinute: 12, familyTicketsPerMinute: 30, userStartsPerDay: 120, familyStartsPerDay: 300, startsPerDay: 2000,
  startTimeoutMs: 5000, connectTimeoutMs: 10000, idleTimeoutMs: 15000, finalTimeoutMs: 10000,
  lifetimeMs: 75000, heartbeatMs: 10000, closeTimeoutMs: 1000,
  maxFrameBytes: 64 * 1024, maxAudioBytes: 60 * 32000, maxOutputBytes: 64 * 1024
});

function readLimits(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const key of Object.keys(limits)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key) || !Number.isSafeInteger(limits[key]) || limits[key] < 1) {
      throw new Error('Invalid ASR gateway limit: ' + key);
    }
  }
  return limits;
}

function parseControl(data) {
  if (data.length > 8192) { throw new Error('control too large'); }
  const value = JSON.parse(data.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('invalid control'); }
  if (value.type === 'end' && Object.keys(value).length === 1) { return value; }
  if (value.type !== 'start' || Object.keys(value).some(key => !['type', 'hotwords'].includes(key))) {
    throw new Error('invalid control');
  }
  const words = value.hotwords === undefined ? [] : value.hotwords;
  if (!Array.isArray(words) || words.length > 100 || words.some(word =>
    typeof word !== 'string' || !word.trim() || word.trim().length > 50 || /[\u0000-\u001f\u007f-\u009f]/.test(word)) ||
      words.reduce((sum, word) => sum + word.length, 0) > 1000) { throw new Error('invalid hotwords'); }
  return { type: 'start', hotwords: [...new Set(words.map(word => word.trim()))] };
}

function publicError(error) {
  if (error && error.providerCode === 45000002) { return 'NO_SPEECH'; }
  switch (error && error.code) {
    case 'VOLC_ASR_CONNECTION': case 'VOLC_ASR_CONNECT_TIMEOUT': return 'ASR_CONNECTION_FAILED';
    case 'VOLC_ASR_EMPTY_AUDIO': case 'VOLC_ASR_EMPTY_RESULT': return 'NO_SPEECH';
    case 'VOLC_ASR_AUTH': case 'VOLC_ASR_CONFIG': return 'ASR_UNAVAILABLE';
    case 'VOLC_ASR_IDLE_TIMEOUT': case 'VOLC_ASR_FINAL_TIMEOUT': case 'VOLC_ASR_EXPIRED': return 'ASR_TIMEOUT';
    case 'VOLC_ASR_BACKPRESSURE': return 'BACKPRESSURE';
    case 'VOLC_ASR_AUDIO_LIMIT': return 'VOICE_TOO_LONG';
    default: return 'ASR_FAILED';
  }
}

function rejectUpgrade(socket, status) {
  if (socket.destroyed) { return; }
  const reason = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    429: 'Too Many Requests', 503: 'Service Unavailable' }[status] || 'Service Unavailable';
  const cutoff = setTimeout(() => socket.destroy(), 1000); cutoff.unref();
  socket.once('close', () => clearTimeout(cutoff));
  socket.end('HTTP/1.1 ' + status + ' ' + reason + '\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n');
}

function createAsrGateway({ store, auth, now, config, connect, getCookie, sameOrigin, limits: overrides }) {
  const limits = readLimits(overrides);
  const enabled = !!config;
  if (enabled && typeof connect !== 'function') { throw new Error('Invalid ASR connector'); }
  const tickets = new Map(), active = new Set(), pending = new Set();
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxFrameBytes, perMessageDeflate: false });
  const sampled = () => +new Date(now());
  let closing = false, closed;

  function pruneTickets() {
    const at = sampled();
    for (const [key, value] of tickets) { if (value.expiresAt <= at) { tickets.delete(key); } }
  }
  function busy(binding) {
    // The browser can finish its close handshake before the server's TCP close
    // event. Reap that closing connection before admitting an immediate retry.
    for (const item of active) { if (item.socket.readyState !== WebSocket.OPEN) { item.stop(); } }
    return active.size >= limits.maxStreams ||
      [...active].filter(item => item.userId === binding.userId).length >= limits.maxUserStreams ||
      [...active].filter(item => item.familyId === binding.familyId).length >= limits.maxFamilyStreams;
  }
  async function quotas(client, rules, windowMs) {
    let until;
    for (const [scope, maximum] of rules) {
      const checked = await store.rate(scope, maximum, windowMs, new Date(now()), client);
      if (!checked.allowed) { until = Math.max(until || 0, +checked.until); }
    }
    return until;
  }
  function rateError(until) {
    const error = new S.HttpError(429, 'RATE_LIMITED', '语音使用较多，请稍后再试');
    error.retryAfter = Math.max(1, Math.ceil((until - sampled()) / 1000));
    throw error;
  }
  async function authorize(client, ctx) {
    const who = await auth.identity(client, ctx, { verified: true });
    const family = await store.family(client, who, ctx.familyId);
    return { userId: who.user.id, familyId: family.id, sessionHash: who.session.token_hash, sessionExpiresAt: +who.session.expires_at };
  }

  async function ticket(ctx) {
    const checked = await store.transaction(async client => {
      const binding = await authorize(client, ctx);
      if (!enabled || closing) { return { binding }; }
      const until = await quotas(client, [
        ['asr-ticket:user:' + binding.userId, limits.ticketsPerMinute],
        ['asr-ticket:family:' + binding.familyId, limits.familyTicketsPerMinute]
      ], 60000);
      return { binding, until };
    });
    if (!enabled || closing) { S.fail(503, 'ASR_UNAVAILABLE', '语音服务暂不可用'); }
    if (checked.until) { rateError(checked.until); }
    if (busy(checked.binding)) { S.fail(429, 'VOICE_BUSY', '已有语音正在使用，请稍后再试'); }
    pruneTickets();
    // A browser only needs its latest ticket; abandoned permission prompts do
    // not accumulate credentials or reserve provider capacity.
    for (const [key, value] of tickets) {
      if (value.sessionHash === checked.binding.sessionHash) { tickets.delete(key); }
    }
    if (tickets.size >= limits.maxPendingTickets) { S.fail(429, 'VOICE_BUSY', '语音服务繁忙，请稍后再试'); }
    const raw = S.token();
    tickets.set(S.digest(raw), { ...checked.binding, expiresAt: Math.min(checked.binding.sessionExpiresAt, sampled() + limits.ticketTtlMs) });
    return { body: { ticket: raw, userId: checked.binding.userId, familyId: checked.binding.familyId } };
  }

  function stream(ws, binding, rawToken) {
    let state = 'start', provider, phaseTimer, closeTimer, heartbeat, hardTimer, bytes = 0;
    let terminal = false, alive = true, checking = false, readyPending = false;
    const entry = { userId: binding.userId, familyId: binding.familyId, socket: ws, stop: abort };
    active.add(entry);

    function closeProvider() {
      const current = provider;
      provider = null;
      if (current) { try { current.close(); } catch (_) { /* no provider details leave this boundary */ } }
    }
    function cleanup() {
      state = 'closed';
      clearTimeout(phaseTimer); clearTimeout(hardTimer); clearInterval(heartbeat);
      active.delete(entry);
      closeProvider();
    }
    function abort() {
      terminal = true;
      cleanup(); clearTimeout(closeTimer);
      ws.terminate();
    }
    function end(payload, code = 1000) {
      if (terminal) { return; }
      terminal = true;
      cleanup();
      if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > limits.maxOutputBytes) { return abort(); }
      closeTimer = setTimeout(abort, limits.closeTimeoutMs); closeTimer.unref();
      try {
        ws.send(JSON.stringify(payload), error => {
          if (error) { abort(); } else if (ws.readyState === WebSocket.OPEN) { ws.close(code); }
        });
      } catch (_) { abort(); }
    }
    function fail(code) { end({ type: 'error', code }, 1008); }
    function phase(timeout, code = 'ASR_TIMEOUT') {
      clearTimeout(phaseTimer);
      phaseTimer = setTimeout(() => fail(code), timeout); phaseTimer.unref();
    }
    function send(payload) {
      if (terminal || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > limits.maxOutputBytes) { return false; }
      try { ws.send(JSON.stringify(payload), error => { if (error) { abort(); } }); }
      catch (_) { return false; }
      return ws.bufferedAmount <= limits.maxOutputBytes;
    }
    function ready() {
      if (terminal || state !== 'connecting') { return; }
      if (!provider) { readyPending = true; return; }
      state = 'recording';
      phase(limits.idleTimeoutMs);
      if (!send({ type: 'ready' })) { fail('BACKPRESSURE'); }
    }
    function transcript(text, final) {
      if (terminal) { return; }
      if (typeof text !== 'string' || text.length > 8000 || (final && state !== 'finishing')) { fail('ASR_FAILED'); return; }
      if (!['recording', 'finishing'].includes(state)) { return; }
      if (final) { end({ type: 'final', text: text.trim() }); }
      else if (!send({ type: 'partial', text })) { fail('BACKPRESSURE'); }
    }
    function start(hotwords) {
      state = 'connecting';
      phase(limits.connectTimeoutMs, 'ASR_CONNECTION_FAILED');
      try {
        provider = connect(config, { hotwords, onReady: ready, onPartial: text => transcript(text, false),
          onFinal: text => transcript(text, true), onError: error => fail(publicError(error)) });
        if (!provider || ['write', 'finish', 'close'].some(key => typeof provider[key] !== 'function')) {
          fail('ASR_FAILED'); return;
        }
        if (terminal) { closeProvider(); }
        else if (readyPending) { ready(); }
      } catch (error) { fail(publicError(error)); }
    }
    ws.on('message', (data, binary) => {
      if (terminal) { return; }
      if (binary) {
        if (state !== 'recording' || data.length === 0 || data.length % 2 !== 0) { fail('VOICE_PROTOCOL'); return; }
        bytes += data.length;
        if (bytes > limits.maxAudioBytes) { fail('VOICE_TOO_LONG'); return; }
        try { if (provider.write(data) === false) { fail('BACKPRESSURE'); return; } }
        catch (error) { fail(publicError(error)); return; }
        if (!terminal) { phase(limits.idleTimeoutMs); }
        return;
      }
      let message;
      try { message = parseControl(data); } catch (_) { fail('VOICE_PROTOCOL'); return; }
      if (state === 'start' && message.type === 'start') { start(message.hotwords); return; }
      if (state === 'recording' && message.type === 'end') {
        state = 'finishing'; phase(limits.finalTimeoutMs);
        try { provider.finish(); } catch (error) { fail(publicError(error)); }
        return;
      }
      fail('VOICE_PROTOCOL');
    });
    ws.on('pong', () => { alive = true; });
    ws.on('error', abort);
    ws.on('close', () => { terminal = true; cleanup(); clearTimeout(closeTimer); });
    phase(limits.startTimeoutMs);
    hardTimer = setTimeout(() => fail('VOICE_TOO_LONG'), Math.min(limits.lifetimeMs, Math.max(1, binding.sessionExpiresAt - sampled())));
    hardTimer.unref();
    heartbeat = setInterval(async () => {
      if (terminal) { return; }
      if (!alive) { fail('ASR_TIMEOUT'); return; }
      alive = false;
      try { ws.ping(); } catch (_) { abort(); return; }
      if (checking) { return; }
      checking = true;
      try {
        await store.transaction(client => authorize(client, { rawToken, familyId: binding.familyId, write: false }));
      } catch (_) { fail('SESSION_EXPIRED'); }
      finally { checking = false; }
    }, limits.heartbeatMs);
    heartbeat.unref();
  }

  async function upgrade(request, socket, head) {
    pending.add(socket);
    socket.on('error', () => {});
    const timeout = setTimeout(() => socket.destroy(), limits.connectTimeoutMs); timeout.unref();
    try {
      if (closing || !enabled) { rejectUpgrade(socket, 503); return; }
      let url;
      try { url = new URL(request.url, 'http://asr.local'); } catch (_) { rejectUpgrade(socket, 400); return; }
      if (url.pathname !== STREAM_PATH) { rejectUpgrade(socket, 404); return; }
      if (request.method !== 'GET' || !request.headers.origin || !sameOrigin(request)) { rejectUpgrade(socket, 403); return; }
      const values = url.searchParams.getAll('ticket');
      if (values.length !== 1 || [...url.searchParams.keys()].some(key => key !== 'ticket') || !S.TOKEN.test(values[0])) {
        rejectUpgrade(socket, 401); return;
      }
      const key = S.digest(values[0]), value = tickets.get(key);
      // Consume synchronously, before any asynchronous authentication, so two
      // racing upgrades cannot open two paid provider connections.
      tickets.delete(key);
      const rawToken = getCookie(request);
      if (!value || value.expiresAt <= sampled() || typeof rawToken !== 'string' ||
          !S.TOKEN.test(rawToken) || !S.equal(value.sessionHash, S.digest(rawToken))) { rejectUpgrade(socket, 401); return; }
      const checked = await store.transaction(async client => {
        const binding = await authorize(client, { rawToken, familyId: value.familyId, write: false });
        if (binding.userId !== value.userId || !S.equal(binding.sessionHash, value.sessionHash)) { S.fail(401, 'AUTH_REQUIRED', '登录已失效'); }
        const until = await quotas(client, [
          ['asr-start:user:' + binding.userId, limits.userStartsPerDay],
          ['asr-start:family:' + binding.familyId, limits.familyStartsPerDay],
          ['asr-start:server', limits.startsPerDay]
        ], 24 * 60 * 60000);
        return { binding, until };
      });
      if (socket.destroyed) { return; }
      if (closing) { rejectUpgrade(socket, 503); return; }
      if (checked.until || busy(checked.binding)) { rejectUpgrade(socket, 429); return; }
      socket.setTimeout(0);
      wss.handleUpgrade(request, socket, head, ws => stream(ws, checked.binding, rawToken));
    } catch (error) {
      rejectUpgrade(socket, error instanceof S.HttpError ? error.status : 503);
    } finally { clearTimeout(timeout); pending.delete(socket); }
  }

  function close() {
    if (!closed) {
      closing = true; tickets.clear();
      for (const socket of pending) { socket.destroy(); }
      for (const entry of active) { entry.stop(); }
      closed = new Promise(resolve => wss.close(() => resolve()));
    }
    return closed;
  }
  return { enabled, ticket, upgrade, close };
}

module.exports = { createAsrGateway, TICKET_PATH };
