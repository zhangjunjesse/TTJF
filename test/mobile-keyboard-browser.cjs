'use strict';

// One short, isolated SaaS run per case. The layout viewport stays at iPhone
// size; only visualViewport changes, as it does with Safari's software keyboard.
// MOBILE_KEYBOARD_CASE=award|template|reminder|pin|pin-landscape (default: award).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Q = require('./saas-browser.cjs');
const { B, action: a, click } = Q;
const CASE = process.env.MOBILE_KEYBOARD_CASE || 'award';
assert.ok(['award', 'template', 'reminder', 'pin', 'pin-landscape'].includes(CASE), 'Unknown MOBILE_KEYBOARD_CASE');
const LANDSCAPE_PIN = CASE === 'pin-landscape';
const WIDTH = Number(process.env.MOBILE_KEYBOARD_WIDTH || (LANDSCAPE_PIN ? 844 : 390));
const HEIGHT = Number(process.env.MOBILE_KEYBOARD_HEIGHT || (LANDSCAPE_PIN ? 390 : 844));
const field = name => '#editor-form [name="' + name + '"]';
let env, page, originalLayout, familyId;
Q.report.command = 'MOBILE_KEYBOARD_CASE=' + CASE + ' node test/mobile-keyboard-browser.cjs';
Q.report.nodeCommand = 'node test/mobile-keyboard-browser.cjs';
Q.report.keyboard = { case: CASE, viewport: { width: WIDTH, height: HEIGHT }, measurements: [],
  boundary: 'Chromium DOM and real pointer/text input with mocked visualViewport geometry; no native iPhone, Safari, OS keyboard or Chinese IME validation.' };

function progress(message, measurement) {
  if (measurement) Q.report.keyboard.measurements.push({ message, ...measurement });
  fs.mkdirSync(Q.OUT, { recursive: true });
  fs.writeFileSync(path.join(Q.OUT, 'keyboard-progress.json'), JSON.stringify({
    case: CASE, message, at: new Date().toISOString(), checks: Q.report.checks, keyboard: Q.report.keyboard
  }, null, 2) + '\n');
}

async function installViewport() {
  await page.evaluateOnNewDocument(() => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error('The keyboard regression needs visualViewport');
    const nativeHeight = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(viewport), 'height').get.bind(viewport);
    const nativeWidth = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(viewport), 'width').get.bind(viewport);
    const current = { height: null, offsetTop: 0, scale: 1 };
    const events = []; let windowResizes = 0;
    Object.defineProperties(viewport, {
      height: { configurable: true, get: () => current.height === null ? nativeHeight() : current.height },
      width: { configurable: true, get: () => nativeWidth() / current.scale },
      scale: { configurable: true, get: () => current.scale },
      offsetTop: { configurable: true, get: () => current.offsetTop },
      pageTop: { configurable: true, get: () => scrollY + current.offsetTop }
    });
    window.addEventListener('resize', () => { windowResizes++; });
    window.__qaKeyboardViewport = {
      get windowResizes() { return windowResizes; }, events,
      apply(next, event) {
        Object.assign(current, next);
        // These masks make real mouse hit tests fail outside the visible area.
        // They never resize the document or cover any part of the tested area.
        for (const position of ['top', 'bottom']) {
          let mask = document.querySelector('[data-qa-keyboard-mask="' + position + '"]');
          if (!mask) {
            mask = document.createElement('div'); mask.dataset.qaKeyboardMask = position;
            mask.setAttribute('aria-hidden', 'true'); document.body.appendChild(mask);
          }
          const top = position === 'top' ? 0 : viewport.offsetTop + viewport.height;
          const height = position === 'top' ? viewport.offsetTop : Math.max(0, innerHeight - top);
          mask.style.cssText = 'position:fixed;left:0;right:0;z-index:2147483647;background:#252830;top:' + top + 'px;height:' + height + 'px;';
        }
        events.push({ type: event, height: viewport.height, offsetTop: viewport.offsetTop, scale: viewport.scale });
        viewport.dispatchEvent(new Event(event));
      }
    };
  });
}

async function measure(selector) {
  return page.$eval(selector, node => {
    const viewport = visualViewport, sheet = node.closest('.sheet'), body = node.closest('.sheet-body');
    const rect = element => element && element.getBoundingClientRect().toJSON();
    const r = node.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { selector: node.name || node.getAttribute('aria-label') || node.type, rect: rect(node), panel: rect(sheet), body: rect(body),
      scrollTop: body && body.scrollTop, scrollHeight: body && body.scrollHeight,
      focused: node === document.activeElement, hit: !!hit && (hit === node || node.contains(hit)),
      viewport: { top: viewport.offsetTop, bottom: viewport.offsetTop + viewport.height, height: viewport.height, width: viewport.width, scale: viewport.scale },
      layout: { width: innerWidth, height: innerHeight, clientHeight: document.documentElement.clientHeight, scrollY,
        windowResizes: window.__qaKeyboardViewport.windowResizes } };
  });
}

