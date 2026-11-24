'use strict';

// One short, isolated screenshot group. Never opens a production database.
// node test/points-home-visual.cjs --label before --viewport phone
// PowerShell: npm.cmd run test:home:visual -- --label before --viewport phone
// --viewport phone|small-phone|ipad; --width N --height N override CSS content size.
// --family sparse mirrors the feedback; mixed adds a real redemption and purchase.
// dense remains the default. --height 844 captures the regular 390x844 phone page.
// --acceptance baseline captures original presentation without final-layout gates.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const args = Object.create(null);
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  assert.ok(['--label', '--viewport', '--width', '--height', '--compare', '--family', '--acceptance'].includes(key) && value, 'Expected --label, --viewport, --width, --height, --compare, --family or --acceptance followed by a value');
  args[key.slice(2)] = value;
}
const presets = { phone: [390, 665], 'small-phone': [320, 568], ipad: [768, 1024] };
const preset = args.viewport || 'phone';
assert.ok(presets[preset], 'Unknown viewport preset');
const familyPreset = args.family || 'dense';
assert.ok(['dense', 'sparse', 'mixed'].includes(familyPreset), 'Unknown family preset');
const lightFamily = familyPreset !== 'dense';
const acceptance = args.acceptance || 'final';
assert.ok(['baseline', 'final'].includes(acceptance), 'Unknown acceptance mode');
const width = Number(args.width || presets[preset][0]), height = Number(args.height || presets[preset][1]);
assert.ok(Number.isInteger(width) && width >= 280 && width <= 2000 && Number.isInteger(height) && height >= 350 && height <= 2000, 'Invalid CSS viewport size');
const label = args.label || 'capture';
assert.match(label, /^[a-zA-Z0-9_-]{1,50}$/, 'Label must contain 1–50 letters, digits, underscores or hyphens');
const run = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 17) + '-' + process.pid;
const out = path.join(ROOT, 'data', 'ui-home-visual', label + '-' + width + 'x' + height + '-' + run);
fs.mkdirSync(out, { recursive: true });
// Reuse the real SaaS/SQLite/browser fixture, including its safe temporary cleanup.
process.env.TEST_ARTIFACT_DIR = path.join(out, 'fixture');
const Q = require('./saas-browser.cjs');
const H = require('../home-points.js');
const NOW = Date.parse('2026-11-23T12:30:00Z');
const sources = ['test/points-home-visual.cjs', 'home-points.js', 'home-points.css', 'app.js', 'styles.css', 'farm-world.css', 'index.html', 'saas-client.js', 'assistant-panel.css'];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
const sourceHashes = () => Object.fromEntries(sources.map(file => [file, hash(file)]));
const report = { status: 'running', label, startedAt: new Date().toISOString(), viewport: { width, height, deviceScaleFactor: 1 },
  familyPreset, acceptance,
  measurementPurpose: 'Region positions, visible row counts and scroll range describe the capture; they are not sparse-family design targets.',
  isolation: 'Fresh synthetic account and family, ephemeral loopback SaaS service and temporary SQLite file; no external email or real records.',
  boundary: 'Chromium CSS content viewport without browser chrome. Physical Safari/iPad and native safe-area insets are not verified.',
  sourceHashes: sourceHashes(), screenshots: [], checks: [], steps: [] };
