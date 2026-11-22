'use strict';
// The legacy model uses local calendar methods. The dedicated SaaS process has
// one documented family calendar; UTC timestamps and crop durations stay real.
process.env.TZ = 'Asia/Shanghai';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./saas/security.cjs');
const { createStore } = require('./saas/store.cjs');
const { createMailer, loopback } = require('./saas/mail.cjs');
const { createAuth } = require('./saas/auth.cjs');
const { createFamilies } = require('./saas/families.cjs');
const { createBusiness } = require('./saas/business.cjs');
const { createLifecycle } = require('./saas/lifecycle.cjs');
const { createClientAddress } = require('./saas/network.cjs');
const { createMaintenance, maintenanceConfig } = require('./saas/maintenance.cjs');
const { initialAccountFromEnv, ensureInitialAccount } = require('./saas/initial-account.cjs');
const MIME = Object.freeze({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.webmanifest': 'application/manifest+json; charset=utf-8' });
const TOP_LEVEL = new Set(['/index.html', '/styles.css', '/app.js', '/model.js', '/assistant.js', '/pet.js', '/pet.css', '/farm-ui.js',
  '/farm.css', '/farm-scene.js', '/manifest.webmanifest', '/saas-client.js', '/saas.css', '/world-ui.js', '/farm-world.css', '/home-points.js', '/home-points.css', '/assistant-panel.js', '/assistant-panel.css']);
const ASSET_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.mp3', '.wav', '.ogg']);
const BUSINESS = new Set(['/api/state', '/api/meta', '/api/parent/challenge', '/api/parent/verify', '/api/action', '/api/assistant',
  '/api/assistant/chat/read', '/api/assistant/chat/turn', '/api/assistant/chat/clear']);

function configuredOrigin(value, production) {
  if (!value) { throw new Error('PUBLIC_ORIGIN is required for mail links and origin validation'); }
  let url;
  try { url = new URL(value); } catch (_) { throw new Error('Invalid PUBLIC_ORIGIN'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin without path or credentials');
  }
  if (url.protocol !== 'https:' && (production || !loopback(url.hostname))) { throw new Error('Public SaaS requires HTTPS; HTTP is loopback development only'); }
  return url.origin;
}
function cookieToken(request, cookieName) {
  const matches = (request.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith(cookieName + '='));
  return matches.length === 1 ? matches[0].slice(cookieName.length + 1) : null;
}
function sameOrigin(request, origin) {
  const site = request.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) { return false; }
  const value = request.headers.origin || request.headers.referer;
  if (!value) { return false; }
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password &&
      (!request.headers.origin || (url.pathname === '/' && !url.search && !url.hash));
  } catch (_) { return false; }
}
async function readJson(request, maximum) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] || '')) {
    request.resume(); S.fail(415, 'JSON_REQUIRED', '请使用 application/json');
  }
  if (Number(request.headers['content-length']) > maximum) { request.resume(); S.fail(413, 'BODY_TOO_LARGE', '请求内容过大'); }
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, finished = false;
    const fail = error => { if (!finished) { finished = true; chunks.length = 0; reject(error); } };
    request.on('data', chunk => {
      if (finished) { return; }
      size += chunk.length;
      if (size > maximum) { fail(new S.HttpError(413, 'BODY_TOO_LARGE', '请求内容过大')); }
      else { chunks.push(chunk); }
    });
    request.on('error', () => fail(new S.HttpError(400, 'INVALID_JSON', '请求未完整接收')));
    request.on('aborted', () => fail(new S.HttpError(400, 'INVALID_JSON', '请求未完整接收')));
    request.on('end', () => {
      if (finished) { return; }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) { throw new Error('object required'); }
        finished = true; resolve(body);
      } catch (_) { fail(new S.HttpError(400, 'INVALID_JSON', '请求格式无效')); }
    });
  });
}
function within(file, directory) {
  const relative = path.relative(directory, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
async function createSaasServer(options = {}) {
  if (options.databaseUrl !== undefined || options.pool !== undefined) {
    throw new Error('PostgreSQL databaseUrl/pool options are no longer supported. Select an explicit SQLite databasePath; existing PostgreSQL data is not migrated automatically.');
  }
  const environment = options.environment || process.env.NODE_ENV || 'development', production = environment === 'production';
  const publicOrigin = configuredOrigin(options.publicOrigin || process.env.PUBLIC_ORIGIN, production);
  const now = options.now || (() => new Date());
  if (typeof now !== 'function' || !Number.isFinite(+new Date(now()))) { throw new Error('now must return a valid date'); }
  const maxBodyBytes = options.maxBodyBytes === undefined ? 256 * 1024 : options.maxBodyBytes;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) { throw new Error('Invalid maxBodyBytes'); }
  const rootDir = fs.realpathSync(path.resolve(options.rootDir || __dirname));
  const assistant = options.assistantService || require('./assistant-service.cjs').createAssistantService();
  if (!assistant || typeof assistant.status !== 'function' || typeof assistant.interpret !== 'function') { throw new Error('Invalid assistantService'); }
  const clientAddress = createClientAddress(options.trustedProxies === undefined ? process.env.SAAS_TRUSTED_PROXIES : options.trustedProxies);
  const maintenanceOptions = maintenanceConfig(options);
  const mail = createMailer({ ...options, environment, publicOrigin });
  let store;
  try {
    store = await createStore({ databasePath: options.databasePath, database: options.database, migrate: options.migrate });
    await ensureInitialAccount(store, options.initialAccount, now);
  } catch (error) {
    try { if (store) await store.close(); } finally { mail.close(); }
    throw error;
  }
  const cookieName = production ? '__Host-ttjf_session' : 'ttjf_session';
  const reportError = typeof options.onError === 'function' ? options.onError : code => console.error('[SaaS] ' + code);
  const auth = createAuth({ store, mail, now, publicOrigin, cookieName, secureCookie: new URL(publicOrigin).protocol === 'https:', reportError });
  const families = createFamilies({ store, auth, mail, now, publicOrigin });
  const business = createBusiness({ store, auth, now, assistant });
  const lifecycle = createLifecycle({ store, auth, now });
  const maintenance = createMaintenance({ store, now, reportError, ...maintenanceOptions });
  const commonHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN' };
  function respond(response, result) {
    if (response.destroyed || response.writableEnded) { return; }
    response.writeHead(result.status || 200, { ...commonHeaders, 'Content-Type': 'application/json; charset=utf-8', ...result.headers });
    response.end(JSON.stringify(result.body));
  }
  function staticRequest(request, response, pathname) {
    if (pathname === '/runtime.js') {
      response.writeHead(200, { ...commonHeaders, 'Content-Type': MIME['.js'] });
      return response.end(request.method === 'HEAD' ? undefined : 'window.__TTJF_SAAS__=true;\n');
    }
    if (pathname === '/') { pathname = '/index.html'; }
    const isAsset = pathname.startsWith('/assets/');
    if (!TOP_LEVEL.has(pathname) && !(isAsset && ASSET_EXTENSIONS.has(path.extname(pathname).toLowerCase()))) { S.fail(404, 'NOT_FOUND', '未找到资源'); }
    const requested = path.resolve(rootDir, '.' + pathname);
    let real, bytes;
    try {
      real = fs.realpathSync(requested);
      const route = '/' + path.relative(rootDir, real).split(path.sep).join('/');
      if (!within(real, rootDir) || (isAsset && (!within(real, path.join(rootDir, 'assets')) || !ASSET_EXTENSIONS.has(path.extname(real).toLowerCase()))) ||
          (!isAsset && !TOP_LEVEL.has(route)) || !fs.statSync(real).isFile()) { throw new Error('outside static allowlist'); }
      bytes = fs.readFileSync(real);
    } catch (_) { S.fail(404, 'NOT_FOUND', '未找到资源'); }
    response.writeHead(200, { ...commonHeaders, 'Content-Type': MIME[path.extname(pathname).toLowerCase()] || 'application/octet-stream', 'Content-Length': bytes.length });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  }
  function requireMethod(ctx, methods) {
    if (!methods.includes(ctx.method)) {
      const error = new S.HttpError(405, 'METHOD_NOT_ALLOWED', '请求方法不允许'); error.allow = methods.join(', '); throw error;
    }
  }
  async function route(ctx, body) {
    const p = ctx.pathname;
    if (p === '/api/health') { requireMethod(ctx, ['GET']); await store.database.query('SELECT 1'); return { body: { ok: true } }; }
    if (p === '/api/session') { requireMethod(ctx, ['GET']); return auth.session(ctx); }
    if (p.startsWith('/api/auth/')) {
      requireMethod(ctx, ['POST']);
      switch (p) {
        case '/api/auth/register': return auth.register(ctx, body);
        case '/api/auth/login': return auth.login(ctx, body);
        case '/api/auth/logout': return auth.logout(ctx);
        case '/api/auth/change-password': return auth.changePassword(ctx, body);
        case '/api/auth/delete-account': return lifecycle.removeAccount(ctx, body);
        case '/api/auth/verify-email': return auth.consumeEmail(ctx, body, 'verify');
        case '/api/auth/reset-password': return auth.consumeEmail(ctx, body, 'reset');
        case '/api/auth/resend-verification': return auth.requestEmail(ctx, body, 'verify');
        case '/api/auth/forgot-password': return auth.requestEmail(ctx, body, 'reset');
        default: S.fail(404, 'NOT_FOUND', '接口不存在');
      }
    }
    if (p === '/api/families') { requireMethod(ctx, ['POST']); return families.create(ctx, body); }
    if (p === '/api/invitations/accept') { requireMethod(ctx, ['POST']); return families.accept(ctx, body); }
    const life = /^\/api\/families\/([^/]+)(?:\/(leave|transfer-owner))?$/.exec(p);
    if (life) {
      if (life[2]) {
        requireMethod(ctx, ['POST']);
        return life[2] === 'leave' ? lifecycle.leave(ctx, life[1]) : lifecycle.transfer(ctx, life[1], body);
      }
      requireMethod(ctx, ['PATCH', 'DELETE']);
      return ctx.method === 'PATCH' ? lifecycle.rename(ctx, life[1], body) : lifecycle.removeFamily(ctx, life[1], body);
    }
    const match = /^\/api\/families\/([^/]+)\/(members|invitations)(?:\/([^/]+))?$/.exec(p);
    if (match) {
      const familyId = match[1], section = match[2], targetId = match[3];
      if (targetId) {
        requireMethod(ctx, ['DELETE']);
        return section === 'members' ? families.remove(ctx, familyId, targetId) : families.revoke(ctx, familyId, targetId);
      }
      requireMethod(ctx, section === 'members' ? ['GET'] : ['GET', 'POST']);
      return section === 'members' ? families.members(ctx, familyId) : ctx.method === 'GET' ? families.invitations(ctx, familyId) : families.invite(ctx, familyId, body);
    }
    if (BUSINESS.has(p)) {
      requireMethod(ctx, ['/api/state', '/api/meta'].includes(p) ? ['GET'] : ['POST']);
      switch (p) {
        case '/api/state': return business.state(ctx);
        case '/api/meta': return business.meta(ctx);
        case '/api/parent/challenge': return business.challenge(ctx, body);
        case '/api/parent/verify': return business.verify(ctx, body);
        case '/api/action': return business.action(ctx, body);
        case '/api/assistant': return business.interpret(ctx, body);
        case '/api/assistant/chat/read': return business.chatRead(ctx, body);
        case '/api/assistant/chat/turn': return business.chatTurn(ctx, body);
        case '/api/assistant/chat/clear': return business.chatClear(ctx, body);
      }
    }
    S.fail(404, 'NOT_FOUND', '接口不存在');
  }
  const server = http.createServer(async (request, response) => {
    const ctx = { method: request.method, address: clientAddress(request),
      rawToken: cookieToken(request, cookieName), csrfToken: request.headers['x-csrf-token'], familyId: request.headers['x-family-id'],
      write: !['GET', 'HEAD', 'OPTIONS'].includes(request.method) };
    try {
      if (typeof request.url !== 'string' || !request.url.startsWith('/')) { S.fail(400, 'INVALID_PATH', '路径无效'); }
      try { ctx.pathname = decodeURIComponent(request.url.split('?')[0]); }
      catch (_) { S.fail(400, 'INVALID_PATH', '路径无效'); }
      if (!/^\/[A-Za-z0-9_./-]*$/.test(ctx.pathname) || ctx.pathname.split('/').some(segment => segment.startsWith('.'))) { S.fail(400, 'INVALID_PATH', '路径无效'); }
      if (!ctx.pathname.startsWith('/api/')) { requireMethod(ctx, ['GET', 'HEAD']); return staticRequest(request, response, ctx.pathname); }
      let body;
      if (ctx.write) {
        if (!sameOrigin(request, publicOrigin)) { request.resume(); S.fail(403, 'ORIGIN_DENIED', '仅允许同源提交'); }
        body = await readJson(request, maxBodyBytes);
        // Public auth routes remain usable with an expired cookie, but a live
        // authenticated browser must send its session-bound CSRF token too.
        if (ctx.rawToken && ctx.pathname.startsWith('/api/auth/') && !['/api/auth/logout', '/api/auth/change-password', '/api/auth/delete-account'].includes(ctx.pathname)) {
          try { await store.transaction(client => auth.identity(client, ctx)); }
          catch (error) { if (!(error instanceof S.HttpError) || error.status !== 401) { throw error; } }
        }
      }
      respond(response, await route(ctx, body));
    } catch (error) {
      const known = error instanceof S.HttpError;
      if (!known) { reportError('REQUEST_FAILED'); }
      const body = { code: known ? error.code : 'DATABASE_UNAVAILABLE', error: known ? error.message : '服务暂不可用，请稍后重试' };
      if (BUSINESS.has(ctx.pathname)) { body.familyId = typeof ctx.familyId === 'string' && S.UUID.test(ctx.familyId) ? ctx.familyId : null; body.userId = ctx.userId || null; }
      const headers = {};
      if (error.retryAfter) { body.retryAfter = error.retryAfter; headers['Retry-After'] = String(error.retryAfter); }
      if (error.allow) { headers.Allow = error.allow; }
      respond(response, { status: known ? error.status : 503, body, headers });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.store = store;
  server.ops = maintenance;
  let closing;
  server.closeSaas = () => {
    if (!closing) {
      closing = (async () => {
        try { await maintenance.close(); }
        finally {
          try {
            if (server.listening) {
              await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
            }
          } finally { try { await store.close(); } finally { mail.close(); } }
        }
      })();
    }
    return closing;
  };
  return server;
}
module.exports = { createSaasServer };
if (require.main === module) {
  const host = process.env.SAAS_HOST || process.env.HOST || '127.0.0.1';
  const port = Number(process.env.SAAS_PORT || process.env.PORT || 4180);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('SAAS_PORT must be 1–65535'); process.exitCode = 1;
  } else {
    const development = !process.env.NODE_ENV || process.env.NODE_ENV === 'development';
    // Real SMTP is required unless a test explicitly opts into local capture.
    // Production continues to require HTTPS; bootstrap secrets stay in env.
    Promise.resolve().then(() => createSaasServer({
      publicOrigin: process.env.PUBLIC_ORIGIN || (development ? 'http://127.0.0.1:' + port : undefined),
      devMailDir: process.env.DEV_MAIL_DIR,
      initialAccount: initialAccountFromEnv(process.env)
    })).then(server => {
      server.on('error', async () => { console.error('SaaS listener failed'); process.exitCode = 1; await server.closeSaas(); });
      server.listen(port, host, () => console.log('SaaS listening on ' + host + ':' + port));
      for (const signal of ['SIGINT', 'SIGTERM']) { process.once(signal, () => { server.closeSaas().catch(() => { process.exitCode = 1; }); }); }
    }).catch(error => { console.error('SaaS startup failed: ' + error.message.replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[database URL redacted]')); process.exitCode = 1; });
  }
}
