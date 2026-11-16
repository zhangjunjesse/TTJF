'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const B = require('./browser.cjs');
const { Model, PIN, FIXTURE_TIME, SELECTORS, action, click, fillForm, state, ui, totals,
  navigate, verify, delay } = B;
async function openCredit(page,values={}) {
  await click(page,action('add-points'));
  await page.waitForFunction(()=>window.FamilyDemo.getUI().form==='behaviorPicker');
  await click(page,action('points-mode','custom'));
  await page.waitForFunction(()=>window.FamilyDemo.getUI().form==='points');
  await fillForm(page,{name:'认真阅读',points:5,reason:'主动分享今天读到的故事',...values});
}
const STATE_KEY = 'little-steps-demo-v1';
const EVIDENCE_VERSION = process.env.FAMILY_EVIDENCE_VERSION || 'v6';
assert.match(EVIDENCE_VERSION, /^v\d+$/);
const SOURCE_HASHES = Object.fromEntries(['app.js','model.js','styles.css','pet.js','pet.css','index.html'].map(name =>
  [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(B.ROOT, name))).digest('hex')]));

// The first seven cases are the original client regressions, migrated from a minimal
// synthetic DOM to the real app rendered in Edge. Only XHR completion order and
// the periodic poll tick are controlled here. Security itself is tested by the
// real-server browser suite and the server owner's API tests, not by these stubs.
const REGRESSION_MAP = [
  { id: 'C1', old: 'HTTP writes blocked before the first successful state sync', current: 'Initial sync hold/failure blocks public and protected writes, preserves draft, then permits fresh verification' },
  { id: 'C2', old: 'Explicit file mode permits local-only actions without requests', current: 'Actual source file:// page publicly completes/persists a reminder without any XHR; packaged export is separately checked' },
  { id: 'C3', old: 'Only one outstanding polling GET, resumes after completion or timeout', current: 'Actual polling callback and XHR timeout preserve single-flight behavior' },
  { id: 'C4', old: 'Delayed older GET cannot roll back a successful POST', current: 'Public reminder completion followed by old GET cannot roll back revision, memory, or storage' },
  { id: 'C5', old: 'Reward price sync refreshes confirmation and requires a second click', current: 'Pending redemption approval refreshes price, preserves note, requires review and new per-operation verification before spending' },
  { id: 'C6', old: 'Timeout/conflict/retry reuses action ID and books once', current: 'Lost committed award response keeps ID; conflict or polling reconciliation must reveal exactly one award; next award gets a new ID and verification' },
  { id: 'C7', old: 'Uncommitted conflict retry keeps ID while advancing revision', current: 'Concurrent public change preserves award draft/ID and requires a fresh challenge tied to the new revision' },
  { id: 'C8', old: 'New v0.3 regression for a connection lost after startup', current: 'Timeout, 503, and malformed snapshots visibly disconnect and block writes without losing the draft; a valid snapshot restores usability' }
];
let browser;
const completed = [], attempted = [];

test.before(async () => { browser = await B.launch(); });
test.after(async () => {
  if (browser) { await browser.close(); }
  fs.mkdirSync(B.ARTIFACTS, { recursive: true });
  const output = path.join(B.ARTIFACTS, EVIDENCE_VERSION + '-client-results.json');
  const targeted = process.execArgv.some(value => value.indexOf('--test-name-pattern') === 0);
  const history = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null;
  const previous = targeted ? history : null;
  const coverage = REGRESSION_MAP.map(item => ({ ...item, result: attempted.includes(item.id) ?
    completed.includes(item.id) ? 'passed' : 'failed' :
    previous && previous.coverage.find(entry => entry.id === item.id)?.result || 'not run' }));
  fs.writeFileSync(output, JSON.stringify({
    browser: 'Microsoft Edge / Chromium, real rendered DOM and hit-tested mouse',
    evidenceBoundary: 'XHR responses, challenge grants, and five-second polling ticks are controlled client fixtures. These tests do not claim backend security or iPad Safari compatibility.',
    passed: coverage.filter(item => item.result === 'passed').length,
    coverage,
    version: EVIDENCE_VERSION,
    sourceHashes: SOURCE_HASHES,
    runs: (history && history.runs || []).concat({ tested: attempted, passed: completed, sourceHashes: SOURCE_HASHES, at: new Date().toISOString() })
  }, null, 2));
});

