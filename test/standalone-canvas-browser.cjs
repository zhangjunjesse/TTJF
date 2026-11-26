'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Q = require('./saas-browser.cjs');
const theme = JSON.parse(fs.readFileSync(path.join(Q.ROOT,'manifest.webmanifest'),'utf8')).theme_color;
const paper = 'rgb('+[1,3,5].map(offset=>parseInt(theme.slice(offset,offset+2),16)).join(', ')+')';
const entry = '[data-action="assistant-open"]';
const homeWhite = 'rgb(253, 253, 251)';
const presetId = 'standalone-edge-preset';
const presetName = '合成贴边核对行为';

async function viewport(page,width,height,standalone) {
  await page.setViewport({width,height,deviceScaleFactor:1,isMobile:true,hasTouch:true,isLandscape:width>height});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const actual = await page.evaluate(()=>({width:innerWidth,height:innerHeight,
    standalone:matchMedia('(display-mode: standalone)').matches,browser:matchMedia('(display-mode: browser)').matches}));
  assert.deepEqual(actual,{width,height,standalone,browser:!standalone},'actual viewport and display mode match the requested device');
}
async function colors(page,panel=false) {
  return page.evaluate(includePanel=>({
    html:getComputedStyle(document.documentElement).backgroundColor,body:getComputedStyle(document.body).backgroundColor,
    ...(includePanel?{panel:getComputedStyle(document.querySelector('#family-assistant-panel')).backgroundColor}:{})
  }),panel);
}
async function canvas(page,panel=false) {
  assert.equal(await page.$eval('meta[name="theme-color"]',node=>node.content),theme);
  assert.deepEqual(await colors(page,panel),{html:paper,body:paper,...(panel?{panel:paper}:{})});
}
async function panelBounds(page,expected) {
  const actual=await page.$eval('#family-assistant-panel',node=>{
    const rect=node.getBoundingClientRect(); return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};
  });
  assert.deepEqual(actual,expected,'assistant retains its full-screen or wide-drawer geometry');
}
async function open(page) {
  await Q.click(page,entry);
  await page.waitForFunction(()=>FamilyAssistantPanel.getState().loaded&&FamilyAssistantPanel.getState().open);
}
async function close(page) {
  await Q.click(page,'button[data-assistant-action="close"]');
  await page.waitForFunction(()=>!FamilyAssistantPanel.getState().open);
  assert.equal((await Q.ui(page)).view,'reminders');
  assert.ok(await Q.visible(page,'#main'));
  assert.ok(await page.$eval('#main',node=>{
    const rect=node.getBoundingClientRect();
    return !!document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.closest('#main');
  }),'closing restores the original reachable reminders view');
}

