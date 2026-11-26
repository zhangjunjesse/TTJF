'use strict';

// Short, isolated gift checks. Uses no real family or production service.
// GIFT_ROUND_STAGE=baseline|final GIFT_ROUND_CASE=catalog|cancel|flow node test/gift-round-browser.cjs
// GIFT_ROUND_SNAPSHOT=1 explicitly reuses a frozen frontend during parallel UI work.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const stage = process.env.GIFT_ROUND_STAGE || 'baseline';
const selected = process.env.GIFT_ROUND_CASE || 'catalog';
const useSnapshot = process.env.GIFT_ROUND_SNAPSHOT === '1';
assert.ok(['baseline', 'final'].includes(stage));
assert.ok(['catalog', 'cancel', 'flow'].includes(selected));
const STATIC_ROOT = path.join(ROOT, 'data', 'ui-home-visual', 'gift-round', 'final', 'static-root');
const staticManifest = path.join(STATIC_ROOT, 'snapshot.json');
if (useSnapshot && !fs.existsSync(staticManifest)) {
  // Freeze public frontend files once, while the root agent continues unrelated
  // home layout edits. All three final cases serve the exact same snapshot.
  fs.mkdirSync(STATIC_ROOT, { recursive: true });
  const publicFiles = fs.readdirSync(ROOT, { withFileTypes: true }).filter(entry => entry.isFile() && /\.(?:html|css|js|webmanifest)$/.test(entry.name)).map(entry => entry.name);
  const sourceHashes = Object.fromEntries(publicFiles.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex')]));
  for (const file of publicFiles) fs.copyFileSync(path.join(ROOT, file), path.join(STATIC_ROOT, file));
  fs.cpSync(path.join(ROOT, 'assets'), path.join(STATIC_ROOT, 'assets'), { recursive: true });
  for (const file of publicFiles) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(STATIC_ROOT, file))).digest('hex'), sourceHashes[file], 'Snapshot source changed while copying: ' + file);
  fs.writeFileSync(staticManifest, JSON.stringify({ createdAt: new Date().toISOString(), sourceRoot: ROOT, publicFiles, sourceHashes }, null, 2) + '\n');
  console.log('Frozen public static frontend: ' + STATIC_ROOT);
}
const SOURCE_ROOT = useSnapshot ? STATIC_ROOT : ROOT;
const OUT = path.join(ROOT, 'data', 'ui-home-visual', 'gift-round', stage, selected);
fs.mkdirSync(OUT, { recursive: true });
// Keep earlier evidence when a visual correction causes this short group to rerun.
const previousFile = path.join(OUT, 'results.json');
if (fs.existsSync(previousFile)) {
  const previous = JSON.parse(fs.readFileSync(previousFile, 'utf8'));
  const archive = path.join(OUT, 'attempts', previous.startedAt.replace(/[^0-9]/g, ''));
  fs.mkdirSync(archive, { recursive: true });
  const previousFiles = ['results.json', 'seed-state.json', 'run.log', ...previous.screenshots.map(item => path.basename(item.file))];
  for (const name of new Set(previousFiles)) if (fs.existsSync(path.join(OUT, name))) fs.copyFileSync(path.join(OUT, name), path.join(archive, name));
}
process.env.TEST_ARTIFACT_DIR = path.join(OUT, 'fixture');
const Q = require('./saas-browser.cjs');
const { B, M, PIN, click, action: a } = Q;
const SAVE = '.sheet button.sheet-save[type="submit"][form="editor-form"]';
const NOW = Date.parse('2026-11-23T12:30:00Z');
const files = ['app.js', 'home-points.js', 'home-points.css', 'styles.css', 'farm-world.css', 'index.html', 'saas-client.js'];
const hashes = (directory = SOURCE_ROOT) => Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex')]));
const report = { stage, case: selected, command: 'GIFT_ROUND_STAGE=' + stage + ' GIFT_ROUND_CASE=' + selected + (useSnapshot ? ' GIFT_ROUND_SNAPSHOT=1' : '') + ' node test/gift-round-browser.cjs',
  status: 'running', startedAt: new Date().toISOString(), viewport: { width: 390, height: 700 },
  isolation: 'Synthetic family in a fresh temporary SQLite file and ephemeral loopback SaaS; no real records or external mail.',
  boundary: '390x700 Chromium CSS content viewport; native phone/iPad/Safari and safe areas are not verified.',
  sourceRoot: SOURCE_ROOT, sourceHashes: hashes(), liveSourceHashes: hashes(ROOT), screenshots: [], checks: [], steps: [] };
