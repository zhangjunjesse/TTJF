'use strict';
// Usage: node tools/verify-saas-release.cjs <v14 baseline report.json> <v14 full report.json>
// No live family reads. This checks the exact reports selected by the reviewer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname,'..');
const read = file => fs.readFileSync(path.join(ROOT,file),'utf8');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,file))).digest('hex');
function tap(file,expected) {
  const text = read(file), counts = {};
  for (const field of ['tests','pass','fail','cancelled','skipped']) {
    const matches = [...text.matchAll(new RegExp('^# '+field+' (\\d+)$','gm'))];
    assert.equal(matches.length,1,file+' has one final TAP summary');
    counts[field] = Number(matches[0][1]);
  }
  assert.equal(counts.tests,expected); assert.equal(counts.pass,expected);
  assert.equal(counts.fail+counts.cancelled+counts.skipped,0);
  return {file,...counts,sha256:sha(file)};
}
const core = tap('artifacts/v14-core-tests.txt',227);
const postgres = tap('artifacts/v14-saas-tests.txt',42);
const sourceHashes = {}, documentUpdates = new Set(), unusedScenarioUpdates = [];
function verifyUnusedBaselineDifference(recordedHash) {
  const file='test/saas-browser.cjs', text=read(file), full=read('test/saas-full-browser.cjs');
  // Full business passes its own run to the unchanged executor. Only these two
  // selectors inside the baseline-only run may differ from that report's source.
  assert.match(text,/async function execute\(scenario = run\)/);
  assert.match(text,/if \(require\.main === module\) execute\(\);/);
  assert.match(full,/Q\.execute\(run\);\s*$/);
  const exportsText=text.slice(text.indexOf('module.exports ='),text.indexOf('if (require.main === module)'));
  assert.ok(exportsText.length>0); assert.doesNotMatch(exportsText,/\brun\b/);
  const start=text.indexOf('async function run() {'), end=text.indexOf('async function execute(scenario = run)');
  assert.ok(start>=0 && end>start);
  const corrections=[
    "await click(page, action('profile-edit')); await B.fillForm(page, { childName: 'SYNTHETIC_LOGOUT_DRAFT' });",
    "await login(page, ownerEmail, PASSWORD, familyA); await ready(page, familyA); await click(page, action('profile-edit'));"
  ];
  let previous=text;
  for (const corrected of corrections) {
    const index=text.indexOf(corrected);
    assert.ok(index>start && index<end); assert.equal(index,text.lastIndexOf(corrected),'One exact corrected selector');
    previous=previous.replace(corrected,corrected.replace("action('profile-edit')","action('profile')"));
  }
  assert.equal(crypto.createHash('sha256').update(previous).digest('hex'),recordedHash,'Only two baseline-only selectors changed; shared helpers and fixture are identical');
  return {scope:'Two profile selectors inside the baseline-only run; full passes its own scenario to execute',reconstructedPreviousSha256:recordedHash,sharedHelpersUnchanged:true};
}
function unchanged(hashes, origin, allowUnusedBaseline=false) {
  for (const [file,hash] of Object.entries(hashes)) {
    const current = sha(file);
    if (file==='docs/saas-design.md' || file==='docs/saas-completion.md') { if (current!==hash) documentUpdates.add(file); }
    else if (allowUnusedBaseline && file==='test/saas-browser.cjs' && current!==hash) {
      unusedScenarioUpdates.push({file,report:origin,recorded:hash,current,...verifyUnusedBaselineDifference(hash)});
    } else assert.equal(current,hash,origin+' tested source unchanged: '+file);
    sourceHashes[file] = current;
  }
}
function browserReport(file,full,expected) {
  assert.equal(typeof file,'string','Pass explicit baseline and full browser report paths');
  const normalized = file.replace(/\\/g,'/');
  assert.match(normalized,full ? /^artifacts\/v14-full-browser\/[^/]+\/report\.json$/ : /^artifacts\/v14-browser\/[^/]+\/report\.json$/);
  const report = JSON.parse(read(normalized));
  assert.equal(report.result,'passed'); assert.equal(report.checks.length,expected);
  assert.ok(report.checks.every(check=>check.result==='passed'));
  assert.equal(report.failed.length+report.pageErrors.length+report.skipped.length,0);
  assert.equal(report.sourceStable,true);
  assert.ok(report.layouts.length>0); assert.ok(report.screenshots.length>0);
  for (const image of report.screenshots) assert.equal(sha(image.file),image.sha256,image.file);
  // No runtime/shared-helper mismatch is accepted. The full suite may only
  // predate the two proven baseline-only selector corrections checked above.
  unchanged(report.sourceHashes,normalized,full);
  return {file:normalized,checks:report.checks.length,layouts:report.layouts.length,screenshots:report.screenshots.length,
    pageErrors:0,sourceStable:true,sha256:sha(normalized)};
}
const browser = browserReport(process.argv[2],false,21);
const fullBrowser = browserReport(process.argv[3],true,27);
const auditFile = 'artifacts/v14-action-audit.json', audit = JSON.parse(read(auditFile));
assert.equal(audit.result,'passed'); assert.equal(audit.sourceStable,true);
assert.equal(audit.summary.uniqueActionTypes,27); assert.equal(audit.summary.committedVariants,98);
assert.equal(audit.summary.checks,528); assert.equal(audit.variants.length,98);
assert.ok(audit.variants.every(item=>item.result==='passed')); assert.equal(audit.summary.otherFamilyUnchanged,true);
unchanged(audit.sourceHashes,auditFile);
for (const file of ['tools/saas-local.cjs','tools/saas-data.cjs','tools/verify-saas-preview.cjs','tools/verify-saas-release.cjs',
  'test/saas-data.test.cjs','test/saas-model.test.cjs','test/saas-calendar.test.cjs','test/saas-client.test.cjs','test/v14-client.test.cjs',
  'test/saas-auth.test.cjs','test/saas-store.test.cjs','test/saas-server.test.cjs','test/saas-lifecycle.test.cjs','test/saas-maintenance.test.cjs',
  'package-lock.json','compose.saas.yml','Dockerfile.saas','compose.production.yml','saas.env.example','.dockerignore','.gitignore',
  'docs/saas-operations.md','docs/saas-completion.md','README.md']) sourceHashes[file]=sha(file);
