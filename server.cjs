'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const FamilyModel = require('./model.js');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};
const TOP_LEVEL = new Set(['/index.html', '/styles.css', '/app.js', '/model.js', '/assistant.js', '/pet.js', '/pet.css', '/farm-ui.js', '/farm.css', '/farm-scene.js', '/manifest.webmanifest', '/runtime.js', '/saas-client.js', '/saas.css', '/world-ui.js', '/farm-world.css']);
const ASSET_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.mp3', '.wav', '.ogg']);
const PUBLIC_ACTIONS = new Set(['task.toggle', 'task.ack', 'task.snooze', 'redemption.request', 'redemption.cancel', 'pet.configure', 'pet.care', 'pet.scene',
  'farm.start', 'farm.plant', 'farm.harvest', 'farm.exchange', 'farm.place', 'farm.animalCare']);
const ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const CHALLENGE_MS = 120000;
const GRANT_MS = 60000;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function atomicWrite(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, '.' + path.basename(file) + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp');
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } catch (error) {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch (_) { /* original failure */ } }
    try { fs.unlinkSync(temporary); } catch (_) { /* no temporary file left */ }
    throw error;
  }
}

function pinValue(pin) {
  if (typeof pin !== 'string' || pin.length < 6 || pin.length > 12 || /\D/.test(pin)) { throw new Error('家长密码须为6至12位数字'); }
  return pin;
}
function pinHash(pin, salt) { return crypto.scryptSync(pin, salt, 32).toString('hex'); }
function newParent(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { configured: true, method: 'pin', salt, hash: pinHash(pinValue(pin), salt) };
}
function validParent(parent) {
  if (!parent || typeof parent !== 'object' || Array.isArray(parent) ||
      Object.keys(parent).some(key => !['configured', 'method', 'salt', 'hash'].includes(key)) ||
      typeof parent.configured !== 'boolean') { throw new Error('家长核验配置无效'); }
  if (!parent.configured) {
    if (parent.method !== null || own(parent, 'salt') || own(parent, 'hash')) { throw new Error('家长核验配置无效'); }
    return;
  }
  if (!['pin', 'math'].includes(parent.method)) { throw new Error('家长核验配置无效'); }
  const hasCredentials = own(parent, 'salt') || own(parent, 'hash');
  if ((parent.method === 'pin' || hasCredentials) &&
      (typeof parent.salt !== 'string' || typeof parent.hash !== 'string' ||
       !/^[a-f0-9]{32}$/.test(parent.salt) || !/^[a-f0-9]{64}$/.test(parent.hash))) {
    throw new Error('家长核验配置无效');
  }
}
function loadState(dataFile, now, initialPin) {
  const exists = fs.existsSync(dataFile);
  let saved;
  try {
    saved = exists ? JSON.parse(fs.readFileSync(dataFile, 'utf8')) : { revision: 1, state: FamilyModel.createSeed(now()) };
    if (!saved || !Number.isSafeInteger(saved.revision) || saved.revision < 1) { throw new Error('版本号无效'); }
    const state = FamilyModel.normalize(saved.state);
    let parent = saved.parent;
    if (parent === undefined) {
      if (saved.receipts !== undefined) { throw new Error('家长核验配置缺失'); }
      parent = initialPin === undefined ? { configured: false, method: null } : newParent(initialPin);
    } else if (parent && typeof parent === 'object' && !Array.isArray(parent) && !own(parent, 'configured')) {
      // Legacy files always carried credentials, even when the selected method
      // was arithmetic. Their absence must not become a public setup/reset path.
      if (!own(parent, 'salt') || !own(parent, 'hash')) { throw new Error('家长核验配置缺失'); }
      parent = Object.assign({}, parent, { configured: true });
    }
    validParent(parent);
    const receipts = saved.receipts === undefined ? {} : saved.receipts;
    if (!receipts || typeof receipts !== 'object' || Array.isArray(receipts)) { throw new Error('动作凭据格式无效'); }
    for (const [id, receipt] of Object.entries(receipts)) {
      if (!ACTION_ID.test(id) || !state.appliedActions.includes(id) || !receipt ||
          !['sha256', 'scrypt'].includes(receipt.algorithm) || typeof receipt.digest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.digest) ||
          (receipt.algorithm === 'scrypt' && (typeof receipt.salt !== 'string' || !/^[a-f0-9]{32}$/.test(receipt.salt)))) { throw new Error('动作凭据无效'); }
      if (!parent.configured && receipt.algorithm === 'scrypt') { throw new Error('已有家长配置记录不能标记为未设置'); }
    }
    const envelope = { revision: saved.revision, state, parent, receipts };
    if (!exists || JSON.stringify(saved) !== JSON.stringify(envelope)) { atomicWrite(dataFile, envelope); }
    return envelope;
  } catch (error) {
    throw new Error('无法读取持久数据，已保留原文件：' + error.message);
  }
}

