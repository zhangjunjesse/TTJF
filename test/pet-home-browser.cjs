'use strict';

// Run one bounded group per process against a fresh synthetic SaaS/SQLite family.
// PET_HOME_CASE=home|preview|rotation|scope|touch|portraits; PET_HOME_WIDTH/PET_HOME_HEIGHT select one bounded viewport run.
// PET_GALLERY_SHOTS=1 saves all ten gallery canvases with reduced motion.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Q = require('./saas-browser.cjs');
const { screenFit, noScroll, scrollState, unscrolled } = require('./home-screen-fit.cjs');
const { B, M, action: a, click, snapshot, ui } = Q;
const CASE = process.env.PET_HOME_CASE || 'home';
const WIDTH = Number(process.env.PET_HOME_WIDTH || 905);
const HEIGHT = Number(process.env.PET_HOME_HEIGHT || (WIDTH === 320 ? 568 : WIDTH === 390 ? 844 : WIDTH === 768 ? 1024 : WIDTH === 1024 ? 768 : 892));
const GALLERY_SHOTS = CASE === 'preview' && process.env.PET_GALLERY_SHOTS === '1';
assert.ok(['home', 'preview', 'rotation', 'scope', 'touch', 'portraits'].includes(CASE), 'Unknown PET_HOME_CASE');
assert.ok(Number.isInteger(WIDTH) && WIDTH >= 320 && WIDTH <= 2560, 'PET_HOME_WIDTH must be a supported CSS viewport width');
assert.ok(Number.isInteger(HEIGHT) && HEIGHT >= 320 && HEIGHT <= 1600, 'PET_HOME_HEIGHT must be a supported CSS viewport height');
const CHILD = '合成伙伴宝';
const HOME_CANVAS = '.pet-home-stage canvas.family-farm-canvas';
const LOOKS = ['default', 'festival'];
const SOURCES = ['test/pet-home-browser.cjs', 'test/home-screen-fit.cjs', 'test/browser.cjs', 'test/saas-browser.cjs', 'app.js', 'farm-ui.js',
  'farm/scene.js', 'farm/companions.js', 'farm/dragon-forms.js', 'farm/companion-interactions.js', 'farm-scene.js', 'farm-world.css',
  ...fs.readdirSync(path.join(Q.ROOT, 'farm/forest-bud'), { recursive: true })
    .filter(file => file.endsWith('.js')).map(file => 'farm/forest-bud/' + file.replace(/\\/g, '/')),
  ...fs.readdirSync(path.join(Q.ROOT, 'assets/farm/portraits')).map(file => 'assets/farm/portraits/' + file)];
const hashes = () => Object.fromEntries(SOURCES.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(Q.ROOT, file))).digest('hex')]));
let env, page, familyId;
const email = 'pet-home-' + CASE + '-' + Q.RUN + '@example.test';
Q.report.petHome = { case: CASE, viewport: { width: WIDTH, height: HEIGHT }, galleryShots: GALLERY_SHOTS, sourceHashes: hashes(), diagnostics: [] };