async function seedPreset(env,page,family) {
  const actions=[{type:'parent.setup',method:'pin',pin:Q.PIN,confirmPin:Q.PIN},
    {type:'pointItem.save',item:{id:presetId,name:presetName,points:5,reason:'自己整理书包',enabled:true}}];
  for (const [index,input] of actions.entries()) {
    const state=await env.api(page,'/api/state'); assert.equal(state.status,200);
    const action={...input,id:'standalone-edge-fixture-'+index}; let grant;
    if (index) {
      const challenge=await env.api(page,'/api/parent/challenge','POST',{revision:state.body.revision,action});
      assert.equal(challenge.status,200,JSON.stringify(challenge.body));
      const verified=await env.api(page,'/api/parent/verify','POST',{challengeId:challenge.body.challengeId,answer:Q.PIN});
      assert.equal(verified.status,200,JSON.stringify(verified.body)); grant=verified.body.grant;
    }
    const saved=await env.api(page,'/api/action','POST',{revision:state.body.revision,action,grant});
    assert.equal(saved.status,200,JSON.stringify(saved.body));
  }
  await page.reload({waitUntil:'load'}); await Q.ready(page,family);
}
async function pointsEdge(page,proof,stage,expected) {
  const measured=await page.evaluate(()=>{
    const describe=node=>node.tagName.toLowerCase()+(node.id?'#'+node.id:'')+(node.className?'.'+String(node.className).trim().replace(/\s+/g,'.'):'');
    const background=node=>getComputedStyle(node).backgroundColor;
    const samples=[1,innerWidth/2,innerWidth-1].flatMap(x=>[0,5].map(y=>{
      const hit=document.elementFromPoint(x,y); let surface=null;
      // The canvas alone cannot prove WebKit has an actual fixed/sticky box to sample.
      for (let node=hit;node&&node!==document.body&&node!==document.documentElement;node=node.parentElement) {
        const css=getComputedStyle(node),r=node.getBoundingClientRect();
        let opaqueAncestors=true;
        for (let parent=node;parent;parent=parent.parentElement) {
          const style=getComputedStyle(parent);
          if (style.opacity!=='1'||style.filter!=='none') opaqueAncestors=false;
        }
        if (['fixed','sticky'].includes(css.position)&&r.left<=0&&r.right>=innerWidth&&r.top<=0&&r.bottom>y&&r.height>10&&
            /^rgb\(/.test(css.backgroundColor)&&css.backgroundImage==='none'&&opaqueAncestors) {
          surface={element:describe(node),position:css.position,color:css.backgroundColor,
            rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,height:r.height}}; break;
        }
      }
      return {x,y,hit:hit&&describe(hit),surface};
    }));
    return {html:background(document.documentElement),body:background(document.body),
      header:background(document.querySelector('.home-header')),samples};
  });
  proof.pointsEdges.push({stage,...measured});
  const color=expected||measured.html;
  assert.match(color,/^rgb\(/,stage+': the page edge is fully opaque');
  assert.equal(measured.html,color,stage+': HTML matches the visible edge');
  assert.equal(measured.body,color,stage+': body matches the visible edge');
  assert.equal(measured.header,homeWhite,stage+': the points header uses the required white');
  for (const sample of measured.samples) {
    assert.ok(sample.surface,stage+': an opaque full-width fixed/sticky box taller than 10px is hit at '+JSON.stringify(sample));
    assert.equal(sample.surface.color,color,stage+': the actual hit surface matches the page canvas');
  }
  return color;
}
async function pointsCycle(page,proof,label,standalone) {
  Q.active(page); const preset='.points-home '+Q.action('choose-point',presetId);
  let before;
  await Q.check(label+' points home exposes a white edge that WebKit can sample',async()=>{
    await viewport(page,390,844,standalone); await Q.home(page); await Q.B.homeView(page,'points');
    await page.waitForSelector('.points-home'); await Q.B.reachable(page,preset);
    assert.equal(await page.$('.sheet-overlay'),null);
    await pointsEdge(page,proof,label+'-home',homeWhite); before=await Q.snapshot(page);
    await Q.shot(page,label+'-points-home');
  });
  await Q.check(label+' preset award review keeps photos reachable and its top edge opaque',async()=>{
    await Q.click(page,preset,{scroll:false});
    await page.waitForSelector('.ledger-award-dialog[data-auth-phase="confirm"]',{visible:true});
    assert.equal(await page.$eval('#sheet-title',node=>node.textContent),'核对加分');
    assert.equal(await page.$eval('.ledger-award-name',node=>node.textContent),presetName);
    for (const action of ['award-photo-camera','award-photo-album','points-cancel']) {
      await Q.B.reachable(page,'.ledger-award-dialog '+Q.action(action));
    }
    assert.equal(await page.$eval('.award-photo-editor [data-photo-count]',node=>node.dataset.count),'0');
    assert.notEqual(await pointsEdge(page,proof,label+'-review'),homeWhite,'the open backdrop changes the sampled edge');
    await Q.shot(page,label+'-preset-photo-review');
  });
  await Q.check(label+' closing the preset review restores the white reachable points home',async()=>{
    await Q.click(page,'.ledger-award-dialog '+Q.action('points-cancel'),{scroll:false});
    await page.waitForSelector('.sheet-overlay',{hidden:true});
    assert.equal((await Q.ui(page)).view,'points'); await Q.B.reachable(page,preset);
    await pointsEdge(page,proof,label+'-closed',homeWhite);
    assert.deepEqual(await Q.snapshot(page),before,'reviewing and closing does not write points or change the preset');
    await Q.shot(page,label+'-points-restored');
  });
}

async function run() {
  Q.phase('standalone-canvas');
  const proof=Q.report.standaloneCanvas={theme,uninstalled:false,pointsEdges:[],
    boundary:'Real temporary Edge PWA via CDP pipe, real display-mode matching and an ordinary tab against isolated SaaS/SQLite. Physical iPhone/Safari status-bar painting is not verified.'};
  const env=await Q.initialize({browserPipe:true}), seed=await env.newPage(), browser=seed.browser();
  const tab=await browser.defaultBrowserContext().newPage(), cdp=await browser.target().createCDPSession();
  const manifestId=env.origin+'/';
  await tab.goto(env.origin,{waitUntil:'load'});
  await cdp.send('PWA.install',{manifestId,installUrlOrBundleUrl:env.origin});
  try {
    await cdp.send('PWA.changeAppUserSettings',{manifestId,displayMode:'standalone'});
    const launched=await cdp.send('PWA.launch',{manifestId}); proof.targetId=launched.targetId;
    const target=await browser.waitForTarget(target=>target!==tab.target()&&target!==seed.target()&&target.type()==='page'&&target.url().startsWith(env.origin),{timeout:5000});
    const app=await target.page(); Q.active(app); app.setDefaultTimeout(6000);
    await Q.check('PWA cold portrait login matches standalone and paints the declared theme',async()=>{
      await viewport(app,390,844,true); await Q.waitView(app,'login');
      await canvas(app); await Q.shot(app,'standalone-login');
    });
    await Q.registerAndVerify(app,'standalone-canvas-'+Q.RUN+'@example.test');
    const family=await Q.createFamily(app,'合成主屏幕启动家庭','合成手机宝');
    await Q.ready(app,family); await Q.home(app);
    await Q.check('PWA first portrait points home keeps the declared canvas',async()=>{
      await viewport(app,390,844,true); await app.waitForSelector('.points-home'); await canvas(app);
    });
    await seedPreset(env,app,family); await pointsCycle(app,proof,'standalone',true);
    await Q.click(app,Q.action('nav','reminders'),{scroll:false});
    await app.waitForFunction(()=>FamilyDemo.getUI().view==='reminders');
    await Q.check('PWA assistant opened from reminders fills the 390 by 844 canvas',async()=>{
      await canvas(app); await open(app); await canvas(app,true);
      await panelBounds(app,{x:0,y:0,width:390,height:844}); await Q.shot(app,'standalone-portrait');
    });
    for (const [width,height,label] of [[844,390,'landscape'],[390,844,'returned-portrait']]) {
      await Q.check('PWA '+label+' retains its canvas and full-screen assistant',async()=>{
        await viewport(app,width,height,true); await canvas(app,true);
        await panelBounds(app,{x:0,y:0,width,height}); assert.equal((await Q.ui(app)).view,'reminders');
        await Q.shot(app,'standalone-'+label);
      });
    }
    await Q.check('PWA assistant closes back to the same reminders view',async()=>{
      await close(app); await canvas(app); await Q.shot(app,'standalone-closed');
    });
    Q.active(tab);
    await viewport(tab,390,844,false); await tab.goto(env.origin,{waitUntil:'load'}); await Q.ready(tab,family);
    await pointsCycle(tab,proof,'browser',false);
    await Q.click(tab,Q.action('nav','reminders'),{scroll:false});
    await tab.waitForFunction(()=>FamilyDemo.getUI().view==='reminders');
    await Q.check('ordinary browser tab retains its original colors and full-screen assistant',async()=>{
      await viewport(tab,390,844,false); await open(tab);
      assert.deepEqual(await colors(tab,true),{html:'rgba(0, 0, 0, 0)',body:'rgb(226, 229, 201)',panel:'rgb(252, 253, 249)'});
      await panelBounds(tab,{x:0,y:0,width:390,height:844}); await Q.shot(tab,'browser-portrait'); await close(tab);
    });
    Q.active(app);
    await Q.check('wide PWA retains its original 420 pixel drawer and returns to reminders',async()=>{
      await viewport(app,1024,768,true); await open(app); await canvas(app);
      assert.equal((await colors(app,true)).panel,'rgb(252, 253, 249)');
      await panelBounds(app,{x:590,y:14,width:420,height:740}); await Q.shot(app,'standalone-wide'); await close(app);
    });
  } finally {
    await cdp.send('PWA.uninstall',{manifestId}); proof.uninstalled=true;
  }
}
module.exports={run};
