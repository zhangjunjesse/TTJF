'use strict';

// Run one bounded group per process with AWARD_PHOTO_CASE. Every group uses
// synthetic files, a new verified account, real HTTP and temporary SQLite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Q = require('./saas-browser.cjs');
const { B, PIN, action: a, click, snapshot, ui } = Q;
const CASE = process.env.AWARD_PHOTO_CASE || 'custom';
const CASES = ['custom', 'preset', 'retry', 'skip', 'scope', 'picker-return', 'preset-return', 'overlap', 'expired', 'retake', 'discard-race', 'resume-committed', 'resume-uncommitted', 'resume-late', 'resume-midnight', 'resume-chooser', 'resume-avatar', 'controls', 'detail'];
assert.ok(CASES.includes(CASE), 'Unknown AWARD_PHOTO_CASE');
const WIDTH = Number(process.env.AWARD_PHOTO_WIDTH || 390);
const HEIGHT = Number(process.env.AWARD_PHOTO_HEIGHT || 844);
const CHILD = '合成照片宝';
const CUSTOM = '独立完成合成作业';
const COMMON = '合成作业常用行为';
const PREVIEW = a('award-photo-preview');
const HISTORY = a('award-photo-history');
const VIEWER = '[data-award-photo-viewer]';
const DETAIL = '.sheet[data-form-kind="recordDetail"]';
const COUNT = '.award-photo-editor [data-photo-count]';
const SOURCES = ['test/award-photos-browser.cjs', 'test/saas-browser.cjs', 'test/browser.cjs',
  'award-photos.js', 'award-photos.css', 'app.js', 'home-points.js', 'home-points.css', 'index.html', 'model.js', 'saas-client.js', 'saas-server.cjs',
  'saas/business.cjs', 'saas/award-photos.cjs', 'saas/migrations/005-award-photos.sql'];
const hashes = () => Object.fromEntries(SOURCES.map(file => [file,
  crypto.createHash('sha256').update(fs.readFileSync(path.join(Q.ROOT, file))).digest('hex')]));
const report = Q.report.awardPhotos = { case: CASE, viewport: { width: WIDTH, height: HEIGHT }, sourceHashes: hashes(), uploads: [] };
Q.report.command = 'AWARD_PHOTO_CASE=' + CASE + ' node test/award-photos-browser.cjs';
Q.report.nodeCommand = 'node test/award-photos-browser.cjs';
Q.report.boundaries = [
  'One selected award-photo group; unselected groups are not claimed as passed.',
  'Real headless Chromium, native file-input chooser, loopback SaaS HTTP and a temporary SQLite file; synthetic homework images only.',
  'Camera-button coverage opens the native file input with rear-camera capture intent. The picker-return group dispatches synthetic visibility events; a physical camera, OS image picker and iPad/Safari are not verified.',
  'Upload-failure groups inject one identity-free 502 HTML response or drop the response after the real service accepted an upload. All completed scoring requests use the real service.',
  'The overlap group delays the first real upload until a second native chooser is open. The expired group injects PHOTO_UNAVAILABLE for only its first challenge after a real staged upload.',
  'The resume-committed group holds a real successful action callback across synthetic hide/show. The resume-uncommitted group aborts its first action before it reaches the real service, then requires explicit review and a fresh PIN before retry.',
  'The resume-late group forwards the unchanged original action body and grant to real HTTP after the first resumed snapshot. Credentials remain only in test memory; no service response or ledger snapshot is fabricated.',
  'The resume-midnight group advances the injected Shanghai clock across midnight, interrupts both the old-day submit and a corrected new-day submit, then verifies fresh authorization, exact saved time and real-service replay behavior.',
  'The resume-chooser group forwards an old authorized award while an edited draft has a native chooser open, accepts the new file while hidden, then verifies both distinct records and photo attachments in SQLite.',
  'The resume-avatar group uses the same synthetic PNG with and without a late award receipt, then explicitly saves the returned avatar with a fresh PIN and verifies SQLite plus reload. Existing family and session boundaries still apply.',
  'The controls and detail groups emulate a mobile touch viewport and use hit-tested Chromium touch taps. Their screenshots contain synthetic workbook pages; actual phone touch hardware, OS image pickers and Safari remain outside this check.',
  'No production service, external SMTP, AI image provider or live family data is used.'
];
for (const name of CASES.filter(name => name !== CASE)) Q.report.skipped.push('AWARD_PHOTO_CASE=' + name + ' not selected');
let env, page, familyId, files, sequence = 0, viewerSequence = 0;
const uploads = [];
const awardRequests = { challenges: [], verifications: [], actions: [] };

