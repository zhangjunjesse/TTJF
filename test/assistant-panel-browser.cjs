'use strict';

// Each case is a short browser run with progress and results on disk.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const B = require('./browser.cjs');
const ROOT = path.resolve(__dirname, '..');
const CASE = process.env.ASSISTANT_PANEL_CASE || 'layout';
assert.ok(['layout', 'lifecycle', 'drafts', 'voice', 'hold', 'hold-touch', 'native-readiness', 'history', 'receipts', 'mixed-notes'].includes(CASE));
const OUT = process.env.TEST_ARTIFACT_DIR ? path.resolve(process.env.TEST_ARTIFACT_DIR) : path.join(ROOT, 'data', 'assistant-panel-verification', CASE);
const report = { case: CASE, startedAt: new Date().toISOString(), checks: [], errors: [], boundary: 'Real Edge/Chromium, isolated panel and deterministic callback transport. VisualViewport and microphone events are controlled fixtures. This does not verify native iPad/Safari, an OS keyboard, a real microphone, an external model or the integrated SaaS host.' };
report.sourceHashes = Object.fromEntries(['assistant.js', 'assistant-panel.js', 'assistant-panel.css', 'test/assistant-panel-browser.cjs'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex')]));
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
    window.SpeechRecognition = function () {
      window.__qaVoice = this;
      this.start = function () { for (const event of window.__qaVoiceStartEvents || ['onstart', 'onaudiostart']) if (this[event]) this[event](); };
      this.stop = function () { this.stopped = true; };
      this.abort = function () { this.aborted = true; };
    };
    document.addEventListener('keydown', event => { if (event.key === 'Escape') __qaEscapes++; });
  });
  await page.addScriptTag({ path: path.join(ROOT, 'assistant.js') });
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
    const controls = ['#assistant-chat-input', '.assistant-voice', '#assistant-chat-send', '[data-assistant-action="hold-voice"]'].map(selector => {
      const node = document.querySelector(selector), r = rect(node);
      if (!node.getClientRects().length) return null;
      const hit = [r.top + 1, r.y + r.height / 2, r.bottom - 1].every(y =>
        node.contains(document.elementFromPoint(r.x + r.width / 2, y)));
      return { selector, rect: r, hit };
    }).filter(Boolean);
    return { panel: rect(document.querySelector('#family-assistant-panel')), composer: rect(document.querySelector('.assistant-composer')), controls, viewport: { top: viewport.offsetTop, left: viewport.offsetLeft, width: viewport.width, height: viewport.height }, focused: document.activeElement.id, caret: document.querySelector('#assistant-chat-input').selectionStart, documentWidth: document.documentElement.scrollWidth, width: innerWidth };
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
function composerAtBottom(value) {
  assert.ok(value.panel.bottom - value.composer.bottom >= -1 && value.panel.bottom - value.composer.bottom <= 20,
    'the composer remains at the panel bottom: ' + JSON.stringify(value));
}
function visibleComposer(value, editing) {
  assert.deepEqual(value.controls.map(control => control.selector), editing
    ? ['#assistant-chat-input', '.assistant-voice', '#assistant-chat-send']
    : ['#assistant-chat-input', '[data-assistant-action="hold-voice"]']);
}
async function layout() {
  for (const [width, height] of [[390, 844], [320, 568], [1024, 768], [844, 390], [1366, 768]]) {
    await fixture(width, height);
    await check(width + 'px opens without focusing the keyboard and keeps the form draft', async () => {
      await open(); const value = await geometry(); withinGeometry(value); composerAtBottom(value); visibleComposer(value, false); assert.equal(value.focused, 'family-assistant-panel');
      assert.equal(await page.$eval(a('clear'), node => node.getClientRects().length), 0, 'a fresh conversation has nothing to clear');
      assert.equal(await page.$eval('#assistant-chat-count', node => node.getClientRects().length), 0);
      if (height >= 420) {
        const positions = await page.evaluate(() => {
          const rect = selector => document.querySelector(selector).getBoundingClientRect();
          return { headingEnd: rect('.assistant-welcome').bottom, inputTop: rect('.assistant-input-row').top,
            suggestionsTop: rect('.assistant-examples').top, suggestionsEnd: rect('.assistant-examples').bottom };
        });
        assert.ok(positions.headingEnd <= positions.suggestionsTop, 'welcome content precedes the suggestions');
        assert.ok(positions.suggestionsEnd <= positions.inputTop && positions.inputTop - positions.suggestionsEnd <= 32,
          'suggestions sit above the bottom composer');
        assert.ok(value.composer.top > value.panel.top + value.panel.height * 0.65, 'the empty mobile composer is not vertically centered');
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
      await settle(); const value = await geometry(); withinGeometry(value); composerAtBottom(value); visibleComposer(value, true); assert.equal(value.focused, 'assistant-chat-input'); assert.equal(value.caret, 2);
      if (width === 390) await page.screenshot({ path: path.join(OUT, 'keyboard-phone.png') });
    });
    await check(width + 'px active conversations keep the composer at the bottom', async () => {
      await page.click('#assistant-chat-send'); await ready();
      const value = await geometry(); withinGeometry(value); composerAtBottom(value);
      assert.equal((await state()).messageCount, 2);
      assert.equal(await page.$eval('.assistant-welcome', node => node.getClientRects().length), 0);
      if (width === 390) await page.screenshot({ path: path.join(OUT, 'active-keyboard-phone.png') });
    });
    await check(width + 'px Escape only closes the assistant and restores the entry focus', async () => {
      await page.keyboard.press('Escape'); await settle(); assert.equal((await state()).open, false);
      assert.equal(await page.evaluate(() => __qaEscapes), 0); assert.equal(await page.evaluate(() => document.activeElement.id), 'launcher'); await draftUntouched();
    });
    await page.close();
  }
  for (const touch of [false, true]) {
    const mode = touch ? 'touch' : 'mouse';
    await check('A first ' + mode + ' activation at the suggestion edge fills the focused empty composer without sending', async () => {
      await fixture(390, 844, touch ? { isMobile: true, hasTouch: true } : {});
      await open();
      const input = '#assistant-chat-input', prompt = '我现在有多少积分？';
      if (touch) await page.tap(input); else await page.click(input);
      await settle();
      assert.equal(await page.evaluate(() => document.activeElement.id), 'assistant-chat-input');
      assert.equal(await page.$eval(input, node => node.value), '');
      const point = await page.$eval(a('example'), node => {
        const rect = node.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.bottom - 2;
        return { x, y, label: node.textContent, hit: node.contains(document.elementFromPoint(x, y)) };
      });
      assert.equal(point.label, '查积分'); assert.equal(point.hit, true, 'the suggestion edge is reachable before pressing');
      // Keep the same physical point through release, even if focus changes its layout.
      if (touch) await page.touchscreen.tap(point.x, point.y);
      else { await page.mouse.move(point.x, point.y); await page.mouse.down(); await settle(); await page.mouse.up(); }
      await settle();
      assert.equal(await page.$eval(input, node => node.value), prompt, 'the first activation inserts the selected prompt');
      assert.deepEqual(await page.evaluate(() => __qaRequests.filter(call => call.url.endsWith('/turn'))), [], 'a suggestion does not submit a turn');
      assert.equal((await state()).messageCount, 0);
      if (touch) await page.tap(input); else await page.click(input);
      await page.keyboard.press('End'); await page.keyboard.type(' 请核对。');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'assistant-chat-input');
      assert.equal(await page.$eval(input, node => node.value), prompt + ' 请核对。', 'the suggested prompt remains editable');
      assert.deepEqual(await page.evaluate(() => __qaRequests.filter(call => call.url.endsWith('/turn'))), []);
      withinGeometry(await geometry()); await draftUntouched();
      await page.screenshot({ path: path.join(OUT, 'example-edge-' + mode + '.png') });
      await page.close();
    });
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
      withinGeometry(value); composerAtBottom(value); visibleComposer(value, true);
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
    await page.click('#assistant-chat-input');
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
const sentTexts = () => page.evaluate(() => __qaRequests.filter(call => call.url.endsWith('/turn')).map(call => call.body.text));
async function holdFixture(width = 390, height = 844, withHistory = false) {
  if (page && !page.isClosed()) await page.close();
  await fixture(width, height, { isMobile: true, hasTouch: true });
  if (withHistory) await page.evaluate(() => {
    __qaSnapshot.messages = [
      { role: 'user', text: '今天可以帮我做些什么？', turnId: 'fixture-history' },
      { role: 'assistant', text: '可以查询积分，也可以帮你整理草稿。', turnId: 'fixture-history', result: { kind: 'answer', source: 'local', answer: '可以查询积分，也可以帮你整理草稿。' } }
    ];
  });
  await open();
}
async function saveVoiceCallbacks() {
  await page.evaluate(() => { __qaSavedVoice = { start: __qaVoice.onstart, audioStart: __qaVoice.onaudiostart, result: __qaVoice.onresult, end: __qaVoice.onend, error: __qaVoice.onerror, nomatch: __qaVoice.onnomatch }; });
}
async function startHold(touch = false, waitReady = true) {
  await page.waitForSelector(a('hold-voice'), { visible: true, timeout: 2000 });
  const point = await page.$eval(a('hold-voice'), node => {
    const r = node.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    return { x, y, disabled: node.disabled, hit: node.contains(document.elementFromPoint(x, y)) };
  });
  assert.equal(point.disabled, false); assert.equal(point.hit, true, 'the hold control is reachable before pressing');
  const gesture = { ...point, touch };
  if (touch) {
    gesture.client = await page.createCDPSession();
    await gesture.client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
  } else { await page.mouse.move(point.x, point.y); await page.mouse.down(); }
  await page.waitForFunction(ready => FamilyAssistantPanel.getState()[ready ? 'listening' : 'holding'] && !document.querySelector('.assistant-recording').hidden, { timeout: 2000 }, waitReady);
  await saveVoiceCallbacks();
  return gesture;
}
async function moveHold(gesture, x, y) {
  if (gesture.touch) await gesture.client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] });
  else await page.mouse.move(x, y);
  await settle();
}
async function releaseHold(gesture, cancel = false) {
  if (gesture.touch) {
    await gesture.client.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
    await gesture.client.detach();
  } else await page.mouse.up();
}
async function hear(segments) {
  await page.evaluate(segments => {
    const results = segments.map(segment => {
      const row = [{ transcript: segment.text }];
      if (Object.prototype.hasOwnProperty.call(segment, 'confidence')) row[0].confidence = segment.confidence;
      for (const alternative of segment.alternatives || []) row.push({ transcript: alternative.text, confidence: alternative.confidence });
      row.isFinal = segment.final === true;
      return row;
    });
    __qaVoice.onresult({ results });
  }, segments);
}
const holdLongEnough = () => new Promise(resolve => setTimeout(resolve, 340));
async function recordingSettled() {
  await page.$eval('.assistant-recording', async node => {
    await new Promise(resolve => requestAnimationFrame(resolve));
    const finite = node.getAnimations({ subtree: true }).filter(animation =>
      animation.effect && Number.isFinite(animation.effect.getComputedTiming().endTime));
    await Promise.all(finite.map(animation => animation.finished.catch(() => {})));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}
function recordingAppearance() {
  return page.$eval('.assistant-recording', node => {
    const wave = node.querySelector('.assistant-recording-wave'), hint = node.querySelector('.assistant-recording-hint');
    return {
      media: { reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, forcedColors: matchMedia('(forced-colors: active)').matches },
      ink: getComputedStyle(hint).color, hint: hint.textContent, hintRect: hint.getBoundingClientRect().toJSON(),
      layers: [null, '::before', '::after'].map(pseudo => {
        const style = getComputedStyle(node, pseudo);
        return { pseudo, content: style.content, display: style.display, visibility: style.visibility, opacity: style.opacity,
          background: style.backgroundColor, image: style.backgroundImage, position: style.backgroundPosition,
          mask: style.maskImage, transform: style.transform };
      }),
      wave: { height: wave.getBoundingClientRect().height,
        bars: Array.from(wave.children, bar => bar.getBoundingClientRect().height) }
    };
  });
}
async function recordingFrames() {
  await recordingSettled();
  const first = await recordingAppearance(); await B.delay(170);
  const middle = await recordingAppearance(); await B.delay(230);
  return [first, middle, await recordingAppearance()];
}
async function endRecognition() { await page.evaluate(() => __qaVoice.onend()); }
async function lateRecognition() {
  await page.evaluate(() => {
    const row = [{ transcript: '迟到结果不应覆盖或发送', confidence: 0.99 }]; row.isFinal = true;
    __qaSavedVoice.result({ results: [row] }); __qaSavedVoice.end(); __qaSavedVoice.end();
  });
}
async function editableTranscript(expected) {
  assert.equal(await page.$eval('#assistant-chat-input', node => node.value), expected);
  assert.equal(await page.$eval('#assistant-chat-send', node => node.disabled), false);
  const value = await geometry(); withinGeometry(value); composerAtBottom(value); visibleComposer(value, true);
  assert.deepEqual(await sentTexts(), []);
  await draftUntouched();
}
async function hold() {
  await check('A reliable final stays on the recording overlay until release, then sends only once after recognition ends', async () => {
    await holdFixture(390, 844, true); const gesture = await startHold();
    await hear([{ text: '我现在有多少积分？', final: true, confidence: 0.96 }]);
    assert.equal(await page.$eval('#assistant-chat-input', node => node.value), '');
    assert.match(await page.$eval('.assistant-recording', node => node.textContent), /我现在有多少积分/);
    assert.deepEqual(await sentTexts(), []);
    await recordingSettled();
    await page.screenshot({ path: path.join(OUT, 'hold-listening-phone.png') });
    await holdLongEnough(); await releaseHold(gesture);
    assert.deepEqual(await sentTexts(), [], 'release waits for the recognizer to finalize');
    await endRecognition(); await page.waitForFunction(() => __qaRequests.some(call => call.url.endsWith('/turn'))); await ready();
    await lateRecognition(); await settle();
    assert.deepEqual(await sentTexts(), ['我现在有多少积分？']);
    assert.equal(await page.$eval('#assistant-chat-input', node => node.value), '');
    assert.equal(await page.$eval('.assistant-recording', node => node.getClientRects().length), 0);
    const composer = await geometry(); withinGeometry(composer); visibleComposer(composer, false);
    assert.equal(await page.$eval(a('hold-voice'), node => node.disabled), false, 'successful send returns to a usable hold composer');
    await page.screenshot({ path: path.join(OUT, 'hold-sent-phone.png') }); await draftUntouched();
    await page.evaluate(() => { __qaFirstVoice = __qaSavedVoice; });
    const second = await startHold();
    await page.evaluate(() => {
      const row = [{ transcript: '上一轮不应混入下一轮', confidence: 0.99 }]; row.isFinal = true;
      __qaFirstVoice.result({ results: [row] }); __qaFirstVoice.end();
    });
    assert.equal((await state()).listening, true); assert.deepEqual(await sentTexts(), ['我现在有多少积分？']);
    await hear([{ text: '再查一下可兑换积分', final: true, confidence: 0.96 }]); await holdLongEnough(); await releaseHold(second); await endRecognition();
    await page.waitForFunction(() => __qaRequests.filter(call => call.url.endsWith('/turn')).length === 2); await ready();
    assert.deepEqual(await sentTexts(), ['我现在有多少积分？', '再查一下可兑换积分']);
    visibleComposer(await geometry(), false);
  });
  await check('A final received after release can complete the same held utterance without a duplicate send', async () => {
    await holdFixture(); const gesture = await startHold();
    await hear([{ text: '请查一下', final: false }]); await holdLongEnough(); await releaseHold(gesture);
    assert.deepEqual(await sentTexts(), []);
    await hear([{ text: '请查一下积分', final: true, confidence: 0.96 }]); await endRecognition();
    await page.waitForFunction(() => __qaRequests.some(call => call.url.endsWith('/turn'))); await ready();
    await lateRecognition(); assert.deepEqual(await sentTexts(), ['请查一下积分']);
  });
  await check('Sliding upward and releasing discards even a reliable final and invalidates late results', async () => {
    await holdFixture(390, 844, true); const gesture = await startHold();
    await hear([{ text: '这段语音要取消', final: true, confidence: 0.96 }]); await holdLongEnough();
    await moveHold(gesture, gesture.x, gesture.y - 100);
    assert.equal(await page.$eval('.assistant-recording', node => node.dataset.cancel), 'true');
    await recordingSettled();
    await page.screenshot({ path: path.join(OUT, 'hold-cancel-phone.png') });
    await releaseHold(gesture); await lateRecognition(); await settle();
    assert.deepEqual(await sentTexts(), []); assert.equal(await page.$eval('#assistant-chat-input', node => node.value), '');
    assert.equal((await state()).listening, false); assert.equal(await page.$eval('.assistant-recording', node => node.getClientRects().length), 0);
    await draftUntouched();
  });
  await check('An interim-only recording stays editable until the user explicitly sends it', async () => {
    await holdFixture(); const gesture = await startHold();
    await hear([{ text: '明天早上提醒带水杯', final: false }]); await holdLongEnough(); await releaseHold(gesture); await endRecognition();
    await editableTranscript('明天早上提醒带水杯');
    await write('明天七点半提醒带水杯'); await page.click('#assistant-chat-send'); await ready();
    assert.deepEqual(await sentTexts(), ['明天七点半提醒带水杯']);
  });
  for (const [label, confidence, alternatives] of [
    ['low confidence', 0.4, []], ['missing confidence', undefined, []],
    ['conflicting numbers', 0.96, [{ text: '自主阅读加十分', confidence: 0.94 }]]
  ]) await check('A final with ' + label + ' remains an editable draft', async () => {
    await holdFixture(); const gesture = await startHold();
    const segment = { text: '自主阅读加五分', final: true, alternatives };
    if (confidence !== undefined) segment.confidence = confidence;
    await hear([segment]); await holdLongEnough(); await releaseHold(gesture); await endRecognition();
    await editableTranscript('自主阅读加五分');
  });
  await check('A no-match signal keeps a later final editable instead of automatically sending it', async () => {
    await holdFixture(); const gesture = await startHold();
    await page.evaluate(() => __qaVoice.onnomatch());
    await hear([{ text: '需要再核对的语音', final: true, confidence: 0.96 }]);
    await holdLongEnough(); await releaseHold(gesture); await endRecognition(); await editableTranscript('需要再核对的语音');
  });
  await check('Missing recognition completion times out to an editable draft and rejects a late final', async () => {
    await holdFixture(); const gesture = await startHold();
    await hear([{ text: '没有结束回调的语音', final: true, confidence: 0.96 }]); await holdLongEnough(); await releaseHold(gesture);
    await page.waitForFunction(() => document.querySelector('#assistant-chat-input').value === '没有结束回调的语音', { timeout: 2500 });
    await editableTranscript('没有结束回调的语音'); await lateRecognition(); await editableTranscript('没有结束回调的语音');
  });
  await check('A recognizer that ends before the finger is released keeps its text for review', async () => {
    await holdFixture(); const gesture = await startHold();
    await hear([{ text: '先核对一下这句话', final: true, confidence: 0.96 }]); await endRecognition();
    assert.deepEqual(await sentTexts(), []); await holdLongEnough(); await releaseHold(gesture);
    await editableTranscript('先核对一下这句话');
  });
  await check('A manual draft typed during recording wins over the utterance and all late callbacks', async () => {
    await holdFixture(); const gesture = await startHold();
    await hear([{ text: '还没有确认的语音', final: true, confidence: 0.96 }]);
    await write('我已经手动改好的草稿'); await releaseHold(gesture); await lateRecognition();
    await editableTranscript('我已经手动改好的草稿');
    await page.click(a('close')); await open(); await editableTranscript('我已经手动改好的草稿');
  });
  await check('Closing during release finalization invalidates the microphone before reopening', async () => {
    await holdFixture(); const gesture = await startHold();
    await hear([{ text: '收起后不应发送', final: true, confidence: 0.96 }]); await holdLongEnough(); await releaseHold(gesture);
    await page.click(a('close')); await lateRecognition(); await open();
    assert.deepEqual(await sentTexts(), []); assert.equal(await page.$eval('#assistant-chat-input', node => node.value), '');
    assert.equal((await state()).listening, false); await draftUntouched();
  });
  await check('Resetting and switching families reject the old recording callbacks and preserve the new draft', async () => {
    await holdFixture(); const gesture = await startHold();
    await hear([{ text: '旧家庭的语音', final: true, confidence: 0.96 }]);
    await page.evaluate(() => { FamilyAssistantPanel.reset(); __qaScope = 'family-b'; __qaSnapshot = { generation: 'b'.repeat(43), messages: [], draft: null }; });
    await releaseHold(gesture); await open(); await write('新家庭的手动草稿'); await lateRecognition();
    await editableTranscript('新家庭的手动草稿'); assert.equal((await state()).generation, 'b'.repeat(43));
  });
  await check('A denied hold microphone leaves a reachable text composer and sends nothing', async () => {
    await holdFixture(); const gesture = await startHold();
    await page.evaluate(() => { __qaVoice.onerror({ error: 'not-allowed' }); __qaSavedVoice.end(); }); await releaseHold(gesture);
    assert.match(await page.$eval('#assistant-chat-status', node => node.textContent), /未获授权/);
    await lateRecognition(); await page.click('#assistant-chat-input'); await write('继续打字'); await editableTranscript('继续打字');
  });
  await check('Holding Space supports release-to-send without triggering a second click action', async () => {
    await holdFixture(); await page.focus(a('hold-voice')); await page.keyboard.down('Space');
    await page.waitForFunction(() => FamilyAssistantPanel.getState().listening);
    await hear([{ text: '键盘也能按住说话', final: true, confidence: 0.96 }]); await holdLongEnough(); await page.keyboard.up('Space');
    await endRecognition(); await page.waitForFunction(() => __qaRequests.some(call => call.url.endsWith('/turn'))); await ready();
    assert.deepEqual(await sentTexts(), ['键盘也能按住说话']); await draftUntouched();
  });
}
async function nativeReadiness() {
  const fresh = async (events = []) => {
    await holdFixture();
    await page.evaluate(events => {
      window.__qaVoiceStartEvents = events; window.__qaVoiceNow = 1000000; window.__qaBuzz = [];
      Date.now = () => __qaVoiceNow;
      Object.defineProperty(navigator, 'vibrate', { configurable: true, value: ms => { __qaBuzz.push(ms); return true; } });
    }, events);
  };
  const advance = ms => page.evaluate(ms => { __qaVoiceNow += ms; }, ms);
  const notify = (...events) => page.evaluate(events => {
    for (const name of events) if (typeof __qaSavedVoice[name] === 'function') __qaSavedVoice[name]();
  }, events);
  const feedback = () => page.evaluate(() => ({ listening: FamilyAssistantPanel.getState().listening,
    ready: document.querySelector('.assistant-recording').dataset.ready === 'true', buzz: __qaBuzz.slice() }));
  const preparing = { listening: false, ready: false, buzz: [] };
  const capturing = { listening: true, ready: true, buzz: [12] };

  await check('Native service start waits for audio capture; a 900ms startup and 100ms tail buzz once and stay editable', async () => {
    await fresh(['onstart']); const gesture = await startHold(true, false);
    assert.deepEqual(await feedback(), preparing);
    await advance(900); assert.deepEqual(await feedback(), preparing);
    assert.match(await page.$eval('.assistant-recording-text', node => node.textContent), /准备/);
    await notify('audioStart'); assert.deepEqual(await feedback(), capturing);
    await advance(50); await notify('start', 'audioStart'); assert.deepEqual(await feedback(), capturing);
    await advance(50); await releaseHold(gesture);
    await hear([{ text: '五分', final: true, confidence: 0.99 }]); await endRecognition();
    await editableTranscript('五分');
    assert.match(await page.$eval('#assistant-chat-status', node => node.textContent), /核对/);
    await notify('start', 'audioStart'); await lateRecognition(); await editableTranscript('五分');
    assert.deepEqual(await feedback(), { listening: false, ready: false, buzz: [12] });
  });
  await check('Releasing before native audio capture aborts and rejects late readiness and transcript callbacks', async () => {
    await fresh(['onstart']); const gesture = await startHold(true, false);
    await advance(900); await releaseHold(gesture);
    assert.deepEqual(await feedback(), preparing);
    assert.equal(await page.evaluate(() => __qaVoice.aborted), true);
    assert.equal(await page.$eval('.assistant-recording', node => node.hidden), true);
    assert.equal(await page.$eval('#assistant-chat-input', node => node.value), '');
    await write('我决定直接打字'); await notify('start', 'audioStart'); await lateRecognition();
    await editableTranscript('我决定直接打字'); assert.deepEqual(await feedback(), preparing);
  });
  await check('Tap dictation becomes ready on audio capture and late readiness cannot resume it after stop', async () => {
    await fresh(); await page.tap('#assistant-chat-input'); await write('原有文字'); await page.tap(a('voice')); await saveVoiceCallbacks();
    assert.deepEqual(await feedback(), preparing);
    await notify('start'); assert.deepEqual(await feedback(), preparing);
    await advance(900); await notify('audioStart');
    assert.deepEqual(await feedback(), { listening: true, ready: false, buzz: [] });
    await hear([{ text: '听写文字', final: true, confidence: 0.99 }]);
    assert.equal(await page.$eval('#assistant-chat-input', node => node.value), '原有文字\n听写文字');
    await page.tap(a('voice')); assert.equal(await page.evaluate(() => __qaVoice.stopped), true);
    await notify('start', 'audioStart'); assert.deepEqual(await feedback(), preparing);
    await endRecognition(); await write('我已核对并修改');
    await notify('start', 'audioStart'); await lateRecognition(); await editableTranscript('我已核对并修改');
    assert.deepEqual(await feedback(), preparing);
  });
  await check('Stopping tap dictation before audio capture prevents a late capture event from claiming readiness', async () => {
    await fresh(['onstart']); await page.tap('#assistant-chat-input'); await page.tap(a('voice')); await saveVoiceCallbacks();
    assert.deepEqual(await feedback(), preparing);
    await page.tap(a('voice')); assert.equal(await page.evaluate(() => __qaVoice.stopped), true);
    await notify('audioStart', 'start'); assert.deepEqual(await feedback(), preparing);
    await endRecognition(); await notify('audioStart', 'start'); await lateRecognition();
    assert.deepEqual(await feedback(), preparing); assert.deepEqual(await sentTexts(), []);
    assert.equal(await page.$eval('#assistant-chat-input', node => node.value), ''); await draftUntouched();
  });
  await check('Native audio capture before service start is usable and duplicate start events never buzz or send twice', async () => {
    await fresh(['onaudiostart']); const gesture = await startHold(true);
    assert.deepEqual(await feedback(), capturing);
    await advance(100); await notify('start', 'audioStart'); assert.deepEqual(await feedback(), capturing);
    await advance(500); await hear([{ text: '完整的语音', final: true, confidence: 0.99 }]);
    await releaseHold(gesture); await endRecognition(); await ready();
    await notify('start', 'audioStart'); await lateRecognition();
    assert.deepEqual(await sentTexts(), ['完整的语音']);
    assert.deepEqual(await feedback(), { listening: false, ready: false, buzz: [12] }); await draftUntouched();
  });
}
async function holdTouch() {
  for (const [width, height] of [[390, 844], [768, 1024], [844, 390]]) {
    await check(width + 'px real touch keeps the control stable while sliding to cancel and back', async () => {
      await holdFixture(width, height, true); const before = await geometry(); visibleComposer(before, false); composerAtBottom(before);
      const initialScroll = await page.evaluate(() => ({ body: scrollY, log: document.querySelector('#assistant-chat-log').scrollTop }));
      const gesture = await startHold(true); await hear([{ text: '触屏按住说话', final: true, confidence: 0.96 }]);
      const recording = await geometry(); withinGeometry(recording); visibleComposer(recording, false); composerAtBottom(recording);
      assert.deepEqual(recording.controls.map(control => control.rect), before.controls.map(control => control.rect), 'recording does not move the original touch target');
      await moveHold(gesture, gesture.x, gesture.y - 100);
      assert.equal(await page.$eval('.assistant-recording', node => node.dataset.cancel), 'true');
      await moveHold(gesture, gesture.x, gesture.y);
      assert.equal(await page.$eval('.assistant-recording', node => node.dataset.cancel), 'false');
      assert.deepEqual(await page.evaluate(() => ({ body: scrollY, log: document.querySelector('#assistant-chat-log').scrollTop })), initialScroll,
        'dragging the held control does not scroll the conversation');
      await holdLongEnough(); await releaseHold(gesture); await endRecognition();
      await page.waitForFunction(() => __qaRequests.some(call => call.url.endsWith('/turn'))); await ready();
      assert.deepEqual(await sentTexts(), ['触屏按住说话']); composerAtBottom(await geometry()); await draftUntouched();
      if (width === 390) await page.screenshot({ path: path.join(OUT, 'touch-sent-phone.png') });
    });
  }
  await check('Sliding right converts a reliable final to editable text without sending', async () => {
    await holdFixture(390, 844, true); const gesture = await startHold(true);
    await hear([{ text: '嘈杂环境先核对这句话', final: true, confidence: 0.96 }]);
    await moveHold(gesture, gesture.x + 100, gesture.y);
    assert.deepEqual(await page.$eval('.assistant-recording', node => ({ cancel: node.dataset.cancel, review: node.dataset.review })),
      { cancel: 'false', review: 'true' });
    await recordingSettled();
    await page.screenshot({ path: path.join(OUT, 'hold-review-phone.png') });
    await holdLongEnough(); await releaseHold(gesture); await endRecognition(); await editableTranscript('嘈杂环境先核对这句话');
    await lateRecognition(); await editableTranscript('嘈杂环境先核对这句话');
    await write('我核对并改好了这句话'); await page.click('#assistant-chat-send'); await ready();
    assert.deepEqual(await sentTexts(), ['我核对并改好了这句话']);
  });
  await check('Sliding back from convert-to-text restores release-to-send for the same utterance', async () => {
    await holdFixture(); const gesture = await startHold(true);
    await hear([{ text: '移回后按原方式发送', final: true, confidence: 0.96 }]);
    await moveHold(gesture, gesture.x + 100, gesture.y);
    assert.equal(await page.$eval('.assistant-recording', node => node.dataset.review), 'true');
    await moveHold(gesture, gesture.x, gesture.y);
    assert.deepEqual(await page.$eval('.assistant-recording', node => ({ cancel: node.dataset.cancel, review: node.dataset.review })),
      { cancel: 'false', review: 'false' });
    await holdLongEnough(); await releaseHold(gesture); await endRecognition();
    await page.waitForFunction(() => __qaRequests.some(call => call.url.endsWith('/turn'))); await ready();
    assert.deepEqual(await sentTexts(), ['移回后按原方式发送']);
  });
  await check('Sliding upward cancels even after entering convert-to-text', async () => {
    await holdFixture(); const gesture = await startHold(true);
    await hear([{ text: '这句话最终仍然要取消', final: true, confidence: 0.96 }]);
    await moveHold(gesture, gesture.x + 100, gesture.y);
    assert.equal(await page.$eval('.assistant-recording', node => node.dataset.review), 'true');
    await moveHold(gesture, gesture.x + 100, gesture.y - 100);
    assert.equal(await page.$eval('.assistant-recording', node => node.dataset.cancel), 'true');
    await holdLongEnough(); await releaseHold(gesture); await lateRecognition();
    assert.deepEqual(await sentTexts(), []); assert.equal(await page.$eval('#assistant-chat-input', node => node.value), '');
    await draftUntouched();
  });
  await check('The empty landscape hold control stays reachable in a compressed visible viewport', async () => {
    await holdFixture(844, 390, true);
    await page.evaluate(() => {
      Object.defineProperties(visualViewport, { height: { configurable: true, value: 120 }, offsetTop: { configurable: true, value: 30 } });
      visualViewport.dispatchEvent(new Event('resize'));
    });
    await settle(); const before = await geometry(); withinGeometry(before); visibleComposer(before, false); composerAtBottom(before);
    const gesture = await startHold(true); await hear([{ text: '压缩窗口仍能取消', final: true, confidence: 0.96 }]);
    const during = await geometry(); withinGeometry(during); visibleComposer(during, false); composerAtBottom(during);
    assert.deepEqual(during.controls.map(control => control.rect), before.controls.map(control => control.rect));
    const overlay = await page.$eval('.assistant-recording', node => node.getBoundingClientRect().toJSON());
    assert.ok(overlay.top >= during.panel.top && overlay.bottom <= during.panel.bottom && overlay.height > 0);
    await releaseHold(gesture, true); await lateRecognition(); assert.deepEqual(await sentTexts(), []); await draftUntouched();
  });
  await check('An OS touch cancellation discards recognition and ignores final callbacks', async () => {
    await holdFixture(); const gesture = await startHold(true);
    await hear([{ text: '系统打断这段录音', final: true, confidence: 0.96 }]); await releaseHold(gesture, true); await lateRecognition();
    assert.deepEqual(await sentTexts(), []); assert.equal(await page.$eval('#assistant-chat-input', node => node.value), '');
    assert.equal((await state()).listening, false); withinGeometry(await geometry()); await draftUntouched();
  });
  await check('A window interruption aborts the held recording without sending', async () => {
    await holdFixture(); const gesture = await startHold(true);
    await hear([{ text: '窗口离开后不应发送', final: true, confidence: 0.96 }]);
    await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await releaseHold(gesture); await lateRecognition();
    assert.deepEqual(await sentTexts(), []); assert.equal(await page.$eval('#assistant-chat-input', node => node.value), '');
    assert.equal((await state()).listening, false); await draftUntouched();
  });
  await check('Recording fades softly, shows distinct gesture colors and a speech-responsive wave, and respects accessible display preferences', async () => {
    report.recordingAppearance = {};
    await holdFixture(390, 844, true);
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }, { name: 'forced-colors', value: 'none' }]);
    const gesture = await startHold(true); await recordingSettled();
    const quiet = await recordingAppearance();
    await page.evaluate(() => __qaVoice.onspeechstart());
    await hear([{ text: '说话时波形更明显', final: true, confidence: 0.96 }]);
    const moving = await recordingFrames();
    report.recordingAppearance.normal = { quiet, moving }; save();
    assert.deepEqual(moving[0].media, { reduced: false, forcedColors: false });
    assert.ok(moving[0].wave.height > quiet.wave.height + 0.5, 'speech increases the effective waveform height');
    assert.ok(moving.slice(1).some(frame => JSON.stringify(frame.wave.bars) !== JSON.stringify(moving[0].wave.bars)),
      'the visible waveform advances between real-time frames');
    const paintMotion = frame => frame.layers.map(layer => ({ transform: layer.transform, position: layer.position, opacity: layer.opacity }));
    assert.ok(moving.slice(1).some(frame => JSON.stringify(paintMotion(frame)) !== JSON.stringify(paintMotion(moving[0]))),
      'the gradient moves after the entry animation has settled');
    assert.ok(moving[0].layers.some(layer => {
      if (layer.content === 'none' || layer.display === 'none' || layer.visibility !== 'visible' || Number(layer.opacity) === 0) return false;
      const gradient = layer.mask + ' ' + layer.image;
      const alphas = Array.from(gradient.matchAll(/rgba?\(([^)]+)\)/g), match => {
        const channels = match[1].split(/[,\s/]+/).filter(Boolean); return channels.length === 4 ? Number(channels[3]) : 1;
      });
      return gradient.includes('gradient(') && alphas.length > 1 && Math.min(...alphas) < Math.max(...alphas);
    }), 'a painted gradient fades between different alpha levels');
    await page.screenshot({ path: path.join(OUT, 'hold-motion-speaking-phone.png') });
    await page.evaluate(() => __qaVoice.onspeechend()); await recordingSettled();
    const speechEnded = await recordingAppearance();
    assert.ok(Math.abs(speechEnded.wave.height - quiet.wave.height) < 0.1, 'speech end restores the quieter waveform height');
    await moveHold(gesture, gesture.x + 100, gesture.y); await recordingSettled();
    const review = await recordingAppearance();
    await page.screenshot({ path: path.join(OUT, 'hold-motion-review-phone.png') });
    await moveHold(gesture, gesture.x + 100, gesture.y - 100); await recordingSettled();
    const cancel = await recordingAppearance();
    await page.screenshot({ path: path.join(OUT, 'hold-motion-cancel-phone.png') });
    const colors = frame => JSON.stringify(frame.layers.map(layer => [layer.background, layer.image]));
    assert.equal(new Set([colors(moving[0]), colors(review), colors(cancel)]).size, 3,
      'recording, review and cancel paint visibly different colors');
    assert.match(review.hint, /转成文字/); assert.match(cancel.hint, /取消/);
    await moveHold(gesture, gesture.x, gesture.y);
    await page.evaluate(() => __qaVoice.onspeechstart()); await recordingSettled(); await endRecognition(); await recordingSettled();
    const recognitionEnded = await recordingAppearance();
    assert.ok(Math.abs(recognitionEnded.wave.height - quiet.wave.height) < 0.1, 'recognition completion resets the waveform even during speech');
    report.recordingAppearance.normal = { quiet, moving, speechEnded, review, cancel, recognitionEnded }; save();
    await releaseHold(gesture); await editableTranscript('说话时波形更明显');

    await holdFixture();
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }, { name: 'forced-colors', value: 'none' }]);
    const fallbackGesture = await startHold(true); await recordingSettled();
    const fallbackQuiet = await recordingAppearance();
    await hear([{ text: '没有语音边界事件也能响应', final: false }]); await recordingSettled();
    const interim = await recordingAppearance();
    report.recordingAppearance.fallback = { quiet: fallbackQuiet, interim }; save();
    assert.deepEqual(interim.media, { reduced: false, forcedColors: false });
    assert.ok(interim.wave.height > fallbackQuiet.wave.height + 0.5, 'interim transcription makes the wave responsive without speech boundary events');
    await hear([{ text: '没有语音边界事件也能响应', final: true, confidence: 0.96 }]); await recordingSettled();
    const final = await recordingAppearance();
    assert.ok(Math.abs(final.wave.height - fallbackQuiet.wave.height) < 0.1, 'a final transcript resets the fallback speech response');
    report.recordingAppearance.fallback = { quiet: fallbackQuiet, interim, final }; save();
    await releaseHold(fallbackGesture, true); await lateRecognition(); assert.deepEqual(await sentTexts(), []);

    for (const mode of ['reduced', 'forced-colors']) {
      await holdFixture();
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: mode === 'reduced' ? 'reduce' : 'no-preference' },
        { name: 'forced-colors', value: mode === 'forced-colors' ? 'active' : 'none' }]);
      const stillGesture = await startHold(true); await recordingSettled();
      const beforeSpeech = await recordingAppearance(); await page.evaluate(() => __qaVoice.onspeechstart());
      const still = await recordingFrames();
      report.recordingAppearance[mode] = { beforeSpeech, frames: still }; save();
      assert.deepEqual(still[0].media, { reduced: mode === 'reduced', forcedColors: mode === 'forced-colors' });
      still.forEach(frame => {
        assert.deepEqual(frame.layers, beforeSpeech.layers, mode + ': the painted surface stays still');
        assert.deepEqual(frame.wave, beforeSpeech.wave, mode + ': the waveform stays still, including during speech');
        assert.ok(frame.hintRect.width > 0 && frame.hintRect.height > 0, mode + ': the recording instruction remains visible');
      });
      if (mode === 'forced-colors') {
        const visibleLayers = still[0].layers.filter(layer => !layer.pseudo || layer.content !== 'none' && layer.display !== 'none');
        assert.ok(visibleLayers.every(layer => !/gradient\(/.test(layer.mask + ' ' + layer.image)), 'forced colors remove decorative gradients');
        assert.notEqual(still[0].ink, still[0].layers[0].background, 'forced colors keep the instruction distinct from its background');
      }
      await page.screenshot({ path: path.join(OUT, 'hold-motion-' + mode + '-phone.png') });
      await releaseHold(stillGesture, true); await lateRecognition(); assert.deepEqual(await sentTexts(), []); await draftUntouched();
    }
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