function canonical(value, depth = 0) {
  if (depth > 40) { throw new Error('操作内容嵌套过深'); }
  if (value === null || typeof value !== 'object') { return JSON.stringify(value); }
  if (Array.isArray(value)) { return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']'; }
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key], depth + 1)).join(',') + '}';
}
function fingerprint(action) { return crypto.createHash('sha256').update(canonical(action)).digest('hex'); }
function makeReceipt(action) {
  // A configuration action can contain a PIN. A fast unsalted digest of that
  // payload would undermine the slow, salted PIN hash in the same private file.
  if (action.type === 'parent.configure' || action.type === 'parent.setup') {
    const salt = crypto.randomBytes(16).toString('hex');
    return { algorithm: 'scrypt', salt, digest: pinHash(canonical(action), salt) };
  }
  return { algorithm: 'sha256', digest: fingerprint(action) };
}
function receiptMatches(receipt, action) {
  const digest = receipt.algorithm === 'scrypt' ? pinHash(canonical(action), receipt.salt) : fingerprint(action);
  return crypto.timingSafeEqual(Buffer.from(receipt.digest, 'hex'), Buffer.from(digest, 'hex'));
}
function within(file, directory) {
  const relative = path.relative(directory, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function createServer(options = {}) {
  const rootDir = fs.realpathSync(path.resolve(options.rootDir || __dirname));
  const dataFile = path.resolve(options.dataFile || path.join(__dirname, 'data', 'state.json'));
  const now = options.now === undefined ? () => new Date() : options.now;
  const maxBodyBytes = options.maxBodyBytes === undefined ? 256 * 1024 : options.maxBodyBytes;
  if (typeof now !== 'function') { throw new Error('now 必须为返回当前时间的函数'); }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) { throw new Error('maxBodyBytes 必须为正整数'); }
  let publicOrigin = null;
  if (options.publicOrigin) {
    const parsed = new URL(options.publicOrigin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) { throw new Error('publicOrigin 必须为不含路径的 HTTP(S) 来源'); }
    publicOrigin = parsed.origin;
  }
  const assistant = options.assistantService || require('./assistant-service.cjs').createAssistantService();
  if (!assistant || typeof assistant.interpret !== 'function' || typeof assistant.status !== 'function') {
    throw new Error('assistantService 必须提供 interpret 和 status');
  }
  let current = loadState(dataFile, now, options.parentPin);
  const challenges = new Map();
  const grants = new Map();
  const rates = new Map();
  let assistantInFlight = 0;
  const publicParent = () => ({ configured: current.parent.configured, method: current.parent.method });
  const snapshot = () => {
    const serverTime = new Date(now());
    return { revision: current.revision, state: current.state, serverNow: serverTime.toISOString(),
      familyDay: FamilyModel.dateKey(serverTime), parent: publicParent() };
  };
  const clock = () => new Date(now()).getTime();
  function respond(response, status, value, extraHeaders) {
    response.writeHead(status, Object.assign({
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin'
    }, extraHeaders));
    response.end(JSON.stringify(value));
  }
  function reject(response, status, code, error, extra) {
    return respond(response, status, Object.assign({ error, code }, extra));
  }
  function sameOrigin(request) {
    const fetchSite = request.headers['sec-fetch-site'];
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') { return false; }
    let expected;
    try { expected = publicOrigin || new URL('http://' + request.headers.host).origin; }
    catch (_) { return false; }
    function matches(value, referer) {
      try {
        const url = new URL(value);
        return url.origin === expected && !url.username && !url.password &&
          (referer || (url.pathname === '/' && !url.search && !url.hash));
      } catch (_) { return false; }
    }
    if (request.headers.origin) { return matches(request.headers.origin, false); }
    if (request.headers.referer) { return matches(request.headers.referer, true); }
    // Non-browser JSON clients need no Origin. Cross-site HTML forms cannot send
    // application/json, and browser JSON requests require a denied CORS preflight.
    return !fetchSite || fetchSite === 'same-origin' || fetchSite === 'none';
  }
  function jsonRequest(request, response, handler) {
    if (!sameOrigin(request)) { request.resume(); return reject(response, 403, 'ORIGIN_DENIED', '仅允许同源提交'); }
    if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] || '')) {
      request.resume(); return reject(response, 415, 'JSON_REQUIRED', '请使用 application/json');
    }
    if (Number(request.headers['content-length']) > maxBodyBytes) {
      request.resume(); return reject(response, 413, 'BODY_TOO_LARGE', '请求内容过大');
    }
    const chunks = [];
    let size = 0;
    let finished = false;
    request.on('data', chunk => {
      if (finished) { return; }
      size += chunk.length;
      if (size > maxBodyBytes) {
        finished = true; chunks.length = 0;
        reject(response, 413, 'BODY_TOO_LARGE', '请求内容过大');
      } else { chunks.push(chunk); }
    });
    request.on('error', () => {
      if (!finished && !response.destroyed) { finished = true; reject(response, 400, 'INVALID_JSON', '请求未完整接收'); }
    });
    request.on('end', () => {
      if (finished) { return; }
      finished = true;
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { throw new Error('object required'); }
      } catch (_) { return reject(response, 400, 'INVALID_JSON', '请求格式无效'); }
      try {
        const result = handler(payload);
        if (result && typeof result.catch === 'function') {
          result.catch(() => { if (!response.writableEnded) { reject(response, 500, 'INTERNAL_ERROR', '请求未完成，请稍后重试'); } });
        }
      } catch (_) { if (!response.writableEnded) { reject(response, 500, 'INTERNAL_ERROR', '请求未完成，请稍后重试'); } }
    });
  }
  function bucket(key, windowMs) {
    const time = clock();
    for (const [oldKey, value] of rates) { if (value.until <= time) { rates.delete(oldKey); } }
    if (!rates.has(key)) { rates.set(key, { count: 0, until: time + windowMs }); }
    return rates.get(key);
  }
  function rateError(response, until) {
    const seconds = Math.max(1, Math.ceil((until - clock()) / 1000));
    respond(response, 429, { error: '尝试次数较多，请稍后再试', code: 'RATE_LIMITED', retryAfter: seconds }, { 'Retry-After': String(seconds) });
    return false;
  }
  function limit(request, response, kind, maximum, windowMs = 60000) {
    const family = bucket(kind + ':family', windowMs);
    if (family.count >= maximum * 3) { return rateError(response, family.until); }
    const perAddress = bucket(kind + ':' + request.socket.remoteAddress, windowMs);
    if (perAddress.count >= maximum) { return rateError(response, perAddress.until); }
    perAddress.count += 1; family.count += 1;
    return true;
  }
  function failuresAllowed(response) {
    const failures = bucket('verification-failures', 300000);
    return failures.count < 5 || rateError(response, failures.until);
  }
  function recordFailure() { bucket('verification-failures', 300000).count += 1; }
  function command(payload, response) {
    if (!Number.isSafeInteger(payload.revision) || payload.revision < 1 || !payload.action ||
        typeof payload.action !== 'object' || Array.isArray(payload.action) || typeof payload.action.id !== 'string' ||
        !ACTION_ID.test(payload.action.id) || typeof payload.action.type !== 'string') {
      reject(response, 400, 'VALIDATION_ERROR', '请提供有效版本号和操作标识'); return false;
    }
    try { canonical(payload.action); }
    catch (_) { reject(response, 400, 'VALIDATION_ERROR', '操作内容嵌套过深'); return false; }
    return true;
  }
  function configValues(action) {
    if (!['pin', 'math'].includes(action.method)) { throw new Error('家长核验方式无效'); }
    if (action.type === 'parent.setup') {
      if (Object.keys(action).some(key => !['id', 'type', 'method', 'pin', 'confirmPin'].includes(key))) {
        throw new Error('首次设置包含无效字段');
      }
      if (action.method === 'pin') {
        if (typeof action.pin !== 'string' || action.pin.length !== 6 || /\D/.test(action.pin)) { throw new Error('PIN须为6位数字'); }
        if (action.confirmPin !== action.pin) { throw new Error('PIN确认不一致'); }
      } else if (own(action, 'pin') || own(action, 'confirmPin')) { throw new Error('算术方式无需PIN'); }
      return;
    }
    if (own(action, 'pin')) { pinValue(action.pin); }
    if (own(action, 'confirmPin') && (!own(action, 'pin') || action.confirmPin !== action.pin)) {
      throw new Error('PIN确认不一致');
    }
    if (action.method === 'pin' && !own(action, 'pin') && !current.parent.hash) {
      throw new Error('请设置新PIN');
    }
  }
  function setupRequired(response) {
    return reject(response, 403, 'PARENT_SETUP_REQUIRED', '请先设置家长验证', { revision: current.revision, parent: publicParent() });
  }
  function conflict(response, action) {
    const latest = snapshot();
    if (action.type === 'parent.setup' && current.parent.configured) {
      return reject(response, 409, 'PARENT_ALREADY_CONFIGURED', '家长验证已设置', latest);
    }
    return respond(response, 409, latest);
  }
  function replay(payload, response) {
    if (!current.state.appliedActions.includes(payload.action.id)) { return false; }
    const receipt = own(current.receipts, payload.action.id) && current.receipts[payload.action.id];
    if (receipt && receipt.algorithm === 'scrypt' && !failuresAllowed(response)) { return true; }
    if (!receipt || !receiptMatches(receipt, payload.action)) {
      if (receipt && receipt.algorithm === 'scrypt') { recordFailure(); }
      reject(response, 400, 'ACTION_ID_REUSED', '此操作标识已使用，不能更改内容后重试');
    } else { respond(response, 200, snapshot()); }
    return true;
  }
  function challengeRequest(request, response, payload) {
    if (!limit(request, response, 'challenge', 20) || !failuresAllowed(response) || !command(payload, response)) { return; }
    if (payload.revision !== current.revision) { return conflict(response, payload.action); }
    if (!current.parent.configured) { return setupRequired(response); }
    if (payload.action.type === 'parent.setup') { return conflict(response, payload.action); }
    if (PUBLIC_ACTIONS.has(payload.action.type)) { return reject(response, 400, 'VALIDATION_ERROR', '此日常操作无需家长验证'); }
    if (current.state.appliedActions.includes(payload.action.id)) {
      return reject(response, 400, 'ACTION_ID_REUSED', '此操作已提交，请使用相同内容直接重试');
    }
    try {
      if (payload.action.type === 'parent.configure') { configValues(payload.action); }
      else { FamilyModel.apply(current.state, payload.action, now()); }
    } catch (error) { return reject(response, 400, 'VALIDATION_ERROR', error.message); }
    const time = clock();
    for (const store of [challenges, grants]) {
      for (const [key, value] of store) { if (value.expiresAt <= time) { store.delete(key); } }
      if (store.size >= 1000) { return rateError(response, time + 60000); }
    }
    const challengeId = crypto.randomBytes(32).toString('base64url');
    const method = current.parent.method;
    const entry = { revision: payload.revision, digest: fingerprint(payload.action), method, expiresAt: time + CHALLENGE_MS, attempts: 0 };
    const result = { challengeId, method, expiresAt: new Date(entry.expiresAt).toISOString() };
    if (method === 'math') {
      const left = crypto.randomInt(11, 100), right = crypto.randomInt(11, 100);
      result.question = left + ' + ' + right + ' = ?';
      entry.answer = String(left + right);
    }
    challenges.set(challengeId, entry);
    respond(response, 200, result);
  }
  function verifyRequest(request, response, payload) {
    if (!limit(request, response, 'verify', 30) || !failuresAllowed(response)) { return; }
    const entry = typeof payload.challengeId === 'string' && challenges.get(payload.challengeId);
    if (!entry || entry.expiresAt <= clock()) {
      challenges.delete(payload.challengeId);
      return reject(response, 410, 'CHALLENGE_EXPIRED', '验证请求已失效，请重新确认操作');
    }
    if (entry.revision !== current.revision) {
      challenges.delete(payload.challengeId); return respond(response, 409, snapshot());
    }
    const answer = typeof payload.answer === 'string' || typeof payload.answer === 'number' ? String(payload.answer).trim() : '';
    let valid = false;
    if (entry.method === 'pin' && /^\d{6,12}$/.test(answer)) {
      valid = crypto.timingSafeEqual(Buffer.from(current.parent.hash, 'hex'), Buffer.from(pinHash(answer, current.parent.salt), 'hex'));
    } else if (entry.method === 'math') { valid = answer === entry.answer; }
    if (!valid) {
      recordFailure(); entry.attempts += 1;
      if (entry.attempts >= 3) { challenges.delete(payload.challengeId); }
      return reject(response, 403, 'VERIFICATION_FAILED', '验证未通过，请重试');
    }
    challenges.delete(payload.challengeId);
    const grant = crypto.randomBytes(32).toString('base64url');
    const expiresAt = clock() + GRANT_MS;
    grants.set(grant, { revision: entry.revision, digest: entry.digest, expiresAt });
    respond(response, 200, { grant, expiresAt: new Date(expiresAt).toISOString() });
  }
  function actionRequest(request, response, payload) {
    if (!limit(request, response, 'action', 60) || !command(payload, response) || replay(payload, response)) { return; }
    if (payload.revision !== current.revision) { return conflict(response, payload.action); }
    const settingUp = payload.action.type === 'parent.setup';
    if (settingUp && current.parent.configured) { return conflict(response, payload.action); }
    if (!settingUp && !PUBLIC_ACTIONS.has(payload.action.type)) {
      if (!current.parent.configured) { return setupRequired(response); }
      if (!payload.grant) { return reject(response, 403, 'PARENT_REQUIRED', '此操作需要家长验证'); }
      const grant = typeof payload.grant === 'string' && grants.get(payload.grant);
      if (grant && grant.expiresAt <= clock()) {
        grants.delete(payload.grant); return reject(response, 410, 'GRANT_EXPIRED', '本次授权已过期，请重新验证');
      }
      if (!grant || grant.revision !== payload.revision || grant.digest !== fingerprint(payload.action)) {
        return reject(response, 403, 'GRANT_INVALID', '本次授权与操作不匹配，请重新验证');
      }
    }
    let state, parent = current.parent;
    try {
      if (settingUp || payload.action.type === 'parent.configure') {
        configValues(payload.action);
        parent = own(payload.action, 'pin') ? newParent(payload.action.pin) :
          settingUp ? { configured: true, method: 'math' } : Object.assign({}, current.parent);
        parent.method = payload.action.method;
        state = FamilyModel.normalize(current.state);
        state.appliedActions.push(payload.action.id);
      } else { state = FamilyModel.apply(current.state, payload.action, now()); }
    } catch (error) { return reject(response, 400, 'VALIDATION_ERROR', error.message); }
    if (!Number.isSafeInteger(current.revision + 1)) { return reject(response, 500, 'REVISION_LIMIT', '版本号已达到上限'); }
    const receipts = Object.assign({}, current.receipts, { [payload.action.id]: makeReceipt(payload.action) });
    const updated = { revision: current.revision + 1, state, parent, receipts };
    // No await between compare, authorization, apply and atomic rename: one
    // synchronous commit publishes the ledger, PIN configuration and receipt.
    try { atomicWrite(dataFile, updated); }
    catch (_) { return reject(response, 500, 'SAVE_FAILED', '保存失败，请稍后重试'); }
    current = updated;
    if (payload.grant) { grants.delete(payload.grant); }
    respond(response, 200, snapshot());
  }
  async function assistantRequest(request, response, payload) {
    if (!limit(request, response, 'assistant', 12)) { return; }
    if (assistantInFlight >= 2) { return rateError(response, clock() + 1000); }
    if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 1200) {
      return reject(response, 400, 'VALIDATION_ERROR', '请输入不超过1200字的指令');
    }
    const context = payload.context === undefined ? 'general' : payload.context;
    const targetId = payload.targetId === undefined ? '' : payload.targetId;
    if (!['general', 'points', 'pointItems'].includes(context) || typeof targetId !== 'string' ||
        (targetId !== '' && !ACTION_ID.test(targetId))) {
      return reject(response, 400, 'VALIDATION_ERROR', '助手情境或目标标识无效');
    }
    assistantInFlight += 1;
    try {
      // Only copied business data crosses the assistant boundary. Neither the
      // photo nor parent secrets/challenges/grants are passed to the service.
      const assistantState = Object.assign({}, current.state);
      delete assistantState.childAvatar;
      const result = await assistant.interpret(payload.text.trim(), JSON.parse(JSON.stringify(assistantState)), new Date(now()), { context, targetId });
      respond(response, 200, result);
    } catch (_) { reject(response, 503, 'ASSISTANT_UNAVAILABLE', '暂时无法理解这句话，请重试或手动填写'); }
    finally { assistantInFlight -= 1; }
  }
  function staticRequest(request, response, pathname) {
    if (pathname === '/') { pathname = '/index.html'; }
    const isAsset = pathname.startsWith('/assets/');
    if (!TOP_LEVEL.has(pathname) && !(isAsset && ASSET_EXTENSIONS.has(path.extname(pathname).toLowerCase()))) {
      return respond(response, 404, { error: '未找到资源' });
    }
    const requested = path.resolve(rootDir, '.' + pathname);
    try {
      const real = fs.realpathSync(requested);
      const realRoute = '/' + path.relative(rootDir, real).split(path.sep).join('/');
      if (!within(real, rootDir) ||
          (isAsset && (!within(real, path.join(rootDir, 'assets')) || !ASSET_EXTENSIONS.has(path.extname(real).toLowerCase()))) ||
          (!isAsset && !TOP_LEVEL.has(realRoute)) ||
          real === dataFile || real === fs.realpathSync(dataFile) || !fs.statSync(real).isFile()) {
        return respond(response, 404, { error: '未找到资源' });
      }
      const bytes = fs.readFileSync(real);
      response.writeHead(200, {
        'Content-Type': MIME[path.extname(pathname).toLowerCase()] || 'application/octet-stream',
        'Content-Length': bytes.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN', 'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'same-origin'
      });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch (_) { respond(response, 404, { error: '未找到资源' }); }
  }
  const server = http.createServer((request, response) => {
    let pathname;
    try {
      if (!request.url.startsWith('/')) { throw new Error('absolute request target'); }
      pathname = decodeURIComponent(request.url.split('?')[0]);
      if (pathname.indexOf('\\') >= 0 || pathname.indexOf('\0') >= 0 ||
          !/^\/[A-Za-z0-9_./-]*$/.test(pathname) || pathname.split('/').some(segment => segment.startsWith('.'))) {
        throw new Error('invalid path');
      }
    } catch (_) { return reject(response, 400, 'INVALID_PATH', '路径无效'); }
    if (['/api/health', '/api/state', '/api/meta'].includes(pathname)) {
      if (request.method !== 'GET') { return respond(response, 405, { error: '请求方法不允许' }, { Allow: 'GET' }); }
      if (pathname === '/api/health') { return respond(response, 200, { ok: true, revision: current.revision }); }
      if (pathname === '/api/state') { return respond(response, 200, snapshot()); }
      try {
        const status = assistant.status();
        if (!status || !['local', 'connected'].includes(status.mode) || typeof status.label !== 'string') { throw new Error('invalid status'); }
        const sampledNow = new Date(now());
        return respond(response, 200, { revision: current.revision, parent: publicParent(), assistant: { mode: status.mode, label: status.label }, now: sampledNow.toISOString(), familyDay: FamilyModel.dateKey(sampledNow) });
      } catch (_) { return reject(response, 503, 'ASSISTANT_UNAVAILABLE', '助手暂不可用'); }
    }
    const handlers = { '/api/action': actionRequest, '/api/parent/challenge': challengeRequest,
      '/api/parent/verify': verifyRequest, '/api/assistant': assistantRequest };
    if (own(handlers, pathname)) {
      if (request.method !== 'POST') { return respond(response, 405, { error: '请求方法不允许' }, { Allow: 'POST' }); }
      return jsonRequest(request, response, payload => handlers[pathname](request, response, payload));
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') { return respond(response, 405, { error: '请求方法不允许' }, { Allow: 'GET, HEAD' }); }
    return staticRequest(request, response, pathname);
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}
module.exports = { createServer };

if (require.main === module) {
  const host = process.env.HOST || '127.0.0.1';
  const port = process.env.PORT === undefined ? 4178 : Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT 必须为 1 至 65535 的整数'); process.exitCode = 1;
  } else {
    try {
      const server = createServer({ publicOrigin: process.env.PUBLIC_ORIGIN, parentPin: process.env.PARENT_PIN, dataFile: process.env.DATA_FILE });
      server.on('error', error => { console.error('服务启动失败：' + error.message); process.exitCode = 1; });
      server.listen(port, host, () => { console.log('家庭看板已启动：http://' + host + ':' + port); });
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
