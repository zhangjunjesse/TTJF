'use strict';

// Farm v12 evidence runs only against createEnvironment's ephemeral server/data.
// Do not point this runner at the live family service. Every user action is a
// hit-tested mouse/touch activation; evaluate() is reserved for observations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const B = require('./browser.cjs');
const { Model: M, ROOT, ARTIFACTS, action, state, ui } = B;
const TIME = B.FIXTURE_TIME, H8 = 8 * 60 * 60 * 1000, DAY = 24 * 60 * 60 * 1000;
const SAVE = '.sheet-header button.sheet-save[type="submit"][form="editor-form"]';
const VERIFY = '#parent-form button[type="submit"]';
const ONLY = (process.env.V12_GROUPS || '').split(',').filter(Boolean);
const EVIDENCE_TAG = process.env.V12_EVIDENCE_TAG || '';
assert.match(EVIDENCE_TAG, /^[a-z0-9-]*$/, 'Evidence tag must be a simple filename suffix');
const PREFIX = 'v12' + (EVIDENCE_TAG ? '-' + EVIDENCE_TAG : '');
const SOURCES = ['model.js', 'server.cjs', 'app.js', 'styles.css', 'index.html', 'farm-ui.js', 'farm.css', 'farm-scene.js', 'farm-scene.bundle.js', 'test/v12-browser.cjs'];
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
const hashes = () => Object.fromEntries(SOURCES.filter(file => fs.existsSync(path.join(ROOT, file))).map(file => [file, sha(file)]));
const report = {
  command: 'node test/v12-browser.cjs', evidenceTag: EVIDENCE_TAG || 'untagged', requested: ONLY.length ? ONLY : 'all except separately enabled offline group',
  startedAt: new Date().toISOString(), sourceHashes: hashes(),
  fixture: 'Functional groups use a temporary createEnvironment server, Model.apply sample data and isolated browser contexts. The separately requested live group uses the real 4178 entry with native time and aborts all non-GET/HEAD requests.',
  boundaries: ['Headless Microsoft Edge/Chromium; viewport and touch emulation do not prove Safari or iPad mini 4 hardware compatibility.',
    'Eight-hour maturity and family-day boundaries use controlled client/server clocks, not eight hours of wall-clock waiting.',
    'Short renderer diagnostics measure this desktop run only; no 10-minute A8/device soak, audible output, OS keyboard, or native touch claim.',
    'Buttons are activated with real mouse/touch input after DOM hit-testing; production actions and state are never invoked or changed via page.evaluate.',
    'Mechanical checks do not establish visual parity with Harvest Hollow. Final judgement requires reading screenshots against the four reference images; see artifacts/v12-visual-review.md.'],
  visualReview: { status: 'pending-human-image-review', references: ['hero.png', 'farm-day.png', 'phone-farm.png', 'night.png'].map(name => 'artifacts/v12-reference/' + name) },
  groups: [], checks: [], layouts: [], renderer: [], screenshots: [], errors: [], skipped: []
};
let browser, groupName, activePage;