const logfile = path.join(out, 'run.log');
function persist() { fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n'); }
function progress(message) {
  const line = new Date().toISOString() + ' ' + message;
  report.steps.push(line); fs.appendFileSync(logfile, line + '\n'); persist(); console.log(line);
}
async function screenshot(page, name) {
  const file = path.join(out, name + '.png');
  await page.screenshot({ path: file, fullPage: false }); report.screenshots.push(file); persist();
}
async function recentScreenshot(page) {
  const recent = await page.$('.points-recent');
  assert.ok(recent, 'The actual recent-record widget exists');
  await recent.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
  await Q.B.delay(80);
  const bounds = await recent.evaluate(node => {
    const r = node.getBoundingClientRect(), main = node.closest('.app-main').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height,
      fullyVisible: r.top >= Math.max(0, main.top) - 1 && r.bottom <= Math.min(innerHeight, main.bottom) + 1 && r.left >= 0 && r.right <= innerWidth };
  });
  assert.ok(bounds.fullyVisible, 'Normal app scrolling fully reveals the recent-record widget');
  const file = path.join(out, 'recent-records.png');
  await recent.screenshot({ path: file, captureBeyondViewport: false });
  report.screenshots.push(file); report.recentCapture = { file, ...bounds, deviceScaleFactor: 1 };
  progress('Saved actual recent-record widget at its natural CSS width: ' + file);
}
async function verifyRecentRecords(page, summary, session) {
  const view = await page.$eval('.points-recent', node => {
    const box = target => {
      if (!target) return null;
      const r = target.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
        text: target.innerText.trim(), clipped: target.scrollWidth > target.clientWidth + 1 || target.scrollHeight > target.clientHeight + 1 };
    };
    return { text: node.innerText, days: [...node.querySelectorAll('.points-record-day')].map(group => ({
      label: group.querySelector('h3')?.innerText.trim(), records: group.querySelectorAll('.points-recent-row').length
    })), rows: [...node.querySelectorAll('.points-recent-row')].map(row => {
      const time = row.querySelector('time'), amount = row.querySelector('.points-record-amount');
      return { ...box(row), name: box(row.querySelector('.points-record-copy > strong')), time: box(time),
        datetime: time?.getAttribute('datetime'), accessibleTime: time?.getAttribute('aria-label'),
        day: row.closest('.points-record-day')?.querySelector('h3')?.innerText.trim(),
        reason: box(row.querySelector('.points-record-reason')), amount: box(amount),
        earned: amount?.classList.contains('is-earned'), spent: amount?.classList.contains('is-spent') };
    }) };
  });
  assert.equal(view.rows.length, summary.recent.length, 'The actual widget contains the newest three ledger entries');
  const overlaps = (a, b) => !!(a && b && Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1);
  for (let index = 0; index < summary.recent.length; index++) {
    const row = view.rows[index], expected = summary.recent[index];
    assert.equal(row.name?.text, expected.name, 'Recent record keeps its saved name');
    assert.equal(row.datetime, expected.at, 'Recent time represents the saved ledger timestamp');
    assert.ok(row.time?.text.includes(expected.clock), 'Recent record visibly keeps its actual clock time');
    assert.equal(row.accessibleTime, expected.timeLabel, 'Time accessible name includes both its day and clock time');
    assert.ok(view.text.includes(expected.dayLabel), 'Recent widget visibly identifies each represented day');
    assert.equal(row.amount?.text.replace(/\s+/g, ''), (expected.positive ? '+' : '−') + expected.points + '分', 'Recent record retains its own signed amount');
    assert.equal(row.earned, expected.positive); assert.equal(row.spent, !expected.positive);
    if (expected.reason) assert.ok(row.reason?.text.includes(expected.reason), 'Recent record retains the actual saved note');
    if (!expected.positive) assert.ok(row.reason?.text.includes(expected.kindLabel), 'Spending clearly identifies redemption or purchase');
    if (acceptance === 'final') {
      assert.equal(row.day, expected.dayLabel, 'Recent record belongs to its visible family-date group');
      for (const [name, content] of Object.entries({ name: row.name, time: row.time, reason: row.reason, amount: row.amount })) {
        if (content) assert.equal(content.clipped, false, 'Recent row content stays readable without clipping: ' + name);
      }
      for (const content of [row.name, row.time, row.reason]) assert.equal(overlaps(content, row.amount), false, 'Recent signed amount has its own space');
    }
  }
  const { root } = await session.send('DOM.getDocument');
  const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#points-recent-heading' });
  assert.ok(nodeId, 'Recent widget has a named heading');
  const { nodes } = await session.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
  const heading = nodes[0];
  assert.equal(heading.role?.value, 'heading'); assert.equal(heading.name?.value, '最近记录'); assert.equal(heading.ignored, false);
  assert.equal(heading.properties?.find(property => property.name === 'level')?.value.value, 2, 'Recent heading keeps level-two semantics');
  report.recentPresentation = view;
  if (acceptance === 'final') assert.deepEqual(view.days, [...new Set(summary.recent.map(row => row.day))].map(day => ({
    label: summary.recent.find(row => row.day === day).dayLabel, records: summary.recent.filter(row => row.day === day).length
  })), 'Each represented family date has one named group with its actual entries');
  report.checks.push('Recent widget preserves actual latest ledger order, saved day/time and note, signed per-record amounts, and an accessible level-two heading');
  if (acceptance === 'final') report.checks.push('Recent record names, times, notes and amounts remain readable without clipping or overlap at this width');
}
async function comparisonImage(browser, previousReport) {
  const visualRoot = path.join(ROOT, 'data', 'ui-home-visual');
  const relative = path.relative(visualRoot, previousReport);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Comparison requires a local synthetic visual report');
  assert.equal(path.basename(previousReport), 'results.json');
  const files = [path.join(path.dirname(previousReport), 'home-initial.png'), path.join(out, 'home-initial.png')];
  const images = files.map(file => 'data:image/png;base64,' + fs.readFileSync(file).toString('base64'));
  // A fresh browser context contains neither family cookies nor application code.
  // Offline mode and CSP keep this composition page limited to the two PNGs.
  const context = await browser.createBrowserContext();
  try {
    const comparison = await context.newPage();
    await comparison.setViewport({ width: width * 2 + 72, height: height + 88, deviceScaleFactor: 1 });
    await comparison.setOfflineMode(true);
    await comparison.setContent('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'"><style>' +
      '*{box-sizing:border-box}body{margin:0;background:#f1f4f2;color:#163a32;font-family:"Microsoft YaHei",sans-serif}' +
      'main{display:grid;grid-template-columns:repeat(2,' + width + 'px);gap:24px;padding:24px}figure{margin:0}' +
      'figcaption{height:28px;margin-bottom:12px;text-align:center;font-size:20px;font-weight:600;line-height:28px}' +
      'img{display:block;width:' + width + 'px;height:' + height + 'px;object-fit:contain}' +
      '</style></head><body><main><figure><figcaption>改版前</figcaption><img alt="" src="' + images[0] + '"></figure>' +
      '<figure><figcaption>改版后</figcaption><img alt="" src="' + images[1] + '"></figure></main></body></html>', { waitUntil: 'load' });
    const rendered = await comparison.$$eval('img', nodes => nodes.map(node => ({
      loaded: node.complete, naturalWidth: node.naturalWidth, naturalHeight: node.naturalHeight,
      width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height
    })));
    assert.equal(rendered.length, 2);
    for (const image of rendered) assert.deepEqual(image, { loaded: true, naturalWidth: width, naturalHeight: height, width, height }, 'Comparison preserves the identical source size and aspect ratio');
    assert.equal(await comparison.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight), false, 'Comparison fits without clipping');
    const file = path.join(out, 'compare.png');
    await comparison.screenshot({ path: file, fullPage: false }); report.screenshots.push(file);
    report.comparison.image = { file, sources: files, rendered, isolatedContext: true, offline: true };
    progress('Saved same-size before/after comparison: ' + file);
  } finally { await context.close(); }
}
async function recentComparisonImage(browser, previousReport) {
  const previous = JSON.parse(fs.readFileSync(previousReport, 'utf8'));
  assert.ok(previous.recentCapture, 'Comparison baseline contains an actual recent-record widget capture');
  assert.equal(previous.recentCapture.deviceScaleFactor, 1);
  const files = [path.join(path.dirname(previousReport), 'recent-records.png'), path.join(out, 'recent-records.png')];
  const images = files.map(file => 'data:image/png;base64,' + fs.readFileSync(file).toString('base64'));
  const context = await browser.createBrowserContext();
  try {
    const comparison = await context.newPage();
    await comparison.setOfflineMode(true);
    await comparison.setContent('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'"><style>' +
      '*{box-sizing:border-box}body{margin:0;background:#f1f4f2;color:#163a32;font-family:"Microsoft YaHei",sans-serif}' +
      'main{display:flex;align-items:flex-start;gap:24px;padding:24px}figure{margin:0;flex:none}' +
      'figcaption{height:28px;margin-bottom:12px;text-align:center;font-size:20px;font-weight:600;line-height:28px}' +
      'img{display:block;width:auto;height:auto;max-width:none;max-height:none}' +
      '</style></head><body><main><figure><figcaption>改版前</figcaption><img alt="改版前的最近记录原图" src="' + images[0] + '"></figure>' +
      '<figure><figcaption>改版后</figcaption><img alt="改版后的最近记录原图" src="' + images[1] + '"></figure></main></body></html>', { waitUntil: 'load' });
    // A component may change width at the same viewport. Lay out each crop at
    // its own natural size; the full-page comparison still requires equal sizes.
    const sizes = await comparison.$$eval('img', nodes => nodes.map(node => ({ width: node.naturalWidth, height: node.naturalHeight })));
    assert.equal(sizes.length, 2);
    for (const image of sizes) assert.ok(image.width > 0 && image.height > 0, 'Actual recent-record crop has natural dimensions');
    await comparison.setViewport({ width: sizes[0].width + sizes[1].width + 72,
      height: Math.max(...sizes.map(image => image.height)) + 88, deviceScaleFactor: 1 });
    const rendered = await comparison.$$eval('img', nodes => nodes.map(node => ({
      loaded: node.complete, naturalWidth: node.naturalWidth, naturalHeight: node.naturalHeight,
      width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height
    })));
    assert.equal(rendered.length, 2);
    for (const image of rendered) {
      assert.ok(image.loaded && image.naturalWidth > 0 && image.naturalHeight > 0, 'Actual recent-record crop loaded');
      assert.equal(image.width, image.naturalWidth, 'Recent comparison preserves original pixel width');
      assert.equal(image.height, image.naturalHeight, 'Recent comparison preserves original pixel height');
    }
    assert.equal(await comparison.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight), false, 'Recent comparison fits without clipping');
    const file = path.join(out, 'recent-compare.png');
    await comparison.screenshot({ path: file, fullPage: false }); report.screenshots.push(file);
    report.comparison.recentImage = { file, sources: files, rendered, isolatedContext: true, offline: true, scale: 1 };
    progress('Saved natural-size recent-record before/after comparison: ' + file);
  } finally { await context.close(); }
}
async function measurements(page) {
  return page.evaluate(() => {
    const main = document.querySelector('.app-main'), mainBox = main.getBoundingClientRect();
    const box = node => {
      if (!node) return null;
      const r = node.getBoundingClientRect(), s = getComputedStyle(node);
      const visibleHeight = Math.max(0, Math.min(r.bottom, mainBox.bottom, innerHeight) - Math.max(r.top, mainBox.top, 0));
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom,
        visibleHeight, visibleFraction: r.height ? Math.round(visibleHeight / r.height * 1000) / 1000 : 0,
        fontSize: parseFloat(s.fontSize), lineHeight: s.lineHeight, color: s.color, background: s.backgroundColor };
    };
    // Keep the historical intro report key for before/after report comparisons.
    const selectors = { header: '.home-header', main: '.app-main', intro: 'h1.points-home-title', wallet: '.points-wallet',
      total: '.points-total, [data-testid="earned-points"]', available: '[data-testid="available-points"]', today: '.points-today',
      recent: '.points-recent', week: '.points-overview', behaviors: '.points-behaviors', behaviorGrid: '.points-behavior-grid', nav: '.bottom-nav' };
    const regions = Object.fromEntries(Object.entries(selectors).map(([name, selector]) => [name, box(document.querySelector(selector))]));
    const controls = [...document.querySelectorAll('.app-shell button')].map(node => {
      const r = node.getBoundingClientRect(), s = getComputedStyle(node), x = r.x + r.width / 2, y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y), inMain = !!node.closest('.app-main');
      return { action: node.dataset.action, id: node.dataset.id || '', name: node.getAttribute('aria-label') || node.textContent.trim(),
        ...box(node), displayed: r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden',
        inViewport: r.x >= -1 && r.y >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 &&
          (!inMain || (r.top >= mainBox.top - 1 && r.bottom <= mainBox.bottom + 1)),
        reachable: !!hit && (hit === node || node.contains(hit)) };
    }).filter(node => node.displayed);
    const rows = [...document.querySelectorAll('.points-recent-row')].map(node => ({ text: node.textContent.trim(), ...box(node) }));
    const chartLabels = [...document.querySelectorAll('.points-day-label')].map(node => ({ text: node.textContent.trim(), ...box(node) }));
    const appearance = node => {
      if (!node) return null;
      const style = getComputedStyle(node);
      return { ...box(node), text: (node.innerText || '').trim(), display: style.display, visibility: style.visibility,
        overflow: style.overflow, clip: style.clip, clipPath: style.clipPath };
    };
    const link = selector => {
      const node = document.querySelector(selector);
      return node && { ...appearance(node), action: node.dataset.action, icon: appearance(node.querySelector('.icon')) };
    };
    const profile = document.querySelector('.home-header [data-action="profile-edit"]');
    const camera = profile && profile.querySelector('.avatar-camera-badge');
    const presentation = { profile: appearance(profile), camera: appearance(camera), cameraIcon: appearance(camera && camera.querySelector('.icon')),
      intro: appearance(document.querySelector('h1.points-home-title')), titleCount: document.querySelectorAll('h1.points-home-title').length,
      legacyIntroCount: document.querySelectorAll('.points-home-intro').length,
      recentLink: link('.points-recent .points-section-link'), weekLink: link('.points-overview .points-section-link'),
      behaviorLink: link('.points-behaviors .points-section-link') };
    return { viewport: { width: innerWidth, height: innerHeight, screenWidth: screen.width, screenHeight: screen.height },
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      main: { clientHeight: main.clientHeight, scrollHeight: main.scrollHeight, scrollTop: main.scrollTop, scrollRange: main.scrollHeight - main.clientHeight },
      regions, controls, chartLabels, presentation, recentRows: rows, fullyVisibleRecentRows: rows.filter(row => row.visibleFraction >= .99).length,
      partiallyVisibleRecentRows: rows.filter(row => row.visibleFraction > 0 && row.visibleFraction < .99).length,
      text: document.querySelector('.points-home').innerText };
  });
}
async function homeAccessibility(session) {
  const { root } = await session.send('DOM.getDocument');
  const selectors = { profile: '.home-header [data-action="profile-edit"]', heading: 'h1.points-home-title',
    recentLink: '.points-recent .points-section-link', weekLink: '.points-overview .points-section-link',
    behaviorLink: '.points-behaviors .points-section-link' };
  const entries = await Promise.all(Object.entries(selectors).map(async ([name, selector]) => {
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    assert.ok(nodeId, 'Accessible home element exists: ' + selector);
    const { nodes } = await session.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
    assert.ok(nodes.length, 'Browser exposes accessibility information: ' + selector);
    const node = nodes[0];
    const semantics = { role: node.role?.value, name: node.name?.value || '', ignored: node.ignored };
    if (name === 'heading') semantics.level = node.properties?.find(property => property.name === 'level')?.value.value;
    return [name, semantics];
  }));
  return Object.fromEntries(entries);
}
async function verifyHomePresentation(session) {
  const p = report.initial.presentation;
  report.accessibility = await homeAccessibility(session);
  const accessible = report.accessibility;
  for (const name of ['profile', 'recentLink', 'weekLink', 'behaviorLink']) {
    assert.equal(accessible[name].ignored, false, 'Home action remains available to screen readers: ' + name);
    assert.equal(accessible[name].role, 'button', 'Home action has button semantics: ' + name);
    assert.ok(accessible[name].name.trim(), 'Home action has an accessible name: ' + name);
  }
  assert.ok(p.profile.text.includes(report.fixture.childName), 'Profile entry visibly keeps the child name');
  assert.ok(accessible.profile.name.includes(report.fixture.childName), 'Profile accessible name identifies the child');
  assert.match(accessible.profile.name, /头像|资料/, 'Profile accessible name explains its purpose');
  assert.match(accessible.recentLink.name, /记录/, 'Recent-record arrow has a meaningful accessible name');
  assert.match(accessible.weekLink.name, /小结/, 'Weekly arrow has a meaningful accessible name');
  assert.match(accessible.behaviorLink.name, /行为/, 'Behavior arrow has a meaningful accessible name');
  assert.deepEqual(accessible.heading, { role: 'heading', name: '成长积分册', ignored: false, level: 1 }, 'Home title keeps its level-one screen-reader heading semantics');
  assert.equal(p.titleCount, 1, 'Points home has one semantic page title');
  assert.equal(p.legacyIntroCount, 0, 'The redundant intro container is removed');
  assert.doesNotMatch(p.profile.text, /上传|更换头像/, 'Profile entry has no visible upload/change caption');
  assert.ok(p.camera && p.camera.width >= 16 && p.camera.height >= 16 && p.camera.visibility === 'visible', 'Camera badge remains visible');
  assert.ok(p.cameraIcon && p.cameraIcon.width >= 12 && p.cameraIcon.height >= 12 && p.cameraIcon.visibility === 'visible', 'Camera glyph stays discernible');
  assert.ok(p.intro.width > 0 && p.intro.width <= 1.1 && p.intro.height > 0 && p.intro.height <= 1.1, 'Semantic home title occupies only a 1px box');
  assert.ok(['hidden', 'clip'].includes(p.intro.overflow) && (p.intro.clipPath !== 'none' || p.intro.clip !== 'auto'), 'Semantic home title is visually clipped');
  assert.notEqual(p.intro.display, 'none'); assert.equal(p.intro.visibility, 'visible');
  assert.equal(p.recentLink.action, 'records'); assert.equal(p.weekLink.action, 'home-week'); assert.equal(p.behaviorLink.action, 'all-behaviors');
  for (const name of ['recentLink', 'weekLink']) {
    assert.equal(p[name].text, '', 'Section action has no visible caption: ' + name);
    assert.ok(p[name].icon && p[name].icon.width >= 12 && p[name].icon.height >= 12, 'Section action keeps its arrow: ' + name);
  }
  if (lightFamily) assert.equal(p.behaviorLink.text, '', 'A single shortcut needs an accessible arrow without a redundant one-item count');
  else assert.match(p.behaviorLink.text, /^\d+\s*项$/, 'Multiple shortcuts keep their useful count without the redundant all caption');
  assert.ok(p.behaviorLink.icon && p.behaviorLink.icon.width >= 12 && p.behaviorLink.icon.height >= 12, 'Behavior action keeps its arrow');
  report.headerWalletGap = report.initial.regions.wallet.y - report.initial.regions.header.bottom;
  report.checks.push('All widths keep child name and camera without upload captions, a visually hidden accessible h1, accessible section arrows, and a behavior count only when useful');
  if (width <= 699) {
    assert.ok(report.headerWalletGap >= 8 && report.headerWalletGap <= 18, 'Phone wallet follows the header without an extra title row: ' + report.headerWalletGap);
    report.checks.push('Phone wallet starts 8–18px after the header without an extra title row');
  } else {
    const { wallet, week } = report.initial.regions;
    assert.ok(Math.abs(wallet.y - week.y) <= 1, 'Tablet wallet and weekly summary share the first row');
    assert.ok(wallet.right <= week.x + 1 || week.right <= wallet.x + 1, 'Tablet keeps separate wallet and weekly-summary columns');
    report.checks.push('Tablet keeps wallet and weekly summary side by side in the first row');
  }
}
async function verifyCameraProfile(page) {
  // Run after both captures so focus, scrolling and sheet animations cannot alter them.
  await Q.click(page, '.home-header .avatar-camera-badge', { scroll: false });
  await page.waitForSelector('.sheet[data-form-kind="profile"]', { visible: true });
  assert.equal(await page.$eval('.sheet [name="childName"]', node => node.value), report.fixture.childName);
  const choose = '.sheet [data-action="avatar-choose"]';
  assert.ok(await Q.visible(page, choose), 'Child profile exposes the photo selection action');
  const fileInput = await page.$eval('.sheet input[type="file"]', node => ({ accept: node.accept, name: node.getAttribute('aria-label') }));
  assert.match(fileInput.accept, /image\//); assert.ok(fileInput.name, 'Photo input has an accessible name');
  const pendingChooser = page.waitForFileChooser();
  await Q.click(page, choose); await (await pendingChooser).cancel();
  await Q.click(page, '.sheet-header [data-action="form-close"]');
  await page.waitForFunction(() => !window.FamilyDemo.getUI().form);
  report.checks.push('Real click on camera opens child profile; photo chooser opens and can be cancelled; profile closes without saving');
}
async function verifyHomeContent(page, summary, items) {
  const shortcuts = report.initial.controls.filter(node => node.action === 'choose-point');
  assert.equal(shortcuts.length, items.length, 'Home exposes every configured enabled shortcut');
  for (const item of items) {
    const shortcut = shortcuts.find(node => node.id === item.id);
    assert.ok(shortcut && shortcut.name.includes(item.name), 'Shortcut identifies its saved behavior: ' + item.name);
    assert.ok(shortcut.inViewport && shortcut.reachable && shortcut.width >= 47.9 && shortcut.height >= 47.9,
      'Shortcut is initially tappable with a 48px target: ' + item.name);
  }
  if (items.length === 1) {
    const grid = report.initial.regions.behaviorGrid, shortcut = shortcuts[0];
    assert.ok(grid && Math.abs(shortcut.x - grid.x) <= 1 && Math.abs(shortcut.width - grid.width) <= 1,
      'A single shortcut spans its full row');
  }
  report.shortcutLayout = { count: shortcuts.length, grid: report.initial.regions.behaviorGrid,
    shortcuts: shortcuts.map(({ id, x, y, width, height, reachable }) => ({ id, x, y, width, height, reachable })) };
  report.recentReachability = [];
  assert.equal(report.initial.recentRows.length, summary.recent.length, 'Recent section retains the actual latest ledger rows');
  for (let index = 0; index < summary.recent.length; index++) {
    const expected = summary.recent[index];
    await page.$$eval('.points-recent-row', (nodes, target) => nodes[target].scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }), index);
    await Q.B.delay(30);
    const current = await measurements(page), row = current.recentRows[index];
    assert.ok(row.text.includes(expected.name), 'Recent row identifies its actual saved behavior: ' + expected.name);
    assert.ok(row.visibleFraction >= .99, 'Normal scrolling reveals the whole recent row: ' + expected.name);
    report.recentReachability.push({ id: expected.id, name: expected.name, visibleFraction: row.visibleFraction,
      y: row.y, height: row.height, scrollTop: current.main.scrollTop });
  }
  report.checks.push('Every configured shortcut remains initially tappable; a single shortcut spans its row; all actual recent rows are fully reachable by normal scrolling');
}
async function verifyHomeEntryRoutes(page, state) {
  report.entryRoutes = [];
  for (const [selector, kind] of [
    ['.points-home [data-action="add-points"]', 'behaviorPicker'],
    ['.points-home [data-action="jump-rewards"]', 'rewards'],
    ['.points-recent [data-action="records"]', 'records'],
    ['.points-overview [data-action="home-week"]', 'homeWeek'],
    ['.points-behaviors [data-action="all-behaviors"]', 'behaviorPicker']
  ]) {
    await Q.click(page, selector);
    await page.waitForSelector('.sheet[data-form-kind="' + kind + '"]', { visible: true });
    report.entryRoutes.push({ selector, kind });
    if (kind === 'records' && familyPreset === 'mixed') {
      const balances = await page.$$eval('.sheet .ledger-summary b', nodes => nodes.map(node => Number(node.textContent)));
      assert.deepEqual(balances, [report.fixture.totals.earned, report.fixture.totals.spent, report.fixture.totals.available], 'Real record entry distinguishes cumulative, spent and available points');
      report.mixedLedger = { balances, tabs: [] };
      for (const [tab, savedRows] of [['points', state.points], ['redemptions', state.redemptions], ['purchases', state.petPurchases]]) {
        await Q.click(page, '.sheet [data-action="history"][data-id="' + tab + '"]');
        const rows = await page.$$eval('.sheet .record-row', nodes => nodes.map(node => ({
          name: node.querySelector('strong')?.innerText.trim(), amount: node.querySelector('.record-number')?.innerText.replace(/\s+/g, ''),
          text: node.innerText
        })));
        assert.equal(rows.length, savedRows.length, 'Real ledger tab contains every actual saved row: ' + tab);
        for (const saved of savedRows) {
          const row = rows.find(row => row.name === saved.name);
          assert.ok(row, 'Real ledger tab retains the actual saved name: ' + saved.name);
          assert.equal(row.amount, (tab === 'points' ? '+' : '−') + saved.points + '分', 'Real ledger tab keeps the signed per-record amount');
          if (saved.reason || saved.note) assert.ok(row.text.includes(saved.reason || saved.note), 'Real ledger tab retains the actual saved note');
        }
        report.mixedLedger.tabs.push({ tab, rows });
        await screenshot(page, 'mixed-ledger-' + tab);
      }
      report.checks.push('At narrow width, the real records entry distinguishes 14 cumulative / 5 spent / 9 available and opens actual award, redemption and purchase tabs');
    }
    await Q.click(page, '.sheet-header [data-action="form-close"]');
    await page.waitForFunction(() => !window.FamilyDemo.getUI().form);
  }
  report.checks.push('Real home actions open the behavior picker, gift catalog, ledger and weekly details; each returns without saving');
}
let env, page, familyId, sequence = 0;
async function fixtureAction(input, protectedAction = true) {
  const current = await env.api(page, '/api/state'); assert.equal(current.status, 200);
  const action = { ...input, id: 'home-visual-' + (++sequence) };
  let grant;
  if (protectedAction) {
    const challenge = await env.api(page, '/api/parent/challenge', 'POST', { revision: current.body.revision, action });
    assert.equal(challenge.status, 200, JSON.stringify(challenge.body));
    const verified = await env.api(page, '/api/parent/verify', 'POST', { challengeId: challenge.body.challengeId, answer: Q.PIN });
    assert.equal(verified.status, 200, JSON.stringify(verified.body)); grant = verified.body.grant;
  }
  const result = await env.api(page, '/api/action', 'POST', { revision: current.body.revision, action, grant });
  assert.equal(result.status, 200, JSON.stringify(result.body));
}
async function scenario() {
  Q.phase('points-home-visual'); progress('Creating isolated SaaS and SQLite');
  env = await Q.initialize(); env.clock(NOW);
  page = await env.newPage({ width, height, controlledClock: true }); Q.active(page); page.setDefaultTimeout(7000);
  const session = await page.createCDPSession();
  // Match the existing device-home fixture. Switching Puppeteer's mobile mode on
  // an about:blank page would reload its injected storage probe before an origin exists.
  await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height });
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await Q.registerAndVerify(page, 'points-visual-' + run + '@example.test');
  familyId = await Q.createFamily(page, '合成视觉核对家庭', lightFamily ? '小米' : '小宝');
  await fixtureAction({ type: 'parent.setup', method: 'pin', pin: Q.PIN, confirmPin: Q.PIN }, false);
  const habits = lightFamily ? [['独立阅读', '', 5]] : [
    ['阅读十分钟', '安静读完了一本故事书'], ['整理书包', '主动把学习用品放整齐'],
    ['按时起床', '闹钟响后自己起床'], ['主动分享', '把喜欢的玩具分享给朋友']
  ];
  for (let index = 0; index < habits.length; index++) {
    await fixtureAction({ type: 'pointItem.save', item: { id: 'visual-habit-' + index, name: habits[index][0], reason: habits[index][1], points: habits[index][2] || 2, enabled: true } });
  }
  if (lightFamily) {
    progress('Adding sparse synthetic history: earlier +5, yesterday +3 and +5, today +1; one +5 shortcut');
    for (const record of [
      { at: '2026-11-20T12:30:00Z', name: '独立阅读', points: 5, reason: '' },
      { at: '2026-11-22T10:58:00Z', name: '整理书包', points: 3, reason: '按明天的课表收好课本' },
      { at: '2026-11-22T13:17:00Z', name: '认真写作业', points: 5, reason: '' },
      { at: '2026-11-23T09:19:00Z', name: '好好吃饭', points: 1, reason: '' }
    ]) {
      env.clock(Date.parse(record.at));
      await fixtureAction({ type: 'points.add', name: record.name, points: record.points, reason: record.reason });
    }
    if (familyPreset === 'mixed') {
      progress('Adding real mixed ledger: yesterday purchase -3 and today gift redemption -2');
      await fixtureAction({ type: 'reward.save', reward: { id: 'visual-gift', name: '彩虹铅笔', points: 2, category: 'daily', enabled: true, icon: 'pencil' } });
      env.clock(Date.parse('2026-11-22T13:30:00Z'));
      await fixtureAction({ type: 'pet.buy', itemId: 'snack', quantity: 1, expectedPoints: 3 });
      env.clock(Date.parse('2026-11-23T10:03:00Z'));
      await fixtureAction({ type: 'reward.redeem', rewardId: 'visual-gift', expectedPoints: 2, note: '认真攒分后选的彩虹铅笔' });
    }
  } else {
    progress('Adding synthetic history: five earlier points and four awards today');
    for (let days = 5; days >= 1; days--) {
      env.clock(NOW - days * 86400000);
      await fixtureAction({ type: 'points.add', name: habits[days % habits.length][0], points: 1, reason: '完成一个小进步' });
    }
    env.clock(NOW);
    for (let index = 0; index < habits.length; index++) {
      await fixtureAction({ type: 'points.add', itemId: 'visual-habit-' + index, reason: habits[index][1], at: new Date(NOW - (3 - index) * 3600000).toISOString() });
    }
  }
  env.clock(NOW);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => { const s = window.FamilySaas?.status(); return s && (s.ready || s.view === 'families'); });
  if ((await Q.status(page)).view === 'families') await Q.click(page, Q.sa('select-family', familyId));
  await Q.ready(page, familyId); await Q.home(page); await Q.B.homeView(page, 'points');
  await page.evaluate(async () => { if (document.fonts) await document.fonts.ready; document.querySelector('.app-main').scrollTop = 0; });
  await Q.B.delay(160);
  const state = await Q.snapshot(page), totals = Q.M.totals(state);
  const summary = H.analyze({ state, now: new Date(NOW), zone: 'Asia/Shanghai' });
  const expected = lightFamily ? { total: 14, spent: familyPreset === 'mixed' ? 5 : 0, today: 1, count: 1, history: 4 } : { total: 13, spent: 0, today: 8, count: 4, history: 9 };
  expected.available = expected.total - expected.spent;
  assert.deepEqual(totals, { earned: expected.total, spent: expected.spent, available: expected.available });
  assert.equal(summary.todayEarned, expected.today); assert.equal(summary.todayCount, expected.count); assert.equal(state.points.length, expected.history);
  report.fixture = { childName: state.childName, totals, todayEarned: summary.todayEarned, todayCount: summary.todayCount, historyCount: state.points.length };
  if (lightFamily) {
    report.fixture.shortcuts = state.pointItems.filter(item => item.enabled).map(({ name, points }) => ({ name, points }));
    report.fixture.records = state.points.map(({ name, points, at, reason }) => ({ name, points, at, reason }));
    report.fixture.sevenDays = summary.days.map(({ points, count }) => ({ points, count }));
    assert.deepEqual(report.fixture.shortcuts, [{ name: '独立阅读', points: 5 }]);
    assert.deepEqual(report.fixture.records.map(({ name, points }) => [name, points]), [['独立阅读', 5], ['整理书包', 3], ['认真写作业', 5], ['好好吃饭', 1]]);
    if (familyPreset === 'sparse') assert.deepEqual(summary.recent.map(({ name, points }) => [name, points]), [['好好吃饭', 1], ['认真写作业', 5], ['整理书包', 3]], 'The three recent rows match the supplied sparse family');
    else {
      report.fixture.spending = { redemptions: state.redemptions, purchases: state.petPurchases };
      assert.deepEqual(summary.recent.map(({ kind, points }) => [kind, points]), [['redemption', 2], ['points', 1], ['purchase', 3]], 'Mixed recent rows retain real redemption, award and purchase order');
    }
    assert.deepEqual(summary.days.map(day => day.points), [0, 0, 0, 5, 0, 8, 1], 'Seven-day chart uses the actual sparse ledger');
    assert.equal(summary.earned, 14); assert.equal(summary.count, 4);
  }
  assert.equal(await page.$eval('[data-testid="earned-points"]', node => Number(node.textContent)), expected.total);
  assert.equal(await page.$eval('[data-testid="available-points"]', node => Number(node.textContent)), expected.available);
  const before = (await env.database.query('SELECT revision,state FROM saas_families WHERE id=$1', [familyId])).rows[0];
  const marker = env.calls.length;
  report.initial = await measurements(page); progress('Measured initial viewport');
  await screenshot(page, 'home-initial');
  await recentScreenshot(page);
  await verifyRecentRecords(page, summary, session);
  if (acceptance === 'final') await verifyHomePresentation(session);
  assert.equal(report.initial.horizontalOverflow, false, 'No horizontal overflow');
  for (const action of acceptance === 'final' ? ['add-points', 'jump-rewards', 'preferences', 'home-view', 'profile-edit', 'nav', 'assistant-open'] : []) {
    const targets = report.initial.controls.filter(node => node.action === action);
    assert.ok(targets.length, 'Required control exists: ' + action);
    for (const target of targets) assert.ok(target.inViewport && target.reachable && target.width >= 47.9 && target.height >= 47.9,
      'Initial control is reachable with a 48px target: ' + JSON.stringify(target));
  }
  await page.$eval('.app-main', node => { node.scrollTop = node.scrollHeight; }); await Q.B.delay(80);
  report.bottom = await measurements(page); await screenshot(page, 'home-bottom');
  assert.equal(report.bottom.chartLabels.length, 7, 'Seven daily chart labels are rendered');
  for (const label of report.bottom.chartLabels) assert.ok(label.height <= parseFloat(label.lineHeight) + 1,
    'Daily chart label stays on one line: ' + JSON.stringify(label));
  if (acceptance === 'final') {
    await verifyHomeContent(page, summary, state.pointItems.filter(item => item.enabled));
    await verifyHomeEntryRoutes(page, state);
  }
  await verifyCameraProfile(page);
  assert.deepEqual((await env.database.query('SELECT revision,state FROM saas_families WHERE id=$1', [familyId])).rows[0], before, 'Capture, scrolling and cancelled profile preserve stored state');
  assert.deepEqual(env.calls.slice(marker).filter(call => !['GET', 'HEAD'].includes(call.method)), [], 'No API mutation during capture or cancelled profile');
  assert.deepEqual(Q.report.pageErrors, [], 'No uncaught browser errors');
  report.checks.push('Synthetic ' + familyPreset + ' ledger ' + expected.total + ' earned / ' + expected.spent + ' spent / ' + expected.available + ' available; today ' + expected.today + ' points / ' + expected.count + ' awards; ' + expected.history + ' historical award rows',
    'No horizontal overflow', 'Seven chart labels each stay on one line', 'Capture, scroll and cancelled profile preserve database and make no mutations', 'No browser page errors');
  if (acceptance === 'final') report.checks.push('Primary actions and view switch reachable initially with 48px targets');
  else report.checks.push('Baseline capture leaves final presentation and initial-target acceptance gates unrun');
  report.finalSourceHashes = sourceHashes();
  report.sourceStable = JSON.stringify(report.sourceHashes) === JSON.stringify(report.finalSourceHashes);
  assert.ok(report.sourceStable, 'Measured source files changed during capture');
  if (args.compare) {
    const previousFile = path.resolve(ROOT, args.compare);
    const previous = JSON.parse(fs.readFileSync(previousFile, 'utf8'));
    assert.equal(previous.status, 'passed', 'Comparison baseline must have passed');
    assert.equal(previous.familyPreset || 'dense', familyPreset, 'Comparison must use the same family preset');
    assert.deepEqual(previous.viewport, report.viewport, 'Comparison must use the same CSS viewport');
    assert.deepEqual(previous.fixture, report.fixture, 'Comparison must use the same synthetic family fixture');
    report.comparison = { previous: previousFile,
      walletHeight: { before: previous.initial.regions.wallet.height, after: report.initial.regions.wallet.height },
      recentTop: { before: previous.initial.regions.recent.y, after: report.initial.regions.recent.y },
      fullyVisibleRecentRows: { before: previous.initial.fullyVisibleRecentRows, after: report.initial.fullyVisibleRecentRows },
      scrollRange: { before: previous.initial.main.scrollRange, after: report.initial.main.scrollRange },
      totalFontSize: { before: previous.initial.regions.total?.fontSize ?? null, after: report.initial.regions.total?.fontSize ?? null } };
    await comparisonImage(page.browser(), previousFile);
    await recentComparisonImage(page.browser(), previousFile);
  }
  progress('Capture checks passed');
}
persist();
Q.execute(() => Q.check('Synthetic points home capture and layout', scenario)).then(() => {
  report.status = Q.report.result; report.finishedAt = new Date().toISOString(); report.errors = Q.report.failed;
  report.fixtureReport = path.join(Q.OUT, 'report.json'); persist();
  progress('Finished: ' + report.status + '; results: ' + path.join(out, 'results.json'));
}).catch(error => { report.status = 'failed'; report.error = error.stack; persist(); fs.appendFileSync(logfile, error.stack + '\n'); console.error(error); process.exitCode = 1; });
