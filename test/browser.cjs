'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
let puppeteer;
try { puppeteer = require('puppeteer-core'); }
catch (_) { puppeteer = require('../../_screenshot-tools/node_modules/puppeteer-core'); }
const { createServer } = require('../server.cjs');
const Model = require('../model.js');
const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = process.env.TEST_ARTIFACT_DIR ? path.resolve(process.env.TEST_ARTIFACT_DIR) : path.join(ROOT, 'artifacts');
const PIN = '246810'; // Test-only server fixture; never supplied by the product UI.
const FIXTURE_TIME = new Date(2026, 10, 15, 12, 30).getTime();
const VIEWPORTS = [
  ['desktop', 1440, 1000], ['ipad-landscape', 1024, 768],
  ['ipad-portrait', 768, 1024], ['phone', 390, 844], ['small-phone', 320, 568]
];
const SELECTORS = {
  nav: '.bottom-nav [data-action="nav"]',
  submit: '.sheet-save[type="submit"][form="editor-form"]',
  verify: '#parent-form button[type="submit"]',
  close: '.sheet-header button[data-action="form-close"]',
  answer: '#parent-form [name="answer"]'
};
const delay = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
const action = (name, id) => 'button[data-action="' + name + '"]' + (id === undefined ? '' : '[data-id="' + id + '"]');

async function homeView(page, mode) {
  assert.ok(['points', 'companion'].includes(mode), 'Unknown home view');
  const selector = '#main [data-home-mode]';
  await page.waitForSelector(selector);
  if (await page.$eval(selector, node => node.dataset.homeMode) !== mode) {
    await click(page, action('home-view', mode));
  }
  await page.waitForFunction(expected => document.querySelector('#main [data-home-mode]')?.dataset.homeMode === expected,
    { timeout: 6000 }, mode);
}

async function launch() {
  return puppeteer.launch({
    executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, protocolTimeout: 30000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']
  });
}
async function createEnvironment(browser, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'family-v3-qa-'));
  let now = options.now || FIXTURE_TIME;
  const dataFile = path.join(directory, 'state.json');
  if (options.state) { fs.writeFileSync(dataFile, JSON.stringify({ revision: 1, state: options.state })); }
  const server = createServer({ dataFile, parentPin: PIN, now: () => new Date(now),
    ...(options.assistantService ? { assistantService: options.assistantService } : {}) });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const context = await browser.createBrowserContext();
  const url = 'http://127.0.0.1:' + server.address().port;
  const errors = [], requests = [], clockScripts = new Map();
  async function installClock(page) {
    const script = await page.evaluateOnNewDocument(milliseconds => {
      const NativeDate = window.Date;
      let current = milliseconds;
      class ControlledDate extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [current])); }
        static now() { return current; }
      }
      window.Date = ControlledDate;
      window.__qaSetTime = value => { current = value; };
    }, now);
    clockScripts.set(page, script.identifier);
  }
  async function newPage(viewport = { width: 390, height: 844 }) {
    const page = await context.newPage();
    await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/')) {
        let body = null; try { body = JSON.parse(request.postData()); } catch (_) { /* no JSON body */ }
        requests.push({ path: new URL(request.url()).pathname, body });
      }
    });
    await installClock(page);
    return page;
  }
  async function load(page) {
    await page.goto(url, { waitUntil: 'load' });
    await connected(page);
    return page;
  }
  async function clock(milliseconds) {
    now = milliseconds;
    for (const page of await context.pages()) {
      if (clockScripts.has(page)) { await page.removeScriptToEvaluateOnNewDocument(clockScripts.get(page)); }
      await installClock(page);
      await page.evaluate(value => { if (window.__qaSetTime) { window.__qaSetTime(value); } }, now);
    }
  }
  async function api(endpoint, payload) {
    const response = await fetch(url + endpoint, payload === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    return { status: response.status, body: await response.json() };
  }
  async function authorize(input) {
    const snapshot = (await api('/api/state')).body;
    const challenge = await api('/api/parent/challenge', { revision: snapshot.revision, action: input });
    assert.equal(challenge.status, 200, JSON.stringify(challenge.body));
    assert.equal(challenge.body.method, 'pin', 'fixture authorization expects PIN mode');
    const verified = await api('/api/parent/verify', { challengeId: challenge.body.challengeId, answer: PIN });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    const saved = await api('/api/action', { revision: snapshot.revision, action: input, grant: verified.body.grant });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    return saved.body;
  }
  async function close() {
    await context.close();
    if (server.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    // Verify the exact cleanup target before removing any temporary files.
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('family-v3-qa-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
  return { url, errors, requests, newPage, load, clock, api, authorize, close, directory };
}
async function visibleHandle(page, selector) {
  await page.waitForSelector(selector, { timeout: 6000 });
  const handles = await page.$$(selector);
  let selected;
  for (const handle of handles) {
    const visible = await handle.evaluate(element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    if (visible && !selected) { selected = handle; } else { await handle.dispose(); }
  }
  assert.ok(selected, 'Missing visible element: ' + selector);
  return selected;
}
// Every button activation uses a real mouse at a hit-tested point. Never use
// element.click(), which can silently bypass another element covering a control.
async function click(page, selector, options = {}) {
  const handle = await visibleHandle(page, selector);
  try {
    if (options.scroll !== false) {
      await handle.evaluate(element => element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }));
      await delay(40);
    }
    const target = await handle.evaluate(element => {
      const r = element.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, width: innerWidth, height: innerHeight, disabled: !!element.disabled,
        reachable: !!hit && (hit === element || element.contains(hit)), hit: hit && hit.tagName + '.' + hit.className };
    });
    assert.equal(target.disabled, false, selector + ' is disabled');
    assert.ok(target.x >= 0 && target.x < target.width && target.y >= 0 && target.y < target.height,
      selector + ' outside viewport: ' + JSON.stringify(target));
    assert.ok(target.reachable, selector + ' obscured: ' + JSON.stringify(target));
    await page.mouse.click(target.x, target.y, { clickCount: options.clickCount || 1 });
    await delay(options.delay === undefined ? 120 : options.delay);
  } finally { await handle.dispose(); }
}
async function fill(page, selector, value) {
  await page.waitForSelector(selector);
  // Assign date/time/select values portably. This dispatches the same draft input
  // listeners; buttons and the keyboard-return scenario are real input events.
  await page.$eval(selector, (element, input) => {
    element.value = String(input);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}
async function fillForm(page, values) {
  for (const [name, value] of Object.entries(values)) { await fill(page, '#editor-form [name="' + name + '"]', value); }
}
const state = page => page.evaluate(() => window.FamilyDemo.getState());
const ui = page => page.evaluate(() => window.FamilyDemo.getUI());
const totals = async page => Model.totals(await state(page));
async function connected(page) {
  await page.waitForFunction(() => window.FamilyDemo && window.FamilyDemo.getUI().connected, { timeout: 10000 });
}
async function navigate(page, view) {
  await click(page, '.bottom-nav ' + action('nav', view), { scroll: false });
  await page.waitForFunction(expected => window.FamilyDemo.getUI().view === expected, {}, view);
}
async function closeSheet(page) { await click(page, SELECTORS.close, { scroll: false }); }
async function noSheet(page) { await page.waitForSelector('.sheet-overlay', { hidden: true, timeout: 6000 }); }
async function confirmPoints(page) {
  if ((await ui(page)).authPhase === 'confirm') await click(page, action('points-confirm'), { scroll: false });
}
async function verify(page, answer = PIN) {
  await confirmPoints(page);
  await page.waitForSelector(SELECTORS.answer);
  await fill(page, SELECTORS.answer, answer);
  await click(page, SELECTORS.verify, { scroll: false });
}
async function submitProtected(page, answer = PIN) {
  await click(page, SELECTORS.submit, { scroll: false });
  await verify(page, answer);
}
async function openCredit(page, values = {}) {
  await click(page, action('add-points'));
  await click(page, action('points-new'));
  await fillForm(page, { name: '认真阅读', points: 5, reason: '主动分享今天读到的故事', ...values });
}
async function capture(page, name, version = 'v3') {
  assert.match(version, /^v\d+(?:-[a-z]+)?$/);
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: path.join(ARTIFACTS, version + '-' + name + '.png'), fullPage: false });
}
async function metrics(page, selector) {
  return page.$$eval(selector, elements => elements.map(element => {
    const r = element.getBoundingClientRect(), style = getComputedStyle(element);
    if (!r.width || !r.height || style.display === 'none' || style.visibility === 'hidden') { return null; }
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { text: element.textContent.trim(), left: r.left, top: r.top, right: r.right, bottom: r.bottom,
      width: r.width, height: r.height,
      inViewport: r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
      reachable: !!hit && (hit === element || element.contains(hit)) };
  }).filter(Boolean));
}
async function reachable(page, selector) {
  const found = await metrics(page, selector);
  assert.ok(found.length, 'Missing visible control: ' + selector);
  for (const item of found) {
    assert.ok(item.inViewport, selector + ' clipped: ' + JSON.stringify(item));
    assert.ok(item.reachable, selector + ' obscured: ' + JSON.stringify(item));
  }
  return found;
}
async function bounded(page, label) {
  const dimensions = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight, htmlWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth, htmlHeight: document.documentElement.scrollHeight,
    bodyHeight: document.body.scrollHeight, scrollX, scrollY
  }));
  assert.ok(dimensions.htmlWidth <= dimensions.width + 1 && dimensions.bodyWidth <= dimensions.width + 1,
    label + ' horizontal overflow: ' + JSON.stringify(dimensions));
  return { label, ...dimensions };
}
async function sheet(page, label) {
  await page.waitForSelector('.sheet[role="dialog"][aria-modal="true"]');
  const visible = await metrics(page, '.sheet[role="dialog"]');
  assert.equal(visible.length, 1, 'only the top dialog is visible');
  assert.ok(visible[0].inViewport, label + ' dialog clipped: ' + JSON.stringify(visible[0]));
  await reachable(page, '.sheet-header button');
  return bounded(page, label);
}

