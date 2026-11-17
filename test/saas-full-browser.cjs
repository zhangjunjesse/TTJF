'use strict';
// v15: real UI -> authorization -> HTTP -> SQLite. All data is synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Q = require('./saas-browser.cjs');
const { B, M, PIN, PASSWORD, RUN, OUT, action: a, click, type, snapshot, totals, ui, save, parentSubmit } = Q;
const { createAssistantService } = require('../assistant-service.cjs');
const DAY = 86400000;
const NEW_PIN = '135790';
const CHANGED_PASSWORD = 'SaaS-QA-Changed-2026!';
let env, page, familyId, ownerEmail, currentPin = PIN, currentPassword = PASSWORD;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const form = values => B.fillForm(page, values);
const state = () => snapshot(page);
const nowDate = () => M.dateKey(new Date(env.now()), 'Asia/Shanghai');
const day = offset => M.addDays(nowDate(), offset, 'Asia/Shanghai');
const calls = route => env.calls.filter(call => call.path === route);
async function sql() { return (await env.database.query('SELECT revision,state FROM saas_families WHERE id=$1', [familyId])).rows[0]; }
async function proof(label) {
  await Q.settled(page);
  const browserState = await state(), http = await env.api(page, '/api/state'), databaseRow = await sql();
  assert.equal(http.status, 200); assert.equal(http.body.familyId, familyId);
  assert.deepEqual(browserState, http.body.state, label + ': UI/HTTP state');
  assert.deepEqual(databaseRow.state, browserState, label + ': SQLite state');
  assert.equal(Number(databaseRow.revision), http.body.revision);
  Q.report.persistence.push({ label, familyId, revision: Number(databaseRow.revision), stateSha256: hash(databaseRow.state), totals: M.totals(databaseRow.state) });
  return browserState;
}
async function selectAfterReload() {
  await page.waitForFunction(() => { const s = window.FamilySaas && window.FamilySaas.status(); return s && (s.ready || s.view === 'families'); }, { timeout: 12000 });
  if ((await Q.status(page)).view === 'families') await click(page, Q.sa('select-family', familyId));
  await Q.ready(page, familyId);
}
async function reloadProof(label) {
  const before = await state(); await page.reload({ waitUntil: 'load' }); await selectAfterReload();
  assert.deepEqual(await state(), before, label + ': reload'); await proof(label);
}
async function waitNoAuth() { await page.waitForFunction(() => !window.FamilyDemo.getUI().auth && !window.FamilyDemo.getUI().pending, { timeout: 12000 }); }
async function answer(value) {
  await page.waitForSelector('#parent-form [name="answer"]', { timeout: 10000 });
  await type(page, '#parent-form [name="answer"]', value); await click(page, parentSubmit);
}
async function authorize(label, trigger = save) {
  const before = await sql(), marker = env.calls.length;
  await click(page, trigger); await page.waitForSelector('#parent-form [name="answer"]', { timeout: 10000 });
  assert.deepEqual(await sql(), before, label + ': confirmation must precede persistence');
  let value = currentPin;
  if (await Q.visible(page, '.math-question')) {
    const text = await page.$eval('.math-question', node => node.textContent), match = text.match(/(\d+)\s*([+×*−-])\s*(\d+)/);
    assert.ok(match, 'Visible arithmetic question');
    value = String(match[2] === '+' ? +match[1] + +match[3] : ['×', '*'].includes(match[2]) ? +match[1] * +match[3] : +match[1] - +match[3]);
  }
  await answer(value); await waitNoAuth();
  const recent = env.calls.slice(marker);
  assert.ok(recent.some(call => call.path === '/api/parent/challenge'));
  assert.ok(recent.some(call => call.path === '/api/parent/verify'));
  assert.ok(recent.some(call => call.path === '/api/action' && call.action && call.action.hasGrant), label + ': operation-bound grant');
  return proof(label);
}
async function publicClick(label, selector) {
  const challenges = calls('/api/parent/challenge').length;
  await click(page, selector); await Q.settled(page);
  assert.equal(calls('/api/parent/challenge').length, challenges, label + ': public action');
  assert.equal((await ui(page)).auth, false); return proof(label);
}
async function setup() {
  await click(page, a('preferences')); await click(page, a('parent-config'));
  await form({ pin: PIN, confirmPin: PIN }); await click(page, save);
  await page.waitForFunction(() => window.FamilyDemo.getUI().parentConfigured === true); await Q.home(page); currentPin = PIN;
}
async function credit(points, reason = '合成业务事实') {
  await Q.home(page); await click(page, a('add-points')); await click(page, a('points-new'));
  await form({ name: '合成自定义加分', points, reason }); return authorize('points.add ' + points);
}
async function templates() { await Q.home(page); await click(page, a('all-behaviors')); await click(page, a('point-list')); }
async function gifts() { await Q.home(page); await click(page, a('jump-rewards')); }
async function reminders() { await Q.home(page); await B.navigate(page, 'reminders'); }
async function preferences(target) { await Q.home(page); await click(page, a('preferences')); if (target) await click(page, a(target)); }
async function saasSubmit(method, route, values, expected = 200) {
  await Q.fillSaas(page, values);
  const response = page.waitForResponse(result => result.request().method() === method && new URL(result.url()).pathname === route);
  await click(page, Q.submit); const result = await response; assert.equal(result.status(), expected, method + ' ' + route);
  await page.waitForFunction(() => { const s = window.FamilySaas.status(); return !s.pending && !['checking', 'loading-family'].includes(s.view); });
  return result.json();
}
async function familyMenu(target) { await Q.account(page); await click(page, Q.sa('family-settings')); if (target) await click(page, Q.sa(target)); }
async function usingPage(target, id, fn) {
  const previousPage = page, previousFamily = familyId; page = target; familyId = id; Q.active(page);
  try { await page.bringToFront(); return await fn(); }
  finally { page = previousPage; familyId = previousFamily; Q.active(page); }
}
async function invite(email) {
  await Q.account(page); await click(page, Q.sa('members')); await page.waitForSelector('#saas-form[data-saas-form="invitation"]');
  const before = env.captured.length, response = page.waitForResponse(result => result.request().method() === 'POST' && new URL(result.url()).pathname.endsWith('/invitations'));
  await Q.fillSaas(page, { email }); await click(page, Q.submit); assert.equal((await response).status(), 200);
  return env.mailLink(email, 'invite', before);
}
async function accept(invitee, link, id) {
  await invitee.goto(link, { waitUntil: 'load' }); await Q.waitView(invitee, 'invite'); await click(invitee, Q.sa('accept-invite')); await Q.ready(invitee, id);
}
async function visibility(hidden) {
  await page.evaluate(value => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value ? 'hidden' : 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}
async function makeReward(name, points, category = 'daily') {
  await gifts(); await click(page, a('reward-new')); await form({ name, points, category }); await authorize('reward.save ' + name);
  return (await state()).rewards.find(item => item.name === name).id;
}
async function group(name, fn) {
  Q.phase(name); Q.active(page);
  if (process.env.SAAS_FULL_GROUPS && !process.env.SAAS_FULL_GROUPS.split(',').includes(name)) { Q.report.skipped.push(name + ': not selected in targeted run'); return; }
  if (!Q.includesPhase(name)) { Q.report.skipped.push(name + ': no selected checks'); return; }
  try {
    await env.setClock(env.now() + 16 * 60000);
    if (!(await Q.status(page)).ready) {
      await page.goto(env.origin, { waitUntil: 'load' });
      if ((await Q.status(page)).view === 'login') await Q.login(page, ownerEmail, currentPassword);
    }
    familyId = await Q.createFamily(page, '合成审查-' + name, '合成孩子-' + name); Q.assertEmpty(await state(), '合成孩子-' + name);
    await setup(); await fn();
    if (!(await Q.status(page)).ready && familyId) await Q.switchFamily(page, familyId);
    await reloadProof(name + ' final persisted state');
  } catch (error) {
    Q.fail(error, error.check || name); console.error('FAIL ' + name + ': ' + error.message);
    Q.report.skipped.push(name + ': any dependent steps after this group failure were not executed; other independent families continue');
    Q.report.failureContexts.push({ group: name, status: await Q.status(page).catch(() => null), ui: await ui(page).catch(() => null), visibleErrors: await page.$$eval('#form-error:not([hidden]),#parent-error:not([hidden]),.saas-message', nodes => nodes.map(node => node.textContent)).catch(() => []) });
    await Q.shot(page, 'failure-' + name).catch(() => {});
  }
}
async function run() {
  // Existing cases retain their names. Only required earlier cases execute as
  // setup; those are recorded separately and do not count as selected coverage.
  const cases = [], groups = new Map(); let groupName;
  for (const line of fs.readFileSync(__filename, 'utf8').split(/\r?\n/)) {
    const groupMatch = /^  await group\('([^']+)'/.exec(line);
    if (groupMatch) groupName = groupMatch[1];
    if (line.includes("Q.phase('final')")) groupName = 'final';
    const match = /await Q\.check\('([^']+)'/.exec(line);
    if (!match) continue;
    const previous = groups.get(groupName) || [];
    const independent = ['profile-partners', 'parent-settings', 'recovery', 'farm-catalog', 'final'].includes(groupName) ||
      (groupName === 'reminders' && previous.length === 2) || (groupName === 'assistant-export' && previous.length === 1) ||
      (groupName === 'family-account-lifecycle' && previous.length === 3);
    const dependency = groupName === 'assistant-export' && previous.length === 2 ? previous[0] :
      groupName === 'family-account-lifecycle' && previous.length === 2 ? previous[0] : previous.at(-1);
    cases.push({ label: match[1], phase: groupName, dependencies: independent || !dependency ? [] : [dependency] });
    previous.push(match[1]); groups.set(groupName, previous);
  }
  Q.configureSelection(cases);
  Q.report.continueAfterGroupFailure = true; Q.report.selection = process.env.SAAS_FULL_GROUPS || 'all'; Q.report.persistence = []; Q.report.failureContexts = [];
  Q.report.boundaries.push('Full-suite assistant uses the real local instruction parser through HTTP with apiKey explicitly empty; no external AI provider is called. One named input throws a controlled provider failure to verify the HTTP503 recovery path.', 'Reminder cases control browser Date/performance offsets and the injected server clock while real foreground timers run; not device background notification validation.', 'Speech recognition API is deliberately unavailable to verify the typing fallback; no microphone or external speech provider is tested.');
  const localAssistant = createAssistantService({ apiKey: '' });
  env = await Q.initialize({ assistantService: { status: localAssistant.status, interpret: (...args) => { if (args[0] === '合成服务故障') throw new Error('Synthetic provider failure'); return localAssistant.interpret(...args); } } });
  env.clock(Date.parse('2026-11-16T04:30:00Z'));
  page = await env.newPage({ controlledClock: true }); Q.active(page);
  await page.evaluateOnNewDocument(() => { window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; });
  ownerEmail = 'full-owner-' + RUN + '@example.test';
  await Q.registerAndVerify(page, ownerEmail);

  await group('points', async () => {
    let id;
    await Q.check('Template create/edit/disable/enable preserves authorized ledger snapshots', async () => {
      await templates(); await click(page, a('point-item-new'));
      await form({ name: '合成整理书包', points: 7, reason: '主动整理好书包' }); await authorize('create point template');
      id = (await state()).pointItems.find(item => item.name === '合成整理书包').id;
      assert.equal((await totals(page)).earned, 0);
      await Q.home(page); await click(page, a('choose-point', id));
      assert.equal(await page.$eval('[name="reason"]', node => node.value), '主动整理好书包');
      await authorize('award from template'); assert.equal((await totals(page)).earned, 7);
      await templates(); await click(page, a('point-item-edit', id));
      await form({ name: '合成整理书包改', points: 11, reason: '自己分类整理书本', enabled: 'false' }); await authorize('disable edited template');
      assert.equal((await state()).points[0].points, 7); assert.equal((await state()).points[0].name, '合成整理书包');
      await Q.home(page); assert.equal(await page.$(a('choose-point', id)), null);
      await templates(); await click(page, a('point-item-edit', id)); await form({ enabled: 'true' }); await authorize('re-enable template');
      await Q.home(page); assert.ok(await page.$(a('choose-point', id))); await Q.shot(page, 'points-template-updated');
    });
    await Q.check('Custom award validation, save-as-template, record display and history use real persisted amounts', async () => {
      await Q.home(page); await click(page, a('add-points')); await click(page, a('points-new'));
      const before = await sql(); await form({ name: '合成独立完成', points: 13, reason: '' }); await click(page, save);
      assert.equal((await ui(page)).auth, false); assert.deepEqual(await sql(), before);
      await form({ reason: '独立完成今天的拼图' });
      await page.$eval('[name="saveAsTemplate"]', node => { node.checked = true; node.dispatchEvent(new Event('change', { bubbles: true })); });
      await authorize('custom award saves template'); assert.equal((await totals(page)).earned, 20);
      assert.ok((await state()).pointItems.some(item => item.name === '合成独立完成'));
      await Q.home(page); await click(page, a('records')); assert.match(await page.$eval('.sheet', node => node.textContent), /独立完成今天的拼图/);
      await Q.audit(page, 'phone-points-records');
    });
  });

  await group('rewards', async () => {
    await credit(100); let rewardId, requestId;
    await Q.check('Gift CRUD states and child request/cancel/switch do not spend family points', async () => {
      rewardId = await makeReward('合成画笔', 40);
      await gifts(); await click(page, a('redeem', rewardId)); await publicClick('request gift', save);
      requestId = (await state()).requests.find(row => row.status === 'pending').id; assert.equal((await totals(page)).available, 100);
      await gifts(); await publicClick('cancel gift request', a('redemption-cancel', requestId));
      assert.equal((await state()).requests.find(row => row.id === requestId).status, 'cancelled');
      const alternate = await makeReward('合成画纸', 30);
      await gifts(); await click(page, a('redeem', alternate)); await publicClick('request alternate gift', save);
      await gifts(); await click(page, a('redeem', rewardId)); await publicClick('replace pending request', save);
      const pending = (await state()).requests.filter(row => row.status === 'pending'); assert.equal(pending.length, 1); assert.equal(pending[0].rewardId, rewardId); requestId = pending[0].id;
      assert.deepEqual(await totals(page), { earned: 100, spent: 0, available: 100 });
    });
    await Q.check('Approval spends once with PIN; later gift edits do not rewrite redemption history', async () => {
      await gifts(); await click(page, a('redemption-approve', requestId)); await form({ note: '合成审批备注' }); await authorize('approve gift');
      assert.deepEqual(await totals(page), { earned: 100, spent: 40, available: 60 });
      assert.equal((await state()).requests.find(row => row.id === requestId).status, 'approved');
      await gifts(); await click(page, a('reward-list')); await click(page, a('reward-edit', rewardId));
      await form({ name: '合成画笔改价', points: 80, enabled: 'false' }); await authorize('edit and disable gift');
      assert.equal((await state()).redemptions[0].points, 40); assert.equal((await state()).redemptions[0].name, '合成画笔');
      await gifts(); assert.equal(await page.$(a('redeem', rewardId)), null);
      await click(page, a('reward-list')); await click(page, a('reward-edit', rewardId)); await form({ enabled: 'true' }); await authorize('re-enable gift');
      await gifts(); await click(page, a('redeem', rewardId)); assert.equal(await page.$eval(save, node => node.disabled), true);
      await Q.audit(page, 'phone-insufficient-reward');
    });
    await Q.check('Weekend/month-end restrictions are visible and exact-balance approval reaches zero', async () => {
      const weekend = await makeReward('合成周末礼物', 1, 'weekend');
      await gifts(); await click(page, a('reward-filter', 'weekend')); await click(page, a('redeem', weekend)); assert.equal(await page.$eval(save, node => node.disabled), true);
      const month = await makeReward('合成月底礼物', 1, 'outing');
      await gifts(); await click(page, a('reward-filter', 'outing')); await click(page, a('redeem', month)); assert.equal(await page.$eval(save, node => node.disabled), true);
      const exact = await makeReward('合成正好兑换', 60);
      await gifts(); await click(page, a('reward-filter', 'daily')); await click(page, a('redeem', exact)); await publicClick('exact-balance request', save);
      const id = (await state()).requests.find(row => row.status === 'pending').id;
      await gifts(); await click(page, a('redemption-approve', id)); await authorize('exact-balance approval'); assert.deepEqual(await totals(page), { earned: 100, spent: 100, available: 0 });
    });
  });

  await group('reminders', async () => {
    let taskId, copyId;
    await Q.check('Reminder create/edit/copy/tomorrow/delete follows protected save and preserves points', async () => {
      await reminders(); await click(page, a('task-new')); await form({ title: '合成带水杯', date: nowDate(), time: '', note: '门口核对' }); await authorize('create reminder');
      taskId = (await state()).tasks.find(row => row.title === '合成带水杯').id;
      await click(page, a('task-edit', taskId)); await form({ title: '合成带水杯和雨伞' }); await click(page, a('task-tomorrow', taskId)); await authorize('move reminder tomorrow');
      assert.equal((await state()).tasks.find(row => row.id === taskId).date, day(1));
      await click(page, a('day', '1')); await click(page, a('task-edit', taskId)); await click(page, a('task-copy', taskId));
      await form({ title: '合成复制提醒' }); await authorize('copy reminder'); copyId = (await state()).tasks.find(row => row.title === '合成复制提醒').id; assert.notEqual(copyId, taskId);
      await Q.home(page); await B.navigate(page, 'reminders'); await click(page, a('day', '1'));
      await click(page, a('task-edit', copyId)); await authorize('cancel reminder', a('task-delete', copyId)); assert.equal((await state()).tasks.find(row => row.id === copyId).deleted, true);
      assert.deepEqual(await totals(page), { earned: 0, spent: 0, available: 0 });
    });
    await Q.check('Completion/undo and real foreground due/snooze/ack never add points', async () => {
      await reminders(); await click(page, a('day', '1')); await publicClick('complete reminder', a('task-toggle', taskId));
      await click(page, '.completed-list summary'); await publicClick('undo completion', a('task-toggle', taskId)); assert.equal((await state()).tasks.find(row => row.id === taskId).done, false);
      await click(page, a('day', '0')); await click(page, a('task-new'));
      const time = M.calendarParts(new Date(env.now() + 60000), 'Asia/Shanghai').time;
      await form({ title: '合成前台到点', date: nowDate(), time }); await authorize('save timed reminder'); const id = (await state()).tasks.find(row => row.title === '合成前台到点').id;
      await env.setClock(env.now() + 61000); await page.waitForSelector('#reminder-slot ' + a('task-snooze', id), { timeout: 8000 });
      await Q.shot(page, 'foreground-reminder-due'); await publicClick('snooze due reminder', '#reminder-slot ' + a('task-snooze', id));
      assert.equal(new Date((await state()).tasks.find(row => row.id === id).snoozeUntil).getTime(), env.now() + 600000);
      await env.setClock(env.now() + 600001); await page.waitForSelector('#reminder-slot ' + a('task-ack', id), { timeout: 8000 });
      await publicClick('acknowledge due reminder', '#reminder-slot ' + a('task-ack', id)); assert.ok((await state()).tasks.find(row => row.id === id).ackAt); assert.equal((await state()).tasks.find(row => row.id === id).done, false);
      assert.deepEqual(await totals(page), { earned: 0, spent: 0, available: 0 });
      await env.setClock(env.now() + DAY); await page.reload({ waitUntil: 'load' }); await selectAfterReload(); await reminders();
      assert.ok(await page.$(a('task-edit', id)), 'Acknowledged overdue task remains reachable next day');
    });
    await Q.check('Important-event advance window and cancellation remain accessible', async () => {
      await reminders();
      await click(page, a('reminder-mode', 'events')); await click(page, a('task-new'));
      await form({ title: '合成近期重要事件', date: day(2), remindDays: 3, time: '', note: '合成活动备注' }); await authorize('create near important event');
      const near = (await state()).tasks.find(row => row.title === '合成近期重要事件').id;
      await click(page, a('task-new')); await form({ title: '合成远期重要事件', date: day(20), remindDays: 3 }); await authorize('create far important event');
      const far = (await state()).tasks.find(row => row.title === '合成远期重要事件').id;
      await click(page, a('reminder-mode', 'near')); await click(page, a('day', '0'));
      assert.ok(await page.$('[data-region="advance-events"] ' + a('task-edit', near))); assert.equal(await page.$('[data-region="advance-events"] ' + a('task-edit', far)), null);
      await Q.audit(page, 'phone-advance-reminders'); await click(page, a('reminder-mode', 'events')); assert.ok(await page.$(a('task-edit', far)));
      await click(page, a('task-edit', near)); await click(page, a('task-tomorrow', near)); await authorize('move important event tomorrow');
      const moved = (await state()).tasks.find(row => row.id === near); assert.equal(moved.date, day(1)); assert.equal(moved.type, 'event'); assert.equal(moved.remindDays, 3); assert.equal(moved.note, '合成活动备注');
      await click(page, a('task-edit', near)); await authorize('cancel important event', a('task-delete', near)); assert.equal((await state()).tasks.find(row => row.id === near).deleted, true);
    });
  });

  await group('profile-partners', async () => {
    await Q.check('Avatar file decode, cancel, authorized rename/save, reload and removal are real browser operations', async () => {
      const image = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 48; c.height = 48; const g = c.getContext('2d'); g.fillStyle = '#356644'; g.fillRect(0, 0, 48, 48); return c.toDataURL('image/png').split(',')[1]; });
      const file = path.join(OUT, 'synthetic-avatar.png'); fs.writeFileSync(file, Buffer.from(image, 'base64'));
      async function choose() { const pending = page.waitForFileChooser(); await click(page, a('avatar-choose')); await (await pending).accept([file]); await page.waitForFunction(() => document.querySelector('#avatar-status') && document.querySelector('#avatar-status').textContent === '头像已选定'); }
      await click(page, a('profile-edit')); await choose(); await form({ childName: '合成新昵称' }); const before = await sql(); await Q.home(page); assert.deepEqual(await sql(), before);
      await click(page, a('profile-edit')); await choose(); await form({ childName: '合成新昵称' }); await authorize('save profile and avatar');
      assert.match((await state()).childAvatar, /^data:image\/jpeg;base64,/); assert.equal((await state()).childName, '合成新昵称');
      await reloadProof('profile photo survives reload'); await Q.shot(page, 'avatar-and-child-name');
      await click(page, a('profile-edit')); await click(page, a('avatar-remove')); await authorize('remove avatar'); assert.equal((await state()).childAvatar, '');
    });
    await Q.check('Two partners, farm preview/place/remove, free care and daily animal record preserve ledger', async () => {
      await credit(500); await Q.home(page); await publicClick('farm start', a('farm-start')); await publicClick('welcome harvest', a('farm-harvest'));
      await click(page, a('farm-open')); await click(page, a('farm-tab', 'collection')); await click(page, a('pet-config'));
      await click(page, a('pet-kind', 'capybara')); await form({ petName: '合成水豚' }); await publicClick('switch partner capybara', save); assert.equal((await ui(page)).petKind, 'capybara');
      await Q.home(page); await Q.shot(page, 'capybara-family-home');
      await click(page, a('farm-open')); await click(page, a('farm-tab', 'collection')); await click(page, a('pet-config'));
      await click(page, a('pet-kind', 'plant')); await form({ petName: '合成晶叶龙' }); await publicClick('switch partner plant', save); assert.equal((await ui(page)).petKind, 'plant');
      await Q.home(page); await click(page, a('farm-open')); await click(page, a('farm-tab', 'build')); const beforePreview = await sql();
      await click(page, a('farm-item', 'flowerpot')); assert.deepEqual(await sql(), beforePreview, 'Preview is not a purchase');
      await publicClick('exchange flowerpot', a('farm-exchange', 'flowerpot')); await publicClick('place flowerpot', a('farm-place', 'flowerpot'));
      await publicClick('remove flowerpot', a('farm-remove', 'entry')); assert.equal((await state()).farm.placements.entry, null);
      await publicClick('replace flowerpot freely', a('farm-place', 'flowerpot')); assert.equal((await ui(page)).farmStatus.inventory.carrot, 0);
      await Q.home(page); await click(page, a('farm-care')); const beforePlay = await sql(); await click(page, a('farm-pet-play', 'feed')); assert.deepEqual(await sql(), beforePlay);
      await click(page, a('farm-animal', 'rabbit')); await publicClick('daily rabbit care', a('farm-animal-care', 'rabbit'));
      assert.equal((await state()).farm.animalCare.length, 1); const daily = await sql(); await click(page, a('farm-animal-care', 'rabbit')); assert.deepEqual(await sql(), daily);
      assert.deepEqual(await totals(page), { earned: 500, spent: 0, available: 500 });
      await Q.audit(page, 'phone-animal-care'); await Q.home(page); await click(page, a('farm-open')); await click(page, a('farm-tab', 'collection')); await click(page, a('pet-hub')); await click(page, a('pet-tab', 'explore')); await Q.shot(page, 'legacy-exploration-preserved');
    });
  });

  await group('farm-catalog', async () => {
    await Q.check('Every crop is planted and harvested through UI; all catalog exchanges and house levels persist without spending points', async () => {
      await credit(500); await Q.home(page); await publicClick('catalog farm start', a('farm-start')); await publicClick('catalog welcome harvest', a('farm-harvest'));
      for (const [crop, rounds] of [['carrot', 5], ['strawberry', 4], ['sunflower', 3]]) {
        for (let round = 0; round < rounds; round++) {
          await Q.home(page); await click(page, a('farm-seeds')); await click(page, a('farm-crop', crop));
          await publicClick('plant ' + crop + ' round ' + round, a('farm-plant'));
          assert.equal((await state()).farm.plots.filter(plot => plot.cropId === crop).length, 6);
          const previous = (await state()).farm.inventory[crop]; await env.setClock(env.now() + 8 * 3600000 + 1);
          await page.reload({ waitUntil: 'load' }); await selectAfterReload();
          await publicClick('harvest ' + crop + ' round ' + round, a('farm-harvest'));
          assert.equal((await state()).farm.inventory[crop], previous + 18);
        }
      }
      for (const [itemId, slot] of [['flowerpot', 'entry'], ['picnic', 'center'], ['rabbitstatue', 'center'], ['mailbox', 'entry'], ['trellis', 'edge'], ['windmill', 'edge'], ['house2', 'house'], ['house3', 'house']]) {
        await Q.home(page); await click(page, a('farm-open')); await click(page, a('farm-tab', 'build')); await click(page, a('farm-item', itemId));
        const before = await sql(); await Q.shot(page, 'catalog-preview-' + itemId); assert.deepEqual(await sql(), before);
        await publicClick('exchange catalog ' + itemId, a('farm-exchange', itemId));
        if (slot !== 'house') { await publicClick('place catalog ' + itemId, a('farm-place', itemId)); assert.equal((await state()).farm.placements[slot], itemId); }
      }
      assert.equal((await state()).farm.houseLevel, 3); assert.deepEqual(await totals(page), { earned: 500, spent: 0, available: 500 });
      const saved = await state(); await env.restart(); await page.reload({ waitUntil: 'load' }); await selectAfterReload(); assert.deepEqual(await state(), saved);
      await Q.shot(page, 'all-crops-third-house-persisted');
    });
    await Q.check('Both animals record one care per family day and expose third/seventh-day milestones', async () => {
      if ((await state()).farm === null) {
        await credit(500); await Q.home(page); await publicClick('animal-care farm start', a('farm-start'));
      }
      for (let index = 0; index < 7; index++) {
        if (index) { await env.setClock(env.now() + DAY); await page.reload({ waitUntil: 'load' }); await selectAfterReload(); }
        for (const animal of ['chicken', 'rabbit']) {
          await Q.home(page); await click(page, a('farm-care')); await click(page, a('farm-animal', animal)); await publicClick('care ' + animal + ' day ' + index, a('farm-animal-care', animal));
          const before = await sql(); await click(page, a('farm-animal-care', animal)); assert.deepEqual(await sql(), before, 'Same-day play is free and adds no duplicate record');
        }
      }
      const farm = (await ui(page)).farmStatus; assert.equal((await state()).farm.animalCare.length, 14);
      for (const animal of farm.animals) { assert.equal(animal.careCount, 7); assert.equal(animal.cardUnlocked, true); assert.equal(animal.actionUnlocked, true); }
      assert.deepEqual(await totals(page), { earned: 500, spent: 0, available: 500 }); await Q.shot(page, 'seven-days-animal-milestones');
    });
  });

  await group('parent-settings', async () => {
    await Q.check('PIN to arithmetic to replacement PIN requires current method and rejects wrong answer', async () => {
      await preferences('parent-config'); await form({ method: 'math' }); await authorize('PIN to arithmetic');
      assert.equal((await env.api(page, '/api/meta')).body.parent.method, 'math');
      await preferences('family-settings'); await form({ childName: '合成设置孩子', monthEndDays: 5 }); const before = await sql();
      await click(page, save); await page.waitForSelector('.math-question'); const text = await page.$eval('.math-question', node => node.textContent), m = text.match(/(\d+)\s*([+×*−-])\s*(\d+)/);
      const correct = m[2] === '+' ? +m[1] + +m[3] : ['×', '*'].includes(m[2]) ? +m[1] * +m[3] : +m[1] - +m[3];
      await answer(String(correct + 1)); await page.waitForFunction(() => !document.querySelector('#parent-error').hidden); assert.deepEqual(await sql(), before);
      await Q.shot(page, 'arithmetic-denial'); await answer(String(correct)); await waitNoAuth(); await proof('family settings with arithmetic');
      assert.equal((await state()).settings.monthEndDays, 5); assert.equal((await state()).childName, '合成设置孩子');
      await preferences('parent-config'); await form({ method: 'pin', pin: NEW_PIN, confirmPin: NEW_PIN }); await authorize('arithmetic to replacement PIN'); currentPin = NEW_PIN;
      assert.equal((await env.api(page, '/api/meta')).body.parent.method, 'pin'); await credit(9, '新PIN确认的独立行为'); assert.equal((await totals(page)).earned, 9);
      const publicState = JSON.stringify((await env.api(page, '/api/state')).body); assert.ok(!publicState.includes(NEW_PIN)); assert.ok(!publicState.includes('digest'));
    });
    await Q.check('Device sound boolean survives reload while hide/logout stop real audio; wake-lock UI does not alter family state', async () => {
      const before = await sql(); await preferences('sound'); assert.equal(await page.evaluate(() => localStorage.getItem('ttjf-saas-device-sound-v1')), 'true');
      await page.reload({ waitUntil: 'load' }); await selectAfterReload(); await preferences(); assert.match(await page.$eval(a('sound'), node => node.textContent), /已开启/);
      await page.$eval('#sound-complete', audio => { audio.loop = true; }); await click(page, a('sound')); await click(page, a('sound'));
      await page.waitForFunction(() => !document.querySelector('#sound-complete').paused);
      await visibility(true); assert.equal(await page.$eval('#sound-complete', audio => audio.paused && audio.currentTime === 0), true);
      await visibility(false); await Q.ready(page, familyId); await preferences(); assert.match(await page.$eval(a('sound'), node => node.textContent), /已开启/);
      await click(page, a('sound')); await click(page, a('sound')); await page.waitForFunction(() => !document.querySelector('#sound-complete').paused);
      await Q.logout(page); assert.equal(await page.$eval('#sound-complete', audio => audio.paused && audio.currentTime === 0), true); assert.equal(await page.evaluate(() => localStorage.getItem('ttjf-saas-device-sound-v1')), 'true');
      await Q.login(page, ownerEmail, currentPassword, familyId); await Q.ready(page, familyId); await preferences('sound'); assert.equal(await page.evaluate(() => localStorage.getItem('ttjf-saas-device-sound-v1')), 'false');
      await click(page, a('display')); await page.waitForFunction(() => !document.querySelector('.sheet [data-action="display"]').textContent.includes('申请中'));
      Q.report.wakeLock = { browserSupported: await page.evaluate(() => !!navigator.wakeLock), browserReportedAwake: (await ui(page)).screenAwake, physicalDeviceTested: false };
      if ((await ui(page)).screenAwake) await click(page, a('display'));
      assert.deepEqual(await sql(), before); await Q.shot(page, 'device-sound-and-wake-preferences');
    });
  });

  await group('assistant-export', async () => {
    async function interpret(text) { await Q.home(page); await click(page, a('voice')); await form({ speech: text }); await click(page, save); await page.waitForFunction(() => !window.FamilyDemo.getUI().aiBusy); }
    await Q.check('HTTP assistant proposals only populate editable points/reminder/gift drafts', async () => {
      const initial = await sql(); await interpret('他刚刚主动收好了书包，给五分'); await page.waitForSelector('[name="reason"]'); assert.deepEqual(await sql(), initial);
      assert.equal(Number(await page.$eval('[name="points"]', node => node.value)), 5); await authorize('AI point proposal confirmed');
      const afterPoints = await sql(); await interpret('明天早上七点半提醒带水杯'); await page.waitForSelector('[name="title"]'); assert.deepEqual(await sql(), afterPoints);
      assert.equal(await page.$eval('[name="date"]', node => node.value), day(1)); await authorize('AI reminder proposal confirmed');
      const afterReminder = await sql(); await interpret('添加一个周末吃汉堡的礼品，六十分'); await page.waitForSelector('[name="category"]'); assert.deepEqual(await sql(), afterReminder);
      assert.equal(await page.$eval('[name="category"]', node => node.value), 'weekend'); await authorize('AI gift proposal confirmed');
      assert.ok(calls('/api/assistant').length >= 3); assert.deepEqual(await totals(page), { earned: 5, spent: 0, available: 5 });
      await interpret('我还有多少积分'); await page.waitForSelector('.assistant-answer'); assert.match(await page.$eval('.assistant-answer', node => node.textContent), /5/); await Q.audit(page, 'phone-assistant-answer');
    });
    await Q.check('Unavailable speech falls back to text and a controlled assistant HTTP503 keeps the draft unwritten', async () => {
      await Q.home(page); await click(page, a('voice')); await click(page, a('listen'));
      assert.match(await page.$eval('.sheet', node => node.textContent), /文字|不支持|不可用/);
      await form({ speech: '合成服务故障' }); const before = await sql();
      const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/assistant'); await click(page, save); assert.equal((await response).status(), 503);
      await page.waitForFunction(() => !window.FamilyDemo.getUI().aiBusy); assert.deepEqual(await sql(), before); assert.equal((await ui(page)).form, 'voice');
      assert.equal(await page.$eval('[name="speech"]', node => node.value), '合成服务故障'); await Q.shot(page, 'assistant-failure-draft-retained');
    });
    await Q.check('Context instruction creates a template without awarding and export matches only the current SQLite business state', async () => {
      await templates(); await click(page, a('ai-toggle')); await form({ aiText: '添加一个整理书包的常用加分项，五分，原因是主动整理书包' }); await click(page, a('ai-fill', 'pointItems'));
      await page.waitForFunction(() => !window.FamilyDemo.getUI().aiBusy); await page.waitForSelector('[name="name"]'); await authorize('context AI template save');
      assert.equal((await totals(page)).earned, 5);
      await page.evaluate(() => { const native = URL.createObjectURL; window.__qaExport = null; URL.createObjectURL = function (blob) { if (blob.type === 'application/json') blob.text().then(text => { window.__qaExport = text; }); return native.call(URL, blob); }; });
      await preferences('export'); await page.waitForFunction(() => typeof window.__qaExport === 'string');
      const exported = JSON.parse(await page.evaluate(() => window.__qaExport)); assert.deepEqual(exported, (await sql()).state);
      const raw = JSON.stringify(exported); for (const secret of [PIN, NEW_PIN, PASSWORD, 'csrfToken', 'passwordHash', 'challengeId', 'grant']) assert.ok(!raw.includes(secret), 'Business export must omit credentials');
      Q.report.export = { actualBlobCaptured: true, stateSha256: hash(exported), familyId, totals: M.totals(exported), privateFieldsAbsent: true };
      await Q.shot(page, 'export-from-family-settings');
    });
  });

  await group('recovery', async () => {
    await Q.check('Focus and hidden/visible revalidation retain same-scope ordinary drafts without a write', async () => {
      await reminders(); await click(page, a('task-new')); await form({ title: '合成恢复草稿', date: nowDate(), time: '18:00', note: '同会话原家庭' });
      await page.evaluate(() => { window.__qaFocusedInput = document.querySelector('[name="title"]'); });
      const before = await sql(), focusResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session');
      await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await focusResponse; await Q.ready(page, familyId);
      assert.equal(await page.evaluate(() => window.__qaFocusedInput === document.querySelector('[name="title"]')), true, 'Focus retains the input instance');
      assert.equal(await page.$eval('[name="title"]', node => node.value), '合成恢复草稿');
      await visibility(true); await page.waitForFunction(() => !window.FamilySaas.status().ready);
      const maskedText = await page.$eval('body', node => node.textContent);
      assert.ok(!maskedText.includes(before.state.childName) && !maskedText.includes('合成恢复草稿'), 'Hidden page contains no private family text'); assert.equal(await page.$('#editor-form'), null); assert.equal(await state(), null); await Q.shot(page, 'hidden-family-masked');
      await visibility(false); await Q.ready(page, familyId); await page.waitForSelector('[name="title"]');
      assert.equal(await page.$eval('[name="title"]', node => node.value), '合成恢复草稿'); assert.equal(await page.$eval('[name="note"]', node => node.value), '同会话原家庭');
      assert.deepEqual(await sql(), before); await Q.shot(page, 'same-session-draft-restored');
      await authorize('restored draft explicitly saved');
    });
    await Q.check('Parent answers and grants do not survive suspension or auto-submit after resume', async () => {
      await Q.home(page); await click(page, a('add-points')); await click(page, a('points-new')); await form({ name: '合成恢复加分', points: 6, reason: '恢复后仍重新验证' });
      const before = await sql(); await click(page, save); await page.waitForSelector('#parent-form [name="answer"]'); await type(page, '#parent-form [name="answer"]', '246');
      await visibility(true); await visibility(false); await Q.ready(page, familyId);
      assert.equal((await ui(page)).auth, false); assert.equal(await page.$('#parent-form'), null); assert.deepEqual(await sql(), before);
      assert.equal(await page.$eval('[name="reason"]', node => node.value), '恢复后仍重新验证'); await authorize('resume demands a new challenge'); assert.equal((await totals(page)).earned, 6);
    });
    await Q.check('File chooser result returns to its original draft across synthetic hide/show then requires verification', async () => {
      await Q.home(page); await click(page, a('profile-edit'));
      const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 32; c.height = 32; return c.toDataURL('image/png').split(',')[1]; });
      const file = path.join(OUT, 'recovery-avatar.png'); fs.writeFileSync(file, Buffer.from(png, 'base64'));
      const pending = page.waitForFileChooser(); await click(page, a('avatar-choose')); const chooser = await pending;
      const before = await sql(); await visibility(true); await chooser.accept([file]); await visibility(false); await Q.ready(page, familyId);
      await page.waitForFunction(() => document.querySelector('#avatar-status') && document.querySelector('#avatar-status').textContent === '头像已选定');
      assert.deepEqual(await sql(), before); await authorize('resumed file result explicitly saved'); assert.match((await state()).childAvatar, /^data:image\/jpeg;base64,/);
    });
  });

  await group('timezone-los-angeles', async () => {
    await page.emulateTimezone('America/Los_Angeles');
    try {
      await Q.check('Los Angeles browser follows Shanghai midnight/weekend/month-end and a real foreground reminder timer', async () => {
        await env.setClock(Date.parse('2026-11-27T15:59:00Z')); await page.reload({ waitUntil: 'load' }); await selectAfterReload();
        assert.equal(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), 'America/Los_Angeles');
        await credit(20); await preferences('family-settings'); await form({ monthEndDays: 3 }); await authorize('Shanghai month-end setting');
        const weekend = await makeReward('合成上海周末', 2, 'weekend'), month = await makeReward('合成上海月底', 3, 'outing');
        for (const [id, category] of [[weekend, 'weekend'], [month, 'outing']]) { await gifts(); await click(page, a('reward-filter', category)); await click(page, a('redeem', id)); assert.equal(await page.$eval(save, node => node.disabled), true); }
        await reminders(); await click(page, a('day', '0')); await click(page, a('task-new')); await click(page, a('form-day', '1'));
        assert.equal(await page.$eval('[name="date"]', node => node.value), '2026-11-28');
        await form({ title: '合成上海零点提醒', time: '00:01' }); await authorize('Shanghai midnight reminder'); const id = (await state()).tasks.find(row => row.title === '合成上海零点提醒').id;
        await env.setClock(Date.parse('2026-11-27T16:02:00Z'));
        await page.waitForSelector('#reminder-slot ' + a('task-ack', id), { visible: true, timeout: 16000 });
        assert.equal(await page.evaluate(() => new Date().getDate()), 27, 'Device is still Friday the 27th');
        await Q.shot(page, 'los-angeles-shanghai-midnight-due'); await publicClick('Shanghai due acknowledgement', '#reminder-slot ' + a('task-ack', id));
        for (const [reward, category] of [[weekend, 'weekend'], [month, 'outing']]) {
          await gifts(); await click(page, a('reward-filter', category)); await click(page, a('redeem', reward)); assert.equal(await page.$eval(save, node => node.disabled), false);
          await publicClick('Shanghai date eligible request', save); const request = (await state()).requests.find(row => row.status === 'pending').id;
          await gifts(); await click(page, a('redemption-approve', request)); await authorize('Shanghai date eligible approval');
        }
        await Q.home(page); await click(page, a('add-points')); await click(page, a('points-new')); await form({ name: '合成上海记录', points: 1, reason: '上海零点后行为', recordTime: '00:01' }); await authorize('Shanghai wall time stored as UTC');
        assert.equal((await state()).points.at(-1).at, '2026-11-27T16:01:00.000Z'); assert.deepEqual(await totals(page), { earned: 21, spent: 5, available: 16 });
        await Q.shot(page, 'los-angeles-shanghai-calendar-complete');
      });
    } finally { await page.emulateTimezone('Asia/Shanghai'); }
  });

  await group('account-password', async () => {
    await Q.check('Account password change validates old password, preserves current session and revokes another real session', async () => {
      const other = await env.newPage(); await other.goto(env.origin, { waitUntil: 'load' }); await Q.waitView(other, 'login'); await Q.login(other, ownerEmail, currentPassword, familyId); await Q.ready(other, familyId);
      const cookies = (await other.browserContext().cookies()).map(row => row.name + '=' + row.value).join('; ');
      await Q.account(page); await click(page, Q.sa('password')); await Q.fillSaas(page, { currentPassword: 'Incorrect-QA-Password!', password: CHANGED_PASSWORD, confirmPassword: CHANGED_PASSWORD }); await click(page, Q.submit);
      await page.waitForFunction(() => !window.FamilySaas.status().pending); assert.equal((await Q.status(page)).view, 'password');
      assert.equal((await env.request('/api/session', { headers: { Cookie: cookies } })).body.authenticated, true);
      await Q.fillSaas(page, { currentPassword, password: CHANGED_PASSWORD, confirmPassword: CHANGED_PASSWORD }); await click(page, Q.submit); await Q.waitView(page, 'account'); currentPassword = CHANGED_PASSWORD;
      assert.equal((await env.api(page, '/api/session')).body.authenticated, true);
      assert.equal((await env.request('/api/session', { headers: { Cookie: cookies } })).body.authenticated, false);
      await other.reload({ waitUntil: 'load' }); await Q.waitView(other, 'login');
      await Q.logout(page); await Q.fillSaas(page, { email: ownerEmail, password: PASSWORD }); await click(page, Q.submit); await page.waitForFunction(() => !window.FamilySaas.status().pending); assert.equal((await Q.status(page)).view, 'login');
      await Q.login(page, ownerEmail, currentPassword, familyId); await Q.ready(page, familyId); await proof('new password retains exact family'); await Q.shot(page, 'password-changed-relogin');
    });
  });
  await group('family-account-lifecycle', async () => {
    const originalPage = page, targetId = familyId, renamed = '合成已改名家庭', parentEmail = 'lifecycle-parent-' + RUN + '@example.test', memberEmail = 'lifecycle-member-' + RUN + '@example.test';
    let parentPage, memberPage, parentId, memberId, survivorId, survivorState, targetState;
    await Q.check('Owner renames a family and transfers ownership only after valid current-password confirmation', async () => {
      await credit(19); targetState = await state();
      survivorId = await Q.createFamily(page, '合成必须保留家庭', '合成保留孩子'); familyId = survivorId; await setup(); await credit(3); survivorState = await state();
      await Q.switchFamily(page, targetId); familyId = targetId;
      await familyMenu('rename-family'); await saasSubmit('PATCH', '/api/families/' + targetId, { name: renamed }); await Q.ready(page, targetId);
      assert.deepEqual(await state(), targetState); assert.equal((await env.database.query('SELECT name FROM saas_families WHERE id=$1', [targetId])).rows[0].name, renamed);
      const parentLink = await invite(parentEmail), memberLink = await invite(memberEmail);
      parentPage = await env.newPage({ controlledClock: true }); await Q.registerAndVerify(parentPage, parentEmail); parentId = (await Q.status(parentPage)).userId; await accept(parentPage, parentLink, targetId);
      memberPage = await env.newPage({ controlledClock: true }); await Q.registerAndVerify(memberPage, memberEmail); memberId = (await Q.status(memberPage)).userId; await accept(memberPage, memberLink, targetId);
      await page.bringToFront(); await Q.switchFamily(page, targetId); await familyMenu(); assert.equal(await page.$(Q.sa('leave-family')), null, 'Owner cannot use parent leave entry');
      await click(page, Q.sa('transfer-owner')); await page.waitForSelector('#saas-userId'); await page.select('#saas-userId', parentId);
      const denial = await saasSubmit('POST', '/api/families/' + targetId + '/transfer-owner', { currentPassword: 'Wrong-Current-Password!' }, 403); assert.equal(denial.code, 'PASSWORD_INVALID');
      const ownersBefore = (await env.database.query("SELECT user_id FROM saas_memberships WHERE family_id=$1 AND role='owner'", [targetId])).rows; assert.equal(ownersBefore.length, 1); assert.equal(ownersBefore[0].user_id, (await Q.status(page)).userId);
      await page.setViewport({ width: 320, height: 568 }); await Q.audit(page, 'small-transfer-owner'); await page.setViewport({ width: 390, height: 844 });
      await page.select('#saas-userId', parentId); await saasSubmit('POST', '/api/families/' + targetId + '/transfer-owner', { currentPassword }); await Q.ready(page, targetId);
      const ownersAfter = (await env.database.query("SELECT user_id FROM saas_memberships WHERE family_id=$1 AND role='owner'", [targetId])).rows; assert.deepEqual(ownersAfter, [{ user_id: parentId }]);
      await familyMenu(); assert.ok(await page.$(Q.sa('leave-family'))); assert.equal(await page.$(Q.sa('delete-family')), null); await Q.shot(page, 'transferred-owner-now-parent');
    });
    await Q.check('A suspended removed member cannot recover its old draft; rejoining starts an empty draft and self-deletion preserves shared business', async () => {
      await usingPage(memberPage, targetId, async () => { await reminders(); await click(page, a('task-new')); await form({ title: 'REVOKED_PRIVATE_DRAFT' }); await visibility(true); });
      await usingPage(parentPage, targetId, async () => {
        await page.reload({ waitUntil: 'load' }); await selectAfterReload(); await Q.account(page); await click(page, Q.sa('members')); await page.waitForSelector(Q.sa('remove-member', memberId));
        await click(page, Q.sa('remove-member', memberId)); await click(page, Q.sa('confirm-remove')); await page.waitForSelector(Q.sa('remove-member', memberId), { hidden: true });
      });
      await usingPage(memberPage, targetId, async () => {
        await visibility(false); await page.waitForFunction(() => ['onboarding', 'families'].includes(window.FamilySaas.status().view));
        assert.equal(await state(), null); assert.ok(!(await page.$eval('body', node => node.textContent)).includes('REVOKED_PRIVATE_DRAFT'));
        assert.equal((await env.api(page, '/api/state', 'GET', undefined, targetId)).status, 403); await Q.shot(page, 'revoked-member-cannot-restore');
      });
      const reinvite = await usingPage(parentPage, targetId, () => invite(memberEmail)); await accept(memberPage, reinvite, targetId);
      await usingPage(memberPage, targetId, async () => {
        await reminders(); await click(page, a('task-new')); assert.equal(await page.$eval('[name="title"]', node => node.value), '');
        await Q.account(page); await click(page, Q.sa('delete-account')); await saasSubmit('POST', '/api/auth/delete-account', { email: 'different@example.test', currentPassword: PASSWORD }, 400);
        await Q.fillSaas(page, { email: memberEmail, currentPassword: PASSWORD }); await page.setViewport({ width: 320, height: 568 }); await Q.audit(page, 'small-delete-parent-account'); await page.setViewport({ width: 390, height: 844 });
        await saasSubmit('POST', '/api/auth/delete-account', { email: memberEmail, currentPassword: PASSWORD }); await Q.waitView(page, 'login');
      });
      assert.equal((await env.database.query('SELECT 1 FROM saas_users WHERE id=$1', [memberId])).rowCount, 0); assert.equal((await env.database.query('SELECT 1 FROM saas_memberships WHERE user_id=$1', [memberId])).rowCount, 0);
      assert.deepEqual((await env.database.query('SELECT state FROM saas_families WHERE id=$1', [targetId])).rows[0].state, targetState);
    });
    await Q.check('Parent leaves; owner account deletion is blocked until exact-name/password family deletion; other families survive', async () => {
      await familyMenu('leave-family'); const leaving = page.waitForResponse(result => new URL(result.url()).pathname.endsWith('/leave'));
      await click(page, Q.sa('confirm-leave')); assert.equal((await leaving).status(), 200);
      await page.waitForFunction(() => !window.FamilySaas.status().pending && !['checking', 'loading-family'].includes(window.FamilySaas.status().view));
      assert.equal((await env.api(page, '/api/state', 'GET', undefined, targetId)).status, 403);
      familyId = survivorId; await Q.switchFamily(page, survivorId); assert.deepEqual(await state(), survivorState);
      await usingPage(parentPage, targetId, async () => {
        await Q.account(page); await click(page, Q.sa('delete-account')); const blocked = await saasSubmit('POST', '/api/auth/delete-account', { email: parentEmail, currentPassword: PASSWORD }, 409); assert.equal(blocked.code, 'ACCOUNT_OWNS_FAMILIES');
        await click(page, Q.sa('account')); await click(page, Q.sa('family-settings')); await click(page, Q.sa('delete-family'));
        await saasSubmit('DELETE', '/api/families/' + targetId, { name: renamed + '错误', currentPassword: PASSWORD }, 400); assert.equal((await env.database.query('SELECT 1 FROM saas_families WHERE id=$1', [targetId])).rowCount, 1);
        await saasSubmit('DELETE', '/api/families/' + targetId, { name: renamed, currentPassword: 'Wrong-Current-Password!' }, 403); assert.equal((await env.database.query('SELECT 1 FROM saas_families WHERE id=$1', [targetId])).rowCount, 1);
        await Q.fillSaas(page, { name: renamed, currentPassword: PASSWORD }); await page.setViewport({ width: 320, height: 568 }); await Q.audit(page, 'small-delete-family-confirmation'); await page.setViewport({ width: 390, height: 844 });
        await saasSubmit('DELETE', '/api/families/' + targetId, { name: renamed, currentPassword: PASSWORD });
        assert.equal((await env.database.query('SELECT 1 FROM saas_families WHERE id=$1', [targetId])).rowCount, 0); assert.equal((await env.database.query('SELECT 1 FROM saas_memberships WHERE family_id=$1', [targetId])).rowCount, 0);
        await Q.account(page); await click(page, Q.sa('delete-account')); await saasSubmit('POST', '/api/auth/delete-account', { email: parentEmail, currentPassword: PASSWORD }); await Q.waitView(page, 'login'); await Q.shot(page, 'owner-family-and-account-deleted');
      });
      assert.equal((await env.database.query('SELECT 1 FROM saas_users WHERE id=$1', [parentId])).rowCount, 0); assert.deepEqual((await env.database.query('SELECT state FROM saas_families WHERE id=$1', [survivorId])).rows[0].state, survivorState);
      page = originalPage; familyId = survivorId; Q.active(page); await proof('unrelated family survives lifecycle deletion');
    });
    await Q.check('An authenticated unverified account can delete itself without verifying email first', async () => {
      const email = 'unverified-delete-' + RUN + '@example.test', pendingPage = await env.newPage();
      await usingPage(pendingPage, null, async () => {
        await page.goto(env.origin, { waitUntil: 'load' }); await Q.waitView(page, 'login'); await click(page, Q.sa('register')); await Q.fillSaas(page, { email, password: PASSWORD, confirmPassword: PASSWORD }); await click(page, Q.submit); await Q.waitView(page, 'pending');
        await click(page, Q.sa('login')); await Q.login(page, email, PASSWORD); await Q.waitView(page, 'unverified'); const id = (await Q.status(page)).userId;
        await click(page, Q.sa('delete-account')); await saasSubmit('POST', '/api/auth/delete-account', { email, currentPassword: PASSWORD }); await Q.waitView(page, 'login'); assert.equal((await env.database.query('SELECT 1 FROM saas_users WHERE id=$1', [id])).rowCount, 0);
      });
    });
  });
  Q.phase('final'); await Q.check('No uncaught browser exceptions in full-business scenarios', async () => assert.deepEqual(Q.report.pageErrors, []));
}
Q.execute(run);
