'use strict';
// Local-only development setup. It never opens a legacy family record.
const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('../saas/store.cjs');
const root = path.resolve(__dirname, '..');
const envFile = path.join(root, '.env.saas.local');
function init() {
  if (fs.existsSync(envFile)) {
    console.log('Local environment already exists; settings were not changed.');
    return;
  }
  const legacy = ['.env.saas.test', '.env.saas.postgres'].filter(name => fs.existsSync(path.join(root, name)));
  if (legacy.length) throw new Error('Previous PostgreSQL environment files exist. Archive them explicitly before initializing SQLite; no existing settings were changed.');
  const content = 'NODE_ENV=development\nHOST=127.0.0.1\nPORT=4180\nPUBLIC_ORIGIN=http://127.0.0.1:4180\nTZ=Asia/Shanghai\nSQLITE_FILE=data/ttjf.sqlite\nDEV_MAIL_DIR=data/saas-mail\nMAIL_FROM=小小向前 <no-reply@ttjf.local>\n';
  fs.writeFileSync(envFile, content, { flag: 'wx', mode: 0o600 });
  console.log('Created private .env.saas.local for SQLite and local file mail. No database service is required.');
}
async function bootstrap() {
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const store = await createStore();
  try {
    const version = (await store.database.query('SELECT sqlite_version() AS version')).rows[0].version;
    console.log(JSON.stringify({ ready: true, storage: 'sqlite', databasePath: store.database.databasePath, version }));
  } finally { await store.close(); }
}
async function main() {
  if (process.argv[2] === 'init') return init();
  if (process.argv[2] === 'bootstrap') return bootstrap();
  throw new Error('Usage: node tools/saas-local.cjs init | bootstrap');
}
module.exports = { init, bootstrap };
if (require.main === module) main().catch(error => {
  console.error('Local SaaS setup failed: ' + error.message.replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[database URL redacted]'));
  process.exitCode = 1;
});
