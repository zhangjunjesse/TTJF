'use strict';
const crypto = require('node:crypto');
const S = require('./security.cjs');
const { emailMessage } = require('./mail.cjs');
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;

function createAuth({ store, mail, now, publicOrigin, cookieName, secureCookie, reportError }) {
  const at = () => new Date(now());
  const userView = user => ({ id: user.id, email: user.email, verified: !!user.verified_at });
  const cookie = raw => cookieName + '=' + raw + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' +
    (raw ? Math.floor(SESSION_MS / 1000) : 0) + (secureCookie ? '; Secure' : '');
  async function limit(ctx, kind, addressMaximum = 30, targetEmail) {
    const scopes = [[kind + ':ip:' + ctx.address, addressMaximum]];
    if (targetEmail) { scopes.push([kind + ':email:' + targetEmail, 10]); }
    for (const [scope, maximum] of scopes) {
      const result = await store.rate(scope, maximum, 15 * 60000, at());
      if (!result.allowed) {
        const error = new S.HttpError(429, 'RATE_LIMITED', '尝试次数较多，请稍后再试');
        error.retryAfter = Math.max(1, Math.ceil((+result.until - +at()) / 1000)); throw error;
      }
    }
  }
  async function identity(client, ctx, options = {}) {
    const result = await store.authenticate(client, ctx.rawToken, at(), {
      csrfToken: ctx.write ? (ctx.csrfToken || '') : undefined, ...options
    });
    ctx.userId = result.user.id;
    return result;
  }
  async function sessionView(client, who) {
    const families = who.user.verified_at ? (await client.query(`SELECT f.id, f.name, m.role
      FROM saas_memberships m JOIN saas_families f ON f.id=m.family_id WHERE m.user_id=$1 ORDER BY f.created_at, f.id`, [who.user.id])).rows : [];
    return { authenticated: true, user: userView(who.user), families, csrfToken: S.csrf(who.rawToken) };
  }
  async function session(ctx) {
    if (!ctx.rawToken) { return { status: 200, body: { authenticated: false } }; }
    try { return await store.transaction(async client => ({ status: 200, body: await sessionView(client, await identity(client, ctx)) })); }
    catch (error) {
      if (error.status === 401) { return { status: 200, body: { authenticated: false }, headers: { 'Set-Cookie': cookie('') } }; }
      throw error;
    }
  }
  async function issueToken(client, user, purpose) {
    const raw = S.token();
    const sampled = at();
    await client.query('UPDATE saas_email_tokens SET consumed_at=$3 WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL', [user.id, purpose, sampled]);
    await client.query(`INSERT INTO saas_email_tokens(token_hash,user_id,purpose,created_at,expires_at) VALUES($1,$2,$3,$4,$5)`,
      [S.digest(raw), user.id, purpose, sampled, new Date(+sampled + (purpose === 'reset' ? 30 * 60000 : 24 * 3600000))]);
    return { user, purpose, raw };
  }
  async function deliver(delivery) {
    if (!delivery) { return; }
    try { await mail.send(emailMessage(delivery.user.email, delivery.purpose, delivery.raw, publicOrigin)); }
    catch (error) {
      // Keep account-existence responses uniform even when SMTP is down. A resend
      // can recover, and operators get a redacted delivery error, never a token.
      await store.database.query('DELETE FROM saas_email_tokens WHERE token_hash=$1 AND consumed_at IS NULL', [S.digest(delivery.raw)]);
      reportError('MAIL_DELIVERY_FAILED');
    }
  }
  async function register(ctx, body) {
    const email = S.email(body.email), password = S.password(body.password);
    await limit(ctx, 'register', 20, email);
    const hash = await S.hashPassword(password);
    const delivery = await store.transaction(async client => {
      const result = await client.query(`INSERT INTO saas_users(id,email,password_hash,created_at) VALUES($1,$2,$3,$4)
        ON CONFLICT(email) DO NOTHING RETURNING *`, [crypto.randomUUID(), email, hash, at()]);
      return result.rowCount ? issueToken(client, result.rows[0], 'verify') : null;
    });
    await deliver(delivery);
    return { status: 202, body: { ok: true } };
  }
  async function requestEmail(ctx, body, purpose) {
    const email = S.email(body.email);
    await limit(ctx, purpose === 'reset' ? 'forgot' : 'resend', 20, email);
    const delivery = await store.transaction(async client => {
      const user = (await client.query('SELECT * FROM saas_users WHERE email=$1', [email])).rows[0];
      return user && (purpose === 'reset' || !user.verified_at) ? issueToken(client, user, purpose) : null;
    });
    await deliver(delivery);
    return { status: 202, body: { ok: true } };
  }
  async function consumeEmail(ctx, body, purpose) {
    await limit(ctx, 'consume-' + purpose, 30);
    if (typeof body.token !== 'string' || !S.TOKEN.test(body.token)) { S.fail(400, 'TOKEN_INVALID', '链接无效或已使用'); }
    const newHash = purpose === 'reset' ? await S.hashPassword(S.password(body.password)) : null;
    return store.transaction(async client => {
      const tokenHash = S.digest(body.token);
      const entry = (await client.query('SELECT * FROM saas_email_tokens WHERE token_hash=$1 AND purpose=$2', [tokenHash, purpose])).rows[0];
      if (!entry || entry.consumed_at) { S.fail(400, 'TOKEN_INVALID', '链接无效或已使用'); }
      if (+entry.expires_at <= +at()) { S.fail(410, 'TOKEN_EXPIRED', '链接已过期，请重新申请'); }
      const sampled = at();
      await client.query('UPDATE saas_email_tokens SET consumed_at=$2 WHERE token_hash=$1', [tokenHash, sampled]);
      if (purpose === 'verify') {
        await client.query('UPDATE saas_users SET verified_at=COALESCE(verified_at,$2) WHERE id=$1', [entry.user_id, sampled]);
      } else {
        await client.query('UPDATE saas_users SET password_hash=$2 WHERE id=$1', [entry.user_id, newHash]);
        await client.query('UPDATE saas_sessions SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL', [entry.user_id, sampled]);
        await client.query("UPDATE saas_email_tokens SET consumed_at=$2 WHERE user_id=$1 AND purpose='reset' AND consumed_at IS NULL", [entry.user_id, sampled]);
      }
      return { status: 200, body: { ok: true } };
    });
  }
  async function login(ctx, body) {
    const email = S.email(body.email);
    await limit(ctx, 'login', 50, email);
    const password = typeof body.password === 'string' && body.password.length <= 128 ? body.password : '';
    return store.transaction(async client => {
      const user = (await client.query('SELECT * FROM saas_users WHERE email=$1', [email])).rows[0];
      // Unknown addresses still perform the same expensive password derivation.
      const record = user ? user.password_hash : { algorithm: 'scrypt', n: 32768, salt: '00000000000000000000000000000000', digest: '0'.repeat(64) };
      const valid = await S.checkPassword(password, record);
      if (!user || !valid) { S.fail(401, 'INVALID_CREDENTIALS', '邮箱或密码不正确'); }
      const rawToken = S.token(), sampled = at();
      await client.query(`INSERT INTO saas_sessions(token_hash,user_id,csrf_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5)`,
        [S.digest(rawToken), user.id, S.digest(S.csrf(rawToken)), sampled, new Date(+sampled + SESSION_MS)]);
      return { status: 200, body: await sessionView(client, { user, rawToken }), headers: { 'Set-Cookie': cookie(rawToken) } };
    });
  }
  async function logout(ctx) {
    return store.transaction(async client => {
      const who = await identity(client, ctx);
      await client.query('UPDATE saas_sessions SET revoked_at=$2 WHERE token_hash=$1', [who.session.token_hash, at()]);
      return { status: 200, body: { ok: true }, headers: { 'Set-Cookie': cookie('') } };
    });
  }
  async function changePassword(ctx, body) {
    await limit(ctx, 'change-password', 20);
    const newHash = await S.hashPassword(S.password(body.password));
    return store.transaction(async client => {
      const who = await identity(client, ctx);
      if (typeof body.currentPassword !== 'string' || body.currentPassword.length > 128 ||
          !await S.checkPassword(body.currentPassword, who.user.password_hash)) { S.fail(403, 'PASSWORD_INVALID', '当前密码不正确'); }
      await client.query('UPDATE saas_users SET password_hash=$2 WHERE id=$1', [who.user.id, newHash]);
      await client.query('UPDATE saas_sessions SET revoked_at=$3 WHERE user_id=$1 AND token_hash<>$2 AND revoked_at IS NULL', [who.user.id, who.session.token_hash, at()]);
      await client.query("UPDATE saas_email_tokens SET consumed_at=$2 WHERE user_id=$1 AND purpose='reset' AND consumed_at IS NULL", [who.user.id, at()]);
      // Revoke outstanding one-use confirmations, including those in this session.
      await client.query('DELETE FROM saas_parent_grants WHERE user_id=$1', [who.user.id]);
      await client.query('DELETE FROM saas_parent_challenges WHERE user_id=$1', [who.user.id]);
      return { status: 200, body: { ok: true } };
    });
  }
  return { identity, session, register, login, logout, changePassword, requestEmail, consumeEmail, limit, clearCookie: () => cookie('') };
}
module.exports = { createAuth };