Q.report.command = report.command;
Q.report.nodeCommand = 'node test/gift-round-browser.cjs';
Q.report.boundaries.push(report.isolation, report.boundary);
function persist() { fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(report, null, 2) + '\n'); }
function progress(message) {
  const line = new Date().toISOString() + ' ' + message;
  report.steps.push(line); fs.appendFileSync(path.join(OUT, 'run.log'), line + '\n'); persist(); console.log(line);
}
let env, page, familyId, sequence = 0;
async function shot(name) {
  await page.evaluate(async () => { if (document.fonts) await document.fonts.ready; });
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file, fullPage: false });
  report.screenshots.push({ name, file }); persist();
}
async function sql() { return (await env.database.query('SELECT revision,state FROM saas_families WHERE id=$1', [familyId])).rows[0]; }
async function fixtureAction(input, protectedAction = true) {
  const current = await env.api(page, '/api/state'); assert.equal(current.status, 200);
  const action = { ...input, id: 'gift-round-' + (++sequence) };
  let grant;
  if (protectedAction) {
    const challenge = await env.api(page, '/api/parent/challenge', 'POST', { revision: current.body.revision, action });
    assert.equal(challenge.status, 200, JSON.stringify(challenge.body));
    const verified = await env.api(page, '/api/parent/verify', 'POST', { challengeId: challenge.body.challengeId, answer: PIN });
    assert.equal(verified.status, 200, JSON.stringify(verified.body)); grant = verified.body.grant;
  }
  const result = await env.api(page, '/api/action', 'POST', { revision: current.body.revision, action, grant });
  assert.equal(result.status, 200, JSON.stringify(result.body));
}
async function setup() {
  Q.phase('gift-round-' + stage + '-' + selected); progress('Creating isolated SaaS/SQLite fixture');
  env = await Q.initialize(useSnapshot ? { staticRoot: STATIC_ROOT } : undefined); env.clock(NOW);
  page = await env.newPage({ width: 390, height: 700, controlledClock: true }); Q.active(page); page.setDefaultTimeout(7000);
  report.browserVersion = await page.browser().version();
  const session = await page.createCDPSession();
  await session.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 700, deviceScaleFactor: 1, mobile: false, screenWidth: 390, screenHeight: 700 });
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await Q.registerAndVerify(page, 'gift-round-' + Q.RUN + '@example.test');
  familyId = await Q.createFamily(page, '合成视觉核对家庭', '小宝');
  await fixtureAction({ type: 'parent.setup', method: 'pin', pin: PIN, confirmPin: PIN }, false);
  progress('Synthetic account, family and parent PIN ready');
  const habits = [['阅读十分钟', '安静读完了一本故事书'], ['整理书包', '主动把学习用品放整齐'], ['按时起床', '闹钟响后自己起床'], ['主动分享', '把喜欢的玩具分享给朋友']];
  for (let i = 0; i < habits.length; i++) await fixtureAction({ type: 'pointItem.save', item: { id: 'visual-habit-' + i, name: habits[i][0], reason: habits[i][1], points: 2, enabled: true } });
  for (let days = 5; days >= 1; days--) {
    env.clock(NOW - days * 86400000);
    await fixtureAction({ type: 'points.add', name: habits[days % habits.length][0], points: 1, reason: '完成一个小进步' });
  }
  env.clock(NOW);
  for (let i = 0; i < habits.length; i++) await fixtureAction({ type: 'points.add', itemId: 'visual-habit-' + i, reason: habits[i][1], at: new Date(NOW - (3 - i) * 3600000).toISOString() });
  await fixtureAction({ type: 'reward.save', reward: { id: 'gift-round-pencil', name: '彩色铅笔', points: 8, category: 'daily', enabled: true, icon: 'pencil' } });
  await fixtureAction({ type: 'reward.save', reward: { id: 'gift-round-book', name: '故事绘本', points: 20, category: 'daily', enabled: true, icon: 'pencil' } });
  progress('Synthetic habits, history and two gift prices saved');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => { const s = window.FamilySaas?.status(); return s && (s.ready || s.view === 'families'); });
  if ((await Q.status(page)).view === 'families') await click(page, Q.sa('select-family', familyId));
  await Q.ready(page, familyId); await Q.home(page); await B.homeView(page, 'points');
  assert.deepEqual(M.totals(await Q.snapshot(page)), { earned: 13, spent: 0, available: 13 });
  report.seed = { childName: '小宝', totals: { earned: 13, spent: 0, available: 13 }, historyCount: 9, habits: habits.map(row => row[0]), rewards: [{ id: 'gift-round-pencil', name: '彩色铅笔', points: 8 }, { id: 'gift-round-book', name: '故事绘本', points: 20 }] };
  if (stage === 'final') {
    const baseline = path.join(ROOT, 'data', 'ui-home-visual', 'gift-round', 'baseline', 'catalog', 'results.json');
    if (fs.existsSync(baseline)) {
      const original = JSON.parse(fs.readFileSync(baseline, 'utf8'));
      assert.equal(original.status, 'passed', 'The comparison baseline passed');
      assert.deepEqual(report.seed, original.seed, 'Final capture uses identical synthetic names, history, prices and balances');
      report.baseline = baseline;
    }
  }
  fs.writeFileSync(path.join(OUT, 'seed-state.json'), JSON.stringify(await Q.snapshot(page), null, 2) + '\n');
  progress('Fixture ready: 13 earned / 13 available; affordable 8 and unaffordable 20');
}
async function openCatalog() { await Q.home(page); await click(page, a('jump-rewards')); await page.waitForSelector('.reward-card', { visible: true }); await B.delay(100); }
async function checkPageEdge(name, expectedForm) {
  if (stage !== 'final') return null;
  const edge = await page.evaluate(name => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    const rgba = value => {
      if (!value || !CSS.supports('color', value)) throw new Error('Invalid page-edge color: ' + value);
      context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    const header = document.querySelector('.app-shell > .home-header');
    const sheet = document.querySelector('.sheet'), backdrop = document.querySelector('.sheet-overlay > .sheet-backdrop');
    const rect = sheet && sheet.getBoundingClientRect();
    return { name, viewport: { width: innerWidth, height: innerHeight },
      theme: rgba(document.querySelector('meta[name="theme-color"]')?.content),
      html: rgba(getComputedStyle(document.documentElement).backgroundColor), body: rgba(getComputedStyle(document.body).backgroundColor),
      header: rgba(getComputedStyle(header).backgroundColor), headerBottom: header.getBoundingClientRect().bottom,
      backdrop: backdrop ? rgba(getComputedStyle(backdrop).backgroundColor) : null,
      form: sheet ? sheet.getAttribute('data-form-kind') : null,
      sheet: rect ? { top: rect.top, bottom: rect.bottom, height: rect.height } : null };
  }, name);
  (report.pageEdges || (report.pageEdges = [])).push(edge); persist();
  assert.deepEqual(edge.viewport, { width: 390, height: 700 }, name + ': uses the phone viewport');
  assert.equal(edge.form, expectedForm, name + ': expected sheet remains open');
  assert.equal(edge.header[3], 255, name + ': home header is opaque');
  if (expectedForm) {
    assert.ok(edge.backdrop && edge.backdrop[3] > 0 && edge.backdrop[3] < 255, name + ': backdrop dims the home');
    assert.ok(edge.sheet.top > edge.headerBottom, name + ': sheet keeps the upper home visible');
    assert.ok(Math.abs(edge.sheet.bottom - edge.viewport.height) <= 1, name + ': sheet stays flush with the bottom');
  } else {
    assert.equal(edge.sheet, null, name + ': final sheet is closed');
    assert.equal(edge.backdrop, null, name + ': no backdrop remains on home');
  }
  const alpha = edge.backdrop ? edge.backdrop[3] / 255 : 0;
  const expected = edge.header.slice(0, 3).map((channel, i) => Math.round(channel * (1 - alpha) + (edge.backdrop ? edge.backdrop[i] * alpha : 0)));
  for (const source of ['theme', 'html', 'body']) {
    assert.equal(edge[source][3], 255, name + ': ' + source + ' edge color is opaque');
    assert.deepEqual(edge[source], edge.theme, name + ': ' + source + ' matches the normalized theme color');
    assert.ok(expected.every((channel, i) => Math.abs(edge[source][i] - channel) <= 2), name + ': ' + source + ' matches header plus backdrop: ' + JSON.stringify({ actual: edge[source], expected }));
  }
  return edge;
}
async function catalog() {
  await Q.check('Gift catalog and cancellable details accurately show balance and cost without writes', async () => {
    const before = await sql(), marker = env.calls.length;
    const homeEdge = await checkPageEdge('home', null);
    await shot('01-home'); await openCatalog(); await checkPageEdge('catalog', 'rewards');
    report.catalog = await page.$eval('.sheet', node => ({ text: node.innerText, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }));
    assert.match(report.catalog.text, /13/); assert.match(report.catalog.text, /彩色铅笔/); assert.match(report.catalog.text, /故事绘本/);
    for (const [id, points] of [['gift-round-pencil', 8], ['gift-round-book', 20]]) {
      assert.match(await page.$eval(a('redeem', id), node => node.textContent), new RegExp(String(points)));
    }
    await shot('02-catalog');
    await click(page, a('redeem', 'gift-round-book'));
    report.unaffordable = await page.$eval('.sheet', node => node.innerText);
    assert.equal(await page.$eval(SAVE, node => node.disabled), true);
    assert.match(report.unaffordable, /20/); assert.match(report.unaffordable, /13/);
    await checkPageEdge('unaffordable-detail', 'request');
    await shot('03-unaffordable');
    await click(page, '.sheet-header ' + a('form-close'));
    await checkPageEdge('back-from-unaffordable', 'rewards');
    if ((await Q.ui(page)).form !== 'rewards') await openCatalog();
    await click(page, a('redeem', 'gift-round-pencil'));
    report.affordable = await page.$eval('.sheet', node => node.innerText);
    assert.equal(await page.$eval(SAVE, node => node.disabled), false);
    assert.match(report.affordable, /8/); assert.match(report.affordable, /13/); assert.match(report.affordable, /5/);
    await checkPageEdge('affordable-detail', 'request');
    await shot('04-affordable');
    await click(page, '.sheet-header ' + a('form-close'));
    await checkPageEdge('back-from-affordable', 'rewards');
    if (stage === 'final') {
      await click(page, '.sheet-header ' + a('form-close'));
      const restoredEdge = await checkPageEdge('home-restored', null);
      for (const source of ['theme', 'html', 'body']) assert.deepEqual(restoredEdge[source], homeEdge[source], source + ' returns to its original home color');
      report.checks.push('Phone theme-color, html and body stay opaque and match the header/backdrop composite through catalog, both details and return; bottom sheets preserve the upper home; closing restores the original home colors');
    }
    assert.deepEqual(await sql(), before, 'Catalog and cancelled detail leave SQLite unchanged');
    assert.deepEqual(env.calls.slice(marker).filter(call => !['GET', 'HEAD'].includes(call.method)), [], 'Catalog and cancellation make no mutations');
    report.checks.push('Home -> catalog shows 13 available, cost 8 and cost 20; insufficient gift cannot submit; affordable gift previews 5 remaining; both cancel with no API mutations or SQLite changes');
    progress('Catalog baseline/checkpoint screenshots saved');
  });
  if (stage === 'final') await Q.check('Full-screen assistant restores the light phone edge and returns to the dimmed catalog', async () => {
    await openCatalog();
    await click(page, '.sheet-header ' + a('assistant-open'));
    await page.waitForFunction(() => FamilyAssistantPanel.getState().loaded && FamilyAssistantPanel.isOpen());
    assert.deepEqual(await page.evaluate(() => ({
      theme: document.querySelector('meta[name="theme-color"]').content,
      root: getComputedStyle(document.documentElement).backgroundColor
    })), { theme: '#fdfdfb', root: 'rgb(253, 253, 251)' });
    await click(page, 'button[data-assistant-action="close"]');
    await checkPageEdge('back-from-assistant', 'rewards');
  });
}
async function cancel() {
  await Q.check('One click cancels the freshly submitted request in the same catalog and permits a deliberate new request', async () => {
    await openCatalog();
    const before = await sql(), marker = env.calls.length;
    await click(page, a('redeem', 'gift-round-pencil')); await click(page, SAVE); await Q.settled(page);
    assert.equal((await Q.ui(page)).form, 'rewards', 'A submitted request returns directly to its catalog');
    const pending = (await sql()).state.requests.find(row => row.status === 'pending'); assert.ok(pending);
    assert.deepEqual(M.totals((await sql()).state), M.totals(before.state), 'Request does not debit points');
    await shot('05-request-pending');
    await click(page, a('redemption-cancel', pending.id)); await Q.settled(page);
    const cancelled = await sql();
    assert.equal(cancelled.state.requests.find(row => row.id === pending.id).status, 'cancelled', 'The first cancel click persists immediately');
    assert.equal(cancelled.state.redemptions.length, 0);
    assert.deepEqual(M.totals(cancelled.state), M.totals(before.state));
    assert.equal((await Q.ui(page)).auth, false, 'Cancellation needs no parent verification');
    assert.equal(await page.$(a('redemption-cancel', pending.id)), null, 'Cancelled pending strip disappears in the same catalog');
    await shot('06-request-cancelled');
    await click(page, a('redeem', 'gift-round-pencil')); await click(page, SAVE); await Q.settled(page);
    const retried = await sql();
    assert.equal(retried.state.requests.filter(row => row.status === 'pending').length, 1);
    assert.notEqual(retried.state.requests.find(row => row.status === 'pending').id, pending.id);
    assert.equal(retried.state.redemptions.length, 0);
    assert.deepEqual(M.totals(retried.state), M.totals(before.state));
    await shot('07-request-retried');
    const actions = env.calls.slice(marker).filter(call => call.path === '/api/action' && call.action);
    assert.equal(actions.filter(call => call.action.type === 'redemption.request').length, 2, 'Two deliberate submissions make two requests');
    assert.equal(actions.filter(call => call.action.type === 'redemption.cancel').length, 1, 'One click makes one cancellation');
    assert.equal(env.calls.slice(marker).filter(call => call.path === '/api/parent/challenge').length, 0);
    report.operations = actions.map(call => call.action);
    report.checks.push('Submit request, remain in the same catalog, cancel with one click and no parent challenge, then request again; no redemptions and balance stays 13');
    progress('Same-catalog one-click cancellation and deliberate resubmission passed');
  });
}
async function flow() {
  await Q.check('One gift request and parent-approved debit survive a lost success response', async () => {
    await openCatalog();
    const before = await sql(), marker = env.calls.length;
    await click(page, a('redeem', 'gift-round-pencil')); await click(page, SAVE); await Q.settled(page);
    const requested = await sql();
    assert.equal(requested.state.requests.filter(row => row.status === 'pending').length, 1);
    assert.deepEqual(M.totals(requested.state), M.totals(before.state), 'Request does not debit points');
    await openCatalog(); await shot('05-request-pending');
    const requestId = requested.state.requests.find(row => row.status === 'pending').id;
    await click(page, a('redemption-approve', requestId)); await shot('06-parent-review');
    await click(page, SAVE); await page.waitForSelector('#parent-form [name="answer"]', { visible: true });
    await B.fill(page, '#parent-form [name="answer"]', PIN);
    await shot('07-parent-pin');
    await page.evaluate(() => {
      const nativeSend = XMLHttpRequest.prototype.send; let armed = true;
      XMLHttpRequest.prototype.send = function () {
        if (armed && this.__qaPath === '/api/action') {
          armed = false; const xhr = this, onload = xhr.onload;
          xhr.onload = function (event) {
            if (xhr.status === 200) { window.__giftLostResponse = true; xhr.ontimeout(); }
            else onload.call(xhr, event);
          };
        }
        return nativeSend.apply(this, arguments);
      };
    });
    await B.click(page, Q.parentSubmit, { clickCount: 2 });
    await page.waitForFunction(() => { const s = window.FamilyDemo.getUI(); return !s.auth && !s.pending; });
    await Q.settled(page);
    assert.equal(await page.evaluate(() => window.__giftLostResponse), true, 'Success response is genuinely discarded after server commit');
    const after = await sql();
    assert.deepEqual(M.totals(after.state), { earned: 13, spent: 8, available: 5 });
    assert.equal(after.state.redemptions.filter(row => row.rewardId === 'gift-round-pencil').length, 1);
    assert.equal(after.state.requests.find(row => row.id === requestId).status, 'approved');
    assert.deepEqual(await Q.snapshot(page), after.state, 'Retry reconciliation loads the authoritative persisted state');
    const actions = env.calls.slice(marker).filter(call => call.path === '/api/action' && call.action);
    report.operations = actions.map(call => call.action);
    assert.equal(actions.filter(call => call.action.type === 'redemption.request').length, 1);
    assert.equal(actions.filter(call => call.action.type === 'redemption.approve').length, 1);
    report.receiptText = await page.$eval('#toast', node => node.innerText);
    assert.match(report.receiptText, /彩色铅笔/);
    assert.match(report.receiptText, /扣\s*8\s*分/);
    assert.match(report.receiptText, /剩\s*5\s*分/);
    await shot('08-final-receipt');
    await page.waitForFunction(() => !document.getElementById('toast')?.textContent.trim(), { timeout: 6000 });
    await openCatalog(); await click(page, a('rewards-history'));
    const recordText = await page.$eval('.record-list', node => node.innerText);
    assert.match(recordText, /彩色铅笔/); assert.match(recordText, /8/);
    report.finalReceiptText = recordText; await shot('09-final-history');
    await Q.home(page); await B.homeView(page, 'points');
    assert.equal(await page.$eval('[data-testid="earned-points"]', node => Number(node.textContent)), 13);
    assert.equal(await page.$eval('[data-testid="available-points"]', node => Number(node.textContent)), 5);
    await shot('10-home-after-debit');
    report.finalTotals = M.totals(after.state); report.finalState = after.state;
    report.checks.push('Request keeps balance 13; parent double-submit approves and debits exactly 8 once; discarded success response reconciles without duplicate operation; one receipt in history; home keeps 13 earned / 5 available');
    progress('Approval, one debit, lost-response reconciliation and receipt passed');
  });
}
persist();
Q.execute(async () => {
  await setup(); await ({ catalog, cancel, flow })[selected]();
  assert.deepEqual(Q.report.pageErrors, []); report.checks.push('No uncaught browser errors');
  report.finalSourceHashes = hashes(); report.sourceStable = JSON.stringify(report.sourceHashes) === JSON.stringify(report.finalSourceHashes);
  report.finalLiveSourceHashes = hashes(ROOT);
  report.liveSourceChanges = files.filter(file => report.liveSourceHashes[file] !== report.finalLiveSourceHashes[file]);
  assert.ok(report.sourceStable, 'Measured source files changed during the check');
}).then(() => {
  report.status = Q.report.result; report.finishedAt = new Date().toISOString(); report.errors = Q.report.failed;
  report.fixtureReport = path.join(Q.OUT, 'report.json'); persist(); progress('Finished: ' + report.status);
}).catch(error => { report.status = 'failed'; report.error = error.stack; persist(); fs.appendFileSync(path.join(OUT, 'run.log'), error.stack + '\n'); console.error(error); process.exitCode = 1; });
