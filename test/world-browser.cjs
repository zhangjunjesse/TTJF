'use strict';

// One bounded presentation group per process. The real SaaS/SQLite consumer
// scenarios remain in saas-browser.cjs and saas-full-browser.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const B = require('./browser.cjs');
const { Model: M, ROOT, action: a } = B;
const CASE = process.env.WORLD_TEST_CASE || 'points';
const GROUPS = ['points', 'rewards', 'reminders', 'companion', 'settings', 'voice', 'lifecycle', 'fallback',
  'layout-320', 'layout-390', 'layout-1440'];
assert.ok(GROUPS.includes(CASE), 'WORLD_TEST_CASE must name one group: ' + GROUPS.join(', '));
const RUN = new Date().toISOString().replace(/[^0-9]/g, '') + '-' + process.pid;
const OUT = path.join(process.env.TEST_ARTIFACT_DIR ? path.resolve(process.env.TEST_ARTIFACT_DIR) :
  path.join(ROOT, 'data', 'threejs-refactor', 'evidence'), 'world-' + CASE + '-' + RUN);
const SOURCES = ['index.html', 'app.js', 'world-ui.js', 'farm-ui.js', 'farm-scene.js', 'farm-world.css',
  'styles.css', 'farm.css', 'saas.css', 'server.cjs', 'test/browser.cjs', 'test/world-browser.cjs'];
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(path.resolve(ROOT, file))).digest('hex');
const hashes = () => Object.fromEntries(SOURCES.map(file => [file, sha(file)]));
fs.mkdirSync(OUT, { recursive: true });
const report = { group: CASE, startedAt: new Date().toISOString(), status: 'running', checks: [], screenshots: [],
  sourceHashes: hashes(), diagnostics: [], errors: [], boundaries: [
    'Synthetic isolated legacy HTTP fixture from B.createEnvironment; no production family, SQLite account, SMTP or external AI service.',
    'Headless desktop Edge at CSS viewport sizes; physical iPad/Safari and real OS suspension are not verified.',
    'Visibility/pagehide/pageshow are synthetic lifecycle events; actual BFCache and background device behavior are not claimed.',
    'This script does not rebuild the renderer. Current source hashes must remain stable during each run.',
    'The reminders fixture injects a deterministic HTTP assistant proposal to expose the existing taskAction confirmation form.'
  ] };
