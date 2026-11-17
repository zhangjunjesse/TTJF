'use strict';
// Read-only verification of the existing local preview; never starts a replacement.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const B = require('../test/browser.cjs');
const ROOT = path.resolve(__dirname,'..');
const ORIGIN = 'http://127.0.0.1:4180';
const OUT = path.join(ROOT,'artifacts');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
async function main() {
  const report = {at:new Date().toISOString(),origin:ORIGIN,scope:'Existing live preview, anonymous read-only requests; no real family state or legacy4178 access.',assets:[],protected:[],pageErrors:[],writeAttempts:[]};
  for (const name of ['index.html','app.js','model.js','saas-client.js','saas.css','farm-ui.js','farm-scene.js']) {
    const response = await fetch(ORIGIN+'/'+name);
    assert.equal(response.status,200,name);
    const bytes = Buffer.from(await response.arrayBuffer());
    const hash = sha(bytes);
    assert.equal(hash,sha(fs.readFileSync(path.join(ROOT,name))),name+' matches workspace');
    report.assets.push({file:name,status:200,sha256:hash});
  }
  const runtime = await fetch(ORIGIN+'/runtime.js');
  assert.equal(runtime.status,200);
  assert.match(await runtime.text(),/__TTJF_SAAS__=true/);
  const health = await fetch(ORIGIN+'/api/health');
  assert.equal(health.status,200);
  assert.deepEqual(await health.json(),{ok:true});
  report.databaseHealth='passed';
  assert.deepEqual(await (await fetch(ORIGIN+'/api/session')).json(),{authenticated:false});
  for (const resource of ['/api/state','/api/meta','/saas-server.cjs','/package.json','/.env.saas.local','/data/state.json']) {
    const response = await fetch(ORIGIN+resource);
    assert.ok(resource.startsWith('/api/') ? response.status===401 : [400,404].includes(response.status));
    assert.equal(response.headers.get('cache-control'),'no-store');
    report.protected.push({path:resource,status:response.status});
  }
  const browser = await B.launch();
  try {
    const page = await browser.newPage();
    await page.setViewport({width:390,height:844,deviceScaleFactor:1});
    await page.setRequestInterception(true);
    page.on('request',request => {
      if (!['GET','HEAD'].includes(request.method())) { report.writeAttempts.push({method:request.method(),path:new URL(request.url()).pathname}); request.abort(); return; }
      if (/^https?:/.test(request.url()) && new URL(request.url()).origin!==ORIGIN) { request.abort(); return; }
      request.continue();
    });
    page.on('pageerror',error => report.pageErrors.push(error.message));
    await page.goto(ORIGIN,{waitUntil:'networkidle0'});
    await page.waitForSelector('#saas-form input[name="email"]',{visible:true});
    const state = await page.evaluate(() => ({saas:window.__TTJF_SAAS__,state:window.FamilyDemo.getState(),canvases:document.querySelectorAll('canvas').length,body:document.body.innerText,overflow:document.documentElement.scrollWidth>window.innerWidth}));
    assert.equal(state.saas,true);
    assert.equal(state.state,null);
    assert.equal(state.canvases,0);
    assert.match(state.body,/登录/);
    assert.equal(state.overflow,false);
    assert.deepEqual(report.pageErrors,[]);
    assert.deepEqual(report.writeAttempts,[]);
    fs.mkdirSync(OUT,{recursive:true});
    const screenshot = path.join(OUT,'v14-live-login.png');
    await page.screenshot({path:screenshot});
    report.screenshot={file:'artifacts/v14-live-login.png',sha256:sha(fs.readFileSync(screenshot))};
    report.result='passed';
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(OUT,'v14-live-preview.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({result:report.result,assets:report.assets.length,protected:report.protected.length,writes:report.writeAttempts.length,browserErrors:report.pageErrors.length,origin:ORIGIN}));
}
main().catch(error => { console.error(error.message); process.exitCode=1; });