function within(rect, top, bottom, label) {
  assert.ok(rect.width > 0 && rect.height > 0 && rect.left >= -1 && rect.right <= WIDTH + 1 &&
    rect.top >= top - 1 && rect.bottom <= bottom + 1, label + ': ' + JSON.stringify(rect) + ' visible=' + top + '..' + bottom);
}
async function visible(selector, label, focused = false) {
  const result = await measure(selector); progress(label, result);
  assert.deepEqual(result.layout, originalLayout, label + ': keyboard must not change the layout viewport or dispatch window.resize');
  within(result.panel, result.viewport.top, result.viewport.bottom, label + ': complete dialog');
  within(result.rect, Math.max(result.viewport.top, result.body ? result.body.top : result.panel.top),
    Math.min(result.viewport.bottom, result.body ? result.body.bottom : result.panel.bottom), label + ': control');
  assert.equal(result.hit, true, label + ': control is hit-testable');
  if (focused) assert.equal(result.focused, true, label + ': keyboard focus survives');
  return result;
}
async function keyboard(next, event, name) {
  await page.evaluate(({ next, event }) => window.__qaKeyboardViewport.apply(next, event), { next, event });
  await settleViewport();
  await Q.shot(page, name);
}
async function settleViewport() {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await B.delay(100);
}
async function focusWithoutScroll(selector) {
  await page.$eval(selector, node => node.focus({ preventScroll: true }));
  await settleViewport();
}
async function typeVisible(selector, value) {
  await visible(selector, 'Before text input: ' + selector);
  await click(page, selector, { scroll: false });
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.keyboard.press('Backspace'); await page.keyboard.type(value);
  assert.equal(await page.$eval(selector, node => node.value), value, 'Real keyboard text reaches the focused field');
  await visible(selector, 'After text input: ' + selector, true);
}
async function rememberedFocus(selector) {
  await page.$eval(selector, node => { window.__qaFocusedKeyboardField = { node, start: node.selectionStart, end: node.selectionEnd }; });
}
async function preservedFocus(selector) {
  assert.equal(await page.$eval(selector, node => {
    const previous = window.__qaFocusedKeyboardField;
    return previous.node === node && document.activeElement === node && previous.start === node.selectionStart && previous.end === node.selectionEnd;
  }), true, 'Viewport events preserve the input node, focus and caret');
}

async function pinchWhileEditing(selector) {
  const before = await measure(selector);
  await keyboard({ height: before.viewport.height / 1.2, scale: 1.2 }, 'resize', 'editor-keyboard-pinch-zoom');
  const zoomed = await measure(selector); progress('Pinch zoom keeps a usable editor instead of shrinking it again', zoomed);
  assert.deepEqual(zoomed.layout, originalLayout, 'Pinch zoom changes only visualViewport');
  assert.ok(zoomed.panel.height >= before.panel.height - 1, 'Pinch zoom must not collapse the keyboard-sized editor');
  assert.ok(zoomed.body.height >= zoomed.rect.height, 'The zoomed editor retains room for the focused control');
  within(zoomed.rect, zoomed.body.top, zoomed.body.bottom, 'The focused field is not clipped by its own scroll container');
  await preservedFocus(selector);
  // Native pinch panning may put controls outside the visual area. Hit testing
  // while zoomed is deliberately left to physical Safari/device validation.
  await keyboard({ height: before.viewport.height, scale: 1 }, 'resize', 'editor-keyboard-unzoomed');
  await visible(selector, 'Field is visible again after undoing pinch zoom', true);
}

