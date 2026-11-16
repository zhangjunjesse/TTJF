'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { createServer } = require('../server.cjs');
const B = require('./browser.cjs');
const { ROOT, ARTIFACTS, Model, FIXTURE_TIME, SELECTORS, action, click, fill, fillForm, state, ui, totals, delay, connected } = B;
const PIN = '642851', NEXT = '753962', OTHER = '951753', LEGACY = '86420975';
const SECRETS = [PIN, NEXT, OTHER, LEGACY];
const VIEWS = [['small-phone',320,568],['phone',390,844],['ipad-landscape',1024,768],['ipad-portrait',768,1024]];
const SOURCES = ['app.js','styles.css','index.html','server.cjs','model.js','assistant.js','assistant-service.cjs','pet.js','pet.css'];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,file))).digest('hex');
const sourceHashes = () => Object.fromEntries(SOURCES.map(name => [name,hash(name)]));
const preservation = JSON.parse(fs.readFileSync(path.join(ARTIFACTS,'v8-preserved-v7.json'),'utf8')).files;
const preservedChanges = () => Object.entries(preservation).filter(([name,value])=>hash(name)!==value).map(([name])=>name);
const reason = '自己把书包和水杯放好';
const form = (page,kind) => page.waitForFunction(value => window.FamilyDemo.getUI().form === value, {timeout:7000},kind);
const idle = page => page.waitForFunction(() => !window.FamilyDemo.getUI().pending, {timeout:10000});
const setupSelector = '#parent-form [name="setupPin"]';
const setupConfirm = '#parent-form [name="setupConfirm"]';
const report = {version:'0.8',requested:process.env.V8_GROUPS || 'all',startedAt:new Date().toISOString(),sources:sourceHashes(),exportHash:hash('export/little-steps-demo.html'),harnessHash:hash('test/v8-browser.cjs'),results:[],screens:[],images:[],fixtures:[],errors:[],privacy:[],previewImages:[]};
const wanted = process.env.V8_GROUPS ? new Set(process.env.V8_GROUPS.split(',')) : null;
let browser;

