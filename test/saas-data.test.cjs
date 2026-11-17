'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const M = require('../model.js');
const S = require('../saas/security.cjs');
const { fixture,register,family,request,grant,PIN } = require('../saas/testing.cjs');
const { importFamily,backupFamily,validateEnvelope } = require('../tools/saas-data.cjs');
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'ttjf-v13-import-'));
  t.after(() => {
    assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));
    assert.match(path.basename(dir),/^ttjf-v13-import-/);
    fs.rmSync(dir,{recursive:true,force:true});
  });
  return dir;
}
function legacyFile(directory, now) {
  let state = M.createSeed(now);
  const start = {id:'legacy-farm-start',type:'farm.start'};
  state = M.apply(state,start,now);
  const setup = {id:'legacy-parent-setup',type:'parent.setup',method:'pin',pin:PIN,confirmPin:PIN};
  state.appliedActions.push(setup.id);
  const salt = crypto.randomBytes(16).toString('hex');
  const receiptSalt = crypto.randomBytes(16).toString('hex');
  const envelope = {revision:12,state,parent:{configured:true,method:'pin',salt,hash:crypto.scryptSync(PIN,salt,32).toString('hex')},receipts:{
    [start.id]:{algorithm:'sha256',digest:S.digest(S.canonical(start))},
    [setup.id]:{algorithm:'scrypt',salt:receiptSalt,digest:crypto.scryptSync(S.canonical(setup),receiptSalt,32).toString('hex')}
  }};
  const source = path.join(directory,'synthetic-legacy.json');
  fs.writeFileSync(source,JSON.stringify(envelope,null,2)+'\n',{mode:0o600});
  return {source,envelope,start,setup,bytes:fs.readFileSync(source)};
}

test('private legacy import requires verified target owner, is dry-run by default and preserves old PIN/receipts', async t => {
  const f = await fixture(t);
  const owner = await family(f,await register(f,'import-owner@example.test'));
  const other = await register(f,'import-other@example.test');
  const dir = temporary(t), legacy = legacyFile(dir,new Date(f.clock.value));
  const options = {source:legacy.source,familyId:owner.familyId,ownerEmail:owner.email,now:new Date(f.clock.value)};
  const before = (await request(f.server,'GET','/api/state',undefined,owner)).body;
  await assert.rejects(importFamily(f.server.store,{...options,ownerEmail:other.email}),/does not own/);
  const dryRun = await importFamily(f.server.store,options);
  assert.equal(dryRun.mode,'dry-run');
  assert.equal(dryRun.sourceRevision,12);
  assert.deepEqual((await request(f.server,'GET','/api/state',undefined,owner)).body,before);
  assert.equal((await f.pool.query('SELECT count(*) FROM saas_family_imports')).rows[0].count,'0');
  const done = await importFamily(f.server.store,{...options,apply:true});
  assert.equal(done.targetRevision,12);
  const row = (await f.pool.query('SELECT state,parent,revision FROM saas_families WHERE id=$1',[owner.familyId])).rows[0];
  assert.deepEqual(row.state,legacy.envelope.state);
  assert.deepEqual(row.parent,legacy.envelope.parent);
  assert.equal(Number(row.revision),12);
  for (const action of [legacy.start,legacy.setup]) {
    const replay = await request(f.server,'POST','/api/action',{revision:12,action},owner);
    assert.equal(replay.status,200,replay.body.code);
    assert.equal(replay.body.revision,12);
  }
  const add = {id:'after-import',type:'points.add',name:'阅读',points:1,reason:'导入后实际记账'};
  const approval = await grant(f,owner,add,12);
  const committed = await request(f.server,'POST','/api/action',{revision:12,action:add,grant:approval},owner);
  assert.equal(committed.status,200,committed.body.code);
  assert.equal(M.totals(committed.body.state).earned,129);
  await assert.rejects(importFamily(f.server.store,{...options,apply:true}),/newly created empty/);
  assert.deepEqual(fs.readFileSync(legacy.source),legacy.bytes,'original file never modified');
});