function progress(message) {
  fs.mkdirSync(Q.OUT, { recursive: true });
  fs.writeFileSync(path.join(Q.OUT, 'pet-home-progress.json'), JSON.stringify({
    case: CASE, message, at: new Date().toISOString(), checks: Q.report.checks, petHome: Q.report.petHome
  }, null, 2) + '\n');
}
async function check(label, fn) {
  progress(label);
  await Q.check(label, fn);
  progress('Completed: ' + label);
}
async function sql(id = familyId) {
  return (await env.database.query('SELECT revision,state FROM saas_families WHERE id=$1', [id])).rows[0];
}
async function unchanged(before, marker, label) {
  assert.deepEqual(await sql(), before, label + ': complete SQLite revision and family state');
  assert.deepEqual(await snapshot(page), before.state, label + ': browser state');
  const writes = env.calls.slice(marker).filter(call => !['GET', 'HEAD'].includes(call.method));
  assert.deepEqual(writes, [], label + ': view-only actions must not send API mutations or authorization requests');
}
async function renderer() {
  return page.evaluate(() => window.FamilyDemo.getUI().farmRender.renderer);
}
async function readyScene(mode = 'home') {
  await page.waitForFunction(expected => {
    const view = window.FamilyDemo && window.FamilyDemo.getUI(), d = view && view.farmRender, r = d && d.renderer;
    return d && d.mode === expected && r && r.ready && r.webgl && r.drawCalls > 0;
  }, { timeout: 10000 }, mode);
  const d = await page.evaluate(() => ({ farm: window.FamilyDemo.getUI().farmRender, scene: window.FamilyFarmScene.diagnostics() }));
  assert.equal(d.scene.instances.length, 1, 'exactly one live WebGL renderer');
  assert.ok(d.scene.activeCount <= 1, 'at most one active renderer');
  Q.report.petHome.diagnostics.push({ mode, ...d });
  return d.farm.renderer;
}
async function actualGrowth(expected) {
  const current = await ui(page), stored = (await sql()).state;
  assert.deepEqual(current.growth, M.growth(stored), 'UI growth must use actual earned-points state');
  assert.equal(current.growth.xp, expected);
  assert.equal(await page.$eval('.pet-growth-numbers strong', node => Number(node.textContent)), expected);
  const level = await page.$eval('.pet-home-heading .pet-level', node => node.textContent);
  assert.match(level, new RegExp('Lv\\.' + current.growth.level + '\\b')); assert.ok(level.includes(current.growth.stageName));
  assert.deepEqual(await page.$eval('.pet-growth-summary .growth-track', el => ({
    now: Number(el.getAttribute('aria-valuenow')), min: Number(el.getAttribute('aria-valuemin')), max: Number(el.getAttribute('aria-valuemax'))
  })), { now: expected, min: current.growth.previousAt, max: current.growth.nextAt });
}
async function simplifiedHome() {
  assert.equal(await page.$('.pet-home-card .pet-rotation-tools, .pet-home-card .pet-drag-hint, .pet-home-card ' +
    a('farm-pet-rotate') + ', .pet-home-card ' + a('farm-pet-reset')), null, 'home has no rotation buttons or drag hint');
  if ((await ui(page)).farmRender.previewStage === null) {
    const entry = await page.$eval(a('farm-pet-preview'), node => ({
      inGrowth: !!node.closest('.pet-growth-summary'), primary: node.classList.contains('primary'),
      label: node.getAttribute('aria-label') || node.textContent.trim(), expanded: node.getAttribute('aria-expanded')
    }));
    assert.equal(entry.inGrowth, true, 'the gallery stays a secondary entry within earned growth');
    assert.equal(entry.primary, false); assert.equal(entry.label, '查看成长图鉴'); assert.equal(entry.expanded, 'false');
    assert.doesNotMatch(await page.$eval('.pet-growth-summary', node => node.textContent), /每获得 1 积分，增加 1 成长值|兑换不影响成长/,
      'growth explanations live in the gallery instead of occupying a permanent home row');
    assert.deepEqual(await B.metrics(page, '.pet-home-footer'), [], 'home has no permanent footer row');
  } else {
    assert.deepEqual(await B.metrics(page, a('farm-pet-preview')), [], 'gallery uses a single return control without a duplicate entry');
    await B.reachable(page, a('farm-pet-current'));
  }
  assert.deepEqual(await page.$eval('#home-feedback', node => ({ role: node.getAttribute('role'), live: node.getAttribute('aria-live') })),
    { role: 'status', live: 'polite' }, 'removing the permanent footer keeps the home feedback live region');
  const accessibleCanvas = await page.$eval(HOME_CANVAS, node => ({ tabIndex: node.tabIndex,
    role: node.getAttribute('role'), label: node.getAttribute('aria-label') }));
  assert.equal(accessibleCanvas.tabIndex, 0); assert.equal(accessibleCanvas.role, 'button');
  assert.match(accessibleCanvas.label, /方向键/); assert.match(accessibleCanvas.label, /Home/);
}
async function canvasKey(key) {
  await page.focus(HOME_CANVAS); await page.keyboard.press(key);
  assert.equal(await page.$eval(HOME_CANVAS, node => node === document.activeElement), true, 'canvas keeps keyboard focus');
}
async function selectedStage(stage) {
  await page.waitForFunction(value => {
    const d = window.FamilyDemo.getUI().farmRender, c = d.renderer && d.renderer.companion;
    return d.previewStage === value && c && c.stage === value && c.preview === true;
  }, { timeout: 6000 }, stage);
  assert.equal((await ui(page)).form, null, 'preview stays inline on home');
  assert.equal(await page.$eval(a('farm-pet-stage', stage), node => node.getAttribute('aria-pressed')), 'true');
  (Q.report.petHome.layouts ||= []).push({ stage, ...await screenFit(page, { preview: true }) });
}
async function previewTargets() {
  const measured = [];
  for (const selector of [a('farm-pet-current'), ...[1, 2, 3, 4, 5].map(stage => a('farm-pet-stage', stage)),
    ...LOOKS.map(look => a('farm-pet-look', look))]) {
    const targets = await B.reachable(page, selector);
    measured.push({ selector, targets });
    assert.ok(targets.every(item => item.width >= 47.9 && item.height >= 47.9), '48px preview target: ' + JSON.stringify(measured.at(-1)));
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'preview has no horizontal overflow');
  Q.report.petHome.previewScrollProbe = await noScroll(page, true);
  Q.report.petHome.previewTargets = measured;
}
async function selectedLook(variant) {
  await page.waitForFunction(value => {
    const d = window.FamilyDemo.getUI().farmRender, c = d.renderer && d.renderer.companion;
    return d.previewStage !== null && c && c.preview === true && c.variant === value;
  }, { timeout: 6000 }, variant);
  const choices = await page.$$eval('.pet-preview-panel button[data-action="farm-pet-look"]', nodes =>
    nodes.map(node => ({ id: node.dataset.id, selected: node.getAttribute('aria-pressed'), disabled: node.disabled })));
  assert.deepEqual(choices.map(choice => choice.id), LOOKS, 'both dragon looks remain available at every stage');
  for (const choice of choices) {
    assert.equal(choice.disabled, false, 'gallery looks do not require unlocks');
    assert.equal(choice.selected, String(choice.id === variant), 'exactly the viewed look is selected');
  }
  const d = await readyScene();
  assert.equal(d.companion.showcase, true); assert.equal(d.world.terrain, 'showcase');
  assert.equal(d.maxFps, 30); assert.equal(d.maxDpr, 1.25); assert.ok(d.dpr <= d.maxDpr);
  (Q.report.petHome.galleryRenders ||= []).push({ stage: d.companion.stage, variant, canvasId: d.canvasId,
    drawCalls: d.drawCalls, triangles: d.triangles, memory: d.memory, bounds: d.petScreenBounds });
}
async function galleryShot(stage, variant) {
  if (!GALLERY_SHOTS) return;
  const savedScroll = await page.$eval('.app-main', node => node.scrollTop), file = 'gallery-stage-' + stage + '-' + variant + '.png';
  const canvas = await page.$(HOME_CANVAS);
  try { await canvas.screenshot({ path: path.join(Q.OUT, file) }); }
  finally { await canvas.dispose(); }
  const target = path.join(Q.OUT, file);
  Q.report.screenshots.push({ name: path.basename(file, '.png'), file: path.relative(Q.ROOT, target).replace(/\\/g, '/'),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') });
  await page.$eval('.app-main', (node, top) => { node.scrollTop = top; }, savedScroll);
}
async function returnCurrent() {
  await click(page, a('farm-pet-current'), { scroll: false });
  await page.waitForFunction(() => {
    const v = window.FamilyDemo.getUI(), d = v.farmRender, c = d.renderer && d.renderer.companion;
    return d.previewStage === null && c && c.preview === false && c.stage === v.growth.stage && c.variant === 'default';
  }, { timeout: 6000 });
  assert.equal(await page.$('.pet-preview-panel'), null);
  assert.equal((await renderer()).companion.showcase, false);
  assert.equal((await renderer()).world.terrain, 'continuous');
  assert.equal(await page.$eval(a('farm-pet-preview'), node => node === document.activeElement), true, 'return-current restores focus to the preview entry');
  (Q.report.petHome.layouts ||= []).push({ returnedToCurrent: true, ...await screenFit(page) });
}
async function reloadFamily() {
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => { const s = window.FamilySaas.status(); return s.ready || s.view === 'families'; });
  if ((await Q.status(page)).view === 'families') await click(page, Q.sa('select-family', familyId));
  await Q.ready(page, familyId);
  if (CASE !== 'portraits') await readyScene();
}
async function fixtureAction(action) {
  const before = (await env.api(page, '/api/state')).body;
  const result = await env.api(page, '/api/action', 'POST', { revision: before.revision, action: { ...action, id: 'pet-home-fixture-' + CASE } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}
async function setup() {
  Q.phase('pet-home-' + CASE); progress('Creating isolated SaaS fixture');
  env = await Q.initialize();
  page = await env.newPage({ width: WIDTH, height: HEIGHT }); Q.active(page);
  if (CASE === 'portraits') await page.evaluateOnNewDocument(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (name, ...args) {
      return /webgl/i.test(name) ? null : getContext.call(this, name, ...args);
    };
  });
  if (GALLERY_SHOTS) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  page.setDefaultTimeout(6000);
  await Q.registerAndVerify(page, email);
  familyId = await Q.createFamily(page, '合成伙伴首页-' + CASE, CHILD);
  await Q.home(page);
  if (CASE !== 'portraits') await readyScene();
  progress('Fixture ready');
}

async function portraits() {
  await check('A family without WebGL can view every dragon and outfit as a rendered portrait', async () => {
    const before = await sql(), marker = env.calls.length;
    async function shown(stage, look) {
      const file = 'bud-' + stage + (look === 'festival' ? '-festival' : '') + '.webp';
      await page.waitForFunction(name => {
        const image = document.querySelector('.farm-scene-fallback:not([hidden]) img');
        return image && image.complete && image.naturalWidth > 0 && image.currentSrc.endsWith('/' + name);
      }, {}, file);
    }
    await shown(1, 'default');
    await click(page, a('farm-pet-preview'));
    for (const stage of M.growthStages('plant')) {
      await click(page, a('farm-pet-stage', stage.stage));
      for (const look of LOOKS) {
        await click(page, a('farm-pet-look', look));
        await shown(stage.stage, look);
      }
    }
    await click(page, a('farm-pet-current')); await shown(1, 'default');
    await unchanged(before, marker, 'static portrait gallery');
  });
  await check('The growth journey and pet chooser show the matching stage sculptures', async () => {
    await fixtureAction({ type: 'farm.start' });
    await reloadFamily();
    await Q.home(page); await click(page, a('farm-open')); await click(page, a('farm-tab', 'collection'));
    await click(page, a('pet-growth'));
    const pictures = await page.$$eval('.journey-pet img', async images => {
      await Promise.all(images.map(image => image.decode()));
      return images.map(image => image.currentSrc.split('/').pop());
    });
    assert.deepEqual(pictures, M.growthStages('plant').map(stage => 'bud-' + stage.stage + '.webp'));
    await B.closeSheet(page);
    if (!(await Q.visible(page, a('pet-config')))) {
      await Q.home(page); await click(page, a('farm-open')); await click(page, a('farm-tab', 'collection'));
    }
    await click(page, a('pet-config'));
    await page.waitForFunction(() => {
      const image = document.querySelector('[data-action="pet-kind"][data-id="plant"] img');
      return image && image.naturalWidth > 0 && image.currentSrc.endsWith('/bud-1.webp');
    });
    assert.ok(await page.$('[data-action="pet-kind"][data-id="capybara"] svg'));
  });
}

async function home() {
  await check('The home keeps identity and earned growth prominent and exposes four free care controls', async () => {
    const before = await sql(), marker = env.calls.length;
    await simplifiedHome();
    assert.equal(await page.$eval('.home-header .child-profile-copy strong', node => node.textContent), CHILD);
    await actualGrowth(0);
    const controls = await page.$$eval('.pet-home-interactions button', nodes => nodes.map(node => node.textContent.trim()));
    assert.deepEqual(controls, ['摸摸', '喂一口', '洗澡', '玩耍']);
    assert.equal(await page.$('.pet-home-card .farm-toolbar, .pet-home-card .farm-welcome-actions'), null);
    assert.match(await page.$eval(a('farm-open'), node => node.getAttribute('aria-label') || node.textContent), /我的小院/);
    const selectors = [a('farm-pet-touch'), ...['feed', 'wash', 'train'].map(care => a('farm-pet-play', care)), a('farm-open')];
    for (const selector of selectors) {
      const measured = await B.reachable(page, selector);
      assert.ok(measured.every(item => item.width >= 47.9 && item.height >= 47.9), '48px home control: ' + selector);
    }
    Q.report.petHome.homeLayout = await screenFit(page, { probe: true });
    assert.equal((await renderer()).companion.interactive, true);
    await unchanged(before, marker, 'home render'); await Q.shot(page, 'pet-home-' + WIDTH);
  });
  await check('Mouse and keyboard care show responses without changing the ledger, farm, or revision', async () => {
    const before = await sql(), marker = env.calls.length;
    for (const [action, id, response] of [['farm-pet-touch', undefined, 'pet'], ['farm-pet-play', 'feed', 'feed'], ['farm-pet-play', 'wash', 'wash'], ['farm-pet-play', 'train', 'train']]) {
      await click(page, a(action, id), { scroll: false });
      await page.waitForFunction(kind => {
        const d = window.FamilyDemo.getUI().farmRender, r = d.renderer && d.renderer.companion.reaction;
        return r && r.kind === kind && document.querySelector('#pet-dialogue').textContent.trim();
      }, { timeout: 3000 }, response);
      assert.equal((await ui(page)).form, null);
      (Q.report.petHome.careLayouts ||= []).push({ action, id, ...await screenFit(page) });
      await unchanged(before, marker, response);
    }
    await page.focus(a('farm-pet-play', 'feed')); await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.FamilyDemo.getUI().farmRender.renderer.companion.reaction?.kind === 'feed');
    await unchanged(before, marker, 'keyboard feed'); await Q.shot(page, 'pet-care-response-' + WIDTH);
    await click(page, a('farm-open'), { scroll: false });
    assert.equal((await ui(page)).form, 'farm');
    assert.equal(await Q.visible(page, '.sheet ' + a('farm-start')), true);
    await unchanged(before, marker, 'explicit farm entry');
  });
}
async function preview() {
  await check('All five dragon stages and both gallery looks are view-only and leave actual growth and unlocks intact', async () => {
    const before = await sql(), marker = env.calls.length;
    await simplifiedHome();
    assert.equal(before.state.pet.kind, 'plant', 'the fixture exercises the dragon gallery');
    await click(page, a('farm-pet-preview'), { scroll: false }); await selectedStage(2);
    await selectedLook('default'); await simplifiedHome();
    assert.match(await page.$eval('.pet-preview-panel', node => node.textContent), /每获得 1 积分，增加 1 成长值/);
    assert.match(await page.$eval('.pet-preview-panel', node => node.textContent), /兑换不影响成长/);
    await previewTargets();
    assert.equal(await page.$$eval('.pet-preview-panel ' + a('farm-pet-stage'), nodes => nodes.length), 5);
    for (const stage of M.growthStages(before.state.pet.kind)) {
      assert.equal(await page.$eval(a('farm-pet-stage', stage.stage), node => node.disabled), false, 'future forms remain previewable');
      const selector = a('farm-pet-stage', stage.stage);
      await page.focus(selector);
      const scrollBefore = await scrollState(page);
      await page.keyboard.press('Enter'); await selectedStage(stage.stage);
      const scrollAfter = await scrollState(page);
      assert.equal(await page.$eval(selector, node => node === document.activeElement), true, 'stage selection retains keyboard focus');
      unscrolled(scrollBefore, 'stage control receives focus without scrolling');
      unscrolled(scrollAfter, 'stage selection stays on one screen');
      Q.report.petHome.previewScroll = [...Q.report.petHome.previewScroll || [], { stage: stage.stage, before: scrollBefore, after: scrollAfter }];
      const description = await page.$eval('.pet-preview-description', node => node.textContent);
      assert.match(description, new RegExp(stage.name));
      assert.match(description, stage.stage === 1 ? /当前形态/ : /尚未解锁，还差/);
      for (const variant of LOOKS) {
        const lookSelector = a('farm-pet-look', variant);
        await page.focus(lookSelector);
        const scrollBeforeLook = await scrollState(page);
        await page.keyboard.press('Enter'); await selectedLook(variant); await selectedStage(stage.stage);
        assert.equal(await page.$eval(lookSelector, node => node === document.activeElement), true, 'look selection retains keyboard focus');
        unscrolled(scrollBeforeLook, 'look control receives focus without scrolling');
        unscrolled(await scrollState(page), 'look selection stays on one screen');
        await actualGrowth(0); await unchanged(before, marker, 'preview stage ' + stage.stage + ' look ' + variant);
        await galleryShot(stage.stage, variant);
      }
    }
    await Q.shot(page, 'future-stage-five-preview');
    await returnCurrent(); await actualGrowth(0); await unchanged(before, marker, 'return to actual stage');
    await click(page, a('farm-pet-preview')); await click(page, a('farm-pet-stage', 5)); await selectedStage(5);
    await click(page, a('farm-pet-look', 'festival')); await selectedLook('festival');
    await reloadFamily();
    assert.equal((await ui(page)).farmRender.previewStage, null);
    assert.equal((await renderer()).companion.stage, 1); assert.equal((await renderer()).companion.variant, 'default');
    assert.equal((await renderer()).companion.showcase, false);
    await unchanged(before, marker, 'reload does not retain preview');
    await click(page, a('farm-pet-preview')); await click(page, a('farm-pet-stage', 5)); await selectedStage(5);
    await click(page, a('farm-pet-look', 'festival')); await selectedLook('festival');
    await B.navigate(page, 'reminders');
    assert.equal((await ui(page)).farmRender.previewStage, null, 'the bottom navigation remains reachable and exits the gallery');
    await unchanged(before, marker, 'leaving the gallery through reminders navigation');
    await Q.home(page); await readyScene();
    assert.equal((await ui(page)).farmRender.previewStage, null);
    assert.equal((await renderer()).companion.stage, 1); assert.equal((await renderer()).companion.variant, 'default');
    assert.equal((await renderer()).companion.showcase, false);
    await actualGrowth(0); await unchanged(before, marker, 'home restores the actual companion after panel navigation');
    await click(page, a('farm-open'));
    assert.equal((await ui(page)).form, 'farm');
    assert.equal(await Q.visible(page, '.sheet ' + a('farm-start')), true);
    const farm = (await ui(page)).farmStatus;
    assert.equal(farm.initialized, false); assert.equal(farm.plotLimit, 2);
    assert.equal(farm.crops.find(crop => crop.id === 'sunflower').unlocked, false);
    assert.equal(farm.animals.find(animal => animal.id === 'rabbit').unlocked, false);
    await unchanged(before, marker, 'future preview grants no farm unlocks');
  });
}
async function rotation() {
  await check('Real companion drag and accessible rotation affect only the view and never activate farming', async () => {
    await fixtureAction({ type: 'farm.start' }); await reloadFamily();
    await screenFit(page);
    const before = await sql(), marker = env.calls.length, start = await renderer(), body = start.bodyScreenBounds;
    assert.ok(body && body.width > 0 && body.height > 0, 'real companion mesh has projected body bounds');
    const x = (body.left + body.right) / 2, y = (body.top + body.bottom) / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 65, y + 1, { steps: 10 }); await page.mouse.up();
    await page.waitForFunction(initial => Math.abs(window.FamilyDemo.getUI().farmRender.renderer.companion.rotation - initial) > .08, { timeout: 3000 }, start.companion.rotation);
    assert.equal((await ui(page)).form, null, 'dragging cannot open a farm detail');
    assert.deepEqual((await renderer()).camera.navigation, start.camera.navigation, 'pet drag does not pan farm camera');
    await simplifiedHome(); await canvasKey('Home');
    assert.ok(Math.abs((await renderer()).companion.rotation) < 1e-8);
    await canvasKey('ArrowRight');
    assert.ok((await renderer()).companion.rotation > .1);
    await canvasKey('ArrowLeft');
    assert.ok(Math.abs((await renderer()).companion.rotation) < 1e-8);
    await canvasKey('ArrowLeft'); assert.ok((await renderer()).companion.rotation < -.1);
    await canvasKey('Home'); assert.ok(Math.abs((await renderer()).companion.rotation) < 1e-8);
    const canvas = await page.$eval('.pet-home-stage canvas', node => node.getBoundingClientRect().toJSON());
    await page.mouse.click(canvas.left + 12, canvas.top + canvas.height * .65);
    assert.equal((await ui(page)).form, null, 'home background cannot open farm details');
    await unchanged(before, marker, 'companion rotation'); await Q.shot(page, 'rotated-companion-home');
    await click(page, a('farm-open')); await readyScene('expanded');
    assert.equal((await renderer()).companion.interactive, false, 'farm keeps its own navigation mode');
    const navigation = (await renderer()).camera.navigation;
    await page.focus('.sheet canvas.family-farm-canvas'); await page.keyboard.press('ArrowRight');
    assert.ok((await renderer()).camera.navigation.x > navigation.x, 'explicit farm camera still pans');
    await click(page, '.sheet ' + a('farm-plot', 'p1'));
    assert.equal((await ui(page)).farmView, 'plot', 'farm details remain explicitly reachable');
    await unchanged(before, marker, 'explicit farm navigation');
  });
}
async function scope() {
  await check('Family changes and logout clear preview and companion rotation without saving either', async () => {
    const first = await sql();
    await click(page, a('farm-pet-preview')); await click(page, a('farm-pet-stage', 5)); await selectedStage(5);
    await click(page, a('farm-pet-look', 'festival')); await selectedLook('festival');
    await canvasKey('ArrowRight');
    assert.ok((await renderer()).companion.rotation > .1);
    const secondId = await Q.createFamily(page, '合成另一个伙伴家', '合成另一宝');
    await readyScene();
    assert.equal((await ui(page)).farmRender.previewStage, null);
    assert.equal((await renderer()).companion.stage, 1); assert.equal((await renderer()).companion.rotation, 0);
    assert.equal((await renderer()).companion.variant, 'default'); assert.equal((await renderer()).companion.showcase, false);
    assert.deepEqual(await sql(), first, 'creating another family does not save the first family view');
    const second = await sql(secondId);
    await Q.switchFamily(page, familyId); await readyScene();
    assert.equal((await ui(page)).farmRender.previewStage, null); assert.equal((await renderer()).companion.rotation, 0);
    assert.equal((await renderer()).companion.variant, 'default');
    assert.deepEqual(await sql(), first); assert.deepEqual(await sql(secondId), second);
    await click(page, a('farm-pet-preview')); await click(page, a('farm-pet-stage', 5)); await selectedStage(5);
    await click(page, a('farm-pet-look', 'festival')); await selectedLook('festival'); await canvasKey('ArrowRight');
    await Q.logout(page); await Q.assertCleared(page, [CHILD, '合成另一宝']);
    await Q.login(page, email, Q.PASSWORD, familyId); await Q.ready(page, familyId); await readyScene();
    assert.equal((await ui(page)).farmRender.previewStage, null); assert.equal((await renderer()).companion.rotation, 0);
    assert.equal((await renderer()).companion.variant, 'default'); assert.equal((await renderer()).companion.showcase, false);
    assert.deepEqual(await sql(), first); assert.deepEqual(await sql(secondId), second);
    await Q.shot(page, 'scope-reset-real-current');
  });
}
async function nativeSwipe(cdp, x, y, dx, dy) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  for (let step = 1; step <= 8; step++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * step / 8, y: y + dy * step / 8, id: 1 }] });
    await B.delay(25);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
