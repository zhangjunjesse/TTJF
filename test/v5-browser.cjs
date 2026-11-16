'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');
const B = require('./browser.cjs');
const { ROOT, ARTIFACTS, PIN, FIXTURE_TIME, SELECTORS, Model,
  action, click, fill, fillForm, state, ui, totals, connected, navigate,
  closeSheet, noSheet, verify, submitProtected, openCredit, reachable, bounded, delay } = B;
const { createAssistantService } = require('../assistant-service.cjs');
const snap = (page, name) => B.capture(page, name, 'v5');
const PUBLIC_BOUNDARY = 'Real Edge rendered DOM and hit-tested pointer coordinates; no physical iPad/Safari, software keyboard, microphone, audible playback, wake word or long-running-device evidence.';
const METADATA = 'V5_QA_ORIGINAL_METADATA_MUST_NOT_BE_SENT';
const output = path.join(ARTIFACTS, 'v5-browser-results.json');

async function form(page, expected) {
  await page.waitForFunction(name => window.FamilyDemo.getUI().form === name, {}, expected);
}
async function aiFill(page, context, text) {
  await fill(page, '[name="aiText"]', text);
  const remote = await page.evaluate(() => location.protocol !== 'file:' && window.__FAMILY_OFFLINE__ !== true);
  const response = remote ? page.waitForResponse(value => value.url().endsWith('/api/assistant') && value.request().method() === 'POST') : null;
  await click(page, action('ai-fill', context));
  if (response) { await response; }
  await page.waitForFunction(() => window.FamilyDemo.getUI().aiBusy === false);
}
async function pointsValue(page, value) {
  await page.waitForFunction(expected => Number(document.querySelector('[name="points"]')?.value) === expected, {}, value);
}
async function openRewards(page) {
  await click(page, action('jump-rewards'));
  await form(page, 'rewards');
}
async function growth(page) {
  return page.evaluate(() => window.FamilyModel.growth(window.FamilyDemo.getState()));
}
async function upload(page, filename) {
  const chooser = page.waitForFileChooser();
  await click(page, action('avatar-choose'));
  await (await chooser).accept([filename]);
}
async function avatarInfo(page, dataUrl) {
  return page.evaluate(source => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      resolve({ width: image.naturalWidth, height: image.naturalHeight,
        first: Array.from(context.getImageData(8, 8, 1, 1).data),
        last: Array.from(context.getImageData(image.naturalWidth - 9, image.naturalHeight - 9, 1, 1).data) });
    };
    image.onerror = reject; image.src = source;
  }), dataUrl);
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) { crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, content) {
  const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(content.length); crc.writeUInt32BE(crc32(Buffer.concat([name, content])));
  return Buffer.concat([length, name, content, crc]);
}
function pngFixture(width, height, extraBytes = 0) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const cropStart = (width - Math.min(width, height)) / 2;
  const leftColor = [220, 30, 40], rightColor = [30, 210, 50], centerColor = [35, 90, 220];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      const rgb = x < cropStart ? leftColor : x >= width - cropStart ? rightColor : centerColor;
      raw[offset] = rgb[0]; raw[offset + 1] = rgb[1]; raw[offset + 2] = rgb[2];
    }
  }
  const metadata = Buffer.concat([Buffer.from('Comment\0' + METADATA), Buffer.alloc(extraBytes, 65)]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('tEXt', metadata), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
function fixtures() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const files = {
    valid: path.join(ARTIFACTS, 'v5-avatar-source.png'),
    svg: path.join(ARTIFACTS, 'v5-avatar-rejected.svg'),
    large: path.join(ARTIFACTS, 'v5-avatar-over-8mib.png'),
    pixels: path.join(ARTIFACTS, 'v5-avatar-over-16mp.png')
  };
  fs.writeFileSync(files.valid, pngFixture(600, 400));
  fs.writeFileSync(files.svg, '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/></svg>');
  fs.writeFileSync(files.large, pngFixture(600, 400, 8 * 1024 * 1024));
  fs.writeFileSync(files.pixels, pngFixture(4001, 4001));
  return files;
}
function seeded(xp, kind = 'plant') {
  const value = Model.createSeed(new Date(FIXTURE_TIME));
  value.points = xp ? [{ id: 'fixture-earned', name: '成长阶段测试', points: xp, reason: '测试夹具中的累计积分', at: new Date(FIXTURE_TIME).toISOString() }] : [];
  value.redemptions = []; value.requests = []; value.appliedActions = [];
  value.pet = { kind, name: kind === 'plant' ? '芽芽' : '团团' };
  return value;
}
async function mockProvider() {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) { chunks.push(chunk); }
    calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: 'action', action: {
      type: 'points.add', payload: { name: '整理书包', points: 5, reason: '自己收好了书包' }
    } }) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, service: createAssistantService({ apiKey: 'qa-local-provider-only', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'qa-fixture' }),
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

const VIEWPORTS = [['wide',1920,1080],['desktop',1440,1000],['ipad-landscape',1024,768],['ipad-portrait',768,1024],['short-landscape',960,540],['phone',390,844],['short-phone',390,667],['small-phone',320,568]];

