'use strict';
// Derive a compact audit from the completed run; this does not launch tests.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),load=name=>JSON.parse(fs.readFileSync(path.join(__dirname,name),'utf8'));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(path.resolve(root,file))).digest('hex');
const r=load('v6-browser-results.json'),c=load('v6-client-results.json');
assert.equal(r.requested,'all');assert.equal(r.failed.length,0);assert.equal(r.errors.length,0);assert.equal(r.skipped.length,0);assert.equal(r.sourceStable,true);assert.equal(r.passed,r.checks.length);
assert.equal(c.passed,8);assert.equal(c.runs.at(-1).passed.length,8);
for(const [file,value]of Object.entries(r.sourceHashes)){assert.equal(hash(file),value);assert.equal(r.sourceHashesAtFinish[file],value);}
for(const [file,value]of Object.entries(c.runs.at(-1).sourceHashes))assert.equal(value,r.sourceHashes[file]);
assert.equal(hash('export/little-steps-demo.html'),r.exportHash);assert.equal(r.exportHashAtFinish,r.exportHash);assert.equal(hash('test/v6-browser.cjs'),r.harnessHash);
const manifest=load('v6-preserved-v5.json');for(const [file,value]of Object.entries(manifest.hashes))assert.equal(hash(file),value);
const coreLog=fs.readFileSync(path.join(__dirname,'v6-core-tests.txt'),'utf8'),count=key=>Number(coreLog.match(new RegExp('^[#ℹ] '+key+' (\\d+)\\r?$','m'))?.[1]);
assert.equal(count('fail'),0);assert.equal(count('tests'),count('pass'));
const groups={};for(const check of r.checks)groups[check.group]=(groups[check.group]||0)+1;
const home=r.layouts.concat(r.stress),controls=home.flatMap(x=>x.controls),round=x=>Math.round(x*10)/10;
const frames=r.animations.flatMap(x=>x.frames),screenFiles=new Set(frames.map(x=>'artifacts/'+x.file));
screenFiles.add('artifacts/v6-companion-reduced-motion.png');
for(const p of r.portraits)if(p.name==='ipad-landscape'||p.name==='small-phone')screenFiles.add('artifacts/v6-companion-'+p.kind+'-stage'+p.stage+(p.name==='small-phone'?'-small-phone':'')+'.png');
for(const s of r.scenes)screenFiles.add('artifacts/v6-companion-'+s.kind+'-scene-'+s.sceneId+'.png');
for(const l of r.layouts)screenFiles.add('artifacts/v6-'+l.name+'-points.png');
const screenshotHashes=Object.fromEntries([...screenFiles].sort().map(file=>[file,hash(file)]));
const summary={version:'0.6',run:{requested:r.requested,startedAt:r.startedAt,finishedAt:r.finishedAt,durationSeconds:round((Date.parse(r.finishedAt)-Date.parse(r.startedAt))/1000)},
 results:{core:{passed:count('pass'),failed:count('fail')},client:{passed:c.runs.at(-1).passed.length,failed:0},consumer:{passed:r.passed,failed:r.failed.length,directHttpChecks:groups['atomic-api']+groups['pet-api']+groups['pet-concurrency'],renderedBrowserChecks:r.passed-groups['atomic-api']-groups['pet-api']-groups['pet-concurrency'],scriptErrors:r.errors.length,skipped:r.skipped.length},total:count('pass')+c.runs.at(-1).passed.length+r.passed},groups,
 geometry:{layoutViewports:r.layouts.length,stressFixtures:r.stress.length,stageViewportSamples:r.portraits.length,minimumHomeControlWidth:round(Math.min(...controls.map(x=>x.width))),minimumHomeControlHeight:round(Math.min(...controls.map(x=>x.height))),homeFillWidthRange:[Math.min(...home.map(x=>x.fill.width)),Math.max(...home.map(x=>x.fill.width))],homeFillHeightRange:[Math.min(...home.map(x=>x.fill.height)),Math.max(...home.map(x=>x.fill.height))],stage3Body:r.portraits.filter(x=>x.stage===3&&['ipad-landscape','phone','small-phone'].includes(x.name)).map(x=>({kind:x.kind,viewport:x.name,height:round(x.character.height),width:round(x.character.width),clippedBy:x.character.clippedBy}))},
 visual:{actionSequences:r.animations.length,actionScreenshots:frames.length,stageScreenshots:20,sceneScreenshots:r.scenes.length,hashedScreenshots:screenFiles.size,actionFrameTiming:'Targets 0/1100/2200ms after detecting the real reaction; measuredMilliseconds records geometry-sampling time immediately before each screenshot.',artSourceUnchanged:true},
 integrity:{sourceStable:r.sourceStable,productSources:r.sourceHashes,exportHash:r.exportHash,harnessHash:r.harnessHash,preservedV5Files:Object.keys(manifest.hashes).length,preservedV5Changed:[],clientMatchesFinalSource:true},
 boundaries:{device:r.deviceBoundary,assistant:r.assistantBoundary,fixture:r.fixtureBoundary},screenshotHashes};
fs.writeFileSync(path.join(__dirname,'v6-acceptance-summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({results:summary.results,geometry:summary.geometry,visual:summary.visual,integrity:{sourceStable:true,preservedV5Files:summary.integrity.preservedV5Files,preservedV5Changed:[]}},null,2));
