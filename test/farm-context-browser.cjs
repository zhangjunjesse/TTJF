'use strict';

// Real browser/context recovery checks. The model gate delays the native WASM
// decoder; it never substitutes model data, WebGL contexts or context events.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const B = require('./browser.cjs');
const ROOT = path.resolve(__dirname, '..');
const CASE = process.env.FARM_CONTEXT_CASE || 'switching';
const CASES = ['switching', 'loading-first', 'restoring-first', 'dispose'];
assert.ok(CASES.includes(CASE), 'FARM_CONTEXT_CASE must be one of ' + CASES.join(', '));
const RUN = new Date().toISOString().replace(/[^0-9]/g, '') + '-' + process.pid;
const OUT = path.join(process.env.TEST_ARTIFACT_DIR ? path.resolve(process.env.TEST_ARTIFACT_DIR) :
  path.join(ROOT, 'data', 'farm-context-evidence'), CASE + '-' + RUN);
fs.mkdirSync(OUT, { recursive: true });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sources = ['farm/scene.js', 'farm-scene.js', 'test/farm-context-browser.cjs'];
const sourceHashes = () => Object.fromEntries(sources.map(file => [file, hash(fs.readFileSync(path.join(ROOT, file)))]));
const report = { group: CASE, startedAt: new Date().toISOString(), status: 'running', checks: [], errors: [],
  snapshots: [], screenshots: [], sourceHashes: sourceHashes(), boundaries: [
    'Isolated example-data component in a real headless desktop browser; no production accounts or business writes.',
    'WEBGL_lose_context performs the actual loss/restoration. Desktop checks do not establish physical iPad/Safari behavior.',
    'The delayed loading cases hold native WebAssembly.instantiate and then perform the original decoding.'
  ] };