async function runSuite() {
  const requested = process.env.V3_GROUPS ? process.env.V3_GROUPS.split(',') : null;
  const report = {
    browser: 'Microsoft Edge / Chromium, headless, real DOM and hit-tested mouse coordinates',
    deviceBoundary: 'No iPad mini 4 / iPadOS 15.8.7 hardware or Safari test was performed. Viewport emulation is not Safari/device validation.',
    assistantBoundary: 'Local instruction demonstration only; no real LLM, microphone recording, wake word or background push claim.',
    timingBoundary: 'Reminder UI and real five-second foreground timers are exercised with an accelerated, fixed test clock; no ten-minute wall-clock or eight-hour device soak was performed.',
    keyboardBoundary: 'Desktop Tab/Escape and phone-sized viewports only; the iPad software keyboard has not been tested.',
    audioBoundary: 'WAV resources and format are checked; actual audible playback and microphone capture have not been verified.',
    command: 'node test/browser.cjs', groupsRequested: requested || 'all', startedAt: new Date().toISOString(),
    sourceHashes: Object.fromEntries(['app.js', 'model.js', 'server.cjs', 'assistant.js', 'styles.css', 'index.html'].map(name =>
      [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, name))).digest('hex')])),
    exportHash: fs.existsSync(path.join(ROOT, 'export', 'little-steps-demo.html')) ?
      crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'export', 'little-steps-demo.html'))).digest('hex') : null,
    passed: 0, checks: [], failed: [], errors: [], layouts: [], skipped: []
  };
  let browser, currentPage, groupName;
  async function check(label, operation) {
    try { await operation(); report.passed++; report.checks.push({ group: groupName, label }); console.log('PASS ' + groupName + ': ' + label); }
    catch (error) { error.check = label; throw error; }
  }
  async function group(name, operation) {
    if (requested && !requested.includes(name)) { return; }
    groupName = name;
    const env = await createEnvironment(browser);
    try {
      currentPage = await env.newPage();
      await env.load(currentPage);
      await operation(env, currentPage, check, report);
      assert.deepEqual(env.errors, [], 'No uncaught browser errors');
    } catch (error) {
      report.failed.push({ group: name, check: error.check || 'group setup', message: error.message, stack: error.stack });
      console.error('FAIL ' + name + ': ' + error.message);
      if (currentPage && !currentPage.isClosed()) { await capture(currentPage, name + '-failure').catch(() => {}); }
    } finally { report.errors.push(...env.errors); await env.close(); currentPage = null; }
  }
  try {
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    browser = await launch();
    await group('layout', async (env, page, check) => {
      await check('Seed ledger and manifest/icon metadata remain valid', async () => {
        assert.deepEqual(await totals(page), { earned: 128, spent: 40, available: 88 });
        const manifestURL = await page.$eval('link[rel="manifest"]', link => link.href);
        const response = await fetch(manifestURL);
        assert.equal(response.status, 200);
        const manifest = await response.json();
        assert.equal(manifest.display, 'standalone');
        for (const size of [192, 512]) {
          const icon = manifest.icons.find(item => item.sizes === size + 'x' + size);
          assert.ok(icon);
          const resource = await fetch(new URL(icon.src, manifestURL));
          assert.equal(resource.status, 200);
          const bytes = Buffer.from(await resource.arrayBuffer());
          assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
          assert.equal(bytes.readUInt32BE(16), size); assert.equal(bytes.readUInt32BE(20), size);
        }
      });
      await check('A seeded quick-award template previews an editable specific reason without immediately writing the ledger', async () => {
        const before = await totals(page);
        const item = (await state(page)).pointItems.find(entry => entry.id === 'point-reading');
        assert.ok(item.reason && item.reason.length > 8, 'The demo preset must contain a concrete candidate reason');
        await click(page, action('choose-point', item.id));
        assert.equal(await page.$eval('[name="reason"]', element => element.value), item.reason);
        assert.equal(Number(await page.$eval('[name="points"]', element => element.value)), item.points);
        await fillForm(page, { reason: '家长核对后改成这次实际发生的情况' });
        assert.deepEqual(await totals(page), before);
        assert.equal(env.requests.filter(entry => entry.path === '/api/action').length, 0);
        await closeSheet(page); await noSheet(page);
      });
      for (const [name, width, height] of VIEWPORTS) {
        await page.setViewport({ width, height, deviceScaleFactor: 1 });
        await delay();
        await check(name + ': exactly two fixed tabs and reachable points/reminder controls, no horizontal body overflow', async () => {
          for (const view of ['points', 'reminders']) {
            await navigate(page, view);
            const nav = await reachable(page, SELECTORS.nav);
            assert.equal(nav.length, 2);
            assert.deepEqual(nav.map(item => item.text), ['首页', '提醒']);
            report.layouts.push(await bounded(page, name + '-' + view));
            await reachable(page, view === 'points' ? action('add-points') : action('task-new'));
            await capture(page, name + '-' + view);
            if (view === 'points' && width <= 390) {
              await reachable(page, action('jump-rewards'));
              await click(page, action('jump-rewards'), { scroll: false });
              assert.equal(await page.evaluate(() => document.activeElement.id), 'rewards-section');
              await click(page, action('redeem', 'reward-pencil'));
              assert.equal((await ui(page)).form, 'request');
              await closeSheet(page); await noSheet(page);
              await capture(page, name + '-gift-entry');
              await navigate(page, 'points');
            }
            if (view === 'reminders') {
              const wrapped = await page.$$eval('.day-tabs .day-tab', elements => elements.filter(element => {
                const text = Array.from(element.childNodes).find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
                if (!text) { return false; }
                const range = document.createRange(); range.selectNodeContents(text);
                return range.getClientRects().length > 1;
              }).map(element => element.textContent));
              assert.deepEqual(wrapped, [], 'The Chinese day label must fit on one line');
            }
          }
        });
        await check(name + ': creation sheet close and primary submit remain reachable', async () => {
          await click(page, action('task-new'));
          report.layouts.push(await sheet(page, name + '-task-sheet'));
          await reachable(page, SELECTORS.submit);
          await closeSheet(page);
          await noSheet(page);
        });
      }
    });
    await group('points', async (env, page, check) => {
      await check('Unverified and wrong-PIN submissions preserve the ledger; cancel/change never reuse authorization', async () => {
        const before = await totals(page);
        await openCredit(page);
        await click(page, SELECTORS.submit, { scroll: false });
        await confirmPoints(page);
        await page.waitForSelector(SELECTORS.answer);
        assert.deepEqual(await totals(page), before);
        assert.deepEqual(Model.totals((await env.api('/api/state')).body.state), before);
        await verify(page, '000000');
        assert.ok(await page.$('#parent-form'));
        assert.deepEqual(await totals(page), before);
        await capture(page, 'pin-wrong');
        await click(page, action('parent-cancel'), { scroll: false });
        await fillForm(page, { points: 7, reason: '自己把书包收好了' });
        await click(page, SELECTORS.submit, { scroll: false });
        await confirmPoints(page);
        const challenges = env.requests.filter(item => item.path === '/api/parent/challenge');
        assert.equal(challenges.length, 2, 'cancelled verification must request a new operation-bound challenge');
        assert.notDeepEqual(challenges[0].body.action, challenges[1].body.action);
        assert.deepEqual(await totals(page), before);
        await verify(page);
        await noSheet(page);
        assert.equal((await totals(page)).earned, before.earned + 7);
        assert.equal((await state(page)).points.filter(row => row.reason === '自己把书包收好了').length, 1);
      });
      await check('The next intentional award again requires verification and no global parent unlock remains', async () => {
        const before = await totals(page);
        await openCredit(page, { reason: '第二笔也要独立核验' });
        await click(page, SELECTORS.submit, { scroll: false });
        await confirmPoints(page);
        await page.waitForSelector(SELECTORS.answer);
        assert.deepEqual(await totals(page), before);
        await capture(page, 'points-second-verification');
        await verify(page);
        await noSheet(page);
        assert.equal((await totals(page)).earned, before.earned + 5);
        const writes = env.requests.filter(item => item.path === '/api/action' && item.body.action.type === 'points.add');
        assert.equal(writes.length, 2);
        assert.ok(writes[0].body.grant && writes[1].body.grant);
        assert.notEqual(writes[0].body.grant, writes[1].body.grant);
        assert.notEqual(writes[0].body.action.id, writes[1].body.action.id);
      });
    });
    await group('authorization', async (env, page, check) => {
      await check('Cancel while verification is in flight discards its late grant, including after opening another operation', async () => {
        const before = await totals(page);
        let held = null;
        const intercept = request => {
          if (new URL(request.url()).pathname === '/api/parent/verify') { held = request; }
          else { request.continue(); }
        };
        await page.setRequestInterception(true); page.on('request', intercept);
        try {
          await openCredit(page, { reason: '取消的迟到核验不能加分' });
          await click(page, SELECTORS.submit, { scroll: false });
          await verify(page);
          assert.ok(held, 'Verification request must be held before its response arrives');
          await click(page, action('parent-cancel'), { scroll: false });
          await closeSheet(page); await noSheet(page);
          await click(page, action('reward-new'));
          const result = await env.api('/api/parent/verify', JSON.parse(held.postData()));
          assert.equal(result.status, 200);
          await held.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(result.body) });
          held = null; await delay(300);
          assert.deepEqual(await totals(page), before);
          assert.deepEqual(Model.totals((await env.api('/api/state')).body.state), before);
          assert.equal(env.requests.filter(item => item.path === '/api/action').length, 0);
          assert.equal((await ui(page)).form, 'reward');
        } finally {
          if (held) { await held.abort(); }
          page.off('request', intercept); await page.setRequestInterception(false);
        }
      });
      await closeSheet(page); await noSheet(page);
      await check('Changing verification settings needs current PIN; configured arithmetic is a disclosed weak gate', async () => {
        await click(page, action('preferences'));
        await click(page, action('parent-config'));
        await fillForm(page, { method: 'math' });
        await click(page, SELECTORS.submit, { scroll: false });
        assert.equal((await env.api('/api/meta')).body.parent.method, 'pin');
        assert.equal(await page.$('#parent-form [name="method"]'), null, 'A challenge cannot switch to a weaker method');
        assert.equal(await page.$eval(SELECTORS.answer, element => element.type), 'password');
        assert.equal(await page.$eval(SELECTORS.answer, element => element.value), '');
        assert.equal((await page.$eval('.sheet', element => element.textContent)).includes(PIN), false);
        await verify(page);
        await page.waitForFunction(() => window.FamilyDemo.getUI().form === 'preferences');
        await closeSheet(page); await noSheet(page);
        assert.equal((await env.api('/api/meta')).body.parent.method, 'math');
        await openCredit(page, { reason: '算术只是轻量防误触' });
        await click(page, SELECTORS.submit, { scroll: false });
        const challengeText = await page.$eval('.sheet', element => element.textContent);
        assert.match(challengeText, /弱|防误触|不能.*身份|不能.*家长/);
        const match = challengeText.match(/(\d+)\s*([+×*−-])\s*(\d+)/);
        assert.ok(match, 'Arithmetic prompt must be visible to the user');
        const a = Number(match[1]), b = Number(match[3]);
        const answer = match[2] === '+' ? a + b : ['×', '*'].includes(match[2]) ? a * b : a - b;
        const before = await totals(page);
        await verify(page, String(answer + 1));
        assert.deepEqual(await totals(page), before);
        await capture(page, 'arithmetic-verification');
        await verify(page, String(answer)); await noSheet(page);
        assert.equal((await totals(page)).earned, before.earned + 5);
      });
    });
    await group('redemption', async (env, page, check) => {
      await check('A child request/cancel does not spend; parent approval spends available without decreasing earned', async () => {
        const before = await totals(page);
        await click(page, action('redeem', 'reward-pencil'));
        await click(page, SELECTORS.submit, { scroll: false });
        await noSheet(page);
        assert.deepEqual(await totals(page), before);
        let request = (await state(page)).requests.find(item => item.status === 'pending');
        assert.ok(request);
        assert.equal(env.requests.filter(item => item.path === '/api/parent/challenge').length, 0);
        await click(page, action('redemption-cancel', request.id));
        assert.deepEqual(await totals(page), before);
        assert.equal((await state(page)).requests.find(item => item.id === request.id).status, 'cancelled');
        await click(page, action('redeem', 'reward-pencil'));
        await click(page, SELECTORS.submit, { scroll: false });
        await noSheet(page);
        request = (await state(page)).requests.find(item => item.status === 'pending');
        await click(page, action('redemption-approve', request.id));
        await fillForm(page, { note: '请选蓝色' });
        await click(page, SELECTORS.submit, { scroll: false });
        assert.deepEqual(await totals(page), before);
        await verify(page);
        await noSheet(page);
        assert.deepEqual(await totals(page), { earned: before.earned, spent: before.spent + 12, available: before.available - 12 });
        assert.equal((await state(page)).requests.find(item => item.id === request.id).status, 'approved');
        await capture(page, 'redemption-approved');
      });
      await check('A gift can be added directly using name/price, without an image, after per-operation verification', async () => {
        await click(page, action('reward-new'));
        await fillForm(page, { name: '橡皮', points: 10 });
        await click(page, SELECTORS.submit, { scroll: false });
        assert.equal((await state(page)).rewards.some(item => item.name === '橡皮'), false);
        await verify(page); await noSheet(page);
        const reward = (await state(page)).rewards.find(item => item.name === '橡皮');
        assert.equal(reward.points, 10); assert.equal(reward.category, 'daily'); assert.equal(reward.enabled, true);
      });
    });
    await group('templates', async (env, page, check) => {
      await check('A maintained quick-award template requires verification and carries its factual reason into a separately authorized award', async () => {
        const before = await totals(page);
        await click(page, action('point-list'));
        await click(page, action('point-item-new'));
        await fillForm(page, { name: '自己收拾书包', points: 3, reason: '今天没有提醒，自己把书包收好了' });
        await click(page, SELECTORS.submit, { scroll: false });
        assert.equal((await state(page)).pointItems.some(item => item.name === '自己收拾书包'), false);
        await verify(page);
        await page.waitForFunction(() => window.FamilyDemo.getUI().form === 'point-list');
        const template = (await state(page)).pointItems.find(item => item.name === '自己收拾书包');
        assert.ok(template); assert.equal(template.points, 3);
        assert.deepEqual(await totals(page), before);
        await closeSheet(page); await noSheet(page);
        await click(page, action('choose-point', template.id));
        assert.equal(await page.$eval('[name="name"]', element => element.value), '自己收拾书包');
        assert.equal(await page.$eval('[name="reason"]', element => element.value), '今天没有提醒，自己把书包收好了');
        assert.equal(Number(await page.$eval('[name="points"]', element => element.value)), 3);
        await click(page, SELECTORS.submit, { scroll: false });
        assert.deepEqual(await totals(page), before);
        await verify(page); await noSheet(page);
        assert.equal((await totals(page)).earned, before.earned + 3);
        await click(page, action('point-list')); await click(page, action('point-item-edit', template.id));
        await fillForm(page, { points: 9, reason: '下次核对新的具体原因' });
        await submitProtected(page);
        await page.waitForFunction(() => window.FamilyDemo.getUI().form === 'point-list');
        const saved = (await state(page)).points.find(item => item.reason === '今天没有提醒，自己把书包收好了');
        assert.ok(saved); assert.equal(saved.points, 3);
        assert.equal((await totals(page)).earned, before.earned + 3);
      });
    });
    await group('reminders', async (env, page, check) => {
      await navigate(page, 'reminders');
      await check('A reminder already due when the page opens is surfaced and publicly acknowledged without completing it', async () => {
        const before = await totals(page);
        await page.waitForSelector('#reminder-slot ' + action('task-ack', 'task-reading'));
        await click(page, '#reminder-slot ' + action('task-ack', 'task-reading'));
        assert.equal((await state(page)).tasks.find(item => item.id === 'task-reading').done, false);
        assert.ok((await state(page)).tasks.find(item => item.id === 'task-reading').ackAt);
        assert.deepEqual(await totals(page), before);
        assert.equal(env.requests.filter(item => item.path === '/api/parent/challenge').length, 0);
        await page.reload({ waitUntil: 'load' }); await connected(page);
        assert.equal(await page.$('#reminder-slot ' + action('task-ack', 'task-reading')), null);
        await navigate(page, 'reminders');
      });
      await check('Closing/Escape keeps a reminder draft; keyboard return and small-screen save preserve usable controls', async () => {
        await page.setViewport({ width: 320, height: 568 });
        await click(page, action('task-new'));
        await fillForm(page, { title: '明天带水杯', date: '2026-11-16', time: '07:30', note: '放在门口' });
        await closeSheet(page); await noSheet(page);
        await click(page, action('task-new'));
        assert.equal(await page.$eval('[name="title"]', element => element.value), '明天带水杯');
        await click(page, '[name="title"]');
        await page.keyboard.press('Tab');
        await page.keyboard.press('Escape'); await noSheet(page);
        await click(page, action('task-new'));
        assert.equal(await page.$eval('[name="note"]', element => element.value), '放在门口');
        report.layouts.push(await sheet(page, 'small-phone-draft-restored'));
        await reachable(page, SELECTORS.submit);
        await click(page, SELECTORS.submit, { scroll: false });
        assert.equal((await state(page)).tasks.some(item => item.title === '明天带水杯'), false);
        await capture(page, 'small-phone-reminder-verification');
        await verify(page); await noSheet(page);
      });
      await check('Reminder editing/deleting requires verification while public completion never awards points', async () => {
        await page.setViewport({ width: 390, height: 844 });
        const before = await totals(page);
        const taskId = (await state(page)).tasks.find(item => item.title === '明天带水杯').id;
        await click(page, action('day', '1'));
        await click(page, action('task-toggle', taskId));
        assert.equal((await state(page)).tasks.find(item => item.id === taskId).done, true);
        assert.deepEqual(await totals(page), before);
        assert.equal(await page.$('#parent-form'), null);
        await click(page, '.completed-list summary');
        await click(page, action('task-edit', taskId));
        await fillForm(page, { title: '明天带水杯和雨伞' });
        await submitProtected(page); await noSheet(page);
        assert.equal((await state(page)).tasks.find(item => item.id === taskId).title, '明天带水杯和雨伞');
        await click(page, '.completed-list summary');
        await click(page, action('task-edit', taskId));
        await click(page, action('task-delete', taskId));
        await verify(page); await noSheet(page);
        assert.equal((await state(page)).tasks.find(item => item.id === taskId).deleted, true);
        assert.deepEqual(await totals(page), before);
      });
      await check('An actual foreground due reminder supports acknowledgement and a ten-minute snooze without awarding points', async () => {
        await click(page, action('day', '0'));
        await click(page, action('task-new'));
        await fillForm(page, { title: '到点带水杯', date: '2026-11-15', time: '12:31', note: '' });
        await submitProtected(page); await noSheet(page);
        const taskId = (await state(page)).tasks.find(item => item.title === '到点带水杯').id;
        const before = await totals(page);
        await env.clock(FIXTURE_TIME + 61000);
        await page.waitForSelector('#reminder-slot .reminder-banner ' + action('task-snooze', taskId), { timeout: 8000 });
        await capture(page, 'foreground-reminder-due');
        const challenges = env.requests.filter(item => item.path === '/api/parent/challenge').length;
        await click(page, action('task-snooze', taskId));
        const snoozed = (await state(page)).tasks.find(item => item.id === taskId);
        assert.equal(new Date(snoozed.snoozeUntil).getTime(), FIXTURE_TIME + 61000 + 600000);
        assert.equal(snoozed.done, false);
        assert.equal(await page.$('#reminder-slot ' + action('task-snooze', taskId)), null, 'Snoozing removes this due prompt');
        await env.clock(FIXTURE_TIME + 661001);
        await page.waitForSelector('#reminder-slot ' + action('task-ack', taskId), { timeout: 8000 });
        await click(page, action('task-ack', taskId));
        const ack = (await state(page)).tasks.find(item => item.id === taskId);
        assert.ok(ack.ackAt); assert.equal(ack.done, false);
        assert.equal(await page.$('#reminder-slot ' + action('task-ack', taskId)), null, 'Acknowledgement removes the prompt without completing the reminder');
        assert.deepEqual(await totals(page), before);
        assert.equal(env.requests.filter(item => item.path === '/api/parent/challenge').length, challenges);
      });
    });
    await group('reminder-boundaries', async (env, page, check) => {
      await check('Acknowledged unfinished tasks and events remain reachable across midnight, and overdue edits still require verification', async () => {
        const date = Model.dateKey(new Date(FIXTURE_TIME));
        await env.authorize({ id: 'qa-carry-create', type: 'task.save', task: { id: 'task-carry', title: '跨日还要处理的水杯', type: 'task', date, time: '11:30', note: '' } });
        await env.authorize({ id: 'qa-past-event-create', type: 'task.save', task: { id: 'event-carry', title: '跨日未完成重要事件', type: 'event', date, time: '11:45', remindDays: 2 } });
        await env.authorize({ id: 'qa-near-event-create', type: 'task.save', task: { id: 'event-near', title: '提前准备家长会', type: 'event', date: Model.addDays(date, 5), time: '', remindDays: 7 } });
        await env.authorize({ id: 'qa-far-event-create', type: 'task.save', task: { id: 'event-far', title: '范围以外的出游', type: 'event', date: Model.addDays(date, 12), time: '', remindDays: 7 } });
        await page.reload({ waitUntil: 'load' }); await connected(page); await navigate(page, 'reminders');
        const before = await totals(page);
        await click(page, '#reminder-slot ' + action('task-ack', 'task-reading'));
        await click(page, '#reminder-slot ' + action('task-ack', 'task-carry'));
        await click(page, '#reminder-slot ' + action('task-ack', 'event-carry'));
        assert.ok((await state(page)).tasks.find(item => item.id === 'task-carry').ackAt);
        assert.ok((await state(page)).tasks.find(item => item.id === 'event-carry').ackAt);
        await env.clock(FIXTURE_TIME + 86400000);
        await page.waitForFunction(() => document.querySelector('.date-label').textContent.includes('11月16日'), { timeout: 8000 });
        await page.waitForSelector('.is-overdue[data-task-id="task-carry"]');
        assert.equal((await state(page)).tasks.find(item => item.id === 'task-carry').done, false);
        await click(page, action('task-edit', 'task-carry'));
        assert.equal(await page.$eval('[name="date"]', element => element.value), date);
        await fillForm(page, { note: '跨日仍能核对和处理' });
        await click(page, SELECTORS.submit, { scroll: false });
        assert.equal((await state(page)).tasks.find(item => item.id === 'task-carry').note, '');
        await verify(page); await noSheet(page);
        await page.reload({ waitUntil: 'load' }); await connected(page); await navigate(page, 'reminders');
        assert.ok(await page.$('.is-overdue[data-task-id="task-carry"]'));
        assert.equal((await state(page)).tasks.find(item => item.id === 'task-carry').note, '跨日仍能核对和处理');
        await click(page, action('reminder-mode', 'events'));
        await click(page, action('task-edit', 'event-carry'));
        assert.equal(await page.$eval('[name="date"]', element => element.value), date);
        await closeSheet(page); await noSheet(page);
        assert.deepEqual(await totals(page), before);
        await capture(page, 'overdue-event-reachable');
        await click(page, action('reminder-mode', 'near'));
      });
      await check('Advance preparation shows only events inside remindDays while the event list retains later events', async () => {
        const region = '[data-region="advance-events"]';
        await page.waitForSelector(region + ' [data-task-id="event-near"]');
        assert.equal(await page.$(region + ' [data-task-id="event-far"]'), null);
        assert.equal(await page.$(region + ' [data-task-id="event-carry"]'), null);
        await click(page, region + ' ' + action('task-edit', 'event-near'));
        assert.equal(await page.$eval('[name="remindDays"]', element => element.value), '7');
        await closeSheet(page); await noSheet(page);
        await capture(page, 'advance-reminder-range');
        await click(page, action('reminder-mode', 'events'));
        assert.ok(await page.$('[data-task-id="event-near"]'));
        assert.ok(await page.$('[data-task-id="event-far"]'));
        await click(page, action('reminder-mode', 'near'));
        await click(page, action('day', '1'));
        assert.equal(await page.$(region), null, 'Preparation region belongs to today rather than mixing all day lists');
      });
    });
    await group('assistant', async (env, page, check) => {
      await check('Local instruction demo produces a visible editable draft; input alone never books points', async () => {
        const before = await totals(page);
        await click(page, action('voice'));
        assert.match(await page.$eval('.sheet', element => element.textContent), /本地|演示/);
        await fillForm(page, { speech: '他刚刚主动收好了书包，给五分' });
        await click(page, SELECTORS.submit, { scroll: false });
        await page.waitForSelector('#editor-form [name="reason"]');
        assert.equal(Number(await page.$eval('[name="points"]', element => element.value)), 5);
        assert.match(await page.$eval('[name="reason"]', element => element.value), /书包/);
        assert.deepEqual(await totals(page), before);
        await capture(page, 'assistant-points-draft');
        await click(page, SELECTORS.submit, { scroll: false });
        assert.deepEqual(await totals(page), before);
        await verify(page);
        await page.waitForFunction(() => window.FamilyDemo.getUI().form === 'voice');
        await closeSheet(page); await noSheet(page);
        assert.equal((await totals(page)).earned, before.earned + 5);
      });
      await check('Read-only balance queries use the real ledger; missing behavior names clarify and gift sentences stay drafts', async () => {
        const before = await totals(page);
        await click(page, action('voice'));
        await fillForm(page, { speech: '还差多少分能换汉堡' });
        await click(page, SELECTORS.submit, { scroll: false });
        const reward = (await state(page)).rewards.find(item => /汉堡/.test(item.name));
        assert.ok(reward);
        const shortage = Math.max(0, reward.points - before.available);
        const answer = await page.$eval('.sheet', element => element.textContent);
        if (shortage > 0) { assert.ok(answer.includes(String(shortage)), 'Answer must show the real shortfall'); }
        else { assert.match(answer, /已经够|足够|够换/, 'An affordable reward must be described as affordable'); }
        const expensive = (await state(page)).rewards.find(item => item.points > before.available);
        assert.ok(expensive);
        await fillForm(page, { speech: '还差多少分能换' + expensive.name });
        await click(page, SELECTORS.submit, { scroll: false });
        const exactAnswer = await page.$eval('.sheet', element => element.textContent);
        assert.ok(exactAnswer.includes(String(expensive.points - before.available)), 'Shortfall must be calculated from the already changed real ledger');
        assert.deepEqual(await totals(page), before);
        await closeSheet(page); await noSheet(page);
        await click(page, action('voice'));
        await fillForm(page, { speech: '给五分' });
        await click(page, SELECTORS.submit, { scroll: false });
        assert.equal(await page.$('#editor-form [name="points"]'), null, 'Missing behavior name must not be invented');
        assert.match(await page.$eval('.sheet', element => element.textContent), /行为.*名称/);
        await closeSheet(page); await noSheet(page);
        await click(page, action('voice'));
        await fillForm(page, { speech: '添加一个周末吃汉堡的礼品，六十分' });
        const count = (await state(page)).rewards.length;
        await click(page, SELECTORS.submit, { scroll: false });
        await page.waitForSelector('[name="category"]');
        assert.equal(await page.$eval('[name="category"]', element => element.value), 'weekend');
        assert.equal(Number(await page.$eval('[name="points"]', element => element.value)), 60);
        assert.equal((await state(page)).rewards.length, count);
        await closeSheet(page);
        assert.equal((await ui(page)).form, 'voice');
        await closeSheet(page); await noSheet(page);
      });
      await check('Unavailable speech recognition returns a keyboard route; a reminder sentence remains editable and cancellable', async () => {
        await page.evaluate(() => { window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; });
        await click(page, action('voice'));
        await click(page, action('listen'));
        assert.match(await page.$eval('.sheet', element => element.textContent), /键盘|打字/);
        await fillForm(page, { speech: '明天早上七点半提醒带水杯' });
        await click(page, SELECTORS.submit, { scroll: false });
        await page.waitForSelector('[name="title"]');
        assert.match(await page.$eval('[name="title"]', element => element.value), /水杯/);
        assert.equal(await page.$eval('[name="date"]', element => element.value), '2026-11-16');
        assert.equal(await page.$eval('[name="time"]', element => element.value), '07:30');
        const count = (await state(page)).tasks.length;
        await closeSheet(page);
        assert.equal((await state(page)).tasks.length, count);
      });
    });
    await group('assistant-public', async (env, page, check) => {
      await check('A public natural-language redemption request remains a visible draft and confirms without parent verification or spending', async () => {
        const before = await totals(page);
        await click(page, action('voice'));
        await fillForm(page, { speech: '我要兑换彩虹铅笔' });
        await click(page, SELECTORS.submit, { scroll: false });
        await page.waitForFunction(() => window.FamilyDemo.getUI().form === 'request');
        assert.equal((await state(page)).requests.some(item => item.status === 'pending'), false);
        assert.deepEqual(await totals(page), before);
        await capture(page, 'assistant-public-request-draft');
        await click(page, SELECTORS.submit, { scroll: false });
        await page.waitForFunction(() => window.FamilyDemo.getUI().form === 'voice');
        assert.ok((await state(page)).requests.find(item => item.status === 'pending' && item.rewardId === 'reward-pencil'));
        assert.deepEqual(await totals(page), before);
        assert.equal(env.requests.filter(item => item.path === '/api/parent/challenge').length, 0);
      });
    });
    await group('sync', async (env, page, check) => {
      const second = await env.newPage({ width: 1024, height: 768 }); await env.load(second);
      await check('Two real pages synchronize an authorized award through real HTTP polling and survive reload', async () => {
        const before = await totals(page);
        await page.bringToFront();
        await openCredit(page, { reason: '两台页面看到同一笔记录' });
        await submitProtected(page); await noSheet(page);
        await second.bringToFront();
        await second.waitForFunction(expected => window.FamilyModel.totals(window.FamilyDemo.getState()).earned === expected,
          { timeout: 12000, polling: 200 }, before.earned + 5);
        assert.deepEqual(await totals(second), await totals(page));
        await second.reload({ waitUntil: 'load' }); await connected(second);
        assert.deepEqual(await totals(second), await totals(page));
        await capture(second, 'two-page-synced');
      });
    });
    await group('compatibility', async (env, page, check) => {
      await check('Audio files remain valid resources and reduced-motion CSS is honored in Edge', async () => {
        for (const name of ['complete', 'points', 'redeem']) {
          const resource = await fetch(env.url + '/assets/' + name + '.wav');
          assert.equal(resource.status, 200);
          const bytes = Buffer.from(await resource.arrayBuffer());
          assert.equal(bytes.subarray(0, 4).toString(), 'RIFF'); assert.ok(bytes.length > 5000);
        }
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
        assert.equal(await page.$eval('.btn', element => getComputedStyle(element).transitionDuration), '0s');
      });
    });
    if (process.env.V3_OFFLINE === '1' || (requested && requested.some(name => name === 'offline' || name === 'offline-hosted'))) {
      await group('offline', async (env, page, check) => {
        await check('The final offline bundle contains the exact current scripts, styles and explicit local-mode flag', async () => {
          const html = fs.readFileSync(path.join(ROOT, 'export', 'little-steps-demo.html'), 'utf8').replace(/\r\n/g, '\n');
          for (const name of ['model.js', 'assistant.js', 'app.js']) {
            const source = fs.readFileSync(path.join(ROOT, name), 'utf8').replace(/\r\n/g, '\n').replace(/<\/script/g, '<\\/script');
            assert.ok(html.includes('<script>' + source + '</script>'), name + ' differs from the final exported executable script');
          }
          assert.ok(html.includes(fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8').replace(/\r\n/g, '\n')));
          assert.match(html, /window\.__FAMILY_OFFLINE__\s*=\s*true/);
        });
        await check('Exported file stays offline, persists public completion and retains drafts', async () => {
          const external = [];
          await page.setRequestInterception(true);
          page.on('request', request => {
            if (/^https?:/.test(request.url())) { external.push(request.url()); request.abort(); }
            else { request.continue(); }
          });
          await page.goto(pathToFileURL(path.join(ROOT, 'export', 'little-steps-demo.html')).href, { waitUntil: 'load' });
          await page.waitForFunction(() => window.FamilyDemo);
          assert.equal((await ui(page)).connected, false);
          await navigate(page, 'reminders');
          const before = await totals(page);
          await click(page, action('task-toggle', 'task-reading'));
          assert.deepEqual(await totals(page), before);
          await page.reload({ waitUntil: 'load' }); await page.waitForFunction(() => window.FamilyDemo);
          assert.equal((await state(page)).tasks.find(item => item.id === 'task-reading').done, true);
          await navigate(page, 'reminders');
          await click(page, action('task-new'));
          await fillForm(page, { title: '离线草稿', note: '关闭仍保留' });
          await closeSheet(page); await click(page, action('task-new'));
          assert.equal(await page.$eval('[name="title"]', element => element.value), '离线草稿');
          assert.deepEqual(external, []);
          await capture(page, 'offline-draft');
        });
        await check('Offline first-use PIN setup and every later award stay local, with wrong-code denial and no credential in business state', async () => {
          await closeSheet(page); await noSheet(page);
          await navigate(page, 'points');
          const before = await totals(page);
          await openCredit(page, { reason: '离线演示首次设置家长密码' });
          await click(page, SELECTORS.submit, { scroll: false });
          await confirmPoints(page);
          await page.waitForSelector('#parent-form [name="setupPin"]');
          assert.deepEqual(await totals(page), before);
          await fill(page, '#parent-form [name="setupPin"]', '654321');
          await fill(page, '#parent-form [name="setupConfirm"]', '654321');
          await click(page, SELECTORS.verify, { scroll: false }); await noSheet(page);
          assert.equal((await totals(page)).earned, before.earned + 5);
          await openCredit(page, { reason: '离线演示下一笔仍需家长密码' });
          await click(page, SELECTORS.submit, { scroll: false });
          await verify(page, '000000');
          assert.equal((await totals(page)).earned, before.earned + 5);
          assert.ok(await page.$('#parent-form'));
          await verify(page, '654321'); await noSheet(page);
          assert.equal((await totals(page)).earned, before.earned + 10);
          const business = await state(page);
          assert.equal(business.parent, undefined);
          assert.equal(JSON.stringify(business).includes('654321'), false);
          await page.reload({ waitUntil: 'load' }); await page.waitForFunction(() => window.FamilyDemo);
          assert.equal((await totals(page)).earned, before.earned + 10);
          await capture(page, 'offline-points-persisted');
        });
      });
      await group('offline-hosted', async (env, page, check) => {
        await check('The exported file explicitly remains local when served over real HTTP and never calls an API', async () => {
          const html = fs.readFileSync(path.join(ROOT, 'export', 'little-steps-demo.html'));
          const apiCalls = [], unexpected = [];
          const hosted = http.createServer((request, response) => {
            if (request.url === '/' || request.url === '/offline.html') {
              response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); return;
            }
            if (request.url.startsWith('/api/')) { apiCalls.push(request.url); }
            else if (request.url !== '/favicon.ico') { unexpected.push(request.url); }
            response.writeHead(404); response.end();
          });
          await new Promise(resolve => hosted.listen(0, '127.0.0.1', resolve));
          try {
            await page.goto('http://127.0.0.1:' + hosted.address().port + '/offline.html', { waitUntil: 'load' });
            await page.waitForFunction(() => window.FamilyDemo);
            assert.equal(await page.evaluate(() => window.__FAMILY_OFFLINE__), true);
            assert.equal((await ui(page)).connected, false);
            await navigate(page, 'reminders');
            const before = await totals(page);
            await click(page, action('task-toggle', 'task-reading'));
            assert.equal((await state(page)).tasks.find(item => item.id === 'task-reading').done, true);
            assert.deepEqual(await totals(page), before);
            await page.reload({ waitUntil: 'load' }); await page.waitForFunction(() => window.FamilyDemo);
            assert.equal((await state(page)).tasks.find(item => item.id === 'task-reading').done, true);
            assert.deepEqual(apiCalls, []); assert.deepEqual(unexpected, []);
            await capture(page, 'offline-http-local');
          } finally { hosted.closeAllConnections(); await new Promise(resolve => hosted.close(resolve)); }
        });
      });
    } else { report.skipped.push('Packaged offline export not checked in this run; run V3_OFFLINE=1 after Lead packages v0.3.'); }
  } finally {
    report.finishedAt = new Date().toISOString();
    const resultFile = path.join(ARTIFACTS, 'v3-browser-results.json');
    const previous = requested && fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null;
    const run = { groups: requested || 'all', startedAt: report.startedAt, finishedAt: report.finishedAt,
      sourceHashes: report.sourceHashes, exportHash: report.exportHash, passed: report.passed, failed: report.failed };
    let combined = { ...report, runs: [run] };
    if (previous) {
      const rerun = new Set(requested);
      combined = { ...report, groupsRequested: 'cumulative targeted runs',
        checks: previous.checks.filter(item => !rerun.has(item.group)).concat(report.checks),
        failed: previous.failed.filter(item => !rerun.has(item.group)).concat(report.failed),
        layouts: (rerun.has('layout') ? [] : previous.layouts || []).concat(report.layouts),
        errors: (previous.errors || []).concat(report.errors),
        skipped: rerun.has('offline') && !report.failed.some(item => item.group === 'offline') ? [] : previous.skipped,
        runs: (previous.runs || [{ groups: previous.groupsRequested, startedAt: previous.startedAt,
          finishedAt: previous.finishedAt, passed: previous.passed, failed: previous.failed }]).concat(run) };
      combined.passed = combined.checks.length;
    }
    fs.writeFileSync(resultFile, JSON.stringify(combined, null, 2));
    if (browser) { await browser.close(); }
  }
  console.log(report.passed + ' checks passed; ' + report.failed.length + ' failed.');
  if (report.failed.length) { process.exitCode = 1; }
  return report;
}

module.exports = { ROOT, ARTIFACTS, PIN, FIXTURE_TIME, VIEWPORTS, SELECTORS, Model,
  launch, createEnvironment, delay, action, homeView, click, fill, fillForm, state, ui, totals,
  connected, navigate, closeSheet, noSheet, confirmPoints, verify, submitProtected, openCredit, capture,
  metrics, reachable, bounded, sheet, runSuite };
if (require.main === module) { runSuite().catch(error => { console.error(error); process.exitCode = 1; }); }
