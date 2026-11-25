'use strict';

// One bounded case per process, with a real SaaS, synthetic account and fresh SQLite.
// PARENT_DEVICE_CASE=pin|math|award|redeem|scope|stale node test/parent-device-browser.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Q = require('./saas-browser.cjs');
const { B, M, PIN, PASSWORD, action: a, click, save, parentSubmit } = Q;
const CASE = process.env.PARENT_DEVICE_CASE || 'pin';
assert.ok(['pin', 'math', 'award', 'redeem', 'scope', 'stale'].includes(CASE), 'Unknown PARENT_DEVICE_CASE');
const TOGGLE = a('parent-device-toggle');
const CREDENTIAL = '#editor-form [name="credential"]';
const EMAIL = 'parent-device-' + CASE + '-' + Q.RUN + '@example.test';
const CHILD = '合成免验证宝';
const GIFT = 'parent-device-pencil';
const NOW = Date.parse('2026-11-25T04:30:00Z');
let env, page, familyId, sequence = 0;

Q.report.command = 'PARENT_DEVICE_CASE=' + CASE + ' node test/parent-device-browser.cjs';
Q.report.nodeCommand = 'node test/parent-device-browser.cjs';
Q.report.parentDeviceCase = CASE;
Q.report.testSourceHash = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
Q.report.boundaries.push('Each run selects one short local-device case. Other cases and native iPad/Safari are not verified by this run.');
Q.report.boundaries.push('Server and browser use the same injected Shanghai clock so a wall-clock minute boundary cannot turn the synthetic award into a future record.');

function progress(message) {
  fs.mkdirSync(Q.OUT, { recursive: true });
  const entry = { case: CASE, at: new Date().toISOString(), message, checks: Q.report.checks };
  fs.writeFileSync(path.join(Q.OUT, 'parent-device-progress.json'), JSON.stringify(entry, null, 2) + '\n');
  fs.appendFileSync(path.join(Q.OUT, 'parent-device-progress.log'), entry.at + ' ' + message + '\n');
  console.log(message);
}
async function stored() {
  return (await env.database.query('SELECT revision,state FROM saas_families WHERE id=$1', [familyId])).rows[0];
}
const recent = (marker, route) => env.calls.slice(marker).filter(call => call.path === route);
async function fixtureAction(input, protectedAction = true) {
  const current = await env.api(page, '/api/state'); assert.equal(current.status, 200);
  const action = { ...input, id: 'parent-device-' + CASE + '-' + (++sequence) };
  let grant;
  if (protectedAction) {
    const challenge = await env.api(page, '/api/parent/challenge', 'POST', { revision: current.body.revision, action });
    assert.equal(challenge.status, 200, JSON.stringify(challenge.body));
    const numbers = (challenge.body.question || '').match(/\d+/g);
    const answer = challenge.body.method === 'math' ? String(Number(numbers[0]) + Number(numbers[1])) : PIN;
    const verified = await env.api(page, '/api/parent/verify', 'POST', { challengeId: challenge.body.challengeId, answer });
    assert.equal(verified.status, 200, JSON.stringify(verified.body)); grant = verified.body.grant;
  }
  const result = await env.api(page, '/api/action', 'POST', { revision: current.body.revision, action, grant });
  assert.equal(result.status, 200, JSON.stringify(result.body));
}
async function device(target = page) {
  const response = await env.api(target, '/api/parent/device');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}
