'use strict';
// Local-only development setup. It never loads or edits a legacy family record.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const root = path.resolve(__dirname, '..');
const files = ['.env.saas.local', '.env.saas.test', '.env.saas.postgres'].map(name => path.join(root, name));
function load(file) {
  const result = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (match) result[match[1]] = match[2];
  }
  return result;
}
function init() {
  const existing = files.filter(file => fs.existsSync(file));
  if (existing.length) {
    if (existing.length !== files.length) throw new Error('Local environment is incomplete; refusing to replace existing credentials.');
    console.log('Local environment already exists; credentials were not changed.');
    return;
  }
  const password = crypto.randomBytes(32).toString('base64url');
  const adminPassword = crypto.randomBytes(32).toString('base64url');
  const database = `postgresql://ttjf_app:${password}@127.0.0.1:55432/ttjf_saas`;
  const testDatabase = database + '_test';
  const common = 'NODE_ENV=development\nHOST=127.0.0.1\nPORT=4180\nPUBLIC_ORIGIN=http://127.0.0.1:4180\nTZ=Asia/Shanghai\n';
  fs.writeFileSync(files[0], common + `DATABASE_URL=${database}\nTEST_DATABASE_URL=${testDatabase}\nDEV_MAIL_DIR=data/saas-mail\nMAIL_FROM=小小向前 <no-reply@ttjf.local>\n`, {flag:'wx',mode:0o600});
  fs.writeFileSync(files[1], `NODE_ENV=test\nTZ=Asia/Shanghai\nDATABASE_URL=${testDatabase}\nTEST_DATABASE_URL=${testDatabase}\n`, {flag:'wx',mode:0o600});
  fs.writeFileSync(files[2], `POSTGRES_USER=ttjf_admin\nPOSTGRES_PASSWORD=${adminPassword}\nPOSTGRES_DB=ttjf_saas\n`, {flag:'wx',mode:0o600});
  console.log('Created three Git-ignored local environment files with random credentials.');
}
async function bootstrap() {
  const local = load(files[0]);
  const admin = load(files[2]);
  const address = new URL(local.DATABASE_URL);
  if (address.hostname !== '127.0.0.1' || address.port !== '55432' || address.pathname !== '/ttjf_saas' || address.username !== 'ttjf_app') throw new Error('Refusing bootstrap outside the dedicated local development database.');
  const appPassword = decodeURIComponent(address.password);
  address.username = admin.POSTGRES_USER;
  address.password = admin.POSTGRES_PASSWORD;
  const client = new Client({connectionString:address.toString(),connectionTimeoutMillis:5000});
  await client.connect();
  try {
    const role = await client.query('SELECT rolname FROM pg_roles WHERE rolname=$1',['ttjf_app']);
    if (!role.rowCount) await client.query("CREATE ROLE ttjf_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '" + appPassword.replace(/'/g,"''") + "'");
    await client.query('GRANT CONNECT ON DATABASE ttjf_saas TO ttjf_app');
    await client.query('GRANT USAGE, CREATE ON SCHEMA public TO ttjf_app');
    const database = await client.query('SELECT datname FROM pg_database WHERE datname=$1',['ttjf_saas_test']);
    if (!database.rowCount) await client.query('CREATE DATABASE ttjf_saas_test OWNER ttjf_app');
  } finally { await client.end(); }
  const check = new Client({connectionString:local.DATABASE_URL,connectionTimeoutMillis:5000});
  await check.connect();
  try {
    const result = await check.query('SELECT current_database() AS database, current_user AS role, rolsuper FROM pg_roles WHERE rolname=current_user');
    if (result.rows[0].rolsuper) throw new Error('Application database role must not be superuser.');
    console.log(JSON.stringify({ready:true,database:result.rows[0].database,applicationRole:result.rows[0].role,superuser:false,separateTestDatabase:true}));
  } finally { await check.end(); }
}
async function main() {
  if (process.argv[2] === 'init') return init();
  if (process.argv[2] === 'bootstrap') return bootstrap();
  throw new Error('Usage: node tools/saas-local.cjs init | bootstrap');
}
main().catch(error => { console.error('Local SaaS setup failed: ' + error.message.replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[database URL redacted]')); process.exitCode=1; });