function fixture(kind = 'seed') {
  if (kind === 'seed') return M.createSeed(new Date(TIME));
  if (kind === 'showcase') {
    let result = fixture('rich'), sequence = 0, now = TIME - H8;
    const apply = input => { result = M.apply(result, { id: 'v12-showcase-' + (++sequence), ...input }, new Date(now)); };
    for (const itemId of ['flowerpot', 'picnic', 'rabbitstatue', 'mailbox', 'trellis', 'windmill', 'house2', 'house3']) apply({ type: 'farm.exchange', itemId });
    for (const [slot, itemId] of [['entry', 'mailbox'], ['center', 'picnic'], ['edge', 'windmill']]) apply({ type: 'farm.place', slot, itemId });
    apply({ type: 'farm.plant', cropId: 'carrot', plotIds: ['p1', 'p2'] });
    now = TIME - H8 * .45; apply({ type: 'farm.plant', cropId: 'strawberry', plotIds: ['p3', 'p4'] });
    now = TIME - H8 * .10; apply({ type: 'farm.plant', cropId: 'sunflower', plotIds: ['p5', 'p6'] });
    return M.normalize(result);
  }
  let sequence = 0, now = TIME - 18 * H8;
  let result = M.createSeed(new Date(now));
  const apply = input => { result = M.apply(result, { id: 'v12-fixture-' + (++sequence), ...input }, new Date(now)); };
  if (kind === 'rich') apply({ type: 'points.add', name: '隔离测试解锁', points: 372, reason: '仅临时测试家庭通过真实规则解锁500成长' });
  apply({ type: 'farm.start' });
  if (kind === 'mixed') { apply({ type: 'farm.plant', cropId: 'strawberry', plotIds: ['p2'] }); now += H8; }
  if (kind === 'rich') {
    apply({ type: 'farm.harvest' });
    for (const cropId of ['carrot', 'strawberry', 'sunflower']) {
      for (let round = 0; round < 5; round++) {
        apply({ type: 'farm.plant', cropId }); now += H8;
        apply({ type: 'farm.harvest' });
      }
    }
    assert.equal(M.totals(result).earned, 500);
    assert.deepEqual(result.farm.inventory, { carrot: 93, strawberry: 90, sunflower: 90 });
  }
  return M.normalize(result);
}
async function check(label, fn) {
  try { await fn(); report.checks.push({ group: groupName, label, result: 'passed' }); console.log('PASS ' + groupName + ': ' + label); }
  catch (error) { error.check = label; throw error; }
}
async function screenshot(page, name) {
  const file = 'artifacts/' + PREFIX + '-' + name + '.png';
  await page.screenshot({ path: path.join(ROOT, file), fullPage: false });
  report.screenshots.push({ file, sha256: sha(file) });
}
async function group(name, fn, options = {}) {
  if (ONLY.length && !ONLY.includes(name)) return;
  if (options.offline && !ONLY.includes(name) && process.env.V12_OFFLINE !== '1') {
    report.skipped.push({ group: name, reason: 'Separate group: run V12_GROUPS=offline after Lead generates the final export.' }); return;
  }
  groupName = name;
  const env = await B.createEnvironment(browser, { state: fixture(options.fixture || 'seed') });
  const before = hashes(); let realContext = null;
  try {
    if (options.realClock) {
      realContext = await browser.createBrowserContext(); activePage = await realContext.newPage();
      await activePage.setViewport({ width: options.width || 390, height: options.height || 844, deviceScaleFactor: 1 });
      activePage.on('pageerror', error => env.errors.push(error.message));
    } else {
      activePage = await env.newPage({ width: options.width || 390, height: options.height || 844 });
      await env.load(activePage);
    }
    await fn(env, activePage);
    assert.deepEqual(env.errors, [], 'No uncaught browser errors');
    report.groups.push({ name, result: 'passed', sourceHashes: before, sourceStable: JSON.stringify(before) === JSON.stringify(hashes()) });
  } catch (error) {
    report.groups.push({ name, result: 'failed', check: error.check || 'group setup', message: error.message, stack: error.stack, sourceHashes: before });
    console.error('FAIL ' + name + ': ' + error.message);
    if (activePage && !activePage.isClosed()) await screenshot(activePage, name + '-failure').catch(() => {});
  } finally {
    report.errors.push(...env.errors.map(message => ({ group: name, message })));
    if (realContext) await realContext.close();
    await env.close(); activePage = null;
  }
}
const farm = async page => (await ui(page)).farmStatus;
const ledger = async page => M.totals(await state(page));
const posts = (env, type) => env.requests.filter(row => row.path === '/api/action' && (!type || row.body.action.type === type));
async function settled(page) { await page.waitForFunction(() => !window.FamilyDemo.getUI().pending, { timeout: 10000 }); }
async function farmView(page, view) {
  await page.waitForFunction(expected => { const u = window.FamilyDemo.getUI(); return u.form === 'farm' && u.farmView === expected; }, { timeout: 7000 }, view);
}
async function visible(page, selector) {
  return page.$$eval(selector, nodes => nodes.some(node => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(node).visibility !== 'hidden'; }));
}
async function scoped(page, selector) {
  return (await ui(page)).form && !selector.startsWith('.sheet') && await visible(page, '.sheet ' + selector) ? '.sheet ' + selector : selector;
}
async function click(page, selector, options) { return B.click(page, await scoped(page, selector), options); }
async function home(page) {
  for (let i = 0; i < 10 && (await ui(page)).form; i++) {
    if ((await ui(page)).auth) await click(page, action('parent-cancel'));
    else if (await visible(page, action('farm-home'))) await click(page, action('farm-home'), { scroll: false });
    else await B.closeSheet(page);
  }
  await B.noSheet(page);
  if ((await ui(page)).view !== 'points') await B.navigate(page, 'points');
}
async function openFarm(page, tab) {
  await home(page); await click(page, action('farm-open'), { scroll: false }); await farmView(page, 'yard');
  if (tab) await click(page, action('farm-tab', tab));
}
async function itemPage(page, id) { await openFarm(page, 'build'); await click(page, action('farm-item', id)); await farmView(page, 'item'); }
async function animalPage(page, id) { await openFarm(page, 'animals'); await click(page, action('farm-animal', id)); await farmView(page, 'animal'); }
async function start(page, env) {
  const previous = await ledger(page), challenges = env.requests.filter(row => row.path === '/api/parent/challenge').length;
  await click(page, action('farm-start'), { scroll: false }); await settled(page);
  assert.equal((await farm(page)).initialized, true);
  assert.equal(env.requests.filter(row => row.path === '/api/parent/challenge').length, challenges);
  assert.deepEqual(await ledger(page), previous);
}
async function typed(page, name, value) {
  const selector = name.startsWith('#') ? name : '#editor-form [name="' + name + '"]';
  await click(page, selector); await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.keyboard.press('Backspace'); await page.keyboard.type(String(value));
  assert.equal(await page.$eval(selector, node => node.value), String(value));
}
async function verify(page, answer = B.PIN) { await typed(page, '#parent-form [name="answer"]', answer); await click(page, VERIFY, { scroll: false }); await settled(page); }
async function protectedSave(page, env, type) {
  const before = await state(page), count = posts(env, type).length;
  await click(page, SAVE, { scroll: false });
  await page.waitForSelector('#parent-form [name="answer"]'); assert.deepEqual(await state(page), before);
  await verify(page); await page.waitForFunction(() => !window.FamilyDemo.getUI().auth && !window.FamilyDemo.getUI().pending);
  assert.equal(posts(env, type).length, count + 1); assert.ok(posts(env, type).at(-1).body.grant);
  assert.deepEqual(await state(page), (await env.api('/api/state')).body.state);
}
async function disabledWithoutWrite(page, env, selector) {
  selector = await scoped(page, selector);
  const before = await state(page), count = env.requests.length;
  const rect = await page.$eval(selector, node => { const r = node.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { disabled: node.disabled, x: r.x + r.width / 2, y: r.y + r.height / 2, reachable: !!hit && (hit === node || node.contains(hit)) }; });
  assert.equal(rect.disabled, true, selector + ' must be disabled'); assert.ok(rect.reachable, selector + ' is obscured');
  await page.mouse.click(rect.x, rect.y); await B.delay(80);
  assert.deepEqual(await state(page), before); assert.equal(env.requests.length, count, 'Disabled action must not POST');
}
async function sceneSummary(page) { return page.evaluate(() => window.FamilyFarmScene && window.FamilyFarmScene.diagnostics()); }
async function diagnostics(page) { const summary = await sceneSummary(page); return summary && summary.instances[0]; }
async function canvasRect(page) {
  return page.$eval('canvas.family-farm-canvas', node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom }; });
}
async function visibleSceneTargets(page, type) {
  return page.evaluate(type => {
    const d = window.FamilyFarmScene.diagnostics().instances[0];
    return d.hitTargets.filter(target => (!type || target.type === type) && (() => {
      const at = document.elementFromPoint(target.center.x, target.center.y);
      return at && at.matches('canvas.family-farm-canvas');
    })());
  }, type);
}
async function sceneReady(page) {
  await page.waitForFunction(() => {
    const api = window.FamilyFarmScene, d = api && api.diagnostics();
    return d && d.instances.length === 1 && d.instances[0].ready && d.instances[0].webgl;
  }, { timeout: 20000 });
  const summary = await sceneSummary(page); assert.equal(summary.canvasCount, 1); assert.equal(summary.activeCount, 1);
  return diagnostics(page);
}
async function audit(page, label, primarySelectors = [], noScroll = false) {
  const measured = await page.evaluate(() => {
    const root = document.querySelector('.sheet') || document.querySelector('.app-shell') || document.body;
    const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const controls = [...root.querySelectorAll('button,input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]),select,textarea')].filter(node => {
      const r = node.getBoundingClientRect(); return r.width && r.height && getComputedStyle(node).visibility !== 'hidden';
    }).map(node => {
      const r = rect(node), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { ...r, action: node.dataset.action, id: node.dataset.id, label: node.getAttribute('aria-label') || node.textContent.trim() || node.name,
        disabled: node.disabled, font: Number.parseFloat(getComputedStyle(node).fontSize), input: node.tagName !== 'BUTTON',
        inViewport: r.x >= -1 && r.y >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
        reachable: !!hit && (hit === node || node.contains(hit)) };
    });
    return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
      bodyScrollHeight: document.body.scrollHeight, scrollY, root: rect(root), form: window.FamilyDemo.getUI().form, controls };
  });
  const problems = [];
  if (measured.scrollWidth > measured.width + 1) problems.push('horizontal document overflow');
  if (noScroll && (measured.scrollHeight > measured.height + 1 || measured.bodyScrollHeight > measured.height + 1 || measured.scrollY !== 0)) problems.push('home/main scene vertical document scroll');
  for (const control of measured.controls) {
    if (control.width < 47.9 || control.height < 47.9) problems.push('target under 48px: ' + control.label + ' ' + control.width + '×' + control.height);
    if (control.input && control.font < 16) problems.push('input text under 16px: ' + control.label);
  }
  for (const selector of primarySelectors) {
    const controls = await B.metrics(page, await scoped(page, selector));
    if (!controls.length) problems.push('missing primary: ' + selector);
    for (const control of controls) if (!control.inViewport || !control.reachable) problems.push('primary obscured/clipped: ' + selector + ' ' + JSON.stringify(control));
  }
  report.layouts.push({ label, ...measured, problems });
  await screenshot(page, label);
  assert.deepEqual(problems, [], label + ' layout');
}

