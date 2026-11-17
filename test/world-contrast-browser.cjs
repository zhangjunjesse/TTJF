'use strict';

// Run with: node test/world-contrast-browser.cjs
// Uses actual product controls and loaded CSS in the isolated legacy HTTP fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const B = require('./browser.cjs');
const { ROOT, Model: M, action: a } = B;
const run = new Date().toISOString().replace(/[^0-9]/g, '') + '-' + process.pid;
const OUT = path.join(process.env.TEST_ARTIFACT_DIR ? path.resolve(process.env.TEST_ARTIFACT_DIR) :
  path.join(ROOT, 'data', 'pr3-review-fixes'), 'world-contrast-' + run);
const hashCSS = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'farm-world.css'))).digest('hex');
fs.mkdirSync(OUT, { recursive: true });
const report = { status: 'running', startedAt: new Date().toISOString(), cssHash: hashCSS(), controls: [],
  method: 'Real computed styles; opaque two-stop RGB gradients bounded by their lightest channels, including CSS brightness on text and background. No backgroundColor substitution for gradients.',
  boundaries: ['Synthetic legacy HTTP family; no production family or SaaS/SQLite persistence is exercised.',
    'Desktop Edge at 390x844; native iPad/Safari and OS keyboard are unverified.',
    'Only solid fills and the current two-stop RGB gradients/brightness filters are supported; other rendering fails explicitly.'] };
const persist = () => fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(report, null, 2));
persist();
let browser, env, page;

