'use strict';
const fs = require('node:fs');
const path = require('node:path');
const S = require('./security.cjs');

async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(1329434013, 13)");
    await client.query(fs.readFileSync(path.join(__dirname, 'migrations', '001-initial.sql'), 'utf8'));
    const applied = await client.query('SELECT 1 FROM saas_schema_migrations WHERE version=2');
    if (!applied.rowCount) { await client.query(fs.readFileSync(path.join(__dirname, 'migrations', '002-lifecycle.sql'), 'utf8')); }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function createStore(options = {}) {
  const ownsPool = !options.pool;
  const connectionString = options.databaseUrl || process.env.DATABASE_URL;
  if (ownsPool && !connectionString) { throw new Error('SaaS requires DATABASE_URL'); }
  const pool = options.pool || new (require('pg').Pool)({ connectionString, max: 10,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, statement_timeout: 20000 });
  // Idle socket errors must not crash the process; requests still fail closed.
  const onPoolError = () => {};
  if (ownsPool) { pool.on('error', onPoolError); }
  try { if (options.migrate !== false) { await migrate(pool); } else { await pool.query('SELECT 1'); } }
  catch (error) { if (ownsPool) { await pool.end(); } throw error; }
  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) { /* preserve original failure */ }
      throw error;
    } finally { client.release(); }
  }
  async function rate(scope, maximum, windowMs, at, queryable = pool) {
    const sampled = new Date(at);
    // Single UPSERT serializes a shared fixed window on every instance.
    const { rows } = await queryable.query(`INSERT INTO saas_rate_limits(scope,count,expires_at) VALUES($1,1,$2)
      ON CONFLICT(scope) DO UPDATE SET
        count=CASE WHEN saas_rate_limits.expires_at <= $3 THEN 1 ELSE LEAST(saas_rate_limits.count+1,1000000) END,
        expires_at=CASE WHEN saas_rate_limits.expires_at <= $3 THEN $2 ELSE saas_rate_limits.expires_at END
      RETURNING count, expires_at`, [S.digest(scope), new Date(+sampled + windowMs), sampled]);
    return { allowed: rows[0].count <= maximum, until: rows[0].expires_at };
  }
  // Order for authenticated operations: user -> session -> family -> membership.
  // Password changes lock user exclusively; member removal locks the family.
  // Cross-user lifecycle operations lock every involved user in UUID order
  // before acquiring any session/family lock (including the actor's).
  async function authenticate(client, rawToken, at, { verified = false, csrfToken, userLock = false, relatedUserIds = [] } = {}) {
    if (typeof rawToken !== 'string' || !S.TOKEN.test(rawToken)) { S.fail(401, 'AUTH_REQUIRED', '请先登录'); }
    const hash = S.digest(rawToken);
    const lookup = await client.query('SELECT user_id FROM saas_sessions WHERE token_hash=$1', [hash]);
    if (!lookup.rowCount) { S.fail(401, 'AUTH_REQUIRED', '登录已失效，请重新登录'); }
    const actorId = lookup.rows[0].user_id;
    const ids = [...new Set([actorId, ...relatedUserIds])].sort();
    if (ids.some(id => typeof id !== 'string' || !S.UUID.test(id))) { throw new Error('Invalid internal user lock set'); }
    const users = (await client.query('SELECT * FROM saas_users WHERE id=ANY($1::uuid[]) ORDER BY id FOR ' +
      (userLock || relatedUserIds.length ? 'UPDATE' : 'SHARE'), [ids])).rows;
    const user = users.find(row => row.id === actorId);
    const session = (await client.query('SELECT * FROM saas_sessions WHERE token_hash=$1 FOR SHARE', [hash])).rows[0];
    if (!user || !session || session.revoked_at || +session.expires_at <= +new Date(at)) {
      S.fail(401, 'AUTH_REQUIRED', '登录已失效，请重新登录');
    }
    if (csrfToken !== undefined && (typeof csrfToken !== 'string' || !S.equal(S.digest(csrfToken), session.csrf_hash))) {
      S.fail(403, 'CSRF_INVALID', '页面已过期，请刷新后重试');
    }
    if (verified && !user.verified_at) { S.fail(403, 'EMAIL_UNVERIFIED', '请先验证邮箱'); }
    return { user, session, rawToken };
  }
  async function family(client, identity, familyId, { owner = false } = {}) {
    if (typeof familyId !== 'string' || !S.UUID.test(familyId)) { S.fail(400, 'FAMILY_REQUIRED', '请选择家庭'); }
    // Deny outsiders before reading or locking another family's aggregate.
    const preliminary = await client.query('SELECT 1 FROM saas_memberships WHERE family_id=$1 AND user_id=$2', [familyId, identity.user.id]);
    if (!preliminary.rowCount) { S.fail(403, 'FAMILY_FORBIDDEN', '无权访问此家庭'); }
    const row = (await client.query('SELECT * FROM saas_families WHERE id=$1 FOR UPDATE', [familyId])).rows[0];
    const member = (await client.query('SELECT role FROM saas_memberships WHERE family_id=$1 AND user_id=$2 FOR SHARE',
      [familyId, identity.user.id])).rows[0];
    if (!row || !member) { S.fail(403, 'FAMILY_FORBIDDEN', '无权访问此家庭'); }
    if (owner && member.role !== 'owner') { S.fail(403, 'OWNER_REQUIRED', '仅家庭所有者可执行此操作'); }
    row.revision = Number(row.revision);
    return { ...row, role: member.role };
  }
  let closed = false;
  return { pool, transaction, authenticate, family, rate,
    async close() { if (!closed && ownsPool) { closed = true; await pool.end(); } } };
}
module.exports = { createStore, migrate };
