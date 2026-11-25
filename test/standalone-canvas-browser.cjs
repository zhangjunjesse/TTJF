'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Q = require('./saas-browser.cjs');
const theme = JSON.parse(fs.readFileSync(path.join(Q.ROOT,'manifest.webmanifest'),'utf8')).theme_color;
const paper = 'rgb('+[1,3,5].map(offset=>parseInt(theme.slice(offset,offset+2),16)).join(', ')+')';
const entry = '[data-action="assistant-open"]';

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

async function run() {
  Q.phase('standalone-canvas');
  const proof=Q.report.standaloneCanvas={theme,uninstalled:false,
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
