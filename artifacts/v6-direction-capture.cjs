'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const B=require('../test/browser.cjs');
(async()=>{
  const browser=await B.launch(),page=await browser.newPage(),errors=[],captures=[];
  page.on('pageerror',e=>errors.push(e.message));
  try {
    await page.setViewport({width:1240,height:900,deviceScaleFactor:1});
    await page.goto(pathToFileURL(path.join(B.ROOT,'tools/pet-v6/preview.html')).href,{waitUntil:'load'});
    await page.waitForFunction(()=>window.renderPetPreview&&document.querySelectorAll('svg.pet-scene').length===2);
    async function capture(name,extra={}) {
      const file=path.join(B.ARTIFACTS,'v6-direction-'+name+'.png');
      const metrics=await page.evaluate(()=>Array.from(document.querySelectorAll('svg.pet-scene')).map(svg=>{
        const group=svg.querySelector('g.pet-character'),b=group.getBBox(),m=group.getScreenCTM();
        return {kind:svg.dataset.petKind,reaction:svg.dataset.petReaction,body:{x:m.a*b.x+m.c*b.y+m.e,y:m.b*b.x+m.d*b.y+m.f,w:b.width*m.a,h:b.height*m.d},animations:svg.getAnimations({subtree:true}).map(a=>({name:a.animationName,currentTime:a.currentTime,playState:a.playState}))};
      }));
      await page.screenshot({path:file,fullPage:false});
      captures.push({file:path.basename(file),...extra,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),metrics});
      console.log('Captured '+path.basename(file));
    }
    await capture('idle');
    for(const reaction of ['feed','wash','train']) {
      const start=await page.evaluate(value=>{window.renderPetPreview('plant',value,false);window.renderPetPreview('capybara',value,false);return performance.now();},reaction);
      for(const target of [0,1100,2200]) {
        const elapsed=await page.evaluate(t=>performance.now()-t,start);
        if(elapsed<target)await B.delay(target-elapsed);
        const actual=await page.evaluate(t=>performance.now()-t,start);
        await capture(reaction+'-'+String(target).padStart(4,'0')+'ms',{reaction,targetMilliseconds:target,measuredMilliseconds:actual});
      }
    }
    if(errors.length)throw new Error(errors.join('\n'));
    fs.writeFileSync(path.join(B.ARTIFACTS,'v6-direction-results.json'),JSON.stringify({directionOnly:true,createdAt:new Date().toISOString(),scope:'Standalone stage3 renderer preview, not integrated homepage or resource-consumption acceptance',errors,captures},null,2));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