async function touch() {
  Q.report.boundaries.push('Touch case uses native Chrome DevTools touch emulation in desktop Edge at the selected CSS viewport; physical iPad/Safari, OS gestures and device suspension remain unverified.');
  await check('Native horizontal touch turns the companion while vertical touch neither rotates nor scrolls the single-screen home', async () => {
    const before = await sql(), marker = env.calls.length, cdp = await page.createCDPSession();
    try {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await page.$eval('.pet-home-stage canvas', canvas => {
        window.__petHomeTouchEvents = [];
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) canvas.addEventListener(type, event => {
          if (event.pointerType === 'touch') window.__petHomeTouchEvents.push({ type, trusted: event.isTrusted, pointerType: event.pointerType });
        });
      });
      Q.report.petHome.touchLayout = await screenFit(page, { probe: true });
      let d = await renderer(), body = d.bodyScreenBounds;
      assert.ok(body && body.width > 0 && body.height > 0, 'touch starts on the real projected companion');
      const scroll = await scrollState(page);
      const initial = d.companion.rotation;
      await nativeSwipe(cdp, (body.left + body.right) / 2, (body.top + body.bottom) / 2, 65, 1);
      await page.waitForFunction(value => Math.abs(window.FamilyDemo.getUI().farmRender.renderer.companion.rotation - value) > .08, { timeout: 3000 }, initial);
      unscrolled(await scrollState(page), 'horizontal touch');
      assert.equal((await ui(page)).form, null);
      await canvasKey('Home');
      d = await renderer(); body = d.bodyScreenBounds;
      Q.report.petHome.touch = { beforeVertical: scroll }; progress('Native horizontal turn passed; checking vertical gesture isolation');
      for (const dy of [-60, 60]) {
        await nativeSwipe(cdp, (body.left + body.right) / 2, (body.top + body.bottom) / 2, 1, dy);
        await B.delay(120);
        unscrolled(await scrollState(page), 'vertical native touch ' + dy);
        assert.ok(Math.abs((await renderer()).companion.rotation) < 1e-8, 'vertical touch must not rotate the pet');
        assert.equal((await ui(page)).form, null);
      }
      const events = await page.evaluate(() => window.__petHomeTouchEvents);
      assert.ok(events.some(event => event.type === 'pointerdown') && events.every(event => event.trusted), 'gestures use trusted native touch events');
      Q.report.petHome.touch = { events, beforeVertical: scroll, afterVertical: await scrollState(page) };
      await screenFit(page); await unchanged(before, marker, 'native touch gestures'); await Q.shot(page, 'native-touch-single-screen-and-turn');
    } finally { await cdp.detach(); }
  });
}
async function run() {
  Q.report.boundaries.push('Pet home case ' + CASE + ': synthetic verified account and fresh temporary SQLite; only explicit fixture actions may write; care, stage and look previews, and rotation must preserve complete stored family state and revision.');
  await setup(); await ({ home, preview, rotation, scope, touch, portraits })[CASE]();
  assert.deepEqual(Q.report.pageErrors, []);
  Q.report.petHome.finalSourceHashes = hashes();
  assert.deepEqual(Q.report.petHome.finalSourceHashes, Q.report.petHome.sourceHashes, 'sources changed during the browser evidence run');
  progress('Case complete');
}
Q.execute(run);
