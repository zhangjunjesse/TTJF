'use strict';

// Isolated, example-data rendering evidence. This never signs in or writes a
// family record; completion feedback is invoked on the rendering controller.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const B = require('./browser.cjs');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.TEST_ARTIFACT_DIR || path.join(ROOT, '.git', 'farm-credit-evidence'));
const hashes = () => Object.fromEntries(['farm/scene.js', 'farm/ui-effects.js', 'farm-scene.js', 'farm-ui.js', 'test/farm-credit-browser.cjs']
  .map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex')]));
const report = { status: 'running', startedAt: new Date().toISOString(), checks: [], errors: [], sourceHashes: hashes(),
  boundaries: ['Isolated example-data fixture in desktop headless Edge/Chrome; no real family data or business writes.',
    'Actual WebGL target/PNG transfer and actual WEBGL_lose_context recovery; no physical iPad/Safari claim.'] };
fs.mkdirSync(OUT, { recursive: true });
const persist = () => fs.writeFileSync(path.join(OUT, 'credit-results.json'), JSON.stringify(report, null, 2) + '\n');
let browser, page;
persist();
async function check(label, action) {
  report.current = label; persist(); await action();
  report.checks.push({ label, result: 'passed' }); persist(); console.log('PASS ' + label);
}
const diag = () => page.evaluate(() => controller.diagnostics());
const wait = predicate => page.waitForFunction(predicate, { timeout: 12000 });
async function capture(name) {
  const image = await page.$('#credit-preview'); await image.screenshot({ path: path.join(OUT, name + '.png') }); await image.dispose();
}
async function run() {
  try {
    browser = await B.launch(); page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 1 });
    page.on('pageerror', error => report.errors.push(error.message));
    await page.evaluateOnNewDocument(() => {
      window.creditContexts = new Set();
      window.creditTiming = { readPixels: [], png: [] };
      const nativeGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
        const context = nativeGetContext.call(this, kind, ...args);
        if (/^webgl/.test(kind) && context) creditContexts.add(context);
        return context;
      };
      for (const type of [window.WebGLRenderingContext, window.WebGL2RenderingContext].filter(Boolean)) {
        const nativeRead = type.prototype.readPixels;
        type.prototype.readPixels = function (...args) {
          const start = performance.now();
          try { return nativeRead.apply(this, args); }
          finally { creditTiming.readPixels.push(performance.now() - start); }
        };
      }
      const nativePng = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function (...args) {
        const start = performance.now();
        try { return nativePng.apply(this, args); }
        finally { creditTiming.png.push(performance.now() - start); }
      };
    });
    await page.goto(pathToFileURL(path.join(ROOT, 'farm', 'verification', 'v12-fixture.html')).href, { waitUntil: 'load' });
    await wait(() => window.controller?.diagnostics().ready);
    const initial = await diag();
    await page.evaluate(() => {
      const image = document.createElement('img'); image.id = 'credit-preview'; image.alt = ''; image.setAttribute('aria-hidden', 'true');
      Object.assign(image.style, { position: 'fixed', right: '16px', top: '50px', width: '192px', height: '256px', background: '#2d6448' });
      document.body.appendChild(image); window.creditFrames = 0;
      window.publishCredit = frame => { if (frame) { image.src = frame; creditFrames++; } else image.removeAttribute('src'); };
      controller.update({ reducedMotion: true, credit: { enabled: true, balance: 25 }, onCreditFrame: publishCredit });
    });
    await wait(() => document.getElementById('credit-preview').naturalWidth === 192 && controller.diagnostics().credit.frameCount > 0);
    await check('a transparent actual Three.js treasury PNG uses the existing WebGL context and preserves the main camera', async () => {
      const d = await diag(); assert.equal(d.canvasId, initial.canvasId); assert.deepEqual(d.camera, initial.camera);
      assert.equal(d.dpr, initial.dpr); assert.equal(d.error, null); assert.equal(d.credit.failed, undefined);
      const pixels = await page.evaluate(() => {
        const image = document.getElementById('credit-preview'), canvas = document.createElement('canvas');
        canvas.width = 192; canvas.height = 256; const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        const data = ctx.getImageData(0, 0, 192, 256).data; let empty = 0, solid = 0, colored = 0;
        for (let i = 0; i < data.length; i += 4) { if (data[i + 3] === 0) empty++; if (data[i + 3] > 240) solid++; if (data[i] > data[i + 2] + 20 && data[i + 3] > 240) colored++; }
        return { empty, solid, colored, contexts: creditContexts.size, canvases: document.querySelectorAll('canvas').length };
      });
      assert.equal(pixels.contexts, 1); assert.equal(pixels.canvases, 1);
      assert.ok(pixels.empty > 15000, JSON.stringify(pixels)); assert.ok(pixels.solid > 7000, JSON.stringify(pixels));
      assert.ok(pixels.colored > 4000, 'golden/wooden foreground pixels must exist'); report.pixels = pixels;
      await capture('credit-static');
    });
    await check('reduced motion stays static and completion feedback appears once, then returns to idle', async () => {
      const before = await diag(); await B.delay(350); assert.equal((await diag()).credit.frameCount, before.credit.frameCount);
      await page.evaluate(() => controller.react('earn')); await wait(() => controller.diagnostics().credit.success);
      await capture('credit-success'); await B.delay(750); const done = await diag();
      assert.equal(done.credit.success, false); assert.equal(done.running, false);
      assert.equal(done.credit.frameCount, before.credit.frameCount + 2, 'static success and reset each publish one image');
    });
    await check('normal idle and success transfers respect their bounded rates while farm rendering remains live', async () => {
      await page.evaluate(() => controller.update({ reducedMotion: false }));
      await page.evaluate(() => { creditTiming.readPixels.length = 0; creditTiming.png.length = 0; });
      const idle = await diag(); await B.delay(1050); const afterIdle = await diag();
      assert.ok(afterIdle.credit.frameCount > idle.credit.frameCount); assert.ok(afterIdle.credit.frameCount - idle.credit.frameCount <= 7);
      assert.ok(afterIdle.frameCount > idle.frameCount);
      report.idlePerformance = await page.evaluate(() => {
        const stats = values => {
          const sorted = values.slice().sort((a, b) => a - b);
          return { samples: sorted.length, meanMs: sorted.length ? values.reduce((sum, value) => sum + value, 0) / sorted.length : null,
            p95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] : null };
        };
        return { readPixels: stats(creditTiming.readPixels), png: stats(creditTiming.png), farmFps: controller.diagnostics().fps };
      });
      await page.evaluate(() => controller.react('earn')); const success = await diag(); await B.delay(900); const after = await diag();
      assert.ok(after.credit.frameCount > success.credit.frameCount); assert.ok(after.credit.frameCount - success.credit.frameCount <= 12);
      assert.equal(after.canvasId, initial.canvasId); assert.equal(after.error, null);
      await page.evaluate(() => controller.pause(true)); const paused = await diag(); await B.delay(200);
      assert.equal((await diag()).credit.frameCount, paused.credit.frameCount);
      await page.evaluate(() => controller.pause(false));
    });
    await check('actual WebGL context loss clears the image and restoration recreates the target without replacing the canvas', async () => {
      await page.evaluate(() => {
        const canvas = document.querySelector('canvas.family-farm-canvas'), gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        window.creditLoss = gl.getExtension('WEBGL_lose_context');
        if (!creditLoss) throw new Error('WEBGL_lose_context is required'); creditLoss.loseContext();
      });
      await wait(() => controller.diagnostics().contextLost);
      assert.equal(await page.$eval('#credit-preview', image => image.hasAttribute('src')), false);
      await page.evaluate(() => controller.update({ credit: { enabled: true, balance: 300 }, reducedMotion: true }));
      await B.delay(150); await page.evaluate(() => creditLoss.restoreContext());
      await wait(() => controller.diagnostics().ready && !controller.diagnostics().contextLost && document.getElementById('credit-preview').hasAttribute('src'));
      const d = await diag(); assert.equal(d.canvasId, initial.canvasId); assert.equal(d.error, null); assert.ok(d.credit.frameCount > 0);
      assert.equal(await page.evaluate(() => creditContexts.size), 1); await capture('credit-restored');
    });
    await check('repeated enable/release stabilizes GPU memory and disposal removes the final image', async () => {
      const memories = [];
      for (let i = 0; i < 4; i++) {
        await page.evaluate(() => controller.update({ credit: { enabled: false, balance: 0 } }));
        await page.evaluate(() => controller.update({ credit: { enabled: true, balance: 25 } }));
        memories.push((await diag()).memory);
      }
      assert.deepEqual(memories[3], memories[1]); report.memorySamples = memories;
      await page.evaluate(() => controller.dispose());
      assert.equal(await page.$eval('#credit-preview', image => image.hasAttribute('src')), false);
      assert.equal(await page.evaluate(() => FamilyFarmScene.diagnostics().instances.length), 0);
      assert.equal(await page.$$eval('canvas', nodes => nodes.length), 0);
    });
    await check('a success queued during initial loading reaches the first rendered treasury frame', async () => {
      await page.evaluate(() => {
        window.controller = FamilyFarmScene.mount(document.getElementById('farm'), { ...sceneOptions, reducedMotion: true,
          credit: { enabled: true, balance: 30 }, onCreditFrame: publishCredit });
        controller.react('earn');
      });
      await wait(() => controller.diagnostics().ready && controller.diagnostics().credit.success);
      assert.equal(await page.$$eval('canvas', nodes => nodes.length), 1);
      await page.evaluate(() => controller.dispose());
    });
    await check('a decorative PNG failure clears queued success and leaves the reduced-motion farm usable and idle', async () => {
      await page.evaluate(() => {
        const nativePng = HTMLCanvasElement.prototype.toDataURL;
        window.restoreCreditPng = () => { HTMLCanvasElement.prototype.toDataURL = nativePng; };
        HTMLCanvasElement.prototype.toDataURL = function (...args) {
          if (this.width === 192 && this.height === 256) throw new Error('synthetic decorative PNG transfer failure');
          return nativePng.apply(this, args);
        };
        window.controller = FamilyFarmScene.mount(document.getElementById('farm'), { ...sceneOptions, reducedMotion: true,
          credit: { enabled: true, balance: 35 }, onCreditFrame: publishCredit });
        controller.react('earn');
      });
      await wait(() => controller.diagnostics().ready && controller.diagnostics().credit.failed);
      await page.evaluate(() => restoreCreditPng());
      await B.delay(200); const failed = await diag();
      assert.equal(failed.error, null); assert.equal(failed.running, false);
      assert.equal(await page.$eval('#credit-preview', image => image.hasAttribute('src')), false);
      await B.delay(200); assert.equal((await diag()).frameCount, failed.frameCount, 'failed queued feedback cannot keep RAF active');
      await page.evaluate(() => controller.react('greet', 'pet'));
      await B.delay(750); const usable = await diag();
      assert.equal(usable.ready, true); assert.equal(usable.error, null); assert.equal(usable.running, false);
      assert.ok(usable.frameCount > failed.frameCount, 'farm interaction still draws after decorative transfer failure');
      report.decorationFailure = { ready: usable.ready, error: usable.error, running: usable.running, credit: usable.credit };
      await page.evaluate(() => controller.dispose());
      assert.equal(await page.$$eval('canvas', nodes => nodes.length), 0);
    });
    assert.deepEqual(report.errors, []); report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.failure = error.stack; process.exitCode = 1; console.error(error); }
  finally {
    if (browser) await browser.close(); report.finishedAt = new Date().toISOString(); report.finalSourceHashes = hashes();
    report.sourceStable = JSON.stringify(report.sourceHashes) === JSON.stringify(report.finalSourceHashes); persist();
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length, failure: report.failure || null }));
  }
}
if (require.main === module) run();
