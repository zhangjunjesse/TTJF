'use strict';

// One bounded group per process, using synthetic users and a fresh SQLite file.
// DEVICE_HOME_CASE=phone|phone-award|phone-award-draft|phone-scrim|phone-landscape|desktop-screen|tablet|preferences|storage|sync
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Q = require('./saas-browser.cjs');
const { B, action: a, click, ui, snapshot } = Q;
const CASE = process.env.DEVICE_HOME_CASE || 'phone';
const CASES = ['phone', 'phone-award', 'phone-award-draft', 'phone-scrim', 'phone-landscape', 'desktop-screen', 'tablet', 'preferences', 'storage', 'sync'];
assert.ok(CASES.includes(CASE), 'Unknown DEVICE_HOME_CASE');
const KEY = 'ttjf-device-home-v1';
const SOURCES = ['test/device-home-browser.cjs', 'test/browser.cjs', 'test/saas-browser.cjs',
  'home-points.js', 'home-points.css', 'app.js', 'saas-client.js', 'farm-ui.js', 'world-ui.js', 'farm-world.css', 'styles.css', 'index.html'];
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
  env = await Q.initialize(); env.clock(Date.parse(CASE === 'sync' ? '2026-11-19T04:30:00Z' : '2026-11-20T04:30:00Z'));
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
    await cold.evaluateOnNewDocument(() => {
      const frames = window.coldCanvas = {};
      const observer = new MutationObserver(() => {
        const view = window.FamilySaas?.status().view;
        const panel = document.querySelector('.saas-main');
        if (!panel || !['checking', 'loading-family'].includes(view) || frames[view]) return;
        frames[view] = [document.documentElement, document.body, panel].map(el => getComputedStyle(el).backgroundColor);
        if (frames.checking && frames['loading-family']) observer.disconnect();
      });
      observer.observe(document, { subtree: true, childList: true });
    });
    try {
      await cold.goto(env.origin, { waitUntil: 'load' }); await Q.ready(cold, familyId);
      await mode('points', cold); await noPetRenderer(cold); await B.delay(250);
      assert.deepEqual(requests, [], 'the lightweight points home does not download the 3D scene bundle');
      const frames = await cold.evaluate(() => window.coldCanvas);
      const paper = await cold.$eval('.home-header', el => getComputedStyle(el).backgroundColor);
      report.coldHome = { sceneBundleRequests: requests.length, frames, paper };
      for (const view of ['checking', 'loading-family']) {
        assert.deepEqual(frames[view], [paper, paper, paper], view + ' paints the same canvas as the incoming points home');
      }
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
async function phoneAwardFixture(allCommon = true) {
  let sequence = 0;
  async function fixtureAction(input, protectedAction = true) {
    const before = await env.api(page, '/api/state');
    assert.equal(before.status, 200);
    const action = { ...input, id: 'device-home-' + CASE + '-fixture-' + (++sequence) };
    let grant;
    if (protectedAction) {
      const challenge = await env.api(page, '/api/parent/challenge', 'POST', { revision: before.body.revision, action });
      assert.equal(challenge.status, 200, JSON.stringify(challenge.body));
      const verified = await env.api(page, '/api/parent/verify', 'POST', { challengeId: challenge.body.challengeId, answer: Q.PIN });
      assert.equal(verified.status, 200, JSON.stringify(verified.body)); grant = verified.body.grant;
    }
    const saved = await env.api(page, '/api/action', 'POST', { revision: before.body.revision, action, grant });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }
  await fixtureAction({ type: 'parent.setup', method: 'pin', pin: Q.PIN, confirmPin: Q.PIN }, false);
  const items = [
    { id: 'device-home-read', name: '合成阅读', points: 3 },
    { id: 'device-home-tidy', name: '合成整理', points: 2 },
    { id: 'device-home-help', name: '合成帮忙', points: 1 },
    { id: 'device-home-brush', name: '自己刷牙', points: 1 }
  ];
  for (const item of allCommon ? items : items.slice(-1)) {
    await fixtureAction({ type: 'pointItem.save', item: { ...item, reason: '', enabled: true } });
  }
  await reload(); await mode('points');
}
async function ledgerAwardReceipt(phase, expected) {
  await page.waitForFunction(() => {
    const world = window.FamilyWorldUI?.diagnostics();
    return world && world.route === 'authorization' && world.visible === false;
  }, { timeout: 4000 });
  const receipt = await page.$eval('.ledger-award-dialog', dialog => {
    const visible = node => {
      if (!node) return false;
      const box = node.getBoundingClientRect(), style = getComputedStyle(node);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const references = attribute => (dialog.getAttribute(attribute) || '').split(/\s+/).filter(Boolean)
      .map(id => ({ id, text: document.getElementById(id)?.textContent.trim() || '' }));
    const readable = selector => {
      const node = dialog.querySelector(selector);
      return !!node && visible(node) && !node.closest('[aria-hidden="true"], [hidden], [inert]');
    };
    const answer = dialog.querySelector('[name="answer"]');
    const summaryBox = dialog.querySelector('.ledger-award-summary').getBoundingClientRect();
    const body = dialog.querySelector('.sheet-body'), bodyBox = body.getBoundingClientRect(), bodyStyle = getComputedStyle(body);
    const contentLeft = bodyBox.left + parseFloat(bodyStyle.borderLeftWidth) + parseFloat(bodyStyle.paddingLeft);
    const contentRight = bodyBox.right - parseFloat(bodyStyle.borderRightWidth) - parseFloat(bodyStyle.paddingRight);
    return {
      phase: dialog.dataset.authPhase, role: dialog.getAttribute('role'), modal: dialog.getAttribute('aria-modal'),
      text: dialog.textContent, name: dialog.querySelector('.ledger-award-name')?.textContent.trim(),
      child: dialog.querySelector('.ledger-award-child')?.textContent.trim(),
      amount: dialog.querySelector('.ledger-award-amount')?.textContent.trim(),
      meta: dialog.querySelector('.ledger-award-meta')?.textContent.trim(),
      reason: dialog.querySelector('.ledger-award-reason')?.textContent.trim() ?? null,
      readable: ['.ledger-award-child', '.ledger-award-name', '.ledger-award-amount', '.ledger-award-meta'].map(readable),
      label: references('aria-labelledby'), description: references('aria-describedby'),
      focused: dialog.contains(document.activeElement),
      pinLabel: answer ? [...answer.labels].map(label => label.textContent.trim()).join(' ') : null,
      homeVisible: visible(document.querySelector('#main [data-home-mode="points"]')),
      homeHiddenFromReader: document.querySelector('.app-shell')?.getAttribute('aria-hidden'),
      worldStageVisible: visible(document.querySelector('#world-stage')),
      layout: { summary: { left: summaryBox.left, right: summaryBox.right, width: summaryBox.width },
        contentLeft, contentRight, contentWidth: contentRight - contentLeft },
      world: window.FamilyWorldUI.diagnostics()
    };
  });
  assert.equal(receipt.phase, phase); assert.equal(receipt.role, 'dialog'); assert.equal(receipt.modal, 'true');
  assert.equal(receipt.name, expected.name);
  assert.equal(receipt.amount.replace(/\s+/g, ''), '+' + expected.points + '分');
  assert.ok(receipt.child.includes('合成设备宝')); assert.ok(receipt.meta.includes(expected.time));
  assert.ok(receipt.label.length && receipt.label.every(row => row.text), 'the receipt has a valid accessible dialog name');
  assert.ok(receipt.description.length && receipt.description.every(row => row.text), 'the receipt has a valid accessible dialog description');
  assert.ok(receipt.readable.every(Boolean), 'the child, behavior, amount and time are readable in the real receipt');
  assert.equal(receipt.focused, true, 'focus stays in the active award dialog');
  assert.equal(receipt.homeVisible, true, 'the actual points home remains visible behind review and PIN');
  assert.equal(receipt.homeHiddenFromReader, 'true', 'the background is excluded from the active dialog reading order');
  assert.equal(receipt.worldStageVisible, false, 'no 3D location replaces the actual ledger during review or PIN');
  assert.equal(receipt.world.route, 'authorization'); assert.equal(receipt.world.visible, false);
  if (CASE === 'phone-award' && phase === 'confirm') {
    const layout = receipt.layout;
    assert.ok(layout.contentWidth > 0 && layout.summary.width >= layout.contentWidth * .9,
      'the real receipt fills at least 90% of the available phone sheet content: ' + JSON.stringify(layout));
    assert.ok(layout.summary.left >= layout.contentLeft - 1 && layout.summary.right <= layout.contentRight + 1,
      'the full-width receipt stays inside the phone sheet content: ' + JSON.stringify(layout));
  }
  if (expected.reason) assert.ok(receipt.reason?.includes(expected.reason), 'a supplied reason remains on the real receipt');
  else {
    assert.equal(receipt.reason, null, 'a blank optional reason has no empty receipt row');
    assert.doesNotMatch(receipt.text, /未填写/);
  }
  if (phase === 'confirm') {
    const cta = await page.$eval(a('points-confirm'), node => ({ text: node.textContent.trim(), busy: node.getAttribute('aria-busy'), disabled: node.disabled }));
    assert.match(cta.text, /家长验证/); assert.doesNotMatch(cta.text, /发放|完成|成功|已加/);
    assert.equal(cta.busy, 'false'); assert.equal(cta.disabled, false);
    assert.equal(receipt.pinLabel, null, 'a review does not ask for a PIN before the explicit verification action');
  } else assert.match(receipt.pinLabel, /家长\s*PIN/);
  return receipt;
}
async function phoneAward() {
  await phoneAwardFixture();
  await check('The phone award review paints an opaque, tappable top edge with both zero and 47px safe-area insets', async () => {
    const before = await sql(), marker = env.calls.length, chosen = a('choose-point', 'device-home-brush');
    const session = deviceSessions.get(page);
    const topEdge = () => page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.paddingTop = 'env(safe-area-inset-top, 0px)'; document.body.appendChild(probe);
      const safeAreaTop = parseFloat(getComputedStyle(probe).paddingTop); probe.remove();
      const hit = document.elementFromPoint(innerWidth / 2, 4), style = getComputedStyle(hit), box = hit.getBoundingClientRect();
      const overlay = hit.closest('.sheet-overlay'), backdrop = overlay?.querySelector('.sheet-backdrop');
      const context = document.createElement('canvas').getContext('2d');
      const pixel = color => {
        context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      };
      const theme = document.querySelector('meta[name="theme-color"]').content;
      return { safeAreaTop, width: innerWidth, theme, themePixel: pixel(theme),
        rootColor: getComputedStyle(document.documentElement).backgroundColor, bodyColor: getComputedStyle(document.body).backgroundColor,
        overlay: !!overlay, sameAcrossTop: [4, innerWidth / 2, innerWidth - 4].every(x => document.elementFromPoint(x, 4) === hit),
        action: hit.dataset.action, backdropAction: backdrop?.dataset.action,
        position: style.position, opacity: style.opacity, color: style.backgroundColor, pixel: pixel(style.backgroundColor),
        box: { top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height } };
    });
    report.phoneAwardTopEdge = [];
    try {
      for (const inset of [0, 47]) {
        await session.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: inset, left: 0, right: 0, bottom: 0 } });
        const home = await topEdge();
        assert.equal(home.safeAreaTop, inset, 'the browser applies the actual CSS safe-area inset');
        assert.equal(home.overlay, false, 'the ordinary points home has no top-edge modal hit target');
        await click(page, chosen, { scroll: false });
        assert.equal((await ui(page)).authPhase, 'confirm');
        assert.ok(await page.$('.ledger-award-dialog .award-photo-editor'), 'the real award review includes its photo controls');
        const review = await topEdge();
        report.phoneAwardTopEdge.push({ inset, home, review }); progress('Measured award review top edge at ' + inset + 'px safe area');
        assert.equal(review.overlay, true, 'the actual viewport top hit belongs to the open award overlay: ' + JSON.stringify(review));
        assert.equal(review.position, 'fixed', 'the actual viewport top is painted by a fixed element');
        assert.ok(review.box.height > 10 && review.box.top <= 0 && review.box.bottom > 4,
          'the top-edge hit target remains taller than 10px even without a safe area: ' + JSON.stringify(review));
        assert.ok(review.box.left <= 0 && review.box.right >= review.width && review.sameAcrossTop,
          'one real top-edge element covers and receives hits across the full viewport width');
        assert.equal(review.opacity, '1'); assert.equal(review.pixel[3], 255, 'the sampled top-edge background is fully opaque');
        assert.deepEqual(review.pixel, review.themePixel, 'the real top-edge paint agrees with the browser theme color');
        assert.ok(review.action && review.action === review.backdropAction, 'the top edge uses the existing backdrop action');
        await Q.shot(page, 'phone-award-top-edge-' + inset);
        await page.mouse.click(review.width / 2, 4);
        await page.waitForFunction(() => {
          const current = window.FamilyDemo.getUI(); return !current.auth && current.form === null && current.view === 'points';
        });
        await mode('points');
        const closed = await topEdge(); report.phoneAwardTopEdge.at(-1).closed = closed;
        assert.equal(closed.overlay, false, 'closing removes the top-edge overlay hit target');
        for (const property of ['theme', 'rootColor', 'bodyColor']) assert.equal(closed[property], home[property], 'closing restores the home ' + property);
        assert.equal(await page.$eval(chosen, node => node === document.activeElement), true, 'a top-edge tap returns focus to the original behavior');
        await unchanged(before, marker, 'top-edge cancellation at ' + inset + 'px safe area');
      }
    } finally {
      await session.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, right: 0, bottom: 0 } });
    }
  });
  await check('A visible phone common behavior opens its real receipt directly and authorizes one point before returning to the first home record', async () => {
    const before = await sql(), marker = env.calls.length, beforeTotals = Q.M.totals(before.state);
    const commonItems = await page.$$eval('.points-behavior-grid [data-action="choose-point"]', nodes => nodes.map(node => ({
      id: node.dataset.id, text: node.textContent.trim()
    })));
    assert.equal(commonItems.length, 4, 'the portrait points home exposes all four common behaviors');
    const chosen = a('choose-point', 'device-home-brush'), target = await B.metrics(page, chosen);
    assert.ok(target.some(row => row.width >= 47.9 && row.height >= 47.9 && row.inViewport && row.reachable),
      'the actual brush-teeth behavior is visible and tappable without first opening the picker: ' + JSON.stringify(target));
    assert.match(await page.$eval(chosen, node => node.textContent), /自己刷牙.*\+1/);
    await Q.shot(page, 'phone-brush-common-visible');
    await click(page, chosen, { scroll: false });
    assert.equal((await ui(page)).authPhase, 'confirm');
    await click(page, '.ledger-award-dialog .sheet-header button[aria-label="取消本次加分"]');
    await page.waitForFunction(() => {
      const current = window.FamilyDemo.getUI(); return !current.auth && current.form === null && current.view === 'points';
    });
    await mode('points');
    assert.equal(await page.$eval(chosen, node => node === document.activeElement), true,
      'one visible cancel returns to the same common-behavior home button');
    await unchanged(before, marker, 'the visible quick-review cancellation');
    progress('The visible cancel returned once to the original home behavior without authorization or writing');
    await click(page, chosen, { scroll: false });
    assert.equal((await ui(page)).form, 'points');
    assert.equal((await ui(page)).authPhase, 'confirm');
    assert.equal(await page.$('#editor-form'), null, 'the unchanged visible template does not open or focus an editor first');
    const preview = await ledgerAwardReceipt('confirm', { name: '自己刷牙', points: 1, time: '12:30' });
    assert.equal(await page.$('#parent-form [name="answer"]'), null, 'the preview does not ask for a PIN yet');
    assert.deepEqual(await sql(), before, 'opening the behavior and its preview does not write any points');
    assert.deepEqual(env.calls.slice(marker).filter(call => !['GET', 'HEAD'].includes(call.method)), [],
      'the visible behavior and review do not request authorization or persist an award');
    await Q.shot(page, 'phone-brush-preview');
    await click(page, a('points-confirm'));
    await page.waitForSelector('#parent-form [name="answer"]');
    assert.equal((await ui(page)).authPhase, 'verify');
    const pin = await ledgerAwardReceipt('verify', { name: '自己刷牙', points: 1, time: '12:30' });
    assert.deepEqual(await sql(), before, 'the parent challenge alone does not award a point');
    assert.equal(env.calls.slice(marker).filter(call => call.path === '/api/parent/challenge').length, 1);
    assert.equal(env.calls.slice(marker).filter(call => call.path === '/api/action').length, 0);
    await Q.shot(page, 'phone-brush-parent-pin');
    await B.fill(page, '#parent-form [name="answer"]', Q.PIN); await click(page, Q.parentSubmit);
    await page.waitForFunction(() => {
      const current = window.FamilyDemo.getUI(); return !current.auth && !current.pending && current.form === null && current.view === 'points';
    });
    await mode('points');
    const notice = await page.$$eval('#toast.visible, #home-feedback[data-feedback="true"]', nodes => nodes.filter(node => {
      const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(node).visibility !== 'hidden';
    }).map(node => node.textContent).join(' '));
    assert.match(notice, /自己刷牙/); assert.match(notice, /\+\s*1\s*分/);
    const firstRecord = await page.$eval('.points-recent-list li:first-child', node => ({
      name: node.querySelector('strong').textContent, amount: node.querySelector('.points-record-amount').textContent.trim()
    }));
    assert.equal(firstRecord.name, '自己刷牙'); assert.match(firstRecord.amount, /^\+1\s*分$/);
    const firstRecordTargets = await B.metrics(page, '.points-recent-list li:first-child');
    assert.ok(firstRecordTargets.some(row => row.inViewport && row.reachable),
      'the returned phone home visibly shows the first new record: ' + JSON.stringify(firstRecordTargets));
    assert.equal(await page.$eval('[data-testid="earned-points"]', node => Number(node.textContent)), beforeTotals.earned + 1);
    assert.equal(await page.$eval('[data-testid="available-points"]', node => Number(node.textContent)), beforeTotals.available + 1);
    await Q.shot(page, 'phone-brush-award-success');
    const after = await sql(), afterTotals = Q.M.totals(after.state);
    assert.equal(after.revision, before.revision + 1, 'one authorized award creates exactly one family revision');
    assert.equal(after.state.points.length, before.state.points.length + 1);
    assert.deepEqual(after.state.points.filter(row => row.itemId === 'device-home-brush').map(row => ({ name: row.name, points: row.points, reason: row.reason, at: row.at })),
      [{ name: '自己刷牙', points: 1, reason: '', at: '2026-11-20T04:30:00.000Z' }]);
    assert.deepEqual(afterTotals, { earned: beforeTotals.earned + 1, spent: beforeTotals.spent, available: beforeTotals.available + 1 });
    assert.deepEqual(await snapshot(page), after.state, 'the home and SQLite agree on the actually committed ledger');
    const writes = env.calls.slice(marker).filter(call => call.path === '/api/action');
    assert.equal(writes.length, 1); assert.equal(writes[0].action.type, 'points.add'); assert.equal(writes[0].action.hasGrant, true);
    report.phoneAward = { commonItems, brushTargets: target, preview, pin, notice, firstRecord, firstRecordTargets,
      beforeTotals, afterTotals, beforeRevision: before.revision, afterRevision: after.revision, authorizedWrites: writes.length };
    progress('Brush-teeth award committed once and visible on the returned phone home');
  });
}
async function phoneAwardDraft() {
  await phoneAwardFixture(false);
  const chosen = a('choose-point', 'device-home-brush'), before = await sql(), marker = env.calls.length;
  const readDraft = () => page.$eval('#editor-form', form => Object.fromEntries(['name', 'points', 'reason', 'recordTime']
    .map(name => [name, form.elements[name].value])));
  await check('Returning from a common-behavior receipt keeps an editable draft and requests no authorization', async () => {
    await click(page, chosen); assert.equal((await ui(page)).authPhase, 'confirm');
    await click(page, '.sheet-footer ' + a('parent-cancel'));
    assert.equal((await ui(page)).form, 'points'); assert.equal((await ui(page)).auth, false);
    assert.deepEqual(await readDraft(), { name: '自己刷牙', points: '1', reason: '', recordTime: '12:30' });
    await unchanged(before, marker, 'returning from the direct common-behavior review');
    await Q.shot(page, 'phone-brush-return-to-edit');
  });
  await check('Separate amount, reason and time drafts reopen for editing instead of being overwritten by quick review', async () => {
    const drafts = [
      { label: 'amount', values: { points: 7 }, expected: { points: '7', reason: '', recordTime: '12:30' } },
      { label: 'reason', values: { points: 1, reason: '早餐后自己刷牙' }, expected: { points: '1', reason: '早餐后自己刷牙', recordTime: '12:30' } },
      { label: 'time', values: { reason: '', recordTime: '10:05' }, expected: { points: '1', reason: '', recordTime: '10:05' } }
    ];
    report.phoneAwardDrafts = [];
    for (const draft of drafts) {
      await B.fillForm(page, draft.values);
      await click(page, '.sheet-header ' + a('form-close')); await mode('points');
      assert.equal((await ui(page)).form, null);
      await click(page, chosen);
      assert.equal((await ui(page)).form, 'points'); assert.equal((await ui(page)).auth, false,
        draft.label + ' changes must open the saved editor rather than a replacement review');
      assert.equal(await page.$('.points-confirm-dialog'), null);
      const actual = await readDraft(); assert.deepEqual(actual, { name: '自己刷牙', ...draft.expected });
      report.phoneAwardDrafts.push({ field: draft.label, draft: actual });
      progress('Retained independent ' + draft.label + ' draft');
    }
    await unchanged(before, marker, 'reopening each independent common-behavior draft');
    await Q.shot(page, 'phone-brush-time-draft-retained');
  });
  await check('The edited common-behavior receipt and cancelled PIN leave both the template and ledger unchanged', async () => {
    await B.fillForm(page, { points: 7, reason: '早餐后自己刷牙' }); await click(page, Q.save);
    const review = await ledgerAwardReceipt('confirm', { name: '自己刷牙', points: 7, reason: '早餐后自己刷牙', time: '10:05' });
    await unchanged(before, marker, 'edited common-behavior review');
    await Q.shot(page, 'phone-brush-edited-receipt');
    await click(page, a('points-confirm')); await page.waitForSelector('#parent-form [name="answer"]');
    const pin = await ledgerAwardReceipt('verify', { name: '自己刷牙', points: 7, reason: '早餐后自己刷牙', time: '10:05' });
    await B.fill(page, '#parent-form [name="answer"]', Q.PIN);
    assert.deepEqual(await sql(), before, 'entering a valid PIN still needs its explicit verify action');
    await click(page, '.sheet-footer ' + a('parent-cancel'));
    assert.equal((await ui(page)).auth, false);
    assert.deepEqual(await readDraft(), { name: '自己刷牙', points: '7', reason: '早餐后自己刷牙', recordTime: '10:05' });
    await click(page, '.sheet-header ' + a('form-close')); await mode('points');
    assert.deepEqual(await sql(), before, 'cancelling a PIN never changes the template or stored ledger');
    assert.deepEqual(await snapshot(page), before.state);
    const requests = env.calls.slice(marker).filter(call => !['GET', 'HEAD'].includes(call.method));
    assert.deepEqual(requests.map(call => call.path), ['/api/parent/challenge'], 'only the explicit review action requests one challenge; cancelled PIN never verifies or commits');
    report.phoneAwardCancellation = { review, pin, beforeRevision: before.revision, afterRevision: (await sql()).revision, requests };
    await Q.shot(page, 'phone-brush-cancelled-no-record');
  });
}
async function phoneScrim() {
  await phoneAwardFixture(false);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  const before = await sql(), marker = env.calls.length, chosen = a('choose-point', 'device-home-brush');
  report.sheetScrim = [];
  async function open(selector) {
    await page.evaluate(() => {
      const host = document.getElementById('app');
      // Observe the real render before its first paint, then seek the browser's
      // animation instead of racing a 100ms wall-clock screenshot window.
      const qa = window.__qaSheetScrim = {};
      qa.read = () => {
        const backdrop = host.querySelector('.sheet-backdrop'), dialog = host.querySelector('.sheet');
        const edge = host.querySelector('.sheet-status-edge'), rect = dialog.getBoundingClientRect();
        const opaque = node => {
          for (; node; node = node.parentElement) if (getComputedStyle(node).opacity !== '1') return false;
          return true;
        };
        const pixel = color => {
          const context = document.createElement('canvas').getContext('2d');
          context.fillStyle = color; context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data];
        };
        const edgeStyle = getComputedStyle(edge), edgeRect = edge.getBoundingClientRect();
        const backdropY = Math.min(80, rect.top / 2), x = innerWidth / 2;
        const hit = document.elementFromPoint(x, rect.top + Math.min(50, rect.height / 2));
        return {
          opacity: Number(getComputedStyle(backdrop).opacity), color: getComputedStyle(backdrop).backgroundColor,
          dialog: { visible: rect.width > 0 && rect.height > 0 && getComputedStyle(dialog).visibility === 'visible',
            opaque: opaque(dialog), reachable: !!hit && dialog.contains(hit), top: rect.top, height: rect.height },
          backdropReachable: backdropY > 6 && document.elementFromPoint(x, backdropY) === backdrop,
          edge: { visible: edgeStyle.display !== 'none', opaque: opaque(edge), pixel: pixel(edgeStyle.backgroundColor),
            themePixel: pixel(document.querySelector('meta[name="theme-color"]').content),
            position: edgeStyle.position, height: edgeRect.height,
            reachable: [1, x, innerWidth - 1].every(left => document.elementFromPoint(left, 4) === edge) }
        };
      };
      const observer = new MutationObserver(() => {
        if (!host.querySelector('.sheet-overlay')) return;
        observer.disconnect();
        const backdrop = host.querySelector('.sheet-backdrop');
        qa.animation = host.getAnimations({ subtree: true }).find(animation => animation.effect.target.contains(backdrop));
        if (qa.animation) {
          qa.animation.pause(); qa.animation.currentTime = 0;
          qa.timing = qa.animation.effect.getTiming();
        }
        qa.first = qa.read();
      });
      observer.observe(host, { childList: true, subtree: true });
    });
    await click(page, selector, { scroll: false, delay: 0 });
    await page.waitForFunction(() => !!window.__qaSheetScrim.first);
    return page.evaluate(() => ({ first: window.__qaSheetScrim.first, timing: window.__qaSheetScrim.timing || null }));
  }
  const sample = time => page.evaluate(value => {
    const qa = window.__qaSheetScrim;
    qa.animation.currentTime = value;
    return qa.read();
  }, time);
  function immediate(measured, mobile = true) {
    assert.ok(measured.dialog.visible && measured.dialog.opaque && measured.dialog.reachable,
      'the dialog is visible, opaque and hittable in the first frame: ' + JSON.stringify(measured));
    assert.equal(measured.backdropReachable, true, 'the transparent scrim already blocks background taps');
    if (mobile) {
      assert.ok(measured.edge.visible && measured.edge.opaque && measured.edge.reachable);
      assert.equal(measured.edge.position, 'fixed'); assert.ok(measured.edge.height > 10);
      assert.equal(measured.edge.pixel[3], 255, 'the Safari sampling edge is immediately fully opaque');
      assert.deepEqual(measured.edge.pixel, measured.edge.themePixel, 'the edge immediately matches theme-color');
    }
  }
  await check('A fully transparent opening scrim is immediately tappable to cancel a preset review', async () => {
    const opening = await open(chosen); immediate(opening.first); assert.equal(opening.first.opacity, 0);
    await page.mouse.click(195, 80);
    await page.waitForSelector('.sheet-overlay', { hidden: true });
    assert.equal(await page.$eval(chosen, node => node === document.activeElement), true, 'cancel restores the original trigger focus');
  });
  await check('Phone picker, award and gift scrims fade for about 100ms without delaying the dialog or opaque top edge', async () => {
    for (const [name, selector] of [['picker', a('add-points')], ['award', chosen], ['gift', a('jump-rewards')]]) {
      const opening = await open(selector);
      const evidence = { name, ...opening, samples: [] }; report.sheetScrim.push(evidence); progress('Captured ' + name + ' first frame');
      assert.ok(opening.timing, name + ': the actual browser has an opening scrim animation');
      assert.ok(opening.timing.duration >= 80 && opening.timing.duration <= 120, 'the entrance lasts about 100ms');
      assert.equal(opening.timing.delay, 0, 'the scrim starts without a delay');
      assert.equal(opening.first.opacity, 0, 'the entrance starts transparent'); immediate(opening.first);
      const duration = opening.timing.duration;
      for (const time of [0, duration / 2, duration]) {
        const measured = await sample(time); evidence.samples.push({ time, ...measured }); immediate(measured);
        assert.deepEqual(measured.dialog, opening.first.dialog, 'only the scrim changes during the entrance');
        assert.equal(measured.color, opening.first.color, 'the final scrim tint stays unchanged');
        if (name === 'award') await Q.shot(page, 'phone-scrim-' + time + 'ms');
      }
      assert.ok(evidence.samples[1].opacity > .05 && evidence.samples[1].opacity < .95, 'the midpoint visibly progresses');
      assert.equal(evidence.samples[2].opacity, 1, 'the scrim reaches its original final tint');
      if (name === 'award') {
        const held = await sample(duration / 2);
        await click(page, a('points-confirm')); await page.waitForSelector('#parent-form [name="answer"]');
        const rerendered = await page.evaluate(() => window.__qaSheetScrim.read()); evidence.rerendered = rerendered;
        assert.equal(rerendered.opacity, held.opacity, 'rerendering does not flash or restart the held midpoint');
      }
      await Q.home(page);
    }
  });
  await check('Reduced motion and desktop preserve an immediate fully painted scrim', async () => {
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
    const reduced = await open(chosen); report.sheetScrim.push({ name: 'reduced-motion', ...reduced });
    immediate(reduced.first); assert.equal(reduced.timing, null); assert.equal(reduced.first.opacity, 1);
    await Q.home(page);
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
    await metrics(page, 1024, 768, 1024, 768);
    const desktop = await open(chosen); report.sheetScrim.push({ name: 'desktop', ...desktop });
    immediate(desktop.first, false); assert.equal(desktop.timing, null); assert.equal(desktop.first.opacity, 1);
    assert.equal(desktop.first.edge.visible, false, 'the mobile sampling edge remains absent on desktop');
    await Q.home(page);
    assert.deepEqual(await sql(), before, 'motion, review and cancellation never change stored family data');
    assert.deepEqual(await snapshot(page), before.state);
    assert.deepEqual(env.calls.slice(marker).filter(call => !['GET', 'HEAD'].includes(call.method)).map(call => call.path),
      ['/api/parent/challenge'], 'only the explicit verification step requests a challenge; no authorization or award is submitted');
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
async function sync() {
  let sequence = 0;
  async function remoteAction(target, input, protectedAction = true) {
    const before = await env.api(target, '/api/state');
    assert.equal(before.status, 200);
    const action = { ...input, id: 'device-home-sync-' + (++sequence) };
    let grant;
    if (protectedAction) {
      const challenge = await env.api(target, '/api/parent/challenge', 'POST', { revision: before.body.revision, action });
      assert.equal(challenge.status, 200, JSON.stringify(challenge.body));
      const verified = await env.api(target, '/api/parent/verify', 'POST', { challengeId: challenge.body.challengeId, answer: Q.PIN });
      assert.equal(verified.status, 200, JSON.stringify(verified.body)); grant = verified.body.grant;
    }
    const saved = await env.api(target, '/api/action', 'POST', { revision: before.body.revision, action, grant });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    return saved.body;
  }
  const week = '[data-testid="home-week-summary"]';
  const daySummary = index => week + ' .points-summary-day:nth-child(' + index + ') > summary';
  const readSummary = () => page.$eval(week, root => {
    const number = node => Number(node.textContent.match(/\d+/)[0]);
    return {
      stats: [...root.querySelectorAll('.points-summary-stats > div > strong')].map(number),
      days: [...root.querySelectorAll('.points-summary-day')].map(day => ({
        date: day.querySelector('.points-day-summary b').textContent,
        count: number(day.querySelector('.points-day-summary > span:nth-child(2)')),
        points: number(day.querySelector('.points-day-summary > strong')),
        open: day.tagName === 'DETAILS' ? day.open : null,
        records: [...day.querySelectorAll('.points-detail-records > li')].map(row => ({
          name: row.querySelector('strong').textContent, reason: row.querySelector('.points-week-record-reason')?.textContent || '',
          time: row.querySelector('time').textContent, points: number(row.querySelector('b'))
        }))
      })),
      behaviors: [...root.querySelectorAll('.points-summary-behaviors > li')].map(row => ({
        name: row.querySelector('strong').textContent,
        count: number(row.querySelector('b')), points: number(row.querySelector('span:last-child > small'))
      }))
    };
  });
  const readPosition = () => page.evaluate(() => ({
    form: window.FamilyDemo.getUI().form,
    focusedDate: document.activeElement?.matches('.points-summary-day > summary')
      ? document.activeElement.querySelector('b').textContent : null,
    scrollTop: document.querySelector('.sheet-body').scrollTop
  }));
  Q.report.boundaries.push('The sync case submits a real PIN-authorized API award using a second isolated browser session, then waits for the normal five-second browser poll; it does not inject a state, a response, or a refresh event.');
  await check('An open seven-day summary follows a remote award through polling and preserves expanded dates, focus and scroll', async () => {
    await remoteAction(page, { type: 'parent.setup', method: 'pin', pin: Q.PIN, confirmPin: Q.PIN }, false);
    await remoteAction(page, { type: 'points.add', name: '合成昨天已完成', points: 3, reason: '保留昨天展开的明细' });
    await env.setClock(Date.parse('2026-11-20T04:30:00Z'));
    await remoteAction(page, { type: 'points.add', name: '合成今天已完成', points: 5, reason: '保留今天关闭的明细' });
    await reload();
    const other = await env.newPage({ width: 390, height: 844, controlledClock: true });
    await other.goto(env.origin, { waitUntil: 'load' }); await Q.waitView(other, 'login');
    await Q.login(other, email, Q.PASSWORD, familyId); await Q.ready(other, familyId);
    assert.notEqual(other.browserContext(), page.browserContext(), 'the remote endpoint has an independent login session');
    await click(page, a('home-week')); await page.waitForSelector(week);
    const baseline = await readSummary();
    assert.deepEqual(baseline.stats, [8, 2, 2]);
    assert.deepEqual(baseline.days.slice(0, 2).map(day => [day.date, day.open]), [['11月20日', true], ['11月19日', false]]);
    await click(page, daySummary(1)); await click(page, daySummary(2));
    await page.$eval('.sheet-body', body => { body.scrollTop = Math.min(96, body.scrollHeight - body.clientHeight); });
    const before = await readSummary(), position = await readPosition(), beforeUI = await ui(page);
    assert.deepEqual(before.days.slice(0, 2).map(day => day.open), [false, true]);
    assert.equal(position.focusedDate, '11月19日', 'a real summary activation keeps keyboard focus on the selected date');
    assert.ok(position.scrollTop > 0, 'the summary has a nonzero scroll position to preserve');
    const responses = [], reads = [];
    const receive = response => {
      if (new URL(response.url()).pathname !== '/api/state' || response.request().method() !== 'GET') return;
      reads.push(response.json().then(body => responses.push({ status: response.status(), revision: body.revision,
        familyId: body.familyId, hasRemoteAward: body.state?.points.some(row => row.name === '合成远端轮询加分') || false })));
    };
    page.on('response', receive);
    try {
      const saved = await remoteAction(other, { type: 'points.add', name: '合成远端轮询加分', points: 7,
        reason: '另一台设备刚完成的鼓励', at: '2026-11-20T04:29:00.000Z' });
      assert.equal(saved.revision, beforeUI.revision + 1);
      await page.waitForFunction(expected => window.FamilyDemo.getUI().revision === expected &&
        window.FamilyDemo.getState().points.some(row => row.name === '合成远端轮询加分'), { timeout: 8000, polling: 50 }, saved.revision);
      await Promise.all(reads);
      const after = await readSummary(), afterPosition = await readPosition(), receivedUI = await ui(page);
      report.sync = { before, position, after, afterPosition, responses, beforeRevision: beforeUI.revision,
        remoteRevision: saved.revision, receivedRevision: receivedUI.revision,
        receivedInLedger: (await snapshot(page)).points.some(row => row.name === '合成远端轮询加分') };
      progress('Remote award received by the open summary');
      await Q.shot(page, 'sync-open-summary-after-poll');
      assert.ok(responses.some(row => row.status === 200 && row.familyId === familyId && row.revision === saved.revision && row.hasRemoteAward),
        'the real browser poll receives the committed award and its exact family revision');
      assert.equal(afterPosition.form, 'homeWeek', 'the same summary stays open without closing or reopening');
      assert.deepEqual(after.stats, [15, 3, 2], 'the open summary displays the new earned points, award count and active days');
      assert.deepEqual(after.days.slice(0, 2).map(day => [day.date, day.count, day.points]),
        [['11月20日', 2, 12], ['11月19日', 1, 3]], 'the open summary updates its actual per-day totals');
      assert.deepEqual(after.days[0].records.find(row => row.name === '合成远端轮询加分'),
        { name: '合成远端轮询加分', reason: '另一台设备刚完成的鼓励', time: '12:29', points: 7 });
      assert.deepEqual(after.behaviors.find(row => row.name === '合成远端轮询加分'),
        { name: '合成远端轮询加分', count: 1, points: 7 }, 'the open behavior ranking includes the new award');
      assert.deepEqual(after.days.map(day => [day.date, day.open]), before.days.map(day => [day.date, day.open]),
        'polling preserves the user-selected expanded and collapsed dates');
      assert.equal(afterPosition.focusedDate, position.focusedDate, 'polling keeps keyboard focus on the selected date');
      assert.ok(Math.abs(afterPosition.scrollTop - position.scrollTop) <= 1, 'polling preserves the summary scroll position');
      assert.deepEqual(await sql(), { revision: saved.revision, state: saved.state }, 'reading the open summary does not create any extra family write');
    } finally { page.off('response', receive); }
  });
}
async function run() {
  Q.report.boundaries.push('Device home tests use isolated desktop Chromium contexts and explicit viewport/screen metrics; physical iPad/Safari and OS rotation remain unverified.');
  let deadline;
  try {
    await Promise.race([(async () => {
      await setup();
      await ({ phone, 'phone-award': phoneAward, 'phone-award-draft': phoneAwardDraft, 'phone-scrim': phoneScrim, 'desktop-screen': phone, 'phone-landscape': landscape, tablet, preferences, storage, sync })[CASE]();
      assert.deepEqual(Q.report.pageErrors, []);
      assert.deepEqual(hashes(), report.sourceHashes, 'sources changed during device-home evidence run');
      progress('Case complete');
    })(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('device-home group exceeded 50 seconds')), 50000); })]);
  } finally { clearTimeout(deadline); }
}
Q.execute(run);