test('import rollback leaves empty target, receipts and import audit unchanged', async t => {
  const f = await fixture(t);
  const owner = await family(f,await register(f,'rollback-import@example.test'));
  const legacy = legacyFile(temporary(t),new Date(f.clock.value));
  await f.pool.query("CREATE FUNCTION fail_private_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected receipt failure'; END $$");
  await f.pool.query('CREATE TRIGGER reject_private_import BEFORE INSERT ON saas_action_receipts FOR EACH ROW EXECUTE FUNCTION fail_private_import()');
  await assert.rejects(importFamily(f.server.store,{source:legacy.source,familyId:owner.familyId,ownerEmail:owner.email,apply:true}),/injected receipt failure/);
  const state = (await request(f.server,'GET','/api/state',undefined,owner)).body;
  assert.equal(state.revision,1);
  assert.equal(M.totals(state.state).earned,0);
  assert.equal(state.parent.configured,false);
  assert.equal((await f.pool.query('SELECT count(*) FROM saas_action_receipts')).rows[0].count,'0');
  assert.equal((await f.pool.query('SELECT count(*) FROM saas_family_imports')).rows[0].count,'0');
});

test('private family backup restores to another empty owned family and refuses overwrite', async t => {
  const f = await fixture(t);
  const user = await register(f,'backup-owner@example.test');
  const first = await family(f,user,'原家庭');
  const second = await family(f,user,'恢复目标');
  const dir = temporary(t), legacy = legacyFile(dir,new Date(f.clock.value));
  await importFamily(f.server.store,{source:legacy.source,familyId:first.familyId,ownerEmail:user.email,apply:true});
  const output = path.join(dir,'private-family-backup.json');
  await assert.rejects(backupFamily(f.server.store,{familyId:first.familyId,ownerEmail:user.email,output:path.resolve(__dirname,'../assets/private-backup.png')}),/private data/);
  assert.equal(fs.existsSync(path.resolve(__dirname,'../assets/private-backup.png')),false);
  const backup = await backupFamily(f.server.store,{familyId:first.familyId,ownerEmail:user.email,output});
  assert.equal(backup.mode,'backup');
  const bytes = fs.readFileSync(output);
  assert.equal(backup.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));
  const archive = JSON.parse(bytes);
  assert.deepEqual(archive,legacy.envelope);
  assert.deepEqual(Object.keys(archive).sort(),['parent','receipts','revision','state']);
  await assert.rejects(backupFamily(f.server.store,{familyId:first.familyId,ownerEmail:user.email,output}),/refusing to overwrite/);
  await importFamily(f.server.store,{source:output,familyId:second.familyId,ownerEmail:user.email,apply:true});
  const a = (await request(f.server,'GET','/api/state',undefined,first)).body;
  const b = (await request(f.server,'GET','/api/state',undefined,second)).body;
  assert.deepEqual(a.state,b.state);
  assert.equal(b.revision,12);
  assert.notEqual(a.familyId,b.familyId);
});

test('import validates private policy and bumps a revision-one source before exposing it', async t => {
  const f = await fixture(t);
  const owner = await family(f,await register(f,'fresh-import@example.test'));
  const source = path.join(temporary(t),'empty-source.json');
  const envelope = {revision:1,state:M.createEmptyFamily({childName:'原称呼'}),parent:{configured:false,method:null},receipts:{}};
  fs.writeFileSync(source,JSON.stringify(envelope));
  assert.throws(() => validateEnvelope({...envelope,parent:{configured:false,method:null,hash:'x'}}),/cannot carry/);
  assert.throws(() => validateEnvelope({...envelope,receipts:undefined}),/receipts are required/);
  assert.throws(() => validateEnvelope({...envelope,state:{...envelope.state,points:[{id:'bad',points:-1}]}}));
  const result = await importFamily(f.server.store,{source,familyId:owner.familyId,ownerEmail:owner.email,apply:true});
  assert.equal(result.sourceRevision,1);
  assert.equal(result.targetRevision,2);
  const state = (await request(f.server,'GET','/api/state',undefined,owner)).body;
  assert.equal(state.revision,2);
  assert.equal(state.state.childName,'原称呼');
});