function stressState({ count = 4, long = false, due = false, pending = false, kind = 'plant' } = {}) {
  const value = seeded(128, kind), at = new Date(FIXTURE_TIME).toISOString();
  value.pointItems = Array.from({ length: count }, (_, index) => ({ id: 'qa-behavior-' + String(index + 1).padStart(2, '0'),
    name: '行为' + String(index + 1).padStart(2, '0') + (long ? '自己认真整理学习用品并主动帮助家人共同完成今天的计划'.repeat(3) : ''),
    points: 1 + index % 9, reason: long ? '这是长度压力测试中的预设原因，选择后仍需记录本次事实。' : '本次真实完成后的记录', enabled: true }));
  if (long) { value.childName = '小禾认真生活快乐成长'.repeat(4); value.pet.name = '团团陪伴每一次小进步'.repeat(4); }
  value.tasks = due ? value.tasks.filter(item => item.id === 'task-reading') : [];
  if (due && long) value.tasks[0].title = '今天需要完成的重要提醒与家人一起认真阅读并整理好书包'.repeat(3);
  if (pending) { const reward = value.rewards.find(item => item.id === 'reward-pencil');
    value.requests.push({ id: 'request-qa-pending', rewardId: reward.id, name: reward.name, points: reward.points,
      category: reward.category, status: 'pending', createdAt: at, updatedAt: at, redemptionId: '' }); }
  return Model.normalize(value);
}
async function geometry(page) {
  return page.evaluate(() => {
    const rect = element => { if (!element) return null; const r = element.getBoundingClientRect();
      return { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height }; };
    const clippedBy = (element, box) => { const bad=[]; for(let p=element.parentElement;p;p=p.parentElement) {
      const s=getComputedStyle(p),r=p.getBoundingClientRect();
      if ((/(hidden|clip|auto|scroll)/.test(s.overflowX) && (box.left < r.left-2 || box.right > r.right+2)) ||
          (/(hidden|clip|auto|scroll)/.test(s.overflowY) && (box.top < r.top-2 || box.bottom > r.bottom+2))) bad.push(p.id || p.className?.baseVal || p.className || p.tagName);
    } return bad; };
    const measure = selector => { const element=document.querySelector(selector); if(!element)return null;
      const style=getComputedStyle(element); return {...rect(element), clientWidth:element.clientWidth, clientHeight:element.clientHeight,
        scrollWidth:element.scrollWidth,scrollHeight:element.scrollHeight,scrollTop:element.scrollTop,
        overflowX:style.overflowX,overflowY:style.overflowY,transform:style.transform,zoom:style.zoom,
        contentWidth:element.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),
        contentHeight:element.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom) }; };
    const shape = selector => { const element=document.querySelector(selector); if(!element)return null;
      const b=element.getBBox(),m=element.getScreenCTM(); if(!m)return null;
      const corners=[[b.x,b.y],[b.x+b.width,b.y],[b.x,b.y+b.height],[b.x+b.width,b.y+b.height]].map(([x,y])=>({x:m.a*x+m.c*y+m.e,y:m.b*x+m.d*y+m.f}));
      const xs=corners.map(p=>p.x),ys=corners.map(p=>p.y),box={left:Math.min(...xs),top:Math.min(...ys),right:Math.max(...xs),bottom:Math.max(...ys)};
      box.width=box.right-box.left;box.height=box.bottom-box.top;
      return {...box,local:{x:b.x,y:b.y,width:b.width,height:b.height},clippedBy:clippedBy(element,box)};
    };
    const textInk = selector => { const el=document.querySelector(selector);if(!el)return null;
      const s=getComputedStyle(el),canvas=document.createElement('canvas').getContext('2d');
      canvas.font=[s.fontStyle,s.fontVariant,s.fontWeight,s.fontSize,s.fontFamily].join(' ');
      const m=canvas.measureText(el.textContent),marker=document.createElement('span');
      marker.style.cssText='display:inline-block;width:0;height:0;line-height:0;padding:0;border:0;vertical-align:baseline';
      el.appendChild(marker);const baseline=marker.getBoundingClientRect().top;marker.remove();
      return {top:baseline-m.actualBoundingBoxAscent,bottom:baseline+m.actualBoundingBoxDescent,baseline,ascent:m.actualBoundingBoxAscent,descent:m.actualBoundingBoxDescent,font:s.fontSize,lineHeight:s.lineHeight};
    };
    const controls=Array.from(document.querySelectorAll('button')).filter(el=>!el.closest('.sheet')).map(el=> {
      const r=rect(el),style=getComputedStyle(el); if(!r.width||!r.height||style.display==='none'||style.visibility==='hidden')return null;
      const hits=[[.5,.5],[.25,.5],[.75,.5],[.5,.25],[.5,.75]].map(([x,y])=>{const hit=document.elementFromPoint(r.left+r.width*x,r.top+r.height*y);return !!hit&&(hit===el||el.contains(hit));});
      return {...r,action:el.dataset.action,id:el.dataset.id||'',text:el.textContent.trim().slice(0,60),disabled:el.disabled,
        hit:hits.every(Boolean),inViewport:r.left>=-1&&r.top>=-1&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,clippedBy:clippedBy(el,r)};
    }).filter(Boolean);
    const main=measure('#main'),home=measure('.interaction-home, .growth-home'),svg=document.querySelector('.companion-card svg.pet-scene');
    return {viewport:{width:innerWidth,height:innerHeight},html:measure('html'),body:measure('body'),main,home,
      fill:home&&main?{width:home.width/main.contentWidth,height:home.height/main.contentHeight}:null,
      scene:measure('.companion-card svg.pet-scene'),character:shape('.companion-card g.pet-character'),
      legacyCharacter:shape('.companion-card g.pet-character-motion'),reaction:shape('.companion-card g.pet-reaction-art'),
      accessories:shape('.companion-card g.pet-accessories'),costume:shape('.companion-card g.pet-costume-back'),support:shape('.companion-card g.pet-support'),
      balance:measure('[data-testid="available-points"]'),toast:measure('#toast.visible'),feedback:measure('#home-feedback'),feedbackInk:textInk('#home-feedback'),
      feedbackActive:document.querySelector('#home-feedback')?.dataset.feedback==='true',feedbackText:document.querySelector('#home-feedback')?.textContent||'',
      pet:svg?{kind:svg.dataset.petKind,stage:svg.dataset.petStage,framing:svg.dataset.petFraming}:null,
      controls,behaviors:controls.filter(x=>x.action==='choose-point').map(x=>x.id)};
  });
}
async function settle(page) {
  await page.waitForFunction(()=>window.FamilyDemo && document.querySelector('#main'));
  await page.waitForFunction(()=>Math.abs(document.querySelector('.bottom-nav').getBoundingClientRect().bottom-innerHeight)<=1,{timeout:3000});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}
async function runProbe() {
  const browser=await B.launch(),env=await B.createEnvironment(browser,{state:stressState({count:24,long:true,due:true,pending:true}),assistantService:createAssistantService({apiKey:''})});
  try { for(const [name,width,height] of VIEWPORTS) {
    const page=await env.newPage({width,height}); await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]); await env.load(page);await settle(page);
    const g=await geometry(page);console.log(JSON.stringify({name,viewport:g.viewport,main:g.main,home:g.home,fill:g.fill,scene:g.scene,character:g.character,
      controls:g.controls.map(x=>({action:x.action,id:x.id,w:x.width,h:x.height,top:x.top,bottom:x.bottom,hit:x.hit,clippedBy:x.clippedBy}))})); await page.close();
  }} finally {await env.close();await browser.close();}
}
async function runBaseline() {
  const baseline=path.join(ARTIFACTS,'v5-baseline-v4.html'),sha=crypto.createHash('sha256').update(fs.readFileSync(baseline)).digest('hex');
  assert.equal(sha,'60eb3f4a65f3ce3cf23b0a878f81ea9226d61c30845febdba933ae55a554a69b');
  const report={version:'v4 baseline for v5',hash:sha,at:new Date().toISOString(),boundary:'Frozen final v4 offline source, synthetic fixtures. Legacy actor geometry includes pot/accessories and is an upper bound, not the new strict body group.',cases:[]},browser=await B.launch();
  try {for(const [name,width,height] of VIEWPORTS) for(const variant of ['seed','stress']) {
    const context=await browser.createBrowserContext(),page=await context.newPage();await page.setViewport({width,height});
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
    await page.evaluateOnNewDocument((snapshot,ms)=>{const D=Date;window.Date=class extends D{constructor(...args){super(...(args.length?args:[ms]));}static now(){return ms;}};localStorage.setItem('little-steps-demo-v1',JSON.stringify(snapshot));},stressState(variant==='seed'?{}:{count:24,long:true,due:true,pending:true,kind:'capybara'}),FIXTURE_TIME);
    await page.goto(pathToFileURL(baseline).href,{waitUntil:'load'});await settle(page);const g=await geometry(page);
    report.cases.push({name,variant,...g});await snap(page,'baseline-'+name+'-'+variant);
    console.log(JSON.stringify({name,variant,mainScroll:g.main.scrollHeight-g.main.clientHeight,fill:g.fill,legacyBodyHeight:g.legacyCharacter?.height,hiddenControls:g.controls.filter(x=>!x.hit||!x.inViewport||x.clippedBy.length).map(x=>x.action+':'+x.id)}));
    await context.close();
  }} finally {await browser.close();fs.writeFileSync(path.join(ARTIFACTS,'v5-baseline-results.json'),JSON.stringify(report,null,2));}
}

