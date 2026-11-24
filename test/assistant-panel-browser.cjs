'use strict';

// Each case is a short browser run with progress and results on disk.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const B = require('./browser.cjs');
const ROOT = path.resolve(__dirname, '..');
const CASE = process.env.ASSISTANT_PANEL_CASE || 'layout';
assert.ok(['layout', 'lifecycle', 'drafts', 'voice', 'history'].includes(CASE));
const OUT = process.env.TEST_ARTIFACT_DIR ? path.resolve(process.env.TEST_ARTIFACT_DIR) : path.join(ROOT, 'data', 'assistant-panel-verification', CASE);
const report = { case: CASE, startedAt: new Date().toISOString(), checks: [], errors: [], boundary: 'Real Edge/Chromium, isolated panel and deterministic callback transport. VisualViewport and microphone events are controlled fixtures. This does not verify native iPad/Safari, an OS keyboard, a real microphone, an external model or the integrated SaaS host.' };
report.sourceHashes = Object.fromEntries(['assistant-panel.js', 'assistant-panel.css', 'test/assistant-panel-browser.cjs'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex')]));
let browser, page;
const a = name => 'button[data-assistant-action="' + name + '"]';
function save() { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(report, null, 2) + '\n'); }
async function check(name, fn) { report.current = name; save(); await fn(); report.checks.push({ name, passed: true }); save(); }
async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function ready() { await page.waitForFunction(() => FamilyAssistantPanel.getState().loaded && !FamilyAssistantPanel.getState().busy); }
async function open() { await page.click('#launcher'); await ready(); }
async function write(value) { await page.$eval('#assistant-chat-input', (node, value) => { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); }, value); }
async function state() { return page.evaluate(() => FamilyAssistantPanel.getState()); }
async function fixture(width = 390, height = 844, viewportOptions = {}) {
  page = await browser.newPage(); await page.setViewport({ width, height, deviceScaleFactor: 1, ...viewportOptions });
  page.on('pageerror', error => { report.errors.push(error.message); save(); });
  await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><button id="launcher">家庭小助手</button><form id="editor-form"><input id="original-draft" name="name" value="手动底稿要保留"></form></body></html>');
  for (const name of ['styles.css', 'farm-world.css', 'assistant-panel.css']) await page.addStyleTag({ path: path.join(ROOT, name) });
  await page.evaluate(() => {
    const duplicate = value => JSON.parse(JSON.stringify(value));
    window.__qaScope = 'family-a'; window.__qaAllowed = true; window.__qaRequests = []; window.__qaHeld = []; window.__qaApplies = []; window.__qaClose = []; window.__qaCleared = [];
    window.__qaModes = {}; window.__qaEscapes = 0; window.__qaPages = {};
    window.__qaSnapshot = { generation: 'g'.repeat(43), messages: [], draft: null, hasMore: false, nextCursor: null };
    window.__qaAction = { kind: 'action', title: '加分草稿', summary: '自主阅读 · 5 分', action: { type: 'points.add', payload: { name: '自主阅读', points: 5, reason: '认真阅读' } } };
    window.__qaInstallDraft = function (snapshot, turnId, result) {
      snapshot.messages = snapshot.messages.concat([{ role: 'user', text: '请整理', turnId }, { role: 'assistant', text: '已整理，请核对。', result, turnId }]);
      if (result.kind === 'action' || result.kind === 'form' || result.kind === 'steps') {
        const rows = result.kind === 'steps' ? result.steps : [result];
        snapshot.draft = { generation: snapshot.generation, turnId, result, sourceRevision: 3, familyDay: '2026-11-22', actions: rows.map((value, index) => ({ value, index })).filter(row => row.value.kind === 'action' || row.value.kind === 'form').map(row => ({ index: row.index, actionId: '00000000-0000-4000-8000-' + String(row.index + 1).padStart(12, '0'), type: row.value.action?.type || 'pointItem.save', status: 'pending' })) };
      }
    };
    window.__qaRequest = function (method, url, body, done) {
      const kind = url.split('/').pop(), call = { method, url, body: duplicate(body) }, handle = { aborted: false, abort() { this.aborted = true; } };
      __qaRequests.push(call);
      if (__qaModes[kind] === 'throw') throw new Error('Test transport exception');
      if (__qaModes[kind] === 'hold') { __qaHeld.push({ call, done, handle }); return handle; }
      setTimeout(() => {
        if (__qaModes[kind] === 'fail') { done(0, {}); return; }
        if (__qaModes[kind] === 'throw-result') { done(503, { code: 'SERVICE_UNAVAILABLE' }); return; }
        if (kind === 'clear') __qaSnapshot = { generation: 'z'.repeat(43), messages: [], draft: null, hasMore: false, nextCursor: null };
        if (kind === 'turn' && !__qaSnapshot.messages.some(message => message.turnId === body.turnId && message.role === 'assistant')) {
          const result = duplicate(window.__qaNextResult || { kind: 'answer', answer: '现在可用 5 分。' });
          __qaSnapshot.messages.push({ role: 'user', text: body.text, turnId: body.turnId }, { role: 'assistant', text: result.answer || '已整理，请核对。', result, turnId: body.turnId });
        }
        done(200, duplicate(body.cursor ? __qaPages[body.cursor] : __qaSnapshot));
      }, 10);
      return handle;
    };
    window.SpeechRecognition = function () { window.__qaVoice = this; this.start = function () {}; this.stop = function () {}; this.abort = function () { this.aborted = true; }; };
    document.addEventListener('keydown', event => { if (event.key === 'Escape') __qaEscapes++; });
  });
  await page.addScriptTag({ path: path.join(ROOT, 'assistant-panel.js') });
  await page.evaluate(() => {
    FamilyAssistantPanel.init({ request: __qaRequest, scope: () => __qaScope, context: () => ({ view: 'points', form: 'pointItem' }), contextLabel: () => '正在编辑常用行为', canOpen: () => __qaAllowed,
      applyResult: (result, meta) => { __qaApplies.push({ result, meta }); }, onClose: info => { __qaClose.push(info); }, onCleared: previous => { __qaCleared.push(previous); } });
    document.getElementById('launcher').addEventListener('click', function () { FamilyAssistantPanel.open({ trigger: this }); });
  });
}
async function draftUntouched() { assert.equal(await page.$eval('#original-draft', node => node.value), '手动底稿要保留'); }
async function geometry() {
  return page.evaluate(() => {
    const rect = node => node.getBoundingClientRect().toJSON(), viewport = visualViewport;
    const controls = ['#assistant-chat-input', '.assistant-voice', '#assistant-chat-send'].map(selector => {
      const node = document.querySelector(selector), r = rect(node);
      const hit = [r.top + 1, r.y + r.height / 2, r.bottom - 1].every(y =>
        node.contains(document.elementFromPoint(r.x + r.width / 2, y)));
      return { selector, rect: r, hit };
    });
    return { panel: rect(document.querySelector('#family-assistant-panel')), controls, viewport: { top: viewport.offsetTop, left: viewport.offsetLeft, width: viewport.width, height: viewport.height }, focused: document.activeElement.id, caret: document.querySelector('#assistant-chat-input').selectionStart, documentWidth: document.documentElement.scrollWidth, width: innerWidth };
  });
}
function withinGeometry(value) {
  const view = value.viewport;
  for (const [label, rect] of [['panel', value.panel], ...value.controls.map(item => [item.selector, item.rect])]) {
    assert.ok(rect.width > 0 && rect.height > 0 && rect.left >= view.left - 1 && rect.right <= view.left + view.width + 1 && rect.top >= view.top - 1 && rect.bottom <= view.top + view.height + 1, label + ' outside visible viewport: ' + JSON.stringify(value));
  }
  value.controls.forEach(control => assert.equal(control.hit, true, control.selector + ' is pointer hit-testable'));
  assert.equal(value.documentWidth, value.width);
}
async function layout() {
  for (const [width, height] of [[390, 844], [320, 568], [1024, 768], [844, 390], [1366, 768]]) {
    await fixture(width, height);
    await check(width + 'px opens without focusing the keyboard and keeps the form draft', async () => {
      await open(); const value = await geometry(); withinGeometry(value); assert.equal(value.focused, 'family-assistant-panel');
      assert.equal(await page.$eval(a('clear'), node => node.getClientRects().length), 0, 'a fresh conversation has nothing to clear');
      assert.equal(await page.$eval('#assistant-chat-count', node => node.getClientRects().length), 0);
      if (height >= 420) {
        const positions = await page.evaluate(() => {
          const rect = selector => document.querySelector(selector).getBoundingClientRect();
          return { headingEnd: rect('.assistant-welcome').bottom, inputTop: rect('.assistant-input-row').top,
            inputEnd: rect('.assistant-input-row').bottom, suggestionsTop: rect('.assistant-examples').top };
        });
        assert.ok(positions.headingEnd <= positions.inputTop && positions.inputTop - positions.headingEnd <= 32);
        assert.ok(positions.inputEnd <= positions.suggestionsTop && positions.suggestionsTop - positions.inputEnd <= 24);
      }
      assert.equal(Math.round(value.panel.width), width >= 900 ? 420 : width); await draftUntouched();
      assert.equal(await page.$eval('#assistant-panel-context', node => node.textContent), '正在编辑常用行为');
      const smallTargets = await page.$$eval('#family-assistant-panel button, #assistant-chat-input', nodes => nodes.filter(node => node.getClientRects().length).map(node => ({ label: node.textContent || node.getAttribute('aria-label'), width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })).filter(rect => rect.width < 47.9 || rect.height < 47.9));
      assert.deepEqual(smallTargets, [], 'all visible touch controls are at least 48px');
      if (width === 390) await page.screenshot({ path: path.join(OUT, 'welcome-phone.png') });
      if (width === 1024) await page.screenshot({ path: path.join(OUT, 'welcome-tablet.png') });
      if (width === 844) await page.screenshot({ path: path.join(OUT, 'short-landscape.png') });
      if (width >= 900) assert.ok(value.panel.left >= width - 450, 'a sidebar leaves the rest of the host visible');
    });
    await check(width + 'px keyboard resize and pan preserve the caret and reachable send button', async () => {
      await page.evaluate(() => {
        window.__qaViewport = { height: 310, offsetTop: 28, offsetLeft: 0, scale: 1 };
        for (const key of Object.keys(__qaViewport)) Object.defineProperty(visualViewport, key, { configurable: true, get: () => __qaViewport[key] });
        visualViewport.dispatchEvent(new Event('resize'));
      });
      await settle(); await page.click('#assistant-chat-input'); await page.type('#assistant-chat-input', '继续输入');
      await page.$eval('#assistant-chat-input', node => node.setSelectionRange(2, 2));
      await page.evaluate(() => { __qaViewport.offsetTop = 59; __qaViewport.height = 255; visualViewport.dispatchEvent(new Event('scroll')); });
      await settle(); const value = await geometry(); withinGeometry(value); assert.equal(value.focused, 'assistant-chat-input'); assert.equal(value.caret, 2);
      if (width === 390) await page.screenshot({ path: path.join(OUT, 'keyboard-phone.png') });
    });
    await check(width + 'px Escape only closes the assistant and restores the entry focus', async () => {
      await page.keyboard.press('Escape'); await settle(); assert.equal((await state()).open, false);
      assert.equal(await page.evaluate(() => __qaEscapes), 0); assert.equal(await page.evaluate(() => document.activeElement.id), 'launcher'); await draftUntouched();
    });
    await page.close();
  }
  await check('A single landscape tap starts dictation or sends the first message from a focused composer', async () => {
    await fixture(844, 390, { isMobile: true, hasTouch: true });
    await open();
    const input = '#assistant-chat-input', message = '我现在有多少积分？';
    const sentMessages = () => page.evaluate(() => __qaRequests.filter(call => call.url.endsWith('/turn')).map(call => call.body.text));
    await page.tap(input);
    await page.keyboard.type(message);
    await page.tap(a('voice'));
    const listening = (await state()).listening;
    const sentWhileListening = await sentMessages();
    await page.tap(input);
    await page.tap('#assistant-chat-send');
    assert.deepEqual({ listening, sentWhileListening, sent: await sentMessages() }, {
      listening: true, sentWhileListening: [], sent: [message]
    });
    await page.close();
  });
  await check('An empty landscape composer stays tappable as the keyboard shrinks and pans the viewport', async () => {
    await fixture(844, 390, { isMobile: true, hasTouch: true });
    await open();
    const input = '#assistant-chat-input';
    await page.tap(input);
    for (const [height, top] of [[120, 0], [150, 30], [188, 0], [390, 0], [120, 30]]) {
      await page.evaluate((height, top) => {
        Object.defineProperties(visualViewport, {
          height: { configurable: true, value: height }, offsetTop: { configurable: true, value: top }
        });
        visualViewport.dispatchEvent(new Event('resize'));
      }, height, top);
      await settle();
      const value = await geometry();
      withinGeometry(value);
      assert.ok(value.controls.every(({ rect }) => rect.height >= 48 && rect.width >= 48));
      assert.equal(value.focused, 'assistant-chat-input');
      if (height === 390) assert.ok(await page.$eval(a('example'), node => node.getClientRects().length), 'suggestions return when the keyboard closes');
      if (height === 120 && top === 0) {
        await page.screenshot({ path: path.join(OUT, 'empty-keyboard-120.png'), clip: { x: 0, y: 0, width: 844, height } });
      }
    }
    await page.tap(a('voice'));
    assert.equal((await state()).listening, true);
    withinGeometry(await geometry());
    await page.tap(input);
    await page.keyboard.type('查积分');
    await page.tap('#assistant-chat-send');
    assert.deepEqual(await page.evaluate(() => __qaRequests.filter(call => call.url.endsWith('/turn')).map(call => call.body.text)), ['查积分']);
    await page.tap(a('close'));
    assert.equal((await state()).open, false);
    await page.close();
  });
}
async function lifecycle() {
  await fixture(); await open();
  await check('Network failure keeps the turn UUID, text and next unsent message through retry', async () => {
    await page.evaluate(() => { __qaModes.turn = 'fail'; }); await write('查询可用积分'); await page.click('#assistant-chat-send');
    await page.waitForFunction(() => !!FamilyAssistantPanel.getState().error); assert.equal((await state()).pendingTurnId.length, 36);
    await write('接下来想问的消息'); assert.equal(await page.$eval('#assistant-chat-send', node => node.disabled), true);
    await page.evaluate(() => { __qaModes.turn = 'normal'; }); await page.click(a('retry')); await ready();
    const turns = await page.evaluate(() => __qaRequests.filter(call => call.url.endsWith('/turn')));
    assert.equal(turns.length, 2); assert.equal(turns[0].body.turnId, turns[1].body.turnId); assert.equal(turns[0].body.text, turns[1].body.text);
    assert.equal(await page.$eval('#assistant-chat-input', node => node.value), '接下来想问的消息'); assert.equal((await state()).pendingTurnId, '');
  });
  await check('Clear confirmation cancels safely, then rejects a late in-flight reply after clearing', async () => {
    await page.evaluate(() => { __qaModes.turn = 'hold'; }); await page.click('#assistant-chat-send'); await page.waitForFunction(() => __qaHeld.length > 0);
    await page.click(a('clear')); assert.equal((await state()).confirming, true); await page.keyboard.press('Escape'); assert.equal((await state()).open, true); assert.equal((await state()).confirming, false);
    assert.equal(await page.evaluate(() => __qaRequests.filter(call => call.url.endsWith('/clear')).length), 0);
    await page.click(a('clear')); await page.click(a('confirm-clear')); await ready();
    await page.evaluate(() => { const old = __qaHeld[0]; old.done(200, { generation: old.call.body.generation, messages: [{ role: 'assistant', text: '不应复活的旧回复', turnId: old.call.body.turnId }], draft: null }); });
    assert.equal((await state()).generation, 'z'.repeat(43)); assert.equal((await state()).messageCount, 0);
    assert.deepEqual(await page.evaluate(() => __qaCleared), ['g'.repeat(43)]);
    assert.equal(await page.$eval('#assistant-chat-log', node => node.textContent.includes('不应复活')), false); await draftUntouched();
  });
  await check('A reset and family change reject stale reads and voice callbacks', async () => {
    await page.evaluate(() => { FamilyAssistantPanel.close({ restoreFocus: false }); __qaModes.read = 'hold'; }); await page.click('#launcher');
    await page.waitForFunction(() => __qaHeld.some(value => value.call.url.endsWith('/read')));
    await page.evaluate(() => { FamilyAssistantPanel.reset(); __qaScope = 'family-b'; __qaModes.read = 'normal'; __qaSnapshot = { generation: 'b'.repeat(43), messages: [], draft: null }; });
    await open(); await page.evaluate(() => { const old = __qaHeld.find(value => value.call.url.endsWith('/read')); old.done(200, { generation: 'a'.repeat(43), messages: [{ role: 'assistant', text: '其他家庭私有消息' }] }); });
    assert.deepEqual(await page.evaluate(() => __qaCleared), ['g'.repeat(43)], 'reset and an initial read must not signal a cleared conversation');
    assert.equal((await state()).generation, 'b'.repeat(43)); assert.equal(await page.$eval('#assistant-chat-log', node => node.textContent.includes('其他家庭')), false); await draftUntouched();
  });
  await check('A changed-generation response replaces old candidates without replaying a prior turn', async () => {
    await page.evaluate(() => { __qaModes.turn = 'hold'; }); await write('旧会话消息'); await page.click('#assistant-chat-send');
    await page.evaluate(() => { const old = __qaHeld.filter(value => value.call.url.endsWith('/turn')).at(-1); old.done(409, { code: 'ASSISTANT_CHAT_CHANGED', snapshot: { generation: 'n'.repeat(43), messages: [], draft: null, hasMore: false, nextCursor: null } }); });
    assert.equal((await state()).generation, 'n'.repeat(43)); assert.equal((await state()).pendingTurnId, ''); assert.equal(await page.$eval('#assistant-chat-input', node => node.value), '');
    assert.deepEqual(await page.evaluate(() => __qaCleared), ['g'.repeat(43), 'b'.repeat(43)]);
  });
  await page.close(); await fixture();
  await check('A thrown request error can be recovered without touching the host draft', async () => {
    await page.evaluate(() => { __qaModes.read = 'throw'; }); await page.click('#launcher'); await page.waitForFunction(() => !!FamilyAssistantPanel.getState().error);
    assert.equal((await state()).loaded, false); await page.evaluate(() => { __qaModes.read = 'normal'; }); await page.click(a('retry')); await ready(); await draftUntouched();
  });
  await check('Opening twice keeps the original return focus', async () => {
    await page.evaluate(() => FamilyAssistantPanel.open()); await ready(); await page.click(a('close')); await settle();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'launcher'); await open();
  });
  await check('Pending server turns are read until completion without automatically resending', async () => {
    await page.evaluate(() => { __qaSnapshot.messages = [{ role: 'user', text: '等待中的消息', turnId: 'pending-turn' }]; __qaSnapshot.pending = { turnId: 'pending-turn' }; FamilyAssistantPanel.refresh(); });
    await page.waitForFunction(() => FamilyAssistantPanel.getState().busy && document.querySelector('#assistant-chat-log').textContent.includes('等待中的消息'));
    await page.evaluate(() => { __qaSnapshot.messages.push({ role: 'assistant', text: '等待后的答复', turnId: 'pending-turn', result: { kind: 'answer', source: 'local', answer: '等待后的答复' } }); delete __qaSnapshot.pending; });
    await page.waitForFunction(() => !FamilyAssistantPanel.getState().busy && document.querySelector('#assistant-chat-log').textContent.includes('等待后的答复'), { timeout: 5000 });
    assert.equal(await page.evaluate(() => __qaRequests.some(call => call.url.endsWith('/turn'))), false); await draftUntouched();
  });
  await check('A failed turn from another device restores the original text and context for explicit retry', async () => {
    const original = await page.evaluate(() => {
      const turn = {generation:__qaSnapshot.generation,turnId:'00000000-0000-4000-8000-000000000099',text:'查看之前的提醒',context:{view:'reminders',form:'task',targetId:'original-task'}};
      __qaSnapshot.messages.push({role:'user',text:turn.text,turnId:turn.turnId,failed:true});
      __qaSnapshot.retryTurn = turn; FamilyAssistantPanel.refresh(); return turn;
    });
    await page.waitForSelector(a('retry'), { visible:true });
    assert.equal((await state()).pendingTurnId, original.turnId);
    assert.equal(await page.evaluate(() => __qaRequests.some(call => call.url.endsWith('/turn'))), false);
    await write('下一条消息'); assert.equal(await page.$eval('#assistant-chat-send', node => node.disabled), false);
    await page.click(a('retry')); await ready();
    assert.deepEqual(await page.evaluate(() => __qaRequests.filter(call => call.url.endsWith('/turn')).map(call => call.body)), [original]);
    assert.equal(await page.$eval('#assistant-chat-input', node => node.value), '下一条消息');
    assert.equal((await state()).pendingTurnId, '');
  });
}
async function drafts() {
  await fixture();
  await page.evaluate(() => {
    const oldId = '00000000-0000-4000-8000-000000000010', turnId = '00000000-0000-4000-8000-000000000020';
    __qaInstallDraft(__qaSnapshot, oldId, __qaAction);
    const steps = { kind: 'steps', steps: [__qaAction, { kind: 'route', route: 'redemptions', title: '兑换记录' }, __qaAction, { kind: 'form', form: 'pointItem', fields: { name: '自己整理书包', points: 6 }, question: '请核对。' }] };
    __qaInstallDraft(__qaSnapshot, turnId, steps); __qaSnapshot.draft.actions.find(action => action.index === 2).status = 'committed';
  });
  await open();
  await check('Only pending current draft steps have handoff controls; old and committed cards are read-only', async () => {
    const indices = await page.$$eval(a('apply'), nodes => nodes.map(node => Number(node.dataset.stepIndex)));
    assert.deepEqual(indices, [0, 3]); assert.equal(await page.$$eval('.assistant-message:not(.assistant-message-current) ' + a('apply'), nodes => nodes.length), 0);
    assert.equal(await page.$$eval('.assistant-current-draft ' + a('route'), nodes => nodes.length), 1); await draftUntouched();
  });
  await check('Handoff sends the original step index and stable draft action ID without writing business data', async () => {
    await page.click(a('apply') + '[data-step-index="3"]'); assert.equal((await state()).open, false);
    const applies = await page.evaluate(() => __qaApplies); assert.equal(applies.length, 1); assert.equal(applies[0].result.form, 'pointItem');
    assert.equal(applies[0].meta.index, 3); assert.equal(applies[0].meta.actionId, '00000000-0000-4000-8000-000000000004'); assert.equal(applies[0].meta.draft.turnId, '00000000-0000-4000-8000-000000000020');
    assert.equal(await page.evaluate(() => __qaRequests.some(call => /\/action|\/parent\//.test(call.url))), false); await draftUntouched();
  });
  await check('Read-only navigation is a separate handoff with no business action mapping', async () => {
    await open(); await page.click('.assistant-current-draft ' + a('route'));
    const last = await page.evaluate(() => __qaApplies.at(-1)); assert.equal(last.result.route, 'redemptions'); assert.equal(last.meta.index, 1); assert.equal(last.meta.readOnly, true); assert.equal(last.meta.actionId, undefined);
    await draftUntouched();
  });
  await check('Completed snapshots remove every actionable draft control', async () => {
    await page.evaluate(() => { __qaSnapshot.draft = null; __qaSnapshot.messages.forEach(message => { if (message.role === 'assistant') message.committed = true; }); });
    await open(); assert.equal(await page.$$eval(a('apply'), nodes => nodes.length), 0); assert.equal((await state()).draft, null);
  });
  await check('Current cards replace duplicated prose and show the actual response source', async () => {
    await page.evaluate(() => {
      __qaSnapshot.messages = [];
      __qaInstallDraft(__qaSnapshot, '00000000-0000-4000-8000-000000000030', { ...__qaAction, source: 'local', mode: 'local' });
      __qaSnapshot.messages.at(-1).text = '确认本次加分：自主阅读 · 5 分'; FamilyAssistantPanel.refresh();
    }); await ready();
    assert.equal(await page.$$eval('.assistant-message-current .assistant-message-text', nodes => nodes.length), 0);
    assert.equal(await page.$eval('.assistant-message-current .assistant-message-source', node => node.textContent), '本地');
    await page.screenshot({ path: path.join(OUT, 'draft-phone.png') });
    for (const [source, mode, label, expected] of [['model', 'connected', 'AI已整理', 'AI'], ['local', 'connected', 'AI已接入', '本地'], ['fallback', 'local', 'AI暂不可用', 'AI 未完成，使用本地'], ['fallback', 'local', 'AI请求超时', 'AI 超时，使用本地']]) {
      await page.evaluate(({ source, mode, label }) => { Object.assign(__qaSnapshot.messages.at(-1).result, { source, mode, label }); Object.assign(__qaSnapshot.draft.result, { source, mode, label }); FamilyAssistantPanel.refresh(); }, { source, mode, label });
      await ready(); assert.equal(await page.$eval('.assistant-message-current .assistant-message-source', node => node.textContent), expected);
    }
  });
  await check('Additional information stays visible alongside the current draft card', async () => {
    await page.evaluate(() => { __qaSnapshot.messages.at(-1).text = '这次是临时加分，还没有设为常用行为。'; FamilyAssistantPanel.refresh(); }); await ready();
    assert.equal(await page.$eval('.assistant-message-current .assistant-message-text', node => node.textContent), '这次是临时加分，还没有设为常用行为。');
  });
  await check('Model prose alongside a tool card is preserved once in both pending and historical messages', async () => {
    const prose = '确认本次加分。';
    await page.evaluate(answer => {
      __qaInstallDraft(__qaSnapshot, '00000000-0000-4000-8000-000000000031', {kind:'steps',source:'model',
        steps:[__qaAction,{kind:'answer',scope:'conversation',answer}]});
      FamilyAssistantPanel.refresh();
    }, prose); await ready();
    assert.deepEqual(await page.$$eval('.assistant-message-current .assistant-step-note', nodes => nodes.map(node => node.textContent)), [prose]);
    await page.evaluate(() => {
      __qaInstallDraft(__qaSnapshot, '00000000-0000-4000-8000-000000000032', __qaAction);
      FamilyAssistantPanel.refresh();
    }); await ready();
    const historical = await page.$$eval('.assistant-message:not(.assistant-message-current) .assistant-message-text', nodes => nodes.map(node => node.textContent));
    assert.equal(historical.filter(text => text === prose).length, 1);
  });
  await check('Failed synchronization disables a cached draft until a fresh read succeeds', async () => {
    await page.evaluate(() => { __qaModes.read = 'fail'; FamilyAssistantPanel.refresh(); }); await page.waitForFunction(() => !!FamilyAssistantPanel.getState().error);
    assert.equal(await page.$eval(a('apply'), node => node.disabled), true);
    await page.evaluate(() => { __qaModes.read = 'normal'; }); await page.click(a('retry')); await ready();
    assert.equal(await page.$eval(a('apply'), node => node.disabled), false);
  });
  await check('A new turn makes prior draft cards read-only even when its network result is uncertain', async () => {
    await page.evaluate(() => { __qaModes.turn = 'fail'; }); await write('把刚才的草稿再调整一下'); await page.click('#assistant-chat-send'); await page.waitForFunction(() => !!FamilyAssistantPanel.getState().error);
    assert.equal((await state()).draft, null); assert.equal(await page.$$eval(a('apply'), nodes => nodes.length), 0);
  });
}
async function voice() {
  await fixture(); await open();
  await check('Example chips prepare text without requesting a turn or automatically focusing the input', async () => {
    await page.click(a('example')); assert.ok(await page.$eval('#assistant-chat-input', node => node.value.length > 0));
    assert.equal(await page.evaluate(() => document.activeElement.id === 'assistant-chat-input'), false);
    assert.equal(await page.evaluate(() => __qaRequests.filter(call => call.url.endsWith('/turn')).length), 0);
  });
  await check('The composer shows its character limit near capacity and hides it after a shorter edit', async () => {
    await write('读'.repeat(1150));
    assert.equal(await page.$eval('#assistant-chat-count', node => node.innerText), '1150 / 1200');
    assert.ok(await page.$eval('#assistant-chat-count', node => node.getClientRects().length));
    assert.equal(await page.$eval('#assistant-chat-input', node => node.maxLength), 1200);
    await write('查积分');
    assert.equal(await page.$eval('#assistant-chat-count', node => node.getClientRects().length), 0);
  });
  await check('Recognition only transcribes; manual editing aborts late microphone callbacks', async () => {
    await write('原有文字'); await page.click(a('voice'));
    await page.evaluate(() => { window.__qaLateVoice = __qaVoice.onresult; __qaVoice.onresult({ results: [[{ transcript: '语音转成文字' }]] }); });
    assert.equal(await page.$eval('#assistant-chat-input', node => node.value), '原有文字\n语音转成文字');
    assert.equal(await page.evaluate(() => __qaRequests.filter(call => call.url.endsWith('/turn')).length), 0);
    await write('我手动改过了'); await page.evaluate(() => __qaLateVoice({ results: [[{ transcript: '迟到结果不覆盖' }]] }));
    assert.equal(await page.$eval('#assistant-chat-input', node => node.value), '我手动改过了'); assert.equal((await state()).listening, false); await draftUntouched();
  });
  await check('Microphone denial keeps typing available and never sends a message', async () => {
    await page.click(a('voice')); await page.evaluate(() => { __qaVoice.onerror({ error: 'not-allowed' }); __qaVoice.onend(); });
    assert.match(await page.$eval('#assistant-chat-status', node => node.textContent), /未获授权/); assert.equal(await page.$eval('#assistant-chat-input', node => node.disabled), false);
    assert.equal(await page.evaluate(() => __qaRequests.filter(call => call.url.endsWith('/turn')).length), 0);
  });
  await check('Closing invalidates recognition and Escape does not dismiss the host form', async () => {
    await page.click(a('voice')); await page.evaluate(() => { window.__qaClosedVoice = __qaVoice.onresult; }); await page.keyboard.press('Escape');
    await page.evaluate(() => __qaClosedVoice({ results: [[{ transcript: '收起后的迟到文字' }]] })); await settle();
    assert.equal((await state()).open, false); assert.equal(await page.evaluate(() => __qaEscapes), 0); await draftUntouched();
  });
}
async function history() {
  await fixture(); await page.evaluate(() => {
    const batch = (first, last) => Array.from({ length: last - first + 1 }, (_, offset) => { const turnId = 't' + (first + offset); return [{ role: 'user', text: '用户消息 ' + turnId, turnId }, { role: 'assistant', text: '助手回复 ' + turnId, turnId }]; }).flat();
    __qaSnapshot.messages = batch(31, 60); __qaSnapshot.hasMore = true; __qaSnapshot.nextCursor = 'older-30';
    __qaPages['older-30'] = { generation: __qaSnapshot.generation, messages: batch(1, 30), hasMore: false, nextCursor: null, draft: null };
  }); await open();
  await check('Initial read loads one page and the history button requests only the opaque cursor', async () => {
    assert.equal((await state()).messageCount, 60); assert.equal(await page.evaluate(() => __qaRequests.filter(call => call.url.endsWith('/read')).length), 1);
    await page.$eval('#assistant-chat-log', node => { node.scrollTop = 0; });
    await page.click(a('history')); await ready(); const reads = await page.evaluate(() => __qaRequests.filter(call => call.url.endsWith('/read')));
    assert.equal(reads.length, 2); assert.equal(reads[1].body.cursor, 'older-30'); assert.equal(reads[1].body.generation, 'g'.repeat(43));
    assert.equal((await state()).messageCount, 120); assert.equal((await state()).hasMore, false);
    const sequence = await page.$$eval('.assistant-message-text', nodes => nodes.map(node => node.textContent)); assert.equal(sequence[0], '用户消息 t1'); assert.equal(sequence.at(-1), '助手回复 t60');
  });
  await check('Refreshing a loaded history preserves earlier pages without duplicates', async () => {
    await page.evaluate(() => FamilyAssistantPanel.refresh()); await ready(); assert.equal((await state()).messageCount, 120); assert.equal((await state()).hasMore, false);
  });
  await check('Clear resets paging and removes prior-generation history', async () => {
    await page.click(a('clear')); await page.click(a('confirm-clear')); await ready(); assert.equal((await state()).messageCount, 0); assert.equal((await state()).hasMore, false);
    assert.equal(await page.$$eval(a('history'), nodes => nodes.length), 0); assert.equal(await page.$eval('#assistant-chat-log', node => node.textContent.includes('用户消息')), false); await draftUntouched();
  });
}

(async () => {
  save(); browser = await B.launch();
  try {
    await ({ layout, lifecycle, drafts, voice, history })[CASE]();
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(OUT, 'panel.png') });
    assert.deepEqual(report.errors, []); report.passed = true;
  } catch (error) { report.passed = false; report.failure = { message: error.message, stack: error.stack }; if (page && !page.isClosed()) await page.screenshot({ path: path.join(OUT, 'failure.png') }); throw error; }
  finally { report.finishedAt = new Date().toISOString(); save(); await browser.close(); }
  console.log(CASE + ': ' + report.checks.length + ' checks passed. Evidence: ' + OUT);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