test('operator CLI backs up, validates, restores and refuses overwrite using a disposable PostgreSQL schema', async t => {
  const f = await fixture(t);
  const owner = await family(f,await register(f,'cli-owner@example.test'),'CLI原家庭');
  const target = await family(f,owner,'CLI恢复目标');
  const stranger = await register(f,'cli-other@example.test');
  const dir = temporary(t), legacy = legacyFile(dir,new Date(f.clock.value));
  const backup = path.join(dir,'cli-family-backup.json');
  const connection = new URL(process.env.TEST_DATABASE_URL);
  assert.match(f.schema,/^v14_test_[0-9]+_[a-f0-9]{16}$/);
  connection.searchParams.set('options','-c search_path=' + f.schema);
  let attempt = 0;
  async function cli(args, expected = 0) {
    const prefix = path.join(dir,'cli-' + (++attempt));
    const out = fs.openSync(prefix+'.out','wx',0o600), err = fs.openSync(prefix+'.err','wx',0o600);
    let code;
    try {
      code = await new Promise((resolve,reject) => {
        const child = spawn(process.execPath,[path.resolve(__dirname,'../tools/saas-data.cjs'),...args],{
          env:{...process.env,DATABASE_URL:connection.href},stdio:['ignore',out,err],timeout:20000
        });
        child.once('error',reject); child.once('close',resolve);
      });
    } finally { fs.closeSync(out); fs.closeSync(err); }
    const stdout = fs.readFileSync(prefix+'.out','utf8'), stderr = fs.readFileSync(prefix+'.err','utf8');
    assert.equal(code,expected,stderr);
    assert.equal(stdout.includes(connection.password)||stderr.includes(connection.password),false,'CLI output must not disclose credentials');
    return expected === 0 ? JSON.parse(stdout) : stderr;
  }
  const importing = ['import','--source',legacy.source,'--family',owner.familyId,'--owner',owner.email];
  const dry = await cli(importing);
  assert.equal(dry.mode,'dry-run');
  assert.equal(Number((await f.pool.query('SELECT revision FROM saas_families WHERE id=$1',[owner.familyId])).rows[0].revision),1);
  assert.equal((await f.pool.query('SELECT count(*) FROM saas_family_imports')).rows[0].count,'0');
  const imported = await cli([...importing,'--apply']);
  assert.equal(imported.mode,'applied');
  const saved = await cli(['backup','--family',owner.familyId,'--owner',owner.email,'--output',backup]);
  assert.equal(saved.mode,'backup');
  const bytes = fs.readFileSync(backup);
  assert.deepEqual(JSON.parse(bytes),legacy.envelope);
  assert.equal(saved.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.match(await cli(['backup','--family',owner.familyId,'--owner',owner.email,'--output',backup],1),/already exists/);
  assert.deepEqual(fs.readFileSync(backup),bytes);
  assert.match(await cli(['backup','--family',owner.familyId,'--owner',stranger.email,'--output',path.join(dir,'denied.json')],1),/does not own/);
  assert.equal(fs.existsSync(path.join(dir,'denied.json')),false);
  const restore = ['import','--source',backup,'--family',target.familyId,'--owner',target.email];
  assert.equal((await cli(restore)).mode,'dry-run');
  assert.equal((await cli([...restore,'--apply'])).mode,'applied');
  const restored = (await f.pool.query('SELECT state,parent,revision FROM saas_families WHERE id=$1',[target.familyId])).rows[0];
  assert.deepEqual(restored.state,legacy.envelope.state);
  assert.deepEqual(restored.parent,legacy.envelope.parent);
  assert.equal(Number(restored.revision),legacy.envelope.revision);
  assert.match(await cli([...restore,'--apply'],1),/empty|imported|active|existing/i);
  assert.deepEqual(fs.readFileSync(legacy.source),legacy.bytes,'synthetic source remains byte-for-byte unchanged');
  for (const action of [legacy.start,legacy.setup]) {
    const replay = await request(f.server,'POST','/api/action',{revision:legacy.envelope.revision,action},target);
    assert.equal(replay.status,200);
    assert.equal(replay.body.revision,legacy.envelope.revision);
  }
});