async function setup() {
  Q.phase('mobile-keyboard-' + CASE); progress('Creating isolated SaaS fixture');
  env = await Q.initialize();
  page = await env.newPage({ width: WIDTH, height: HEIGHT }); Q.active(page);
  page.setDefaultTimeout(6000);
  await installViewport();
  await Q.registerAndVerify(page, 'keyboard-' + CASE + '-' + Q.RUN + '@example.test');
  familyId = await Q.createFamily(page, '合成键盘测试', '合成键盘宝');
  const before = (await env.api(page, '/api/state')).body;
  const configured = await env.api(page, '/api/action', 'POST', { revision: before.revision,
    action: { type: 'parent.setup', id: 'keyboard-fixture-' + Q.RUN, method: 'pin', pin: Q.PIN, confirmPin: Q.PIN } });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  await page.reload({ waitUntil: 'load' }); await Q.ready(page, familyId); await Q.home(page);
  originalLayout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
    clientHeight: document.documentElement.clientHeight, scrollY, windowResizes: window.__qaKeyboardViewport.windowResizes }));
  assert.equal(originalLayout.height, HEIGHT); progress('Fixture ready');
}
async function openAward() {
  await click(page, a('add-points')); await click(page, a('points-new'));
  await page.waitForSelector('.sheet[data-form-kind="points"] #editor-form');
}
async function openEditor() {
  if (CASE === 'award') { await openAward(); return { target: 'reason', other: 'name', initial: '今天主动整理书包', otherValue: '合成键盘行为' }; }
  if (CASE === 'template') {
    await click(page, a('add-points')); await click(page, a('point-list')); await click(page, a('point-item-new'));
    return { target: 'reason', other: 'name', initial: '每天自己完成阅读', otherValue: '合成常用行为' };
  }
  await B.navigate(page, 'reminders'); await click(page, a('task-new'));
  return { target: 'note', other: 'title', initial: '记得带好水杯和雨伞', otherValue: '合成出门提醒' };
}

async function editor() {
  const before = await Q.snapshot(page), marker = env.calls.length, scenario = await openEditor();
  const target = field(scenario.target), other = field(scenario.other);
  const initial = await visible(other, 'Original editor layout'); await Q.shot(page, 'editor-original');
  await click(page, target); await page.keyboard.type(scenario.initial); await rememberedFocus(target);
  await keyboard({ height: 360, offsetTop: 84 }, 'resize', 'editor-keyboard-resize');
  await visible(target, 'Focused lower field after visualViewport resize', true); await preservedFocus(target);
  await visible(Q.save, 'Save action above the keyboard');
  await typeVisible(target, scenario.initial + '，中文输入仍然可见'); await rememberedFocus(target);
  await keyboard({ offsetTop: 132 }, 'scroll', 'editor-keyboard-scroll');
  await visible(target, 'Focused lower field after visualViewport scroll', true); await preservedFocus(target);
  await keyboard({ height: 320, offsetTop: 108 }, 'resize', 'editor-keyboard-candidates');
  await visible(target, 'Candidate-bar height change keeps lower field visible', true); await preservedFocus(target);
  if (CASE === 'award') await pinchWhileEditing(target);
  await focusWithoutScroll(other);
  await typeVisible(other, scenario.otherValue);
  await page.evaluate(() => document.activeElement.blur());
  await keyboard({ height: HEIGHT, offsetTop: 0 }, 'resize', 'editor-keyboard-dismissed');
  const restored = await visible(other, 'Editor after keyboard dismissal');
  for (const property of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(restored.panel[property] - initial.panel[property]) < 1,
    'Original editor geometry is restored: ' + property);
  assert.equal(await page.$eval(target, node => node.value), scenario.initial + '，中文输入仍然可见');
  assert.equal(await page.$eval(other, node => node.value), scenario.otherValue);
  await Q.home(page);
  assert.deepEqual(await Q.snapshot(page), before, 'Editing and dismissing the keyboard never writes family data');
  assert.deepEqual(env.calls.slice(marker).filter(call => call.path === '/api/action'), []);
}

async function wrongPinRetry(before, marker) {
  await keyboard({ height: 180, offsetTop: 90 }, 'resize', 'pin-retry-keyboard');
  await typeVisible(B.SELECTORS.answer, '000000');
  await click(page, Q.parentSubmit, { scroll: false });
  await page.waitForFunction(() => { const error = document.querySelector('#parent-error'); return error && !error.hidden && error.textContent; });
  await settleViewport();
  assert.deepEqual(await Q.snapshot(page), before, 'A rejected PIN never changes the displayed family data');
  const rejected = await env.api(page, '/api/state');
  assert.equal(rejected.status, 200); assert.deepEqual(rejected.body.state, before, 'A rejected PIN never changes the persisted family data');
  assert.deepEqual(env.calls.slice(marker).filter(call => call.path === '/api/action'), [], 'A rejected PIN never submits the points action');
  const text = await page.$eval('#parent-error', node => {
    const range = document.createRange(); range.selectNodeContents(node);
    return { value: node.textContent.trim(), rect: range.getBoundingClientRect().toJSON() };
  });
  progress('Wrong PIN is rejected without writing family data', {
    input: await measure(B.SELECTORS.answer), error: await measure('#parent-error'), text
  });
  await Q.shot(page, 'pin-wrong-answer');
  await visible(B.SELECTORS.answer, 'Wrong PIN can be corrected with the keyboard open', true);
  const error = await visible('#parent-error', 'PIN error and input are visible together');
  assert.equal(text.value, '验证未通过', 'The real PIN rejection is displayed');
  within(text.rect, error.rect.top, error.rect.bottom, 'The complete PIN error text is not clipped');
  assert.ok(text.rect.left >= error.rect.left - 1 && text.rect.right <= error.rect.right + 1, 'The PIN error text fits its container');
  await visible('.sheet-footer ' + a('parent-cancel'), 'Return action remains reachable after a wrong PIN');
  await visible(Q.parentSubmit, 'Verify action remains reachable after a wrong PIN');
  await typeVisible(B.SELECTORS.answer, Q.PIN);
}