async function client(options = {}) {
  const env = await B.createEnvironment(browser);
  const page = await env.newPage({ width: 1024, height: 768 });
  await page.evaluateOnNewDocument(() => {
    const realTimeout = window.setTimeout.bind(window);
    const realInterval = window.setInterval.bind(window);
    const requests = [], polls = [];
    let sequence = 0;
    window.setInterval = function (callback, milliseconds) {
      if (milliseconds === 5000) { polls.push(callback); return 900000 + polls.length; }
      return realInterval(callback, milliseconds);
    };
    window.__qaPoll = function () {
      if (!polls.length) { throw new Error('App must register its five-second poll callback'); }
      polls.forEach(callback => callback());
    };
    function respond(entry, status, body) {
      if (!entry || entry.settled) { throw new Error('An XHR must receive exactly one terminal event'); }
      entry.settled = true;
      entry.xhr.status = status;
      entry.xhr.responseText = JSON.stringify(body);
      if (entry.xhr.onload) { entry.xhr.onload(); }
    }
    window.__qaRequests = function () {
      return requests.map(entry => ({ id: entry.id, method: entry.method, url: entry.url, body: entry.body, settled: entry.settled }));
    };
    window.__qaRespond = function (id, status, body) { respond(requests.find(entry => entry.id === id), status, body); };
    window.__qaTimeout = function (id) {
      const entry = requests.find(item => item.id === id);
      if (!entry || entry.settled) { throw new Error('Cannot timeout a settled XHR'); }
      entry.settled = true;
      if (entry.xhr.ontimeout) { entry.xhr.ontimeout(); }
    };
    function ControlledXHR() {
      this.headers = {};
      this.open = (method, url) => { this.method = method; this.url = url; };
      this.setRequestHeader = (name, value) => { this.headers[name] = value; };
      this.send = payload => {
        const entry = { id: ++sequence, xhr: this, method: this.method, url: this.url,
          body: payload ? JSON.parse(payload) : null, settled: false };
        requests.push(entry);
        if (entry.url === '/api/meta') {
          realTimeout(() => respond(entry, 200, { parent: { method: 'pin' }, assistant: { mode: 'demo', label: '本地指令演示' }, now: new Date().toISOString(), familyDay: '2026-11-15' }), 0);
        } else if (entry.url === '/api/parent/challenge') {
          realTimeout(() => respond(entry, 200, { challengeId: 'qa-challenge-' + entry.id, method: 'pin', expiresAt: new Date(Date.now() + 120000).toISOString() }), 0);
        } else if (entry.url === '/api/parent/verify') {
          realTimeout(() => respond(entry, entry.body.answer === '246810' ? 200 : 403,
            entry.body.answer === '246810' ? { grant: 'qa-grant-' + entry.id, expiresAt: new Date(Date.now() + 120000).toISOString() } : { error: '核验失败', code: 'VERIFICATION_FAILED' }), 0);
        }
      };
      this.abort = () => {
        const entry = requests.find(item => item.xhr === this);
        if (entry && !entry.settled) { entry.settled = true; if (this.onabort) { this.onabort(); } }
      };
    }
    window.XMLHttpRequest = ControlledXHR;
  });
  await page.goto(options.file ? pathToFileURL(path.join(B.ROOT, 'index.html')).href : env.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.FamilyDemo);
  const requests = async (method, url) => (await page.evaluate(() => window.__qaRequests()))
    .filter(entry => (!method || entry.method === method) && (!url || entry.url === url));
  const gets = () => requests('GET', '/api/state');
  const posts = () => requests('POST', '/api/action');
  const challenges = () => requests('POST', '/api/parent/challenge');
  const respond = async (request, status, body) => {
    assert.ok(request, 'The expected request must exist');
    if(body&&body.state&&Number.isInteger(body.revision)&&!Object.hasOwn(body,'familyDay'))body={...body,familyDay:'2026-11-15'};
    await page.evaluate((id, responseStatus, responseBody) => window.__qaRespond(id, responseStatus, responseBody), request.id, status, body);
    await delay(50);
  };
  const timeout = async request => { await page.evaluate(id => window.__qaTimeout(id), request.id); await delay(50); };
  const poll = async () => { await page.evaluate(() => window.__qaPoll()); await delay(30); };
  const storedState = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), STATE_KEY);
  const initial = () => ({ revision: 1, state: Model.createSeed(new Date(FIXTURE_TIME)) });
  const connect = async (snapshot = initial()) => {
    await respond((await gets())[0], 200, snapshot);
    assert.equal((await ui(page)).connected, true);
    return snapshot;
  };
  const accept = async (request, snapshot) => {
    if (request.body.revision !== snapshot.revision) { await respond(request, 409, snapshot); return snapshot; }
    const nextState = Model.apply(snapshot.state, request.body.action, new Date(FIXTURE_TIME));
    const next = nextState === snapshot.state ? snapshot : { revision: snapshot.revision + 1, state: nextState };
    await respond(request, 200, next);
    return next;
  };
  async function submitAward() {
    if (!(await page.$('#parent-form'))) { await click(page, SELECTORS.submit, { scroll: false }); }
    await page.waitForSelector(SELECTORS.answer);
    await verify(page, PIN);
    await delay(50);
    return (await posts()).at(-1);
  }
  return { ...env, page, requests, gets, posts, challenges, respond, timeout, poll, storedState, initial, connect, accept, submitAward };
}
function regression(id, title, run) {
  test(id + ' ' + title, { timeout: 45000 }, async () => {
    attempted.push(id);
    const app = await client(id === 'C2' ? { file: true } : {});
    try { await run(app); assert.deepEqual(app.errors, []); completed.push(id); }
    catch (error) { await B.capture(app.page, 'client-' + id + '-failure', EVIDENCE_VERSION).catch(() => {}); throw error; }
    finally { await app.close(); }
  });
}