function progress(message) {
  fs.mkdirSync(Q.OUT, { recursive: true });
  fs.writeFileSync(path.join(Q.OUT, 'award-photos-progress.json'), JSON.stringify({
    at: new Date().toISOString(), case: CASE, message, checks: Q.report.checks, awardPhotos: report
  }, null, 2) + '\n');
}
async function check(label, work) {
  progress(label); await Q.check(label, work); progress('Completed: ' + label);
}
async function sql(id = familyId) {
  return (await env.database.query('SELECT revision,state FROM saas_families WHERE id=$1', [id])).rows[0];
}
async function storedPhotos(pending, committed = []) {
  const expected = { pending: [...pending].sort(), committed: [...committed].sort() };
  const until = Date.now() + 5000;
  let actual;
  do {
    const { rows } = await env.database.query('SELECT id,action_id FROM saas_award_photos WHERE family_id=$1 ORDER BY id', [familyId]);
    actual = { pending: rows.filter(row => !row.action_id).map(row => row.id), committed: rows.filter(row => row.action_id).map(row => row.id) };
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    await B.delay(40);
  } while (Date.now() < until);
  assert.deepEqual(actual, expected, 'SQLite contains exactly the selected and committed photos');
}
async function fixtureAction(input, protectedAction = true) {
  const response = await env.api(page, '/api/state');
  assert.equal(response.status, 200);
  const action = { ...input, id: 'award-photo-fixture-' + (++sequence) };
  let grant;
  if (protectedAction) {
    const challenge = await env.api(page, '/api/parent/challenge', 'POST', { revision: response.body.revision, action });
    assert.equal(challenge.status, 200, JSON.stringify(challenge.body));
    const verified = await env.api(page, '/api/parent/verify', 'POST', { challengeId: challenge.body.challengeId, answer: PIN });
    assert.equal(verified.status, 200, JSON.stringify(verified.body)); grant = verified.body.grant;
  }
  const result = await env.api(page, '/api/action', 'POST', { revision: response.body.revision, action, grant });
  assert.equal(result.status, 200, JSON.stringify(result.body));
}
async function reload() {
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => { const s = window.FamilySaas?.status(); return s && (s.ready || s.view === 'families'); });
  if ((await Q.status(page)).view === 'families') await click(page, Q.sa('select-family', familyId));
  await Q.ready(page, familyId); await Q.home(page); await B.homeView(page, 'points');
}
async function setup() {
  Q.phase('award-photos-' + CASE); progress('Creating an isolated real SaaS fixture');
  env = await Q.initialize(); env.clock(Date.parse('2026-11-25T04:30:00Z'));
  page = await env.newPage({ controlledClock: true, width: WIDTH, height: HEIGHT }); Q.active(page);
  if (['controls', 'detail'].includes(CASE)) {
    // Changing touch/mobile emulation reloads the page. Give the shared storage
    // instrumentation a real origin before that reload instead of about:blank.
    await page.goto(env.origin, { waitUntil: 'load' });
    await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  }
  page.setDefaultTimeout(6000);
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    const route = new URL(request.url()).pathname;
    if (!['/api/award-photos', '/api/parent/challenge', '/api/parent/verify', '/api/action'].includes(route)) return;
    const body = JSON.parse(request.postData() || '{}');
    if (route === '/api/award-photos') uploads.push(body);
    if (route === '/api/parent/challenge' && body.action?.type === 'points.add') awardRequests.challenges.push(body);
    if (route === '/api/parent/verify') awardRequests.verifications.push(body);
    if (route === '/api/action' && body.action?.type === 'points.add') awardRequests.actions.push(body);
  });
  await Q.registerAndVerify(page, 'award-photo-' + CASE + '-' + Q.RUN + '@example.test');
  familyId = await Q.createFamily(page, '合成照片家庭-' + CASE, CHILD);
  await fixtureAction({ type: 'parent.setup', method: 'pin', pin: PIN, confirmPin: PIN }, false);
  await fixtureAction({ type: 'pointItem.save', item: { id: 'photo-common', name: COMMON, points: 5, reason: '', enabled: true } });
  await reload();
  const images = await page.evaluate(() => {
    function image(type, color, title) {
      const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 1200;
      const g = canvas.getContext('2d'); g.fillStyle = '#fffdf6'; g.fillRect(0, 0, 900, 1200);
      g.strokeStyle = color; g.lineWidth = 3;
      for (let y = 180; y < 1160; y += 70) { g.beginPath(); g.moveTo(55, y); g.lineTo(845, y); g.stroke(); }
      g.fillStyle = color; g.font = '52px sans-serif'; g.fillText(title, 60, 110);
      g.font = '34px sans-serif'; g.fillText('Synthetic homework / 2 + 3 = 5', 65, 235);
      return canvas.toDataURL(type, 0.88);
    }
    return { png: image('image/png', '#245eab', 'SYNTHETIC PAGE ONE'), jpeg: image('image/jpeg', '#a54434', 'SYNTHETIC PAGE TWO'),
      third: image('image/jpeg', '#306b4b', 'SYNTHETIC PAGE THREE') };
  });
  files = { png: path.join(Q.OUT, 'synthetic-homework.png'), jpeg: path.join(Q.OUT, 'synthetic-homework.jpg'), third: path.join(Q.OUT, 'synthetic-homework-three.jpg') };
  for (const [kind, file] of Object.entries(files)) fs.writeFileSync(file, Buffer.from(images[kind].split(',')[1], 'base64'));
  progress('Fixture and synthetic PNG/JPEG files ready');
}
async function openCustom(name = CUSTOM) {
  await click(page, a('add-points')); await click(page, a('points-new'));
  await B.fillForm(page, { name, points: 7, reason: '自己完成并核对两页练习' });
}
async function thumbnails(selector, count) {
  await page.waitForFunction((target, expected) => {
    const images = [...document.querySelectorAll(target + ' img')];
    return images.length === expected && images.every(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > image.naturalWidth);
  }, { timeout: 6000 }, selector, count);
}
async function mobileShot(name) {
  const label = 'mobile-' + WIDTH + '-' + name;
  await Q.shot(page, label);
  if (!process.env.AWARD_PHOTO_SCREENSHOT_DIR) return;
  const directory = path.resolve(process.env.AWARD_PHOTO_SCREENSHOT_DIR);
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, label + '.png');
  fs.copyFileSync(path.join(Q.OUT, label + '.png'), target);
  (report.reviewScreenshots || (report.reviewScreenshots = [])).push(target);
}
async function tap(selector, edge = false) {
  if (await Q.visible(page, '.ledger-award-dialog ' + selector)) selector = '.ledger-award-dialog ' + selector;
  await page.waitForSelector(selector, { visible: true });
  const handles = await page.$$(selector);
  let target;
  try {
    for (const handle of handles) {
      target = await handle.evaluate((node, rightEdge) => {
        const initial = node.getBoundingClientRect();
        if (!initial.width || !initial.height || getComputedStyle(node).visibility === 'hidden') return null;
        node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        const r = node.getBoundingClientRect(), x = rightEdge ? r.right - 12 : r.left + r.width / 2, y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return hit && (hit === node || node.contains(hit)) ? { x, y, width: r.width, height: r.height, disabled: !!node.disabled } : null;
      }, edge);
      if (target) break;
    }
    assert.ok(target, selector + ' must be reachable by a real touchscreen tap');
    assert.equal(target.disabled, false, selector + ' is enabled');
    assert.ok(target.width >= 44 && target.height >= 44, selector + ' has a 44px touch target: ' + JSON.stringify(target));
    await page.touchscreen.tap(target.x, target.y); await B.delay(120);
    (report.touchTargets || (report.touchTargets = [])).push({ selector, width: target.width, height: target.height, rightEdge: edge });
  } finally { for (const handle of handles) await handle.dispose(); }
}
async function selectedCount(count) {
  await page.waitForFunction((selector, expected) => {
    const nodes = [...document.querySelectorAll(selector)].filter(node => node.getBoundingClientRect().height);
    return nodes.length && nodes.every(node => Number(node.dataset.count) === expected && node.textContent.trim() === expected + ' / 3');
  }, { timeout: 6000 }, COUNT, count);
}
function uploadResponse() {
  return page.waitForResponse(response => new URL(response.url()).pathname === '/api/award-photos' &&
    response.request().method() === 'POST', { timeout: 6000 }).then(response => ({ response }), error => ({ error }));
}
async function uploaded(received, marker, input) {
  const outcome = await received;
  if (outcome.error) throw outcome.error;
  assert.equal(outcome.response.status(), 200, await outcome.response.text());
  const result = await outcome.response.json();
  assert.equal(typeof result.photoId, 'string'); assert.ok(result.photoId.length > 0);
  const sent = uploads.slice(marker);
  assert.equal(sent.length, 1, 'one selected file sends one upload');
  assert.match(sent[0].dataUrl, /^data:image\/jpeg;base64,/, 'the browser converts the selected photo to JPEG before upload');
  const size = await page.evaluate(dataUrl => new Promise((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error('Uploaded JPEG cannot be decoded')); image.src = dataUrl;
  }), sent[0].dataUrl);
  assert.ok(Math.abs(size.width / size.height - 0.75) < 0.02, 'workbook page keeps its portrait proportions');
  report.uploads.push({ input, output: 'image/jpeg', photoId: result.photoId, bytes: Buffer.from(sent[0].dataUrl.split(',')[1], 'base64').length, ...size });
  return result.photoId;
}
async function openChooser(mode, touch = false) {
  const input = '[data-award-photo-input="' + mode + '"]';
  assert.equal(await page.$eval(input, node => node.type), 'file');
  if (mode === 'camera') assert.equal(await page.$eval(input, node => node.getAttribute('capture')), 'environment');
  const chooser = page.waitForFileChooser({ timeout: 6000 });
  if (touch) await tap(a('award-photo-' + mode));
  else await click(page, a('award-photo-' + mode));
  return chooser;
}
async function pick(mode, file, count, fail = false, touch = false) {
  const selected = await openChooser(mode, touch), marker = uploads.length, received = fail ? null : uploadResponse();
  await selected.accept([file]);
  if (fail) { await page.waitForSelector(a('award-photo-retry'), { visible: true }); return; }
  const id = await uploaded(received, marker, path.extname(file));
  await thumbnails(PREVIEW, count); return id;
}
async function viewer(selector, multiple = false) {
  await click(page, selector); await page.waitForSelector(VIEWER, { visible: true });
  assert.equal(await page.$eval(VIEWER, node => node.tagName === 'DIALOG' && node.open), true);
  await page.waitForFunction(target => { const image = document.querySelector(target + ' img'); return image && image.complete && image.naturalWidth > 0; }, {}, VIEWER);
  if (multiple) {
    const first = await page.$eval(VIEWER + ' img', node => node.src);
    await click(page, VIEWER + ' [data-photo-next]');
    await page.waitForFunction((target, original) => {
      const image = document.querySelector(target + ' img'); return image && image.src !== original && image.complete && image.naturalWidth > 0;
    }, {}, VIEWER, first);
    await click(page, VIEWER + ' [data-photo-prev]');
    await page.waitForFunction((target, original) => {
      const image = document.querySelector(target + ' img'); return image && image.src === original && image.complete && image.naturalWidth > 0;
    }, {}, VIEWER, first);
  }
  await Q.shot(page, 'photo-viewer-' + CASE + '-' + (++viewerSequence));
  await click(page, VIEWER + ' [data-photo-close]'); await page.waitForSelector(VIEWER, { hidden: true });
}
async function commit(before, ids, direct = false, trusted = false) {
  if (!direct) await click(page, Q.save);
  await page.waitForFunction(() => window.FamilyDemo.getUI().authPhase === 'confirm');
  await thumbnails(PREVIEW, ids.length);
  assert.deepEqual(await sql(), before, 'selecting photos and reviewing never commits a score');
  const marker = env.calls.length;
  await click(page, a('points-confirm'));
  if (!trusted) {
    await page.waitForSelector('#parent-form [name="answer"]');
    await B.fill(page, '#parent-form [name="answer"]', PIN); await click(page, Q.parentSubmit);
  }
  await page.waitForFunction(() => { const current = window.FamilyDemo.getUI(); return !current.auth && !current.pending; });
  const after = await sql(), row = after.state.points.at(-1);
  assert.equal(after.state.points.length, before.state.points.length + 1);
  assert.deepEqual(row.photoIds || [], ids);
  assert.equal(new Set(row.photoIds || []).size, ids.length);
  assert.doesNotMatch(JSON.stringify(after.state), /data:image\/(?:jpeg|png);base64,/, 'the shared ledger stores references rather than image bytes');
  const writes = env.calls.slice(marker).filter(call => call.path === '/api/action' && call.action?.type === 'points.add');
  assert.equal(writes.length, 1); assert.equal(writes[0].action.hasGrant, !trusted);
  if (trusted) assert.equal(env.calls.slice(marker).some(call => call.path === '/api/parent/challenge'), false);
  assert.deepEqual(await snapshot(page), after.state); return row;
}
async function history(count, name = CUSTOM) {
  await Q.home(page); await click(page, a('records'));
  assert.match(await page.$eval('.record-list', node => node.textContent), new RegExp(name));
  const row = (await snapshot(page)).points.filter(record => record.name === name).at(-1);
  assert.ok(row, 'the named award exists in the real family ledger');
  await click(page, '.record-list ' + a('record-detail', 'points:' + row.id));
  await page.waitForSelector(DETAIL, { visible: true });
  await page.waitForSelector(HISTORY, { visible: true });
  const saved = await page.$$eval(DETAIL + ' ' + HISTORY, nodes => nodes.map(node => ({
    ids: node.dataset.id.split(','), index: Number(node.dataset.photoIndex), photoId: node.dataset.photoId
  })));
  assert.equal(saved.length, count, 'saved photos are individual thumbnails inside the record detail');
  assert.deepEqual(saved.map(photo => photo.index), Array.from({ length: count }, (_, index) => index));
  assert.deepEqual(saved.map(photo => photo.photoId), row.photoIds);
  for (const photo of saved) assert.deepEqual(photo.ids, row.photoIds);
  await thumbnails(DETAIL + ' ' + HISTORY, count);
}
async function custom() {
  await check('Custom scoring keeps PNG/JPEG page previews, removal and full-size navigation before one authorized write', async () => {
    const before = await sql(); await openCustom();
    await pick('album', files.png, 1);
    const first = await pick('camera', files.jpeg, 2);
    await withProxyFailure(async () => {
      await click(page, a('award-photo-remove'));
      await thumbnails(PREVIEW, 1);
      await storedPhotos([first]);
      assert.equal((await Q.status(page)).ready, true);
    }, '/api/award-photos/discard');
    const second = await pick('album', files.png, 2);
    await viewer(PREVIEW, true); await Q.shot(page, 'custom-photo-draft');
    const row = await commit(before, [first, second]);
    assert.equal(row.name, CUSTOM); assert.equal(row.points, 7);
    await storedPhotos([], [first, second]);
  });
  await check('Saved photo entries and full-size pages survive reload in point history', async () => {
    const before = await sql(); await reload(); await history(2); await viewer(HISTORY, true);
    assert.deepEqual(await sql(), before, 'opening saved photos does not alter the ledger');
    await Q.shot(page, 'saved-photo-history');
  });
}
async function preset() {
  await check('A quick common-behavior review accepts a camera photo and leaves the template unchanged', async () => {
    const before = await sql(); await click(page, a('choose-point', 'photo-common'));
    assert.equal((await ui(page)).authPhase, 'confirm', 'the common behavior opens its direct review');
    const id = await pick('camera', files.jpeg, 1); await Q.shot(page, 'quick-preset-photo');
    const row = await commit(before, [id], true);
    assert.equal(row.itemId, 'photo-common'); assert.equal(row.name, COMMON); assert.equal(row.points, 5);
    assert.deepEqual((await sql()).state.pointItems, before.state.pointItems, 'record photos never become template photos');
    await Q.home(page); await click(page, a('choose-point', 'photo-common'));
    assert.equal(await page.$(PREVIEW), null, 'the next quick award has no photos from the previous award');
    await Q.home(page); await history(1, COMMON); await viewer(HISTORY);
  });
}
async function withProxyFailure(work, route = '/api/award-photos') {
  let fail = true, aborted = 0;
  await page.setRequestInterception(true);
  const intercept = request => {
    if (fail && request.method() === 'POST' && new URL(request.url()).pathname === route) {
      fail = false; aborted++;
      void request.respond({ status: 502, contentType: 'text/html', body: '<!doctype html><title>Bad Gateway</title><h1>502 Bad Gateway</h1>' });
      (report.injectedFailures ||= []).push({ route, fault: 'proxy', status: 502, contentType: 'text/html', identityAbsent: true });
    } else void request.continue();
  };
  page.on('request', intercept);
  try { await work(); assert.equal(aborted, 1, 'the selected photo request actually failed'); }
  finally { page.off('request', intercept); await page.setRequestInterception(false); }
}
async function retry() {
  await check('A 502 HTML proxy response preserves the photo draft and explicit retry saves one photo with one score', async () => {
    const before = await sql(); await openCustom();
    await withProxyFailure(async () => {
      await pick('album', files.png, 1, true); assert.deepEqual(await sql(), before);
      const status = await Q.status(page);
      assert.equal(status.ready, true, 'an identity-free proxy error does not sign the parent out');
      assert.equal(status.familyId, familyId);
      assert.equal(await page.$eval('#editor-form [name="name"]', node => node.value), CUSTOM);
      assert.equal(await page.$eval('#editor-form [name="reason"]', node => node.value), '自己完成并核对两页练习');
      assert.ok(await Q.visible(page, a('award-photo-skip')), 'a failed attachment offers the only-score path');
      await Q.shot(page, 'photo-upload-failed-retry');
      const marker = uploads.length, received = uploadResponse(); await click(page, a('award-photo-retry'));
      const id = await uploaded(received, marker, '.png retry');
      await thumbnails(PREVIEW, 1); await page.waitForSelector(a('award-photo-retry'), { hidden: true });
      await commit(before, [id]);
    });
    await history(1); await viewer(HISTORY);
  });
}
async function skip() {
  await check('After an upload failure, only-score explicitly removes the photo and still requires parent verification', async () => {
    const before = await sql(); await openCustom();
    await pick('album', files.jpeg, 1);
    const cdp = await page.createCDPSession();
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/award-photos', requestStage: 'Response' }] });
    cdp.once('Fetch.requestPaused', event => {
      report.lostUploadStatus = event.responseStatusCode;
      void cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' });
    });
    try {
      await pick('album', files.png, 2, true); assert.deepEqual(await sql(), before);
      assert.equal(report.lostUploadStatus, 200, 'the server stored the JPEG before the upload response was lost');
      await click(page, a('award-photo-skip'));
      await page.waitForSelector(PREVIEW, { hidden: true }); await page.waitForSelector(a('award-photo-retry'), { hidden: true });
      const row = await commit(before, []); assert.equal(row.points, 7);
      await storedPhotos([]);
    } finally { await cdp.detach(); }
    await Q.home(page); await click(page, a('records'));
    assert.equal(await page.$(HISTORY), null, 'the score-only record has no broken photo thumbnail');
    await Q.shot(page, 'photo-failure-only-score-history');
  });
}
async function scope() {
  await check('Changing families clears old photo UI and only the original family can reopen its saved photo', async () => {
    const before = await sql(); await openCustom();
    const id = await pick('album', files.png, 1); await commit(before, [id]);
    await history(1); await viewer(HISTORY);
    const original = await sql();
    const other = await Q.createFamily(page, '合成无照片家庭', '合成另一宝');
    assert.notEqual(other, familyId); assert.deepEqual((await snapshot(page)).points, []);
    assert.equal(await page.$('[data-award-photo-viewer] img[src^="data:image/"]'), null, 'no previous-family image remains in the viewer');
    const denied = await env.api(page, '/api/award-photos/read', 'POST', { photoId: id }, other);
    assert.ok([403, 404].includes(denied.status), 'another family cannot read the known photo ID');
    await click(page, a('records')); assert.equal(await page.$(HISTORY), null);
    await Q.home(page); await openCustom('另一家庭的新行为'); assert.equal(await page.$(PREVIEW), null);
    await Q.home(page); await Q.switchFamily(page, familyId); await history(1); await viewer(HISTORY);
    assert.deepEqual(await sql(), original, 'family switching and viewing preserve the original ledger');
    await Q.shot(page, 'original-family-photo-restored');
  });
}
async function visibility(hidden) {
  await page.evaluate(value => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value ? 'hidden' : 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}
async function parentReview() {
  await click(page, Q.save);
  await page.waitForFunction(() => window.FamilyDemo.getUI().authPhase === 'confirm');
  await click(page, a('points-confirm'));
  await page.waitForSelector('#parent-form [name="answer"]', { visible: true });
  assert.equal(await page.$eval('#parent-form [name="answer"]', node => node.value), '', 'each parent verification starts with an empty PIN');
}
async function hideAward() {
  await visibility(true); await page.waitForFunction(() => !window.FamilySaas.status().ready);
  assert.equal(await snapshot(page), null, 'the hidden page masks family state');
  assert.doesNotMatch(await page.$eval('body', node => node.textContent), new RegExp(CUSTOM));
}
async function resumeAward() { await visibility(false); await Q.ready(page, familyId); }
async function loseUncommittedAction(before) {
  let held;
  const marker = awardRequests.actions.length;
  const intercept = request => {
    if (!held && request.method() === 'POST' && new URL(request.url()).pathname === '/api/action') held = request;
    else void request.continue();
  };
  await page.setRequestInterception(true); page.on('request', intercept);
  try {
    const sent = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/action');
    await B.fill(page, '#parent-form [name="answer"]', PIN); await click(page, Q.parentSubmit); await sent;
    assert.ok(held, 'the actual browser action is held before the real service');
    assert.equal(awardRequests.actions.length, marker + 1); assert.ok(awardRequests.actions[marker].grant);
    assert.deepEqual(await sql(), before, 'the first action has not reached SQLite');
    await hideAward(); await held.abort('aborted').catch(() => {});
  } finally { page.off('request', intercept); await page.setRequestInterception(false); }
  return awardRequests.actions[marker];
}
async function noStoredAward(actionId, photoId) {
  const values = await page.evaluate(() => {
    const legacy = new Set(['little-steps-demo-v1', 'little-steps-drafts-v03', 'little-steps-parent-private-v03']);
    return [localStorage, sessionStorage].flatMap(storage => Object.keys(storage).filter(key => !legacy.has(key)).map(key => storage.getItem(key)));
  });
  const stored = JSON.stringify(values);
  for (const value of [actionId, photoId, CUSTOM, PIN]) assert.equal(stored.includes(value), false, 'business data and PIN stay out of browser storage');
  assert.equal((await page.evaluate(() => window.__qaStorage.inspect())).unchanged, true, 'the poisoned legacy business stores stay untouched');
}
async function resumeCommitted() {
  await check('A committed photo award with a lost response resumes as success once and clears its old draft', async () => {
    const before = await sql(); await openCustom();
    const id = await pick('album', files.png, 1); await parentReview();
    await page.evaluate(() => window.__qaTransport.arm({ path: '/api/action', status: 200, method: 'POST' }));
    await B.fill(page, '#parent-form [name="answer"]', PIN); await click(page, Q.parentSubmit);
    await page.waitForFunction(() => window.__qaTransport.pending().length === 1);
    assert.equal(awardRequests.actions.length, 1);
    const actionId = awardRequests.actions[0].action.id, persisted = await sql();
    assert.equal(persisted.revision, before.revision + 1);
    assert.equal(persisted.state.points.length, before.state.points.length + 1);
    assert.equal(persisted.state.points.at(-1).id, 'points-' + actionId);
    assert.deepEqual(persisted.state.points.at(-1).photoIds, [id]);
    await hideAward(); await resumeAward();
    const current = await ui(page);
    report.resume = { committedBeforeHide: true, actionId, photoId: id, restoredForm: current.form };
    progress('Inspecting the authoritative committed award after resume');
    assert.equal(current.form, null, 'a committed photo award never reopens its completed form');
    assert.equal(current.auth, false); assert.equal(current.pending, false);
    assert.ok(await Q.visible(page, '#toast.points-receipt'), 'resume shows the normal visible success receipt');
    assert.match(await page.$eval('#toast.points-receipt', node => node.textContent), new RegExp('已记好：' + CUSTOM + ' \\+7 分'));
    assert.equal(await page.$(PREVIEW), null, 'committed staged IDs no longer appear as draft thumbnails');
    assert.equal(await page.$('#parent-form [name="answer"]'), null);
    assert.deepEqual(await snapshot(page), persisted.state); await storedPhotos([], [id]);
    assert.equal(awardRequests.challenges.length, 1); assert.equal(awardRequests.actions.length, 1, 'resuming never resubmits the completed award');
    await Q.shot(page, 'committed-photo-resumed-success');
    await page.evaluate(() => window.__qaTransport.release()); await B.delay(120);
    assert.deepEqual(await sql(), persisted, 'the late original response cannot repeat the commit');
    assert.equal((await ui(page)).form, null);
    await click(page, a('add-points')); await click(page, a('points-new'));
    assert.equal(await page.$eval('#editor-form [name="name"]', node => node.value), '', 'the completed name is removed from the next new draft');
    assert.equal(await page.$eval('#editor-form [name="reason"]', node => node.value), '', 'the completed reason is removed from the next new draft');
    assert.equal(await page.$(PREVIEW), null, 'the next award has no old staged photo reference');
    await history(1); await viewer(HISTORY); await noStoredAward(actionId, id);
    assert.deepEqual(await sql(), persisted); assert.equal(awardRequests.actions.length, 1);
  });
}
async function resumeUncommitted() {
  await check('An uncommitted photo award keeps its action ID across repeated resumes and needs a fresh explicit authorization to retry', async () => {
    const before = await sql(); await openCustom();
    const id = await pick('album', files.png, 1); await parentReview();
    const original = await loseUncommittedAction(before), actionId = original.action.id;
    for (let round = 0; round < 2; round++) {
      if (round) await hideAward();
      await resumeAward();
      assert.equal((await ui(page)).form, 'points', 'an uncommitted award retains the editable draft');
      assert.equal((await ui(page)).auth, false, 'resuming never restores parent verification authority');
      assert.equal(await page.$('#parent-form [name="answer"]'), null);
      assert.equal(await page.$eval('#editor-form [name="name"]', node => node.value), CUSTOM);
      assert.equal(await page.$eval('#editor-form [name="reason"]', node => node.value), '自己完成并核对两页练习');
      await thumbnails(PREVIEW, 1); await storedPhotos([id]);
      assert.equal(await Q.visible(page, '#toast.points-receipt'), false, 'an uncommitted award has no fabricated success');
      assert.doesNotMatch((await ui(page)).homeFeedback, /已记好|记好啦/);
      assert.deepEqual(await sql(), before, 'resuming does not record points automatically');
      assert.equal(awardRequests.actions.length, 1); assert.equal(awardRequests.challenges.length, 1);
      assert.equal(awardRequests.verifications.length, 1, 'returning never replays the old PIN');
      await noStoredAward(actionId, id);
    }
    await Q.shot(page, 'uncommitted-photo-draft-resumed');
    await parentReview();
    assert.equal(awardRequests.challenges.length, 2);
    assert.equal(awardRequests.challenges[1].action.id, actionId, 'explicit retry preserves the original operation identity');
    assert.deepEqual(awardRequests.challenges[1].action, original.action, 'retry authorizes the same award and photo references');
    assert.equal(awardRequests.actions.length, 1, 'review and challenge alone never submit the retry');
    assert.deepEqual(await sql(), before);
    await B.fill(page, '#parent-form [name="answer"]', PIN); await click(page, Q.parentSubmit);
    await page.waitForFunction(() => { const current = window.FamilyDemo.getUI(); return !current.auth && !current.pending && current.form === null; });
    assert.equal(awardRequests.verifications.length, 2);
    assert.ok(awardRequests.verifications[1].challengeId !== awardRequests.verifications[0].challengeId, 'retry verifies a new challenge');
    assert.equal(awardRequests.actions.length, 2);
    assert.equal(awardRequests.actions[1].action.id, actionId);
    assert.ok(awardRequests.actions[1].grant); assert.ok(awardRequests.actions[1].grant !== original.grant, 'retry uses fresh parent authority');
    const after = await sql();
    assert.equal(after.revision, before.revision + 1); assert.equal(after.state.points.length, before.state.points.length + 1);
    assert.equal(after.state.points.at(-1).id, 'points-' + actionId); assert.deepEqual(after.state.points.at(-1).photoIds, [id]);
    assert.deepEqual(await snapshot(page), after.state); await storedPhotos([], [id]);
    report.resume = { committedBeforeHide: false, actionId, photoId: id, hideShowCycles: 2, explicitRetry: true, freshChallenge: true, freshGrant: true };
    await history(1); await viewer(HISTORY); assert.deepEqual(await sql(), after);
  });
}
async function resumeLate() {
  await check('An original photo award arriving after an empty resume snapshot races a fresh authorized retry without duplicate scoring', async () => {
    const before = await sql(); await openCustom();
    const id = await pick('album', files.png, 1); await parentReview();
    const original = await loseUncommittedAction(before), actionId = original.action.id;
    await resumeAward(); await thumbnails(PREVIEW, 1);
    assert.equal((await ui(page)).auth, false); assert.equal(await Q.visible(page, '#toast.points-receipt'), false);
    assert.deepEqual(await sql(), before); assert.equal(awardRequests.actions.length, 1, 'resume does not write before an explicit retry');
    const probe = await env.api(page, '/api/action', 'POST', { revision: original.revision, action: original.action });
    assert.equal(probe.status, 403); assert.equal(probe.body.code, 'PARENT_REQUIRED', 'an absent receipt requires fresh parent authority');
    assert.deepEqual(await sql(), before);
    await parentReview();
    assert.equal(awardRequests.challenges.length, 2);
    assert.equal(awardRequests.challenges[1].action.id, actionId, 'the retry keeps the in-flight operation identity before the original arrives');
    assert.deepEqual(awardRequests.challenges[1].action, original.action);
    let held, released = false;
    const intercept = request => {
      if (!held && request.method() === 'POST' && new URL(request.url()).pathname === '/api/action') held = request;
      else void request.continue();
    };
    await page.setRequestInterception(true); page.on('request', intercept);
    try {
      const sent = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/action');
      await B.fill(page, '#parent-form [name="answer"]', PIN); await click(page, Q.parentSubmit); await sent;
      assert.ok(held); assert.equal(awardRequests.actions.length, 2);
      const retried = awardRequests.actions[1];
      assert.equal(retried.action.id, actionId); assert.deepEqual(retried.action, original.action);
      assert.ok(retried.grant); assert.ok(retried.grant !== original.grant, 'the explicit retry has a new grant');
      assert.ok(awardRequests.verifications[1].challengeId !== awardRequests.verifications[0].challengeId, 'the explicit retry verifies a new challenge');
      const late = await env.api(page, '/api/action', 'POST', original);
      assert.equal(late.status, 200, 'the original authorized body reaches the real service only after resume and retry review');
      assert.equal(late.body.state.points.length, before.state.points.length + 1);
      assert.equal(late.body.state.points.at(-1).id, 'points-' + actionId);
      assert.deepEqual(late.body.state.points.at(-1).photoIds, [id]);
      const replay = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/action');
      await held.continue(); released = true;
      assert.equal((await replay).status(), 200, 'the retry returns the existing receipt from the real service');
      await page.waitForFunction(() => { const current = window.FamilyDemo.getUI(); return !current.auth && !current.pending && current.form === null; });
      const after = await sql();
      assert.equal(after.revision, before.revision + 1); assert.equal(after.state.points.length, before.state.points.length + 1);
      assert.equal(after.state.points.filter(row => row.id === 'points-' + actionId).length, 1);
      assert.deepEqual(after.state.points.at(-1).photoIds, [id]); await storedPhotos([], [id]);
      assert.deepEqual(await snapshot(page), after.state); assert.ok(await Q.visible(page, '#toast.points-receipt'));
      await Q.shot(page, 'late-original-photo-award-converged');
      report.resume = { committedBeforeFirstResume: false, actionId, photoId: id, noGrantProbe: probe.body.code, lateOriginalStatus: late.status, retryStatus: 200, committedAwards: 1 };
    } finally {
      if (held && !released) await held.abort('aborted').catch(() => {});
      page.off('request', intercept); await page.setRequestInterception(false);
    }
    await history(1); await viewer(HISTORY); await noStoredAward(actionId, id);
    assert.equal((await sql()).state.points.length, before.state.points.length + 1);
  });
}
async function resumeMidnight() {
  await env.setClock(Date.parse('2026-11-25T15:58:00Z')); await reload();
  await check('An uncommitted photo award accepts a new-day time after midnight and retains that correction across another interrupted submit', async () => {
    const before = await sql(); await openCustom();
    const id = await pick('album', files.png, 1); await parentReview();
    const original = await loseUncommittedAction(before), actionId = original.action.id;
    assert.equal(original.action.at, '2026-11-25T15:58:00.000Z');
    await env.setClock(Date.parse('2026-11-25T16:02:00Z')); await resumeAward();
    assert.equal((await ui(page)).familyDay, '2026-11-26');
    assert.equal((await ui(page)).auth, false); assert.deepEqual(await sql(), before);
    await thumbnails(PREVIEW, 1); await storedPhotos([id]);
    const time = '#editor-form [name="recordTime"]', correctedAt = '2026-11-25T16:01:00.000Z';
    assert.equal(await page.$eval(time, node => node.value), '00:02', 'an uncommitted old-day default is refreshed to the current family day');
    await page.$eval(time, node => {
      node.value = '00:01'; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.equal(await page.$eval(time, node => node.checkValidity()), true, 'the edited new-day time is valid for the visible form');
    await parentReview();
    assert.equal(awardRequests.challenges.length, 2, 'editing time requires a new explicit confirmation and challenge');
    const correctedAction = { ...original.action, at: correctedAt };
    assert.deepEqual(awardRequests.challenges[1].action, correctedAction, 'the review authorizes the chosen time and original operation identity');
    assert.deepEqual(await sql(), before, 'editing and review never record points');
    const interruptedCorrection = await loseUncommittedAction(before);
    assert.deepEqual(interruptedCorrection.action, correctedAction);
    assert.notEqual(interruptedCorrection.grant, original.grant, 'the corrected submit uses fresh parent authority');
    assert.notEqual(awardRequests.verifications[1].challengeId, awardRequests.verifications[0].challengeId);
    await resumeAward(); await thumbnails(PREVIEW, 1);
    assert.equal(await page.$eval(time, node => node.value), '00:01', 'a second resume keeps the corrected time');
    assert.equal((await ui(page)).auth, false); assert.equal(await page.$('#parent-form [name="answer"]'), null);
    assert.equal(await Q.visible(page, '#toast.points-receipt'), false); assert.deepEqual(await sql(), before);
    await parentReview();
    assert.equal(awardRequests.challenges.length, 3);
    assert.deepEqual(awardRequests.challenges[2].action, correctedAction, 'the second resume never revives the rejected old-day payload');
    assert.equal(awardRequests.actions.length, 2, 'each retry still waits for an explicit fresh PIN');
    await B.fill(page, '#parent-form [name="answer"]', PIN); await click(page, Q.parentSubmit);
    await page.waitForFunction(() => { const current = window.FamilyDemo.getUI(); return !current.auth && !current.pending && current.form === null; });
    assert.equal(awardRequests.actions.length, 3); assert.equal(awardRequests.verifications.length, 3);
    assert.deepEqual(awardRequests.actions[2].action, correctedAction);
    assert.notEqual(awardRequests.actions[2].grant, interruptedCorrection.grant);
    assert.notEqual(awardRequests.verifications[2].challengeId, awardRequests.verifications[1].challengeId);
    const after = await sql(), row = after.state.points.at(-1);
    assert.equal(after.revision, before.revision + 1); assert.equal(after.state.points.length, before.state.points.length + 1);
    assert.equal(row.id, 'points-' + actionId); assert.equal(row.name, CUSTOM); assert.equal(row.points, 7);
    assert.equal(row.at, correctedAt); assert.deepEqual(row.photoIds, [id]); assert.equal(uploads.length, 1);
    await storedPhotos([], [id]); assert.deepEqual(await snapshot(page), after.state);
    assert.ok(await Q.visible(page, '#toast.points-receipt'));
    const lateOriginal = await env.api(page, '/api/action', 'POST', original);
    assert.equal(lateOriginal.status, 400); assert.equal(lateOriginal.body.code, 'ACTION_ID_REUSED', 'the old timestamp cannot replace the corrected receipt');
    const lateCorrection = await env.api(page, '/api/action', 'POST', interruptedCorrection);
    assert.equal(lateCorrection.status, 200, 'the exact corrected request replays its authoritative receipt');
    assert.deepEqual(await sql(), after, 'late requests never add a duplicate or change the chosen time');
    report.resume = { actionId, photoId: id, originalAt: original.action.at, correctedAt, hideShowCycles: 2,
      freshChallenges: 3, committedAwards: 1, lateOriginalStatus: lateOriginal.status, lateCorrectionStatus: lateCorrection.status };
    await Q.shot(page, 'midnight-photo-correction-confirmed');
    await history(1); await viewer(HISTORY); await noStoredAward(actionId, id);
    assert.deepEqual(await sql(), after);
  });
}
async function resumeChooser() {
  await check('A late old award receipt preserves a new photo selected in an edited draft and both awards commit exactly once', async () => {
    const oldName = '第一笔尚在途', newName = '第二笔正在选照片', before = await sql();
    await openCustom(oldName); const oldPhoto = await pick('album', files.png, 1); await parentReview();
    const original = await loseUncommittedAction(before), actionId = original.action.id;
    await resumeAward(); await thumbnails(PREVIEW, 1);
    await B.fillForm(page, { name: newName, reason: '为第二笔单独选择的新照片' });
    const chooser = await openChooser('album'), marker = uploads.length;
    const late = await env.api(page, '/api/action', 'POST', original);
    assert.equal(late.status, 200, 'the original authorized request commits while the next chooser remains open');
    const oldCommitted = await sql(), oldRow = oldCommitted.state.points.at(-1);
    assert.equal(oldCommitted.revision, before.revision + 1); assert.equal(oldCommitted.state.points.length, before.state.points.length + 1);
    assert.equal(oldRow.id, 'points-' + actionId); assert.equal(oldRow.name, oldName); assert.deepEqual(oldRow.photoIds, [oldPhoto]);
    await hideAward(); const received = uploadResponse();
    await chooser.accept([files.jpeg]); await resumeAward();
    const selected = await received;
    assert.ok(selected.response, 'returning from the chooser uploads the selected new image');
    const newPhoto = await uploaded(Promise.resolve(selected), marker, '.jpg selected while the old award finished');
    assert.notEqual(newPhoto, oldPhoto); await thumbnails(PREVIEW, 1);
    assert.equal(await page.$eval('#editor-form [name="name"]', node => node.value), newName);
    assert.equal(await page.$eval('#editor-form [name="reason"]', node => node.value), '为第二笔单独选择的新照片');
    assert.equal((await ui(page)).auth, false); assert.equal((await ui(page)).pending, false);
    assert.equal(await page.$('#parent-form [name="answer"]'), null);
    assert.equal(uploads.length - marker, 1, 'the new selection uploads exactly once after receipt reconciliation');
    assert.equal(awardRequests.actions.length, 1, 'a returned file never submits the edited award automatically');
    assert.equal(awardRequests.challenges.length, 1); assert.equal(awardRequests.verifications.length, 1);
    assert.deepEqual(await sql(), oldCommitted); assert.deepEqual(await snapshot(page), oldCommitted.state);
    await storedPhotos([newPhoto], [oldPhoto]); await Q.shot(page, 'late-receipt-new-photo-retained');
    await click(page, Q.save);
    if ((await ui(page)).authPhase !== 'confirm') {
      assert.match(await page.$eval('#form-error', node => node.textContent), /记录已更新 · 待确认/, 'an older draft may first require reviewing the changed ledger');
      assert.deepEqual(await sql(), oldCommitted); await click(page, Q.save);
    }
    await page.waitForFunction(() => window.FamilyDemo.getUI().authPhase === 'confirm');
    const newRow = await commit(oldCommitted, [newPhoto], true);
    assert.equal(newRow.name, newName); assert.equal(newRow.reason, '为第二笔单独选择的新照片'); assert.equal(newRow.points, 7);
    assert.notEqual(newRow.id, oldRow.id, 'the edited award has its own operation identity');
    assert.equal(awardRequests.challenges.length, 2); assert.equal(awardRequests.verifications.length, 2); assert.equal(awardRequests.actions.length, 2);
    assert.notEqual(awardRequests.actions[1].action.id, actionId); assert.notEqual(awardRequests.actions[1].grant, original.grant);
    assert.notEqual(awardRequests.verifications[1].challengeId, awardRequests.verifications[0].challengeId);
    const after = await sql();
    assert.equal(after.revision, before.revision + 2); assert.equal(after.state.points.length, before.state.points.length + 2);
    assert.deepEqual(after.state.points.find(row => row.id === oldRow.id), oldRow, 'the old record keeps only its original photo');
    assert.deepEqual(after.state.points.find(row => row.id === newRow.id).photoIds, [newPhoto]);
    await storedPhotos([], [oldPhoto, newPhoto]); assert.equal(uploads.length, 2);
    const replay = await env.api(page, '/api/action', 'POST', original);
    assert.equal(replay.status, 200); assert.deepEqual(await sql(), after, 'a repeated old receipt never repeats either award');
    report.resume = { oldActionId: actionId, newActionId: awardRequests.actions[1].action.id,
      oldPhotoId: oldPhoto, newPhotoId: newPhoto, newSelectionUploads: uploads.length - marker, committedAwards: 2 };
    await history(1, newName);
    assert.equal(await page.$eval(DETAIL + ' ' + HISTORY, node => node.dataset.photoId), newPhoto);
    await viewer(HISTORY);
    await click(page, DETAIL + ' .sheet-header ' + a('form-close'));
    await page.waitForSelector('.record-list', { visible: true });
    const visibleRows = await page.$$eval('.record-list button[data-action="record-detail"]', nodes => nodes.map(node => ({ id: node.dataset.id, text: node.textContent })));
    assert.deepEqual(visibleRows.map(row => row.id), ['points:' + newRow.id, 'points:' + oldRow.id], 'back returns to both distinct saved awards');
    assert.ok(visibleRows[0].text.includes(newName)); assert.ok(visibleRows[1].text.includes(oldName));
    await click(page, '.record-list ' + a('record-detail', 'points:' + oldRow.id));
    await page.waitForSelector(DETAIL, { visible: true }); await thumbnails(DETAIL + ' ' + HISTORY, 1);
    assert.equal(await page.$eval(DETAIL + ' ' + HISTORY, node => node.dataset.photoId), oldPhoto);
    const expectedOld = await env.api(page, '/api/award-photos/read', 'POST', { photoId: oldPhoto }); assert.equal(expectedOld.status, 200);
    await click(page, DETAIL + ' ' + HISTORY); await page.waitForSelector(VIEWER, { visible: true });
    await page.waitForFunction((selector, expected) => {
      const image = document.querySelector(selector + ' img'); return image && image.complete && image.naturalWidth > 0 && image.src === expected;
    }, { timeout: 6000 }, VIEWER, expectedOld.body.dataUrl);
    await click(page, VIEWER + ' [data-photo-close]'); await page.waitForSelector(VIEWER, { hidden: true });
    await noStoredAward(actionId, oldPhoto); await noStoredAward(awardRequests.actions[1].action.id, newPhoto);
    assert.deepEqual(await sql(), after);
  });
}
async function resumeAvatar() {
  let controlAvatar;
  await check('An avatar selected across hide/show remains an unsaved profile draft without an old award receipt', async () => {
    const before = await sql(), marker = env.calls.length;
    await click(page, a('profile-edit'));
    const selected = page.waitForFileChooser(); await click(page, a('avatar-choose')); const chooser = await selected;
    await hideAward(); await chooser.accept([files.png]); await resumeAward();
    await page.waitForFunction(() => document.querySelector('#avatar-status')?.textContent === '头像已选定');
    controlAvatar = await page.$eval('.profile-photo-preview img', node => node.getAttribute('src'));
    assert.match(controlAvatar, /^data:image\/jpeg;base64,/);
    assert.equal((await ui(page)).form, 'profile'); assert.equal((await ui(page)).auth, false);
    assert.deepEqual(await sql(), before, 'a returned avatar does not save the profile or award points');
    assert.deepEqual(env.calls.slice(marker).filter(call => ['/api/parent/challenge', '/api/parent/verify', '/api/action'].includes(call.path)), []);
    await Q.home(page); assert.equal(await page.$('.child-avatar img'), null, 'cancelling leaves the home avatar unchanged');
    assert.deepEqual(await sql(), before);
  });
  await check('A late award receipt preserves the returned avatar until explicit profile save and keeps one award after reload', async () => {
    const before = await sql(); await openCustom(); await parentReview();
    const original = await loseUncommittedAction(before), actionId = original.action.id;
    await resumeAward(); await Q.home(page); await click(page, a('profile-edit'));
    const selected = page.waitForFileChooser(); await click(page, a('avatar-choose')); const chooser = await selected;
    const late = await env.api(page, '/api/action', 'POST', original);
    assert.equal(late.status, 200, 'the old authorized award commits while the avatar chooser remains open');
    const committed = await sql(), row = committed.state.points.at(-1);
    assert.equal(committed.revision, before.revision + 1); assert.equal(committed.state.points.length, before.state.points.length + 1);
    assert.equal(row.id, 'points-' + actionId); assert.equal(row.name, CUSTOM); assert.equal(row.points, 7);
    const marker = env.calls.length;
    await hideAward(); await chooser.accept([files.png]); await resumeAward();
    await page.waitForFunction(() => document.querySelector('#avatar-status')?.textContent === '头像已选定');
    await page.waitForFunction(() => {
      const image = document.querySelector('.profile-photo-preview img');
      return image && image.complete && image.naturalWidth === 192 && image.naturalHeight === 192;
    });
    const avatar = await page.$eval('.profile-photo-preview img', node => node.getAttribute('src'));
    assert.equal(avatar, controlAvatar, 'the identical PNG produces the same avatar when the old receipt is reconciled');
    assert.equal((await ui(page)).form, 'profile'); assert.equal((await ui(page)).auth, false); assert.equal((await ui(page)).pending, false);
    assert.equal(await page.$('#parent-form [name="answer"]'), null);
    assert.equal(await page.$eval('#editor-form [name="childName"]', node => node.value), CHILD);
    assert.deepEqual(await sql(), committed, 'returning from the chooser never saves the selected avatar automatically');
    assert.deepEqual(await snapshot(page), committed.state);
    assert.deepEqual(env.calls.slice(marker).filter(call => ['/api/parent/challenge', '/api/parent/verify', '/api/action'].includes(call.path)), []);
    assert.equal(uploads.length, 0, 'profile avatars never become award-photo uploads');
    await Q.shot(page, 'late-award-avatar-selected');
    await click(page, Q.save);
    if (!(await ui(page)).auth) {
      assert.match(await page.$eval('#form-error', node => node.textContent), /记录已更新 · 待确认/);
      assert.deepEqual(await sql(), committed); await click(page, Q.save);
    }
    await page.waitForSelector('#parent-form [name="answer"]', { visible: true });
    assert.equal(await page.$eval('#parent-form [name="answer"]', node => node.value), '', 'profile save requires fresh parent verification');
    assert.deepEqual(await sql(), committed, 'profile review does not save the avatar before verification');
    await B.fill(page, '#parent-form [name="answer"]', PIN); await click(page, Q.parentSubmit);
    await page.waitForFunction(() => { const current = window.FamilyDemo.getUI(); return !current.auth && !current.pending && current.form === null; });
    const after = await sql(), profileWrites = env.calls.slice(marker).filter(call => call.path === '/api/action');
    assert.equal(after.revision, committed.revision + 1); assert.equal(after.state.childAvatar, avatar); assert.equal(after.state.childName, CHILD);
    assert.deepEqual(after.state.points, committed.state.points, 'saving the avatar never repeats the old award');
    assert.equal(profileWrites.length, 1); assert.equal(profileWrites[0].action.type, 'profile.update');
    assert.equal(profileWrites[0].action.hasGrant, true); assert.equal(profileWrites[0].familyId, familyId);
    assert.equal(awardRequests.actions.length, 1, 'the original aborted browser submission is never resubmitted');
    const replay = await env.api(page, '/api/action', 'POST', original);
    assert.equal(replay.status, 200); assert.deepEqual(await sql(), after, 'replaying the old award cannot change the saved profile or add points');
    await reload();
    await page.waitForFunction(() => { const image = document.querySelector('.child-avatar img'); return image && image.complete && image.naturalWidth === 192; });
    assert.equal(await page.$eval('.child-avatar img', node => node.getAttribute('src')), avatar);
    assert.deepEqual(await snapshot(page), after.state); assert.deepEqual(await sql(), after);
    report.resume = { actionId, lateOriginalStatus: late.status, committedAwards: 1, controlAvatarMatched: true,
      avatarSha256: crypto.createHash('sha256').update(avatar).digest('hex'), profileSaved: true, avatarSurvivedReload: true };
    await Q.shot(page, 'late-award-avatar-persisted');
  });
}
async function pickerReturn() {
  await check('A file-picker result returns to the same draft after hide/show and still needs explicit parent verification', async () => {
    const before = await sql(); await openCustom();
    const chooser = await openChooser('album');
    await visibility(true); await page.waitForFunction(() => !window.FamilySaas.status().ready);
    assert.equal(await snapshot(page), null, 'hidden UI masks the family state while the picker is open');
    assert.doesNotMatch(await page.$eval('body', node => node.textContent), new RegExp(CUSTOM));
    const marker = uploads.length, received = uploadResponse();
    await chooser.accept([files.png]); await visibility(false); await Q.ready(page, familyId);
    const id = await uploaded(received, marker, '.png across picker return');
    await thumbnails(PREVIEW, 1);
    assert.equal(await page.$eval('#editor-form [name="name"]', node => node.value), CUSTOM);
    assert.equal(await page.$eval('#editor-form [name="reason"]', node => node.value), '自己完成并核对两页练习');
    assert.equal((await ui(page)).auth, false);
    assert.deepEqual(await sql(), before, 'returning from the file picker never records points');
    await Q.shot(page, 'photo-picker-draft-restored');
    await commit(before, [id]); await history(1); await viewer(HISTORY);
  });
}
async function presetReturn() {
  await check('A direct preset camera returns to the same unwritten review and X cancels its photos before another explicit award', async () => {
    const before = await sql(), marker = env.calls.length;
    await click(page, a('choose-point', 'photo-common'));
    assert.equal((await ui(page)).authPhase, 'confirm');
    const chooser = await openChooser('camera');
    await visibility(true); await page.waitForFunction(() => !window.FamilySaas.status().ready);
    assert.equal(await snapshot(page), null);
    const uploadMarker = uploads.length, received = uploadResponse();
    await chooser.accept([files.jpeg]); await visibility(false); await Q.ready(page, familyId);
    const discarded = await uploaded(received, uploadMarker, '.jpg across direct-review camera return');
    await page.waitForFunction(() => window.FamilyDemo.getUI().authPhase === 'confirm');
    await thumbnails(PREVIEW, 1);
    assert.equal((await Q.status(page)).familyId, familyId);
    assert.deepEqual(await sql(), before, 'returning preserves the same family revision and does not write a score');
    assert.deepEqual(await snapshot(page), before.state);
    assert.equal(await page.$('#parent-form [name="answer"]'), null, 'returning to review does not restore verification authority');
    assert.match(await page.$eval('.ledger-award-dialog', node => node.textContent), new RegExp(COMMON));
    assert.deepEqual(env.calls.slice(marker).filter(call => ['/api/parent/challenge', '/api/action'].includes(call.path)), []);
    await Q.shot(page, 'preset-camera-returned-to-review');
    await click(page, '.ledger-award-dialog .sheet-header button[aria-label="取消本次加分"]');
    await page.waitForFunction(() => { const current = window.FamilyDemo.getUI(); return !current.auth && current.form === null; });
    assert.deepEqual(await sql(), before, 'X cancels the photo draft without scoring');
    await storedPhotos([]);
    await click(page, a('choose-point', 'photo-common')); assert.equal((await ui(page)).authPhase, 'confirm');
    assert.equal(await page.$(PREVIEW), null, 'the cancelled photo never returns in the next direct review');
    const id = await pick('camera', files.jpeg, 1); assert.notEqual(id, discarded);
    const row = await commit(before, [id], true);
    assert.equal(row.itemId, 'photo-common'); assert.equal(row.points, 5);
    await storedPhotos([], [id]);
    await history(1, COMMON); await viewer(HISTORY);
  });
}
async function overlap() {
  await check('Finishing one upload while a second native chooser is open keeps both photos in the same authorized award in order', async () => {
    const before = await sql(); await openCustom();
    let held, released = false, first, second;
    const intercept = request => {
      if (!held && request.method() === 'POST' && new URL(request.url()).pathname === '/api/award-photos') held = request;
      else void request.continue();
    };
    await page.setRequestInterception(true); page.on('request', intercept);
    try {
      const initial = await openChooser('album'), firstMarker = uploads.length;
      const started = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/award-photos', { timeout: 6000 });
      await initial.accept([files.png]); await started;
      assert.ok(held, 'the first actual upload is held before the real service');
      const next = await openChooser('album');
      assert.equal(await page.evaluate(() => document.hidden), false, 'this overlap happens without suspending the page');
      const firstResponse = uploadResponse(); await held.continue(); released = true;
      first = await uploaded(firstResponse, firstMarker, '.png completed while second chooser is open');
      await page.waitForFunction(selector => {
        const button = document.querySelector(selector); return button && !button.disabled;
      }, { timeout: 6000 }, Q.save);
      report.overlap = { firstUploadFinishedWhileSecondChooserOpen: true };
      progress('First upload finished while the second native chooser remains open');
      const secondMarker = uploads.length, secondResponse = uploadResponse();
      await next.accept([files.jpeg]);
      progress('Second native selection accepted; waiting for its real upload');
      second = await uploaded(secondResponse, secondMarker, '.jpg selected after first upload finished');
      await thumbnails(PREVIEW, 2);
      assert.equal(uploads.length - firstMarker, 2, 'both real selections uploaded once');
      assert.deepEqual(await sql(), before, 'overlapping selection does not record points');
      assert.equal(await page.$eval('#editor-form [name="name"]', node => node.value), CUSTOM);
      report.overlap.secondSelectionPreserved = true;
      await Q.shot(page, 'overlapping-photo-selection-preserved');
    } finally {
      if (held && !released) await held.continue().catch(() => {});
      page.off('request', intercept); await page.setRequestInterception(false);
    }
    const row = await commit(before, [first, second]);
    assert.equal(row.name, CUSTOM); assert.equal(row.points, 7);
    await history(2); await viewer(HISTORY, true);
  });
}
async function expired() {
  await check('An unavailable staged photo keeps its JPEG for explicit retry with a new reference and one authorized award', async () => {
    const before = await sql(); await openCustom();
    const firstMarker = uploads.length, initial = await pick('album', files.png, 1);
    const originalJpeg = uploads[firstMarker].dataUrl, identity = await Q.status(page);
    await click(page, Q.save); await page.waitForFunction(() => window.FamilyDemo.getUI().authPhase === 'confirm');
    let failed = 0, rejected;
    const intercept = request => {
      if (failed === 0 && request.method() === 'POST' && new URL(request.url()).pathname === '/api/parent/challenge') {
        failed++; rejected = JSON.parse(request.postData());
        void request.respond({ status: 400, contentType: 'application/json', body: JSON.stringify({
          code: 'PHOTO_UNAVAILABLE', error: '照片已过期或不可用于本次加分，请重新选择',
          familyId, userId: identity.userId
        }) });
      } else void request.continue();
    };
    await page.setRequestInterception(true); page.on('request', intercept);
    try {
      const marker = env.calls.length;
      await click(page, a('points-confirm')); await page.waitForSelector(a('award-photo-retry'), { visible: true });
      assert.equal(failed, 1); assert.deepEqual(rejected.action.photoIds, [initial]);
      assert.equal((await Q.status(page)).ready, true);
      assert.equal((await Q.status(page)).familyId, familyId);
      assert.deepEqual(await sql(), before, 'an expired attachment never commits its score');
      assert.deepEqual(env.calls.slice(marker).filter(call => call.path === '/api/action'), []);
      assert.equal(await page.$('#parent-form [name="answer"]'), null, 'an unavailable photo does not advance to PIN entry');
      await Q.shot(page, 'expired-photo-ready-for-retry');
      const retryMarker = uploads.length, received = uploadResponse(); await click(page, a('award-photo-retry'));
      const replacement = await uploaded(received, retryMarker, '.png retried after PHOTO_UNAVAILABLE');
      assert.notEqual(replacement, initial, 'retry gets a new staged-photo reference');
      assert.equal(uploads[retryMarker].dataUrl, originalJpeg, 'retry reuses the retained JPEG without another file selection');
      await thumbnails(PREVIEW, 1); await page.waitForSelector(a('award-photo-retry'), { hidden: true });
      report.expired = { initialPhotoId: initial, replacementPhotoId: replacement, retainedJpegReused: true };
      await commit(before, [replacement], (await ui(page)).authPhase === 'confirm');
    } finally { page.off('request', intercept); await page.setRequestInterception(false); }
    await history(1); await viewer(HISTORY);
  });
}
async function retake() {
  await check('At the staging quota, retaking a photo frees its slot and preserves other drafts', async () => {
    const enabled = await env.api(page, '/api/parent/device', 'POST', { enabled: true, credential: PIN });
    assert.equal(enabled.status, 200); await reload();
    const jpeg = 'data:image/jpeg;base64,' + fs.readFileSync(files.jpeg).toString('base64');
    const otherDrafts = [];
    for (let i = 0; i < 11; i++) {
      const reply = await env.api(page, '/api/award-photos', 'POST', { dataUrl: jpeg });
      assert.equal(reply.status, 200); otherDrafts.push(reply.body.photoId);
    }
    const before = await sql(); await openCustom();
    const initial = await pick('album', files.png, 1);
    await storedPhotos([...otherDrafts, initial]);
    await click(page, Q.save);
    await page.waitForFunction(() => window.FamilyDemo.getUI().authPhase === 'confirm');
    await click(page, '.sheet-footer ' + a('parent-cancel'));
    await thumbnails(PREVIEW, 1); await storedPhotos([...otherDrafts, initial]);
    const cancelled = page.waitForFileChooser();
    await click(page, a('award-photo-retake'));
    await (await cancelled).cancel();
    await thumbnails(PREVIEW, 1); await storedPhotos([...otherDrafts, initial]);
    env.clock(env.now() + 61000);
    const chooser = page.waitForFileChooser();
    await click(page, a('award-photo-retake'));
    const marker = uploads.length, received = uploadResponse();
    await (await chooser).accept([files.jpeg]);
    const replacement = await uploaded(received, marker, 'replacement camera shot');
    assert.notEqual(replacement, initial);
    await storedPhotos([...otherDrafts, replacement]);
    await commit(before, [replacement], false, true); await storedPhotos(otherDrafts, [replacement]);
  });
}
async function discardRace() {
  await check('Removing a photo while its upload is in flight leaves no staged row or score', async () => {
    const before = await sql(); await openCustom();
    let held, released = false;
    const intercept = request => {
      if (!held && new URL(request.url()).pathname === '/api/award-photos' && request.method() === 'POST') held = request;
      else void request.continue();
    };
    await page.setRequestInterception(true); page.on('request', intercept);
    try {
      const chooser = await openChooser('album');
      const started = page.waitForRequest(request => new URL(request.url()).pathname === '/api/award-photos' && request.method() === 'POST');
      await chooser.accept([files.png]); await started;
      assert.ok(held); await click(page, a('award-photo-remove')); await thumbnails(PREVIEW, 0);
      const finished = uploadResponse(); await held.continue(); released = true;
      const outcome = await finished;
      assert.ok(outcome.response, 'the retained upload must finish at the service');
      await storedPhotos([]); assert.deepEqual(await sql(), before);
    } finally {
      if (held && !released) await held.continue().catch(() => {});
      page.off('request', intercept); await page.setRequestInterception(false);
    }
  });
}
async function controls() {
  await check('Mobile attachment controls explain zero and full selection and accept real camera/album taps without scoring', async () => {
    const before = await sql(), marker = env.calls.length; await openCustom();
    await selectedCount(0); await thumbnails(PREVIEW, 0);
    assert.ok(await Q.visible(page, a('award-photo-camera')));
    assert.ok(await Q.visible(page, a('award-photo-album')));
    assert.ok(await Q.visible(page, '.award-photo-heading ' + a('award-photo-album')), 'the optional album action remains visible beside the attachment heading');
    await page.$eval('.award-photo-editor', node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await mobileShot('editor-empty');
    await click(page, Q.save); await page.waitForFunction(() => window.FamilyDemo.getUI().authPhase === 'confirm');
    await selectedCount(0); await mobileShot('review-empty');
    const first = await pick('album', files.png, 1, false, true); await selectedCount(1);
    const second = await pick('camera', files.jpeg, 2, false, true); await selectedCount(2);
    const third = await pick('album', files.third, 3, false, true); await selectedCount(3);
    assert.equal(await page.$('.award-photo-editor ' + a('award-photo-camera')), null, 'the full tray replaces add controls with its visible selected count');
    assert.equal(await page.$('.award-photo-editor ' + a('award-photo-album')), null);
    assert.equal(await page.$('.award-photo-pickers'), null, 'there is no empty add row below three selected photos');
    assert.ok(await Q.visible(page, '.award-photo-quota'));
    await storedPhotos([first, second, third]);
    await mobileShot('review-filled');
    await tap(PREVIEW); await page.waitForSelector(VIEWER, { visible: true });
    await page.waitForFunction(selector => {
      const image = document.querySelector(selector + ' img'); return image && image.complete && image.naturalWidth > 0;
    }, { timeout: 6000 }, VIEWER);
    await tap(VIEWER + ' [data-photo-close]'); await page.waitForSelector(VIEWER, { hidden: true });
    await selectedCount(3); await storedPhotos([first, second, third]);
    const cancelled = page.waitForFileChooser({ timeout: 6000 });
    await tap(a('award-photo-retake')); await (await cancelled).cancel();
    await selectedCount(3); await thumbnails(PREVIEW, 3); await storedPhotos([first, second, third]);
    const removeThird = a('award-photo-remove', await page.$$eval(a('award-photo-remove'), nodes => nodes.at(-1).dataset.id));
    await tap(removeThird); await selectedCount(2); await thumbnails(PREVIEW, 2); await storedPhotos([first, second]);
    const replacement = await pick('album', files.jpeg, 3, false, true); await selectedCount(3);
    await click(page, '.sheet-footer ' + a('parent-cancel'));
    await page.waitForFunction(() => window.FamilyDemo.getUI().form === 'points');
    await selectedCount(3); await thumbnails(PREVIEW, 3);
    await page.$eval('.award-photo-editor', node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await mobileShot('editor-filled');
    assert.deepEqual(await sql(), before, 'choosing, cancelling retake, removing and reviewing photos never records points');
    assert.deepEqual(env.calls.slice(marker).filter(call => ['/api/parent/challenge', '/api/parent/verify', '/api/action'].includes(call.path)), []);
    await Q.home(page); await storedPhotos([]); assert.deepEqual(await sql(), before);
    report.controls = { zeroAndFullCounts: true, fullTrayQuota: true, cameraAndAlbumTouch: true, cancelledRetakePreservedPhotos: true,
      removedThirdPhotoId: third, replacementPhotoId: replacement, committedScores: 0 };
  });
}
async function detail() {
  const legacyName = '合成旧记录：独立整理书包';
  const originalNow = env.now();
  const trusted = await env.api(page, '/api/parent/device', 'POST', { enabled: true, credential: PIN });
  assert.equal(trusted.status, 200);
  await env.setClock(originalNow - 86400000);
  for (let index = 0; index < 5; index++) {
    progress('Creating real photo-less history fixture ' + (index + 1));
    await fixtureAction({ type: 'points.add', name: '合成往日练习 ' + (index + 1), points: 1, reason: '用于检查完整记录列表滚动返回，保留原来记录的原因和分数' }, false);
  }
  await fixtureAction({ type: 'points.add', name: legacyName, points: 3, reason: '按课表整理并核对书本，无照片的旧记录' }, false);
  const oldRecords = (await sql()).state.points, legacy = oldRecords.at(-1), oldest = oldRecords[0];
  assert.equal(Object.hasOwn(legacy, 'photoIds'), false, 'the old fixture uses the existing photo-less persisted shape');
  const untrusted = await env.api(page, '/api/parent/device', 'POST', { enabled: false }); assert.equal(untrusted.status, 200);
  await env.setClock(originalNow); await reload();
  const beforeAward = await sql(); await openCustom();
  const first = await pick('album', files.png, 1), second = await pick('camera', files.jpeg, 2), third = await pick('album', files.third, 3);
  const row = await commit(beforeAward, [first, second, third]);
  await reload();
  const baseline = await sql(), marker = env.calls.length;
  const recordButton = record => a('record-detail', 'points:' + record.id);
  async function assertDetail(record, count) {
    await page.waitForSelector(DETAIL, { visible: true });
    const content = await page.$eval(DETAIL + ' .points-record-detail', node => node.textContent);
    assert.ok(content.includes(record.name)); assert.ok(content.includes(record.reason));
    assert.match(content, new RegExp('\\+' + record.points + '\\s*分'));
    const times = await page.$$eval(DETAIL + ' time', nodes => nodes.map(node => ({ at: node.getAttribute('datetime'), label: node.textContent })));
    assert.ok(times.some(time => time.at === record.at && time.label === '12:30'), 'detail preserves the actual recorded time');
    assert.equal((await page.$$(DETAIL + ' ' + HISTORY)).length, count);
    await thumbnails(DETAIL + ' ' + HISTORY, count);
  }
  async function closeDetail(selector, expectedForm, scrollBefore, parent = '.sheet-body') {
    await click(page, DETAIL + ' .sheet-header ' + a('form-close'));
    await page.waitForFunction((target, kind) => {
      const form = window.FamilyDemo.getUI().form;
      return form === kind && document.activeElement?.matches(target);
    }, { timeout: 6000 }, selector, expectedForm);
    const current = await page.evaluate(target => target === 'window' ? window.scrollY : document.querySelector(target).scrollTop, parent);
    assert.ok(Math.abs(current - scrollBefore) <= 2, 'closing detail restores its parent scroll: ' + JSON.stringify({ current, scrollBefore }));
  }
  async function originalShown(index, url) {
    await page.waitForFunction((selector, number, expected) => {
      const image = document.querySelector(selector + ' img'), heading = document.querySelector(selector + ' header');
      return heading && new RegExp(number + '\\s*\\/\\s*3').test(heading.textContent) && image && !image.hidden && image.complete && image.naturalWidth > 0 && image.src === expected;
    }, { timeout: 6000 }, VIEWER, index + 1, url);
  }
  await check('A complete home row opens its record and the chosen second thumbnail opens that original before any other page', async () => {
    assert.equal(await page.$('#main ' + HISTORY), null, 'home rows lead to detail rather than nested photo buttons');
    const selector = '#main .points-recent-row ' + recordButton(row);
    await page.$eval(selector, node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await tap(selector, true); await assertDetail(row, 3); await mobileShot('record-detail');
    const chosen = DETAIL + ' ' + HISTORY + '[data-photo-index="1"]';
    const expected = await env.api(page, '/api/award-photos/read', 'POST', { photoId: second }); assert.equal(expected.status, 200);
    const originals = await page.$$eval(DETAIL + ' ' + HISTORY + ' img', nodes => nodes.map(node => node.src));
    assert.equal(originals[1], expected.body.dataUrl, 'the second visible thumbnail came from its actual persisted photo');
    const readsBeforeViewer = env.calls.filter(call => call.path === '/api/award-photos/read').length;
    await tap(chosen); await page.waitForSelector(VIEWER, { visible: true });
    await originalShown(1, expected.body.dataUrl);
    await mobileShot('large-photo');
    await tap(VIEWER + ' [data-photo-next]');
    await originalShown(2, originals[2]);
    assert.equal(await page.$eval(VIEWER + ' [data-photo-next]', node => node.disabled), true);
    await page.keyboard.press('ArrowLeft');
    await originalShown(1, originals[1]);
    await tap(VIEWER + ' [data-photo-prev]');
    await originalShown(0, originals[0]);
    assert.equal(await page.$eval(VIEWER + ' [data-photo-prev]', node => node.disabled), true);
    await page.keyboard.press('ArrowRight');
    await originalShown(1, originals[1]);
    await tap(VIEWER + ' [data-photo-zoom]');
    assert.equal(await page.$eval(VIEWER + ' .award-photo-stage', node => node.classList.contains('zoomed')), true);
    await tap(VIEWER + ' [data-photo-zoom]');
    assert.equal(await page.$eval(VIEWER + ' .award-photo-stage', node => node.classList.contains('zoomed')), false);
    await page.keyboard.press('Escape'); await page.waitForSelector(VIEWER, { hidden: true });
    assert.equal(env.calls.filter(call => call.path === '/api/award-photos/read').length, readsBeforeViewer, 'viewing already loaded originals makes no duplicate photo-read request');
    assert.equal(await page.evaluate(target => document.activeElement?.matches(target), chosen), true, 'viewer close returns focus to the chosen thumbnail');
    await assertDetail(row, 3); await closeDetail(selector, null, scrollBefore, 'window');
    const oldSelector = '#main .points-recent-row ' + recordButton(legacy);
    await tap(oldSelector, true); await assertDetail(legacy, 0);
    await click(page, DETAIL + ' .sheet-header ' + a('form-close'));
    assert.equal((await ui(page)).form, null);
  });
  await check('Complete-list details preserve the points tab, scroll and focus for photo records and old photo-less entries', async () => {
    await click(page, '.points-recent ' + a('records'));
    await page.waitForSelector('.points-ledger .record-list', { visible: true }); await mobileShot('record-history');
    assert.equal(await page.$('.record-list ' + HISTORY), null, 'history rows open details rather than a nested image action');
    for (const record of [row, oldest]) {
      const selector = '.record-list ' + recordButton(record);
      await page.$eval(selector, node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.focus(selector);
      const scrollBefore = await page.$eval('.sheet-body', node => node.scrollTop);
      if (record === oldest) assert.ok(scrollBefore > 20, 'the old entry requires a scrolled complete list');
      await page.keyboard.press('Enter'); await assertDetail(record, record === row ? 3 : 0);
      await closeDetail(selector, 'records', scrollBefore);
      assert.equal(await page.$eval(a('history', 'points'), node => node.getAttribute('aria-pressed')), 'true');
    }
    await Q.home(page);
  });
  await check('Weekly daily rows open old and photographed records and return to the same expanded days without any ledger write', async () => {
    await click(page, a('home-week')); await page.waitForSelector('[data-testid="home-week-summary"]');
    const yesterday = '.points-summary-day[data-date="2026-11-24"]';
    await click(page, yesterday + ' > summary');
    for (const record of [legacy, row]) {
      const selector = '.points-detail-records ' + recordButton(record);
      await page.$eval(selector, node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.focus(selector);
      const scrollBefore = await page.$eval('.sheet-body', node => node.scrollTop);
      const expanded = await page.$$eval('.points-summary-day[open]', nodes => nodes.map(node => node.dataset.date));
      await page.keyboard.press('Enter'); await assertDetail(record, record === row ? 3 : 0);
      await closeDetail(selector, 'homeWeek', scrollBefore);
      assert.deepEqual(await page.$$eval('.points-summary-day[open]', nodes => nodes.map(node => node.dataset.date)), expanded);
    }
    assert.deepEqual(await sql(), baseline, 'viewing every record, original image, list and weekly detail leaves SQLite unchanged');
    assert.deepEqual(env.calls.slice(marker).filter(call => ['/api/action', '/api/parent/challenge', '/api/parent/verify'].includes(call.path)), [], 'read-only navigation never requests a parent grant or ledger write');
    report.details = { home: true, completeList: true, weekly: true, photoLessOldShape: true, firstOriginalPhotoId: second,
      originalStartIndex: 1, touchAndKeyboardNavigation: true, focusAndScrollRestored: true, ledgerUnchanged: true };
  });
}
async function run() {
  await setup(); await ({ custom, preset, retry, skip, scope, 'picker-return': pickerReturn, 'preset-return': presetReturn, overlap, expired, retake, 'discard-race': discardRace, 'resume-committed': resumeCommitted, 'resume-uncommitted': resumeUncommitted, 'resume-late': resumeLate, 'resume-midnight': resumeMidnight, 'resume-chooser': resumeChooser, 'resume-avatar': resumeAvatar, controls, detail })[CASE]();
  assert.deepEqual(Q.report.pageErrors, []);
  report.finalSourceHashes = hashes(); report.sourceStable = JSON.stringify(report.sourceHashes) === JSON.stringify(report.finalSourceHashes);
  progress('Selected photo group complete');
}
Q.execute(run);