const persist = () => fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(report, null, 2) + '\n');
let browser, page;
persist();
async function check(label, fn) {
  report.current = label; persist();
  await fn(); report.checks.push({ label, result: 'passed' }); persist(); console.log('PASS ' + label);
}
async function open(holdModels = false) {
  page = await browser.newPage();
  page.on('pageerror', error => { report.errors.push(error.message); persist(); });
  await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 1 });
  if (holdModels) await page.evaluateOnNewDocument(() => {
    const instantiate = WebAssembly.instantiate.bind(WebAssembly);
    const gate = new Promise(resolve => { window.releaseFarmModels = resolve; });
    window.farmDecoder = { pending: 0, completed: 0 };
    WebAssembly.instantiate = async (...args) => {
      window.farmDecoder.pending++;
      await gate;
      const result = await instantiate(...args);
      window.farmDecoder.completed++;
      return result;
    };
  });
  await page.goto(pathToFileURL(path.join(ROOT, 'farm', 'verification', 'v12-fixture.html')).href, { waitUntil: 'load' });
  await page.waitForFunction(() => window.controller, { timeout: 10000 });
  await page.evaluate(() => {
    window.recoveryStatuses = [];
    controller.update({ presentation: 'points', reducedMotion: true, onStatus: status => {
      recoveryStatuses.push({ ...status, diagnostics: controller.diagnostics() });
    } });
  });
  if (holdModels) {
    assert.equal(await page.evaluate(() => farmDecoder.pending > 0 && !controller.diagnostics().ready), true,
      'the real decoder must still be waiting before context loss');
  } else await ready('points');
}
async function snapshot(label) {
  const state = await page.evaluate(() => ({ controller: controller.diagnostics(), scene: FamilyFarmScene.diagnostics(),
    canvasId: document.querySelector('canvas.family-farm-canvas')?.id,
    presentation: document.querySelector('canvas.family-farm-canvas')?.dataset.presentation }));
  report.snapshots.push({ label, ...state }); persist(); return state;
}
async function ready(presentation) {
  await page.waitForFunction(() => controller.diagnostics().ready ||
    (controller.diagnostics().error && !controller.diagnostics().contextLost), { timeout: 12000 });
  const { controller: d, scene, presentation: canvasPresentation } = await snapshot('ready-' + presentation);
  assert.equal(d.error, null, JSON.stringify(d)); assert.equal(d.contextLost, false); assert.equal(d.ready, true);
  assert.equal(d.presentation, presentation); assert.equal(d.station?.id, presentation,
    'restoration must build the presentation requested while WebGL was unavailable');
  assert.equal(canvasPresentation, presentation); assert.ok(d.drawCalls > 0, 'the recovered renderer must draw');
  assert.equal(scene.instances.length, 1); assert.equal(scene.canvasCount, 1); assert.ok(scene.activeCount <= 1);
  const statuses = await page.evaluate(() => recoveryStatuses.filter(status => status.ready));
  assert.ok(statuses.length > 0, 'the host must be told that rendering recovered');
  for (const status of statuses) {
    assert.equal(status.diagnostics.error, null); assert.equal(status.diagnostics.contextLost, false);
    assert.equal(status.diagnostics.station?.id, status.diagnostics.presentation,
      'each ready notification must already expose the current station');
    assert.ok(status.diagnostics.drawCalls > 0, 'a visible recovered scene must have drawn before publishing ready');
  }
  return d;
}
async function lose() {
  const before = await page.evaluate(() => {
    window.contextCanvas = document.querySelector('canvas.family-farm-canvas');
    const gl = contextCanvas.getContext('webgl2') || contextCanvas.getContext('webgl');
    window.lossExtension = gl.getExtension('WEBGL_lose_context');
    if (!lossExtension) throw new Error('WEBGL_lose_context is required; this check cannot simulate success');
    window.contextEvents = { lost: 0, restored: 0 };
    contextCanvas.addEventListener('webglcontextlost', () => contextEvents.lost++, { once: true });
    contextCanvas.addEventListener('webglcontextrestored', () => contextEvents.restored++, { once: true });
    window.recoveryStatuses = [];
    const state = controller.diagnostics(); lossExtension.loseContext(); return state;
  });
  await page.waitForFunction(() => contextEvents.lost > 0 && controller.diagnostics().contextLost, { timeout: 5000 });
  const { controller: lost } = await snapshot('context-lost');
  assert.equal(lost.ready, false); assert.equal(lost.running, false); assert.equal(lost.error, 'FARM_CONTEXT_LOST');
  return before;
}
async function restore() {
  // The extension dispatches loss asynchronously and browser recovery is delayed.
  await B.delay(150);
  await page.evaluate(() => lossExtension.restoreContext());
  await page.waitForFunction(() => contextEvents.restored > 0, { timeout: 5000 });
}
async function image(name) {
  await page.evaluate(() => controller.resize());
  const handle = await page.$('canvas.family-farm-canvas');
  const buffer = await handle.screenshot({ path: path.join(OUT, name + '.png') }); await handle.dispose();
  const digest = hash(buffer); report.screenshots.push({ file: name + '.png', sha256: digest }); persist(); return digest;
}
const scenarios = {
  async switching() {
    await open();
    const id = await page.evaluate(() => controller.diagnostics().id);
    await check('Recovery applies the latest protected-form route before publishing ready', async () => {
      await lose();
      await page.evaluate(() => {
        controller.update({ presentation: 'authorization' });
        controller.update({ presentation: 'points' });
        controller.update({ presentation: 'rewards', lighting: 'night', pet: { kind: 'capybara', name: '测试伙伴' },
          growth: { stage: 5, stars: 1 }, viewInsets: { left: 120, top: 40, bottom: 60 }, reducedMotion: true });
      });
      await restore(); const d = await ready('rewards'); assert.equal(d.id, id);
      const actual = await image('pending-options-restored');
      await page.evaluate(() => {
        controller.update({ presentation: 'points', lighting: 'day', pet: { kind: 'plant' }, growth: { stage: 1 }, viewInsets: {} });
        controller.update({ presentation: 'rewards', lighting: 'night', pet: { kind: 'capybara', name: '测试伙伴' },
          growth: { stage: 5, stars: 1 }, viewInsets: { left: 120, top: 40, bottom: 60 }, reducedMotion: true });
      });
      assert.equal(actual, await image('pending-options-reference'), 'recovered pixels must match the same options applied with a live context');
    });
    await check('Another loss reconciles lighting and camera insets without a presentation rebuild', async () => {
      const expected = await image('night-reference');
      await page.evaluate(() => controller.update({ lighting: 'day', viewInsets: {} }));
      assert.notEqual(await image('day-before-loss'), expected, 'the reference must detect changed visual options');
      await lose();
      await page.evaluate(() => controller.update({ lighting: 'night', viewInsets: { left: 120, top: 40, bottom: 60 } }));
      await restore(); const d = await ready('rewards'); assert.equal(d.id, id);
      assert.equal(await image('night-restored'), expected, 'pending lighting and camera options must reach the recovered scene');
    });
    await check('A further loss can return from authorization to points on the same canvas', async () => {
      await page.evaluate(() => controller.update({ presentation: 'authorization' }));
      const before = await lose(); await page.evaluate(() => controller.update({ presentation: 'points' }));
      await restore(); const d = await ready('points'); assert.equal(d.id, before.id); assert.equal(d.canvasId, before.canvasId);
    });
  },
  async 'loading-first'() {
    await open(true); await lose();
    await check('Models finishing during context loss remain unavailable until the current station is rebuilt on recovery', async () => {
      const statuses = await page.evaluate(() => {
        controller.update({ presentation: 'authorization', lighting: 'night' });
        const count = recoveryStatuses.length; releaseFarmModels(); return count;
      });
      await page.waitForFunction(count => farmDecoder.completed > 0 && recoveryStatuses.length > count,
        { timeout: 12000 }, statuses);
      const { controller: d } = await snapshot('models-finished-while-lost');
      assert.equal(d.ready, false); assert.equal(d.running, false); assert.equal(d.error, 'FARM_CONTEXT_LOST');
      await page.evaluate(() => controller.update({ presentation: 'rewards' }));
      await restore(); await ready('rewards');
    });
  },
  async 'restoring-first'() {
    await open(true); await lose();
    await check('A context restored before models finish stays loading and then builds the latest station', async () => {
      await page.evaluate(() => controller.update({ presentation: 'authorization', lighting: 'night' }));
      await restore();
      const { controller: d } = await snapshot('restored-before-models');
      assert.equal(d.ready, false); assert.equal(d.contextLost, false); assert.equal(d.error, null); assert.equal(d.frameCount, 0);
      assert.equal(await page.evaluate(() => recoveryStatuses.some(status => status.ready)), false);
      await page.evaluate(() => { controller.update({ presentation: 'rewards' }); releaseFarmModels(); });
      await ready('rewards');
    });
  },
  async dispose() {
    await open(true); await lose();
    await check('Disposal during loss and model loading never recreates a scene or publishes ready', async () => {
      const statuses = await page.evaluate(() => {
        controller.update({ presentation: 'authorization' }); controller.dispose();
        const count = recoveryStatuses.length; releaseFarmModels(); return count;
      });
      await restore();
      await page.waitForFunction(() => farmDecoder.completed > 0, { timeout: 10000 });
      await B.delay(100);
      const { controller: d, scene } = await snapshot('disposed-after-real-restoration');
      assert.equal(d.disposed, true); assert.equal(d.ready, false); assert.equal(d.running, false); assert.equal(d.frameCount, 0);
      assert.equal(scene.canvasCount, 0); assert.equal(scene.instances.length, 0);
      assert.equal(await page.evaluate(() => recoveryStatuses.length), statuses, 'async completion must not notify a disposed host');
    });
  }
};
(async () => {
  browser = await B.launch(); await scenarios[CASE]();
  assert.deepEqual(report.errors, [], 'the real browser must not emit page errors');
  assert.deepEqual(sourceHashes(), report.sourceHashes, 'sources must remain stable during a run');
  report.status = 'passed';
})().catch(error => {
  report.status = 'failed'; report.failure = { message: error.message, stack: error.stack };
  process.exitCode = 1; console.error(error);
}).finally(async () => {
  report.finishedAt = new Date().toISOString(); persist();
  if (browser) await browser.close();
  console.log(JSON.stringify({ group: CASE, status: report.status, checks: report.checks.length, evidence: OUT }));
});