const frozen = {
  'farm-scene.js':'b0b1526889b498aecaf59cc6b16d7d79d4677b20fbfb90f754d112f7abd879de',
  'export/little-steps-demo.html':'407b9cf1e94c44fd6f7b1098b04b002c380e5cbe58e29885d5d750eb3a1e94f3'
};
for (const [file,hash] of Object.entries(frozen)) assert.equal(sha(file),hash,'Frozen historical file unchanged: '+file);
let checkedLinks=0;
const documents=['README.md','docs/saas-design.md','docs/saas-completion.md','docs/saas-operations.md','docs/core-redesign.md',
  'docs/parent-onboarding.md','docs/家庭看板需求文档.md','docs/farm-design-proposal.md','docs/self-explanatory-ui.md',
  'artifacts/v14-saas-coverage-plan.md','artifacts/v14-saas-verification.md'];
for (const file of documents) {
  sourceHashes[file]=sha(file);
  for (const match of read(file).matchAll(/\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))\)/g)) {
    const destination=match[1]||match[2];
    if (/^[a-z][a-z0-9+.-]*:/i.test(destination)||destination.startsWith('#')) continue;
    const target=decodeURIComponent(destination.split('#')[0]);
    assert.ok(fs.existsSync(path.resolve(ROOT,path.dirname(file),target)),file+' links to missing '+target);
    checkedLinks++;
  }
}
const liveFile='artifacts/v14-live-preview.json', live=JSON.parse(read(liveFile));
assert.equal(live.result,'passed'); assert.equal(live.pageErrors.length+live.writeAttempts.length,0);
for (const item of live.assets) assert.equal(sha(item.file),item.sha256);
assert.equal(sha(live.screenshot.file),live.screenshot.sha256);
const pkg=JSON.parse(read('package.json')), lock=JSON.parse(read('package-lock.json'));
assert.equal(pkg.version,'0.14.0'); assert.equal(lock.version,pkg.version); assert.equal(lock.packages[''].version,pkg.version);
assert.deepEqual(lock.packages[''].dependencies,pkg.dependencies);
assert.match(read('docs/saas-design.md'),/^# .*（Current）/);
assert.match(read('docs/saas-completion.md'),/^# .*（Current）/);
const summary={version:pkg.version,at:new Date().toISOString(),result:'passed',core,postgres,browser,fullBrowser,
  actionAudit:{file:auditFile,...audit.summary,sourceStable:true,sha256:sha(auditFile)},
  livePreview:{file:liveFile,url:live.origin,assets:live.assets.length,protected:live.protected.length,writes:0,pageErrors:0,sha256:sha(liveFile)},
  deployment:{composeConfiguration:'passed',imageBuild:'blocked at DockerHub base-image metadata/anonymous-token fetch by connection timeout; no image built',publicDeployment:'not performed'},
  checkedLinks,sourceHashes,frozen,documentUpdatesAfterBrowserRun:[...documentUpdates],unusedBaselineScenarioUpdatesAfterFullRun:unusedScenarioUpdates,
  unchangedHistoricalWhitespace:'Broad git diff --check flags six pre-existing generated whitespace lines in export/little-steps-demo.html. Its SHA256 matches the frozen pre-SaaS baseline. The passing scoped source check excludes frozen export files and generated artifacts.',
  boundaries:['Local multi-family beta only; no public deployment/billing/commit/push.',
    'No real legacy family file read, assigned or imported.',
    'Real local SMTP protocol tested; external delivery and deployed HTTPS not tested.',
    'Headless Edge and synthetic visibility/file-chooser events are not physical iPad/Safari, native BFCache or OS suspension verification.',
    'Crop maturity and daily milestones use an injected server clock.',
    'Only same-session ordinary memory drafts may resume after server revalidation; passwords, PINs and old grants never resume.',
    'The sound preference is one device-only boolean, not business data or a family cache.',
    'Family backup/CLI restore used synthetic private files; production backup/PITR was not performed.',
    'External AI provider internals and real microphone recognition were not tested.']};
fs.writeFileSync(path.join(ROOT,'artifacts/v14-summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({result:summary.result,core:core.pass,postgres:postgres.pass,browser:browser.checks,
  fullBrowser:fullBrowser.checks,actionTypes:27,actionVariants:98,liveAssets:live.assets.length,checkedLinks,frozenFiles:Object.keys(frozen).length}));
