'use strict';
// Operator-only private family backup/import. Never reachable from HTTP routes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const M = require('../model.js');
const S = require('../saas/security.cjs');
const { createStore } = require('../saas/store.cjs');
const { resolveDatabasePath } = require('../saas/sqlite.cjs');
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function validateEnvelope(value) {
  requireValue(isObject(value) && Object.keys(value).every(key => ['revision','state','parent','receipts'].includes(key)), 'Expected a private family envelope, not a public business export.');
  requireValue(Number.isSafeInteger(value.revision) && value.revision >= 1 && value.revision < Number.MAX_SAFE_INTEGER, 'Invalid source revision.');
  M.totals(value.state);
  const parent = value.parent;
  requireValue(isObject(parent) && typeof parent.configured === 'boolean' && Object.keys(parent).every(key => ['configured','method','salt','hash','n'].includes(key)), 'Invalid private parent policy.');
  if (!parent.configured) {
    requireValue(parent.method === null && Object.keys(parent).length === 2, 'Unconfigured policy cannot carry credentials.');
  } else {
    requireValue(['pin','math'].includes(parent.method), 'Unknown parent method.');
    const hasCredentials = Object.hasOwn(parent,'salt') || Object.hasOwn(parent,'hash') || Object.hasOwn(parent,'n');
    if (parent.method === 'pin' || hasCredentials) {
      requireValue(/^[a-f0-9]{32}$/.test(parent.salt || '') && /^[a-f0-9]{64}$/.test(parent.hash || ''), 'Invalid parent credential digest.');
      requireValue(parent.n === undefined || [16384,32768].includes(parent.n), 'Unknown parent work factor.');
    }
  }
  requireValue(isObject(value.receipts), 'Private action receipts are required.');
  const applied = new Set(value.state.appliedActions);
  for (const [id, receipt] of Object.entries(value.receipts)) {
    requireValue(S.ID.test(id) && applied.has(id) && isObject(receipt), 'Receipt does not match an existing action.');
    requireValue(['sha256','scrypt'].includes(receipt.algorithm) && /^[a-f0-9]{64}$/.test(receipt.digest || ''), 'Invalid action receipt.');
    if (receipt.algorithm === 'scrypt') {
      requireValue(parent.configured && /^[a-f0-9]{32}$/.test(receipt.salt || ''), 'Invalid private configuration receipt.');
      requireValue(receipt.n === undefined || [16384,32768].includes(receipt.n), 'Unknown receipt work factor.');
      requireValue(Object.keys(receipt).every(key => ['algorithm','digest','salt','n'].includes(key)), 'Unexpected private receipt field.');
    } else requireValue(Object.keys(receipt).every(key => ['algorithm','digest'].includes(key)), 'Unexpected receipt field.');
  }
  return JSON.parse(JSON.stringify(value));
}
function readEnvelope(file) {
  const absolute = path.resolve(file);
  const size = fs.statSync(absolute).size;
  requireValue(size <= 64 * 1024 * 1024, 'Source exceeds the 64 MiB operator import limit.');
  const bytes = fs.readFileSync(absolute);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch (_) { throw new Error('Source is not valid JSON; nothing was changed.'); }
  return { envelope: validateEnvelope(value), digest: crypto.createHash('sha256').update(bytes).digest('hex') };
}
async function ownedFamily(client, familyId, ownerEmail) {
  requireValue(S.UUID.test(familyId), 'A valid explicit target family ID is required.');
  const email = S.email(ownerEmail);
  const user = (await client.query('SELECT id,verified_at FROM saas_users WHERE email=$1',[email])).rows[0];
  requireValue(user && user.verified_at, 'Target owner must be an existing verified account.');
  const precheck = await client.query("SELECT 1 FROM saas_memberships WHERE family_id=$1 AND user_id=$2 AND role='owner'",[familyId,user.id]);
  requireValue(precheck.rowCount === 1, 'The supplied account does not own the target family.');
  const family = (await client.query('SELECT * FROM saas_families WHERE id=$1',[familyId])).rows[0];
  const member = (await client.query("SELECT role FROM saas_memberships WHERE family_id=$1 AND user_id=$2",[familyId,user.id])).rows[0];
  requireValue(family && member && member.role === 'owner', 'Target family ownership changed; nothing was imported.');
  return family;
}
function emptyFamily(family) {
  requireValue(Number(family.revision) === 1 && family.parent.configured === false && family.state.farm === null, 'Target must be a newly created empty family with no parent setup.');
  for (const key of ['tasks','pointItems','rewards','points','redemptions','requests','petPurchases','petCare','appliedActions']) {
    requireValue(Array.isArray(family.state[key]) && family.state[key].length === 0, 'Refusing to replace existing target activity or settings.');
  }
  const totals = M.totals(family.state);
  requireValue(totals.earned === 0 && totals.spent === 0, 'Refusing to replace an existing ledger.');
}
async function importFamily(store, {source, familyId, ownerEmail, apply = false, now = new Date()}) {
  const {envelope, digest} = readEnvelope(source);
  const at = new Date(now);
  requireValue(Number.isFinite(+at), 'Invalid import timestamp.');
  return store.transaction(async client => {
    const family = await ownedFamily(client, familyId, ownerEmail);
    emptyFamily(family);
    const prior = await client.query('SELECT 1 FROM saas_family_imports WHERE family_id=$1',[familyId]);
    requireValue(!prior.rowCount, 'Family has already received an import.');
    const revision = Math.max(envelope.revision, Number(family.revision) + 1);
    const totals = M.totals(envelope.state);
    const result = {mode:apply ? 'applied' : 'dry-run', familyId, sourceSha256:digest, sourceRevision:envelope.revision,
      targetRevision:revision, receipts:Object.keys(envelope.receipts).length, points:envelope.state.points.length,
      redemptions:envelope.state.redemptions.length, earned:totals.earned, available:totals.available};
    if (!apply) return result;
    await client.query('UPDATE saas_families SET state=$2,parent=$3,revision=$4,updated_at=$5 WHERE id=$1', [familyId,envelope.state,envelope.parent,revision,at]);
    for (const [actionId,receipt] of Object.entries(envelope.receipts)) {
      await client.query('INSERT INTO saas_action_receipts(family_id,action_id,receipt,revision,created_at) VALUES($1,$2,$3,$4,$5)',[familyId,actionId,receipt,revision,at]);
    }
    await client.query('INSERT INTO saas_family_imports(family_id,source_sha256,source_revision,imported_at) VALUES($1,$2,$3,$4)',[familyId,digest,envelope.revision,at]);
    return result;
  });
}
async function backupFamily(store, {familyId, ownerEmail, output}) {
  requireValue(typeof output === 'string' && output.trim(), 'An explicit private backup destination is required.');
  const target = resolveDatabasePath(output);
  requireValue(!fs.existsSync(target), 'Backup destination already exists; refusing to overwrite.');
  const envelope = await store.transaction(async client => {
    const family = await ownedFamily(client,familyId,ownerEmail);
    const rows = (await client.query('SELECT action_id,receipt FROM saas_action_receipts WHERE family_id=$1 ORDER BY action_id',[familyId])).rows;
    const receipts = Object.create(null);
    for (const row of rows) receipts[row.action_id] = row.receipt;
    return validateEnvelope({revision:Number(family.revision),state:family.state,parent:family.parent,receipts});
  });
  const bytes = Buffer.from(JSON.stringify(envelope,null,2) + '\n','utf8');
  fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
  const fd = fs.openSync(target,'wx',0o600);
  try { fs.writeFileSync(fd,bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return {mode:'backup', familyId, revision:envelope.revision, bytes:bytes.length, sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
}
async function main() {
  const {positionals,values} = parseArgs({allowPositionals:true,options:{source:{type:'string'},family:{type:'string'},owner:{type:'string'},output:{type:'string'},apply:{type:'boolean',default:false},help:{type:'boolean'}}});
  if (values.help) {
    console.log('Private family operator commands (SQLite path comes from SQLITE_FILE):\n  import --source FILE --family UUID --owner EMAIL [--apply]\n  backup --family UUID --owner EMAIL --output PRIVATE_FILE\nImport is a dry-run by default and never overwrites an existing family. Database must already exist.');
    return;
  }
  requireValue(positionals.length === 1 && ['import','backup'].includes(positionals[0]), 'Choose import or backup; use --help for syntax.');
  requireValue(values.family && values.owner, 'Explicit --family and --owner are required.');
  if (positionals[0] === 'import') requireValue(values.source && !values.output, 'Import requires --source and does not accept --output.');
  else requireValue(values.output && !values.source && !values.apply, 'Backup requires --output and does not accept --source or --apply.');
  // Validation/backup never provisions the database or changes schema implicitly.
  const store = await createStore({migrate:false});
  try {
    const result = positionals[0] === 'import' ? await importFamily(store,{source:values.source,familyId:values.family,ownerEmail:values.owner,apply:values.apply}) :
      await backupFamily(store,{familyId:values.family,ownerEmail:values.owner,output:values.output});
    console.log(JSON.stringify(result,null,2));
  } finally { await store.close(); }
}
module.exports = {validateEnvelope,readEnvelope,importFamily,backupFamily};
if (require.main === module) main().catch(error => {
  const safe = error.code && /^[0-9A-Z]{5}$/.test(error.code) ? 'Database operation failed (' + error.code + '); transaction was rolled back.' : error.message;
  console.error(String(safe).replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[database URL redacted]')); process.exitCode=1;
});