regression('C1', 'HTTP startup and failed sync block writes while retaining a usable draft', async app => {
  const { page } = app;
  const before = await state(page);
  await navigate(page, 'reminders');
  await click(page, action('task-toggle', 'task-reading'));
  assert.deepEqual(await state(page), before);
  assert.deepEqual(await app.storedState(), before);
  assert.equal((await app.posts()).length, 0);
  await app.timeout((await app.gets())[0]);
  await navigate(page, 'points');
  await openCredit(page);
  await click(page, SELECTORS.submit, { scroll: false });
  assert.deepEqual(await state(page), before);
  assert.equal((await app.posts()).length, 0);
  assert.equal((await app.challenges()).length, 0, 'No protected operation is authorized before initial state sync');
  assert.equal(await page.$eval('[name="reason"]', element => element.value), '主动分享今天读到的故事');
  await app.poll();
  assert.equal((await app.gets()).length, 2);
  await app.respond((await app.gets())[1], 200, app.initial());
  await click(page, SELECTORS.submit, { scroll: false });
  if (!(await page.$('#parent-form'))) {
    assert.equal((await app.posts()).length, 0);
    assert.ok(await page.$eval('#form-error', element => element.textContent.trim()), 'Refreshing a startup draft must visibly request review');
  }
  const submitted = await app.submitAward();
  assert.equal((await app.posts()).length, 1);
  assert.equal(submitted.body.revision, 1);
});

regression('C2', 'file mode still permits local public actions without any network request', async app => {
  const { page } = app;
  await navigate(page, 'reminders');
  const before = await totals(page);
  await click(page, action('task-toggle', 'task-reading'));
  assert.equal((await state(page)).tasks.find(task => task.id === 'task-reading').done, true);
  assert.equal((await app.storedState()).tasks.find(task => task.id === 'task-reading').done, true);
  assert.deepEqual(await totals(page), before);
  assert.equal((await app.requests()).length, 0);
});