async function mainLoop(env, page) {
  const original = await state(page), before = await ledger(page);
  await check('First-use home shows a live 3D preview and opens without PIN at inherited 128 growth', async () => {
    assert.equal((await farm(page)).initialized, false); await sceneReady(page);
    await start(page, env);
    const f = await farm(page);
    assert.equal(f.plotLimit, 4); assert.equal(f.readyCount, 1);
    assert.deepEqual(f.crops.filter(crop => crop.unlocked).map(crop => crop.id), ['carrot', 'strawberry']);
    assert.deepEqual(f.animals.filter(animal => animal.unlocked).map(animal => animal.id), ['chicken', 'rabbit']);
    assert.equal(f.plots[0].welcomeGift, true); assert.equal(f.plots[0].plantedAt, null);
    assert.match(await page.$eval('body', node => node.textContent), /欢迎礼/);
  });
  await check('Harvest welcome carrots → exchange flowerpot → place at entry is an actual UI loop with unchanged ledger', async () => {
    await click(page, action('farm-harvest'), { scroll: false }); await settled(page);
    assert.deepEqual((await farm(page)).inventory, { carrot: 3, strawberry: 0, sunflower: 0 });
    await itemPage(page, 'flowerpot'); await click(page, action('farm-exchange', 'flowerpot')); await settled(page);
    assert.ok((await farm(page)).owned.includes('flowerpot')); assert.equal((await farm(page)).inventory.carrot, 0);
    await itemPage(page, 'flowerpot'); await click(page, action('farm-place', 'flowerpot')); await settled(page);
    assert.equal((await farm(page)).placements.entry, 'flowerpot');
    assert.deepEqual(await ledger(page), before); assert.equal(await page.$('#parent-form'), null);
    await home(page); await screenshot(page, 'loop-first-flowerpot');
  });
  await check('Reload keeps one welcome gift and original family history; free batch planting fills only four empty unlocked plots', async () => {
    const gift = (await state(page)).farm.welcomeGift;
    await page.reload({ waitUntil: 'load' }); await B.connected(page);
    assert.deepEqual((await state(page)).farm.welcomeGift, gift); assert.equal((await farm(page)).readyCount, 0);
    const current = await state(page);
    for (const key of ['points', 'redemptions', 'petPurchases', 'petCare', 'pet', 'petScene']) assert.deepEqual(current[key], original[key], key + ' preserved');
    await click(page, action('farm-seeds'), { scroll: false }); await farmView(page, 'seed');
    await disabledWithoutWrite(page, env, action('farm-crop', 'sunflower'));
    await click(page, action('farm-crop', 'strawberry')); await click(page, action('farm-plant')); await settled(page);
    const f = await farm(page); assert.equal(f.plots.filter(plot => plot.status === 'growing').length, 4);
    assert.ok(f.plots.slice(0, 4).every(plot => plot.cropId === 'strawberry' && Date.parse(plot.readyAt) - Date.parse(plot.plantedAt) === H8));
    assert.ok(f.plots.slice(4).every(plot => plot.status === 'locked')); assert.deepEqual(await ledger(page), before);
  });
  await check('Server clock 8h−1ms rejects maturity; a closed/reopened page at 8h harvests exactly 12 once without automatic replant', async () => {
    // The shared UI correctly extrapolates server time with performance.now().
    // Keep its visible pre-maturity check away from the sub-millisecond edge;
    // exercise the exact -1ms boundary against the same authoritative service.
    await env.clock(TIME + H8 - 60000); await page.reload({ waitUntil: 'load' }); await B.connected(page);
    assert.equal((await farm(page)).readyCount, 0); await disabledWithoutWrite(page, env, action('farm-harvest'));
    await env.clock(TIME + H8 - 1);
    const edge = (await env.api('/api/state')).body;
    const refused = await env.api('/api/action', { revision: edge.revision, action: { id: 'v12-before-eight-hours', type: 'farm.harvest' } });
    assert.equal(refused.status, 400); assert.match(JSON.stringify(refused.body), /成熟/);
    assert.deepEqual((await env.api('/api/state')).body.state, edge.state);
    await page.close(); await env.clock(TIME + H8);
    page = await env.newPage(); activePage = page; await env.load(page);
    assert.equal((await farm(page)).readyCount, 4);
    await click(page, action('farm-harvest'), { scroll: false }); await settled(page);
    assert.deepEqual((await farm(page)).inventory, { carrot: 0, strawberry: 12, sunflower: 0 }); assert.equal((await farm(page)).emptyCount, 4);
    await disabledWithoutWrite(page, env, action('farm-harvest'));
    assert.deepEqual(await ledger(page), before);
    const saved = (await env.api('/api/state')).body.state; assert.deepEqual(await state(page), saved);
    assert.equal(saved.farm.lastHarvest.batchIds.length, 4);
    await screenshot(page, 'loop-eight-hour-harvest');
  });
}

async function individualPlots(env, page) {
  const before = await state(page), totalsBefore = await ledger(page);
  await check('Individual plot selection preserves other plots; watering is free and does not accelerate readiness', async () => {
    for (const [id, crop] of [['p2', 'carrot'], ['p3', 'strawberry']]) {
      await openFarm(page, 'fields'); await click(page, action('farm-plot', id)); await farmView(page, 'plot');
      await click(page, action('farm-seeds', id)); await farmView(page, 'seed');
      await click(page, action('farm-crop', crop)); await click(page, action('farm-plant')); await settled(page);
    }
    const planted = await state(page);
    assert.deepEqual(planted.farm.plots.filter(plot => plot.cropId).map(plot => [plot.id, plot.cropId]), [['p2', 'carrot'], ['p3', 'strawberry']]);
    await openFarm(page, 'fields'); await click(page, action('farm-plot', 'p2')); await farmView(page, 'plot');
    await click(page, action('farm-water', 'p2'));
    assert.deepEqual(await state(page), planted, 'Watering neither writes resources nor changes readyAt');
    assert.equal(await visible(page, '.sheet ' + action('farm-seeds')), false, 'Growing plot cannot be uprooted/replaced');
    await env.clock(TIME + H8); await page.reload({ waitUntil: 'load' }); await B.connected(page);
    await openFarm(page, 'fields'); await click(page, action('farm-plot', 'p2')); await click(page, action('farm-harvest', 'p2')); await settled(page);
    const f = await farm(page); assert.equal(f.inventory.carrot, before.farm.inventory.carrot + 3);
    assert.equal(f.inventory.strawberry, before.farm.inventory.strawberry); assert.equal(f.plots[2].status, 'ready');
    assert.equal(f.plots[1].status, 'empty'); assert.deepEqual(await ledger(page), totalsBefore);
    await screenshot(page, 'individual-carrot-harvest');
  });
}