function rgba(value) {
  assert.match(value, /^rgba?\([\d.,\s]+\)$/, 'unsupported computed color: ' + value);
  const channels = value.match(/[\d.]+/g).map(Number);
  assert.ok(channels.length === 3 || channels.length === 4, 'invalid RGB color: ' + value);
  if (channels.length === 3) channels.push(1);
  return channels;
}
function rgb(value) {
  const channels = rgba(value);
  assert.equal(channels[3], 1, 'color must be opaque: ' + value);
  return channels.slice(0, 3);
}
function luminance(channels) {
  const linear = channels.map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; });
  return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
}
function contrast(style) {
  assert.equal(style.opacity, '1', 'button opacity must be included in the contrast model');
  assert.deepEqual(style.ancestorEffects, [], 'ancestor compositing requires a rendered-pixel audit');
  assert.deepEqual(style.overlays, [], 'painted pseudo-element overlays require a rendered-pixel audit');
  let stops;
  if (style.backgroundImage === 'none') stops = [rgb(style.backgroundColor)];
  else {
    assert.match(style.backgroundImage, /^linear-gradient\(rgba?\([\d.,\s]+\), rgba?\([\d.,\s]+\)\)$/, 'unsupported gradient: ' + style.backgroundImage);
    stops = style.backgroundImage.match(/rgba?\([^)]+\)/g).map(rgb);
  }
  assert.ok(style.filter === 'none' || /^brightness\([\d.]+\)$/.test(style.filter), 'unsupported filter: ' + style.filter);
  const brightness = style.filter === 'none' ? 1 : Number(style.filter.match(/[\d.]+/)[0]);
  // RGB interpolation stays within the per-channel envelope. A lighter opaque
  // label has its lowest contrast at this conservative brightest background.
  // Round the label down and background up to cover 8-bit raster quantization.
  function bound(color, backgrounds) {
    const foreground = rgb(color).map(value => Math.floor(Math.min(255, value * brightness)));
    const brightest = [0, 1, 2].map(channel => Math.ceil(Math.min(255, Math.max(...backgrounds.map(stop => stop[channel])) * brightness)));
    assert.ok(foreground.every((value, channel) => value >= brightest[channel]), 'expected a light label on a darker fill');
    return { foreground, brightest, minimumRatio: (luminance(foreground) + .05) / (luminance(brightest) + .05) };
  }
  const textRuns = style.textRuns.map(text => {
    let backgrounds = stops;
    for (const layer of text.layers) {
      assert.equal(layer.backgroundImage, 'none', 'nested gradient requires a rendered-pixel audit');
      assert.equal(layer.opacity, '1'); assert.equal(layer.filter, 'none'); assert.equal(layer.mixBlendMode, 'normal');
      const color = rgba(layer.backgroundColor), alpha = color[3];
      backgrounds = backgrounds.map(stop => stop.map((value, channel) => color[channel] * alpha + value * (1 - alpha)));
    }
    return { label: text.label, ...bound(text.color, backgrounds) };
  });
  const base = bound(style.color, stops);
  return { stops, brightness, ...base, textRuns, minimumRatio: Math.min(base.minimumRatio, ...textRuns.map(text => text.minimumRatio)) };
}
async function styleOf(selector) {
  return page.$eval(selector, element => {
    const s = getComputedStyle(element), box = element.getBoundingClientRect();
    const rect = value => ({ x: value.x, y: value.y, width: value.width, height: value.height });
    const text = document.createRange(); text.selectNodeContents(element);
    const ancestorEffects = [];
    for (let node = element.parentElement; node; node = node.parentElement) {
      const css = getComputedStyle(node);
      if (css.opacity !== '1' || css.filter !== 'none' || css.mixBlendMode !== 'normal') ancestorEffects.push(node.tagName + '.' + node.className);
    }
    const overlays = ['::before', '::after'].filter(pseudo => {
      const css = getComputedStyle(element, pseudo);
      return css.content !== 'none' && css.content !== 'normal' && css.display !== 'none' && css.opacity !== '0';
    });
    const textRuns = [...element.querySelectorAll('*')].filter(node => [...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim())).map(node => {
      const layers = [];
      for (let current = node; current !== element; current = current.parentElement) {
        const css = getComputedStyle(current);
        layers.unshift({ backgroundColor: css.backgroundColor, backgroundImage: css.backgroundImage, opacity: css.opacity,
          filter: css.filter, mixBlendMode: css.mixBlendMode });
      }
      return { label: [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join('').trim(), color: getComputedStyle(node).color, layers };
    });
    return { label: element.textContent.trim() || element.getAttribute('aria-label'), className: element.className,
      color: s.color, backgroundImage: s.backgroundImage, backgroundColor: s.backgroundColor, filter: s.filter,
      opacity: s.opacity, cursor: s.cursor, fontSize: s.fontSize, fontWeight: s.fontWeight,
      disabled: element.disabled, busy: element.getAttribute('aria-busy'), hover: element.matches(':hover'),
      focusVisible: element.matches(':focus-visible'), active: element.matches(':active'),
      outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, ancestorEffects, overlays, textRuns,
      box: rect(box), text: rect(text.getBoundingClientRect()) };
  });
}
async function settle() {
  await B.delay(220);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function audit(label, selector) {
  report.current = label; persist();
  const control = { label, selector, states: [] }; report.controls.push(control);
  await page.$eval(selector, element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  async function measure(state) {
    await settle(); const style = await styleOf(selector);
    assert.equal(style.disabled, false, label + ' must be enabled');
    assert.notEqual(style.busy, 'true', label + ' must have settled');
    if (state === 'hover' || state === 'active') assert.equal(style.hover, true);
    if (state === 'focus') { assert.equal(style.focusVisible, true); assert.notEqual(style.outlineStyle, 'none'); }
    if (state === 'active') assert.equal(style.active, true);
    const result = { state, ...style, ...contrast(style) };
    result.passed = result.minimumRatio >= 4.5;
    control.states.push(result); persist();
    console.log((result.passed ? 'PASS ' : 'FAIL ') + label + '/' + state + ': ' + result.minimumRatio.toFixed(4));
  }
  await page.mouse.move(0, 0); await page.$eval(selector, element => element.blur());
  await measure('default');
  control.screenshot = label + '.png'; await page.screenshot({ path: path.join(OUT, control.screenshot) });
  await page.hover(selector); await measure('hover');
  await page.mouse.move(0, 0); await page.focus(selector);
  await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
  await page.keyboard.press('Tab'); await measure('focus');
  await page.hover(selector); await page.mouse.down();
  try { await measure('active'); } finally { await page.mouse.move(0, 0); await page.mouse.up(); }
  await page.$eval(selector, element => element.blur());
}
async function home() {
  for (let n = 0; n < 8 && (await B.ui(page)).form; n++) {
    if ((await B.ui(page)).auth) await B.click(page, '.sheet-footer ' + a('parent-cancel'));
    else await B.closeSheet(page);
  }
  await B.noSheet(page);
  if ((await B.ui(page)).view !== 'points') await B.navigate(page, 'points');
}
async function disabled() {
  report.current = 'disabled-redemption'; persist();
  await home(); await B.click(page, a('jump-rewards')); await B.click(page, '.sheet ' + a('reward-filter', 'all'));
  await B.click(page, '.sheet ' + a('redeem', 'reward-trip'));
  const selector = B.SELECTORS.submit;
  await page.hover(selector); await settle();
  const style = await styleOf(selector);
  assert.equal(style.disabled, true); assert.equal(style.busy, 'false');
  assert.equal(style.backgroundImage, 'none'); assert.equal(style.filter, 'none');
  assert.equal(style.cursor, 'not-allowed');
  const before = env.requests.length;
  await page.mouse.click(style.box.x + style.box.width / 2, style.box.y + style.box.height / 2);
  await B.delay(50); assert.equal(env.requests.length, before, 'disabled action must not submit');
  report.disabled = style; await page.screenshot({ path: path.join(OUT, 'disabled-redemption.png') }); persist();
}
async function runTest() {
  try {
    browser = await B.launch(); report.browser = await browser.version(); persist();
    const state = M.apply(M.createSeed(new Date(B.FIXTURE_TIME)), { id: 'contrast-farm-start', type: 'farm.start' }, new Date(B.FIXTURE_TIME));
    env = await B.createEnvironment(browser, { state }); page = await env.newPage({ width: 390, height: 844 });
    page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(10000); await env.load(page);
    await audit('home-primary', '.credit-add');
    await audit('home-harvest', '.farm-toolbar .farm-tool-primary');
    await B.click(page, a('add-points')); await audit('picker-add', '.sheet .icon-button.nav-add');
    await B.click(page, '.sheet ' + a('points-new')); await audit('points-save', B.SELECTORS.submit);
    await home(); await B.click(page, a('farm-open')); await audit('farm-harvest', '.farm-game-sheet .farm-tool-primary');
    await home(); await B.click(page, a('home-inbox')); await audit('reminder-complete', '.sheet .reminder-primary');
    await home(); await B.navigate(page, 'reminders'); await B.click(page, a('task-edit', 'task-reading'));
    await B.click(page, '.sheet ' + a('task-delete')); await page.waitForSelector('#parent-form .danger-primary');
    await audit('danger-confirm', '#parent-form .danger-primary');
    await disabled();
    assert.deepEqual(env.errors, [], 'browser runtime errors');
    assert.equal(env.requests.filter(request => request.path === '/api/action').length, 0, 'contrast audit must not change business state');
    assert.equal(hashCSS(), report.cssHash, 'CSS changed during audit');
    const failures = report.controls.flatMap(control => control.states.filter(item => !item.passed).map(item => control.label + '/' + item.state + ': ' + item.minimumRatio.toFixed(4)));
    assert.deepEqual(failures, [], 'enabled primary contrast must be at least 4.5:1');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = error.stack; process.exitCode = 1; console.error(error.stack);
  } finally {
    report.finishedAt = new Date().toISOString(); persist();
    if (env) await env.close(); if (browser) await browser.close();
  }
  console.log('Contrast ' + report.status + '; report: ' + path.join(OUT, 'results.json'));
}
runTest();
