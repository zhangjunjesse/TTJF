'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { DatabaseSync, backup: backupSqlite } = require('node:sqlite');

const PROJECT = fs.realpathSync(path.resolve(__dirname, '..'));
const JSON_COLUMNS = new Map([
  ['saas_users', new Set(['password_hash'])],
  ['saas_families', new Set(['state', 'parent'])],
  ['saas_action_receipts', new Set(['receipt'])],
  ['saas_parent_challenges', new Set(['action_receipt'])],
  ['saas_parent_grants', new Set(['action_receipt'])]
]);
const TRANSACTION_CONTROL = new Set(['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE']);

function within(value, parent) {
  const relative = path.relative(parent, value);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function directoryEntry(value) {
  try { return fs.lstatSync(value); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function privateLocation(value) {
  if (within(value, PROJECT) && !within(value, path.join(PROJECT, 'data'))) {
    throw new Error('SQLite files inside the repository must be under private data/, never assets or source files.');
  }
}
function resolveDatabasePath(value, { mustExist = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value === ':memory:' ||
      (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) || /^\.env(?:\.|$)/i.test(path.basename(value))) {
    throw new Error('SQLITE_FILE must be a private SQLite file path, not a database URL, .env file or in-memory database.');
  }
  const target = path.resolve(value);
  if (!path.isAbsolute(value) && !within(target, PROJECT)) {
    throw new Error('SQLite files outside the repository require an absolute private file path.');
  }
  privateLocation(target);
  let ancestor = target;
  let entry = directoryEntry(ancestor);
  while (!entry) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('SQLite destination has no accessible parent directory.');
    ancestor = parent;
    entry = directoryEntry(ancestor);
  }
  let actual;
  try { actual = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, target)); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('SQLite destination contains a dangling symbolic link. Choose an existing private directory.');
    throw error;
  }
  privateLocation(actual);
  const existing = directoryEntry(actual);
  if (existing && !existing.isFile()) throw new Error('SQLite destination must be a regular private file.');
  if (mustExist && !existing) throw new Error('SQLite database does not exist. Start the application once to initialize it, or select an existing SQLITE_FILE.');
  return actual;
}
function bindValue(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(+value)) throw new TypeError('Cannot bind an invalid date to SQLite.');
    return value.toISOString();
  }
  if (value === null || typeof value === 'string' || typeof value === 'bigint' || ArrayBuffer.isView(value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return Number(value);
  if (value && typeof value === 'object') return JSON.stringify(value);
  throw new TypeError('Unsupported SQLite parameter; use null explicitly for missing values.');
}
function bindings(params) {
  if (!Array.isArray(params)) throw new TypeError('SQLite query parameters must be an array.');
  return Object.fromEntries(params.map((value, index) => ['$' + (index + 1), bindValue(value)]));
}
function uncommentStart(sql) {
  return sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, '');
}
function assertManagedStatement(sql) {
  const keyword = /^[a-z]+/i.exec(uncommentStart(sql));
  if (keyword && TRANSACTION_CONTROL.has(keyword[0].toUpperCase())) {
    throw new Error('Use database.transaction(callback) to manage SQLite transactions.');
  }
}
function decodeRows(rows, columns) {
  return rows.map(row => {
    const result = { ...row };
    for (const column of columns) {
      const value = result[column.name];
      if (typeof value !== 'string') continue;
      const origin = column.column || column.name;
      if (JSON_COLUMNS.get(column.table)?.has(origin)) result[column.name] = JSON.parse(value);
      else if (origin.endsWith('_at')) {
        const date = new Date(value);
        if (!Number.isFinite(+date)) throw new Error('SQLite contains an invalid timestamp in ' + origin + '.');
        result[column.name] = date;
      }
    }
    return result;
  });
}

