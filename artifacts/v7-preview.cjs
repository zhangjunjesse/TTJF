'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const B=require('../test/browser.cjs');
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(path.join(B.ROOT,f))).digest('hex');
async function main(){
  const sourceFiles=['app.js','styles.css','index.html','model.js','pet.js','pet.css'],start=Object.fromEntries(sourceFiles.map(f=>[f,hash(f)])),browser=await B.launch(),env=await B.createEnvironment(browser),page=await env.newPage({width:390,height:844}),images=[];
  const capture=async(name)=>{await B.capture(page,'preview-phone-'+name,'v7');images.push('artifacts/v7-preview-phone-'+name+'.png');};
  try{
    await env.load(page);const before=await B.totals(page);
    await B.click(page,B.action('add-points'));await B.click(page,B.action('points-mode','custom'));
    await B.fillForm(page,{name:'自己整理书包',points:7,reason:'自己把书包和水杯放好'});await B.click(page,'[name="saveAsTemplate"]');await page.$eval('.sheet-body',element=>{element.scrollTop=0;});await capture('diy');
    await B.click(page,B.SELECTORS.submit,{scroll:false});await page.waitForSelector(B.SELECTORS.answer);await capture('parent-verify');
    await B.click(page,'.sheet-footer '+B.action('parent-cancel'));for(let i=0;i<5&&(await B.ui(page)).form;i++)await B.closeSheet(page);await B.noSheet(page);
    await B.click(page,B.action('pet-hub'));await B.click(page,B.action('pet-tab','supply'));await B.click(page,B.action('pet-buy','snack'));await B.fillForm(page,{quantity:2});await capture('pet-buy');
    assert.deepEqual(await B.totals(page),before);assert.equal(env.requests.filter(r=>r.path==='/api/action').length,0);assert.deepEqual(env.errors,[]);
    const finish=Object.fromEntries(sourceFiles.map(f=>[f,hash(f)]));assert.deepEqual(finish,start);const details={capturedAt:new Date().toISOString(),description:'Real 390×844 Edge screenshots captured through hit-tested clicks and form input. Ordinary user facts for product preview; no composited notes or image edits. Drafts only; no saved business actions.',sourceHashes:start,images:Object.fromEntries(images.map(f=>[f,hash(f)])),scriptErrors:env.errors};fs.writeFileSync(path.join(B.ARTIFACTS,'v7-preview-results.json'),JSON.stringify(details,null,2)+'\n');console.log(images.join('\n'));
  }finally{await env.close();await browser.close();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
