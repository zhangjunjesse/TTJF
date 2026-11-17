'use strict';
// Component-level browser evidence; product integration is covered by the Lead's suite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const out = path.join(__dirname, 'verification');
fs.mkdirSync(out, { recursive: true });
const delay = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage(), report = { checks: [], scenes: [], errors: [], network: [] };
  page.on('pageerror', e => report.errors.push(e.message));
  page.on('request', r => { if (/^https?:/.test(r.url())) report.network.push(r.url()); });
  const check = (name, value) => { assert.ok(value, name); report.checks.push(name); };
  try {
    const { cropPhase } = await import('./garden.js');
    const timedPlot = { status: 'growing', plantedAt: '2026-11-01T00:00:00Z', readyAt: '2026-11-01T08:00:00Z', remainingMs: 7 * 3600000 };
    check('Projected remainingMs wins over a device clock far in the future', cropPhase(timedPlot, Date.parse('2030-01-01')) === 0);
    check('Projected remainingMs selects the intermediate growth phase', cropPhase({ ...timedPlot, remainingMs: 4 * 3600000 }, Date.parse('2020-01-01')) === 1);
    check('A growing projection never visually becomes harvest-ready', cropPhase({ ...timedPlot, remainingMs: 0 }, Date.parse('2030-01-01')) === 2);
    await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 2 });
    const url = pathToFileURL(path.join(__dirname, 'preview.html')).href;
    await page.goto(url + '?width=650&height=470', { waitUntil: 'load' });
    await page.waitForFunction(() => controller.diagnostics().ready || controller.diagnostics().error, { timeout: 20000 });
    const first = await page.evaluate(() => controller.diagnostics());
    check('WebGL and all embedded models initialize', first.ready && first.webgl && !first.error);
    await delay(650);
    for (const kind of ['plant', 'capybara']) {
      for (const mode of ['home', 'expanded']) {
        await page.evaluate(({ kind, mode }) => { sceneOptions.pet.kind = kind; sceneOptions.mode = mode; controller.update(sceneOptions); }, { kind, mode });
        await delay(90);
        const d = await page.evaluate(() => controller.diagnostics());
        report.scenes.push({ kind, mode, diagnostics: d });
        await page.screenshot({ path: path.join(out, kind + '-' + mode + '.png') });
        check(kind + '/' + mode + ' keeps single canvas', await page.$eval('body', e => e.querySelectorAll('canvas.family-farm-canvas').length === 1));
        check(kind + '/' + mode + ' keeps renderer identity', d.canvasId === first.canvasId);
        if (mode === 'home') check(kind + ' anatomical body >=240px in 650x470 host', d.bodyScreenBounds.height >= 240);
      }
    }
    for (const kind of ['plant', 'capybara']) {
      for (let stage = 1; stage <= 5; stage++) {
        await page.evaluate(({ kind, stage }) => { sceneOptions.pet.kind = kind; sceneOptions.mode = 'home'; sceneOptions.growth.stage = stage; controller.update(sceneOptions); }, { kind, stage });
        const d = await page.evaluate(() => controller.diagnostics());
        check(kind + '/stage' + stage + ' anatomical body remains prominent', d.bodyScreenBounds.height >= 240);
        await page.screenshot({ path: path.join(out, kind + '-stage-' + stage + '.png') });
      }
    }
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, hasTouch: true });
    await page.evaluate(() => { const host = document.getElementById('farm'); host.style.width = '348px'; host.style.height = '412px'; controller.update({ mode: 'home' }); controller.resize(); });
    await delay(80);
    const phone = await page.evaluate(() => { const d = controller.diagnostics(); const r = document.querySelector('canvas').getBoundingClientRect(); return { d, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } }; });
    report.phone = phone;
    check('Portrait close-up keeps anatomical body inside canvas', phone.d.bodyScreenBounds.left >= phone.rect.left && phone.d.bodyScreenBounds.right <= phone.rect.right && phone.d.bodyScreenBounds.top >= phone.rect.top && phone.d.bodyScreenBounds.bottom <= phone.rect.bottom);
    const petTarget = phone.d.hitTargets.find(x => x.type === 'pet');
    await page.touchscreen.tap(petTarget.center.x, petTarget.center.y);
    check('Touch pointer selects companion', await page.evaluate(() => picks.at(-1)?.type === 'pet'));
    await page.screenshot({ path: path.join(out, 'phone-home.png') });
    await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 2 });
    await page.evaluate(() => { const host = document.getElementById('farm'); host.style.width = '650px'; host.style.height = '470px'; controller.resize(); });
    await page.evaluate(() => { sceneOptions.mode = 'expanded'; sceneOptions.farm.placements.entry = 'mailbox'; sceneOptions.farm.placements.center = 'rabbitstatue'; sceneOptions.farm.placements.edge = 'windmill'; controller.update(sceneOptions); });
    await page.screenshot({ path: path.join(out, 'alternate-decorations.png') });
    for (let level = 1; level <= 3; level++) {
      await page.evaluate(level => { sceneOptions.farm.houseLevel = level; controller.update(sceneOptions); }, level);
      await page.screenshot({ path: path.join(out, 'house-level-' + level + '.png') });
    }
    await delay(1300);
    report.steadyMetrics = await page.evaluate(() => controller.diagnostics());
    check('Animation caps sampled frame rate near 30', report.steadyMetrics.fps > 0 && report.steadyMetrics.fps <= 32);
    check('DPR <=1.25 on DPR2 display', (await page.evaluate(() => controller.diagnostics())).dpr <= 1.25);
    const memory = await page.evaluate(() => controller.diagnostics().memory);
    for (let i = 0; i < 6; i++) await page.evaluate(i => { sceneOptions.pet.kind = i % 2 ? 'capybara' : 'plant'; controller.update(sceneOptions); }, i);
    const memoryAfter = await page.evaluate(() => controller.diagnostics().memory);
    check('Six rebuilds keep geometry resource counts stable', memoryAfter.geometries <= memory.geometries + 2);
    await page.evaluate(() => { controller.update({ mode: 'expanded' }); });
    const target = await page.evaluate(() => controller.diagnostics().hitTargets.find(x => x.type === 'plot' && x.id === 'p1'));
    await page.mouse.click(target.center.x, target.center.y);
    check('Real tap selects plot p1', await page.evaluate(() => picks.at(-1)?.type === 'plot' && picks.at(-1)?.id === 'p1'));
    const count = await page.evaluate(() => picks.length);
    await page.mouse.move(target.center.x, target.center.y); await page.mouse.down(); await page.mouse.move(target.center.x + 40, target.center.y + 40, { steps: 5 }); await page.mouse.up();
    check('Dragging does not select', await page.evaluate(n => picks.length === n, count));
    await page.evaluate(() => controller.pause(true));
    const frames = await page.evaluate(() => controller.diagnostics().frameCount); await delay(220);
    check('pause(true) stops rendering', await page.evaluate(n => controller.diagnostics().frameCount === n && !controller.diagnostics().running, frames));
    await page.evaluate(() => controller.pause(false)); await delay(220);
    check('pause(false) resumes same renderer', await page.evaluate(n => controller.diagnostics().frameCount > n && controller.diagnostics().running, frames));
    const hideFrames = await page.evaluate(() => controller.diagnostics().frameCount);
    const foreground = await browser.newPage();
    await foreground.bringToFront(); await delay(180);
    const hidden = await page.evaluate(() => ({ hidden: document.hidden, diagnostic: controller.diagnostics() }));
    if (hidden.hidden) {
      const settled = hidden.diagnostic.frameCount; await delay(150);
      check('Background browser tab stops its render loop', await page.evaluate(n => controller.diagnostics().frameCount === n && !controller.diagnostics().running, settled));
    }
    await foreground.close(); await page.bringToFront(); await delay(180);
    check('Foreground browser tab resumes', await page.evaluate(n => controller.diagnostics().frameCount > n, hideFrames));
    await page.evaluate(() => controller.update({ reducedMotion: true })); await delay(1700);
    const stillFrames = await page.evaluate(() => controller.diagnostics().frameCount); await delay(150);
    check('Reduced motion settles to a still frame', await page.evaluate(n => controller.diagnostics().frameCount === n && !controller.diagnostics().running, stillFrames));
    const lossAvailable = await page.evaluate(() => { const gl = document.querySelector('canvas').getContext('webgl2') || document.querySelector('canvas').getContext('webgl'); window.loss = gl?.getExtension('WEBGL_lose_context'); if (loss) loss.loseContext(); return !!loss; });
    if (lossAvailable) {
      await delay(100); check('Context loss reports recognizable status', await page.evaluate(() => controller.diagnostics().contextLost && statuses.at(-1).error === 'FARM_CONTEXT_LOST'));
      await page.evaluate(() => loss.restoreContext()); await delay(250);
      check('Context restoration recovers same canvas', await page.evaluate(() => controller.diagnostics().ready && !controller.diagnostics().contextLost));
    }
    check('Offline fixture makes zero HTTP asset requests', report.network.length === 0);
    check('No browser script errors', report.errors.length === 0);
    await page.evaluate(() => { controller.dispose(); controller.dispose(); });
    check('Dispose is idempotent and releases canvas/registry', await page.evaluate(() => !document.querySelector('canvas.family-farm-canvas') && FamilyFarmScene.diagnostics().instances.length === 0));
    const legacy = await browser.newPage();
    await legacy.evaluateOnNewDocument(() => {
      const get = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, ...args) { return type === 'webgl2' ? null : get.call(this, type, ...args); };
      window.ResizeObserver = undefined;
    });
    await legacy.goto(url + '?kind=capybara&still', { waitUntil: 'load' });
    await legacy.waitForFunction(() => controller.diagnostics().ready || controller.diagnostics().error, { timeout: 20000 });
    report.webgl1 = await legacy.evaluate(() => controller.diagnostics());
    check('Forced WebGL1 with ResizeObserver unavailable initializes', report.webgl1.ready && report.webgl1.contextVersion === 1);
    await legacy.evaluate(() => controller.dispose()); await legacy.close();
    const unavailable = await browser.newPage();
    await unavailable.evaluateOnNewDocument(() => {
      const get = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, ...args) { return /webgl/.test(type) ? null : get.call(this, type, ...args); };
    });
    await unavailable.goto(url, { waitUntil: 'load' });
    check('WebGL unavailable returns controller and recognizable status', await unavailable.evaluate(() => !controller.diagnostics().ready && /^FARM_WEBGL_UNAVAILABLE/.test(controller.diagnostics().error) && typeof controller.dispose === 'function'));
    await unavailable.evaluate(() => controller.dispose()); await unavailable.close();
  } catch (error) { report.failure = error.stack; process.exitCode = 1; console.error(error); }
  finally {
    fs.writeFileSync(path.join(out, 'component-results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ checks: report.checks.length, errors: report.errors, network: report.network, failure: report.failure || null, sceneMetrics: report.scenes.map(s => ({ kind: s.kind, mode: s.mode, bodyHeight: s.diagnostics.bodyScreenBounds.height, drawCalls: s.diagnostics.drawCalls, triangles: s.diagnostics.triangles, memory: s.diagnostics.memory })) }, null, 2));
    await browser.close();
  }
})();
