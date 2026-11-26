'use strict';
const fs = require('node:fs');
const path = require('node:path');
const S = require('./security.cjs');
const { createDatabase } = require('./sqlite.cjs');

const MIGRATIONS = ['001-initial.sql', '002-lifecycle.sql', '003-assistant-chat.sql', '004-parent-devices.sql', '005-award-photos.sql'];
const REQUIRED_COLUMNS = {
  saas_schema_migrations: ['version', 'applied_at'],
  saas_users: ['id', 'email', 'password_hash', 'verified_at', 'created_at'],
  saas_sessions: ['token_hash', 'user_id', 'csrf_hash', 'created_at', 'expires_at', 'revoked_at'],
  saas_email_tokens: ['token_hash', 'user_id', 'purpose', 'created_at', 'expires_at', 'consumed_at'],
  saas_families: ['id', 'name', 'revision', 'state', 'parent', 'owner_user_id', 'owner_role', 'created_at', 'updated_at'],
  saas_memberships: ['family_id', 'user_id', 'role', 'created_at'],
  saas_family_requests: ['user_id', 'request_id', 'digest', 'family_id'],
  saas_invitations: ['id', 'family_id', 'email', 'role', 'token_hash', 'invited_by', 'created_at', 'expires_at', 'consumed_at', 'revoked_at'],
  saas_family_imports: ['family_id', 'source_sha256', 'source_revision', 'imported_at'],
  saas_action_receipts: ['family_id', 'action_id', 'receipt', 'revision', 'created_at'],
  saas_parent_challenges: ['token_hash', 'family_id', 'user_id', 'session_hash', 'revision', 'action_receipt', 'method', 'answer_hash', 'attempts', 'expires_at'],
  saas_parent_grants: ['token_hash', 'family_id', 'user_id', 'session_hash', 'revision', 'action_receipt', 'expires_at'],
  saas_parent_devices: ['session_hash', 'family_id', 'user_id', 'created_at'],
  saas_assistant_leases: ['id', 'family_id', 'user_id', 'session_hash', 'expires_at'],
  saas_assistant_chats: ['family_id', 'user_id', 'generation', 'sequence', 'draft', 'context_result', 'pending_turn_id', 'pending_expires_at', 'created_at', 'updated_at'],
  saas_assistant_turns: ['family_id', 'user_id', 'generation', 'turn_id', 'sequence', 'input_digest', 'text', 'context', 'result', 'actions', 'source_revision', 'family_day', 'created_at', 'completed_at', 'failed_at', 'failure_code'],
  saas_award_photos: ['family_id', 'id', 'uploaded_by', 'data', 'action_id', 'created_at', 'expires_at', 'committed_at'],
  saas_award_photo_discards: ['family_id', 'id', 'uploaded_by', 'expires_at'],
  saas_rate_limits: ['scope', 'count', 'expires_at']
};
const TABLE_VERSION = { saas_assistant_chats: 3, saas_assistant_turns: 3, saas_parent_devices: 4, saas_award_photos: 5, saas_award_photo_discards: 5 };
async function assertDatabaseSchema(database, { allowOlder = false } = {}) {
  const names = new Set((await database.query("SELECT name FROM sqlite_schema WHERE type='table'")).rows.map(row => row.name));
  if (!names.has('saas_schema_migrations')) throw new Error('SQLite schema is missing or incomplete. Start the application once to initialize it, or select a complete existing SQLite database.');
  const versions = (await database.query('SELECT version FROM saas_schema_migrations ORDER BY version')).rows.map(row => row.version);
  if (!versions.length || versions.length > MIGRATIONS.length || (!allowOlder && versions.length !== MIGRATIONS.length) || versions.some((version, index) => version !== index + 1)) {
    throw new Error('SQLite schema version is unsupported. Use the matching application version or select a compatible existing SQLite database.');
  }
  const requiredTables = Object.entries(REQUIRED_COLUMNS).filter(([table]) => (TABLE_VERSION[table] || 1) <= versions.length);
  if (requiredTables.some(([name]) => !names.has(name))) throw new Error('SQLite schema is missing or incomplete. Start the application once to initialize it, or select a complete existing SQLite database.');
  for (const [table, required] of requiredTables) {
    const columns = new Set((await database.query('PRAGMA table_info(' + table + ')')).rows.map(row => row.name));
    if (required.some(column => !columns.has(column))) throw new Error('SQLite schema is missing required columns in ' + table + '. Use a complete matching backup.');
  }
  if ((await database.query('PRAGMA foreign_key_check')).rowCount) throw new Error('SQLite database contains broken foreign key relationships. Restore a consistent private backup.');
}
async function migrate(database) {
  await database.transaction(async client => {
    const tables = (await client.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")).rows;
    if (tables.length && !tables.some(row => row.name === 'saas_schema_migrations')) {
      throw new Error('The selected SQLite file contains another schema. Choose a new private SQLITE_FILE; no data was changed.');
    }
    await client.exec(`CREATE TABLE IF NOT EXISTS saas_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ) STRICT;`);
    const versions = (await client.query('SELECT version FROM saas_schema_migrations ORDER BY version')).rows.map(row => row.version);
    if (versions.some((version, index) => version !== index + 1 || version > MIGRATIONS.length)) {
      throw new Error('SQLite schema version is unsupported. Use the application version that created this database.');
    }
    for (let index = versions.length; index < MIGRATIONS.length; index++) {
      await client.exec(fs.readFileSync(path.join(__dirname, 'migrations', MIGRATIONS[index]), 'utf8'));
    }
  });
  await assertDatabaseSchema(database);
}
async function createStore(options = {}) {
  const ownsDatabase = !options.database;
  if (options.pool) throw new Error('PostgreSQL pools are no longer supported. Supply database or databasePath for SQLite.');
  if (options.databaseUrl || process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL belongs to the former PostgreSQL backend. Preserve the old database and remove DATABASE_URL before selecting a private SQLITE_FILE; PostgreSQL data is not migrated automatically.');
  }
  const database = options.database || await createDatabase({
    databasePath: options.databasePath ?? (process.env.SQLITE_FILE || path.resolve(__dirname, '..', 'data', 'ttjf.sqlite')),
    mustExist: options.migrate === false
  });
  try {
    if (options.migrate !== false) await migrate(database);
    else await assertDatabaseSchema(database);
  } catch (error) { if (ownsDatabase) await database.close(); throw error; }
  async function rate(scope, maximum, windowMs, at, queryable = database) {
    const sampled = new Date(at);
    const { rows } = await queryable.query(`INSERT INTO saas_rate_limits(scope,count,expires_at) VALUES($1,1,$2)
      ON CONFLICT(scope) DO UPDATE SET
        count=CASE WHEN saas_rate_limits.expires_at <= $3 THEN 1 ELSE MIN(saas_rate_limits.count+1,1000000) END,
        expires_at=CASE WHEN saas_rate_limits.expires_at <= $3 THEN $2 ELSE saas_rate_limits.expires_at END
      RETURNING count, expires_at`, [S.digest(scope), new Date(+sampled + windowMs), sampled]);
    return { allowed: rows[0].count <= maximum, until: rows[0].expires_at };
  }
  // BEGIN IMMEDIATE reserves the writer before authenticated reads. Every
  // operation uses this same serialized connection instead of row locks.
  async function authenticate(client, rawToken, at, { verified = false, csrfToken, relatedUserIds = [] } = {}) {
    if (typeof rawToken !== 'string' || !S.TOKEN.test(rawToken)) S.fail(401, 'AUTH_REQUIRED', '请先登录');
    const hash = S.digest(rawToken);
    const lookup = await client.query('SELECT user_id FROM saas_sessions WHERE token_hash=$1', [hash]);
    if (!lookup.rowCount) S.fail(401, 'AUTH_REQUIRED', '登录已失效，请重新登录');
    const actorId = lookup.rows[0].user_id;
    const ids = [...new Set([actorId, ...relatedUserIds])].sort();
    if (ids.some(id => typeof id !== 'string' || !S.UUID.test(id))) throw new Error('Invalid internal user set');
    const users = (await client.query('SELECT * FROM saas_users WHERE id IN (' + ids.map((_, i) => '$' + (i + 1)).join(',') + ') ORDER BY id', ids)).rows;
    const user = users.find(row => row.id === actorId);
    const session = (await client.query('SELECT * FROM saas_sessions WHERE token_hash=$1', [hash])).rows[0];
    if (!user || !session || session.revoked_at || +session.expires_at <= +new Date(at)) S.fail(401, 'AUTH_REQUIRED', '登录已失效，请重新登录');
    if (csrfToken !== undefined && (typeof csrfToken !== 'string' || !S.equal(S.digest(csrfToken), session.csrf_hash))) S.fail(403, 'CSRF_INVALID', '页面已过期，请刷新后重试');
    if (verified && !user.verified_at) S.fail(403, 'EMAIL_UNVERIFIED', '请先验证邮箱');
    return { user, session, rawToken };
  }
  async function family(client, identity, familyId, { owner = false } = {}) {
    if (typeof familyId !== 'string' || !S.UUID.test(familyId)) S.fail(400, 'FAMILY_REQUIRED', '请选择家庭');
    const preliminary = await client.query('SELECT 1 FROM saas_memberships WHERE family_id=$1 AND user_id=$2', [familyId, identity.user.id]);
    if (!preliminary.rowCount) S.fail(403, 'FAMILY_FORBIDDEN', '无权访问此家庭');
    const row = (await client.query('SELECT * FROM saas_families WHERE id=$1', [familyId])).rows[0];
    const member = (await client.query('SELECT role FROM saas_memberships WHERE family_id=$1 AND user_id=$2', [familyId, identity.user.id])).rows[0];
    if (!row || !member) S.fail(403, 'FAMILY_FORBIDDEN', '无权访问此家庭');
    if (owner && member.role !== 'owner') S.fail(403, 'OWNER_REQUIRED', '仅家庭所有者可执行此操作');
    row.revision = Number(row.revision);
    return { ...row, role: member.role };
  }
  let closed = false;
  return { database, transaction: fn => database.transaction(fn), authenticate, family, rate,
    async close() { if (!closed && ownsDatabase) { closed = true; await database.close(); } } };
}
module.exports = { createStore, migrate, assertDatabaseSchema };