// Unlike the old helper, a fresh fixture never supplies parentPin and never
// writes an empty/preseeded file. This exercises the real first-use contract.
async function environment(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'family-v8-qa-'));
  const dataFile = path.join(directory,'state.json');
  assert.equal(fs.existsSync(dataFile),false);
  const contexts = [], errors = [], requests = [];
  let server, port, ordinal = 0;
  const start = async (initialPin, samePort) => {
    const input = {dataFile,now:() => new Date(FIXTURE_TIME)};
    if (initialPin !== undefined) input.parentPin = initialPin;
    server = createServer(input);
    await new Promise((resolve,reject) => { server.once('error',reject);server.listen(samePort || 0,'127.0.0.1',resolve); });
    port = server.address().port;
  };
  await start(options.preconfigured);
  const url = 'http://127.0.0.1:' + port;
  const api = async (endpoint,payload) => {
    const response = await fetch(url + endpoint,payload === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    return {status:response.status,body:await response.json()};
  };
  const snapshot = async () => (await api('/api/state')).body;
  const initial = await snapshot();
  assert.deepEqual(initial.parent,options.preconfigured === undefined ? {configured:false,method:null} : {configured:true,method:'pin'});
  report.fixtures.push({kind:options.preconfigured === undefined ? 'genuinely-unconfigured' : 'explicit-existing-PIN',passedParentPin:options.preconfigured !== undefined,initialParent:initial.parent,initialRevision:initial.revision});
  async function newPage(view = ['phone',390,844], opts = {}) {
    const context = await browser.createBrowserContext(); contexts.push(context);
    const page = await context.newPage(); const id = ++ordinal;
    page.setDefaultTimeout(7000);
    await page.setViewport({width:view[1],height:view[2],deviceScaleFactor:1});
    page.on('pageerror',error => errors.push(error.message));
    page.on('request',request => {
      if (request.method() !== 'POST' || !new URL(request.url()).pathname.startsWith('/api/')) return;
      let body; try { body = JSON.parse(request.postData()); } catch (_) { body = null; }
      requests.push({page:id,path:new URL(request.url()).pathname,body});
    });
    await page.evaluateOnNewDocument(({now,pausePolls}) => {
      const NativeDate = window.Date;
      class ControlledDate extends NativeDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
      window.Date = ControlledDate;
      if (pausePolls) {
        const original = window.setInterval.bind(window), polls=[];
        window.setInterval = (callback,milliseconds) => milliseconds === 5000 ? (polls.push(callback),900000+polls.length) : original(callback,milliseconds);
        window.__v8Poll = () => polls.forEach(callback => callback());
      }
    },{now:FIXTURE_TIME,pausePolls:!!opts.pausePolls});
    if (opts.holdMeta) {
      const original=await api('/api/meta');let heldMeta;
      await page.setRequestInterception(true);
      const handler=request=>{if(!heldMeta&&request.method()==='GET'&&new URL(request.url()).pathname==='/api/meta'){heldMeta=request;return;}request.continue().catch(()=>{});};
      page.on('request',handler);
      page.__v8ReleaseMeta=async()=>{assert.ok(heldMeta,'The original metadata request must have arrived');await heldMeta.respond({status:original.status,contentType:'application/json',body:JSON.stringify(original.body)});page.off('request',handler);await page.setRequestInterception(false);};
    }
    await page.goto(url,{waitUntil:'load'}); await connected(page);
    page.__v8Id = id;
    return page;
  }
  async function restart(initialPin) {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await start(initialPin,port);
  }
  async function close() {
    await Promise.all(contexts.map(context => context.close()));
    if (server.listening) { server.closeAllConnections();await new Promise(resolve => server.close(resolve)); }
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('family-v8-qa-'));
    fs.rmSync(directory,{recursive:true,force:true});
    report.errors.push(...errors);
  }
  return {url,directory,dataFile,requests,errors,newPage,api,snapshot,restart,close,initial};
}
async function isolated(options,body) {
  const env = await environment(options);
  try { await body(env); assert.deepEqual(env.errors,[]); } finally { await env.close(); }
}
async function check(group,name,fn) {
  if (wanted && !wanted.has(group)) return;
  const start=Date.now();
  try { await fn();report.results.push({group,name,passed:true,milliseconds:Date.now()-start});console.log('PASS '+group+': '+name); }
  catch (error) { report.results.push({group,name,passed:false,error:error.stack,milliseconds:Date.now()-start});console.error('FAIL '+group+': '+name+'\n'+error.stack); }
}
async function typed(page,selector,value) {
  await click(page,selector); await page.keyboard.down('Control');await page.keyboard.press('KeyA');await page.keyboard.up('Control');await page.keyboard.type(String(value));
}
async function closeHome(page) {
  for (let i=0;i<8 && (await ui(page)).form;i++) {
    if ((await ui(page)).auth) await click(page,'.sheet-footer '+action('parent-cancel'));
    else await B.closeSheet(page);
  }
  await B.noSheet(page);
}
async function config(page) {
  await closeHome(page); await click(page,action('preferences'));await form(page,'preferences');
  await click(page,action('parent-config'));await form(page,'parentConfig');
}
async function setPair(page,pin,confirm=pin) {
  await typed(page,'#editor-form [name="pin"]',pin);
  await typed(page,'#editor-form [name="confirmPin"]',confirm);
}
async function setBusinessPair(page,pin,confirm=pin) {
  await page.waitForSelector(setupSelector);await typed(page,setupSelector,pin);await typed(page,setupConfirm,confirm);
}
async function submitEditor(page) { await click(page,SELECTORS.submit,{scroll:false}); }
async function submitParent(page) { await click(page,SELECTORS.verify,{scroll:false}); }
async function verify(page,pin) {
  await page.waitForSelector(SELECTORS.answer);await typed(page,SELECTORS.answer,pin);await submitParent(page);
}
async function verifyMath(page) {
  await page.waitForSelector(SELECTORS.answer);
  const text = await page.$eval('#parent-form',e=>e.innerText);
  const match = text.match(/(\d+)\s*([+×x*])\s*(\d+)\s*=\s*\?/);
  assert.ok(match,'A visible arithmetic question is required');
  const answer=match[2]==='+'?Number(match[1])+Number(match[3]):Number(match[1])*Number(match[3]);
  await verify(page,String(answer));
}
async function award(page,name='自己整理书包',points=7) {
  await closeHome(page);
  await click(page,action('add-points'));await form(page,'behaviorPicker');
  await click(page,action('points-mode','custom'));await form(page,'points');
  await fillForm(page,{name,points,reason});
}
async function finished(page) {
  await page.waitForFunction(()=>!window.FamilyDemo.getUI().pending&&!window.FamilyDemo.getUI().auth,{timeout:10000});
}
async function visibleError(page) {
  await page.waitForFunction(()=>[...document.querySelectorAll('[role="alert"]')].some(e=>!e.hidden&&e.innerText.trim()),{timeout:7000});
  const texts = await page.$$eval('[role="alert"]',all=>all.filter(e=>!e.hidden).map(e=>e.innerText.trim()).filter(Boolean));
  assert.ok(texts.every(text=>text.length<=48),'Errors must name a concise current problem');
  return texts.join(' | ');
}
const writes = (env,type,page) => env.requests.filter(r=>r.path==='/api/action'&&r.body&&(!type||r.body.action.type===type)&&(!page||r.page===page.__v8Id));
async function noSecrets(page,env,label) {
  const stores = await page.evaluate(()=>({storage:Object.fromEntries(Object.keys(localStorage).map(key=>[key,localStorage.getItem(key)])),publicState:window.FamilyDemo.getState(),ui:window.FamilyDemo.getUI()}));
  const publicMeta = env ? (await env.api('/api/meta')).body : null;
  const publicSnapshot = env ? await env.snapshot() : null;
  const privateDisk = env ? fs.readFileSync(env.dataFile,'utf8') : '';
  for (const pin of SECRETS) {
    assert.ok(!JSON.stringify(stores).includes(pin),'PIN must not appear in storage or public browser state at '+label);
    assert.ok(!JSON.stringify([publicMeta,publicSnapshot]).includes(pin),'PIN must not appear in public HTTP output at '+label);
    assert.ok(!privateDisk.includes(pin),'Persistent server records must contain only salted credential/receipt hashes at '+label);
  }
  report.privacy.push({label,storageKeys:Object.keys(stores.storage),plainSecretsAbsent:true});
}
async function audit(page,name,options={}) {
  await page.evaluate(()=>{const e=document.querySelector('.sheet-body');if(e)e.scrollTop=0;});
  const screen = await page.evaluate(()=>{
    const root=document.querySelector('.sheet')||document.querySelector('.app-shell');
    const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};
    const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0;};
    const controls=[...root.querySelectorAll('button,input,select,textarea')].filter(visible).map(e=>({tag:e.tagName,type:e.type,name:e.name,action:e.dataset.action||'',label:e.getAttribute('aria-label')||(e.labels&&[...e.labels].map(l=>l.innerText).join(' ').trim())||e.textContent.trim(),font:parseFloat(getComputedStyle(e).fontSize),disabled:e.disabled,box:rect(e)}));
    return {text:root.innerText,form:window.FamilyDemo.getUI().auth?'parent':window.FamilyDemo.getUI().form,viewport:{w:innerWidth,h:innerHeight},root:rect(root),page:{w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight},controls};
  });
  screen.name=name;report.screens.push(screen);
  assert.ok(screen.page.w<=screen.viewport.w+1&&screen.page.h<=screen.viewport.h+1,'Page overflow '+name);
  assert.ok(screen.root.x>=-1&&screen.root.y>=-1&&screen.root.right<=screen.viewport.w+1&&screen.root.bottom<=screen.viewport.h+1,'Sheet overflow '+name);
  for (const c of screen.controls) {
    assert.ok(c.label,'Unlabelled control '+name+' '+c.name);
    if (c.tag==='BUTTON') assert.ok(c.box.w>=47.5&&c.box.h>=47.5,'Touch control below 48px: '+name+' '+c.label);
    else if (!['checkbox','radio','file','hidden'].includes(c.type)) assert.ok(c.font>=16,'Input below 16px: '+name+' '+c.name);
    if (/pin|confirm/i.test(c.name||'')) assert.equal(c.type,'password','PIN entries must be masked');
  }
  assert.doesNotMatch(screen.text,/控制台|询问开发者|自动产生|初始密码|请由家长|每笔操作单独验证/,'No technical or tutorial explanation in the product flow');
  await B.reachable(page,'.sheet-footer button');
  await B.capture(page,name,'v8');report.images.push('v8-'+name+'.png');
  if (options.preview) {
    const file='v8-preview-'+options.preview+'.png';
    await page.screenshot({path:path.join(ARTIFACTS,file),fullPage:false});report.previewImages.push(file);
  }
  return screen;
}
async function holdAction(page,type,options={}) {
  let held,resolve;const states=[];
  const arrived=new Promise((done,fail)=>{const timeout=setTimeout(()=>fail(new Error('Expected '+type+' request did not arrive')),8000);resolve=value=>{clearTimeout(timeout);done(value);};});
  await page.setRequestInterception(true);
  const handler=request=>{
    if (options.holdStates&&request.method()==='GET'&&new URL(request.url()).pathname==='/api/state') { states.push(request);return; }
    if (request.method()==='POST'&&new URL(request.url()).pathname==='/api/action') {
      let body;try {body=JSON.parse(request.postData());}catch(_){}
      if (!held&&body&&body.action.type===type) {held=request;resolve({request,body});return;}
    }
    request.continue().catch(()=>{});
  };
  page.on('request',handler);
  return {arrived,dispose:async()=>{for(const request of states)await request.continue();page.off('request',handler);await page.setRequestInterception(false);}};
}
async function expectedSetup(page) {
  await form(page,'parentConfig');
  assert.equal(await page.$('#editor-form [name="answer"]'),null);
  assert.deepEqual(await page.$$eval('#editor-form input[type="password"]',all=>all.map(e=>e.name)),['pin','confirmPin']);
  const text=await page.$eval('.sheet',e=>e.innerText);
  assert.match(text,/设置\s*PIN/);assert.match(text,/确认\s*PIN/);assert.doesNotMatch(text,/当前\s*PIN|新\s*PIN/);
}
async function sourceCase() {
  assert.deepEqual(preservedChanges(),[],'Immutable v0.7 delivery and evidence must not change');
  const html=fs.readFileSync(path.join(ROOT,'export/little-steps-demo.html'),'utf8');
  for (const file of ['app.js','model.js','pet.js','assistant.js']) {
    const embedded=fs.readFileSync(path.join(ROOT,file),'utf8').replace(/\r\n/g,'\n').replace(/<\/script/gi,'<\\/script');
    assert.ok(html.replace(/\r\n/g,'\n').includes(embedded),'Export must embed current '+file);
  }
  assert.ok(html.replace(/\r\n/g,'\n').includes(fs.readFileSync(path.join(ROOT,'styles.css'),'utf8').replace(/\r\n/g,'\n')));
}
async function settingsCase(view) {
  await isolated({},async env=>{
    const page=await env.newPage(view,{holdMeta:view[0]==='phone'});
    const initial=await env.snapshot();
    assert.deepEqual((await env.api('/api/meta')).body.parent,{configured:false,method:null});
    await config(page);await expectedSetup(page);
    await audit(page,view[0]+'-setup',{preview:view[0]==='phone'?'setup':null});
    await setPair(page,PIN,OTHER);await submitEditor(page);await visibleError(page);
    assert.equal((await env.snapshot()).revision,initial.revision);assert.equal(writes(env).length,0);
    await audit(page,view[0]+'-setup-mismatch');await noSecrets(page,env,view[0]+'-setup-mismatch');
    await closeHome(page);await config(page);
    assert.equal(await page.$eval('[name="pin"]',e=>e.value),'');assert.equal(await page.$eval('[name="confirmPin"]',e=>e.value),'');
    await setPair(page,PIN);await submitEditor(page);await finished(page);
    assert.deepEqual((await env.snapshot()).parent,{configured:true,method:'pin'});
    assert.equal(writes(env,'parent.setup').length,1);
    assert.equal(env.requests.filter(r=>r.path==='/api/parent/challenge').length,0,'First configuration must not require the unknown old PIN');
    assert.deepEqual((await env.snapshot()).state.points,initial.state.points);
    assert.equal((await env.snapshot()).revision,initial.revision+1);
    if (view[0]==='phone') {
      await page.__v8ReleaseMeta();await delay(100);await config(page);
      assert.match(await page.$eval('.sheet',e=>e.innerText),/新\s*PIN/,'Late unconfigured metadata must not reopen initialization after successful setup');
      await env.restart();
    }
    await page.reload({waitUntil:'load'});await connected(page);
    await config(page);const text=await page.$eval('.sheet',e=>e.innerText);assert.match(text,/新\s*PIN/);assert.match(text,/确认新\s*PIN/);
    await audit(page,view[0]+'-configured',{preview:view[0]==='phone'?'change':null});
    await award(page);await submitEditor(page);await page.waitForSelector(SELECTORS.answer);
    await verify(page,PIN);await finished(page);
    const saved=await env.snapshot();assert.equal(saved.state.points.length,initial.state.points.length+1);assert.equal(Model.totals(saved.state).earned,Model.totals(initial.state).earned+7);
    assert.equal(writes(env,'points.add').length,1);await noSecrets(page,env,view[0]+'-configured-award');
  });
}
async function configuredCase() {
  await isolated({preconfigured:LEGACY},async env=>{
    const page=await env.newPage();const initial=await env.snapshot();
    await config(page);await setPair(page,NEXT,OTHER);await submitEditor(page);await visibleError(page);
    assert.equal((await ui(page)).auth,false);assert.equal(writes(env).length,0);
    await setPair(page,NEXT);await submitEditor(page);await page.waitForSelector(SELECTORS.answer);
    assert.match(await page.$eval('#parent-form',e=>e.innerText),/当前\s*PIN/);
    await audit(page,'phone-current-pin',{preview:'verify'});
    await verify(page,OTHER);await visibleError(page);assert.equal((await env.snapshot()).revision,initial.revision);
    await audit(page,'phone-current-pin-error');
    await verify(page,LEGACY);await finished(page);
    assert.equal(writes(env,'parent.configure').length,1);
    await env.restart(OTHER);await page.evaluate(()=>localStorage.clear());await page.reload({waitUntil:'load'});await connected(page);
    const authoritative=await env.snapshot();
    const spoof=await env.api('/api/action',{revision:authoritative.revision,action:{type:'parent.setup',id:'v8-forged-unconfigured',configured:false,method:'pin',pin:OTHER,confirmPin:OTHER}});
    assert.equal(spoof.status,409);assert.equal(spoof.body.code,'PARENT_ALREADY_CONFIGURED');
    await award(page,'修改后的一次加分',5);await submitEditor(page);
    await verify(page,LEGACY);await visibleError(page);assert.equal((await env.snapshot()).state.points.length,initial.state.points.length);
    await verify(page,NEXT);await finished(page);
    assert.equal((await env.snapshot()).state.points.length,initial.state.points.length+1);
    await noSecrets(page,env,'existing-current-PIN-change');
  });
}
async function mathCase() {
  await isolated({},async env=>{
    const page=await env.newPage();const original=(await env.snapshot()).state.points.length;
    await config(page);await fill(page,'[name="method"]','math');await submitEditor(page);await finished(page);
    assert.deepEqual((await env.snapshot()).parent,{configured:true,method:'math'});
    assert.equal(env.requests.filter(r=>r.path==='/api/parent/challenge').length,0);
    await award(page,'算术首设后的加分',3);await submitEditor(page);await verifyMath(page);await finished(page);
    await config(page);await fill(page,'[name="method"]','pin');await setPair(page,NEXT);await submitEditor(page);
    await page.waitForSelector(SELECTORS.answer);await audit(page,'phone-math-current');await verifyMath(page);await finished(page);
    assert.deepEqual((await env.snapshot()).parent,{configured:true,method:'pin'});
    await config(page);await fill(page,'[name="method"]','math');await submitEditor(page);
    assert.match(await page.$eval('#parent-form',e=>e.innerText),/当前\s*PIN/);
    await verify(page,NEXT);await finished(page);
    assert.deepEqual((await env.snapshot()).parent,{configured:true,method:'math'});
    await award(page,'再次使用算术验证',4);await submitEditor(page);await verifyMath(page);await finished(page);
    assert.equal((await env.snapshot()).state.points.length,original+2);
    await noSecrets(page,env,'math-first-and-both-transitions');
  });
}
async function firstBusinessCase() {
  await isolated({},async env=>{
    const page=await env.newPage();const initial=await env.snapshot();
    // A real public action is still available before first configuration.
    const task=initial.state.tasks.find(t=>!t.done);
    await click(page,'.bottom-nav '+action('nav','reminders'));await click(page,action('task-toggle',task.id));await idle(page);
    assert.equal((await ui(page)).auth,false);assert.deepEqual((await env.snapshot()).parent,{configured:false,method:null});
    await click(page,'.bottom-nav '+action('nav','points'));
    await award(page);await submitEditor(page);await setBusinessPair(page,PIN,OTHER);await submitParent(page);await visibleError(page);
    assert.equal(writes(env,'parent.setup').length,0);await noSecrets(page,env,'business-setup-mismatch');
    await click(page,'.sheet-footer '+action('parent-cancel'));await form(page,'points');
    assert.equal((await env.snapshot()).parent.configured,false);assert.equal(writes(env,'points.add').length,0);
    assert.equal(await page.$eval('[name="reason"]',e=>e.value),reason);
    await submitEditor(page);await page.waitForSelector(setupSelector);assert.equal(await page.$eval(setupSelector,e=>e.value),'');
    await setBusinessPair(page,PIN);await audit(page,'phone-business-setup');
    const held=await holdAction(page,'parent.setup');await submitParent(page);const pending=await held.arrived;
    const button=await page.$(SELECTORS.verify),box=await button.boundingBox();await page.mouse.click(box.x+box.width/2,box.y+box.height/2);await button.dispose();
    await pending.request.continue();await finished(page);await held.dispose();
    const saved=await env.snapshot();
    assert.equal(saved.state.points.length,initial.state.points.length+1);assert.equal(Model.totals(saved.state).earned,Model.totals(initial.state).earned+7);
    assert.equal(writes(env,'parent.setup').length,1);assert.equal(writes(env,'points.add').length,1);
    assert.equal(env.requests.filter(r=>r.path==='/api/parent/verify').length,1,'Original operation continues using the newly entered PIN without a third manual input');
    const exact=await env.api('/api/action',pending.body);assert.equal(exact.status,200);assert.equal(exact.body.revision,saved.revision);assert.equal(exact.body.state.points.length,saved.state.points.length);
    await award(page,'之后仍需家长验证',2);await submitEditor(page);await page.waitForSelector(SELECTORS.answer);assert.equal(await page.$(setupSelector),null);
    await click(page,'.sheet-footer '+action('parent-cancel'));await noSecrets(page,env,'first-business-completed-once');
  });
}
async function competitionCase() {
  await isolated({},async env=>{
    const first=await env.newPage(VIEWS[1],{pausePolls:true}),second=await env.newPage(VIEWS[1],{pausePolls:true});
    const initial=await env.snapshot();
    await config(first);await setPair(first,PIN);
    await award(second,'第二台设备的加分',6);await submitEditor(second);await setBusinessPair(second,OTHER);
    const hold=await holdAction(second,'parent.setup');await submitParent(second);const pending=await hold.arrived;
    await submitEditor(first);await finished(first);await pending.request.continue();await idle(second);await visibleError(second);await hold.dispose();
    const current=await env.snapshot();assert.equal(current.revision,initial.revision+1);assert.equal(current.state.points.length,initial.state.points.length);
    assert.equal(env.requests.filter(r=>r.page===second.__v8Id&&r.path==='/api/parent/verify').length,0,'A losing setup must not silently use its own PIN as a successful setup');
    await audit(second,'phone-setup-competition');await noSecrets(second,env,'losing-setup-competition');
    await closeHome(second);await award(second,'竞争后使用已设PIN',6);await submitEditor(second);await second.waitForSelector(SELECTORS.answer);
    await verify(second,PIN);await finished(second);assert.equal((await env.snapshot()).state.points.length,initial.state.points.length+1);
  });
  await isolated({},async env=>{
    const page=await env.newPage(VIEWS[1],{pausePolls:true});const initial=await env.snapshot();
    await award(page,'版本变化后重新确认',6);await submitEditor(page);await setBusinessPair(page,PIN);
    const updated=await env.api('/api/action',{revision:initial.revision,action:{id:'v8-public-during-pin-entry',type:'task.toggle',taskId:initial.state.tasks[0].id}});
    assert.equal(updated.status,200);await page.evaluate(()=>window.__v8Poll());
    await page.waitForFunction(rev=>window.FamilyDemo.getUI().revision===rev,{},updated.body.revision);
    await submitParent(page);await visibleError(page);await form(page,'points');
    assert.equal((await env.snapshot()).parent.configured,false);assert.equal(writes(env,'points.add').length,0);
    assert.equal(writes(env,'parent.setup')[0].body.revision,initial.revision,'Setup must use the original business confirmation revision');
    await audit(page,'phone-setup-stale-business');await noSecrets(page,env,'public-write-during-PIN-entry');
    assert.equal(await page.$eval('[name="reason"]',e=>e.value),reason);
    await submitEditor(page);await setBusinessPair(page,PIN);await submitParent(page);await finished(page);
    assert.equal((await env.snapshot()).state.points.length,initial.state.points.length+1);assert.equal(writes(env,'points.add').length,1);
  });
}
async function lostSetupCase() {
  await isolated({},async env=>{
    const page=await env.newPage(VIEWS[1],{pausePolls:true});const initial=await env.snapshot();
    await award(page,'响应丢失后的一次加分',8);await submitEditor(page);await setBusinessPair(page,PIN);
    const hold=await holdAction(page,'parent.setup',{holdStates:true});await submitParent(page);const pending=await hold.arrived;
    const committed=await env.api('/api/action',pending.body);assert.equal(committed.status,200);
    const publicWrite=await env.api('/api/action',{revision:committed.body.revision,action:{id:'v8-public-after-lost-setup',type:'task.toggle',taskId:initial.state.tasks[0].id}});
    assert.equal(publicWrite.status,200);
    await pending.request.abort('failed');await idle(page);await visibleError(page);
    assert.equal((await env.snapshot()).state.points.length,initial.state.points.length);
    await audit(page,'phone-setup-response-lost');await noSecrets(page,env,'setup-response-lost');
    assert.equal((await ui(page)).authPhase,'setup-retry');await submitParent(page);await finished(page);await hold.dispose();await connected(page);
    await form(page,'points');assert.equal((await env.snapshot()).parent.configured,true);
    assert.equal(writes(env,'points.add').length,0,'Intervening public commit must stop automatic continuation');
    assert.equal(env.requests.filter(r=>r.path==='/api/parent/verify').length,0);
    assert.equal(await page.$eval('[name="reason"]',e=>e.value),reason);
    assert.equal(Number(await page.$eval('[name="points"]',e=>e.value)),8);
    await audit(page,'phone-setup-recovered-stale-business');
    await submitEditor(page);await verify(page,PIN);await finished(page);
    const saved=await env.snapshot();assert.equal(saved.state.points.length,initial.state.points.length+1);assert.equal(Model.totals(saved.state).earned,Model.totals(initial.state).earned+8);
    assert.equal(writes(env,'points.add').length,1);
    const setupAttempts=writes(env,'parent.setup');assert.equal(setupAttempts.length,2);assert.ok(setupAttempts.every(r=>r.body.action.id===pending.body.action.id),'Uncertain setup retry must reuse its action id');
    await noSecrets(page,env,'setup-response-loss-recovered');
  });
}
async function lateSetupCase() {
  await isolated({},async env=>{
    const page=await env.newPage(VIEWS[1],{pausePolls:true});const initial=await env.snapshot();
    await award(page,'取消的首笔加分',9);await submitEditor(page);await setBusinessPair(page,PIN);
    const hold=await holdAction(page,'parent.setup');await submitParent(page);const pending=await hold.arrived;
    await click(page,'.sheet-footer '+action('parent-cancel'));await form(page,'points');
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/action'&&r.request().method()==='POST');
    await pending.request.continue();await response;await delay(200);await hold.dispose();
    assert.equal((await env.snapshot()).state.points.length,initial.state.points.length);assert.equal(writes(env,'points.add').length,0);
    assert.equal((await ui(page)).auth,false);assert.equal(await page.$eval('[name="reason"]',e=>e.value),reason);
    await noSecrets(page,env,'cancel-while-setup-response-pending');
    await page.reload({waitUntil:'load'});await connected(page);
    await config(page);assert.equal(await page.$eval('[name="pin"]',e=>e.value),'');await audit(page,'phone-late-setup-cancelled');
  });
}
async function offlineCase(protocol) {
  const context=await browser.createBrowserContext(),page=await context.newPage();
  let server;const errors=[],api=[];
  try {
    await page.setViewport({width:390,height:844,deviceScaleFactor:1});page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(/^https?:/.test(r.url())&&new URL(r.url()).pathname.startsWith('/api/'))api.push(r.url());});
    let url=pathToFileURL(path.join(ROOT,'export/little-steps-demo.html')).href;
    if(protocol==='http') {
      const html=fs.readFileSync(path.join(ROOT,'export/little-steps-demo.html'));
      server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);});
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));url='http://127.0.0.1:'+server.address().port;
    }
    await page.goto(url,{waitUntil:'load'});await page.waitForFunction(()=>window.FamilyDemo&&window.__FAMILY_OFFLINE__===true);
    const initial=await state(page);
    await config(page);await expectedSetup(page);await audit(page,'offline-'+protocol+'-settings-setup');
    await setPair(page,PIN,OTHER);await submitEditor(page);await visibleError(page);await noSecrets(page,null,'offline-'+protocol+'-mismatch');
    await setPair(page,PIN);await submitEditor(page);await finished(page);await page.reload({waitUntil:'load'});await page.waitForFunction(()=>window.FamilyDemo);
    await award(page,'离线首设后的加分',5);await submitEditor(page);await page.waitForSelector(SELECTORS.answer);assert.equal(await page.$(setupSelector),null);
    await verify(page,PIN);await finished(page);assert.equal((await state(page)).points.length,initial.points.length+1);
    await noSecrets(page,null,'offline-'+protocol+'-settings-complete');
    // Reset only this isolated offline browser storage to exercise the other first-use entry.
    await page.evaluate(()=>localStorage.clear());await page.reload({waitUntil:'load'});await page.waitForFunction(()=>window.FamilyDemo);
    const fresh=await state(page);await award(page,'离线首次加分',6);await submitEditor(page);await setBusinessPair(page,NEXT);await audit(page,'offline-'+protocol+'-business-setup');
    await submitParent(page);await finished(page);assert.equal((await state(page)).points.length,fresh.points.length+1);
    await page.reload({waitUntil:'load'});await page.waitForFunction(()=>window.FamilyDemo);assert.equal((await state(page)).points.length,fresh.points.length+1);
    await noSecrets(page,null,'offline-'+protocol+'-business-complete');assert.deepEqual(api,[]);assert.deepEqual(errors,[]);
  } finally {
    await context.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}report.errors.push(...errors);
  }
}
(async()=>{
  fs.mkdirSync(ARTIFACTS,{recursive:true});browser=await B.launch();
  try {
    await check('source','Current offline HTML embeds the exact current UI sources',sourceCase);
    for(const view of VIEWS)await check('settings',view[0]+': genuinely fresh settings, mismatch, cancellation, persistence and a protected award',()=>settingsCase(view));
    await check('configured','Existing 8-digit PIN, confirmed change, wrong old PIN, restart, forged unconfigured flag and new-only verification',configuredCase);
    await check('math','First arithmetic configuration and both PIN/arithmetic changes retain current authorization',mathCase);
    await check('first-action','First protected operation sets PIN twice and continues once; public action, cancellation and duplicate click remain safe',firstBusinessCase);
    await check('race','Two isolated devices race setup; the loser cannot continue using its own PIN',competitionCase);
    await check('loss','A committed setup with a lost browser response recovers without duplicating the original award',lostSetupCase);
    await check('late','Canceling while setup response is delayed cannot later commit the original business operation',lateSetupCase);
    for(const protocol of ['file','http'])await check('offline',protocol+': exported page first settings and first business setup persist without APIs',()=>offlineCase(protocol));
  } finally {
    await browser.close();report.finishedAt=new Date().toISOString();report.finalSources=sourceHashes();report.finalExportHash=hash('export/little-steps-demo.html');report.finalHarnessHash=hash('test/v8-browser.cjs');
    report.passed=report.results.filter(r=>r.passed).length;report.failed=report.results.length-report.passed;
    report.preservedV7={files:Object.keys(preservation).length,changed:preservedChanges()};
    report.sourceStable=JSON.stringify(report.sources)===JSON.stringify(report.finalSources)&&report.exportHash===report.finalExportHash&&report.harnessHash===report.finalHarnessHash;
    report.screenshotHashes=Object.fromEntries([...new Set(report.images.concat(report.previewImages))].map(name=>['artifacts/'+name,hash('artifacts/'+name)]));
    const suffix=wanted?'targeted-'+[...wanted].join('-'):'browser-results';
    fs.writeFileSync(path.join(ARTIFACTS,'v8-'+suffix+'.json'),JSON.stringify(report,null,2)+'\n');
    console.log(report.passed+' checks passed; '+report.failed+' failed; '+report.errors.length+' script errors. Source stable: '+report.sourceStable);
    process.exitCode=report.failed||report.errors.length||!report.sourceStable||report.preservedV7.changed.length?1:0;
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
