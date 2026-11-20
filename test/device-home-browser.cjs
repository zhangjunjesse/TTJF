'use strict';

// One bounded group per process, using synthetic users and a fresh SQLite file.
// DEVICE_HOME_CASE=phone|phone-landscape|desktop-screen|tablet|preferences|storage
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Q = require('./saas-browser.cjs');
const { B, action: a, click, ui, snapshot } = Q;
const CASE = process.env.DEVICE_HOME_CASE || 'phone';
const CASES = ['phone', 'phone-landscape', 'desktop-screen', 'tablet', 'preferences', 'storage'];
assert.ok(CASES.includes(CASE), 'Unknown DEVICE_HOME_CASE');
const KEY = 'ttjf-device-home-v1';
const SOURCES = ['test/device-home-browser.cjs', 'test/browser.cjs', 'test/saas-browser.cjs',
  'home-points.js', 'home-points.css', 'app.js', 'farm-ui.js', 'world-ui.js', 'farm-world.css', 'styles.css', 'index.html'];
const hashes = () => Object.fromEntries(SOURCES.map(file => [file,
  crypto.createHash('sha256').update(fs.readFileSync(path.join(Q.ROOT, file))).digest('hex')]));
const email = 'device-home-' + CASE + '-' + Q.RUN + '@example.test';
const report = Q.report.deviceHome = { case: CASE, sourceHashes: hashes(), diagnostics: [] };
let env, page, familyId;
const deviceSessions = new WeakMap();

function progress(message) {
  fs.mkdirSync(Q.OUT, { recursive: true });
  fs.writeFileSync(path.join(Q.OUT, 'device-home-progress.json'), JSON.stringify({
    at: new Date().toISOString(), case: CASE, message, checks: Q.report.checks, deviceHome: report
  }, null, 2) + '\n');
}
async function check(label, fn) {
  progress(label); await Q.check(label, fn); progress('Completed: ' + label);
}
const sql = async () => (await env.database.query('SELECT revision,state FROM saas_families WHERE id=$1', [familyId])).rows[0];
const preference = target => target.evaluate(key => localStorage.getItem(key), KEY);
const preferenceWrites = target => target.evaluate(key => window.__qaStorage.events.filter(row => row.op === 'set' && row.key === key), KEY);