let browser, env, page;
function persist() { fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(report, null, 2)); }
persist();
async function check(label, fn) {
  report.current = label; persist(); const start = Date.now();
  await fn(); report.checks.push({ label, milliseconds: Date.now() - start, result: 'passed' });
  persist(); console.log('PASS ' + CASE + ': ' + label);
}
async function click(selector, options) {
  if (!selector.startsWith('.sheet') && await page.$('.sheet ' + selector)) selector = '.sheet ' + selector;
  await B.click(page, selector, options);
}
async function form(expected) {
  await page.waitForFunction(kind => window.FamilyDemo.getUI().form === kind, { timeout: 7000 }, expected);
}
async function route(expected, name, unavailable = false) {
  const calendar = (await B.ui(page)).view === 'reminders';
  await page.waitForFunction(({ value, fallback, calendar }) => {
    const host = window.FamilyWorldUI && window.FamilyWorldUI.diagnostics();
    if (!host || host.route !== value || document.body.dataset.worldRoute !== value) return false;
    if (calendar) return document.body.dataset.worldLayout === 'page' && !host.visible && !host.renderer;
    if (value === 'farm') return !host.visible;
    if (fallback) return host.visible && document.querySelector('#world-stage').dataset.sceneState === 'unavailable';
    return host.visible && host.renderer && host.renderer.ready && host.renderer.webgl && host.renderer.drawCalls > 0 && host.renderer.presentation === value;
  }, { timeout: 10000 }, { value: expected, fallback: unavailable, calendar });
  const diagnostic = await page.evaluate(() => ({ host: window.FamilyWorldUI.diagnostics(), farm: window.FamilyDemo.getUI().farmRender,
    scene: window.FamilyFarmScene.diagnostics(),
    canvases: Array.from(document.querySelectorAll('canvas.family-farm-canvas')).map(canvas => ({
      tabIndex: canvas.tabIndex, world: !!canvas.closest('#world-stage'), width: canvas.width, height: canvas.height })) }));
  assert.ok(diagnostic.scene.instances.length <= 1, 'only one renderer instance may survive a route change');
  assert.ok(diagnostic.scene.activeCount <= 1, 'only the current visible renderer may run');
  if (calendar) {
    assert.equal(diagnostic.canvases.length, 0, 'calendar pages release the decorative renderer');
  } else if (expected !== 'farm') {
    assert.equal(await page.$eval('#world-stage', el => el.getAttribute('aria-hidden')), 'true');
    assert.equal(await page.$$eval('#world-stage canvas', nodes => nodes.every(node => node.tabIndex === -1)), true);
    assert.equal(diagnostic.canvases.filter(canvas => !canvas.world).length, 0, 'a station must not retain the previous family farm canvas');
    if (!unavailable) assert.equal(diagnostic.scene.instances[0].id, diagnostic.host.renderer.id, 'the surviving renderer belongs to this station');
    if (!unavailable) assert.ok(diagnostic.host.renderer.drawCalls > 0, 'actual Three.js scene must have drawn');
  }
  report.diagnostics.push({ name, expected, ...diagnostic }); persist();
  if (name) {
    const file = name + '.png'; await page.screenshot({ path: path.join(OUT, file), fullPage: false });
    report.screenshots.push({ file, sha256: sha(path.join(OUT, file)) }); persist();
  }
}
async function home() {
  for (let n = 0; n < 10 && (await B.ui(page)).form; n++) {
    const current = await B.ui(page);
    if (current.auth) await click(a('parent-cancel'));
    else if (await page.$('.sheet ' + a('farm-home'))) await click(a('farm-home'));
    else await B.closeSheet(page);
  }
  if ((await B.ui(page)).view !== 'points') await B.navigate(page, 'points');
  await B.noSheet(page); await route('farm');
}
async function open(action, kind, expected, name) {
  await click(a(action)); await form(kind); await route(expected, name || kind);
}
async function assertPanel() {
  const result = await page.evaluate(() => {
    const sheet = document.querySelector('.sheet'), box = sheet.getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
      box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
      visibleScene: document.querySelector('#world-stage').getBoundingClientRect().height > 0,
      overlayPointerEvents: getComputedStyle(document.querySelector('#world-stage')).pointerEvents };
  });
  assert.ok(result.documentWidth <= result.width + 1, 'horizontal overflow: ' + JSON.stringify(result));
  assert.ok(result.box.left >= -1 && result.box.right <= result.width + 1, 'panel extends beyond viewport: ' + JSON.stringify(result));
  assert.ok(result.box.top >= -1 && result.box.top < result.height - 60, 'panel header is unreachable: ' + JSON.stringify(result));
  assert.equal(result.visibleScene, true); assert.equal(result.overlayPointerEvents, 'none');
  await B.reachable(page, '.sheet-header button:not([disabled])');
  const edit = await page.$('#editor-form textarea, #editor-form input:not([type="hidden"]):not([type="file"])');
  if (edit) { await edit.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' })); await edit.dispose(); }
  report.layout = result; persist();
}

