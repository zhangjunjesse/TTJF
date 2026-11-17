'use strict';
// v12-only component evidence. This fixture has no family data or economic API.
// Automated checks prove mechanics; screenshots require a separate visual review.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const B = require('../test/browser.cjs');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(__dirname, 'verification');
const EVIDENCE_TAG = process.env.V12_EVIDENCE_TAG || '';
assert.match(EVIDENCE_TAG, /^[a-z0-9-]*$/);
const PREFIX = 'v12' + (EVIDENCE_TAG ? '-' + EVIDENCE_TAG : '');
const FORCE_WEBGL1 = process.env.V12_WEBGL1 === '1';
const fixtureURL = pathToFileURL(path.join(OUT, 'v12-fixture.html')).href;
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
const sourceHashes = () => Object.fromEntries(['farm-scene.js', 'farm/scene.js', 'farm/garden.js', 'farm/companions.js', 'farm/primitives.js', 'farm/models.js', 'farm/verify-v12.cjs', 'farm/verification/v12-fixture.html'].filter(file => fs.existsSync(path.join(ROOT, file))).map(file => [file, sha(file)]));
const report = { evidenceTag: EVIDENCE_TAG || 'untagged', startedAt: new Date().toISOString(), sourceHashes: sourceHashes(), checks: [], scenes: [], screenshots: [], errors: [], network: [], visualStatus: 'pending-image-review', boundaries: ['Desktop headless Edge with emulated viewport/touch; no physical iPad/Safari claim.', 'Isolated component fixture with example data, not the live family app.', 'Mechanical checks and diagnostic flags do not establish visual parity. Review actual captured images against artifacts/v12-reference.', 'Day/night are visual modes only. Their rendered light and material changes require image review, not only a diagnostics string.'] };
let browser, page;
const diag = () => page.evaluate(() => window.controller.diagnostics());
async function ready() { await page.waitForFunction(() => window.controller && (controller.diagnostics().ready || controller.diagnostics().error), { timeout: 30000 }); const d = await diag(); assert.ok(d.ready && d.webgl && !d.error, JSON.stringify(d)); return d; }
async function canvas() { const handle = await page.$('canvas.family-farm-canvas'); assert.ok(handle); return handle; }
async function viewCanvas() { const handle = await canvas(); await handle.evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' })); await B.delay(80); await handle.dispose(); }
async function rect() { return page.$eval('canvas.family-farm-canvas', node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }); }
async function capture(name) {
  await viewCanvas(); await B.delay(150);
  const handle = await canvas(), file = 'farm/verification/' + PREFIX + '-' + name + '.png';
  await handle.screenshot({ path: path.join(ROOT, file) }); await handle.dispose();
  const diagnostics = await diag(); report.scenes.push({ name, diagnostics }); report.screenshots.push({ file, sha256: sha(file) });
}
async function click(id) { await B.click(page, '#' + id); await ready(); }
async function check(label, fn) { await fn(); report.checks.push({ label, result: 'passed' }); console.log('PASS ' + label); }
async function open(options, viewport) {
  await page.setViewport(viewport); await page.goto(fixtureURL + '?' + new URLSearchParams({ ...options, ...(FORCE_WEBGL1 ? { webgl1: '1' } : {}) }), { waitUntil: 'load' }); await ready();
}
async function visibleTarget(type) {
  return page.evaluate(type => controller.diagnostics().hitTargets.find(target => {
    if (target.type !== type) return false;
    const node = document.elementFromPoint(target.center.x, target.center.y);
    return node && node.matches('canvas.family-farm-canvas');
  }), type);
}
async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  try {
    browser = await B.launch(); page = await browser.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url())) report.network.push(request.url()); });
    await open({ width: 650, height: 470, mode: 'home' }, { width: 1024, height: 768, deviceScaleFactor: 1 });
    await check('New renderer loads a continuous world with actual shadow mapping', async () => {
      report.webglVersion = await page.$eval('canvas.family-farm-canvas', canvas => { const gl = canvas.getContext('webgl2') || canvas.getContext('webgl'); return gl.getParameter(gl.VERSION); });
      if (FORCE_WEBGL1) assert.match(report.webglVersion, /^WebGL 1\./);
      const d = await diag(); assert.equal(d.world.terrain, 'continuous'); assert.ok(d.world.width >= 60 && d.world.depth >= 60);
      assert.equal(d.shadows.enabled, true); assert.ok(d.shadows.mapSize > 0 || d.shadows.mapSize.width > 0);
      assert.equal(await page.$$eval('canvas', nodes => nodes.length), 1);
    });
    const identity = (await diag()).canvasId;
    await check('Both companions and three growth stages use the same live renderer; images recorded for review', async () => {
      for (const kind of ['plant', 'capybara']) {
        await click('kind-' + kind);
        for (const stage of [1, 3, 5]) {
          await click('stage-' + stage); await click('mode-home'); await capture(kind + '-stage-' + stage + '-home');
          const d = await diag(); assert.equal(d.canvasId, identity); assert.ok(d.bodyScreenBounds && d.bodyScreenBounds.height > 0);
        }
        await click('mode-expanded'); await capture(kind + '-expanded');
      }
    });
    await check('Day and night update the same renderer and keep the farm geometry', async () => {
      await click('mode-expanded'); await click('lighting-day'); const day = await diag(); await capture('desktop-day-expanded');
      await click('lighting-night'); await B.delay(300); const night = await diag(); assert.equal(night.lighting, 'night'); assert.equal(night.canvasId, day.canvasId);
      assert.deepEqual(night.world, day.world); assert.equal(night.hitTargets.length, day.hitTargets.length); await capture('desktop-night-expanded');
      await click('mode-home'); await capture('capybara-night-home'); await click('lighting-day'); assert.equal((await diag()).lighting, 'day');
    });
    await check('Real mouse dragging pans the expanded camera without selecting a target', async () => {
      await click('mode-expanded'); await click('camera-reset'); await viewCanvas();
      const r = await rect(), before = await diag(), picks = await page.evaluate(() => picks.length);
      assert.equal(before.camera.canPan, true);
      await page.mouse.move(r.x + r.width * .5, r.y + r.height * .58); await page.mouse.down();
      await page.mouse.move(r.x + r.width * .72, r.y + r.height * .67, { steps: 12 }); await page.mouse.up(); await B.delay(180);
      const after = await diag(); assert.notDeepEqual(after.camera.target, before.camera.target); assert.equal(await page.evaluate(() => picks.length), picks);
      await capture('desktop-panned');
    });
    await check('Wheel and visible buttons zoom the same camera, and reset restores the initial framing', async () => {
      await click('camera-reset'); await viewCanvas(); const baseline = (await diag()).camera, r = await rect();
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2); await page.mouse.wheel({ deltaY: -240 }); await B.delay(200);
      assert.notEqual((await diag()).camera.zoom, baseline.zoom); await capture('desktop-wheel-zoom');
      await click('zoom-out'); await click('zoom-in'); await click('camera-reset');
      const reset = (await diag()).camera; assert.ok(Math.abs(reset.zoom - baseline.zoom) < .001); assert.deepEqual(reset.target, baseline.target);
    });
    await check('An actual plot click still selects correctly after camera browsing', async () => {
      await viewCanvas(); const target = await visibleTarget('plot'); assert.ok(target);
      await page.mouse.click(target.center.x, target.center.y);
      const selected = await page.evaluate(() => picks.at(-1)); assert.equal(selected.type, 'plot'); assert.equal(selected.id, target.id);
      await capture('desktop-plot-selected');
    });
    await check('Both species and view modes stabilize GPU resource allocation after warmup', async () => {
      for (let i = 0; i < 2; i++) for (const kind of ['plant', 'capybara']) { await click('kind-' + kind); await click('mode-home'); await click('mode-expanded'); }
      await B.delay(1500); const baseline = (await diag()).memory; report.resourceBaseline = baseline;
      for (let i = 1; i <= 6; i++) {
        await click('kind-plant'); await click('mode-home'); await click('mode-expanded');
        await click('kind-capybara'); await click('mode-home'); await click('mode-expanded');
        if ([2, 4, 6].includes(i)) { const memory = (await diag()).memory; (report.resourceSamples ||= []).push({ cycles: i, memory }); assert.deepEqual(memory, baseline); }
      }
    });
    await check('Pause and resume stop drawing and recover the same canvas', async () => {
      await click('pause'); const paused = await diag(); await B.delay(220); assert.equal((await diag()).frameCount, paused.frameCount);
      await click('resume'); await B.delay(220); assert.ok((await diag()).frameCount > paused.frameCount); assert.equal((await diag()).canvasId, identity);
    });
    for (const width of [390, 320]) {
      await open({ width, height: width === 390 ? 690 : 510, mode: 'expanded', kind: 'plant', stage: 3 }, { width, height: width === 390 ? 844 : 668, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      await check(width + 'px portrait retains world scale and supports a real touch pan', async () => {
        await viewCanvas(); const r = await rect(), before = await diag(); assert.equal(before.camera.canPan, true);
        await capture('phone-' + width + '-expanded');
        const touch = await page.touchscreen.touchStart(r.x + r.width * .48, r.y + r.height * .5);
        await touch.move(r.x + r.width * .75, r.y + r.height * .60); await touch.end(); await B.delay(200);
        assert.notDeepEqual((await diag()).camera.target, before.camera.target); assert.equal(await page.evaluate(() => picks.length), 0);
        await capture('phone-' + width + '-panned'); await click('camera-reset'); await viewCanvas();
        const target = await visibleTarget('plot'); assert.ok(target, 'A usable plot target is in the reset portrait view');
        await page.touchscreen.tap(target.center.x, target.center.y); assert.equal(await page.evaluate(() => picks.at(-1).id), target.id);
        await click('kind-capybara'); await capture('phone-' + width + '-capybara-expanded');
      });
    }
    assert.deepEqual(report.errors, []); assert.deepEqual(report.network, []);
  } catch (error) {
    report.failure = error.stack; process.exitCode = 1; console.error(error);
    if (page && !page.isClosed()) await capture('component-failure').catch(() => {});
  } finally {
    if (browser) await browser.close(); report.finishedAt = new Date().toISOString(); report.finalSourceHashes = sourceHashes();
    report.sourceStable = JSON.stringify(report.sourceHashes) === JSON.stringify(report.finalSourceHashes);
    fs.writeFileSync(path.join(OUT, PREFIX + '-component-results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ checks: report.checks.length, errorCount: report.errors.length, networkCount: report.network.length, visualStatus: report.visualStatus, failure: report.failure || null }));
  }
}
if (require.main === module) run();
module.exports = { run };