async function pin() {
  const before = await Q.snapshot(page), marker = env.calls.length;
  const keyboardHeight = LANDSCAPE_PIN ? 195 : 360, reopenedHeight = LANDSCAPE_PIN ? 195 : 320;
  const keyboardOffset = LANDSCAPE_PIN ? 90 : 84;
  await openAward(); await B.fillForm(page, { name: '合成键盘确认', points: 5, reason: '家长仍可完成确认' });
  await click(page, Q.save); await click(page, a('points-confirm')); await page.waitForSelector(B.SELECTORS.answer);
  assert.ok(await page.$('.global-dialog-overlay .parent-dialog[role="dialog"][aria-modal="true"]'));
  const initial = await visible(B.SELECTORS.answer, 'Original global PIN dialog', true); await Q.shot(page, 'pin-original');
  await rememberedFocus(B.SELECTORS.answer);
  await keyboard({ height: keyboardHeight, offsetTop: keyboardOffset }, 'resize', 'pin-keyboard-resize');
  await visible(B.SELECTORS.answer, 'PIN after visualViewport resize', true); await preservedFocus(B.SELECTORS.answer);
  await typeVisible(B.SELECTORS.answer, Q.PIN); await rememberedFocus(B.SELECTORS.answer);
  await keyboard({ offsetTop: 132 }, 'scroll', 'pin-keyboard-scroll');
  await visible(B.SELECTORS.answer, 'PIN after visualViewport scroll', true); await preservedFocus(B.SELECTORS.answer);
  await visible(Q.parentSubmit, 'Global verify action above keyboard');
  assert.deepEqual(await Q.snapshot(page), before, 'An entered PIN does not commit until the verify action');
  await page.evaluate(() => document.activeElement.blur());
  await keyboard({ height: HEIGHT, offsetTop: 0 }, 'resize', 'pin-keyboard-dismissed');
  const restored = await visible(B.SELECTORS.answer, 'Global PIN dialog after keyboard dismissal');
  for (const property of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(restored.panel[property] - initial.panel[property]) < 1,
    'Original global PIN geometry is restored: ' + property);
  await focusWithoutScroll(B.SELECTORS.answer);
  await keyboard({ height: reopenedHeight, offsetTop: LANDSCAPE_PIN ? 90 : 108 }, 'resize', 'pin-keyboard-reopened');
  await visible(B.SELECTORS.answer, 'PIN remains editable', true);
  await visible(Q.parentSubmit, 'Global verify action with the reopened keyboard');
  if (LANDSCAPE_PIN) await wrongPinRetry(before, marker);
  await click(page, Q.parentSubmit, { scroll: false }); await Q.settled(page); await B.noSheet(page);
  const after = await Q.snapshot(page);
  assert.equal(Q.M.totals(after).earned, Q.M.totals(before).earned + 5);
  assert.equal(after.points.filter(row => row.name === '合成键盘确认').length, 1);
  assert.equal(env.calls.slice(marker).filter(call => call.path === '/api/action' && call.action && call.action.type === 'points.add').length, 1);
  await keyboard({ height: HEIGHT, offsetTop: 0 }, 'resize', 'pin-confirmed-home');
}

Q.execute(async () => {
  await setup();
  await Q.check(CASE + ': visualViewport-only keyboard preserves visible, editable controls and restores the original dialog', CASE.startsWith('pin') ? pin : editor);
  await Q.check('Keyboard simulation has no uncaught browser errors', async () => {
    assert.deepEqual(Q.report.pageErrors, []);
    Q.report.keyboard.events = await page.evaluate(() => window.__qaKeyboardViewport.events);
  });
  progress('All selected keyboard checks passed');
});
