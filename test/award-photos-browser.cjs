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
const CASES = ['custom', 'preset', 'retry', 'skip', 'scope', 'picker-return', 'preset-return', 'overlap', 'expired', 'retake', 'discard-race', 'resume-committed', 'resume-uncommitted', 'resume-late'];
assert.ok(CASES.includes(CASE), 'Unknown AWARD_PHOTO_CASE');
const WIDTH = Number(process.env.AWARD_PHOTO_WIDTH || 390);
const HEIGHT = Number(process.env.AWARD_PHOTO_HEIGHT || 844);
const CHILD = '合成照片宝';
const CUSTOM = '独立完成合成作业';
const COMMON = '合成作业常用行为';
const PREVIEW = a('award-photo-preview');
const HISTORY = a('award-photo-history');
const VIEWER = '[data-award-photo-viewer]';
const SOURCES = ['test/award-photos-browser.cjs', 'test/saas-browser.cjs', 'test/browser.cjs',
  'award-photos.js', 'award-photos.css', 'app.js', 'index.html', 'model.js', 'saas-client.js', 'saas-server.cjs',
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
    return { png: image('image/png', '#245eab', 'SYNTHETIC PAGE ONE'), jpeg: image('image/jpeg', '#a54434', 'SYNTHETIC PAGE TWO') };
  });
  files = { png: path.join(Q.OUT, 'synthetic-homework.png'), jpeg: path.join(Q.OUT, 'synthetic-homework.jpg') };
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
async function openChooser(mode) {
  const input = '[data-award-photo-input="' + mode + '"]';
  assert.equal(await page.$eval(input, node => node.type), 'file');
  if (mode === 'camera') assert.equal(await page.$eval(input, node => node.getAttribute('capture')), 'environment');
  const chooser = page.waitForFileChooser({ timeout: 6000 });
  await click(page, a('award-photo-' + mode));
  return chooser;
}
async function pick(mode, file, count, fail = false) {
  const selected = await openChooser(mode), marker = uploads.length, received = fail ? null : uploadResponse();
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
  await page.waitForSelector(HISTORY, { visible: true });
  const saved = await page.$eval(HISTORY, node => ({ ids: node.dataset.id.split(','), text: node.textContent }));
  assert.equal(saved.ids.length, count);
  assert.match(saved.text, new RegExp(count + '\\s*张'));
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
async function run() {
  await setup(); await ({ custom, preset, retry, skip, scope, 'picker-return': pickerReturn, 'preset-return': presetReturn, overlap, expired, retake, 'discard-race': discardRace, 'resume-committed': resumeCommitted, 'resume-uncommitted': resumeUncommitted, 'resume-late': resumeLate })[CASE]();
  assert.deepEqual(Q.report.pageErrors, []);
  report.finalSourceHashes = hashes(); report.sourceStable = JSON.stringify(report.sourceHashes) === JSON.stringify(report.finalSourceHashes);
  progress('Selected photo group complete');
}
Q.execute(run);
