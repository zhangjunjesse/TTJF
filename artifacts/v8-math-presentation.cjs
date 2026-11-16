'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const B=require('../test/browser.cjs'),{createServer}=require('../server.cjs');
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(path.join(B.ROOT,file))).digest('hex');
(async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'family-v8-math-view-')),dataFile=path.join(directory,'state.json');
  const server=createServer({dataFile,now:()=>new Date(B.FIXTURE_TIME)}),result={purpose:'Additional presentation inspection for the frozen math option; not another consumer scenario count',appHash:digest('app.js'),screens:[],errors:[]};
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port,browser=await B.launch();
  try{
    const page=await browser.newPage();await page.setViewport({width:390,height:844,deviceScaleFactor:1});page.on('pageerror',e=>result.errors.push(e.message));
    await page.goto(origin,{waitUntil:'load'});await B.connected(page);assert.equal((await B.ui(page)).parentConfigured,false);
    await B.click(page,B.action('preferences'));await B.click(page,B.action('parent-config'));
    for(const name of ['pin','confirmPin'])await B.fill(page,'[name="'+name+'"]','123456');
    await B.fill(page,'[name="method"]','math');
    async function inspect(name,title){
      const screen=await page.evaluate(()=>({title:document.querySelector('#sheet-title').innerText,text:document.querySelector('.sheet').innerText,fields:['pin','confirmPin'].map(name=>{const e=document.querySelector('[name="'+name+'"]');return {name,hidden:e.closest('label').hidden,disabled:e.disabled,empty:e.value==='',height:e.getBoundingClientRect().height};})}));
      assert.equal(screen.title,title);for(const f of screen.fields){assert.equal(f.hidden,true);assert.equal(f.disabled,true);assert.equal(f.empty,true);assert.equal(f.height,0);}
      await B.reachable(page,B.SELECTORS.submit);await B.capture(page,name,'v8');const file='artifacts/v8-'+name+'.png';result.screens.push({file,sha256:digest(file),...screen});
    }
    await inspect('math-settings-first','设置家长验证');await B.click(page,B.SELECTORS.submit,{scroll:false});await page.waitForFunction(()=>!window.FamilyDemo.getUI().pending&&window.FamilyDemo.getUI().parentConfigured===true);
    await B.click(page,B.action('parent-config'));await inspect('math-settings-change','修改家长验证');
    await B.fill(page,'[name="method"]','pin');
    for(const name of ['pin','confirmPin']){const v=await page.$eval('[name="'+name+'"]',e=>({hidden:e.closest('label').hidden,disabled:e.disabled,empty:e.value===''}));assert.deepEqual(v,{hidden:false,disabled:false,empty:true});}
    assert.deepEqual(result.errors,[]);assert.equal(digest('app.js'),result.appHash);result.passed=true;
    fs.writeFileSync(path.join(B.ARTIFACTS,'v8-math-presentation.json'),JSON.stringify(result,null,2)+'\n');console.log('Math first/change titles and hidden, disabled, cleared PIN fields inspected; switching back restores empty enabled fields.');
  }finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('family-v8-math-view-'));fs.rmSync(directory,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