async function metrics(target, width, height, screenWidth, screenHeight) {
  // Detaching clears emulated screen dimensions. Keep this target's session
  // until its browser context closes, and verify the browser applied the input.
  let session = deviceSessions.get(target);
  if (!session) { session = await target.createCDPSession(); deviceSessions.set(target, session); }
  await session.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false, screenWidth, screenHeight
  });
  const actual = await target.evaluate(() => ({ width: innerWidth, height: innerHeight, screenWidth: screen.width, screenHeight: screen.height }));
  assert.deepEqual(actual, { width, height, screenWidth, screenHeight }, 'the browser applies the requested viewport and device screen');
  (report.metrics ||= []).push(actual);
}
async function mode(expected, target = page) {
  await target.waitForFunction(value => document.querySelector('#main [data-home-mode]')?.dataset.homeMode === value,
    { timeout: 6000 }, expected);
  const choices = await target.$$eval('[data-action="home-view"]', nodes => nodes.map(node => ({
    id: node.dataset.id, pressed: node.getAttribute('aria-pressed')
  })));
  assert.deepEqual(choices.map(choice => choice.id).sort(), ['companion', 'points']);
  choices.forEach(choice => assert.equal(choice.pressed, String(choice.id === expected), 'the displayed view has the selected toggle'));
}
async function noPetRenderer(target = page) {
  await target.waitForFunction(() => {
    const farm = window.FamilyFarmUI?.diagnostics(), scene = window.FamilyFarmScene?.diagnostics();
    return farm && farm.renderer === null && (!scene || scene.instances.length === 0);
  }, { timeout: 7000 });
  assert.equal(await target.$('#main .pet-home-stage, #main canvas.family-farm-canvas'), null,
    'points home has no hidden pet scene or WebGL canvas');
  const d = await target.evaluate(() => ({ farm: window.FamilyFarmUI.diagnostics(), scene: window.FamilyFarmScene?.diagnostics() || null,
    viewport: { width: innerWidth, height: innerHeight, screenWidth: screen.width, screenHeight: screen.height } }));
  report.diagnostics.push({ mode: 'points', ...d });
}
async function companionRenderer(target = page) {
  await target.waitForFunction(() => {
    const r = window.FamilyFarmUI?.diagnostics().renderer;
    return r && r.ready && r.webgl && r.drawCalls > 0;
  }, { timeout: 10000 });
  const d = await target.evaluate(() => ({ farm: window.FamilyFarmUI.diagnostics(), scene: window.FamilyFarmScene.diagnostics() }));
  assert.equal(d.scene.instances.length, 1, 'companion home has exactly one actual renderer');
  assert.ok(d.scene.activeCount <= 1);
  report.diagnostics.push({ mode: 'companion', ...d });
}
async function unchanged(before, marker, label, target = page) {
  assert.deepEqual(await sql(), before, label + ': full stored state and revision');
  assert.deepEqual(await snapshot(target), before.state, label + ': browser family state');
  assert.deepEqual(env.calls.slice(marker).filter(call => !['GET', 'HEAD'].includes(call.method)), [],
    label + ': view controls make no API mutations or authorization requests');
}
async function reload(target = page) {
  await target.reload({ waitUntil: 'load' });
  await target.waitForFunction(() => {
    const s = window.FamilySaas?.status(); return s && (s.ready || s.view === 'families');
  });
  if ((await Q.status(target)).view === 'families') await click(target, Q.sa('select-family', familyId));
  await Q.ready(target, familyId); await Q.home(target);
}
async function saveDefault(target = page) {
  await click(target, a('preferences'));
  await click(target, a('home-default'));
  await Q.home(target);
}
async function pointsControls() {
  const actions = [a('home-view', 'points'), a('home-view', 'companion'),
    a('add-points'), a('jump-rewards'), a('records'), a('preferences')];
  const measured = [];
  for (const selector of [...actions, a('home-week')]) measured.push({ selector, targets: await B.metrics(page, selector) });
  report.pointsControls = measured; progress('Measured points-home controls');
  for (const selector of actions) {
    const targets = measured.find(entry => entry.selector === selector).targets;
    assert.ok(targets.some(target => target.width >= 47.9 && target.height >= 47.9 && target.inViewport && target.reachable),
      'a 48px points-home action is reachable initially: ' + JSON.stringify({ selector, targets }));
  }
  // The lightweight home may scroll. Its seven-day section remains reachable
  // through a native scroll, while the primary points actions fit initially.
  await page.$eval(a('home-week'), node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const week = await B.reachable(page, a('home-week'));
  assert.ok(week.every(target => target.width >= 47.9 && target.height >= 47.9), '48px seven-day entry: ' + JSON.stringify(week));
  await page.$eval('.app-main', node => { node.scrollTop = 0; });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'points home has no horizontal overflow');
  assert.equal(await page.$eval('[data-testid="earned-points"]', node => Number(node.textContent)), 0);
  assert.equal(await page.$eval('[data-testid="available-points"]', node => Number(node.textContent)), 0);
}
async function setup() {
  Q.phase('device-home-' + CASE); progress('Creating isolated SQLite fixture');
  env = await Q.initialize(); env.clock(Date.parse('2026-11-20T04:30:00Z'));
  const tablet = CASE === 'tablet', landscape = CASE === 'phone-landscape';
  const width = tablet ? 768 : landscape ? 1024 : 390, height = tablet ? 1024 : landscape ? 430 : 844;
  page = await env.newPage({ width, height, controlledClock: true, storageUnavailable: CASE === 'storage' }); Q.active(page);
  page.setDefaultTimeout(6000);
  // Plain Puppeteer reports an 800x600 desktop screen even at phone viewports.
  // Keep that real value in its own group; use actual device dimensions elsewhere.
  if (CASE !== 'desktop-screen') await metrics(page, width, height, width, height);
  await Q.registerAndVerify(page, email);
  familyId = await Q.createFamily(page, '合成首页设备-' + CASE, '合成设备宝');
  await Q.home(page); progress('Fixture ready');
}