async function setDevice(enabled, target = page) {
  const response = await env.api(target, '/api/parent/device', 'POST', enabled ? { enabled: true, credential: PIN } : { enabled: false });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.enabled, enabled);
}
async function selectFamily(target) {
  await target.waitForFunction(() => {
    const status = window.FamilySaas && window.FamilySaas.status(); return status && (status.ready || status.view === 'families');
  });
  if ((await Q.status(target)).view === 'families') await click(target, Q.sa('select-family', familyId));
  await Q.ready(target, familyId); await Q.home(target);
}
async function reload(target = page) {
  await target.reload({ waitUntil: 'load' }); await selectFamily(target);
}
async function settings(target = page) {
  await Q.home(target); await click(target, a('preferences')); await click(target, a('parent-config'));
  await target.waitForSelector(TOGGLE, { visible: true });
  assert.match(await target.$eval('.sheet', node => node.textContent), /本机日常免验证/);
  assert.equal(await target.$eval(TOGGLE, node => node.getAttribute('role')), 'switch');
}
async function enabledInSettings(expected, target = page) {
  await target.waitForFunction(({ selector, enabled }) => document.querySelector(selector)?.getAttribute('aria-checked') === String(enabled),
    {}, { selector: TOGGLE, enabled: expected });
  assert.equal((await device(target)).enabled, expected);
}
async function setup() {
  Q.phase('parent-device-' + CASE); progress('Creating isolated SaaS/SQLite fixture');
  env = await Q.initialize(); env.clock(NOW);
  page = await env.newPage({ width: 390, height: 844, controlledClock: true }); Q.active(page); page.setDefaultTimeout(6500);
  await Q.registerAndVerify(page, EMAIL);
  familyId = await Q.createFamily(page, '合成本机授权家庭', CHILD);
  await fixtureAction(CASE === 'math' ? { type: 'parent.setup', method: 'math' } : { type: 'parent.setup', method: 'pin', pin: PIN, confirmPin: PIN }, false);
  if (CASE === 'redeem') {
    await fixtureAction({ type: 'points.add', name: '合成兑换积分', points: 20, reason: '' });
    await fixtureAction({ type: 'reward.save', reward: { id: GIFT, name: '合成彩色铅笔', points: 8, category: 'daily', enabled: true, icon: 'pencil' } });
    await fixtureAction({ type: 'redemption.request', rewardId: GIFT }, false);
  }
  await reload();
  assert.deepEqual(Q.report.pageErrors, []); progress('Synthetic account and family ready');
}
async function openAward(target = page, name = '合成免验证加分') {
  await Q.home(target); await click(target, a('add-points')); await click(target, a('points-new'));
  await B.fillForm(target, { name, points: 5, reason: '合成测试原因' }); await click(target, save);
  await target.waitForFunction(() => window.FamilyDemo.getUI().authPhase === 'confirm');
}
async function waitNoAuth(target = page) {
  await target.waitForFunction(() => { const ui = window.FamilyDemo.getUI(); return !ui.auth && !ui.pending; });
}
async function expectPin(target = page) {
  await target.waitForSelector('#parent-form [name="answer"]', { visible: true });
  assert.equal((await Q.ui(target)).authPhase, 'verify');
  assert.match(await target.$eval('.parent-dialog-prompt', node => node.textContent), /PIN/);
}
async function assertReviewUncommitted(before, marker, expected, target = page) {
  assert.equal((await Q.ui(target)).authPhase, 'confirm');
  assert.equal(await target.$('#parent-form [name="answer"]'), null, 'The final review asks for no PIN');
  assert.match(await target.$eval('#parent-form', node => node.textContent), expected);
  assert.deepEqual(await stored(), before, 'Final review leaves the persisted ledger untouched');
  assert.deepEqual(recent(marker, '/api/action'), [], 'No ledger command runs before final confirmation');
  assert.deepEqual(recent(marker, '/api/parent/challenge'), [], 'No PIN or math challenge is requested');
}
async function pin() {
  await Q.check('Local daily bypass starts off; cancelling or entering a wrong PIN cannot enable it; one correct PIN enables it', async () => {
    const before = await stored();
    await settings(); await enabledInSettings(false);
    await click(page, TOGGLE); await page.waitForSelector(CREDENTIAL, { visible: true });
    assert.match(await page.$eval('.sheet', node => node.textContent), /PIN/);
    assert.equal(await page.$eval(CREDENTIAL, node => node.type), 'password');
    await click(page, '.sheet-header ' + a('form-close')); await enabledInSettings(false);
    await click(page, TOGGLE); await Q.type(page, CREDENTIAL, '000000'); await click(page, save);
    await page.waitForFunction(() => { const error = document.querySelector('#form-error'); return error && !error.hidden; });
    assert.equal((await device()).enabled, false); assert.deepEqual(await stored(), before);
    await Q.type(page, CREDENTIAL, PIN); await click(page, save); await enabledInSettings(true);
    assert.deepEqual(await stored(), before, 'Device authorization does not change family state or revision');
    await Q.shot(page, 'pin-enabled'); progress('Wrong/cancelled PIN rejected and correct PIN enabled the current session');
  });
}
async function math() {
  await Q.check('Arithmetic-mode families require the current account password to enable the local bypass', async () => {
    const before = await stored(), marker = env.calls.length;
    await settings(); await enabledInSettings(false); await click(page, TOGGLE);
    await page.waitForSelector(CREDENTIAL, { visible: true });
    assert.match(await page.$eval('.sheet', node => node.textContent), /账号.*密码/);
    assert.equal(await page.$eval(CREDENTIAL, node => node.type), 'password');
    assert.equal(await page.$('.math-question'), null, 'An arithmetic answer cannot authorize a trusted device');
    await Q.type(page, CREDENTIAL, '42'); await click(page, save);
    await page.waitForFunction(() => { const error = document.querySelector('#form-error'); return error && !error.hidden; });
    assert.equal((await device()).enabled, false); assert.deepEqual(await stored(), before);
    await Q.type(page, CREDENTIAL, PASSWORD); await click(page, save); await enabledInSettings(true);
    assert.deepEqual(recent(marker, '/api/parent/challenge'), []); assert.deepEqual(await stored(), before);
    await Q.shot(page, 'math-password-enabled'); progress('Arithmetic mode accepted account password, rejected a numeric answer');
  });
}
async function award() {
  await setDevice(true); await reload();
  await Q.check('A trusted session still reviews the award, permits cancellation, then records a double-clicked final confirmation once without PIN', async () => {
    const before = await stored(), marker = env.calls.length;
    await openAward(); await assertReviewUncommitted(before, marker, /确认加5分/);
    await click(page, '.sheet-footer ' + a('parent-cancel'));
    assert.equal((await Q.ui(page)).form, 'points'); assert.deepEqual(await stored(), before);
    await click(page, save); await assertReviewUncommitted(before, marker, /确认加5分/);
    await Q.shot(page, 'award-final-confirmation'); await B.click(page, parentSubmit, { clickCount: 2 }); await waitNoAuth();
    const after = await stored();
    assert.equal(after.revision, before.revision + 1);
    assert.deepEqual(M.totals(after.state), { earned: 5, spent: 0, available: 5 });
    assert.equal(after.state.points.filter(row => row.name === '合成免验证加分').length, 1);
    assert.deepEqual(recent(marker, '/api/parent/challenge'), []); assert.deepEqual(recent(marker, '/api/parent/verify'), []);
    const writes = recent(marker, '/api/action'); assert.equal(writes.length, 1);
    assert.equal(writes[0].action.type, 'points.add'); assert.equal(writes[0].action.hasGrant, false);
    assert.equal(await page.$('#parent-form [name="answer"]'), null); progress('One explicit final confirmation added 5 points once without a PIN prompt');
  });
}
async function redeem() {
  await setDevice(true); await reload();
  await Q.check('A trusted session keeps a final gift confirmation; cancelling costs nothing and confirming debits once without PIN', async () => {
    const before = await stored(), marker = env.calls.length;
    const pending = before.state.requests.find(row => row.status === 'pending'); assert.ok(pending);
    await click(page, a('jump-rewards')); await click(page, a('redemption-approve', pending.id)); await click(page, save);
    await page.waitForFunction(() => window.FamilyDemo.getUI().authPhase === 'confirm');
    await assertReviewUncommitted(before, marker, /确认兑换/); await Q.shot(page, 'gift-final-confirmation');
    await click(page, '.sheet-footer ' + a('parent-cancel')); assert.deepEqual(await stored(), before);
    await click(page, save); await assertReviewUncommitted(before, marker, /确认兑换/);
    await B.click(page, parentSubmit, { clickCount: 2 }); await waitNoAuth();
    const after = await stored();
    assert.equal(after.revision, before.revision + 1);
    assert.deepEqual(M.totals(after.state), { earned: 20, spent: 8, available: 12 });
    assert.equal(after.state.redemptions.length, 1); assert.equal(after.state.redemptions[0].name, '合成彩色铅笔');
    assert.equal(after.state.requests.find(row => row.id === pending.id).status, 'approved');
    assert.deepEqual(recent(marker, '/api/parent/challenge'), []); assert.deepEqual(recent(marker, '/api/parent/verify'), []);
    const writes = recent(marker, '/api/action'); assert.equal(writes.length, 1);
    assert.equal(writes[0].action.type, 'redemption.approve'); assert.equal(writes[0].action.hasGrant, false);
    assert.equal(await page.$('#parent-form [name="answer"]'), null); progress('One explicit gift confirmation debited 8 points once without a PIN prompt');
  });
}
async function scope() {
  await setDevice(true); await reload();
  await Q.check('Refresh keeps the same session trusted; a second login stays protected; revocation restores the PIN requirement', async () => {
    const before = await stored();
    await settings(); await enabledInSettings(true); await reload(); await settings(); await enabledInSettings(true);
    const other = await env.newPage({ width: 390, height: 844, controlledClock: true }); other.setDefaultTimeout(6500);
    await other.goto(env.origin, { waitUntil: 'load' }); await Q.waitView(other, 'login');
    await Q.login(other, EMAIL); await selectFamily(other); assert.equal((await device(other)).enabled, false);
    await settings(other); await enabledInSettings(false, other);
    await openAward(other, '合成另一个会话'); await click(other, parentSubmit); await expectPin(other);
    assert.deepEqual(await stored(), before, 'An untrusted session cannot commit without PIN');
    await Q.shot(other, 'second-session-still-pin'); await click(other, '.sheet-footer ' + a('parent-cancel'));
    Q.active(page); await settings(); await enabledInSettings(true);
    await click(page, TOGGLE); await enabledInSettings(false);
    assert.equal(await page.$(CREDENTIAL), null, 'Revoking trust requires no secret entry');
    await openAward(); await click(page, parentSubmit); await expectPin();
    assert.deepEqual(await stored(), before); await Q.shot(page, 'revoked-session-pin');
    progress('Reload retained only the authorized session; other login and revoked session both required PIN');
  });
}
async function stale() {
  await setDevice(true); await reload();
  await Q.check('Revoking trust while an award review is open falls back to PIN and preserves the original action for one commit', async () => {
    const before = await stored(), marker = env.calls.length;
    await openAward(); await assertReviewUncommitted(before, marker, /确认加5分/);
    await setDevice(false); await click(page, parentSubmit); await expectPin();
    assert.deepEqual(await stored(), before, 'A stale trusted UI cannot bypass server revocation');
    const first = recent(marker, '/api/action'); assert.equal(first.length, 1); assert.equal(first[0].action.hasGrant, false);
    await Q.shot(page, 'stale-trust-falls-back-to-pin');
    await Q.type(page, '#parent-form [name="answer"]', PIN); await click(page, parentSubmit); await waitNoAuth();
    const after = await stored(); assert.equal(after.revision, before.revision + 1);
    assert.deepEqual(M.totals(after.state), { earned: 5, spent: 0, available: 5 });
    const attempts = recent(marker, '/api/action'); assert.equal(attempts.length, 2);
    assert.equal(attempts[0].action.id, attempts[1].action.id, 'PIN fallback reuses the same intended operation');
    assert.equal(attempts[1].action.hasGrant, true); assert.equal(after.state.points.length, 1);
    progress('Server revocation rejected the stale exemption; a fresh PIN completed the same operation once');
  });
}
Q.execute(async () => {
  await setup(); await ({ pin, math, award, redeem, scope, stale })[CASE]();
  assert.deepEqual(Q.report.pageErrors, []); progress('Selected browser case passed');
});