regression('C3', 'polling remains single-flight and releases the lock on success and timeout', async app => {
  await app.poll(); await app.poll();
  assert.equal((await app.gets()).length, 1);
  await app.connect();
  await app.poll(); await app.poll();
  assert.equal((await app.gets()).length, 2);
  await app.timeout((await app.gets())[1]);
  await app.poll(); assert.equal((await app.gets()).length, 3);
  await app.respond((await app.gets())[2], 200, app.initial());
  await app.poll(); assert.equal((await app.gets()).length, 4);
});

regression('C4', 'a delayed older GET cannot roll back a successful public POST in memory/storage', async app => {
  const { page } = app;
  const initial = await app.connect();
  await app.poll(); const delayed = (await app.gets())[1];
  await navigate(page, 'reminders');
  await click(page, action('task-toggle', 'task-reading'));
  const current = await app.accept((await app.posts())[0], initial);
  assert.equal(current.revision, 2);
  await app.respond(delayed, 200, initial);
  assert.equal((await ui(page)).connected, true, 'A valid older response is ignored without falsely disconnecting');
  assert.equal((await ui(page)).revision, 2);
  assert.equal((await state(page)).tasks.find(task => task.id === 'task-reading').done, true);
  assert.equal((await app.storedState()).tasks.find(task => task.id === 'task-reading').done, true);
  await app.poll(); assert.equal((await app.gets()).length, 3);
});

regression('C5', 'a synced gift-price change requires visible reconfirmation before a protected approval', async app => {
  const { page } = app;
  const initial = app.initial();
  initial.state = Model.apply(initial.state, { id: 'child-request', type: 'redemption.request', rewardId: 'reward-pencil' }, new Date(FIXTURE_TIME));
  const requestId = initial.state.requests.find(item => item.status === 'pending').id;
  await app.connect(initial);
  await click(page, action('jump-rewards'));
  await click(page, '.sheet ' + action('redemption-approve', requestId));
  await fillForm(page, { note: '请选蓝色，留给周末一起用' });
  assert.match(await page.$eval('.sheet', element => element.textContent), /12/);
  const changed = { revision: 2, state: Model.apply(initial.state,
    { id: 'other-device-price', type: 'reward.save', reward: { id: 'reward-pencil', points: 60 } }, new Date(FIXTURE_TIME)) };
  await app.poll(); await app.respond((await app.gets())[1], 200, changed);
  await click(page, SELECTORS.submit, { scroll: false });
  assert.equal((await app.posts()).length, 0);
  assert.equal((await app.challenges()).length, 0, 'New price first needs explicit review, before a challenge');
  assert.equal((await totals(page)).spent, 40);
  assert.match(await page.$eval('.sheet', element => element.textContent), /60/);
  assert.ok(await page.$eval('#form-error', element => element.textContent.trim()));
  assert.equal(await page.$eval('[name="note"]', element => element.value), '请选蓝色，留给周末一起用');
  const submitted = await app.submitAward();
  assert.equal(submitted.body.revision, 2);
  assert.equal(submitted.body.action.type, 'redemption.approve');
  assert.equal(submitted.body.action.expectedPoints, 60);
  assert.equal(submitted.body.action.note, '请选蓝色，留给周末一起用');
  await app.accept(submitted, changed);
  assert.deepEqual(await totals(page), { earned: 128, spent: 100, available: 28 });
});

