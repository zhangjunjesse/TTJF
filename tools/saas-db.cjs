'use strict';
// Operator-only whole-database snapshots. HTTP routes never expose this tool.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const { DatabaseSync, backup } = require('node:sqlite');
const { createDatabase, resolveDatabasePath } = require('../saas/sqlite.cjs');
const { createStore, assertDatabaseSchema, migrate } = require('../saas/store.cjs');
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function existsEntry(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function validateDatabase(database, { allowOlder = false } = {}) {
  const integrity = (await database.query('PRAGMA integrity_check')).rows;
  requireValue(integrity.length === 1 && Object.values(integrity[0])[0] === 'ok', 'SQLite integrity_check failed; nothing was restored.');
  const foreignKeys = (await database.query('PRAGMA foreign_key_check')).rows;
  requireValue(foreignKeys.length === 0, 'SQLite foreign_key_check failed; nothing was restored.');
  await assertDatabaseSchema(database, { allowOlder });
  const triggers = (await database.query("SELECT name FROM sqlite_schema WHERE type='trigger'")).rows;
  requireValue(triggers.length === 0, 'SQLite database contains unrecognized triggers. This application schema has no triggers; backup or restore was refused.');
}
function readonlyDatabase(file) {
  const connection = new DatabaseSync(file, { readOnly: true });
  return { connection, async query(sql) { const rows = connection.prepare(sql).all(); return { rows, rowCount: rows.length }; }, async close() { connection.close(); } };
}
async function backupDatabase({ databasePath, output }) {
  requireValue(typeof output === 'string' && output.trim(), 'An explicit private --output destination is required.');
  const target = resolveDatabasePath(output);
  requireValue(!existsEntry(target), 'Backup destination already exists; refusing to overwrite.');
  const store = await createStore({ databasePath, migrate: false });
  try {
    await validateDatabase(store.database);
    await store.database.backup(target);
    const snapshot = readonlyDatabase(target);
    try { await validateDatabase(snapshot); }
    finally { await snapshot.close(); }
    return { mode: 'backup', databasePath: store.database.databasePath, output: target, bytes: fs.statSync(target).size };
  } finally { await store.close(); }
}
async function restoreDatabase({ source, output, appStopped = false }) {
  requireValue(appStopped === true, 'Stop every application process before restore, then pass --app-stopped. Restore always requires a new unused database path.');
  requireValue(typeof source === 'string' && source.trim(), 'An explicit --source backup file is required.');
  requireValue(typeof output === 'string' && output.trim(), 'An explicit private --output destination is required.');
  const input = resolveDatabasePath(source, { mustExist: true });
  const target = resolveDatabasePath(output);
  requireValue(!existsEntry(target), 'Restore destination already exists; refusing to overwrite. Use a new path.');
  const snapshot = readonlyDatabase(input);
  let stage, stageCreated = false;
  try {
    // Validate the source without provisioning schema or modifying backup bytes.
    await validateDatabase(snapshot, { allowOlder: true });
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    stage = target + '.restore-' + crypto.randomBytes(12).toString('hex');
    const stageDescriptor = fs.openSync(stage, 'wx', 0o600);
    stageCreated = true;
    fs.closeSync(stageDescriptor);
    // SQLite's backup API captures one consistent database, including live pages.
    await backup(snapshot.connection, stage);
    fs.chmodSync(stage, 0o600);
    const database = await createDatabase({ databasePath: stage, mustExist: true });
    try {
      // Older supported backups are upgraded only in the private staging copy;
      // the source remains read-only and can still be restored by its old app.
      await migrate(database);
      await database.transaction(async client => {
        // Pending provider work cannot survive an offline restore. Preserve
        // completed conversation history while releasing the interrupted turn.
        await client.query("UPDATE saas_assistant_turns SET failed_at=$1,failure_code='ASSISTANT_INTERRUPTED' WHERE completed_at IS NULL AND failed_at IS NULL", [new Date()]);
        await client.query('UPDATE saas_assistant_chats SET pending_turn_id=NULL,pending_expires_at=NULL');
        await client.query('DELETE FROM saas_award_photos WHERE action_id IS NULL');
        for (const table of ['saas_assistant_leases', 'saas_parent_grants', 'saas_parent_challenges', 'saas_sessions', 'saas_email_tokens', 'saas_invitations']) {
          await client.query('DELETE FROM ' + table);
        }
      });
      await validateDatabase(database);
    } finally { await database.close(); }
    const descriptor = fs.openSync(stage, 'r+');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    // Hard-link publication is atomic and cannot replace an existing directory entry.
    fs.linkSync(stage, target);
    return { mode: 'restored', source: input, output: target, bytes: fs.statSync(target).size, credentialsInvalidated: true,
      nextStep: 'Set SQLITE_FILE to the restored path before starting one application process. Every account must log in again.' };
  } finally {
    await snapshot.close();
    if (stageCreated && existsEntry(stage)) fs.unlinkSync(stage);
  }
}
async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    source: { type: 'string' }, output: { type: 'string' }, 'app-stopped': { type: 'boolean', default: false }, help: { type: 'boolean' }
  } });
  if (values.help) {
    console.log('Private SQLite operator commands:\n  backup --output PRIVATE_FILE  (source: SQLITE_FILE)\n  restore --source BACKUP --output NEW_PRIVATE_FILE --app-stopped\nStop every application process before restore. Existing output files are never overwritten. Restore invalidates old sessions, email tokens, invitations and temporary authorizations.');
    return;
  }
  requireValue(positionals.length === 1 && ['backup', 'restore'].includes(positionals[0]), 'Choose backup or restore; use --help for syntax.');
  if (positionals[0] === 'backup') requireValue(!values.source && !values['app-stopped'], 'Backup uses SQLITE_FILE and does not accept --source or --app-stopped.');
  const result = positionals[0] === 'backup' ? await backupDatabase({ output: values.output }) :
    await restoreDatabase({ source: values.source, output: values.output, appStopped: values['app-stopped'] });
  console.log(JSON.stringify(result, null, 2));
}
module.exports = { backupDatabase, restoreDatabase, validateDatabase };
if (require.main === module) main().catch(error => {
  console.error(String(error.message).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[database URL redacted]'));
  process.exitCode = 1;
});