const scenarios = {
  async points() {
    await check('default home and picker show farm and points scenes', async () => {
      await route('farm', 'home'); await open('add-points', 'behaviorPicker', 'points');
      await open('choose-point', 'points', 'points', 'common-points');
    });
    await check('protected save changes to authorization and cancel restores the editable points draft', async () => {
      await B.fillForm(page, { reason: 'World presentation test reason' });
      await click(B.SELECTORS.submit, { scroll: false });
      await B.confirmPoints(page);
      await page.waitForSelector('#parent-form [name="answer"]'); await route('authorization', 'parent-verification');
      await click(a('parent-cancel')); await route('points');
      assert.equal(await page.$eval('#editor-form [name="reason"]', el => el.value), 'World presentation test reason');
      assert.equal(env.requests.filter(request => request.path === '/api/action').length, 0);
    });
    await check('custom points, template management and records have matching places', async () => {
      await home(); await open('add-points', 'behaviorPicker', 'points', 'picker-again');
      await open('points-new', 'points', 'points', 'custom-points');
      await home(); await open('all-behaviors', 'behaviorPicker', 'points', 'behavior-browser');
      await open('point-list', 'point-list', 'points', 'point-list');
      await open('point-item-new', 'pointItem', 'points', 'template-editor');
      await home(); await open('records', 'records', 'history', 'history');
    });
  },
  async rewards() {
    await check('reward browsing, management and editing all use the market', async () => {
      await open('jump-rewards', 'rewards', 'rewards');
      await open('reward-list', 'reward-list', 'rewards');
      await open('reward-new', 'reward', 'rewards', 'reward-editor');
    });
    await check('request and approval keep reward context without a ledger write', async () => {
      await home(); await open('jump-rewards', 'rewards', 'rewards', 'rewards-again');
      await click(a('redeem', 'reward-eraser')); await form('request'); await route('rewards', 'request');
      await home(); await open('home-inbox', 'homeInbox', 'reminders', 'inbox');
      await click(a('redemption-approve')); await form('approve'); await route('rewards', 'approval');
      assert.equal(env.requests.filter(request => request.path === '/api/action').length, 0);
    });
  },
  async reminders() {
    await check('the companion inbox opens its station and the standalone calendar and editor open as app pages', async () => {
      await open('home-inbox', 'homeInbox', 'reminders'); await home();
      await B.navigate(page, 'reminders'); await route('reminders', 'reminders-page');
      await open('task-new', 'task', 'reminders', 'reminder-editor');
      await B.fillForm(page, { title: 'Temporary readable reminder' });
    });
    await check('HTTP assistant proposal reaches taskAction without completing or writing a task', async () => {
      await home(); await open('voice', 'voice', 'voice');
      await B.fillForm(page, { speech: '确认收到读书提醒' }); await click(B.SELECTORS.submit, { scroll: false });
      await form('taskAction'); await route('reminders', 'task-confirmation');
      assert.equal(env.requests.filter(request => request.path === '/api/action').length, 0);
    });
  },
  async companion() {
    await check('farm panel remains the farm while growth, archive and partner settings use their places', async () => {
      await click(a('farm-open')); await form('farm'); await click(a('farm-tab', 'collection')); await route('farm');
      await open('pet-growth', 'petGrowth', 'history', 'growth-history'); await home();
      await click(a('farm-open')); await form('farm'); await route('farm', 'farm-panel');
      await click(a('farm-tab', 'collection')); await route('farm');
      await open('pet-hub', 'petHub', 'companion', 'companion-archive');
      await open('pet-config', 'petConfig', 'companion', 'companion-settings');
    });
  },
  async settings() {
    await check('settings, family settings, child profile and parent configuration use the correct places', async () => {
      await open('preferences', 'preferences', 'settings');
      await open('family-settings', 'familySettings', 'family', 'family-settings');
      await home(); await open('profile-edit', 'profile', 'family', 'child-profile');
      await home(); await open('preferences', 'preferences', 'settings', 'settings-again');
      await open('parent-config', 'parentConfig', 'authorization', 'parent-settings');
      assert.equal(env.requests.filter(request => request.path === '/api/action').length, 0);
    });
  },
  async voice() {
    await check('speech fallback retains typing and the voice station', async () => {
      await open('voice', 'voice', 'voice');
      await click(a('listen')); await page.waitForFunction(() => /听写不支持/.test(document.querySelector('#voice-status').textContent));
      await B.fillForm(page, { speech: '可继续手工输入' });
      assert.equal(await page.$eval('#editor-form [name="speech"]', el => el.value), '可继续手工输入');
      await route('voice', 'voice-typing-fallback');
    });
  },
  async lifecycle() {
    await check('resize and reduced motion retain input DOM, selection and focus', async () => {
      await open('add-points', 'behaviorPicker', 'points'); await open('points-new', 'points', 'points', 'points-draft');
      await click('#editor-form [name="name"]'); await page.keyboard.type('Readable draft');
      await page.evaluate(() => { window.__worldFocus = document.activeElement; window.__worldFocus.setSelectionRange(2, 6); });
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await page.waitForFunction(() => window.FamilyWorldUI.diagnostics().renderer.reducedMotion);
      const focus = await page.evaluate(() => ({ same: document.activeElement === window.__worldFocus,
        value: document.activeElement.value, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd }));
      assert.deepEqual(focus, { same: true, value: 'Readable draft', start: 2, end: 6 });
    });
    await check('hidden/pagehide stop the active scene and pageshow restores only the visible route', async () => {
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
      assert.equal((await page.evaluate(() => window.FamilyWorldUI.diagnostics())).renderer.paused, true);
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
      await route('points');
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
      assert.equal((await page.evaluate(() => window.FamilyWorldUI.diagnostics())).renderer.paused, true);
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow')));
      await page.waitForFunction(() => !window.FamilyWorldUI.diagnostics().renderer.paused);
      await home(); assert.equal((await page.evaluate(() => window.FamilyWorldUI.diagnostics())).renderer, null);
    });
    await check('farm night and keyboard/zoom navigation survive releasing the renderer during a station round trip', async () => {
      await click(a('farm-open')); await form('farm');
      await page.waitForFunction(() => window.FamilyDemo.getUI().farmRender.renderer && window.FamilyDemo.getUI().farmRender.renderer.ready);
      const start = await page.evaluate(() => window.FamilyDemo.getUI().farmRender.renderer.camera.navigation);
      await page.focus('.sheet canvas.family-farm-canvas');
      await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
      await click(a('farm-zoom-in'));
      const moved = await page.evaluate(() => {
        const camera = window.FamilyDemo.getUI().farmRender.renderer.camera.navigation;
        return { x: camera.x, z: camera.z, zoom: camera.zoom };
      });
      assert.ok(moved.x > start.x && moved.z > start.z && moved.zoom > start.zoom, 'real keyboard and zoom controls change the farm view');
      await click(a('farm-lighting'));
      await page.waitForFunction(() => window.FamilyDemo.getUI().farmRender.renderer.lighting === 'night');
      const previous = await page.evaluate(() => window.FamilyDemo.getUI().farmRender.renderer.id);
      await route('farm', 'night-before-navigation'); await home();
      await open('add-points', 'behaviorPicker', 'points', 'station-after-night'); await home();
      await click(a('farm-open')); await form('farm');
      await page.waitForFunction(() => {
        const scene = window.FamilyDemo.getUI().farmRender.renderer;
        return scene && scene.ready && scene.lighting === 'night';
      });
      const restored = await page.evaluate(() => window.FamilyDemo.getUI().farmRender.renderer.id);
      assert.notEqual(restored, previous, 'the old WebGL resource was released while the lighting preference survived');
      const restoredView = await page.evaluate(() => {
        const camera = window.FamilyDemo.getUI().farmRender.renderer.camera.navigation;
        return { x: camera.x, z: camera.z, zoom: camera.zoom };
      });
      assert.deepEqual(restoredView, moved, 'the user pan and zoom choices survive the renderer handoff');
      await route('farm', 'night-restored');
    });
  }
};