async function phone() {
  await check('A fresh phone starts with points and has reachable points actions without a pet renderer', async () => {
    await mode('points'); await noPetRenderer(); await pointsControls();
    assert.equal(await preference(page), null); assert.deepEqual(await preferenceWrites(page), []);
    await Q.shot(page, CASE + '-points-default');
  });
  if (CASE === 'phone') await check('An authenticated cold points home does not request the scene bundle', async () => {
    const cold = await env.newPage({ context: page.browserContext(), width: 390, height: 844, controlledClock: true });
    const requests = [];
    cold.on('request', request => { if (new URL(request.url()).pathname.endsWith('/farm-scene.js')) requests.push(request.url()); });
    await metrics(cold, 390, 844, 390, 844);
    try {
      await cold.goto(env.origin, { waitUntil: 'load' }); await Q.ready(cold, familyId);
      await mode('points', cold); await noPetRenderer(cold); await B.delay(250);
      assert.deepEqual(requests, [], 'the lightweight points home does not download the 3D scene bundle');
      report.coldHome = { sceneBundleRequests: requests.length };
    } finally { await cold.close(); }
  });
  await check('A temporary companion choice survives rotation and resize but does not become a refresh default', async () => {
    const before = await sql(), marker = env.calls.length;
    await B.homeView(page, 'companion'); await mode('companion'); await companionRenderer();
    await metrics(page, 844, 390, 844, 390); await mode('companion');
    await metrics(page, 768, 1024, 390, 844); await mode('companion');
    assert.equal(await preference(page), null); assert.deepEqual(await preferenceWrites(page), []);
    await metrics(page, 390, 844, 390, 844); await reload();
    await mode('points'); await noPetRenderer(); assert.equal(await preference(page), null);
    await unchanged(before, marker, 'temporary view and viewport changes');
  });
  await check('The seven-day summary opens through the points home and does not modify the family', async () => {
    const before = await sql(), marker = env.calls.length;
    await click(page, a('home-week'));
    await page.waitForSelector('.sheet');
    assert.match(await page.$eval('.sheet', node => node.textContent), /近\s*7|最近\s*7|近七|小结/);
    assert.notEqual((await ui(page)).form, null, 'the summary has a readable detail panel');
    await Q.shot(page, CASE + '-seven-day-details'); await Q.home(page); await mode('points');
    await unchanged(before, marker, 'seven-day detail');
  });
}
async function landscape() {
  await check('A phone first loaded in landscape still starts with points and keeps it when rotated', async () => {
    const before = await sql(), marker = env.calls.length;
    await mode('points'); await noPetRenderer(); await pointsControls();
    await Q.shot(page, 'phone-landscape-points-default');
    await metrics(page, 390, 844, 390, 844); await mode('points');
    await reload(); await mode('points'); await noPetRenderer();
    assert.equal(await preference(page), null); assert.deepEqual(await preferenceWrites(page), []);
    await unchanged(before, marker, 'initial landscape classification');
  });
}
async function tablet() {
  await check('An iPad starts with its actual companion and a temporary points choice survives rotation', async () => {
    const before = await sql(), marker = env.calls.length;
    await mode('companion'); await companionRenderer();
    assert.equal(await preference(page), null);
    await Q.shot(page, 'ipad-companion-default');
    await B.homeView(page, 'points'); await mode('points'); await noPetRenderer();
    await metrics(page, 1024, 768, 1024, 768); await mode('points');
    await metrics(page, 390, 844, 768, 1024); await mode('points');
    assert.deepEqual(await preferenceWrites(page), []);
    await metrics(page, 768, 1024, 768, 1024); await reload();
    await mode('companion'); await companionRenderer();
    await unchanged(before, marker, 'iPad default and temporary choice');
  });
}
async function preferences() {
  await check('Only the explicit device-default action persists the current view across refresh', async () => {
    const before = await sql(), marker = env.calls.length;
    await mode('points'); await B.homeView(page, 'companion');
    assert.equal(await preference(page), null); assert.deepEqual(await preferenceWrites(page), []);
    await saveDefault(); assert.equal(await preference(page), 'companion');
    assert.ok((await preferenceWrites(page)).length >= 1);
    await reload(); await mode('companion'); await companionRenderer();
    await unchanged(before, marker, 'explicit local default');
  });
  const other = await env.newPage({ width: 768, height: 1024, controlledClock: true });
  await metrics(other, 768, 1024, 768, 1024);
  await other.goto(env.origin, { waitUntil: 'load' }); await Q.waitView(other, 'login');
  await Q.login(other, email, Q.PASSWORD, familyId); await Q.ready(other, familyId); await Q.home(other);
  await check('The same family on another device has an independent local default', async () => {
    const before = await sql(), marker = env.calls.length;
    await mode('companion', other); assert.equal(await preference(other), null, 'the first device preference is not copied with the account');
    await B.homeView(other, 'points'); await saveDefault(other); assert.equal(await preference(other), 'points');
    await reload(other); await mode('points', other); await noPetRenderer(other);
    await reload(); await mode('companion'); assert.equal(await preference(page), 'companion');
    await unchanged(before, marker, 'second device default', other);
    const events = await other.evaluate(() => window.__qaStorage.events.filter(row => row.op === 'set'));
    assert.ok(events.every(row => row.key === KEY || row.key === 'ttjf-saas-auth-change-v1'), 'only the enum preference or anonymous auth signal may persist');
  });
  await check('Restoring automatic selection affects the next visit and leaves the other device default intact', async () => {
    const before = await sql(), marker = env.calls.length;
    await click(page, a('preferences')); await click(page, a('home-auto')); await Q.home(page);
    assert.equal(await preference(page), null); await mode('companion');
    await reload(); await mode('points'); await noPetRenderer();
    assert.equal(await preference(other), 'points'); await mode('points', other);
    await unchanged(before, marker, 'restore automatic device selection');
  });
}
async function storage() {
  await check('Blocked browser storage still permits temporary views and refresh restores the phone default', async () => {
    const before = await sql(), marker = env.calls.length;
    await mode('points'); await noPetRenderer();
    await B.homeView(page, 'companion'); await mode('companion');
    await saveDefault(); await mode('companion');
    await reload(); await mode('points'); await noPetRenderer();
    await unchanged(before, marker, 'unavailable preference storage');
  });
}
async function run() {
  Q.report.boundaries.push('Device home tests use isolated desktop Chromium contexts and explicit viewport/screen metrics; physical iPad/Safari and OS rotation remain unverified.');
  let deadline;
  try {
    await Promise.race([(async () => {
      await setup();
      await ({ phone, 'desktop-screen': phone, 'phone-landscape': landscape, tablet, preferences, storage })[CASE]();
      assert.deepEqual(Q.report.pageErrors, []);
      assert.deepEqual(hashes(), report.sourceHashes, 'sources changed during device-home evidence run');
      progress('Case complete');
    })(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('device-home group exceeded 50 seconds')), 50000); })]);
  } finally { clearTimeout(deadline); }
}
Q.execute(run);
