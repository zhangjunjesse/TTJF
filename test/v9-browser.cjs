'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const B=require('./browser.cjs');
const {ROOT,ARTIFACTS,Model,action,click,state,ui}=B;
const SAVE='.sheet-header button.sheet-save[type="submit"][form="editor-form"]';
const AUTH_SAVE='#parent-form button[type="submit"],button[type="submit"][form="parent-form"]';
const TILE='.picker-grid button[data-action="choose-point"]';
const ONLY=process.env.V9_CASES||'';
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,file))).digest('hex');
const hashes=()=>Object.fromEntries(['app.js','styles.css','index.html','model.js','server.cjs','test/v9-browser.cjs'].map(file=>[file,sha(file)]));
const report={scope:'App-style entry, back/draft, header save and real shared PIN-authorized persistence; no historical suite replay.',fixture:'Synthetic seed family on isolated temporary servers, explicitly configured with a test PIN; not first-use onboarding or the live family.',requested:ONLY||'all',startedAt:new Date().toISOString(),sources:hashes(),cases:[],screens:[],saves:[],errors:[]};
let browser;
function fixture(count=7){const data=Model.createSeed(new Date(B.FIXTURE_TIME));for(let i=data.pointItems.length+1;i<=count;i++)data.pointItems.push({id:'point-v9-'+i,name:'练习'+String(i).padStart(2,'0')+'：自己收好学习用品',points:5,reason:'完成后把用品放回原处',enabled:true});return Model.normalize(data);}
async function test(name,fn){if(ONLY&&!ONLY.split(',').some(part=>name.startsWith(part)))return;try{const detail=await fn();report.cases.push({name,result:'passed',detail});console.log('PASS '+name);}catch(error){report.cases.push({name,result:'failed',error:error.stack});throw error;}}
async function setup(width=390,height=844,count=7){const env=await B.createEnvironment(browser,{state:fixture(count)}),page=await env.newPage({width,height});await env.load(page);return{env,page};}
async function cleanup(env){report.errors.push(...env.errors);await env.close();}
async function typed(page,name,value){const selector=name.startsWith('#')?name:'#editor-form [name="'+name+'"]';await click(page,selector);await page.keyboard.down('Control');await page.keyboard.press('KeyA');await page.keyboard.up('Control');await page.keyboard.press('Backspace');await page.keyboard.type(String(value));assert.equal(await page.$eval(selector,e=>e.value),String(value));}
async function value(page,name){return page.$eval('#editor-form [name="'+name+'"]',e=>e.value);}
async function isVisible(page,selector){return page.evaluate(s=>{const e=document.querySelector(s);return !!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';},selector);}
async function shot(page,name){if(ONLY)return;const file='artifacts/v9-'+name+'.png';await page.screenshot({path:path.join(ROOT,file),fullPage:false});report.screens.push({file,sha256:sha(file)});}
async function audit(page,label,extra=''){
  const data=await page.evaluate(selector=>{
    const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};
    const selectorBase='.sheet-header button,.picker-grid button,#behavior-picker-footer button,#behavior-page,#behavior-search,.picker-search button';
    const controls=[...document.querySelectorAll(selectorBase+(selector?','+selector:''))].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden').map(e=>{const r=rect(e),hit=document.elementFromPoint(r.x+r.w/2,r.y+r.h/2);return{...r,label:e.getAttribute('aria-label')||e.innerText||e.name,disabled:e.disabled,hit:!!hit&&(hit===e||e.contains(hit))};});
    const panel=document.querySelector('.sheet');return{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,panel:panel?rect(panel):null,controls,inputs:[...document.querySelectorAll('.sheet input:not([type="hidden"]):not([type="checkbox"]),.sheet textarea,.sheet select')].filter(e=>e.getClientRects().length).map(e=>({name:e.name||e.id,font:parseFloat(getComputedStyle(e).fontSize)}))};
  },extra);
  assert.ok(data.scrollWidth<=data.width+1,label+' horizontal overflow');
  if(data.panel)assert.ok(data.panel.x>=-1&&data.panel.y>=-1&&data.panel.right<=data.width+1&&data.panel.bottom<=data.height+1,label+' panel clipped');
  for(const c of data.controls){assert.ok(c.w>=47.9&&c.h>=47.9,label+' target <48px '+JSON.stringify(c));assert.ok(c.x>=-1&&c.y>=-1&&c.right<=data.width+1&&c.bottom<=data.height+1,label+' control clipped '+JSON.stringify(c));if(!c.disabled)assert.ok(c.hit,label+' control obscured '+c.label);}
  for(const input of data.inputs)assert.ok(input.font>=16,label+' input font <16px '+input.name);
  return{width:data.width,height:data.height,minimumTarget:Math.min(...data.controls.flatMap(c=>[c.w,c.h])),minimumInputFont:data.inputs.length?Math.min(...data.inputs.map(i=>i.font)):null};
}
async function picker(page){await click(page,action('add-points'),{scroll:false});assert.equal((await ui(page)).form,'behaviorPicker');await B.delay(100);}
async function formContract(page){assert.ok(await page.$(SAVE),'Header must own the external form submit');assert.equal(await page.$eval(SAVE,e=>e.form&&e.form.id),'editor-form');assert.equal(await page.$$eval('#editor-form button[type="submit"]',e=>e.length),0);assert.equal(await page.$$eval('button[data-action="points-mode"]',e=>e.length),0);assert.match(await page.$eval(SAVE,e=>e.innerText.trim()),/^(加分|保存|确认|发送)$/);assert.ok(await page.$eval(SAVE,e=>!!e.getAttribute('aria-label')));}
async function submit(page,env,type,screenshot=false){
  const before=await state(page),revision=(await ui(page)).revision,start=env.requests.length;
  await click(page,SAVE,{scroll:false});await page.waitForFunction(()=>window.FamilyDemo.getUI().authPhase==='verify',{timeout:6000});
  assert.deepEqual(await state(page),before,'Header click must not bypass parent verification');if(screenshot)await shot(page,'parent-authorization');
  await typed(page,'#parent-form [name="answer"]',B.PIN);await click(page,AUTH_SAVE,{scroll:false});
  await page.waitForFunction(r=>{const x=window.FamilyDemo.getUI();return x.revision===r+1&&!x.auth&&!x.pending;},{timeout:6000},revision);
  const next=await state(page),persisted=(await env.api('/api/state')).body;
  assert.deepEqual(next,persisted.state,'Actual shared server state must match the UI');assert.equal(persisted.revision,revision+1);
  const posts=env.requests.slice(start);assert.deepEqual(posts.map(p=>p.path),['/api/parent/challenge','/api/parent/verify','/api/action']);assert.equal(posts.at(-1).body.action.type,type);
  report.saves.push({actionType:type,revisionBefore:revision,revisionAfter:persisted.revision,requestPaths:posts.map(p=>p.path),persisted:true});return next;
}
async function layouts(){
  for(const [name,width,height]of [['735',735,754],['390',390,844],['320',320,568]])await test(name+' App entry, back/draft, row navigation and touch sizing',async()=>{
    const{env,page}=await setup(width,height);try{
      const original=await state(page);await picker(page);assert.equal(await page.$$eval('button[data-action="points-mode"]',e=>e.length),0);assert.equal(await isVisible(page,'#behavior-search'),false);
      for(const name of ['points-new','picker-search','point-list'])assert.ok(await page.$('.sheet-header '+action(name)));
      const measurements=[await audit(page,'picker-'+width)];if(width===735)await shot(page,'picker-735');
      await click(page,'.sheet-header '+action('points-new'),{scroll:false});assert.equal((await ui(page)).form,'points');assert.equal(await value(page,'itemId'),'');await formContract(page);measurements.push(await audit(page,'new-points-'+width));assert.equal(await isVisible(page,'textarea[name="aiText"]'),false);if(width===390)await shot(page,'new-points-390');
      if(width===735){await typed(page,'name','往返保留的自定义加分');await typed(page,'reason','保留输入原因');await typed(page,'points','13');await click(page,action('ai-toggle'));assert.equal(await isVisible(page,'textarea[name="aiText"]'),true);await click(page,action('ai-toggle'));assert.equal(await value(page,'name'),'往返保留的自定义加分');}
      await B.closeSheet(page);assert.equal((await ui(page)).form,'behaviorPicker');assert.equal(await page.evaluate(()=>document.activeElement.dataset.action),'points-new');
      if(width===735){await click(page,'.sheet-header '+action('points-new'),{scroll:false});assert.equal(await value(page,'name'),'往返保留的自定义加分');assert.equal(await value(page,'points'),'13');assert.equal(await value(page,'reason'),'保留输入原因');await B.closeSheet(page);}
      const chosen=await page.$eval(TILE,e=>e.dataset.id);await click(page,TILE,{scroll:false});assert.equal(await value(page,'itemId'),chosen);await formContract(page);await B.closeSheet(page);assert.equal(await page.evaluate(()=>document.activeElement.dataset.id),chosen);
      await click(page,'.sheet-header '+action('point-list'),{scroll:false});assert.equal((await ui(page)).form,'point-list');assert.ok(await page.$('.sheet-header '+action('point-item-new')));measurements.push(await audit(page,'management-'+width));
      const row=await page.$eval('.manage-row',e=>({id:e.dataset.id,tag:e.tagName,w:e.getBoundingClientRect().width,parent:e.parentElement.getBoundingClientRect().width,h:e.getBoundingClientRect().height,nested:e.querySelectorAll('button').length}));assert.equal(row.tag,'BUTTON');assert.ok(row.w>=row.parent-2&&row.h>=48);assert.equal(row.nested,0);if(width===320)await shot(page,'management-320');
      await click(page,'.manage-row');assert.equal((await ui(page)).form,'pointItem');assert.equal(await value(page,'name'),original.pointItems.find(i=>i.id===row.id).name);await formContract(page);measurements.push(await audit(page,'edit-common-'+width));
      assert.equal(env.requests.length,0);assert.deepEqual(await state(page),original);return measurements;
    }finally{await cleanup(env);}
  });
}
async function main(){
  await layouts();
  await test('Custom points plus saved common item uses the actual PIN-authorized ledger',async()=>{
    const{env,page}=await setup();try{const before=await state(page);await picker(page);await click(page,'.sheet-header '+action('points-new'));
      await typed(page,'name','v9主动收好书桌');await typed(page,'points','13');await typed(page,'reason','完成后主动整理');await click(page,'.template-toggle');assert.equal((await ui(page)).saveAsTemplate,true);await formContract(page);
      const next=await submit(page,env,'points.add',true),entry=next.points.at(-1),item=next.pointItems.find(i=>i.id===entry.itemId);
      assert.equal(next.points.length,before.points.length+1);assert.equal(next.pointItems.length,before.pointItems.length+1);assert.equal(entry.name,'v9主动收好书桌');assert.equal(entry.points,13);assert.equal(item.name,entry.name);assert.equal(item.reason,entry.reason);assert.equal(item.points,13);assert.equal(Model.totals(next).available,Model.totals(before).available+13);await B.noSheet(page);
      await page.reload({waitUntil:'load'});await B.connected(page);assert.deepEqual(await state(page),next);return{availableDelta:13,newLedgerRecords:1,newCommonItems:1,reloadVerified:true};
    }finally{await cleanup(env);}
  });
  await test('Common-management header plus creates and authorizes a saved item',async()=>{
    const{env,page}=await setup();try{await picker(page);await click(page,'.sheet-header '+action('point-list'));await click(page,'.sheet-header '+action('point-item-new'));assert.equal((await ui(page)).form,'pointItem');await typed(page,'name','v9新的常用行为');await typed(page,'points','9');await typed(page,'reason','自己独立完成');await formContract(page);const next=await submit(page,env,'pointItem.save');assert.equal(next.pointItems.filter(i=>i.name==='v9新的常用行为'&&i.points===9).length,1);assert.equal((await ui(page)).form,'point-list');return{created:1};}finally{await cleanup(env);}
  });
  await test('Reminder header plus creates an authorized reminder',async()=>{
    const{env,page}=await setup();try{await B.navigate(page,'reminders');await audit(page,'reminder-header',action('task-new'));await click(page,action('task-new'),{scroll:false});assert.equal((await ui(page)).form,'task');await formContract(page);await typed(page,'title','v9明天整理书包');await typed(page,'note','检查水杯和作业');const next=await submit(page,env,'task.save');assert.equal(next.tasks.filter(t=>t.title==='v9明天整理书包'&&!t.deleted).length,1);return{created:1};}finally{await cleanup(env);}
  });
  await test('Existing reminder full-row entry saves through header and PIN',async()=>{
    const{env,page}=await setup();try{await B.navigate(page,'reminders');const rowSelector=action('task-edit','task-reading')+'.task-open';assert.ok(await page.$(rowSelector));const taskNoteLayout=await page.$eval(rowSelector,e=>{const time=e.querySelector('.task-time'),note=e.querySelector('.task-note');return{timeDisplay:getComputedStyle(time).display,noteDisplay:getComputedStyle(note).display,timeBottom:time.getBoundingClientRect().bottom,noteTop:note.getBoundingClientRect().top,noteText:note.textContent};});assert.equal(taskNoteLayout.timeDisplay,'block');assert.equal(taskNoteLayout.noteDisplay,'block');assert.ok(taskNoteLayout.noteTop>=taskNoteLayout.timeBottom,'Time and note must occupy separate lines');assert.ok(taskNoteLayout.noteText);await click(page,rowSelector);assert.equal((await ui(page)).form,'task');await formContract(page);await typed(page,'title','v9读书提醒已修改');const next=await submit(page,env,'task.save');assert.equal(next.tasks.find(t=>t.id==='task-reading').title,'v9读书提醒已修改');return{editedId:'task-reading',taskNoteLayout};}finally{await cleanup(env);}
  });
  await test('Rewards header plus creates an authorized gift',async()=>{
    const{env,page}=await setup();try{await click(page,action('jump-rewards'));assert.ok(await page.$('.sheet-header '+action('reward-list')));await click(page,'.sheet-header '+action('reward-new'),{scroll:false});await formContract(page);await typed(page,'name','v9彩色手账');await typed(page,'points','21');const next=await submit(page,env,'reward.save');assert.equal(next.rewards.filter(r=>r.name==='v9彩色手账'&&r.points===21).length,1);return{created:1};}finally{await cleanup(env);}
  });
  await test('Existing gift full-row management entry saves through header and PIN',async()=>{
    const{env,page}=await setup();try{await click(page,action('jump-rewards'));await click(page,'.sheet-header '+action('reward-list'));assert.ok(await page.$('.sheet-header '+action('reward-new')));await click(page,action('reward-edit','reward-pencil'));await formContract(page);await typed(page,'name','v9彩虹铅笔已修改');await typed(page,'points','17');const next=await submit(page,env,'reward.save');const gift=next.rewards.find(r=>r.id==='reward-pencil');assert.equal(gift.name,'v9彩虹铅笔已修改');assert.equal(gift.points,17);return{editedId:'reward-pencil'};}finally{await cleanup(env);}
  });
  await test('Search expansion, Chinese composition, clear and numeric last-page jump',async()=>{
    const{env,page}=await setup(735,754,80);try{await picker(page);await click(page,'.sheet-header '+action('picker-search'));const input=await page.$('#behavior-search'),cdp=await page.createCDPSession();
      try{for(const text of ['练习','练习08']){await cdp.send('Input.imeSetComposition',{text,selectionStart:text.length,selectionEnd:text.length});assert.equal(await input.evaluate(e=>e.isConnected&&document.activeElement===e),true);}await cdp.send('Input.insertText',{text:'练习08'});}finally{await cdp.detach();}
      assert.equal((await ui(page)).picker.total,1);assert.equal((await ui(page)).picker.items[0].id,'point-v9-8');await click(page,action('picker-clear'));assert.equal(await input.evaluate(e=>e.isConnected&&document.activeElement===e),true);await input.dispose();
      await click(page,'.sheet-header '+action('picker-search'));assert.equal(await isVisible(page,'#behavior-search'),false);const last=(await ui(page)).picker.pages;await typed(page,'#behavior-page',last);await page.keyboard.press('Enter');assert.equal((await ui(page)).picker.page,last-1);assert.equal((await ui(page)).picker.items.at(-1).id,'point-v9-80');await audit(page,'search-and-last-page');assert.equal(env.requests.length,0);return{lastPage:last,lastItem:'point-v9-80'};
    }finally{await cleanup(env);}
  });
}
(async()=>{browser=await B.launch();let failure;try{await main();assert.deepEqual(report.errors,[]);assert.deepEqual(hashes(),report.sources);report.sourceStable=true;}catch(error){failure=error;report.failure=error.stack;console.error(error);}finally{await browser.close();report.finishedAt=new Date().toISOString();report.passed=report.cases.filter(c=>c.result==='passed').length;report.failed=report.cases.filter(c=>c.result==='failed').length+(failure&&report.cases.every(c=>c.result!=='failed')?1:0);const suffix=ONLY?'probe-'+ONLY.toLowerCase().replace(/[^a-z0-9]+/g,'-'):'results';fs.writeFileSync(path.join(ARTIFACTS,'v9-'+suffix+'.json'),JSON.stringify(report,null,2)+'\n');if(failure)fs.writeFileSync(path.join(ARTIFACTS,'v9-failure-'+Date.now()+'.json'),JSON.stringify(report,null,2)+'\n');}if(failure)process.exitCode=1;else console.log(report.passed+' targeted checks passed; '+report.saves.length+' authorized saves; '+report.screens.length+' screenshots');})();
