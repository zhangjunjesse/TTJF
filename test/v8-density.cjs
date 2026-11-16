'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const B = require('./browser.cjs'), { createServer } = require('../server.cjs');
const { ROOT, ARTIFACTS, Model, action, click, ui, state } = B;
const MODE = process.argv[2], ONLY = process.env.DENSITY_ONLY || '', NOW = new Date(2026, 10, 16, 9, 12).getTime();
assert.ok(['--before', '--after'].includes(MODE), 'Pass --before or --after explicitly');
const OLD = 'export/little-steps-v8.html', NEW = 'export/little-steps-demo.html';
const OLD_HASH = '4053fbb2d189a973876edaf3dc68a509d177c316b4eb66e007e2ef9b2056b137';
const TILE = '.picker-grid button[data-action="choose-point"]';
const VIEWS = [['reported',735,754],['ipad-portrait',768,1024],['ipad-landscape',1024,768],['phone',390,844],['small-phone',320,568]];
const SOURCE_FILES = ['app.js','styles.css','index.html','server.cjs','model.js','assistant.js','assistant-service.cjs','pet.js','pet.css'];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,file))).digest('hex');
const jsonHash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const load = file => JSON.parse(fs.readFileSync(path.join(ROOT,file),'utf8'));
const save = (name,value) => fs.writeFileSync(path.join(ARTIFACTS,'v8-density-'+name+'.json'),JSON.stringify(value,null,2)+'\n');
const sourceHashes = () => Object.fromEntries(SOURCE_FILES.map(file=>[file,hash(file)]));
const report = {scope:'Only behavior-picker density and affected interactions; no replay of the prior 79 checks.',mode:MODE,startedAt:new Date().toISOString(),cases:[],screens:[],images:{},errors:[],posts:[],fixtures:[]};
let browser;
function fixture(count) {
  const value=Model.createSeed(new Date(NOW));
  const names=['自主阅读','专心完成作业','主动整理','关心家人','按时刷牙','练习跳绳','准备明天要用的书包和水杯'];
  value.pointItems=Array.from({length:count},(_,i)=>({id:'density-'+String(i+1).padStart(2,'0'),name:names[i]||'练习'+String(i+1).padStart(2,'0')+'：独立完成并整理自己的学习用品',points:[5,8,5,3,2,4,7][i%7],reason:'自己完成第'+(i+1)+'项，并把用品放回原处',enabled:true}));
  return Model.normalize(value);
}
function protectedHashes() {
  const files=[OLD,'test/v8-browser.cjs','test/v8-client.test.cjs'];
  function visit(directory) {for(const entry of fs.readdirSync(path.join(ROOT,directory),{withFileTypes:true})) {const file=directory+'/'+entry.name;if(entry.isDirectory())visit(file);else if(entry.name.startsWith('v8-')&&!entry.name.startsWith('v8-density-'))files.push(file);}}
  visit('artifacts'); return Object.fromEntries(files.map(file=>[file,hash(file)]));
}
async function environment(count, offline) {
  const value=fixture(count), directory=fs.mkdtempSync(path.join(os.tmpdir(),'family-density-')),dataFile=path.join(directory,'state.json');
  let server=null,origin=null,persistedHash=null;
  if(!offline) {
    fs.writeFileSync(dataFile,JSON.stringify({revision:1,state:value,parent:{configured:false,method:null},receipts:{}}));
    server=createServer({dataFile,now:()=>new Date(NOW)});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    origin='http://127.0.0.1:'+server.address().port;
    persistedHash=crypto.createHash('sha256').update(fs.readFileSync(dataFile)).digest('hex');
  }
  const context=await browser.createBrowserContext(),pages=[];
  const identity={count,mode:offline?'offline-file':'isolated-shared',stateHash:jsonHash(value)};report.fixtures.push(identity);
  async function pageAt(width,height) {
    const page=await context.newPage();pages.push(page);await page.setViewport({width,height,deviceScaleFactor:1});
    page.on('pageerror',error=>report.errors.push(error.message));
    page.on('request',request=>{if(request.method()==='POST')report.posts.push({url:request.url(),method:'POST'});});
    await page.evaluateOnNewDocument((milliseconds,initial,isOffline)=>{
      const NativeDate=Date;window.Date=class extends NativeDate {constructor(...args){super(...(args.length?args:[milliseconds]));}static now(){return milliseconds;}};
      if(isOffline)localStorage.setItem('little-steps-demo-v1',JSON.stringify(initial));
    },NOW,value,!!offline);
    await page.goto(offline?pathToFileURL(path.join(ROOT,offline)).href:origin,{waitUntil:'load'});
    await page.waitForFunction(()=>!!window.FamilyDemo);if(!offline)await B.connected(page);
    assert.deepEqual(await state(page),value,'The same complete fixture must reach the actual page');
    await click(page,action('all-behaviors'),{scroll:false});await B.delay(160);
    await page.waitForFunction(()=>window.FamilyDemo.getUI().form==='behaviorPicker');return page;
  }
  async function close() {
    for(const page of pages)if(!page.isClosed())assert.deepEqual(await state(page),value,'Picker interaction must not change household data');
    await context.close();
    if(server){assert.equal(crypto.createHash('sha256').update(fs.readFileSync(dataFile)).digest('hex'),persistedHash,'Read-only picker fixture changed on disk');server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('family-density-'));fs.rmSync(directory,{recursive:true,force:true});
  }
  return {pageAt,close,value};
}
async function measure(page,label) {
  const result=await page.evaluate(()=>{
    const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    const visible=e=>e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
    const panel=document.querySelector('.behavior-picker-sheet'),grid=document.querySelector('.picker-grid'),footer=document.getElementById('behavior-picker-footer');
    const controls=[...panel.querySelectorAll('button,input,select,textarea')].filter(visible).map(e=>{const r=box(e),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {...r,tag:e.tagName,id:e.id,action:e.dataset.action||'',label:e.getAttribute('aria-label')||e.innerText,disabled:!!e.disabled,font:parseFloat(getComputedStyle(e).fontSize),hit:!!hit&&(e===hit||e.contains(hit))};});
    return {viewport:{width:innerWidth,height:innerHeight},panel:box(panel),grid:{...box(grid),scrollHeight:grid.scrollHeight,clientHeight:grid.clientHeight},document:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},picker:window.FamilyDemo.getUI().picker,footerVisible:!!footer&&visible(footer),controls,cards:[...grid.querySelectorAll('button[data-action="choose-point"]')].map(e=>({...box(e),id:e.dataset.id,name:e.querySelector('b').innerText,text:e.innerText})),text:panel.innerText,focus:{id:document.activeElement.id,action:document.activeElement.dataset.action||'',dataId:document.activeElement.dataset.id||'',inside:panel.contains(document.activeElement)}};
  });
  result.label=label;return result;
}
function geometry(result,{compact=true}={}) {
  const {width,height}=result.viewport;
  assert.ok(result.document.width<=width+1&&result.document.height<=height+1,'Document overflow: '+result.label);
  assert.ok(result.panel.left>=-1&&result.panel.right<=width+1&&result.panel.top>=-1&&result.panel.bottom<=height+1,'Panel outside viewport: '+result.label);
  assert.ok(result.grid.scrollHeight<=result.grid.clientHeight+1,'Grid overflows available height: '+result.label);
  assert.equal(result.cards.length,result.picker.items.length);
  for(const item of result.controls){assert.ok(item.left>=-1&&item.top>=-1&&item.right<=width+1&&item.bottom<=height+1,'Clipped control: '+result.label+' '+JSON.stringify(item));assert.ok(item.width>=47.9&&item.height>=47.9,'Target below 48px: '+result.label+' '+JSON.stringify(item));if(!item.disabled)assert.ok(item.hit,'Obscured control: '+result.label+' '+item.label);if(item.tag!=='BUTTON')assert.ok(item.font>=16,'Input font below 16px');}
  for(const card of result.cards){assert.ok(card.height>=47.9);if(compact)assert.ok(card.height<=100,'Card still unnecessarily tall: '+result.label+' '+card.height);}
  if(compact)assert.equal(result.footerVisible,result.picker.pages>1,'Pagination visibility must match need');
}
async function screenshot(page,label,result) {
  const file='artifacts/v8-density-'+(ONLY?'probe-'+ONLY.toLowerCase().replace(/[^a-z]+/g,'-')+'-':'')+label+'.png';await page.screenshot({path:path.join(ROOT,file),fullPage:false});report.images[file]=hash(file);if(result)report.screens.push(result);return file;
}
async function typed(page,selector,value) {
  await click(page,selector,{scroll:false});await page.keyboard.down('Control');await page.keyboard.press('KeyA');await page.keyboard.up('Control');await page.keyboard.press('Backspace');await page.keyboard.type(String(value));assert.equal(await page.$eval(selector,e=>e.value),String(value));
}
async function jump(page,number) {
  await typed(page,'#behavior-page',number);const input=await page.$('#behavior-page');await page.keyboard.press('Enter');assert.equal(await input.evaluate(e=>e.isConnected&&document.activeElement===e),true,'Page Enter must retain the input and focus');await input.dispose();
}
async function tabsStayInside(page) {
  const count=await page.$$eval('.sheet button,.sheet input',items=>items.filter(e=>!e.disabled&&e.getClientRects().length).length);
  for(let index=0;index<count+2;index++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>{const e=document.activeElement;return !!e.closest('.sheet')&&e.getClientRects().length>0;}),true,'Tab escaped to hidden pagination or underlying page');}
}
async function check(name,fn) {
  if(ONLY&&!ONLY.split(',').some(part=>name.startsWith(part)))return;
  try {const detail=await fn();report.cases.push({name,result:'passed',detail});console.log('PASS '+name);}
  catch(error){report.cases.push({name,result:'failed',error:error.stack});console.error('FAIL '+name+' '+error.message);if(!ONLY)throw error;}
}
async function baseline() {
  assert.equal(hash(OLD),OLD_HASH);const env=await environment(7,OLD);
  try {const page=await env.pageAt(735,754),view=await measure(page,'before-735');geometry(view,{compact:false});assert.equal(view.cards.length,6);assert.equal(view.picker.pages,2);assert.equal(view.footerVisible,true);await screenshot(page,'before-735',view);report.before={html:OLD,hash:hash(OLD),fixtureHash:jsonHash(env.value),measurement:view};report.protected=protectedHashes();}
  finally {await env.close();}
}
async function after() {
  const before=load('artifacts/v8-density-before.json');report.sources=sourceHashes();report.exportHash=hash(NEW);report.harnessHash=hash('test/v8-density.cjs');report.baseline={hash:before.before.hash,fixtureHash:before.before.fixtureHash};
  await check('Frozen source/export and identical seven-item before fixture',async()=>{
    assert.equal(hash(OLD),OLD_HASH);assert.equal(jsonHash(fixture(7)),before.before.fixtureHash);
    for(const [name,value]of Object.entries(before.protected))assert.equal(hash(name),value,'Prior v8 evidence changed: '+name);
    const html=fs.readFileSync(path.join(ROOT,NEW),'utf8').replace(/\r\n/g,'\n');for(const file of ['app.js','styles.css','model.js','pet.js','pet.css']){const embedded=fs.readFileSync(path.join(ROOT,file),'utf8').replace(/\r\n/g,'\n').replace(/<\/script/gi,'<\\/script');assert.ok(html.includes(embedded),'Export is stale: '+file);}
    return {protectedFiles:Object.keys(before.protected).length};
  });
  const seven=await environment(7);
  try {for(const [name,width,height]of VIEWS)await check(name+': seven-item layout and keyboard focus',async()=>{
    const page=await seven.pageAt(width,height),view=await measure(page,'after-'+name);geometry(view);assert.equal(view.picker.total,7);
    if(width===735){assert.equal(view.cards.length,7);assert.equal(view.picker.pages,1);assert.ok(Math.max(...view.cards.map(c=>c.height))<Math.min(...before.before.measurement.cards.map(c=>c.height)));}
    await screenshot(page,'after-'+name,view);await tabsStayInside(page);return {cards:view.cards.length,pages:view.picker.pages,pageSize:view.picker.pageSize,cardHeight:view.cards.map(c=>c.height),panelHeight:view.panel.height};
  });}finally{await seven.close();}
  await check('24/80 items remain reachable with paging at normal and small sizes',async()=>{
    const observations=[];
    for(const [count,width,height]of [[24,735,754],[80,735,754],[80,320,568]]){
      const env=await environment(count);try{const page=await env.pageAt(width,height),seen=[];let last;
        while(true){last=await measure(page,'pages-'+count+'-'+width);geometry(last);seen.push(...last.cards.map(card=>card.id));if(last.picker.page+1===last.picker.pages)break;await click(page,action('picker-next'),{scroll:false});}
        assert.deepEqual(seen,env.value.pointItems.map(item=>item.id),'Every configured item must appear exactly once');
        if(count===80&&width===735)await screenshot(page,'eighty-last-page',last);
        if(last.picker.pages>1){await jump(page,1);assert.equal((await ui(page)).picker.page,0);await jump(page,last.picker.pages);assert.equal((await ui(page)).picker.items.at(-1).id,'density-'+String(count).padStart(2,'0'));}
        observations.push({count,width,height,pages:last.picker.pages,pageSize:last.picker.pageSize,visited:seen.length});
      }finally{await env.close();}
    }return observations;
  });
  await check('Chinese IME, empty/clear, Enter and blur-then-next keep stable inputs',async()=>{
    const env=await environment(80);try{const page=await env.pageAt(735,754);await typed(page,'#behavior-search','');const input=await page.$('#behavior-search'),cdp=await page.createCDPSession();
      try{for(const text of ['练习','练习08']){await cdp.send('Input.imeSetComposition',{text,selectionStart:text.length,selectionEnd:text.length});assert.equal(await input.evaluate(e=>e.isConnected&&document.activeElement===e),true);}await cdp.send('Input.insertText',{text:'练习08'});}finally{await cdp.detach();}
      assert.equal(await input.evaluate(e=>e.value),'练习08');assert.equal((await ui(page)).picker.total,1);geometry(await measure(page,'search-one'));await tabsStayInside(page);
      await typed(page,'#behavior-search','没有对应行为xyz');assert.equal((await ui(page)).picker.total,0);const empty=await measure(page,'empty-search');geometry(empty);await screenshot(page,'empty-search',empty);
      await click(page,'#behavior-picker-results '+action('picker-clear'),{scroll:false});assert.equal(await input.evaluate(e=>e.isConnected&&document.activeElement===e&&e.value===''),true);await input.dispose();
      await jump(page,2);await typed(page,'#behavior-page','2');await click(page,action('picker-next'),{scroll:false});assert.equal((await ui(page)).picker.page,2,'The first Next click after blur must not be swallowed');
      return {matched:'density-08',totalAfterClear:(await ui(page)).picker.total,firstNextAfterBlur:3};
    }finally{await env.close();}
  });
  await check('Selecting, returning and reselecting preserves the original form draft and focus',async()=>{
    const env=await environment(80);try{const page=await env.pageAt(390,844);await typed(page,'#behavior-search','练习');const last=(await ui(page)).picker.pages;await jump(page,last);
      await click(page,TILE+'[data-id="density-80"]',{scroll:false});assert.equal((await ui(page)).form,'points');assert.equal(await page.evaluate(()=>document.activeElement.name),'name');
      await B.fillForm(page,{points:13,reason:'密度验收保留的原始原因'});await click(page,action('points-mode','common'));
      assert.equal((await ui(page)).picker.query,'练习');assert.equal((await ui(page)).picker.page,last-1);await B.closeSheet(page);assert.equal((await ui(page)).form,'points');
      assert.equal(await page.$eval('[name="reason"]',e=>e.value),'密度验收保留的原始原因');assert.equal(await page.$eval('[name="points"]',e=>e.value),'13');
      await B.closeSheet(page);assert.equal((await ui(page)).form,'behaviorPicker');assert.equal((await ui(page)).picker.query,'练习');const focus=await page.evaluate(()=>{const e=document.activeElement;return {tag:e.tagName,id:e.id,dataId:e.dataset.id||'',action:e.dataset.action||'',inside:!!e.closest('.sheet')};});assert.equal(focus.dataId,'density-80','Returned focus: '+JSON.stringify(focus));
      await click(page,TILE+'[data-id="density-80"]',{scroll:false});assert.equal(await page.$eval('[name="reason"]',e=>e.value),'密度验收保留的原始原因');assert.equal(await page.$eval('[name="points"]',e=>e.value),'13');return {itemId:'density-80',retainedPoints:13};
    }finally{await env.close();}
  });
  await check('Orientation and short-height changes keep search focus and valid pagination',async()=>{
    const env=await environment(80);try{const page=await env.pageAt(390,844);await typed(page,'#behavior-search','练习');const input=await page.$('#behavior-search'),observations=[];
      for(const [width,height]of [[844,390],[768,1024],[320,568],[735,360]]){await page.setViewport({width,height,deviceScaleFactor:1});await B.delay(220);const view=await measure(page,'resize-'+width+'-'+height);geometry(view);assert.equal(await input.evaluate(e=>e.isConnected&&document.activeElement===e&&e.value==='练习'),true);observations.push({width,height,pageSize:view.picker.pageSize,pages:view.picker.pages});if(height===360)await screenshot(page,'short-screen',view);}
      await input.dispose();const last=(await ui(page)).picker.pages;await jump(page,last);const short=await measure(page,'short-last');geometry(short);assert.equal(short.picker.items.at(-1).id,'density-80');
      await typed(page,'#behavior-search','没有对应行为xyz');const empty=await measure(page,'short-empty');await screenshot(page,'short-empty',empty);geometry(empty);await click(page,'#behavior-picker-results '+action('picker-clear'),{scroll:false});assert.equal((await ui(page)).picker.total,80);return observations;
    }finally{await env.close();}
  });
  await check('Final offline export exposes the same seven-item compact picker',async()=>{
    const env=await environment(7,NEW);try{const page=await env.pageAt(735,754),view=await measure(page,'offline-after');geometry(view);assert.equal(view.cards.length,7);assert.equal(view.picker.pages,1);assert.equal(await page.evaluate(()=>window.__FAMILY_OFFLINE__),true);await screenshot(page,'offline-after',view);return {fixtureHash:jsonHash(env.value),cards:view.cards.length};}finally{await env.close();}
  });
  assert.deepEqual(sourceHashes(),report.sources);assert.equal(hash(NEW),report.exportHash);assert.equal(hash('test/v8-density.cjs'),report.harnessHash);
  for(const [name,value]of Object.entries(before.protected))assert.equal(hash(name),value,name);report.sourceStable=true;report.preservedPriorV8=Object.keys(before.protected).length;
}
(async()=>{
  browser=await B.launch();let failure;
  try{if(MODE==='--before')await baseline();else await after();assert.deepEqual(report.errors,[]);assert.deepEqual(report.posts,[]);}
  catch(error){failure=error;report.failure=error.stack;console.error(error);}
  finally{await browser.close();report.finishedAt=new Date().toISOString();report.requested=ONLY||'all';report.passed=report.cases.filter(item=>item.result==='passed').length;report.failed=report.cases.filter(item=>item.result==='failed').length+(failure&&report.cases.every(item=>item.result!=='failed')?1:0);save(MODE==='--before'?'before':ONLY?'probe-'+ONLY.toLowerCase().replace(/[^a-z]+/g,'-'):'results',report);if(failure||report.failed)save('failure-'+Date.now(),report);}
  if(failure||report.failed)process.exitCode=1;else console.log(MODE==='--before'?'Before captured from immutable v8 HTML':report.passed+' density checks passed; '+Object.keys(report.images).length+' screenshots; zero POST');
})();
