'use strict';
const { randomUUID } = require('node:crypto');
const { gzipSync, gunzipSync } = require('node:zlib');
const { TextDecoder } = require('node:util');
const WebSocket = require('ws');

const MODES = new Set(['bigmodel_async', 'bigmodel', 'bigmodel_nostream']);
const RESOURCE_ID = 'volc.seedasr.sauc.duration';
const PACKET_BYTES = 6400; // 200 ms of 16 kHz mono pcm_s16le, as recommended by the provider.
const MAX_CHUNK_BYTES = 64 * 1024;
const MAX_AUDIO_BYTES = 60 * 32000;
const MAX_BUFFER_BYTES = 256 * 1024;
const MAX_WIRE_BYTES = 256 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_TEXT_LENGTH = 12000;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function configError(message) {
  const error = new Error(message);
  error.code = 'VOLC_ASR_CONFIG';
  return error;
}
function envText(env, name) {
  const value = env[name];
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') throw configError(name + ' must be a string');
  return value.trim();
}
function credential(env, name) {
  const value = envText(env, name);
  if (value && (value.length > 4096 || !/^[\x21-\x7e]+$/.test(value))) {
    throw configError(name + ' must be a valid credential without whitespace or control characters');
  }
  return value;
}
function checkedHotwords(values, name) {
  if (!Array.isArray(values) || values.length > 100 || values.some(word =>
    typeof word !== 'string' || !word.trim() || word.trim().length > 50 || /[\u0000-\u001f\u007f]/.test(word))) {
    throw configError(name + ' must contain at most 100 nonempty words, each at most 50 characters');
  }
  const words = [...new Set(values.map(word => word.trim()))];
  if (words.reduce((count, word) => count + word.length, 0) > 1000) {
    throw configError(name + ' must contain at most 1000 characters in total');
  }
  return words;
}
function envHotwords(value) {
  if (!value) return [];
  const name = 'VOLC_ASR_HOTWORDS';
  if (value.length > 16000) throw configError(name + ' is too long');
  let parsed;
  if (/^[\[{]/.test(value)) {
    try { parsed = JSON.parse(value); } catch { throw configError(name + ' must be valid JSON or a comma/newline separated list'); }
    if (plain(parsed) && Object.keys(parsed).length === 1 && Array.isArray(parsed.hotwords)) parsed = parsed.hotwords;
    if (Array.isArray(parsed)) parsed = parsed.map(word => plain(word) && Object.keys(word).length === 1 ? word.word : word);
  } else {
    parsed = value.split(/[,，\r\n]+/).map(word => word.trim()).filter(Boolean);
  }
  return checkedHotwords(parsed, name);
}
function combinedHotwords(configured, requested) {
  const words = checkedHotwords(configured || [], 'ASR hotwords');
  const additions = checkedHotwords(requested || [], 'ASR hotwords'), unique = new Set(words);
  let characters = words.reduce((count, word) => count + word.length, 0);
  for (const word of additions) {
    if (unique.has(word) || words.length >= 100 || characters + word.length > 1000) continue;
    words.push(word); unique.add(word); characters += word.length;
  }
  return words;
}

// HOTWORDS accepts ["小明","积分宝箱"], {"hotwords":[{"word":"小明"}]},
// or comma/newline separated text. These become the provider's JSON-string corpus.context.
function readVolcConfig(env = process.env) {
  const provider = envText(env, 'ASR_PROVIDER').toLowerCase();
  if (provider === 'browser') return null;
  if (provider && !['volc', 'volcengine'].includes(provider)) {
    throw configError('ASR_PROVIDER must be browser, volc or volcengine');
  }
  const mode = envText(env, 'VOLC_ASR_MODE') || 'bigmodel_async';
  if (!MODES.has(mode)) throw configError('VOLC_ASR_MODE must be bigmodel_async, bigmodel or bigmodel_nostream');
  const resourceId = envText(env, 'VOLC_ASR_RESOURCE_ID') || RESOURCE_ID;
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(resourceId)) throw configError('VOLC_ASR_RESOURCE_ID has an invalid format');
  const hotwords = envHotwords(envText(env, 'VOLC_ASR_HOTWORDS'));
  const apiKey = credential(env, 'VOLC_ASR_API_KEY');
  const appKey = credential(env, 'VOLC_ASR_APP_KEY');
  const accessKey = credential(env, 'VOLC_ASR_ACCESS_KEY');
  if (!!appKey !== !!accessKey) throw configError('VOLC_ASR_APP_KEY and VOLC_ASR_ACCESS_KEY must be configured together');
  if (!apiKey && !appKey) return null;
  return Object.freeze({ mode, resourceId, apiKey, appKey, accessKey, hotwords: Object.freeze(hotwords),
    url: 'wss://openspeech.bytedance.com/api/v3/sauc/' + mode });
}

function frame(type, bytes, sequence, last = false) {
  const compressed = gzipSync(bytes);
  const header = Buffer.alloc(12);
  header[0] = 0x11;
  header[1] = (type << 4) | (last ? 3 : 1);
  header[2] = (type === 1 ? 0x10 : 0) | 1;
  header.writeInt32BE(last ? -sequence : sequence, 4);
  header.writeUInt32BE(compressed.length, 8);
  return Buffer.concat([header, compressed]);
}
function parseFrame(data, isBinary) {
  if (!isBinary || !Buffer.isBuffer(data) || data.length < 8 || data.length > MAX_WIRE_BYTES) throw new Error('Invalid frame');
  const headerBytes = (data[0] & 15) * 4, type = data[1] >> 4, flags = data[1] & 15;
  const serialization = data[2] >> 4, compression = data[2] & 15;
  if (data[0] >> 4 !== 1 || headerBytes < 4 || headerBytes > data.length - 4 ||
      ![9, 15].includes(type) || flags > 7 || ![0, 1].includes(compression) ||
      (type === 9 ? serialization !== 1 : ![0, 1].includes(serialization))) throw new Error('Unsupported frame');
  let offset = headerBytes, sequence = 0;
  const take = signed => {
    if (offset + 4 > data.length) throw new Error('Truncated frame');
    const value = signed ? data.readInt32BE(offset) : data.readUInt32BE(offset);
    offset += 4; return value;
  };
  if (flags & 1) sequence = take(true);
  if (flags & 4) take(true); // The official parser permits an optional event field.
  const errorCode = type === 15 ? take(false) : null;
  const size = take(false);
  if (size !== data.length - offset) throw new Error('Invalid payload length');
  let payload = data.subarray(offset);
  if (compression === 1) payload = gunzipSync(payload, { maxOutputLength: MAX_JSON_BYTES });
  if (payload.length > MAX_JSON_BYTES) throw new Error('Payload too large');
  if (type === 15) return { errorCode };
  const body = payload.length ? JSON.parse(utf8.decode(payload)) : {};
  if (!plain(body)) throw new Error('Invalid JSON body');
  return { body, last: !!(flags & 2) || sequence < 0 };
}
function lastPackage(body) {
  return body.is_last_package === true || body.is_last === true ||
    ['sequence', 'payload_sequence'].some(key => Number.isInteger(body[key]) && body[key] < 0);
}
function responseCode(body) {
  if (body.code === undefined) return 0;
  const code = typeof body.code === 'string' && /^\d{1,8}$/.test(body.code) ? Number(body.code) : body.code;
  if (!Number.isInteger(code) || code < 0 || code > 99999999) throw new Error('Invalid status');
  return code === 20000000 ? 0 : code;
}
function transcript(body) {
  let result = body.result;
  // List responses contain recognition alternatives, not text deltas to concatenate.
  if (Array.isArray(result)) result = result[0];
  if (result === undefined) return null;
  if (!plain(result)) throw new Error('Invalid recognition result');
  let text = result.text;
  if (text === undefined && Array.isArray(result.utterances)) {
    if (result.utterances.length > 256 || result.utterances.some(item => !plain(item) || typeof item.text !== 'string')) {
      throw new Error('Invalid utterances');
    }
    text = result.utterances.map(item => item.text).join('');
  }
  if (text === undefined) return null;
  if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) throw new Error('Invalid transcript');
  return text;
}
function parseResult(body) {
  const outer = body;
  if (body.payload_msg !== undefined && body.payload_msg !== null) {
    body = typeof body.payload_msg === 'string' ? JSON.parse(body.payload_msg) : body.payload_msg;
    if (!plain(body) || body.payload_msg !== undefined) throw new Error('Invalid response envelope');
  }
  return { code: responseCode(outer) || responseCode(body), last: lastPackage(outer) || lastPackage(body), text: transcript(body) };
}
function timeout(value, fallback) {
  return Number.isInteger(value) && value > 0 && value <= 120000 ? value : fallback;
}