async function receiptCards() {
  return page.$$eval('.assistant-message:not(.assistant-message-current)', messages => {
    const message = messages.find(node => node.querySelector('h3')?.textContent === '已记录：家长实际加分');
    return message ? Array.from(message.querySelectorAll('.assistant-draft-card')).map(card => ({
      index:Number(card.dataset.assistantDraftIndex),status:card.querySelector('.assistant-draft-heading span')?.textContent,
      applies:card.querySelectorAll('[data-assistant-action="apply"]').length
    })) : null;
  });
}
async function receipts() {
  await fixture();
  await page.evaluate(() => {
    const result = {kind:'steps',steps:[
      {...__qaAction,title:'已记录：家长实际加分',summary:'家长改为 7 分 · 实际记录已保存',receipt:{actionId:'saved-action',revision:4}},
      {kind:'route',route:'points',title:'积分记录'},
      {...__qaAction,title:'尚未提交的第二项',receipt:{actionId:'untrusted-model-receipt',revision:999,status:'committed'}},
      {kind:'answer',title:'积分快照',answer:'保存这一步时可兑换 7 分。',after:[0],deferred:false}
    ]};
    __qaInstallDraft(__qaSnapshot, '00000000-0000-4000-8000-000000000080', result);
    __qaSnapshot.draft.actions.find(action => action.index === 0).status = 'committed';
    __qaSnapshot.messages.at(-1).committedIndexes = [0];
  });
  await open();
  await check('A partial current plan shows the saved step and keeps only its pending step actionable', async () => {
    assert.equal(await page.$eval('.assistant-current-draft [data-assistant-draft-index="0"] .assistant-draft-heading span', node => node.textContent), '已办理');
    assert.deepEqual(await page.$$eval(a('apply'), nodes => nodes.map(node => Number(node.dataset.stepIndex))), [2]);
    assert.equal(await page.$eval('.assistant-current-draft .assistant-step-note', node => node.textContent), '保存这一步时可兑换 7 分。');
    await draftUntouched();
  });
  await check('Replacing a partial plan keeps its persisted committed index and ignores a model receipt on the other card', async () => {
    await page.evaluate(() => { __qaInstallDraft(__qaSnapshot, '00000000-0000-4000-8000-000000000081', __qaAction); FamilyAssistantPanel.refresh(); }); await ready();
    assert.deepEqual(await receiptCards(), [{index:0,status:'已办理',applies:0},{index:2,status:'历史草稿',applies:0}]);
    await page.screenshot({path:path.join(OUT,'partial-history.png')}); await draftUntouched();
  });
  await check('A fresh panel read preserves per-step historical statuses without creating a handoff', async () => {
    await page.evaluate(() => FamilyAssistantPanel.reset()); await open();
    assert.deepEqual(await receiptCards(), [{index:0,status:'已办理',applies:0},{index:2,status:'历史草稿',applies:0}]);
    assert.deepEqual(await page.evaluate(() => __qaApplies), []);
    assert.equal(await page.evaluate(() => __qaRequests.some(call => /\/action|\/parent\//.test(call.url))), false);
  });
  await check('The existing all-committed message flag still marks every historical card completed', async () => {
    await page.evaluate(() => {
      const message = __qaSnapshot.messages.find(message => message.turnId.endsWith('000000000080') && message.role === 'assistant');
      message.committed = true; delete message.committedIndexes; FamilyAssistantPanel.refresh();
    }); await ready();
    assert.deepEqual(await receiptCards(), [{index:0,status:'已办理',applies:0},{index:2,status:'已办理',applies:0}]);
  });
}
async function mixedNotes() {
  await fixture();
  await page.evaluate(() => {
    const result = {kind:'steps',steps:[
      {...__qaAction,title:'已加分',summary:'自主阅读 · +7 分'},
      {kind:'route',route:'points',title:'积分记录'},
      {kind:'answer',title:'积分快照',answer:'当时可兑换 7 分，累计 7 分。',after:[0],deferred:false},
      {kind:'clarify',title:'下一项',question:'下一次要选择哪条提醒？'}
    ]};
    __qaInstallDraft(__qaSnapshot, '00000000-0000-4000-8000-000000000090', result);
    const message = __qaSnapshot.messages.at(-1);
    message.text = '已加分：自主阅读 · +7 分\n积分记录\n积分快照：当时可兑换 7 分，累计 7 分。\n下一项：下一次要选择哪条提醒？';
    message.committed = true; __qaSnapshot.draft = null;
  }); await open();
  await check('A historical mixed plan displays its balance snapshot and clarification once beside its cards', async () => {
    const notes = await page.$$eval('.assistant-message .assistant-message-text', nodes => nodes.map(node => node.textContent));
    assert.equal(notes.filter(text => text === '当时可兑换 7 分，累计 7 分。').length, 1);
    assert.equal(notes.filter(text => text === '下一次要选择哪条提醒？').length, 1);
    assert.equal(await page.$$eval('.assistant-draft-card', nodes => nodes.length), 1);
    assert.equal(await page.$$eval(a('route'), nodes => nodes.length), 1);
    assert.equal(await page.$$eval(a('apply'), nodes => nodes.length), 0);
    await page.screenshot({path:path.join(OUT,'historical-query.png')});
  });
  await check('Reopening the panel keeps its historical query text visible and read-only', async () => {
    await page.click(a('close')); await open();
    const text = await page.$eval('#assistant-chat-log', node => node.textContent);
    assert.equal(text.split('当时可兑换 7 分，累计 7 分。').length - 1, 1);
    assert.equal(text.split('下一次要选择哪条提醒？').length - 1, 1);
    assert.equal(await page.$$eval(a('apply'), nodes => nodes.length), 0); await draftUntouched();
  });
  await check('Untitled answers and clarification in a mixed plan do not repeat in its generated prose', async () => {
    await page.evaluate(() => {
      __qaInstallDraft(__qaSnapshot, '00000000-0000-4000-8000-000000000091', {kind:'steps',steps:[__qaAction,
        {kind:'answer',answer:'另一份快照可兑换 9 分。'},{kind:'clarify',question:'下一项提醒希望几点？'}]});
      __qaSnapshot.messages.at(-1).text = '加分草稿：自主阅读 · 5 分\n另一份快照可兑换 9 分。\n下一项提醒希望几点？';
      __qaSnapshot.draft = null; FamilyAssistantPanel.refresh();
    }); await ready();
    const text = await page.$eval('#assistant-chat-log', node => node.textContent);
    assert.equal(text.split('另一份快照可兑换 9 分。').length - 1, 1);
    assert.equal(text.split('下一项提醒希望几点？').length - 1, 1);
  });
  await check('Additional historical prose remains visible alongside mixed plan notes', async () => {
    await page.evaluate(() => { __qaSnapshot.messages.at(-1).text = '这份结果来自本次核对，请先看当时快照。'; FamilyAssistantPanel.refresh(); }); await ready();
    const text = await page.$eval('#assistant-chat-log', node => node.textContent);
    assert.equal(text.split('这份结果来自本次核对，请先看当时快照。').length - 1, 1);
    assert.equal(text.split('另一份快照可兑换 9 分。').length - 1, 1);
  });
  await check('Plain answers, ordinary conversation and standalone clarification render once', async () => {
    await page.evaluate(() => {
      __qaSnapshot.messages = [
        {role:'assistant',turnId:'plain-answer',text:'现在可兑换 11 分。',result:{kind:'answer',answer:'现在可兑换 11 分。'}},
        {role:'assistant',turnId:'conversation-answer',text:'你好，需要帮什么？',result:{kind:'answer',scope:'conversation',answer:'你好，需要帮什么？'}},
        {role:'assistant',turnId:'plain-clarify',text:'希望提醒在几点？',result:{kind:'clarify',question:'希望提醒在几点？'}}
      ]; FamilyAssistantPanel.reset();
    }); await open();
    assert.deepEqual(await page.$$eval('.assistant-message .assistant-message-text', nodes => nodes.map(node => node.textContent)),
      ['现在可兑换 11 分。','你好，需要帮什么？','希望提醒在几点？']);
    assert.equal(await page.$$eval(a('apply'), nodes => nodes.length), 0); await draftUntouched();
  });
}

(async () => {
  save(); browser = await B.launch();
  try {
    await ({ layout, lifecycle, drafts, voice, hold, 'hold-touch': holdTouch, 'native-readiness': nativeReadiness, history, receipts, 'mixed-notes':mixedNotes })[CASE]();
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(OUT, 'panel.png') });
    assert.deepEqual(report.errors, []); report.passed = true;
  } catch (error) { report.passed = false; report.failure = { message: error.message, stack: error.stack }; if (page && !page.isClosed()) await page.screenshot({ path: path.join(OUT, 'failure.png') }); throw error; }
  finally { report.finishedAt = new Date().toISOString(); save(); await browser.close(); }
  console.log(CASE + ': ' + report.checks.length + ' checks passed. Evidence: ' + OUT);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