async function runFallback() {
  await check('unavailable WebGL keeps inputs and protected confirmation reachable', async () => {
    await click(a('add-points')); await form('behaviorPicker'); await route('points', 'picker-fallback', true);
    await click(a('choose-point')); await form('points'); await route('points', 'points-fallback', true);
    await B.fillForm(page, { reason: 'Fallback draft still works' }); await click(B.SELECTORS.submit, { scroll: false });
    await B.confirmPoints(page);
    await page.waitForSelector('#parent-form [name="answer"]'); await route('authorization', 'verification-fallback', true);
    await click(a('parent-cancel')); assert.equal(await page.$eval('#editor-form [name="reason"]', el => el.value), 'Fallback draft still works');
  });
}
async function runLayout(width) {
  if (width < 700) {
    await check('phone ledger opens its real form on the page without mounting a station', async () => {
      await click(a('add-points')); await form('behaviorPicker');
      assert.equal(await page.$eval('.sheet', el => el.classList.contains('ledger-sheet')), true);
      const state = await page.evaluate(() => ({ host: window.FamilyWorldUI.diagnostics(), layout: document.body.dataset.worldLayout }));
      assert.equal(state.layout, 'page'); assert.equal(state.host.route, 'points');
      assert.equal(state.host.visible, false); assert.equal(state.host.renderer, null);
      await B.closeSheet(page);
      await B.homeView(page, 'companion');
    });
  }
  await check(width + 'px layout preserves readable fields and reachable panel controls', async () => {
    await open('add-points', 'behaviorPicker', 'points', 'layout-picker'); await assertPanel();
    await open('points-new', 'points', 'points', 'layout-editor'); await assertPanel();
    await click('#editor-form [name="reason"]'); await page.keyboard.type('Visible and editable at ' + width + 'px');
    assert.equal(await page.$eval('#editor-form [name="reason"]', el => el.value), 'Visible and editable at ' + width + 'px');
    await route('points', 'layout-typed-editor'); await home();
    await open('preferences', 'preferences', 'settings', 'layout-settings'); await assertPanel();
  });
}
async function run() {
  let deadline;
  try {
    const task = async () => {
      browser = await B.launch();
      let state = M.createSeed(new Date(B.FIXTURE_TIME));
      state = M.apply(state, { id: 'world-fixture-start', type: 'farm.start' }, new Date(B.FIXTURE_TIME));
      state = M.apply(state, { id: 'world-fixture-request', type: 'redemption.request', rewardId: 'reward-pencil' }, new Date(B.FIXTURE_TIME));
      env = await B.createEnvironment(browser, { state, assistantService: { status: () => ({ mode: 'local', label: 'Presentation fixture' }),
        interpret: async () => ({ mode: 'local', kind: 'action', action: { type: 'task.ack', taskId: 'task-reading' } }) } });
      const width = CASE.startsWith('layout-') ? Number(CASE.slice(7)) : 1440;
      page = await env.newPage({ width, height: width === 320 ? 568 : width === 390 ? 844 : 1000 });
      page.setDefaultTimeout(7000);
      await page.evaluateOnNewDocument(blockWebGL => {
        window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined;
        if (blockWebGL) {
          const native = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function (kind, ...args) { return /webgl/i.test(kind) ? null : native.call(this, kind, ...args); };
        }
      }, CASE === 'fallback');
      const initial = state;
      await env.load(page);
      if (CASE.startsWith('layout-')) await runLayout(width);
      else if (CASE === 'fallback') await runFallback();
      else await scenarios[CASE]();
      assert.deepEqual(await B.state(page), initial, 'presentation navigation must not alter business state');
      assert.deepEqual(env.errors, [], 'no uncaught browser errors');
      report.sourceStable = JSON.stringify(report.sourceHashes) === JSON.stringify(hashes());
      assert.equal(report.sourceStable, true, 'source changed during presentation evidence run; repeat after source stabilizes');
      report.status = 'passed';
    };
    await Promise.race([task(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('bounded world group exceeded 50 seconds')), 50000); })]);
  } catch (error) {
    report.status = 'failed'; report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
    console.error('FAIL ' + CASE + ': ' + error.message);
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(OUT, 'failure.png'), fullPage: false }).catch(() => {});
  } finally {
    clearTimeout(deadline); report.errors = env ? [...env.errors] : []; report.finishedAt = new Date().toISOString();
    report.milliseconds = Date.parse(report.finishedAt) - Date.parse(report.startedAt); delete report.current; persist();
    if (env) await env.close(); if (browser) await browser.close();
  }
  console.log(report.checks.length + ' checks ' + report.status + '; evidence ' + path.relative(ROOT, OUT));
}
run().catch(error => { report.status = 'failed'; report.failure = { message: error.message, stack: error.stack }; persist(); console.error(error); process.exitCode = 1; });