regression('C6', 'a committed response lost in transit is reconciled once and the next award is a new operation', async app => {
  const { page } = app;
  const initial = await app.connect();
  await openCredit(page);
  const first = await app.submitAward();
  const actionId = first.body.action.id;
  assert.ok(actionId);
  const committed = { revision: 2, state: Model.apply(initial.state, first.body.action, new Date(FIXTURE_TIME)) };
  await app.timeout(first);
  assert.equal((await totals(page)).earned, 128, 'A timeout cannot be displayed as success');
  await click(page, await page.$('#parent-form') ? SELECTORS.verify : SELECTORS.submit, { scroll: false });
  // A correct client may retry the same idempotent action directly or obtain a
  // new operation-bound challenge. Both must retain the exact action identity.
  if (await page.$(SELECTORS.answer)) { await verify(page); }
  await delay(50);
  const retry = (await app.posts()).at(-1);
  assert.notEqual(retry.id, first.id);
  assert.equal(retry.body.action.id, actionId);
  assert.equal(retry.body.revision, 1);
  await app.accept(retry, committed); // 409 carries the already committed action.
  if ((await ui(page)).form) {
    await click(page, await page.$('#parent-form') ? SELECTORS.verify : SELECTORS.submit, { scroll: false });
    if (await page.$(SELECTORS.answer)) { await verify(page); }
    await delay(50);
    const finalRetry = (await app.posts()).at(-1);
    if (finalRetry.id !== retry.id) {
      assert.equal(finalRetry.body.action.id, actionId);
      assert.equal(finalRetry.body.revision, 2);
      const accepted = await app.accept(finalRetry, committed);
      assert.equal(accepted.revision, 2);
    }
  }
  assert.equal((await totals(page)).earned, 133);
  assert.equal((await state(page)).points.filter(row => row.id === 'points-' + actionId).length, 1);
  await openCredit(page, { reason: '下一次明确的加分' });
  const next = await app.submitAward();
  assert.notEqual(next.body.action.id, actionId);
  assert.ok(next.body.grant);
});

regression('C8', 'a previously connected page visibly disconnects on failed/invalid polls and preserves drafts until recovery', async app => {
  const { page } = app;
  const snapshot = await app.connect();
  const before = await totals(page);
  await openCredit(page, { reason: '断线期间保留的具体原因' });
  for (const failure of ['timeout', '503', 'malformed']) {
    await app.poll();
    const poll = (await app.gets()).at(-1);
    if (failure === 'timeout') { await app.timeout(poll); }
    else { await app.respond(poll, failure === '503' ? 503 : 200, failure === '503' ? { error: 'Temporary upstream failure' } : { revision: 'bad', state: {} }); }
    assert.equal((await ui(page)).connected, false, failure + ' must mark the client disconnected');
    assert.match(await page.$eval('#connection-state', element => element.textContent), /中断|断开|未连接|连接失败/);
    assert.equal(await page.$eval('[name="reason"]', element => element.value), '断线期间保留的具体原因');
    await click(page, SELECTORS.submit, { scroll: false });
    assert.equal((await app.posts()).length, 0);
    assert.equal((await app.challenges()).length, 0);
    assert.deepEqual(await totals(page), before);
  }
  await app.poll(); await app.respond((await app.gets()).at(-1), 200, snapshot);
  assert.equal((await ui(page)).connected, true);
  assert.equal(await page.$eval('#connection-state', element => element.textContent.trim()), '');
  assert.equal(await page.$eval('[name="reason"]', element => element.value), '断线期间保留的具体原因');
  const request = await app.submitAward();
  await app.accept(request, snapshot); await B.noSheet(page);
  assert.equal((await totals(page)).earned, before.earned + 5);
});

regression('C7', 'an uncommitted conflict preserves the draft/id but renews revision-bound verification', async app => {
  const { page } = app;
  const initial = await app.connect();
  await openCredit(page);
  const first = await app.submitAward();
  const concurrent = { revision: 2, state: Model.apply(initial.state,
    { id: 'other-device-task', type: 'task.toggle', taskId: 'task-bag' }, new Date(FIXTURE_TIME)) };
  await app.accept(first, concurrent);
  assert.equal(await page.$eval('[name="reason"]', element => element.value), '主动分享今天读到的故事');
  const retry = await app.submitAward();
  assert.equal(retry.body.action.id, first.body.action.id);
  assert.equal(retry.body.revision, 2);
  assert.notEqual(retry.body.grant, first.body.grant);
  const challenges = await app.challenges();
  assert.equal(challenges.length, 2);
  assert.equal(challenges[1].body.revision, 2);
  const accepted = await app.accept(retry, concurrent);
  assert.equal(accepted.revision, 3);
  assert.equal((await totals(page)).earned, 133);
  assert.equal((await state(page)).tasks.find(task => task.id === 'task-bag').done, true);
});
