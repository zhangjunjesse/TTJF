'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),output=path.join(__dirname,'v7-preserved-v6.json');
if(fs.existsSync(output))throw new Error('The v0.6 protection manifest already exists; keep it unchanged.');
const files=['test/v6-browser.cjs','test/client.test.cjs',...fs.readdirSync(__dirname).filter(n=>n.startsWith('v6-')).map(n=>'artifacts/'+n),...['little-steps-v6.html','little-steps-v6.zip','v6-package-verification.json','v6-delivery-manifest.json'].map(n=>'export/'+n)];
const hashes=Object.fromEntries(files.filter(f=>fs.statSync(path.join(root,f)).isFile()).sort().map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')]));
fs.writeFileSync(output,JSON.stringify({capturedAt:new Date().toISOString(),scope:'v0.6 artifacts, consumer/client scripts, retained HTML/ZIP/package audit/delivery manifest',hashes},null,2)+'\n');
console.log(Object.keys(hashes).length+' v0.6 files protected');
