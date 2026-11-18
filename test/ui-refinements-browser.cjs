'use strict';

// Each named case uses a fresh synthetic account and temporary SQLite database.
// Run a single case with UI_REFINEMENT_CASE under the bounded test runner.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Q = require('./saas-browser.cjs');
const { B, M, PIN, action: a, click, ui, snapshot, save, parentSubmit } = Q;
const CASE = process.env.UI_REFINEMENT_CASE || 'award';
assert.ok(['award', 'template', 'history', 'voice', 'retry', 'balance'].includes(CASE), 'Unknown UI_REFINEMENT_CASE');
const CHILD = '合成核对宝';
let env, page, familyId, sequence = 0;

function progress(message) {
  fs.mkdirSync(Q.OUT, { recursive: true });
  fs.writeFileSync(path.join(Q.OUT, 'flow-progress.json'), JSON.stringify({
    case: CASE, message, at: new Date().toISOString(), checks: Q.report.checks
  }, null, 2));
}
const recent = (marker, route) => env.calls.slice(marker).filter(call => call.path === route);
async function sql() {
  return (await env.database.query('SELECT revision,state FROM saas_families WHERE id=$1', [familyId])).rows[0];
}
async function fixtureAction(input, protectedAction = true) {
  const response = await env.api(page, '/api/state');
  assert.equal(response.status, 200);
  const action = { ...input, id: 'ui-refinement-' + CASE + '-' + (++sequence) };
  let grant;
  if (protectedAction) {
    const challenge = await env.api(page, '/api/parent/challenge', 'POST', { revision: response.body.revision, action });
    assert.equal(challenge.status, 200, JSON.stringify(challenge.body));
    const verified = await env.api(page, '/api/parent/verify', 'POST', { challengeId: challenge.body.challengeId, answer: PIN });
    assert.equal(verified.status, 200, JSON.stringify(verified.body)); grant = verified.body.grant;
  }
  const result = await env.api(page, '/api/action', 'POST', { revision: response.body.revision, action, grant });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}