function rankingState() {
  const value=stressState({count:8}),h=3600000;value.points=[];value.pointItems[7].enabled=false;
  const add=(n,hours,points=1)=>value.points.push({id:'history-'+value.points.length,itemId:'qa-behavior-'+String(n).padStart(2,'0'),name:'历史名称可以不同',points,reason:'隔离测试中的成功记录',at:new Date(FIXTURE_TIME-hours*h).toISOString()});
  [48,24,2].forEach(hours=>add(3,hours));[72,1].forEach(hours=>add(1,hours));[96,5].forEach(hours=>add(2,hours,40));
  add(5,6);add(6,6);add(7,31*24);add(7,-1/3600);for(let n=0;n<8;n++)add(8,n);
  value.points.push({id:'unattributed',name:value.pointItems[3].name,points:4,reason:'同名但没有itemId，不计入常用次数',at:new Date(FIXTURE_TIME).toISOString()});
  return Model.normalize(value);
}
function assertHome(g, expectedCount) {
  assert.ok(g.main && g.home && g.character && g.scene, 'Real home and separately measurable character must exist');
  for (const name of ['html','body','main','home']) {
    const box=g[name]; assert.ok(box.scrollHeight<=box.clientHeight+2,name+' must not scroll or conceal vertical overflow: '+JSON.stringify(box));
    assert.ok(box.scrollWidth<=box.clientWidth+2,name+' must not conceal horizontal overflow');
    if(name!=='home')assert.equal(box.transform,'none','Do not scale the page to fit');
    assert.ok(!box.zoom || Number(box.zoom)===1,'Do not zoom the page to fit');
  }
  assert.ok(Math.abs(g.home.width-g.main.contentWidth)<=2,'Home must fill main content width: '+JSON.stringify(g.fill));
  assert.ok(Math.abs(g.home.height-g.main.contentHeight)<=2,'Home must fill main content height: '+JSON.stringify(g.fill));
  const max=g.viewport.width>=900&&g.viewport.width>g.viewport.height?4:2;
  assert.equal(g.behaviors.length,Math.min(expectedCount,max),'Home shows only the bounded frequent prefix');
  const required=['profile-edit','add-points','jump-rewards','all-behaviors','pet-config','pet-touch','pet-growth'];
  for(const name of required)assert.ok(g.controls.some(x=>x.action===name),'Missing visible core action '+name);
  assert.equal(g.controls.filter(x=>x.action==='pet-interact').length,3);
  for(const button of g.controls) {
    assert.ok(button.inViewport&&button.hit&&!button.clippedBy.length,'Control is clipped or obscured: '+JSON.stringify(button));
    assert.ok(button.width>=47.5&&button.height>=47.5,'Home hit target must be at least 48px: '+JSON.stringify(button));
  }
  assert.equal(g.pet.framing,'hero','Home must use the close-up rendering');
  assert.ok(!g.character.clippedBy.length,'Body cannot be clipped: '+JSON.stringify(g.character));
  assert.ok(g.character.left>=g.scene.left-2&&g.character.right<=g.scene.right+2&&g.character.top>=g.scene.top-2&&g.character.bottom<=g.scene.bottom+2,'Body must remain inside the rendered scene');
  const floor=g.viewport.width===1024&&g.viewport.height===768?240:g.viewport.width===390&&g.viewport.height===844?170:g.viewport.width===320?100:0;
  if(Number(g.pet.stage)===3&&floor)assert.ok(g.character.height>=floor,'Actual body height '+g.character.height+' is below '+floor);
}
function assertPetGeometry(g, reaction = false) {
  assert.ok(g.scene && g.character && g.pet.framing==='hero','Scene and strict body group must exist in hero framing');
  const shapes=(reaction?['character','reaction']:['character']).concat(['accessories','costume','support'].filter(key=>g[key]&&g[key].width>0&&g[key].height>0));
  for(const key of shapes) {
    const box=g[key];assert.ok(box&&box.width>0&&box.height>0,'Missing visible '+key);
    assert.ok(!box.clippedBy.length,key+' clipped by '+JSON.stringify(box));
    assert.ok(box.left>=g.scene.left-2&&box.right<=g.scene.right+2&&box.top>=g.scene.top-2&&box.bottom<=g.scene.bottom+2,key+' extends outside scene: '+JSON.stringify(box));
  }
  const floor=g.viewport.width===1024&&g.viewport.height===768?240:g.viewport.width===390&&g.viewport.height===844?170:g.viewport.width===320?100:0;
  if(Number(g.pet.stage)===3&&floor)assert.ok(g.character.height>=floor,'Actual body height '+g.character.height+' below '+floor);
}
function assertFeedbackVisible(g) {
  assert.ok(g.balance&&g.balance.width>0&&g.balance.height>0,'Updated balance must be visible on home');
  assert.ok(g.feedbackActive&&g.feedback&&g.feedback.height>=16&&g.feedback.width>=48,'Visible in-place success feedback must remain beside growth');
  assert.ok(g.feedback.scrollWidth<=g.feedback.clientWidth+2,'The compact success message must be readable without horizontal ellipsis');
  assert.ok(g.feedbackInk&&g.feedbackInk.top>=g.feedback.top-1&&g.feedbackInk.bottom<=g.feedback.bottom+1,'Actual text ink, measured from the DOM baseline, must fit the clipped feedback line');
  assert.match(g.feedbackText,/6/,'The just-saved +6 award has explicit feedback');
  if(!g.toast)return;
  const intersects=box=>box&&Math.min(box.right,g.toast.right)>Math.max(box.left,g.toast.left)&&Math.min(box.bottom,g.toast.bottom)>Math.max(box.top,g.toast.top);
  const core=new Set(['add-points','jump-rewards','choose-point','pet-interact','nav','all-behaviors']);
  const blocked=[{name:'updated balance',box:g.balance},{name:'character body',box:g.character}]
    .concat(g.controls.filter(x=>core.has(x.action)).map(x=>({name:x.action+':'+x.id,box:x}))).filter(x=>intersects(x.box));
  assert.deepEqual(blocked,[],'Success notification must not visually cover balance, body or core actions (pointer-events:none does not prove visibility)');
}
async function inboxAt(page,count) {
  await page.waitForFunction(n=>window.FamilyDemo.getUI().inboxCount===n,{},count);await form(page,'homeInbox');
  assert.ok((await page.$eval('#sheet-title',el=>el.textContent)).includes(String(count)),'Remaining count must be visible in the inbox title');
  await page.waitForFunction(()=>!!document.activeElement.closest('.sheet'));
}
async function typed(page,selector,text) {
  await click(page,selector);await page.keyboard.down('Control');await page.keyboard.press('KeyA');await page.keyboard.up('Control');await page.keyboard.press('Backspace');await page.keyboard.type(String(text));
  assert.equal(await page.$eval(selector,e=>e.value),String(text),'Typing must not lose focus or characters');
}
async function chineseSearch(page,text) {
  await typed(page,'#behavior-search',''); const handle=await page.$('#behavior-search'),cdp=await page.createCDPSession();
  try {for(const part of [text.slice(0,2),text]) {await cdp.send('Input.imeSetComposition',{text:part,selectionStart:part.length,selectionEnd:part.length});
    assert.equal(await handle.evaluate(el=>el.isConnected&&document.activeElement===el),true,'Composition must not replace or blur the input');
  }await cdp.send('Input.insertText',{text});}finally{await handle.dispose();await cdp.detach();}
  assert.equal(await page.$eval('#behavior-search',el=>el.value),text);
}
async function pointManager(page) {
  const direct=await B.metrics(page,action('point-list'));
  if(!direct.some(x=>x.inViewport&&x.reachable)){await click(page,action('all-behaviors'),{scroll:false});await form(page,'behaviorPicker');}
  await click(page,action('point-list'));await form(page,'point-list');
}
async function runSuite() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const selected = process.env.V5_GROUPS ? process.env.V5_GROUPS.split(',').map(value => value.trim()).filter(Boolean) : null;
  const hash = name => fs.existsSync(path.join(ROOT, name)) ? crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, name))).digest('hex') : null;
  const report = { version: '0.5', browser: 'Microsoft Edge / Chromium, real DOM and hit-tested mouse',
    deviceBoundary: PUBLIC_BOUNDARY, assistantBoundary: 'Local instruction demonstration; a separately labelled loopback mock provider verifies outbound privacy. Neither is a real external LLM run.',
    fixtureBoundary: 'Fixed/accelerated clock; synthetic avatar with tagged metadata; isolated real HTTP servers and real model state. Stage gallery uses controlled starting ledgers, never claims user-earned points.',
    startedAt: new Date().toISOString(), requested: selected || 'all',
    sourceHashes: Object.fromEntries(['app.js', 'model.js', 'server.cjs', 'assistant.js', 'assistant-service.cjs', 'styles.css', 'pet.js', 'pet.css', 'index.html'].map(name => [name, hash(name)])),
    exportHash: hash('export/little-steps-demo.html'), harnessHash: hash('test/v5-browser.cjs'), checks: [], failed: [], errors: [], layouts: [], stress: [], portraits: [], reactions: [], feedback: [], skipped: [] };
  const browser = await B.launch();
  let groupName = '', current;
  async function check(label, run) {
    try { await run(); report.checks.push({ group: groupName, label }); console.log('PASS ' + groupName + ': ' + label); }
    catch (error) { error.check = label; throw error; }
  }
  async function group(name, run, options = {}) {
    if (selected && !selected.includes(name)) { return; }
    groupName = name;
    const env = await B.createEnvironment(browser, { ...options,
      assistantService: options.assistantService || createAssistantService({ apiKey: '' }) });
    try {
      current = await env.newPage(); await env.load(current);
      await run(env, current, check);
      assert.deepEqual(env.errors, [], 'No uncaught page script errors');
    } catch (error) {
      report.failed.push({ group: name, check: error.check || 'setup', message: error.message, stack: error.stack });
      console.error('FAIL ' + name + ': ' + error.message);
      if (current && !current.isClosed()) { await snap(current, name + '-failure').catch(() => {}); }
    } finally { report.errors.push(...env.errors.map(message => ({ group: name, message }))); await env.close(); current = null; }
  }
  try {
    await group('layout', async (env, unused, check) => {
      for (const [name,width,height] of VIEWPORTS) {
        const page=await env.newPage({width,height});current=page;await env.load(page);await settle(page);
        await check(name+': home fills the available viewport and every main action is directly hittable',async()=>{
          const g=await geometry(page);report.layouts.push({name,...g});assertHome(g,4);
          assert.equal(await page.$$('.bottom-nav [data-action="nav"]').then(x=>x.length),2);
          await snap(page,name+'-points');
          await click(page,action('all-behaviors'),{scroll:false});await form(page,'behaviorPicker');await closeSheet(page);await noSheet(page);
          await openRewards(page);await click(page,action('redeem','reward-pencil'));await form(page,'request');await reachable(page,SELECTORS.submit);
          await closeSheet(page);await form(page,'rewards');await closeSheet(page);await noSheet(page);
          await click(page,action('records'),{scroll:false});await reachable(page,SELECTORS.close);await closeSheet(page);await noSheet(page);
          await click(page,action('pet-growth'),{scroll:false});await reachable(page,SELECTORS.close);await closeSheet(page);await noSheet(page);
          await navigate(page,'reminders');await bounded(page);await reachable(page,SELECTORS.nav);
          await click(page,action('task-new'));await reachable(page,SELECTORS.submit);await closeSheet(page);await noSheet(page);await snap(page,name+'-reminders');
        });
        await check(name+': profile, partner settings and award sheets remain reachable and inputs stay at least 16px',async()=>{
          await navigate(page,'points');await click(page,action('profile-edit'),{scroll:false});await reachable(page,SELECTORS.close);await reachable(page,SELECTORS.submit);
          const chooser=page.waitForFileChooser();await click(page,action('avatar-choose'));await(await chooser).cancel();await closeSheet(page);await noSheet(page);
          await click(page,action('pet-config'),{scroll:false});await reachable(page,SELECTORS.submit);await closeSheet(page);await noSheet(page);
          await click(page,action('add-points'),{scroll:false});await click(page,action('ai-fill','points'));
          const small=await page.$$eval('.sheet input,.sheet textarea,.sheet select',els=>els.filter(el=>el.getBoundingClientRect().width>0&&parseFloat(getComputedStyle(el).fontSize)<16).map(el=>el.name));
          assert.deepEqual(small,[]);await reachable(page,SELECTORS.submit);await closeSheet(page);await noSheet(page);
          await pointManager(page);await reachable(page,SELECTORS.close);await closeSheet(page);
          while((await ui(page)).form){await closeSheet(page);}await noSheet(page);
        });await page.close();
      }
    });
    await group('stress',async(unusedEnv,unusedPage,check)=>{
      for(const [name,width,height] of VIEWPORTS) await check(name+': 0/1/4/24 long-name behaviors × four reminder/request states keep all home actions visible',async()=>{
        const failures=[];
        for(const count of [0,1,4,24])for(const status of ['none','due','pending','both']){
          const fixture=stressState({count,long:true,due:status==='due'||status==='both',pending:status==='pending'||status==='both',kind:count===24?'capybara':'plant'});
          const env=await B.createEnvironment(browser,{state:fixture,assistantService:createAssistantService({apiKey:''})});let page;
          try{page=await env.newPage({width,height});current=page;await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);await env.load(page);await settle(page);
            const g=await geometry(page);report.stress.push({name,count,status,longNames:true,...g});
            if(count===24&&status==='both')await snap(page,'stress-'+name+'-24-both');
            assertHome(g,count);assert.deepEqual(g.behaviors,fixture.pointItems.slice(0,g.behaviors.length).map(x=>x.id));
            if(status!=='none')assert.ok(g.controls.some(x=>x.action==='home-inbox'),'Reminder/request needs a visible entry');
            assert.deepEqual(env.errors,[]);
          }catch(error){failures.push({count,status,message:error.message});if(page&&!page.isClosed()&&failures.length===1)await snap(page,'stress-'+name+'-failure');}
          finally{report.errors.push(...env.errors.map(message=>({group:'stress',name,count,status,message})));await env.close();}
        }assert.deepEqual(failures,[],'Stress matrix failures: '+JSON.stringify(failures));
      });
    });
    await group('picker',async(unusedEnv,unusedPage,check)=>{
      for(const [name,width,height]of VIEWPORTS)await check(name+': Chinese search, empty/clear, paging, cancel and verified last-item award return to visible home feedback',async()=>{
        const fixture=stressState({count:24,long:true,due:true,pending:true}),env=await B.createEnvironment(browser,{state:fixture,assistantService:createAssistantService({apiKey:''})});let page;
        try{page=await env.newPage({width,height});current=page;await env.load(page);await settle(page);const before=await totals(page);
          await click(page,action('all-behaviors'),{scroll:false});await form(page,'behaviorPicker');
          const pageSize=(await ui(page)).picker.pageSize,lastPage=Math.ceil(24/pageSize);
          assert.ok(pageSize>=1&&pageSize<=6);assert.equal((await ui(page)).picker.total,24);
          assert.equal(await page.$$eval('.sheet button[data-action="choose-point"]',els=>els.length),pageSize);
          await chineseSearch(page,'行为24');await page.waitForFunction(()=>document.querySelectorAll('.sheet button[data-action="choose-point"]').length===1);
          assert.equal(await page.$eval('.sheet button[data-action="choose-point"]',el=>el.dataset.id),'qa-behavior-24');
          await typed(page,'#behavior-search','no-match-xyz');assert.equal(await page.$$eval('.sheet button[data-action="choose-point"]',els=>els.length),0);
          await click(page,'#behavior-picker-results '+action('picker-clear'));await page.waitForFunction(n=>document.querySelectorAll('.sheet button[data-action="choose-point"]').length===n,{},pageSize);
          await reachable(page,action('picker-next'));await click(page,action('picker-next'),{scroll:false});
          assert.equal(await page.$eval('.sheet button[data-action="choose-point"]',el=>el.dataset.id),'qa-behavior-'+String(pageSize+1).padStart(2,'0'));
          await click(page,action('picker-prev'),{scroll:false});assert.equal(await page.$eval('.sheet button[data-action="choose-point"]',el=>el.dataset.id),'qa-behavior-01');
          await typed(page,'#behavior-page','2');const numberInput=await page.$('#behavior-page');await page.keyboard.press('Enter');
          assert.equal(await numberInput.evaluate(el=>el.isConnected&&document.activeElement===el),true,'Enter must retain the number input and focus');await numberInput.dispose();
          await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement.closest('.sheet')),true,'Tab after page commit must stay inside the dialog');
          await typed(page,'#behavior-page','2');await click(page,action('picker-next'),{scroll:false});
          assert.equal(await page.$eval('#behavior-page',el=>Number(el.value)),3,'Blurring a page input must not swallow the following Next click');
          assert.equal(await page.$eval('.sheet button[data-action="choose-point"]',el=>el.dataset.id),'qa-behavior-'+String(pageSize*2+1).padStart(2,'0'));
          await typed(page,'#behavior-page',lastPage);await page.keyboard.press('Enter');
          await page.waitForSelector('.sheet button[data-action="choose-point"][data-id="qa-behavior-24"]');
          await snap(page,'picker-'+name+'-last-page');await click(page,'.sheet '+action('choose-point','qa-behavior-24'));await form(page,'points');await pointsValue(page,6);
          await fillForm(page,{reason:'第24项取消后继续的真实事实'});await closeSheet(page);await form(page,'behaviorPicker');
          assert.equal(await page.$eval('#behavior-page',el=>Number(el.value)),lastPage);assert.deepEqual(await totals(page),before);
          await closeSheet(page);await noSheet(page);assert.equal((await geometry(page)).behaviors[0],'qa-behavior-01','Opening/cancelling must not alter frequency');
          await click(page,action('all-behaviors'),{scroll:false});await form(page,'behaviorPicker');await typed(page,'#behavior-search','24');
          await click(page,'.sheet '+action('choose-point','qa-behavior-24'));await form(page,'points');await pointsValue(page,6);
          await fillForm(page,{reason:'最后一项已真正完成，验证后才加分'});await click(page,SELECTORS.submit,{scroll:false});await verify(page,'000000');assert.deepEqual(await totals(page),before);
          await verify(page);await noSheet(page);await settle(page);assert.equal((await ui(page)).view,'points');
          const after=await totals(page);assert.equal(after.earned,before.earned+6);assert.equal(after.available,before.available+6);
          const saved=(await state(page)).points.find(x=>x.reason==='最后一项已真正完成，验证后才加分');assert.equal(saved.itemId,'qa-behavior-24');
          const g=await geometry(page);report.feedback.push({name,before:before.available,after:after.available,...g});assertHome(g,24);assertFeedbackVisible(g);assert.equal(g.behaviors[0],'qa-behavior-24');
          assert.equal(Number(await page.$eval('[data-testid="available-points"]',el=>el.textContent)),after.available);
          await page.waitForSelector('.companion-card svg[data-pet-reaction="celebrate"]');
          await snap(page,'picker-'+name+'-saved-home');assert.deepEqual(env.errors,[]);
        }catch(error){if(page&&!page.isClosed())await snap(page,'picker-'+name+'-failure');throw error;}finally{report.errors.push(...env.errors.map(message=>({group:'picker',name,message})));await env.close();}
      });
    });

    for(const [name,width,height] of VIEWPORTS) await group('inbox',async(env,page,check)=>{
      await page.setViewport({width,height});await settle(page);
      await check(name+': compact inbox opens real reminders and pending approval without expanding home',async()=>{
        const before=await totals(page);await click(page,action('home-inbox'),{scroll:false});await form(page,'homeInbox');
        await click(page,'.sheet '+action('task-ack','task-reading'));await inboxAt(page,3);assert.ok((await state(page)).tasks.find(x=>x.id==='task-reading').ackAt);
        await click(page,'.sheet '+action('task-snooze','task-qa-snooze'));await inboxAt(page,2);assert.ok((await state(page)).tasks.find(x=>x.id==='task-qa-snooze').snoozeUntil);
        await click(page,'.sheet '+action('task-toggle','task-qa-complete'));await inboxAt(page,1);assert.equal((await state(page)).tasks.find(x=>x.id==='task-qa-complete').done,true);
        assert.equal(env.requests.filter(x=>x.path==='/api/parent/challenge').length,0,'Reminder actions remain public');
        await snap(page,'inbox-'+name+'-pending');await click(page,'.sheet '+action('redemption-approve','request-qa-pending'));await form(page,'approve');
        assert.deepEqual(await totals(page),before);await submitProtected(page);
        await page.waitForFunction(()=>window.FamilyDemo.getState().requests[0].status==='approved');await form(page,'homeInbox');
        await page.waitForFunction(()=>!!document.activeElement.closest('.sheet'));await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(()=>!!document.activeElement.closest('.sheet')),true,'Approval returning to inbox must keep focus and Tab inside the dialog');
        assert.equal((await ui(page)).inboxCount,0);assert.match(await page.$eval('#home-inbox-body',el=>el.textContent),/都处理好了/);
        await closeSheet(page);await noSheet(page);await settle(page);
        assert.equal((await totals(page)).available,before.available-12);assert.equal((await totals(page)).earned,before.earned);
        assert.equal((await ui(page)).inboxCount,0);assertHome(await geometry(page),24);await snap(page,'inbox-'+name+'-completed-home');
      });
    },{state:(()=>{const v=stressState({count:24,long:true,due:true,pending:true});v.tasks.push({...v.tasks[0],id:'task-qa-snooze',title:'第二项：稍后提醒'}, {...v.tasks[0],id:'task-qa-complete',title:'第三项：真正完成'});return v;})()});
    for(const [name,width,height]of [['ipad-landscape',1024,768],['phone',390,844]])await group('ranking',async(env,page,check)=>{
      await page.setViewport({width,height});await settle(page);const ids=list=>list.map(n=>'qa-behavior-'+String(n).padStart(2,'0'));
      await check(name+': independent ledger history orders by count, recency and configuration; cancel does not count and disable removes immediately',async()=>{
        const order=ids([3,1,2,5,6,4,7]),limit=width>=900?4:2;
        assert.deepEqual((await geometry(page)).behaviors,order.slice(0,limit));
        await click(page,action('all-behaviors'),{scroll:false});await form(page,'behaviorPicker');
        assert.deepEqual(await page.$$eval('.sheet button[data-action="choose-point"]',els=>els.map(x=>x.dataset.id)),order.slice(0,6));
        await typed(page,'#behavior-search','07');await click(page,'.sheet '+action('choose-point','qa-behavior-07'));await form(page,'points');
        const ledger=(await state(page)).points;await closeSheet(page);await form(page,'behaviorPicker');await closeSheet(page);await noSheet(page);
        assert.deepEqual((await state(page)).points,ledger);assert.deepEqual((await geometry(page)).behaviors,order.slice(0,limit));
        await click(page,action('choose-point','qa-behavior-01'),{scroll:false});await form(page,'points');await fillForm(page,{reason:'真实成功加分使同频项按最近时间提前'});
        await submitProtected(page);await noSheet(page);assert.deepEqual((await geometry(page)).behaviors,ids([1,3,2,5]).slice(0,limit));
        await pointManager(page);await click(page,action('point-item-edit','qa-behavior-03'));await form(page,'pointItem');
        await fillForm(page,{name:'第三项改名仍通过itemId归属历史'});await submitProtected(page);await form(page,'point-list');
        await click(page,action('point-item-edit','qa-behavior-01'));await form(page,'pointItem');await fillForm(page,{enabled:'false'});await submitProtected(page);await form(page,'point-list');
        for(let n=0;n<4&&(await ui(page)).form;n++)await closeSheet(page);await noSheet(page);
        assert.deepEqual((await geometry(page)).behaviors,ids([3,2,5,6]).slice(0,limit));
        assert.equal((await state(page)).points.length,ledger.length+1);await snap(page,'ranking-'+name+'-disabled');
      });
    },{state:rankingState()});

    await group('points-ai', async (env, page, check) => {
      await check('Contextual AI fills the same editable points form without committing; every actual award is verified', async () => {
        const before = await totals(page);
        await click(page, action('add-points'));
        await aiFill(page, 'points', '自己收好了书包，加5分');
        await pointsValue(page, 5);
        await page.waitForFunction(() => document.querySelector('[name="reason"]').value.includes('书包'));
        assert.equal((await ui(page)).form, 'points'); assert.deepEqual(await totals(page), before);
        const request = env.requests.filter(item => item.path === '/api/assistant').at(-1);
        assert.equal(request.body.context, 'points');
        assert.equal(env.requests.filter(item => item.path === '/api/action').length, 0);
        await fillForm(page, { reason: '家长核对：今天确实自己收好了书包' });
        await snap(page, 'context-points-draft');
        await click(page, SELECTORS.submit, { scroll: false }); await verify(page, '000000');
        assert.deepEqual(await totals(page), before);
        await verify(page); await noSheet(page);
        assert.equal((await totals(page)).earned, before.earned + 5);
        await openCredit(page, { points: 2, reason: '下一次独立记录仍需核验' });
        await click(page, SELECTORS.submit, { scroll: false });
        assert.equal((await totals(page)).earned, before.earned + 5);
        await verify(page); await noSheet(page);
        assert.equal((await totals(page)).earned, before.earned + 7);
      });
    });

    await group('template-ai', async (env, page, check) => {
      let item;
      await check('Template-management AI creates a reviewable verified template, never an accidental award', async () => {
        const before = await totals(page), ledger = (await state(page)).points;
        await pointManager(page);
        await aiFill(page, 'pointItems', '新增常用项：整理书包，3分，预设原因：今天自己收好了书包');
        await form(page, 'pointItem'); await pointsValue(page, 3);
        assert.equal((await state(page)).pointItems.some(value => value.name === '整理书包'), false);
        await click(page, SELECTORS.submit, { scroll: false });
        assert.deepEqual(await totals(page), before);
        await verify(page); await form(page, 'point-list');
        const restored = await page.evaluate(() => ({ busy: window.FamilyDemo.getUI().aiBusy,
          disabled: document.querySelector('button[data-action="ai-fill"]').disabled,
          text: document.querySelector('[name="aiText"]').value,
          status: document.querySelector('#context-ai-status').textContent }));
        assert.equal(restored.busy, false); assert.equal(restored.disabled, false);
        assert.doesNotMatch(restored.status, /正在整理/, 'Returned management screen must not show a stale pending state: ' + JSON.stringify(restored));
        assert.equal(restored.text, '', 'A successfully saved template clears the consumed description');
        assert.match(restored.status, /已保存|已更新/);
        item = (await state(page)).pointItems.find(value => value.name === '整理书包'); assert.ok(item);
        assert.equal(item.points, 3); assert.match(item.reason, /书包/);
        assert.deepEqual((await state(page)).points, ledger); assert.deepEqual(await totals(page), before);
        assert.ok(env.requests.filter(value => value.path === '/api/assistant').every(value => value.body.context === 'pointItems'));
      });
      await check('Cancel keeps the description without a stale busy message and another management request remains usable', async () => {
        const description = '把整理书包改为4分', before = await totals(page);
        await aiFill(page, 'pointItems', description); await form(page, 'pointItem'); await pointsValue(page, 4);
        await closeSheet(page); await form(page, 'point-list');
        assert.equal((await ui(page)).aiBusy, false);
        assert.equal(await page.$eval('button[data-action="ai-fill"]', element => element.disabled), false);
        assert.equal(await page.$eval('[name="aiText"]', element => element.value), description);
        assert.doesNotMatch(await page.$eval('#context-ai-status', element => element.textContent), /正在整理/);
        assert.equal((await state(page)).pointItems.find(value => value.id === item.id).points, 3);
        await snap(page, 'context-template-cancel');
        await aiFill(page, 'pointItems', '把整理书包改为6分'); await form(page, 'pointItem'); await pointsValue(page, 6);
        await closeSheet(page); await form(page, 'point-list');
        assert.deepEqual(await totals(page), before);
        assert.equal((await state(page)).pointItems.find(value => value.id === item.id).points, 3);
      });
      await check('Editing name, points, preset reason, disabling and enabling stays in template management with a fresh verification each time', async () => {
        const before = await totals(page), ledger = (await state(page)).points;
        for (const operation of [
          { text: '把整理书包改为9分', expect: value => value.points === 9 },
          { text: '把整理书包的预设原因改为自己把第二天的课本和文具放好了', expect: value => /课本/.test(value.reason) },
          { text: '把整理书包改名为自己收拾书包', expect: value => value.name === '自己收拾书包' },
          { text: '停用自己收拾书包', expect: value => value.enabled === false },
          { text: '启用自己收拾书包', expect: value => value.enabled === true }
        ]) {
          const saved = (await state(page)).pointItems.find(value => value.id === item.id);
          await click(page, action('point-item-edit', item.id));
          await aiFill(page, 'pointItems', operation.text);
          await page.waitForFunction(() => document.querySelector('[name="aiText"]') && !document.querySelector('button[data-action="ai-fill"]').disabled);
          await delay(250);
          assert.deepEqual((await state(page)).pointItems.find(value => value.id === item.id), saved);
          await click(page, SELECTORS.submit, { scroll: false }); await verify(page); await form(page, 'point-list');
          assert.ok(operation.expect((await state(page)).pointItems.find(value => value.id === item.id)), operation.text);
          assert.deepEqual(await totals(page), before); assert.deepEqual((await state(page)).points, ledger);
        }
        await snap(page, 'context-template-management');
      });
    });

    await group('ai-races', async (env, page, check) => {
      let held;
      await page.setRequestInterception(true);
      page.on('request', request => {
        if (request.url().endsWith('/api/assistant')) { held = request; }
        else { request.continue(); }
      });
      await check('Typing manually during contextual AI processing is preserved when the late result arrives', async () => {
        await openCredit(page);
        await fill(page, '[name="aiText"]', '自己收好了书包，加5分');
        await click(page, action('ai-fill', 'points'));
        assert.ok(held, 'The real outgoing assistant request is deliberately held');
        await fillForm(page, { points: 7, reason: 'AI等待时家长新补充的事实，不能被覆盖' });
        await reachable(page, SELECTORS.submit);
        const response = page.waitForResponse(value => value.url().endsWith('/api/assistant'));
        await held.continue(); await response; await delay(200);
        assert.equal(await page.$eval('[name="reason"]', element => element.value), 'AI等待时家长新补充的事实，不能被覆盖');
        assert.equal(Number(await page.$eval('[name="points"]', element => element.value)), 7);
        assert.equal((await totals(page)).earned, 128);
        await snap(page, 'context-late-manual-edit');
      });
      await check('Closing an in-flight AI draft and opening profile cannot let the late response overwrite the new scene', async () => {
        held = null;
        await fill(page, '[name="aiText"]', '把今天的书包整理好了，加6分');
        await click(page, action('ai-fill', 'points')); assert.ok(held);
        await closeSheet(page); await noSheet(page);
        await click(page, action('profile-edit'));
        await fillForm(page, { childName: '要保留的新资料草稿' });
        await held.continue().catch(error => {
          if (!/Invalid InterceptionId|already handled|Target closed/i.test(error.message)) { throw error; }
        });
        await delay(450);
        assert.equal((await ui(page)).form, 'profile');
        assert.equal(await page.$eval('[name="childName"]', element => element.value), '要保留的新资料草稿');
        assert.equal((await state(page)).childName, '小禾');
        assert.equal(env.requests.filter(value => value.path === '/api/action').length, 0);
        await snap(page, 'context-cancel-new-scene');
      });
      await check('Assistant request failure preserves manual input and a normal verified save remains usable', async () => {
        await closeSheet(page); await noSheet(page);
        await openCredit(page, { reason: '网络失败后仍然保留这次实际原因' });
        held = null;
        await fill(page, '[name="aiText"]', '自己收好了书包，加5分');
        await click(page, action('ai-fill', 'points')); assert.ok(held);
        await held.abort('failed'); await delay(200);
        assert.equal(await page.$eval('[name="reason"]', element => element.value), '网络失败后仍然保留这次实际原因');
        await click(page, SELECTORS.submit, { scroll: false }); await verify(page); await noSheet(page);
        assert.equal((await totals(page)).earned, 133);
      });
    });

    await group('companions', async (env, page, check) => {
      const before = await totals(page);
      await check('Both companions have three visibly distinct free interactions and public switching preserves growth', async () => {
        for (const kind of ['plant', 'capybara']) {
          if (kind === 'capybara') {
            await click(page, action('pet-config'));
            await click(page, action('pet-kind', kind)); await fillForm(page, { petName: '团团' });
            await click(page, SELECTORS.submit, { scroll: false }); await noSheet(page);
            assert.equal((await state(page)).pet.kind, kind);
          }
          await page.waitForSelector('.companion-card svg[data-pet-kind="' + kind + '"]');
          const reactions = kind === 'plant' ? ['pet', 'water', 'sun'] : ['pet', 'feed', 'play'];
          const actionsBefore = env.requests.filter(value => value.path === '/api/action').length;
          const markup = [];
          for (const reaction of reactions) {
            await click(page, action('pet-interact', reaction));
            const selector = '.companion-card svg[data-pet-reaction="' + reaction + '"]';
            await page.waitForSelector(selector);
            markup.push(await page.$eval(selector, element => element.innerHTML));
            assert.deepEqual(await totals(page), before); assert.equal((await growth(page)).xp, 128);
            const reactionGeometry=await geometry(page);report.reactions.push({kind,reaction,...reactionGeometry});assertPetGeometry(reactionGeometry,true);
            await snap(page, 'companion-' + kind + '-reaction-' + reaction);
          }
          assert.equal(new Set(markup).size, 3, 'All three reactions must have distinct visible SVG content');
          await click(page, action('pet-touch'));
          await page.waitForSelector('.companion-card svg[data-pet-reaction="pet"]');
          assert.equal(env.requests.filter(value => value.path === '/api/action').length, actionsBefore, 'Companion interactions must not send ledger or other mutations');
          await snap(page, 'companion-' + kind + '-phone');
        }
        assert.equal(env.requests.filter(value => value.path === '/api/parent/challenge').length, 0);
        await page.reload({ waitUntil: 'load' }); await connected(page);
        assert.equal((await state(page)).pet.kind, 'capybara'); assert.equal((await growth(page)).stage, 3);
      });
      await check('Reduced-motion rendering still provides a clear static interaction and no sustained animation', async () => {
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
        await page.reload({ waitUntil: 'load' }); await connected(page);
        await click(page, action('pet-interact', 'feed'));
        const selector = '.companion-card svg.pet-scene';
        assert.equal(await page.$eval(selector, element => element.getAttribute('data-pet-reduced-motion')), 'true');
        assert.equal(await page.$eval(selector, element => element.getAttribute('data-pet-reaction')), 'feed');
        const continuous = await page.$$eval('.companion-card svg *', elements => elements.filter(element => {
          const style = getComputedStyle(element);
          return style.animationName !== 'none' && style.animationDuration.split(',').some(value => parseFloat(value) > 0.05);
        }).length);
        assert.equal(continuous, 0); assert.deepEqual(await totals(page), before);
        const g=await geometry(page);report.reactions.push({kind:'capybara',reaction:'feed',reduced:true,...g});assertPetGeometry(g,true);
        await snap(page, 'companion-reduced-motion');
      });
    });

    for (const kind of ['plant', 'capybara']) {
      for (const [index, xp] of [0, 30, 100, 250, 500].entries()) {
        await group('gallery', async (env, page, check) => {
          await check(kind + ' stage ' + (index + 1) + ': real home renders the stage derived from its starting ledger', async () => {
            const stage = index + 1;
            await page.emulateMediaFeatures([{ name:'prefers-reduced-motion', value:'reduce' }]);
            for(const [name,width,height] of VIEWPORTS) {
              await page.setViewport({width,height});await settle(page);
              await page.waitForSelector('.companion-card svg[data-pet-kind="' + kind + '"][data-pet-stage="' + stage + '"]');
              const value = await growth(page); assert.equal(value.stage, stage); assert.equal(value.xp, xp);
              const g=await geometry(page);report.portraits.push({name,kind,stage,...g});assertPetGeometry(g);
              if(name==='ipad-landscape')await snap(page,'companion-'+kind+'-stage'+stage);
              if(name==='small-phone')await snap(page,'companion-'+kind+'-stage'+stage+'-small-phone');
            }
          });
        }, { state: seeded(xp, kind) });
      }
    }

    await group('growth-redemption', async (env, page, check) => {
      await check('Verified awards cross all visual thresholds, then stars continue; spending from the secondary panel never reduces growth', async () => {
        assert.equal((await growth(page)).stage, 1);
        for (const [xp, stage, level] of [[30, 2, 2], [100, 3, 3], [250, 4, 4], [500, 5, 5], [750, 5, 6]]) {
          const before = await totals(page);
          await openCredit(page, { points: xp - before.earned, reason: '核对本次积分，让累计成长达到' + xp });
          await click(page, SELECTORS.submit, { scroll: false });
          assert.equal((await growth(page)).xp, before.earned);
          await verify(page); await noSheet(page);
          const value = await growth(page);
          assert.equal(value.xp, xp); assert.equal(value.stage, stage); assert.equal(value.level, level);
          await page.waitForSelector('.companion-card svg[data-pet-stage="' + stage + '"]');
          assert.ok((await page.$eval('.companion-card', element => element.textContent)).includes(value.stageName));
          await click(page,action('pet-growth'),{scroll:false});await form(page,'petGrowth');
          assert.ok((await page.$eval('.sheet',el=>el.textContent)).includes(String(value.remaining)),'Remaining growth stays available through the visible growth-details entry');
          await closeSheet(page);await noSheet(page);
        }
        assert.equal((await growth(page)).stars, 1);
        const before = await totals(page), grown = await growth(page);
        await openRewards(page); await click(page, action('redeem', 'reward-pencil'));
        await click(page, SELECTORS.submit, { scroll: false }); await form(page, 'rewards');
        const request = (await state(page)).requests.find(value => value.status === 'pending'); assert.ok(request);
        assert.deepEqual(await totals(page), before);
        await click(page, '.sheet ' + action('redemption-approve', request.id));
        await click(page, SELECTORS.submit, { scroll: false }); await verify(page); await form(page, 'rewards');
        assert.equal((await totals(page)).available, before.available - 12);
        assert.equal((await totals(page)).earned, before.earned); assert.deepEqual(await growth(page), grown);
        await closeSheet(page); await noSheet(page); await snap(page, 'growth-after-redemption');
        await click(page, action('pet-growth')); await snap(page, 'growth-explained');
      });
    }, { state: seeded(29) });

    if (!selected || selected.includes('profile')) {
      const files = fixtures(), provider = await mockProvider();
      try {
        await group('profile', async (env, page, check) => {
          let avatar;
          await check('A real file chooser locally crops the tagged photo; cancel writes nothing and profile save requires PIN', async () => {
            const before = await totals(page), original = fs.readFileSync(files.valid);
            await click(page, action('profile-edit'));
            await upload(page, files.valid);
            await page.waitForSelector('.sheet img.profile-avatar-image');
            avatar = await page.$eval('.sheet img.profile-avatar-image', element => element.src);
            assert.match(avatar, /^data:image\/jpeg;base64,/); assert.ok(avatar.length <= 160000);
            const info = await avatarInfo(page, avatar);
            assert.equal(info.width, 192); assert.equal(info.height, 192);
            for (const pixel of [info.first, info.last]) {
              assert.ok(pixel[2] > 180 && pixel[0] < 80 && pixel[1] < 130, 'Center crop must exclude the red/green side stripes');
            }
            assert.equal(Buffer.from(avatar.split(',')[1], 'base64').includes(Buffer.from(METADATA)), false);
            assert.notEqual(avatar.split(',')[1], original.toString('base64'));
            assert.equal((await state(page)).childAvatar, '');
            assert.equal(env.requests.filter(item => item.path === '/api/action').length, 0);
            await snap(page, 'avatar-local-preview');
            await closeSheet(page); await noSheet(page);
            assert.equal((await state(page)).childAvatar, '');
            await click(page, action('profile-edit'));
            // The product may retain the unsaved draft; if not, choose it again.
            if (!(await page.$('.sheet img.profile-avatar-image'))) { await upload(page, files.valid); await page.waitForSelector('.sheet img.profile-avatar-image'); }
            await fillForm(page, { childName: '小芽' });
            await click(page, SELECTORS.submit, { scroll: false });
            assert.equal((await state(page)).childAvatar, ''); assert.equal((await state(page)).childName, '小禾');
            await verify(page, '000000'); assert.equal((await state(page)).childAvatar, '');
            await verify(page); await noSheet(page);
            const saved = await state(page); avatar = saved.childAvatar;
            assert.equal(saved.childName, '小芽'); assert.match(avatar, /^data:image\/jpeg;base64,/);
            assert.deepEqual(await totals(page), before);
            await page.reload({ waitUntil: 'load' }); await connected(page);
            assert.equal((await state(page)).childAvatar, avatar); assert.equal((await state(page)).childName, '小芽');
            assert.ok(await page.$('img.profile-avatar-image'));
            const writes = env.requests.filter(value => value.path === '/api/action' || value.path === '/api/parent/challenge');
            assert.ok(writes.length); assert.ok(writes.every(value => !JSON.stringify(value.body).includes(original.toString('base64'))));
            await snap(page, 'avatar-persisted-home');
          });
          await check('SVG, over-8MiB files and over-16MP photos are rejected without replacing the saved avatar', async () => {
            await click(page, action('profile-edit'));
            for (const [filename, pattern] of [[files.svg, '格式|JPEG|PNG|WebP|支持'], [files.large, '8|大小|体积'], [files.pixels, '像素|16']]) {
              await upload(page, filename);
              await page.waitForFunction(source => new RegExp(source).test(document.querySelector('#avatar-status').textContent), {}, pattern);
              assert.equal((await state(page)).childAvatar, avatar);
              assert.equal(await page.$eval('.sheet img.profile-avatar-image', element => element.src), avatar);
            }
            await snap(page, 'avatar-rejected-input');
            await closeSheet(page); await noSheet(page);
          });
          await check('The real assistant HTTP path sends no photo or original metadata to a loopback mock model; removing an avatar is also verified', async () => {
            await click(page, action('add-points'));
            await aiFill(page, 'points', '自己收好了书包，加5分'); await pointsValue(page, 5);
            assert.equal(provider.calls.length, 1);
            const outgoing = JSON.stringify(provider.calls[0]);
            assert.equal(outgoing.includes('childAvatar'), false); assert.equal(outgoing.includes('data:image/'), false);
            assert.equal(outgoing.includes(METADATA), false); assert.equal(outgoing.includes(avatar), false);
            assert.equal(outgoing.includes(PIN), false);
            const browserRequest = env.requests.filter(value => value.path === '/api/assistant').at(-1);
            assert.equal(JSON.stringify(browserRequest.body).includes('data:image/'), false);
            assert.equal((await totals(page)).earned, 128, 'An AI candidate after photo saving must still be only a draft');
            await closeSheet(page); await noSheet(page);
            await click(page, action('profile-edit')); await click(page, action('avatar-remove'));
            assert.equal((await state(page)).childAvatar, avatar);
            await click(page, SELECTORS.submit, { scroll: false }); await verify(page); await noSheet(page);
            assert.equal((await state(page)).childAvatar, ''); assert.equal((await state(page)).childName, '小芽');
          });
        }, { assistantService: provider.service });
      } finally { await provider.close(); }
    }

    if (process.env.V5_OFFLINE === '1' || selected && selected.some(name => name === 'offline' || name === 'offline-hosted')) {
      await group('offline', async (env, page, check) => {
        await check('Final single-file export exactly embeds the current app, model, assistant, pet renderer and both stylesheets', async () => {
          const html = fs.readFileSync(path.join(ROOT, 'export', 'little-steps-demo.html'), 'utf8').replace(/\r\n/g, '\n');
          for (const name of ['model.js', 'assistant.js', 'pet.js', 'app.js']) {
            const source = fs.readFileSync(path.join(ROOT, name), 'utf8').replace(/\r\n/g, '\n').replace(/<\/script/g, '<\\/script');
            assert.ok(html.includes('<script>' + source + '</script>'), name + ' differs from the exported executable');
          }
          for (const name of ['styles.css', 'pet.css']) { assert.ok(html.includes(fs.readFileSync(path.join(ROOT, name), 'utf8').replace(/\r\n/g, '\n')), name + ' missing'); }
          assert.match(html, /window\.__FAMILY_OFFLINE__\s*=\s*true/);
          assert.equal(/<script\s+src=|<link[^>]+rel="stylesheet"/.test(html), false);
        });
        await check('Offline file supports the real avatar chooser, local PIN setup, context filling and companion persistence without HTTP', async () => {
          const external = [], filename = path.join(ARTIFACTS, 'v5-avatar-source.png');
          fs.writeFileSync(filename, pngFixture(600, 400));
          await page.setRequestInterception(true);
          page.on('request', request => {
            if (/^https?:/.test(request.url())) { external.push(request.url()); request.abort(); }
            else { request.continue(); }
          });
          await page.goto(pathToFileURL(path.join(ROOT, 'export', 'little-steps-demo.html')).href, { waitUntil: 'load' });
          await page.waitForFunction(() => window.FamilyDemo && window.FamilyPet);
          assert.equal((await ui(page)).connected, false);
          await click(page, action('pet-interact', 'water'));
          await page.waitForSelector('.companion-card svg[data-pet-reaction="water"]');
          assert.equal((await growth(page)).xp, 128);
          await click(page, action('profile-edit')); await upload(page, filename);
          await page.waitForSelector('.sheet img.profile-avatar-image');
          await fillForm(page, { childName: '离线小芽' });
          await click(page, SELECTORS.submit, { scroll: false });
          await page.waitForSelector('#parent-form [name="setupPin"]');
          await fill(page, '#parent-form [name="setupPin"]', PIN); await fill(page, '#parent-form [name="setupConfirm"]', PIN);
          await click(page, SELECTORS.verify, { scroll: false }); await noSheet(page);
          await click(page, action('pet-config')); await click(page, action('pet-kind', 'capybara')); await fillForm(page, { petName: '离线团团' });
          await click(page, SELECTORS.submit, { scroll: false }); await noSheet(page);
          await click(page, action('add-points')); await aiFill(page, 'points', '自己收好了书包，加5分');
          await page.waitForFunction(() => document.querySelector('[name="reason"]').value.includes('书包'));
          assert.equal((await totals(page)).earned, 128);
          await click(page, SELECTORS.submit, { scroll: false }); await verify(page); await noSheet(page);
          await page.reload({ waitUntil: 'load' }); await page.waitForFunction(() => window.FamilyDemo && window.FamilyPet);
          const saved = await state(page); assert.equal(saved.childName, '离线小芽'); assert.equal(saved.pet.name, '离线团团'); assert.equal(saved.pet.kind, 'capybara');
          assert.equal((await avatarInfo(page, saved.childAvatar)).width, 192); assert.equal((await growth(page)).xp, 133);
          assert.deepEqual(external, []); await snap(page, 'offline-growth-avatar');
        });
      });
      await group('offline-hosted', async (env, page, check) => {
        await check('The v0.5 export remains local over a real HTTP host, with pet changes persisted and no API calls', async () => {
          const html = fs.readFileSync(path.join(ROOT, 'export', 'little-steps-demo.html')), extra = [];
          const server = http.createServer((request, response) => {
            if (request.url === '/offline.html') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); }
            else { if (request.url !== '/favicon.ico') { extra.push(request.url); } response.writeHead(404); response.end(); }
          });
          await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
          try {
            await page.goto('http://127.0.0.1:' + server.address().port + '/offline.html', { waitUntil: 'load' });
            await page.waitForFunction(() => window.FamilyDemo && window.FamilyPet);
            assert.equal(await page.evaluate(() => window.__FAMILY_OFFLINE__), true); assert.equal((await ui(page)).connected, false);
            await click(page, action('pet-config')); await click(page, action('pet-kind', 'capybara')); await fillForm(page, { petName: '本机团团' });
            await click(page, SELECTORS.submit, { scroll: false }); await noSheet(page);
            await page.reload({ waitUntil: 'load' }); await page.waitForFunction(() => window.FamilyDemo && window.FamilyPet);
            assert.equal((await state(page)).pet.name, '本机团团'); assert.equal((await growth(page)).xp, 128);
            await click(page, action('pet-interact', 'feed')); await page.waitForSelector('.companion-card svg[data-pet-reaction="feed"]');
            assert.deepEqual(extra, []); await snap(page, 'offline-http-companion');
          } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        });
      });
    } else { report.skipped.push('Final v0.5 offline package has not been selected for this run.'); }
  } finally {
    await browser.close();
    report.sourceHashesAtFinish=Object.fromEntries(Object.keys(report.sourceHashes).map(name=>[name,hash(name)]));
    report.exportHashAtFinish=hash('export/little-steps-demo.html');
    report.sourceStable=Object.entries(report.sourceHashes).every(([name,value])=>report.sourceHashesAtFinish[name]===value)&&report.exportHashAtFinish===report.exportHash;
    if(!report.sourceStable)report.failed.push({group:'source-consistency',label:'Source and export stay frozen during acceptance',message:'Source or export changed during this run'});
    report.passed = report.checks.length; report.finishedAt = new Date().toISOString();
    const run = { requested: report.requested, startedAt: report.startedAt, finishedAt: report.finishedAt,
      sourceHashes: report.sourceHashes, exportHash: report.exportHash, harnessHash:report.harnessHash, sourceStable:report.sourceStable, passed: report.passed, failed: report.failed };
    let final = report;
    if (selected && fs.existsSync(output)) {
      const previous = JSON.parse(fs.readFileSync(output, 'utf8'));
      final = { ...previous, ...report,
        checks: previous.checks.filter(item => !selected.includes(item.group)).concat(report.checks),
        failed: previous.failed.filter(item => !selected.includes(item.group)).concat(report.failed),
        layouts: selected.includes('layout') ? report.layouts : previous.layouts,
        stress: selected.includes('stress') ? report.stress : previous.stress,
        portraits: selected.includes('gallery') ? report.portraits : previous.portraits,
        reactions: selected.includes('companions') ? report.reactions : previous.reactions,
        feedback: selected.includes('picker') ? report.feedback : previous.feedback,
        errors: (previous.errors || []).filter(item => !selected.includes(item.group)).concat(report.errors),
        runs: (previous.runs || []).concat(run), requested: 'cumulative targeted runs' };
      final.passed = final.checks.length;
    } else { final.runs = (fs.existsSync(output) ? JSON.parse(fs.readFileSync(output,'utf8')).runs || [] : []).concat(run); }
    fs.writeFileSync(output, JSON.stringify(final, null, 2));
  }
  console.log(report.passed + ' checks passed; ' + report.failed.length + ' failed.');
  process.exitCode = report.failed.length ? 1 : 0;
  return report;
}

if (require.main === module) { (process.env.V5_BASELINE === '1' ? runBaseline() : process.env.V5_PROBE === '1' ? runProbe() : runSuite()).catch(error => { console.error(error); process.exitCode = 1; }); }
module.exports = { runSuite, runProbe, geometry, stressState, seeded, fixtures, pngFixture, avatarInfo, mockProvider };