async function createDatabase({ databasePath, mustExist = false } = {}) {
  const target = resolveDatabasePath(databasePath, { mustExist });
  if (!mustExist) {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (!directoryEntry(target)) {
      const fd = fs.openSync(target, 'wx', 0o600);
      fs.closeSync(fd);
    }
  }
  let connection;
  try {
    connection = new DatabaseSync(target, { enableForeignKeyConstraints: true, timeout: 5000 });
    connection.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
  } catch (error) {
    if (connection && connection.isOpen) connection.close();
    throw new Error('Could not open the configured SQLite file. Check SQLITE_FILE, file permissions and whether it is a SQLite database.', { cause: error });
  }
  let tail = Promise.resolve();
  let closed = false;
  let closePromise;
  const scope = new AsyncLocalStorage();
  function assertOutsideTransaction() {
    if (scope.getStore()?.active) throw new Error('Use the supplied transaction client inside database.transaction(callback).');
  }
  function enqueue(operation) {
    assertOutsideTransaction();
    if (closePromise) return Promise.reject(new Error('SQLite database is closed.'));
    const result = tail.then(() => {
      if (closed) throw new Error('SQLite database is closed.');
      return operation();
    });
    tail = result.catch(() => {});
    return result;
  }
  function prepare(sql) {
    if (typeof sql !== 'string' || !uncommentStart(sql)) throw new TypeError('SQLite requires a nonempty SQL statement.');
    assertManagedStatement(sql);
    const statement = connection.prepare(sql);
    statement.setAllowBareNamedParameters(false);
    return statement;
  }
  function query(sql, params = []) {
    const statement = prepare(sql);
    if (uncommentStart(sql.slice(statement.sourceSQL.length))) throw new Error('query accepts one SQLite statement; use exec for SQL scripts.');
    const values = bindings(params);
    const columns = statement.columns();
    if (columns.length) {
      const rows = decodeRows(statement.all(values), columns);
      return { rows, rowCount: rows.length };
    }
    const result = statement.run(values);
    return { rows: [], rowCount: Number(result.changes) };
  }
  function exec(sql) {
    if (typeof sql !== 'string') throw new TypeError('SQLite requires a SQL script.');
    let remaining = sql;
    while (uncommentStart(remaining)) {
      const statement = prepare(remaining);
      statement.run();
      remaining = remaining.slice(statement.sourceSQL.length);
    }
  }
  const database = {
    databasePath: target,
    async query(sql, params) { return enqueue(() => query(sql, params)); },
    async exec(sql) { return enqueue(() => exec(sql)); },
    async transaction(fn) {
      if (typeof fn !== 'function') throw new TypeError('SQLite transaction requires a callback.');
      return enqueue(async () => {
        connection.exec('BEGIN IMMEDIATE');
        const token = { active: true, aborted: false };
        function active() {
          if (!token.active) throw new Error('SQLite transaction client is no longer active.');
          // ON CONFLICT ROLLBACK, RAISE(ROLLBACK) and some I/O failures end
          // SQLite's transaction even if the callback catches their errors.
          // Never let the remaining callback writes become autocommits.
          if (token.aborted || !connection.isTransaction) {
            token.aborted = true;
            throw new Error('SQLite transaction was rolled back and is no longer usable.');
          }
        }
        function execute(operation) {
          active();
          try { return operation(); }
          finally { if (!connection.isTransaction) token.aborted = true; }
        }
        const client = Object.freeze({
          async query(sql, params) { return execute(() => query(sql, params)); },
          async exec(sql) { return execute(() => exec(sql)); }
        });
        try {
          const value = await scope.run(token, () => fn(client));
          active();
          connection.exec('COMMIT');
          return value;
        } catch (error) {
          try { if (connection.isTransaction) connection.exec('ROLLBACK'); } catch (_) { /* preserve the original failure */ }
          throw error;
        } finally { token.active = false; }
      });
    },
    async backup(destination) {
      return enqueue(async () => {
        const output = resolveDatabasePath(destination);
        if (directoryEntry(output)) throw new Error('SQLite backup destination already exists; refusing to overwrite.');
        fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
        const fd = fs.openSync(output, 'wx', 0o600);
        fs.closeSync(fd);
        try {
          const pages = await backupSqlite(connection, output);
          // Windows FlushFileBuffers requires a handle opened for writing.
          const backupFd = fs.openSync(output, 'r+');
          try { fs.fsyncSync(backupFd); } finally { fs.closeSync(backupFd); }
          return { databasePath: output, pages };
        } catch (error) {
          fs.unlinkSync(output);
          throw error;
        }
      });
    },
    async close() {
      assertOutsideTransaction();
      if (!closePromise) {
        closePromise = tail.then(() => { connection.close(); closed = true; });
        tail = closePromise.catch(() => {});
      }
      return closePromise;
    }
  };
  return Object.freeze(database);
}

module.exports = { createDatabase, resolveDatabasePath };