async function setup() {
  Q.phase('ui-refinement-' + CASE);
  env = await Q.initialize({ assistantService: {
    status: () => ({ mode: 'local', label: '合成指令测试' }),
    interpret: async () => ({ mode: 'local', kind: 'action', action: { type: 'points.add',
      payload: { name: '合成语音行为', points: 11, reason: '完整读完故事并主动分享' } } })
  } });
  env.clock(Date.parse('2026-11-17T04:30:00Z'));
  page = await env.newPage({ controlledClock: true, width: 905, height: 768 }); Q.active(page);
  page.setDefaultTimeout(7000);
  await page.evaluateOnNewDocument(() => { window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; });
  progress('Creating isolated SaaS fixture');
  await Q.registerAndVerify(page, 'ui-' + CASE + '-' + Q.RUN + '@example.test');
  familyId = await Q.createFamily(page, '合成界面核对-' + CASE, CHILD);
  await fixtureAction({ type: 'parent.setup', method: 'pin', pin: PIN, confirmPin: PIN }, false);
  await fixtureAction({ type: 'pointItem.save', item: { id: 'ui-common', name: '合成常用行为', points: 5, reason: '主动整理桌面', enabled: true } });
  if (CASE === 'balance') await fixtureAction({ type: 'reward.save', reward: { id: 'ui-gift', name: '合成兑换礼品', points: 20, category: 'daily', enabled: true, icon: 'pencil' } });
  if (CASE === 'history') {
    await fixtureAction({ type: 'points.add', name: '合成兑换前积累', points: 50, reason: '隔离测试积分' });
    await fixtureAction({ type: 'reward.save', reward: { id: 'ui-gift', name: '合成兑换礼品', points: 12, category: 'daily', enabled: true, icon: 'pencil' } });
    await fixtureAction({ type: 'redemption.request', rewardId: 'ui-gift' }, false);
    const state = (await env.api(page, '/api/state')).body.state;
    await fixtureAction({ type: 'redemption.approve', requestId: state.requests[0].id, expectedPoints: 12, note: '合成已完成兑换' });
  }
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => {
    const state = window.FamilySaas && window.FamilySaas.status();
    return state && (state.ready || state.view === 'families');
  });
  if ((await Q.status(page)).view === 'families') await click(page, Q.sa('select-family', familyId));
  await Q.ready(page, familyId); await Q.home(page); progress('Fixture ready');
}
async function openCustom(values = {}) {
  await click(page, a('add-points')); await click(page, a('points-new'));
  await B.fillForm(page, { name: '合成核对行为', points: 5, reason: '主动收好书包', recordTime: '11:45', ...values });
}
async function review(marker, before) {
  await click(page, save);
  assert.equal((await ui(page)).authPhase, 'confirm');
  assert.ok(await page.$('.points-confirm-dialog[role="dialog"][aria-modal="true"]'));
  assert.equal(await page.$('#parent-form [name="answer"]'), null);
  assert.deepEqual(recent(marker, '/api/parent/challenge'), []);
  assert.deepEqual(recent(marker, '/api/action'), []);
  assert.deepEqual(await sql(), before, 'review leaves SQLite untouched');
  const text = await page.$eval('.points-confirm-dialog', node => node.textContent);
  assert.match(text, new RegExp(CHILD)); assert.match(text, /记录时间/);
  assert.equal(await page.evaluate(() => document.querySelector('.points-confirm-dialog').contains(document.activeElement)), true);
  return text;
}
async function confirm(options = {}) {
  if (options.keyboard) {
    await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'points-confirm');
    await page.keyboard.press('Enter');
  } else await B.click(page, a('points-confirm'), { clickCount: options.double ? 2 : 1 });
  await page.waitForSelector('#parent-form [name="answer"]');
  assert.equal((await ui(page)).authPhase, 'verify');
  assert.ok(await page.$('.parent-dialog[aria-describedby="parent-dialog-prompt"]'));
  assert.match(await page.$eval('.parent-dialog-prompt', node => node.textContent), /请家长输入 PIN/);
  assert.equal(await page.evaluate(() => document.activeElement.name), 'answer');
  assert.equal(await page.$eval('#parent-error', node => node.hidden), true, 'review activation does not submit an empty PIN');
}
async function finish(pin = PIN, double = false, keyboard = false) {
  await B.fill(page, '#parent-form [name="answer"]', pin);
  if (keyboard) await page.keyboard.press('Enter');
  else await B.click(page, parentSubmit, { clickCount: double ? 2 : 1 });
  if (pin === PIN) await page.waitForFunction(() => {
    const state = window.FamilyDemo.getUI(); return !state.auth && !state.pending;
  });
}
async function award() {
  await Q.check('Custom awards review child, behavior, amount and time before challenge; back preserves the editable draft', async () => {
    const before = await sql(), marker = env.calls.length;
    await openCustom(); const text = await review(marker, before);
    assert.match(text, /合成核对行为/); assert.match(text, /确认加5分/); assert.match(text, /11:45/); assert.match(text, /主动收好书包/);
    await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'points-confirm');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'parent-cancel');
    await click(page, '.sheet-footer ' + a('parent-cancel'));
    assert.equal((await ui(page)).form, 'points'); assert.equal((await ui(page)).auth, false);
    for (const [name, value] of Object.entries({ name: '合成核对行为', points: '5', recordTime: '11:45', reason: '主动收好书包' })) {
      assert.equal(await page.$eval('#editor-form [name="' + name + '"]', node => node.value), value);
    }
    assert.deepEqual(recent(marker, '/api/parent/challenge'), []); assert.deepEqual(await sql(), before);
    await Q.shot(page, 'award-draft-restored'); progress('Award review cancellation verified');
  });
  await Q.check('Only explicit review plus a valid fresh PIN adds the edited amount, and a double submit writes once', async () => {
    const before = await sql(), marker = env.calls.length;
    await page.evaluate(() => {
      const complete = window.FamilyFarmUI.complete;
      window.__uiCompletedActions = [];
      window.FamilyFarmUI.complete = function (action) {
        window.__uiCompletedActions.push({ type: action.type, id: action.id });
        return complete.apply(this, arguments);
      };
    });
    await B.fillForm(page, { points: 7 }); await review(marker, before); await confirm({ double: true });
    assert.deepEqual(await sql(), before);
    await finish('000000');
    await page.waitForFunction(() => { const error = document.querySelector('#parent-error'); return error && !error.hidden; });
    assert.deepEqual(await sql(), before); assert.equal(recent(marker, '/api/action').length, 0);
    assert.deepEqual(await page.evaluate(() => window.__uiCompletedActions), [], 'wrong PIN triggers no success presentation');
    await click(page, '.sheet-footer ' + a('parent-cancel'));
    await review(env.calls.length, before); await confirm(); await Q.shot(page, 'parent-pin'); await finish(PIN, true);
    assert.equal(await page.evaluate(() => window.__uiCompletedActions.filter(action => action.type === 'points.add').length), 1);
    await page.waitForFunction(() => {
      const renderer = window.FamilyFarmUI.diagnostics().renderer;
      return renderer && renderer.credit && renderer.credit.success === true;
    }, { timeout: 7000, polling: 'raf' });
    const success = await page.evaluate(() => {
      const art = document.querySelector('[data-credit-scene]');
      return { credit: window.FamilyFarmUI.diagnostics().renderer.credit, imageReady: !!art && !!art.src && art.naturalWidth > 0 };
    });
    assert.equal(success.imageReady, true, 'successful award has a real rendered wallet frame');
    Q.report.creditSuccess = success; await Q.shot(page, 'award-success-credit');
    const after = await sql();
    assert.equal(M.totals(after.state).earned, M.totals(before.state).earned + 7);
    assert.equal(after.state.points.filter(row => row.name === '合成核对行为' && row.points === 7).length, 1);
    const writes = recent(marker, '/api/action').filter(call => call.action && call.action.type === 'points.add');
    assert.equal(writes.length, 1); assert.equal(writes[0].action.hasGrant, true);
    assert.equal(recent(marker, '/api/parent/challenge').length, 2);
    assert.deepEqual(await snapshot(page), after.state); progress('PIN, cancellation and single committed write verified');
  });
  await Q.check('Choosing a common behavior still requires the same non-writing review', async () => {
    await Q.home(page); const before = await sql(), marker = env.calls.length;
    await click(page, a('choose-point', 'ui-common'));
    const text = await review(marker, before); assert.match(text, /合成常用行为/); assert.match(text, /主动整理桌面/);
    await confirm({ keyboard: true }); assert.deepEqual(await sql(), before);
    await click(page, '.sheet-footer ' + a('parent-cancel')); assert.deepEqual(await sql(), before);
  });
}
async function template() {
  await Q.check('Creating a named common behavior uses explicit template copy and changes no earned points', async () => {
    const before = await sql();
    await click(page, a('all-behaviors')); await click(page, a('point-list'));
    assert.match(await page.$eval('.template-create', node => node.textContent), /新建常用行为/);
    await click(page, a('point-item-new'));
    assert.match(await page.$eval('.sheet', node => node.textContent), /本次不增加积分/);
    await B.fillForm(page, { name: '合成新建常用行为', points: 9, reason: '默认预设原因' });
    const marker = env.calls.length; await click(page, save);
    await page.waitForSelector('#parent-form [name="answer"]');
    assert.equal(await page.$(a('points-confirm')), null, 'template maintenance is separate from an actual award');
    assert.deepEqual(await sql(), before); await finish();
    const after = await sql(); assert.deepEqual(M.totals(after.state), M.totals(before.state));
    assert.equal(after.state.pointItems.filter(item => item.name === '合成新建常用行为').length, 1);
    assert.deepEqual(recent(marker, '/api/action').map(call => call.action.type), ['pointItem.save']);
    await Q.home(page); assert.match(await page.$eval(a('add-points'), node => node.textContent), /立即加分/);
    await Q.shot(page, 'template-distinct-from-award');
  });
}
async function history() {
  await Q.check('Rewards opens existing redemption history directly, and back restores the gift list and selected filter without writes', async () => {
    const before = await sql(), marker = env.calls.length;
    await click(page, a('jump-rewards')); await click(page, a('reward-filter', 'daily'));
    const gifts = await page.$$eval('.reward-card', nodes => nodes.map(node => node.dataset.id));
    await click(page, a('rewards-history'));
    assert.equal((await ui(page)).form, 'records');
    assert.equal(await page.$eval('.history-tabs .active', node => node.dataset.id), 'redemptions');
    assert.match(await page.$eval('.record-list', node => node.textContent), /合成兑换礼品/);
    assert.match(await page.$eval('.record-list', node => node.textContent), /合成已完成兑换/);
    await Q.shot(page, 'rewards-existing-redemption-record');
    await click(page, '.sheet-header ' + a('form-close'));
    assert.equal((await ui(page)).form, 'rewards');
    assert.equal(await page.$eval('.filter-tabs .active', node => node.dataset.id), 'daily');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'rewards-history');
    assert.deepEqual(await page.$$eval('.reward-card', nodes => nodes.map(node => node.dataset.id)), gifts);
    assert.deepEqual(await sql(), before); assert.deepEqual(recent(marker, '/api/parent/challenge'), []); assert.deepEqual(recent(marker, '/api/action'), []);
  });
}
async function voice() {
  await Q.check('An HTTP assistant award proposal remains a draft and passes the same explicit review before PIN and persistence', async () => {
    const before = await sql(), marker = env.calls.length;
    await click(page, a('voice')); await B.fillForm(page, { speech: '今天读完故事，加十一分' }); await click(page, save);
    await page.waitForFunction(() => window.FamilyDemo.getUI().form === 'points');
    assert.equal(await page.$eval('[name="name"]', node => node.value), '合成语音行为');
    assert.deepEqual(await sql(), before); assert.deepEqual(recent(marker, '/api/parent/challenge'), []); assert.deepEqual(recent(marker, '/api/action'), []);
    const text = await review(marker, before); assert.match(text, /确认加11分/); assert.match(text, /完整读完故事并主动分享/);
    await Q.shot(page, 'voice-award-review'); await confirm({ keyboard: true }); await finish(PIN, false, true);
    const after = await sql(); assert.equal(M.totals(after.state).earned, M.totals(before.state).earned + 11);
    assert.equal(recent(marker, '/api/action').filter(call => call.action && call.action.type === 'points.add').length, 1);
  });
}
async function retry() {
  await Q.check('Losing a committed award response reconciles its original operation once after review and PIN', async () => {
    const before = await sql(), marker = env.calls.length;
    await openCustom({ name: '合成丢失回执', points: 3 }); await review(marker, before); await confirm();
    await page.evaluate(() => {
      const nativeSend = XMLHttpRequest.prototype.send;
      let armed = true;
      XMLHttpRequest.prototype.send = function () {
        if (armed && this.__qaPath === '/api/action') {
          armed = false;
          const xhr = this, onload = xhr.onload;
          xhr.onload = function (event) {
            if (xhr.status === 200) { window.__lostAwardResponse = true; xhr.ontimeout(); }
            else onload.call(xhr, event);
          };
        }
        return nativeSend.apply(this, arguments);
      };
    });
    await finish();
    assert.equal(await page.evaluate(() => window.__lostAwardResponse), true);
    const after = await sql(); assert.equal(M.totals(after.state).earned, M.totals(before.state).earned + 3);
    assert.equal(after.state.points.filter(row => row.name === '合成丢失回执').length, 1);
    assert.equal(recent(marker, '/api/action').filter(call => call.action && call.action.type === 'points.add').length, 1);
    assert.deepEqual(await snapshot(page), after.state);
    await openCustom({ name: '合成下一笔', points: 2 }); await review(env.calls.length, after);
    assert.equal((await ui(page)).authPhase, 'confirm', 'next intentional award gets its own review');
  });
}
async function balance() {
  async function wallet(earned, available) {
    await Q.home(page);
    assert.equal(await page.$eval('[data-testid="earned-points"]', node => Number(node.textContent)), earned);
    assert.equal(await page.$eval('[data-testid="available-points"]', node => Number(node.textContent)), available);
    assert.match(await page.$eval('.credit-score', node => node.getAttribute('aria-label')), new RegExp('历史总积分' + earned + '，可兑换积分' + available));
    assert.equal(await page.$eval(a('add-points'), node => node.textContent.trim()), '立即加分');
  }
  await Q.check('An optional blank reason saves once with a template, survives reload, and has an honest empty-history label', async () => {
    await wallet(0, 0);
    const before = await sql(), marker = env.calls.length;
    await openCustom({ name: '合成喂猫', points: 20, reason: '' });
    await click(page, '#editor-form [name="saveAsTemplate"]');
    assert.equal(await page.$eval('#editor-form [name="saveAsTemplate"]', node => node.checked), true);
    assert.equal(await page.$eval('#editor-form [name="reason"]', node => node.required), false);
    assert.match(await page.$eval('#editor-form [name="reason"]', node => node.closest('label').textContent), /选填/);
    const text = await review(marker, before); assert.match(text, /未填写/);
    await confirm(); await finish();
    const after = await sql(), saved = after.state.points.find(row => row.name === '合成喂猫');
    assert.equal(saved.reason, '');
    assert.equal(after.state.pointItems.find(row => row.id === saved.itemId).reason, '');
    assert.deepEqual(M.totals(after.state), { earned: 20, spent: 0, available: 20 });
    assert.equal(recent(marker, '/api/action').filter(call => call.action && call.action.type === 'points.add').length, 1);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => { const s = window.FamilySaas.status(); return s.ready || s.view === 'families'; });
    if ((await Q.status(page)).view === 'families') await click(page, Q.sa('select-family', familyId));
    await Q.ready(page, familyId); await wallet(20, 20);
    assert.deepEqual(await snapshot(page), after.state);
    await click(page, a('records')); await click(page, a('history', 'points'));
    const row = await page.$eval('.record-list', node => node.textContent);
    assert.match(row, /合成喂猫/); assert.match(row, /未填写原因/); assert.doesNotMatch(row, /礼品/);
    await Q.shot(page, 'empty-reason-ledger');
  });
  await Q.check('Redeeming the full balance lowers only redeemable points; historical growth and the Three.js treasury remain', async () => {
    await wallet(20, 20);
    await click(page, a('jump-rewards')); await click(page, a('redeem', 'ui-gift')); await click(page, save); await Q.settled(page);
    await Q.home(page); await click(page, a('jump-rewards'));
    const request = (await snapshot(page)).requests.find(row => row.status === 'pending');
    await click(page, a('redemption-approve', request.id)); await click(page, save);
    await page.waitForSelector('#parent-form [name="answer"]'); await finish();
    await wallet(20, 0);
    assert.deepEqual(M.totals((await sql()).state), { earned: 20, spent: 20, available: 0 });
    await page.waitForFunction(() => { const image = document.querySelector('[data-credit-scene]'); return image && image.complete && image.naturalWidth > 0; });
    await Q.shot(page, 'historical-total-after-full-redemption');
    await click(page, a('choose-point', 'ui-common')); await B.fillForm(page, { reason: '' });
    await review(env.calls.length, await sql()); await confirm(); await finish();
    await wallet(25, 5);
    assert.equal((await sql()).state.points.at(-1).reason, '', 'a preset reason is optional on each award');
  });
}
async function run() {
  Q.report.boundaries.push('UI refinement case ' + CASE + ': real SaaS HTTP and temporary SQLite; synthetic email verification and local assistant proposal, no external mail, microphone or live family data.');
  await setup();
  await ({ award, template, history, voice, retry, balance })[CASE]();
  assert.deepEqual(Q.report.pageErrors, []); progress('Case complete');
}
Q.execute(run);