class VolcSession {
  constructor(config, callbacks) {
    this.config = config;
    this.callbacks = callbacks;
    this.socket = null;
    this.timers = {};
    this.pending = Buffer.alloc(0);
    this.totalBytes = 0;
    this.sequence = 1;
    this.ready = false;
    this.finishing = false;
    this.finalSent = false;
    this.ended = false;
    this.partial = null;
    // Even a constructor/config failure is delivered after createVolcSession returns.
    queueMicrotask(() => this.start());
  }
  notify(name, value) {
    if (typeof this.callbacks[name] === 'function') this.callbacks[name](value);
  }
  arm(name, delay, code, message) {
    clearTimeout(this.timers[name]);
    this.timers[name] = setTimeout(() => this.fail(code, message), delay);
    this.timers[name].unref();
  }
  cleanup() {
    for (const timer of Object.values(this.timers)) clearTimeout(timer);
    this.timers = {};
    this.pending = Buffer.alloc(0);
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }
  fail(code, message, providerCode) {
    if (this.ended) return;
    this.ended = true;
    this.cleanup();
    const error = new Error(message);
    error.code = code;
    if (providerCode !== undefined) error.providerCode = providerCode;
    this.notify('onError', error);
  }
  providerFailure(code) {
    const message = code === 45000081 ? '语音连接等待录音超时，请重新录音' :
      code === 45000002 ? '没有收到可识别的录音，请重新录音' : '语音识别服务暂时不可用，请重新录音';
    this.fail('VOLC_ASR_PROVIDER_ERROR', message, code);
  }
  start() {
    if (this.ended) return;
    const config = this.config;
    try {
      if (!config || !MODES.has(config.mode) || !(config.apiKey || config.appKey && config.accessKey)) {
        throw configError('Volcengine ASR is not configured');
      }
      this.hotwords = combinedHotwords(config.hotwords, this.callbacks.hotwords);
      const id = randomUUID(), headers = { 'X-Api-Resource-Id': config.resourceId,
        'X-Api-Request-Id': id, 'X-Api-Connect-Id': id, 'X-Api-Sequence': '-1' };
      if (config.apiKey) headers['X-Api-Key'] = config.apiKey;
      else { headers['X-Api-App-Key'] = config.appKey; headers['X-Api-Access-Key'] = config.accessKey; }
      this.arm('connect', timeout(config.connectTimeoutMs, 8000), 'VOLC_ASR_CONNECT_TIMEOUT', '语音服务连接超时，请重试');
      this.arm('lifetime', timeout(config.maxDurationMs, 65000), 'VOLC_ASR_EXPIRED', '本次录音时间已到，请重新录音');
      const Socket = config.WebSocket || WebSocket;
      this.socket = new Socket(config.url, { headers, handshakeTimeout: timeout(config.connectTimeoutMs, 8000),
        maxPayload: MAX_WIRE_BYTES, perMessageDeflate: false });
      this.socket.once('open', () => this.opened());
      this.socket.on('message', (data, binary) => this.received(data, binary));
      this.socket.on('error', () => this.fail('VOLC_ASR_CONNECTION', '语音连接中断，请重新录音'));
      this.socket.once('close', () => {
        this.socket = null;
        this.fail('VOLC_ASR_CONNECTION', '语音连接已断开，请重新录音');
      });
      this.socket.once('unexpected-response', (_request, response) => {
        response.resume();
        this.fail([401, 403].includes(response.statusCode) ? 'VOLC_ASR_AUTH' : 'VOLC_ASR_CONNECTION',
          [401, 403].includes(response.statusCode) ? '语音服务鉴权失败，请检查服务端配置' : '语音服务连接失败，请重试');
      });
    } catch (error) {
      this.fail(error.code === 'VOLC_ASR_CONFIG' ? 'VOLC_ASR_CONFIG' : 'VOLC_ASR_CONNECTION',
        error.code === 'VOLC_ASR_CONFIG' ? '语音服务配置无效，请检查服务端配置' : '语音服务连接失败，请重试');
    }
  }
  opened() {
    if (this.ended) return;
    clearTimeout(this.timers.connect);
    const request = { model_name: 'bigmodel', enable_itn: true, enable_punc: true,
      show_utterances: true, result_type: 'full', end_window_size: 800 };
    if (this.config.mode === 'bigmodel_async') request.enable_nonstream = true;
    if (this.hotwords.length) request.corpus = { context: JSON.stringify({ hotwords: this.hotwords.map(word => ({ word })) }) };
    const body = { user: { uid: randomUUID() }, audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 }, request };
    if (!this.send(frame(1, Buffer.from(JSON.stringify(body)), this.sequence++))) return;
    this.ready = true;
    this.arm('idle', timeout(this.config.idleTimeoutMs, 8000), 'VOLC_ASR_IDLE_TIMEOUT', '语音连接等待录音超时，请重新录音');
    this.notify('onReady');
    this.flush();
  }
  send(bytes) {
    if (this.ended) return false;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.fail('VOLC_ASR_CONNECTION', '语音连接中断，请重新录音'); return false;
    }
    if (this.socket.bufferedAmount + bytes.length > MAX_BUFFER_BYTES) {
      this.fail('VOLC_ASR_BACKPRESSURE', '语音网络暂时繁忙，请重新录音'); return false;
    }
    try {
      this.socket.send(bytes, { binary: true }, error => {
        if (error) this.fail('VOLC_ASR_CONNECTION', '语音连接中断，请重新录音');
      });
      return !this.ended;
    } catch {
      this.fail('VOLC_ASR_CONNECTION', '语音连接中断，请重新录音'); return false;
    }
  }
  audio(bytes, last) {
    if (!this.send(frame(2, bytes, this.sequence++, last))) return false;
    if (last) {
      this.finalSent = true;
      clearTimeout(this.timers.idle);
      clearTimeout(this.timers.lifetime);
      this.arm('final', timeout(this.config.finalTimeoutMs, 10000), 'VOLC_ASR_FINAL_TIMEOUT', '语音识别结果等待超时，请重新录音');
    } else {
      this.arm('idle', timeout(this.config.idleTimeoutMs, 8000), 'VOLC_ASR_IDLE_TIMEOUT', '语音连接等待录音超时，请重新录音');
    }
    return true;
  }
  flush() {
    if (!this.ready || this.ended || this.finalSent) return;
    while (this.pending.length >= PACKET_BYTES) {
      const bytes = this.pending.subarray(0, PACKET_BYTES);
      this.pending = this.pending.subarray(PACKET_BYTES);
      if (!this.audio(bytes, false)) return;
    }
    if (this.finishing) {
      const bytes = this.pending;
      this.pending = Buffer.alloc(0);
      this.audio(bytes, true);
    }
  }
  write(bytes) {
    if (this.ended || this.finishing) return false;
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_CHUNK_BYTES || bytes.length % 2) {
      this.fail('VOLC_ASR_AUDIO', '录音数据格式无效，请重新录音'); return false;
    }
    if (!bytes.length) return true;
    if (this.totalBytes + bytes.length > MAX_AUDIO_BYTES) {
      this.fail('VOLC_ASR_AUDIO_LIMIT', '本次录音过长，请分段录音'); return false;
    }
    if (this.pending.length + bytes.length > MAX_BUFFER_BYTES || (this.socket && this.socket.bufferedAmount > MAX_BUFFER_BYTES)) {
      this.fail('VOLC_ASR_BACKPRESSURE', '语音网络暂时繁忙，请重新录音'); return false;
    }
    this.totalBytes += bytes.length;
    this.pending = Buffer.concat([this.pending, bytes]);
    this.flush();
    return !this.ended;
  }
  finish() {
    if (this.ended) return false;
    if (this.finishing) return true;
    if (!this.totalBytes) { this.fail('VOLC_ASR_EMPTY_AUDIO', '没有收到录音，请重新录音'); return false; }
    this.finishing = true;
    this.flush();
    return !this.ended;
  }
  received(data, binary) {
    if (this.ended) return;
    let decoded, result;
    try {
      decoded = parseFrame(data, binary);
      if (decoded.errorCode !== undefined) { this.providerFailure(decoded.errorCode); return; }
      result = parseResult(decoded.body);
    } catch {
      this.fail('VOLC_ASR_PROTOCOL', '语音服务返回了无效数据，请重新录音'); return;
    }
    if (result.code) { this.providerFailure(result.code); return; }
    if (decoded.last || result.last) {
      if (!this.finishing || !this.finalSent) {
        this.fail('VOLC_ASR_EARLY_END', '语音服务提前结束，请重新录音'); return;
      }
      // A terminal packet must carry its own final text. A cached partial is never a final result.
      if (result.text === null || !result.text.trim()) {
        this.fail('VOLC_ASR_EMPTY_RESULT', '没有识别到完整语音，请重新录音'); return;
      }
      this.ended = true;
      this.cleanup();
      this.notify('onFinal', result.text);
    } else if (result.text !== null && result.text !== this.partial) {
      this.partial = result.text;
      this.notify('onPartial', result.text);
    }
  }
  close() {
    this.ended = true;
    this.cleanup();
  }
}

function createVolcSession(config, callbacks = {}) {
  const session = new VolcSession(config, callbacks);
  return { write: bytes => session.write(bytes), finish: () => session.finish(), close: () => session.close() };
}

module.exports = { readVolcConfig, createVolcSession };