async function exchangeAndHouse(env, page) {
  const before = await ledger(page);
  await check('House3 requires House2; insufficient and already-owned items cannot spend inventory', async () => {
    await itemPage(page, 'house3'); assert.match(await page.$eval('.sheet', node => node.textContent), /二级|2级/);
    await disabledWithoutWrite(page, env, action('farm-exchange', 'house3'));
    await itemPage(page, 'flowerpot');
    let held; const handler = request => { if (new URL(request.url()).pathname === '/api/action' && !held) held = request; else request.continue(); };
    await page.setRequestInterception(true); page.on('request', handler);
    const old = await state(page), count = posts(env, 'farm.exchange').length;
    try {
      const arrived = page.waitForRequest(request => new URL(request.url()).pathname === '/api/action');
      await click(page, action('farm-exchange', 'flowerpot')); await arrived;
      assert.deepEqual(await state(page), old, 'No optimistic inventory or ownership before server success');
      const r = await page.$eval(action('farm-exchange', 'flowerpot'), node => { const r = node.getBoundingClientRect(); return { disabled: node.disabled, x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      assert.ok(r.disabled); await page.mouse.click(r.x, r.y); await page.mouse.click(r.x, r.y);
      assert.equal(posts(env, 'farm.exchange').length, count + 1);
    } finally {
      if (held && !held.isInterceptResolutionHandled()) await held.continue(); page.off('request', handler); await page.setRequestInterception(false);
    }
    await settled(page); assert.equal((await farm(page)).inventory.carrot, old.farm.inventory.carrot - 3);
    await itemPage(page, 'flowerpot');
    if (await visible(page, action('farm-exchange', 'flowerpot'))) await disabledWithoutWrite(page, env, action('farm-exchange', 'flowerpot'));
    else assert.ok(await visible(page, action('farm-place', 'flowerpot')), 'Owned item replaces purchase with placement');
  });
  await check('All six decorations exchange once; placement/replacement/removal retains ownership and upgrades the same house to levels 2/3', async () => {
    for (const id of ['picnic', 'rabbitstatue', 'mailbox', 'trellis', 'windmill', 'house2', 'house3']) {
      await itemPage(page, id); const old = await farm(page), cost = old.catalog.find(item => item.id === id).cost;
      await click(page, action('farm-exchange', id)); await settled(page);
      const current = await farm(page); assert.ok(current.owned.includes(id));
      for (const crop of ['carrot', 'strawberry', 'sunflower']) assert.equal(current.inventory[crop], old.inventory[crop] - cost[crop]);
      if (id === 'house2' || id === 'house3') assert.equal(current.houseLevel, Number(id.slice(-1)));
      else { await itemPage(page, id); await click(page, action('farm-place', id)); await settled(page); assert.equal((await farm(page)).placements[current.catalog.find(item => item.id === id).slot], id); }
    }
    await itemPage(page, 'flowerpot'); await click(page, action('farm-place', 'flowerpot')); await settled(page);
    assert.equal((await farm(page)).placements.entry, 'flowerpot'); assert.ok((await farm(page)).owned.includes('mailbox'));
    await click(page, action('farm-remove', 'entry')); await settled(page);
    assert.equal((await farm(page)).placements.entry, null); assert.ok((await farm(page)).owned.includes('flowerpot'));
    assert.deepEqual(await ledger(page), before); assert.equal((await farm(page)).houseLevel, 3);
    await home(page); await screenshot(page, 'house3-decorated-home');
    await openFarm(page); await sceneReady(page); await screenshot(page, 'house3-decorated-yard'); await home(page);
    await page.reload({ waitUntil: 'load' }); await B.connected(page);
    assert.equal((await farm(page)).houseLevel, 3); assert.equal(new Set((await farm(page)).owned).size, 10);
  });
}

async function insufficient(env, page) {
  await start(page, env);
  await check('Insufficient materials and growth gates expose clear reasons and never partially debit', async () => {
    for (const id of ['flowerpot', 'mailbox', 'house2', 'windmill']) {
      await itemPage(page, id); const f = await farm(page), item = f.catalog.find(item => item.id === id);
      assert.equal(item.canBuy, false); assert.ok(item.reason);
      assert.match(await page.$eval('.sheet', node => node.textContent), id === 'windmill' ? /500|成长/ : /缺|不足|萝卜|草莓/);
      await disabledWithoutWrite(page, env, action('farm-exchange', id));
    }
    assert.deepEqual((await farm(page)).inventory, { carrot: 0, strawberry: 0, sunflower: 0 });
  });
}

async function careAndCollection(env, page) {
  const before = await ledger(page), exploration = M.petStatus(await state(page), new Date(TIME)).exploration;
  await check('Unlimited free partner care changes neither XP, inventory, nor archived exploration', async () => {
    const inventory = (await farm(page)).inventory, priorState = await state(page), priorPosts = env.requests.length;
    await home(page); await click(page, action('farm-care'), { scroll: false }); await farmView(page, 'care');
    for (let index = 0; index < 4; index++) {
      await click(page, action('farm-pet-play', ['feed', 'wash', 'train'][index % 3]));
      await settled(page);
    }
    assert.deepEqual(await state(page), priorState, 'Free companionship is local animation only');
    assert.equal(env.requests.length, priorPosts, 'Free companionship never writes the shared family');
    assert.deepEqual((await farm(page)).inventory, inventory); assert.deepEqual(await ledger(page), before);
    assert.equal(M.petStatus(await state(page), new Date(TIME)).exploration, exploration);
  });
  await check('Each animal counts one care per family day; gaps keep cumulative progress and unlock at 3/7', async () => {
    const days = [0, 1, 3, 4, 7, 9, 10];
    for (let index = 0; index < days.length; index++) {
      await env.clock(TIME + days[index] * DAY); await page.reload({ waitUntil: 'load' }); await B.connected(page);
      for (const id of ['chicken', 'rabbit']) {
        await animalPage(page, id); await click(page, action('farm-animal-care', id)); await settled(page);
        let animal = (await farm(page)).animals.find(row => row.id === id);
        assert.equal(animal.careCount, index + 1); assert.equal(animal.caredToday, true);
        assert.equal(animal.cardUnlocked, index >= 2); assert.equal(animal.actionUnlocked, index >= 6);
        await click(page, action('farm-animal-care', id)); await settled(page);
        animal = (await farm(page)).animals.find(row => row.id === id); assert.equal(animal.careCount, index + 1);
      }
      if (index === 2 || index === 6) {
        await openFarm(page, 'collection'); await farmView(page, 'collection');
        assert.match(await page.$eval('.sheet', node => node.textContent), /小鸡/); assert.match(await page.$eval('.sheet', node => node.textContent), /兔/);
        await screenshot(page, 'animal-collection-' + (index + 1));
      }
    }
    assert.deepEqual(await ledger(page), before); assert.equal((await state(page)).farm.animalCare.length, 14);
  });
}

async function synchronization(env, page) {
  await start(page, env);
  const second = await env.newPage({ width: 1024, height: 768 }); await env.load(second);
  await check('Two pages racing the same welcome harvest converge to exactly three carrots and one receipt', async () => {
    await Promise.all([click(page, action('farm-harvest'), { scroll: false }), click(second, action('farm-harvest'), { scroll: false })]);
    await settled(page); await settled(second);
    await page.waitForFunction(() => window.FamilyDemo.getState().farm.inventory.carrot === 3, { timeout: 12000, polling: 150 });
    await second.waitForFunction(() => window.FamilyDemo.getState().farm.inventory.carrot === 3, { timeout: 12000, polling: 150 });
    assert.equal(posts(env, 'farm.harvest').length, 2, 'Both pages exercised the real competing write path');
    assert.equal((await env.api('/api/state')).body.state.farm.inventory.carrot, 3);
    assert.deepEqual((await state(second)).farm, (await state(page)).farm);
    await second.reload({ waitUntil: 'load' }); await B.connected(second); assert.equal((await farm(second)).readyCount, 0);
    await disabledWithoutWrite(second, env, action('farm-harvest'));
  });
  await check('Disconnected shared exchange cannot grant ownership or spend locally; reconnect permits one actual exchange', async () => {
    await itemPage(page, 'flowerpot'); const before = await state(page);
    const intercept = request => { if (new URL(request.url()).pathname.startsWith('/api/')) request.abort('internetdisconnected'); else request.continue(); };
    await page.setRequestInterception(true); page.on('request', intercept);
    try {
      await click(page, action('farm-exchange', 'flowerpot')); await settled(page);
      await page.waitForFunction(() => !window.FamilyDemo.getUI().connected, { timeout: 7000 });
      assert.deepEqual(await state(page), before); assert.deepEqual((await env.api('/api/state')).body.state, before);
      assert.match(await page.$eval('body', node => node.textContent), /连接|断开|待确认|同步/);
      await screenshot(page, 'shared-disconnected-exchange');
    } finally { page.off('request', intercept); await page.setRequestInterception(false); }
    await page.reload({ waitUntil: 'load' }); await B.connected(page);
    assert.equal((await farm(page)).owned.includes('flowerpot'), false);
    await itemPage(page, 'flowerpot'); await click(page, action('farm-exchange', 'flowerpot')); await settled(page);
    await second.waitForFunction(() => window.FamilyDemo.getState().farm.owned.includes('flowerpot'), { timeout: 12000 });
    assert.equal((await farm(second)).inventory.carrot, 0);
  });
}

async function lostResponse(env, page) {
  await start(page, env);
  await check('A committed harvest with its response lost shows no fake local success, then polling reconciles that same receipt once', async () => {
    const before = await state(page); let forwarded, forwardedResult, online = false;
    const intercept = async request => {
      const endpoint = new URL(request.url()).pathname;
      if (endpoint === '/api/action' && !forwarded) {
        forwarded = JSON.parse(request.postData());
        forwardedResult = await env.api('/api/action', forwarded);
        await request.abort('internetdisconnected');
      } else if (endpoint.startsWith('/api/') && !online) await request.abort('internetdisconnected');
      else await request.continue();
    };
    await page.setRequestInterception(true); page.on('request', intercept);
    try {
      await click(page, action('farm-harvest'), { scroll: false }); await settled(page);
      await page.waitForFunction(() => !window.FamilyDemo.getUI().connected, { timeout: 7000 });
      assert.equal(forwardedResult.status, 200); assert.deepEqual(await state(page), before);
      assert.equal((await env.api('/api/state')).body.state.farm.inventory.carrot, 3);
      await disabledWithoutWrite(page, env, action('farm-harvest'));
      await screenshot(page, 'harvest-response-lost'); online = true;
      await page.waitForFunction(() => window.FamilyDemo.getUI().connected && window.FamilyDemo.getState().farm.inventory.carrot === 3, { timeout: 12000 });
      assert.equal((await state(page)).farm.lastHarvest.id, forwarded.action.id);
      assert.equal((await state(page)).appliedActions.filter(id => id === forwarded.action.id).length, 1);
      assert.equal(posts(env, 'farm.harvest').length, 1);
      assert.deepEqual(await state(page), (await env.api('/api/state')).body.state);
      await disabledWithoutWrite(page, env, action('farm-harvest'));
    } finally { page.off('request', intercept); await page.setRequestInterception(false); }
  });
}

async function crossHarvestReceipt(env, page) {
  const second = await env.newPage(); await env.load(second);
  await check('A lost carrot receipt is never presented as device B\'s later strawberry harvest', async () => {
    await openFarm(page, 'fields'); await click(page, action('farm-plot', 'p1'));
    let forwarded, reply, online = false;
    const intercept = async request => {
      const endpoint = new URL(request.url()).pathname;
      if (endpoint === '/api/action' && !forwarded) {
        forwarded = JSON.parse(request.postData()); reply = await env.api('/api/action', forwarded); await request.abort('internetdisconnected');
      } else if (endpoint.startsWith('/api/') && !online) await request.abort('internetdisconnected');
      else await request.continue();
    };
    await page.setRequestInterception(true); page.on('request', intercept);
    try {
      await click(page, action('farm-harvest', 'p1')); await settled(page);
      await page.waitForFunction(() => !window.FamilyDemo.getUI().connected);
      assert.equal(reply.status, 200); assert.deepEqual(reply.body.state.farm.lastHarvest.crops, { carrot: 3, strawberry: 0, sunflower: 0 });
      await second.reload({ waitUntil: 'load' }); await B.connected(second);
      await openFarm(second, 'fields'); await click(second, action('farm-plot', 'p2'));
      await click(second, action('farm-harvest', 'p2')); await settled(second);
      const bFeedback = await second.$eval('#toast', node => node.textContent); assert.match(bFeedback, /草莓\s*\+\s*3/);
      assert.notEqual((await state(second)).farm.lastHarvest.id, forwarded.action.id);
      online = true; await page.bringToFront();
      await page.waitForFunction(() => window.FamilyDemo.getUI().connected && window.FamilyDemo.getState().farm.inventory.strawberry === 3, { timeout: 12000, polling: 150 });
      const aFeedback = await page.$eval('#toast', node => node.textContent);
      assert.match(aFeedback, /收获|同步|萝卜/); assert.doesNotMatch(aFeedback, /草莓/, 'A must not claim device B\'s crop as its own');
      assert.deepEqual((await farm(page)).inventory, { carrot: 3, strawberry: 3, sunflower: 0 });
      report.receiptAttribution = { aAction: forwarded.action.id, aFeedback, bAction: (await state(second)).farm.lastHarvest.id, bFeedback };
      await screenshot(page, 'two-device-carrot-receipt');
    } catch (error) {
      report.receiptAttributionFailure = { ui: await ui(page), state: await state(page), server: (await env.api('/api/state')).body, secondUI: await ui(second) };
      throw error;
    } finally { page.off('request', intercept); await page.setRequestInterception(false); }
  });
}

async function clockSamples(env, page) {
  await start(page, env);
  await click(page, action('farm-seeds')); await click(page, action('farm-crop', 'strawberry')); await click(page, action('farm-plant')); await settled(page);
  await check('A delayed older server clock sample at the same revision never moves growing crops backward', async () => {
    const older = (await env.api('/api/state')).body;
    await env.clock(TIME + H8 / 2); await page.reload({ waitUntil: 'load' }); await B.connected(page);
    const before = (await farm(page)).plots.find(plot => plot.id === 'p2').remainingMs;
    assert.ok(before > H8 / 2 - 10000 && before <= H8 / 2);
    let delivered = false;
    const intercept = async request => {
      if (!delivered && request.method() === 'GET' && new URL(request.url()).pathname === '/api/state') {
        delivered = true; await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(older) });
      } else await request.continue();
    };
    await page.setRequestInterception(true); page.on('request', intercept);
    try {
      const response = await page.waitForResponse(response => new URL(response.url()).pathname === '/api/state', { timeout: 10000 });
      await response.text(); await B.delay(150); assert.ok(delivered);
      const after = (await farm(page)).plots.find(plot => plot.id === 'p2').remainingMs;
      assert.ok(after <= before + 100, 'Remaining time must not jump backward: before=' + before + ', after=' + after);
      assert.deepEqual(await state(page), older.state);
      report.clockSample = { sameRevision: older.revision, staleServerNow: older.serverNow, beforeRemainingMs: before, afterRemainingMs: after };
    } finally { page.off('request', intercept); await page.setRequestInterception(false); }
  });
}

async function business(env, page) {
  await start(page, env); const originalFarm = (await state(page)).farm;
  await check('Real award still requires operation-bound PIN; wrong PIN leaves both ledger and farm unchanged, 500 XP unlocks 6 plots', async () => {
    const before = await ledger(page);
    await click(page, action('add-points'), { scroll: false }); await click(page, action('points-new'));
    await typed(page, 'name', '隔离浏览器成长解锁'); await typed(page, 'points', 372); await typed(page, 'reason', '本次实际核验的隔离测试加分');
    await click(page, SAVE, { scroll: false }); await page.waitForSelector('#parent-form [name="answer"]');
    assert.deepEqual(await ledger(page), before); await verify(page, '000000'); assert.deepEqual(await ledger(page), before);
    assert.deepEqual((await state(page)).farm, originalFarm); await verify(page);
    await B.noSheet(page); assert.equal((await ledger(page)).earned, 500); assert.equal((await farm(page)).plotLimit, 6);
    assert.equal((await farm(page)).crops.find(crop => crop.id === 'sunflower').unlocked, true);
    assert.ok(posts(env, 'points.add').at(-1).body.grant);
  });
  await check('Gift request is public; approval requires fresh PIN and spends only family available points', async () => {
    const before = await ledger(page), farmBefore = (await state(page)).farm;
    await home(page); await click(page, action('jump-rewards'), { scroll: false }); await click(page, action('redeem', 'reward-pencil'));
    await click(page, SAVE, { scroll: false }); await settled(page);
    const request = (await state(page)).requests.find(row => row.status === 'pending'); assert.ok(request); assert.deepEqual(await ledger(page), before);
    await home(page); await click(page, action('home-inbox'), { scroll: false }); await click(page, action('redemption-approve', request.id));
    await protectedSave(page, env, 'redemption.approve');
    assert.deepEqual(await ledger(page), { earned: before.earned, spent: before.spent + 12, available: before.available - 12 });
    assert.deepEqual((await state(page)).farm, farmBefore);
  });
  await check('Reminder creation remains protected; public completion never changes farm or awards points', async () => {
    await home(page); await B.navigate(page, 'reminders'); const before = await ledger(page), farmBefore = (await state(page)).farm;
    await click(page, action('task-new')); await typed(page, 'title', '农场回归提醒');
    await protectedSave(page, env, 'task.save'); await B.noSheet(page);
    const task = (await state(page)).tasks.find(row => row.title === '农场回归提醒'); assert.ok(task);
    await click(page, action('task-toggle', task.id)); await settled(page);
    assert.equal((await state(page)).tasks.find(row => row.id === task.id).done, true);
    assert.deepEqual(await ledger(page), before); assert.deepEqual((await state(page)).farm, farmBefore);
  });
  await check('Switching original partner preserves the shared farm and welcome receipt', async () => {
    await home(page); await openFarm(page, 'collection'); await click(page, action('pet-config'));
    await click(page, action('pet-kind', 'capybara')); const before = (await state(page)).farm;
    const challenges = env.requests.filter(row => row.path === '/api/parent/challenge').length;
    await click(page, SAVE, { scroll: false }); await settled(page); await home(page);
    assert.equal(env.requests.filter(row => row.path === '/api/parent/challenge').length, challenges, 'Original partner selection remains a public action');
    assert.equal((await state(page)).pet.kind, 'capybara'); assert.deepEqual((await state(page)).farm, before);
    await page.reload({ waitUntil: 'load' }); await B.connected(page);
    assert.equal((await ui(page)).petKind, 'capybara'); assert.deepEqual((await state(page)).farm, before);
    await screenshot(page, 'original-partner-capybara');
  });
}

async function layouts(env, page) {
  for (const [name, width, height] of B.VIEWPORTS) {
    await page.setViewport({ width, height, deviceScaleFactor: 1 }); await B.delay(150);
    await check(name + ' first-use home: 48px targets, unoccluded core entries, no document scroll', async () => {
      await home(page); await audit(page, name + '-preview', [action('add-points'), action('jump-rewards'), action('farm-start'), '.bottom-nav ' + action('nav'), action('home-inbox')], true);
    });
  }
  await start(page, env);
  for (const [name, width, height] of B.VIEWPORTS) {
    await page.setViewport({ width, height, deviceScaleFactor: 1 }); await B.delay(150);
    await check(name + ' initialized home and full-yard controls remain reachable at 48px', async () => {
      await home(page); await sceneReady(page);
      await audit(page, name + '-home', [action('add-points'), action('jump-rewards'), action('farm-harvest'), action('farm-seeds'), action('farm-care'), action('farm-open'), '.bottom-nav ' + action('nav')], true);
      const d = await diagnostics(page); report.renderer.push({ label: name + '-home', diagnostics: d });
      assert.ok(d.bodyScreenBounds && d.bodyScreenBounds.height > 0, 'Partner has visible body bounds');
      const minimumBody = width === 320 ? 100 : width === 390 ? 170 : width >= 1024 && width > height ? 240 : 0;
      assert.ok(d.bodyScreenBounds.height >= minimumBody - .5, 'Previously accepted body-height minimum ' + minimumBody + 'px: ' + JSON.stringify(d.bodyScreenBounds));
      // The size floor is necessary; separate screenshot review still judges quality.
      assert.ok(d.bodyScreenBounds.height < height, 'Anatomical body is not larger than the whole viewport');
      await click(page, action('farm-open'), { scroll: false }); await farmView(page, 'yard');
      await audit(page, name + '-yard', [action('farm-home'), action('farm-tab')], true);
      await click(page, action('farm-tab', 'build')); await click(page, action('farm-item', 'house2'));
      await audit(page, name + '-item', [action('farm-home'), action('farm-exchange', 'house2')]);
    });
  }
}

async function renderer(env, page) {
  await check('Normal WebGL renders; home and expanded yard retain exactly the same canvas', async () => {
    const d = await sceneReady(page); report.renderer.push({ label: 'initial', diagnostics: d });
    const canvas = await page.$('canvas'); assert.ok(canvas);
    const supported = await canvas.evaluate(node => !!(node.getContext('webgl2') || node.getContext('webgl'))); assert.ok(supported, 'Canvas has a WebGL context');
    await start(page, env); await openFarm(page);
    assert.equal(await canvas.evaluate(node => node.isConnected && node === document.querySelector('canvas')), true);
    assert.equal(await page.$$eval('canvas', nodes => nodes.length), 1);
    await home(page); assert.equal(await canvas.evaluate(node => node === document.querySelector('canvas')), true);
    await canvas.dispose();
  });
  await check('A projected plot target responds to a real canvas click', async () => {
    await openFarm(page, 'fields'); await sceneReady(page);
    const target = (await visibleSceneTargets(page, 'plot'))[0];
    assert.ok(target, 'Expanded default view exposes an unobscured plot target');
    await page.mouse.click(target.center.x, target.center.y); await farmView(page, 'plot');
    assert.match(await page.$eval('.sheet', node => node.textContent), new RegExp(target.id.slice(1) + '号田'));
    await home(page);
  });
  await check('Leaving for reminders pauses rendering and returning resumes without growing resources', async () => {
    await B.delay(1200); const initial = await diagnostics(page);
    report.renderer.push({ label: 'before-navigation', diagnostics: initial });
    await B.navigate(page, 'reminders'); await B.delay(200); const paused = await diagnostics(page);
    report.renderer.push({ label: 'paused-reminders', diagnostics: paused });
    assert.equal(paused.running, false, 'Renderer is paused away from farm');
    await B.delay(250); assert.equal((await diagnostics(page)).frameCount, paused.frameCount, 'Paused scene stops drawing frames');
    await B.navigate(page, 'points'); await B.delay(1200); const resumed = await diagnostics(page);
    report.renderer.push({ label: 'resumed-home', diagnostics: resumed }); assert.equal(resumed.running, true); assert.ok(resumed.fps > 0);
    // The selection ring has its own lazily uploaded geometry/material. Warm
    // both views after the first real selection, then check a stable platform
    // rather than mistaking the first GPU upload for a leak.
    for (let index = 0; index < 2; index++) { await openFarm(page, 'fields'); await home(page); }
    await B.delay(300); const warm = await diagnostics(page);
    report.renderer.push({ label: 'warmed-home-selection', diagnostics: warm });
    assert.ok(warm.memory && Number.isInteger(warm.memory.geometries) && Number.isInteger(warm.memory.programs));
    for (let index = 1; index <= 8; index++) {
      await openFarm(page, 'fields'); await home(page);
      if ([2, 4, 8].includes(index)) {
        const measured = await diagnostics(page); report.renderer.push({ label: 'after-' + index + '-warmed-roundtrips', diagnostics: measured });
        assert.deepEqual(measured.memory, warm.memory, 'No WebGL resource growth after ' + index + ' warmed UI roundtrips');
      }
    }
    assert.equal(await page.$$eval('canvas', nodes => nodes.length), 1);
  });
}

async function cameraBrowsing(env, page) {
  await openFarm(page, 'fields'); await sceneReady(page);
  await check('Expanded camera supports actual drag, wheel zoom and visible reset without writing farm state', async () => {
    const beforeState = await state(page), beforePosts = env.requests.length, before = await diagnostics(page);
    assert.equal(before.camera.canPan, true); assert.equal(before.world.terrain, 'continuous'); assert.equal(before.shadows.enabled, true);
    const drag = await page.evaluate(() => {
      const c = document.querySelector('.sheet canvas.family-farm-canvas'), r = c.getBoundingClientRect();
      for (const y of [.5, .42, .65]) for (const x of [.4, .55, .3]) {
        const a = { x: r.x + r.width * x, y: r.y + r.height * y }, b = { x: a.x + Math.min(120, r.width * .2), y: a.y + 24 };
        if ([a, b].every(p => document.elementFromPoint(p.x, p.y) === c)) return { a, b };
      }
      return null;
    });
    assert.ok(drag, 'Expanded HUD leaves room for an actual camera gesture');
    await page.mouse.move(drag.a.x, drag.a.y); await page.mouse.down(); await page.mouse.move(drag.b.x, drag.b.y, { steps: 12 }); await page.mouse.up(); await B.delay(200);
    const panned = await diagnostics(page); assert.notDeepEqual(panned.camera.target, before.camera.target); assert.equal((await ui(page)).farmView, 'yard', 'Dragging does not open a plot/animal detail');
    await screenshot(page, 'camera-desktop-panned');
    await page.mouse.move(drag.a.x, drag.a.y); await page.mouse.wheel({ deltaY: -240 }); await B.delay(200);
    assert.notEqual((await diagnostics(page)).camera.zoom, panned.camera.zoom);
    await click(page, action('farm-camera-reset')); const reset = await diagnostics(page);
    assert.ok(Math.abs(reset.camera.zoom - before.camera.zoom) < .001); assert.deepEqual(reset.camera.target, before.camera.target);
    await click(page, action('farm-zoom-in')); assert.ok((await diagnostics(page)).camera.zoom > reset.camera.zoom);
    await click(page, action('farm-zoom-out')); await click(page, action('farm-camera-reset'));
    assert.deepEqual(await state(page), beforeState); assert.equal(env.requests.length, beforePosts);
    await audit(page, 'camera-desktop-reset', [action('farm-zoom-in'), action('farm-zoom-out'), action('farm-camera-reset'), action('farm-home')]);
  });
  await check('390px touch drag and zoom buttons browse the scene without accidental selection', async () => {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    // Changing isMobile reloads Chromium; re-enter through real UI before the gesture.
    await B.connected(page); await openFarm(page, 'fields'); await sceneReady(page); await B.delay(200);
    await click(page, action('farm-camera-reset')); const before = await diagnostics(page), r = await canvasRect(page);
    const point = await page.evaluate(r => {
      for (const y of [.4, .52, .65]) {
        const a = { x: r.x + r.width * .38, y: r.y + r.height * y }, b = { x: r.x + r.width * .66, y: a.y + 20 };
        if ([a, b].every(p => { const at = document.elementFromPoint(p.x, p.y); return at && at.matches('canvas.family-farm-canvas'); })) return { a, b };
      }
      return null;
    }, r);
    assert.ok(point); const touch = await page.touchscreen.touchStart(point.a.x, point.a.y); await touch.move(point.b.x, point.b.y); await touch.end(); await B.delay(200);
    assert.notDeepEqual((await diagnostics(page)).camera.target, before.camera.target); assert.equal((await ui(page)).farmView, 'yard');
    await screenshot(page, 'camera-phone-panned');
    const tap = async selector => { const m = (await B.metrics(page, await scoped(page, selector)))[0]; assert.ok(m && m.inViewport && m.reachable && m.width >= 47.9 && m.height >= 47.9); await page.touchscreen.tap(m.left + m.width / 2, m.top + m.height / 2); await B.delay(150); };
    await tap(action('farm-zoom-in')); await tap(action('farm-camera-reset')); await sceneReady(page);
    const target = (await visibleSceneTargets(page, 'plot'))[0]; assert.ok(target, 'Reset phone camera exposes a selectable plot');
    await page.touchscreen.tap(target.center.x, target.center.y); await farmView(page, 'plot');
    assert.match(await page.$eval('.sheet', node => node.textContent), new RegExp(target.id.slice(1) + '号田'));
    await screenshot(page, 'camera-phone-plot-focus');
  });
  await check('320x568 yard exposes four 48px camera controls above the plot tray and accepts real taps', async () => {
    await page.setViewport({ width: 320, height: 568, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await openFarm(page, 'fields'); await sceneReady(page);
    const beforeState = await state(page), beforePosts = env.requests.length;
    for (const name of ['farm-zoom-in', 'farm-zoom-out', 'farm-camera-reset', 'farm-lighting']) {
      const selector = await scoped(page, action(name)), targets = await B.metrics(page, selector), target = targets[0];
      assert.ok(target && target.reachable && target.inViewport && target.width >= 47.9 && target.height >= 47.9, name + ': ' + JSON.stringify(targets));
      await page.touchscreen.tap(target.left + target.width / 2, target.top + target.height / 2); await B.delay(150);
    }
    assert.equal((await diagnostics(page)).lighting, 'night'); await screenshot(page, 'camera-small-phone-four-tools-night');
    const light = (await B.metrics(page, await scoped(page, action('farm-lighting'))))[0];
    await page.touchscreen.tap(light.left + light.width / 2, light.top + light.height / 2); await B.delay(150);
    assert.equal((await diagnostics(page)).lighting, 'day'); assert.deepEqual(await state(page), beforeState); assert.equal(env.requests.length, beforePosts);
    await screenshot(page, 'camera-small-phone-four-tools-day');
  });
}

async function visualSamples(env, page) {
  await check('Record actual app composition for both companions at desktop and two phone widths', async () => {
    for (const kind of ['plant', 'capybara']) {
      if ((await ui(page)).petKind !== kind) {
        await home(page); await openFarm(page, 'collection'); await click(page, action('pet-config')); await click(page, action('pet-kind', kind)); await click(page, SAVE); await settled(page);
        await home(page); await page.waitForFunction(() => !window.FamilyDemo.getUI().homeFeedback, { timeout: 7000, polling: 100 });
      }
      for (const [name, width, height] of [['desktop', 1024, 768], ['phone', 390, 844], ['small-phone', 320, 568]]) {
        await page.setViewport({ width, height, deviceScaleFactor: 1 }); await home(page); await sceneReady(page); await B.delay(300);
        report.renderer.push({ label: 'visual-' + kind + '-' + name + '-home', diagnostics: await diagnostics(page) }); await screenshot(page, 'visual-' + kind + '-' + name + '-home');
        await openFarm(page, 'fields'); await sceneReady(page); await click(page, action('farm-camera-reset')); await B.delay(300);
        const d = await diagnostics(page); assert.equal(d.world.terrain, 'continuous'); assert.equal(d.shadows.enabled, true);
        report.renderer.push({ label: 'visual-' + kind + '-' + name + '-expanded', diagnostics: d }); await screenshot(page, 'visual-' + kind + '-' + name + '-expanded');
        const beforeLightingState = await state(page), beforeLightingPosts = env.requests.length;
        assert.ok(await visible(page, action('farm-lighting')), 'Day/night button is visible in the actual app');
        await click(page, action('farm-lighting'));
        await page.waitForFunction(() => window.FamilyFarmScene.diagnostics().instances[0].lighting === 'night'); await B.delay(250);
        const night = await diagnostics(page); assert.equal(night.canvasId, d.canvasId); await screenshot(page, 'visual-' + kind + '-' + name + '-night');
        await click(page, action('farm-lighting')); await page.waitForFunction(() => window.FamilyFarmScene.diagnostics().instances[0].lighting === 'day');
        assert.deepEqual(await state(page), beforeLightingState); assert.equal(env.requests.length, beforeLightingPosts, 'Lighting is visual only and sends no family action');
      }
      await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 1 }); await itemPage(page, 'house3'); await sceneReady(page); await screenshot(page, 'visual-' + kind + '-house3-detail');
    }
    // A pass here means the evidence was captured. It does not approve its aesthetics.
  });
}

async function touchInput(env, page) {
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.reload({ waitUntil: 'load' }); await B.connected(page);
  await check('Emulated touchscreen can start, harvest, choose seed and plant without mouse-only handlers', async () => {
    const tap = async selector => {
      const rows = await B.metrics(page, await scoped(page, selector)); assert.ok(rows.length);
      const r = rows[0]; assert.ok(r.inViewport && r.reachable); assert.ok(r.width >= 47.9 && r.height >= 47.9);
      await page.touchscreen.tap(r.left + r.width / 2, r.top + r.height / 2); await B.delay(150); await settled(page);
    };
    await tap(action('farm-start')); assert.equal((await farm(page)).initialized, true);
    await tap(action('farm-harvest')); assert.equal((await farm(page)).inventory.carrot, 3);
    await tap(action('farm-seeds')); await farmView(page, 'seed');
    await tap(action('farm-crop', 'strawberry')); await tap(action('farm-plant'));
    assert.equal((await farm(page)).plots.filter(plot => plot.cropId === 'strawberry').length, 4);
    await screenshot(page, 'touch-emulation-planted');
  });
}

async function offline(env, page) {
  const target = path.join(ROOT, 'export', 'little-steps-demo.html');
  await check('Final self-contained export actually renders and performs the farm loop without any network request', async () => {
    assert.ok(fs.existsSync(target), 'Lead must generate the final offline export before this group'); report.exportHash = sha('export/little-steps-demo.html');
    const network = [], handler = request => { if (/^https?:/.test(request.url())) { network.push(request.url()); request.abort('internetdisconnected'); } else request.continue(); };
    await page.setRequestInterception(true); page.on('request', handler);
    await page.goto(pathToFileURL(target).href, { waitUntil: 'load' });
    await page.waitForFunction(() => window.FamilyDemo && window.FamilyDemo.getUI().farmStatus);
    assert.equal((await ui(page)).connected, false); assert.match(await page.$eval('body', node => node.textContent), /离线|本机/);
    await sceneReady(page); await click(page, action('farm-start'), { scroll: false }); await settled(page);
    await click(page, action('farm-harvest'), { scroll: false }); await settled(page);
    await itemPage(page, 'flowerpot'); await click(page, action('farm-exchange', 'flowerpot')); await settled(page);
    await itemPage(page, 'flowerpot'); await click(page, action('farm-place', 'flowerpot')); await settled(page);
    assert.equal((await farm(page)).placements.entry, 'flowerpot');
    await home(page); await click(page, action('farm-seeds')); await click(page, action('farm-crop', 'carrot')); await click(page, action('farm-plant')); await settled(page);
    await env.clock(TIME + H8); await page.reload({ waitUntil: 'load' }); await page.waitForFunction(() => window.FamilyDemo);
    assert.equal((await farm(page)).readyCount, 4); assert.equal((await farm(page)).placements.entry, 'flowerpot');
    await click(page, action('farm-harvest'), { scroll: false }); await settled(page); assert.equal((await farm(page)).inventory.carrot, 12);
    assert.equal((await ledger(page)).earned, 128); assert.deepEqual(network, []);
    await screenshot(page, 'offline-local-eight-hour-loop');
  });
  await check('An open offline animal panel refreshes itself across local midnight and permits one new daily care', async () => {
    await env.clock(new Date(2026, 10, 15, 23, 59, 58).getTime());
    await animalPage(page, 'chicken'); await click(page, action('farm-animal-care', 'chicken')); await settled(page);
    assert.equal((await farm(page)).animals.find(animal => animal.id === 'chicken').careCount, 1);
    assert.match(await page.$eval(action('farm-animal-care', 'chicken'), node => node.textContent), /再陪/);
    await env.clock(new Date(2026, 10, 16, 0, 0, 1).getTime());
    await page.waitForFunction(() => {
      const button = document.querySelector('button[data-action="farm-animal-care"][data-id="chicken"]');
      return button && button.textContent.includes('照料一下');
    }, { timeout: 7000 });
    assert.equal((await ui(page)).farmView, 'animal', 'Panel remains open; no manual reload or navigation');
    await click(page, action('farm-animal-care', 'chicken')); await settled(page);
    const animal = (await farm(page)).animals.find(row => row.id === 'chicken');
    assert.equal(animal.careCount, 2); assert.equal(animal.caredToday, true);
    assert.deepEqual((await state(page)).farm.animalCare.map(row => row.day), ['2026-11-15', '2026-11-16']);
    await screenshot(page, 'offline-animal-midnight');
  });
}

async function offlineHttp(env, page) {
  const target = path.join(ROOT, 'export', 'little-steps-demo.html'); assert.ok(fs.existsSync(target));
  const html = fs.readFileSync(target), server = require('node:http').createServer((request, response) => {
    if (request.url === '/offline.html') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html); }
    else { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = 'http://127.0.0.1:' + server.address().port + '/offline.html', attempted = [];
  const intercept = async request => {
    if (/^https?:/.test(request.url()) && request.url() !== url) {
      if (!request.url().endsWith('/favicon.ico')) attempted.push({ url: request.url(), type: request.resourceType() });
      await request.abort('internetdisconnected');
    } else await request.continue();
  };
  await page.setRequestInterception(true); page.on('request', intercept);
  try {
    await check('The exported HTML served over HTTP still stays explicitly local, persists the farm loop and sends no XHR/assets', async () => {
      report.exportHash = sha('export/little-steps-demo.html');
      await page.goto(url, { waitUntil: 'load' }); await page.waitForFunction(() => window.FamilyDemo && window.FamilyDemo.getUI().farmStatus);
      assert.equal((await ui(page)).connected, false); assert.match(await page.$eval('body', node => node.textContent), /离线|本机/);
      await sceneReady(page); await click(page, action('farm-start')); await settled(page);
      await click(page, action('farm-harvest')); await settled(page); assert.equal((await farm(page)).inventory.carrot, 3);
      await itemPage(page, 'flowerpot'); await click(page, action('farm-exchange', 'flowerpot')); await settled(page);
      await click(page, action('farm-place', 'flowerpot')); await settled(page);
      await home(page); await click(page, action('farm-seeds')); await click(page, action('farm-crop', 'strawberry')); await click(page, action('farm-plant')); await settled(page);
      const saved = await state(page); assert.equal(saved.farm.placements.entry, 'flowerpot');
      await page.reload({ waitUntil: 'load' }); await page.waitForFunction(() => window.FamilyDemo);
      assert.deepEqual(await state(page), saved); assert.equal((await ui(page)).connected, false);
      assert.deepEqual(attempted, []); assert.equal((await ledger(page)).earned, 128);
      await screenshot(page, 'offline-http-local-loop');
    });
  } finally {
    page.off('request', intercept); await page.setRequestInterception(false);
    await new Promise(resolve => { server.close(resolve); if (server.closeAllConnections) server.closeAllConnections(); });
  }
}

async function liveReadOnly(env, page) {
  const url = process.env.V12_LIVE_URL || 'http://127.0.0.1:4178';
  assert.equal(new URL(url).origin, 'http://127.0.0.1:4178', 'Live evidence is restricted to the explicitly authorized service');
  const blockedWrites = [], resources = [];
  report.live = { url, mode: 'GET-only; no economic, PIN or family data writes', blockedWrites, resources };
  const guard = async request => {
    if (!['GET', 'HEAD'].includes(request.method())) { blockedWrites.push({ method: request.method(), path: new URL(request.url()).pathname }); await request.abort('blockedbyclient'); }
    else await request.continue();
  };
  await page.setCacheEnabled(false); await page.setRequestInterception(true); page.on('request', guard);
  try {
    await check('The actual 4178 entry serves current farm resources and renders with every write blocked', async () => {
      for (const file of ['app.js', 'farm-ui.js', 'farm.css', 'farm-scene.js']) {
        const response = await fetch(url + '/' + file, { cache: 'no-store' });
        const body = Buffer.from(await response.arrayBuffer()), hash = crypto.createHash('sha256').update(body).digest('hex');
        resources.push({ file, status: response.status, bytes: body.length, sha256: hash });
        assert.equal(response.status, 200, file + ' must be served by the real backend'); assert.equal(hash, sha(file), file + ' must be current, not a stale served version');
      }
      for (const [label, width, height] of [['desktop', 1024, 768], ['phone', 390, 844]]) {
        await page.setViewport({ width, height, deviceScaleFactor: 1 }); await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction(() => window.FamilyDemo && window.FamilyDemo.getUI().connected, { timeout: 15000 }); await sceneReady(page);
        await screenshot(page, 'live-' + label + '-home');
        const liveFarm = (await state(page)).farm;
        if (liveFarm && liveFarm.initialized) {
          await click(page, action('farm-open')); await farmView(page, 'yard'); await sceneReady(page); await B.delay(200);
          await screenshot(page, 'live-' + label + '-expanded');
        } else report.live.expandedSkipped = 'The live family has not started its farm; the QA does not start it or change its data.';
      }
      assert.deepEqual(blockedWrites, [], 'Read-only entry/navigation must not attempt a write');
    });
  } finally { page.off('request', guard); await page.setRequestInterception(false); }
}

async function run() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  try {
    browser = await B.launch();
    await group('loop', mainLoop);
    await group('plots', individualPlots, { fixture: 'rich' });
    await group('exchange', exchangeAndHouse, { fixture: 'rich' });
    await group('insufficient', insufficient);
    await group('care', careAndCollection, { fixture: 'started' });
    await group('sync', synchronization);
    await group('lost-response', lostResponse);
    await group('cross-harvest', crossHarvestReceipt, { fixture: 'mixed' });
    await group('clock-sample', clockSamples);
    await group('business', business);
    await group('layout', layouts);
    await group('renderer', renderer, { width: 1024, height: 768 });
    await group('camera', cameraBrowsing, { fixture: 'showcase', width: 1024, height: 768 });
    await group('visual', visualSamples, { fixture: 'showcase', width: 1024, height: 768 });
    await group('touch', touchInput);
    await group('offline', offline, { offline: true });
    await group('offline-http', offlineHttp, { offline: true });
    if (ONLY.includes('live') || process.env.V12_LIVE === '1') await group('live', liveReadOnly, { realClock: true });
  } catch (error) { report.failure = error.stack; console.error(error); }
  finally {
    if (browser) await browser.close();
    report.finishedAt = new Date().toISOString(); report.finalSourceHashes = hashes();
    report.sourceStable = JSON.stringify(report.sourceHashes) === JSON.stringify(report.finalSourceHashes);
    report.passed = report.groups.filter(row => row.result === 'passed').length; report.failed = report.groups.filter(row => row.result === 'failed').length;
    const suffix = ONLY.length ? '-probe-' + ONLY.join('-').replace(/[^a-z0-9-]/gi, '') : '-results';
    fs.writeFileSync(path.join(ARTIFACTS, PREFIX + suffix + '.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(report.passed + ' groups passed; ' + report.failed + ' failed; ' + report.checks.length + ' checks; ' + report.layouts.length + ' layouts.');
    if (report.failure || report.failed || report.errors.length) process.exitCode = 1;
  }
}
module.exports = { fixture, run };
if (require.main === module) run();
