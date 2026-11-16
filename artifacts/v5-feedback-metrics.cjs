'use strict';
const fs=require('node:fs');
const path=require('node:path');
const B=require('../test/browser.cjs');
const V=require('../test/v5-browser.cjs');
const {createAssistantService}=require('../assistant-service.cjs');
(async()=>{
 const browser=await B.launch();
 const env=await B.createEnvironment(browser,{state:V.seeded(128),assistantService:createAssistantService({apiKey:''})});
 try{
  const page=await env.newPage({width:1920,height:1080});await env.load(page);await B.connected(page);
  await B.openCredit(page,{points:6,reason:'核查反馈字体墨迹边界'});await B.submitProtected(page);await B.noSheet(page);
  const metrics=await page.$eval('#home-feedback',el=>{
   const s=getComputedStyle(el),r=el.getBoundingClientRect(),c=document.createElement('canvas').getContext('2d');
   c.font=[s.fontStyle,s.fontVariant,s.fontWeight,s.fontSize,s.fontFamily].join(' ');
   const m=c.measureText(el.textContent),line=parseFloat(s.lineHeight);
   const marker=document.createElement('span');marker.style.cssText='display:inline-block;width:0;height:0;line-height:0;padding:0;border:0;vertical-align:baseline';el.appendChild(marker);
   const baseline=marker.getBoundingClientRect().top;marker.remove();
   return {text:el.textContent,font:c.font,fontSize:s.fontSize,lineHeight:s.lineHeight,box:{x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,bottom:r.bottom},clientHeight:el.clientHeight,scrollHeight:el.scrollHeight,
    fontAscent:m.fontBoundingBoxAscent,fontDescent:m.fontBoundingBoxDescent,inkAscent:m.actualBoundingBoxAscent,inkDescent:m.actualBoundingBoxDescent,baseline,inkTop:baseline-m.actualBoundingBoxAscent,inkBottom:baseline+m.actualBoundingBoxDescent};
  });
  await page.screenshot({path:path.join(__dirname,'v5-feedback-glyph-wide.png'),clip:{x:Math.floor(metrics.box.x)-5,y:Math.floor(metrics.box.y)-10,width:380,height:68}});
  fs.writeFileSync(path.join(__dirname,'v5-feedback-glyph-metrics.json'),JSON.stringify(metrics,null,2));console.log(JSON.stringify(metrics,null,2));
 }finally{await env.close();await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
