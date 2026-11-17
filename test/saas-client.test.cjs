'use strict';
// v14 browser-VM regressions; v13 evidence artifacts remain unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const M = require('../model.js');
const ROOT = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(ROOT, name), 'utf8');
const APP = source('app.js'), CLIENT = source('saas-client.js'), FARM = source('farm-ui.js');
const NOW = new Date('2026-11-16T08:00:00Z');
const copy = value => JSON.parse(JSON.stringify(value));
const USER = { id: 'user-one', email: 'owner@example.test', verified: true };
const FAMILIES = [{ id: 'family-a', name: '甲家庭', role: 'owner' }, { id: 'family-b', name: '乙家庭', role: 'owner' }];
function snapshot(familyId, revision = 1) {
  // Deliberately use the same object IDs/revision across families. Fixture creation is
  // outside the browser; any browser call to createSeed fails the SaaS test.
  const state = M.createSeed(NOW); state.childName = familyId === 'family-a' ? '甲私有孩子' : '乙私有孩子';
  return { state, revision, familyId, userId: USER.id, parent: { configured: true, method: 'pin' }, serverNow: NOW.toISOString(), familyDay: '2026-11-16' };
}
function harness(options = {}) {
  const documentEvents = {}, windowEvents = {}, xhrs = [], intervals = [], timeouts = [], readers = [], images = [], revoked = [], wake = [], audio = [], channels = [];
  const calls = { reads: [], writes: [], seed: 0, normalize: 0, disposed: 0, paused: 0, canvas: 0, recognitionAbort: 0, scenes: 0 };
  const elements = new Map();
  let document, elapsed = 100;
  const stored = options.stored || {};
  function element(id = '') {
    return { id, innerHTML: '', textContent: '', className: '', style: {}, scrollTop: 0, hidden: false, disabled: false,
      tagName: 'DIV', attributes: {}, parentNode: null, children: [],
      getAttribute(name) { return this.attributes[name] || null; }, setAttribute(name, value) { this.attributes[name] = value; },
      focus() { document.activeElement = this; }, querySelector() { return null; }, querySelectorAll() { return []; },
      appendChild(node) { if (node.parentNode) node.parentNode.removeChild(node); this.children.push(node); node.parentNode = this; }, removeChild(node) { this.children = this.children.filter(n => n !== node); node.parentNode = null; },
      replaceChild(node, old) { this.removeChild(old); this.appendChild(node); }, removeAttribute(name) { delete this.attributes[name]; },
      insertBefore(node) { this.appendChild(node); }, contains() { return false; }, getClientRects() { return []; },
      classList: { add() {}, remove() {} }
    };
  }
  document = {
    hidden: false, body: element('body'), documentElement: { style: { setProperty() {} } }, activeElement: null,
    addEventListener(name, fn) { (documentEvents[name] || (documentEvents[name] = [])).push(fn); },
    getElementById(id) { return elements.get(id) || null; }, querySelector() { return null; }, querySelectorAll() { return []; },
    createElement(tag) { const el = element(); if (tag === 'canvas') { calls.canvas++; el.getContext = () => ({ fillRect() {}, drawImage() {} }); el.toDataURL = () => 'data:image/jpeg;base64,ZmFrZQ=='; } return el; }
  };
  for (const id of ['app', 'toast', 'main', 'saas-title', 'saas-status', 'avatar-status', 'voice-status']) elements.set(id, element(id));
  for (const name of ['complete', 'points', 'redeem']) { const el = element('sound-' + name); el.pause = () => audio.push(name); el.play = () => ({ catch() {} }); elements.set(el.id, el); }
  class XHR {
    constructor() { xhrs.push(this); this.headers = {}; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(key, value) { this.headers[key] = value; }
    send(body) { this.body = body ? JSON.parse(body) : null; }
    // A deliberately uncooperative abort still allows a queued onload/ontimeout.
    // Epoch checks, not the browser's abort behavior, must suppress every effect.
    abort() { this.aborted = true; }
    respond(status, body) { this.status = status; this.responseText = JSON.stringify(body); this.onload(); }
  }
  class Reader { constructor() { readers.push(this); this.readyState = 0; } readAsArrayBuffer() { this.readyState = 1; } abort() { this.aborted = true; } }
  class Image { constructor() { images.push(this); this.naturalWidth = this.naturalHeight = 256; } }
  class Speech { start() {} abort() { calls.recognitionAbort++; if (this.onend) this.onend(); } }
  const storage = { getItem(key) { calls.reads.push(key); if (options.storageThrows) throw Error('blocked'); if (Object.hasOwn(stored, key)) return stored[key]; if (key === 'ttjf-saas-device-sound-v1' || key === 'ttjf-saas-auth-change-v1') return null; return JSON.stringify(options.cache || snapshot('family-a').state); }, setItem(key, value) { calls.writes.push([key, value]); if (options.storageThrows) throw Error('blocked'); stored[key] = value; if (options.onWrite) options.onWrite(key, value); } };
  class Channel { constructor(name) { this.name = name; channels.push(this); } postMessage(value) { if (options.onBroadcast) options.onBroadcast(value); } }
  const model = Object.assign({}, M, {
    createSeed() { calls.seed++; if (options.legacy) return M.createSeed(NOW); throw Error('SaaS tried to seed'); },
    normalize(value) { calls.normalize++; return M.normalize(value); }
  });
  const window = {
    __TTJF_SAAS__: !options.legacy, FamilyModel: model, performance: { now: () => elapsed }, innerWidth: 390, innerHeight: 844,
    localStorage: storage, location: { protocol: 'http:', hash: options.hash || '', pathname: '/', search: '' },
    history: { replaceState(unused, title, url) { window.location.hash = ''; window.replacedURL = url; } },
    addEventListener(name, fn) { (windowEvents[name] || (windowEvents[name] = [])).push(fn); },
    BroadcastChannel: Channel, SpeechRecognition: Speech, requestAnimationFrame(fn) { fn(); }, matchMedia() { return { matches: false }; },
    FamilyFarmScene: { mount() { calls.scenes++; return { pause() { calls.paused++; }, update() {}, resize() {}, dispose() {}, diagnostics() { return {}; } }; } }
  };
  const context = { window, document, location: window.location, localStorage: storage, XMLHttpRequest: XHR, FileReader: Reader, Image,
    navigator: { wakeLock: { request() { return { then(resolve, reject) { wake.push({ resolve, reject }); } }; } } },
    URL: { createObjectURL() { return 'blob:private-' + images.length; }, revokeObjectURL(url) { revoked.push(url); } },
    Uint8Array, Date, console, Blob: class {}, setTimeout(fn) { timeouts.push(fn); return timeouts.length; }, clearTimeout() {},
    setInterval(fn) { intervals.push(fn); return intervals.length; }, clearInterval() {} };
  vm.createContext(context);
  vm.runInContext(CLIENT, context, { filename: 'saas-client.js' });
  vm.runInContext(FARM, context, { filename: 'farm-ui.js' });
  const originalDispose = window.FamilyFarmUI.dispose;
  window.FamilyFarmUI.dispose = function () { calls.disposed++; originalDispose(); };
  // Expose existing functions for invoking asynchronous browser entry points; do
  // not bypass bootstrap or replace any application implementation.
  const marker = "  if (!M) { document.getElementById('app').innerHTML";
  assert.equal(APP.indexOf(marker), APP.lastIndexOf(marker));
  new vm.Script(APP, { filename: 'app.js' });
  const hook = `window.__v13 = { request: request, sync: sync, loadMeta: loadMeta, action: beginAction, open: openForm,
    today: today, clock: clock, niceDate: niceDate, niceTime: niceTime, due: dueTasks, makeAction: makeAction, playStatus: playStatus,
    avatar: loadAvatar, ai: contextualInterpret, wake: displayMode, listen: listen, parent: submitParent,
    get: function () { return { state: state, revision: revision, pending: pending, retry: retryTx, setup: setupTx,
      privateConfig: privateConfig, drafts: drafts, ui: ui, meta: meta, familyDay: familyDay, serverTime: serverTime, serverReceived: serverReceived, reminderSound: reminderSound }; }
  };\n`;
  vm.runInContext(APP.replace(marker, hook + marker), context, { filename: 'app.js' });
  function emit(events, name, event = {}) { for (const fn of events[name] || []) fn(event); }
  function click(action, id, business) { const el = element(); el.tagName = 'BUTTON'; el.attributes[business ? 'data-action' : 'data-saas'] = action; if (id) el.attributes['data-id'] = id; emit(documentEvents, 'click', { target: el, preventDefault() {} }); }
  function submit(kind, values) { const el = element('saas-form'); el.attributes['data-saas-form'] = kind; el.elements = Object.entries(values).map(([name, value]) => ({ name, value })); el.checkValidity = () => true; emit(documentEvents, 'submit', { target: el, preventDefault() {} }); }
  function pending(url, method) { return xhrs.filter(x => x.url === url && (!method || x.method === method)).at(-1); }
  function session(verified = true, list = FAMILIES, userId = USER.id, token = 'csrf-' + userId) { pending('/api/session').respond(200, { authenticated: true, user: { ...USER, id: userId, verified }, families: list, csrfToken: token }); }
  function family(id = 'family-a') { click('select-family', id); const x = pending('/api/state'); x.respond(200, snapshot(id)); const meta = pending('/api/meta'); if (meta && !meta.aborted) meta.respond(200, { familyId: id, userId: USER.id, revision: 1, parent: { configured: true, method: 'pin' } }); }
  function login() { session(); family(); }
  return { window, document, elements, element, stored, channels, advance: ms => { elapsed += ms; }, xhrs, calls, intervals, timeouts, readers, images, revoked, wake, audio, click, submit, pending, session, family, login,
    api: window.__v13, emitDocument: (name, event) => emit(documentEvents, name, event), emitWindow: (name, event) => emit(windowEvents, name, event),
    html: () => elements.get('app').innerHTML, state: () => copy(window.FamilyDemo.getState()), ui: () => copy(window.FamilyDemo.getUI()) };
}

test('v13 auth-first bootstrap never reads origin business caches or creates a seed, even when storage throws', () => {
  for (const storageThrows of [false, true]) {
    const h = harness({ storageThrows });
    assert.equal(h.state(), null);
    assert.deepEqual(h.calls.reads, ['ttjf-saas-auth-change-v1']); assert.deepEqual(h.calls.writes, []); assert.equal(h.calls.seed, 0); assert.equal(h.calls.normalize, 0);
    assert.deepEqual(h.xhrs.map(x => x.url), ['/api/session']);
    h.pending('/api/session').respond(200, { authenticated: false });
    assert.match(h.html(), /登录/); assert.doesNotMatch(h.html(), /甲私有孩子/);
    h.intervals.forEach(fn => fn()); h.window.FamilyFarmUI.tick(); h.emitWindow('pageshow', { persisted: false });
    assert.equal(h.xhrs.length, 1); assert.equal(h.calls.scenes, 0);
  }
});

test('v13 registration waits for email, unverified login cannot load or create a family, fragments require explicit POST', () => {
  const h = harness(); h.pending('/api/session').respond(200, { authenticated: false });
  h.click('register'); h.submit('register', { email: 'new@example.test', password: 'Password-test-13', confirmPassword: 'Password-test-13' });
  h.pending('/api/auth/register').respond(202, { ok: true });
  assert.equal(h.window.FamilySaas.status().view, 'pending'); assert.equal(h.state(), null);
  assert.equal(h.xhrs.filter(x => x.url === '/api/state').length, 0);
  h.click('login'); h.submit('login', { email: 'new@example.test', password: 'Password-test-13' });
  h.pending('/api/auth/login').respond(200, { authenticated: true, user: { ...USER, verified: false }, families: [], csrfToken: 'csrf-unverified' });
  assert.equal(h.window.FamilySaas.status().view, 'unverified'); h.click('create'); assert.equal(h.window.FamilySaas.status().view, 'unverified');
  h.click('resend'); assert.equal(h.pending('/api/auth/resend-verification').headers['X-CSRF-Token'], 'csrf-unverified');
  for (const kind of ['verify', 'reset', 'invite']) {
    const f = harness({ hash: '#' + kind + '=private-token' });
    assert.equal(f.window.location.hash, ''); assert.equal(f.window.replacedURL, '/');
    assert.equal(f.xhrs.length, 1); assert.equal(f.xhrs[0].method, 'GET'); assert.doesNotMatch(f.html(), /private-token/);
    f.pending('/api/session').respond(200, { authenticated: false });
    if (kind === 'verify') { f.click('verify'); assert.equal(f.pending('/api/auth/verify-email').body.token, 'private-token'); }
    else if (kind === 'reset') { f.submit('reset', { password: 'Password-reset-13', confirmPassword: 'Password-reset-13' }); assert.equal(f.pending('/api/auth/reset-password').body.token, 'private-token'); }
    else assert.equal(f.window.FamilySaas.status().view, 'login');
  }
});

test('v13 empty-account create retries use one requestId and never initialize local data', () => {
  const h = harness(); h.session(true, []); assert.equal(h.window.FamilySaas.status().view, 'onboarding');
  h.click('create'); h.submit('create', { name: '新家庭', childName: '小星' });
  const first = h.pending('/api/families'); assert.equal(first.headers['X-CSRF-Token'], 'csrf-user-one');
  first.ontimeout(); h.submit('create', { name: '新家庭', childName: '小星' });
  assert.equal(h.pending('/api/families').body.requestId, first.body.requestId);
  assert.equal(h.state(), null); assert.equal(h.calls.seed, 0); assert.deepEqual(h.calls.reads, ['ttjf-saas-auth-change-v1']);
});

test('v13 every business request has scope headers and all late success, conflict, 401 and timeout effects are ignored', () => {
  for (const code of [200, 409, 401, 0]) {
    const h = harness(); h.login(); let effects = 0;
    const urls = ['/api/state', '/api/meta', '/api/parent/challenge', '/api/parent/verify', '/api/action', '/api/assistant'];
    const held = urls.map(url => { h.api.request(url === '/api/state' || url === '/api/meta' ? 'GET' : 'POST', url, url === '/api/state' || url === '/api/meta' ? null : { action: { id: 'same-id', type: 'parent.setup' } }, () => { effects++; }); return h.pending(url); });
    held.forEach(x => { assert.equal(x.headers['X-Family-ID'], 'family-a'); if (x.method === 'POST') assert.equal(x.headers['X-CSRF-Token'], 'csrf-user-one'); });
    h.window.FamilySaas.openSettings(); assert.equal(h.state(), null); h.family('family-b');
    const before = h.html(), scope = copy(h.window.FamilySaas.status());
    held.forEach(x => { assert.equal(x.aborted, true); if (code === 0) x.ontimeout(); else x.respond(code, { ...snapshot('family-a'), code: code === 401 ? 'AUTH_REQUIRED' : 'CONFLICT', grant: 'old-grant' }); });
    assert.equal(effects, 0); assert.equal(h.state().childName, '乙私有孩子'); assert.equal(h.html(), before);
    assert.deepEqual(copy(h.window.FamilySaas.status()), scope); assert.equal(h.ui().pending, false);
    assert.ok(h.calls.reads.every(key => key === 'ttjf-saas-device-sound-v1' || key === 'ttjf-saas-auth-change-v1')); assert.deepEqual(h.calls.writes, []);
  }
});

test('v13 actual action conflict and old state response cannot mutate new family revision, locks or feedback', () => {
  const h = harness(); h.login(); h.api.sync(); const get = h.pending('/api/state');
  const taskId = h.state().tasks[0].id;
  h.api.action({ type: 'task.toggle', taskId, id: 'same-action-id', done: true }, '甲反馈');
  const post = h.pending('/api/action'); assert.equal(h.ui().pending, true);
  h.window.FamilySaas.openSettings(); h.family('family-b'); const before = h.html();
  post.respond(409, { ...snapshot('family-a', 999), error: '旧冲突' }); get.respond(200, snapshot('family-a', 1000));
  assert.equal(h.state().childName, '乙私有孩子'); assert.equal(h.ui().revision, 1); assert.equal(h.ui().pending, false);
  assert.equal(h.api.get().retry, null); assert.equal(h.api.get().ui.auth, null); assert.equal(h.html(), before);
});

test('v13 current auth/membership failures erase state and foreign envelopes never reach app callbacks', () => {
  for (const failure of [[401, 'AUTH_REQUIRED'], [403, 'EMAIL_UNVERIFIED'], [403, 'FAMILY_FORBIDDEN']]) {
    const h = harness(); h.login(); h.api.open('points', { name: '私有草稿', points: 8, reason: '私有原因' });
    h.api.request('GET', '/api/state', null, () => assert.fail('unauthorized callback'));
    h.pending('/api/state').respond(failure[0], { code: failure[1] });
    assert.equal(h.state(), null); assert.equal(h.ui().ready, false); assert.doesNotMatch(h.html(), /甲私有孩子|私有草稿|私有原因/);
    assert.deepEqual(Object.keys(h.api.get().drafts), []); assert.equal(h.api.get().serverTime, 0); assert.equal(h.api.get().familyDay, null);
    assert.ok(h.calls.disposed >= 2); assert.equal(h.window.FamilySaas.status().view, 'checking');
  }
  const h = harness(); h.login(); let changed = false;
  h.api.request('GET', '/api/state', null, () => { changed = true; });
  h.pending('/api/state').respond(200, snapshot('family-b'));
  assert.equal(changed, false); assert.equal(h.state(), null); assert.equal(h.window.FamilySaas.status().view, 'error');
});

test('v13 late assistant/avatar and wake-lock results cannot affect another family, and resources are stopped', () => {
  const h = harness(); h.login();
  h.api.open('points', { aiText: '甲私有指令', name: '', points: 2 }); h.api.ai('points'); const ai = h.pending('/api/assistant');
  h.api.open('profile', { childName: '甲私有昵称', childAvatar: '' });
  h.api.avatar({ type: 'image/jpeg', size: 400, slice() { return {}; } });
  const reader = h.readers[0]; reader.result = new Uint8Array([255, 216, 255, 0]).buffer; reader.onload();
  const image = h.images[0], lateImage = image.onload;
  h.api.listen('speech'); h.api.wake();
  h.window.FamilySaas.openSettings(); h.family('family-b'); h.api.open('points', { aiText: '乙指令', name: '乙手动输入', points: 3 });
  const before = h.html(); ai.respond(200, { familyId: 'family-a', userId: USER.id, kind: 'action', action: { type: 'points.add', payload: { name: '甲AI内容', points: 20 } } });
  lateImage(); let released = 0; h.wake[0].resolve({ released: false, release() { released++; return { catch() {} }; }, addEventListener() {} });
  assert.equal(h.api.get().ui.form.data.name, '乙手动输入'); assert.equal(h.state().childName, '乙私有孩子'); assert.equal(h.html(), before);
  assert.equal(h.calls.canvas, 0); assert.equal(h.revoked.length, 1); assert.equal(reader.aborted, true); assert.equal(released, 1);
  assert.equal(h.calls.recognitionAbort, 1); assert.ok(h.audio.includes('complete')); assert.equal(h.ui().screenAwake, false);
});

test('v13 visibility/pageshow and cross-tab changes hide content before session recheck; farm and inherited interval stay gated', () => {
  const h = harness(); h.login(); h.document.hidden = true; h.emitDocument('visibilitychange');
  assert.equal(h.state(), null); assert.equal(h.window.FamilySaas.status().ready, false); const count = h.xhrs.length;
  h.intervals.forEach(fn => fn()); h.window.FamilyFarmUI.tick(); h.window.FamilyFarmUI.afterRender(); assert.equal(h.xhrs.length, count); assert.equal(h.calls.scenes, 0);
  h.document.hidden = false; h.emitWindow('pageshow', { persisted: true });
  assert.equal(h.pending('/api/session').url, '/api/session'); assert.equal(h.state(), null); assert.doesNotMatch(h.html(), /甲私有孩子/);
  const heldSession = h.pending('/api/session');
  h.emitWindow('storage', { key: 'ttjf-saas-auth-change-v1', newValue: 'random-non-pii-signal' });
  assert.equal(heldSession.aborted, true);
  heldSession.respond(200, { authenticated: true, user: USER, families: FAMILIES, csrfToken: 'stale-csrf' }); assert.equal(h.state(), null);
  h.pending('/api/session').respond(200, { authenticated: false }); assert.equal(h.window.FamilySaas.status().view, 'login');
});

test('v13 logout clears immediately, emits only opaque cross-tab signal and ignores old response', () => {
  const h = harness(); h.login(); h.api.sync(); const held = h.pending('/api/state');
  h.window.FamilySaas.logout(); assert.equal(h.state(), null); assert.equal(h.ui().ready, false);
  const logout = h.pending('/api/auth/logout'); assert.equal(logout.headers['X-CSRF-Token'], 'csrf-user-one');
  held.respond(200, snapshot('family-a')); logout.respond(200, { ok: true });
  assert.equal(h.window.FamilySaas.status().view, 'login'); assert.equal(h.state(), null);
  assert.ok(h.calls.writes.length >= 1);
  h.calls.writes.forEach(([key, value]) => { assert.equal(key, 'ttjf-saas-auth-change-v1'); assert.doesNotMatch(value, /user-one|family-a|@|私有|csrf/); });
});

test('v13 runtime flag is explicit and legacy bootstrap still accepts its local cache without account module', () => {
  const h = harness({ legacy: true }); assert.equal(h.window.FamilySaas, undefined);
  assert.ok(h.calls.reads.includes('little-steps-demo-v1')); assert.ok(h.state().tasks.length); assert.equal(h.calls.normalize, 1);
  assert.equal(h.xhrs.some(x => x.url === '/api/session'), false); assert.equal(h.pending('/api/state').headers['X-Family-ID'], undefined);
  const index = source('index.html'); const files = ['runtime.js', 'saas-client.js', 'model.js', 'farm-ui.js', 'app.js'];
  for (let i = 1; i < files.length; i++) assert.ok(index.indexOf('src="' + files[i - 1] + '"') < index.indexOf('src="' + files[i] + '"'));
  const runtime = { window: {} }; vm.runInNewContext(source('runtime.js'), runtime); assert.equal(runtime.window.__TTJF_SAAS__, false);
});

function hide(h) { h.document.hidden = true; h.emitDocument('visibilitychange'); }
function show(h) { h.document.hidden = false; h.emitDocument('visibilitychange'); }
function completeResume(h, revision = 1, mutate) { h.session(); const value = snapshot('family-a', revision); if (mutate) mutate(value.state); h.pending('/api/state').respond(200, value); }

test('v14 same-session recovery restores ordinary drafts only after fresh state and preserves conflict confirmation', () => {
  const h = harness(); h.login();
  h.api.open('points', { name: '待核对的草稿', points: 5, reason: '普通原因', pin: '123456', answer: '654321', grant: 'secret-grant', password: 'secret-password' });
  h.api.action({ type: 'points.add', name: '待核对的草稿', points: 5, reason: '普通原因' }, '已保存');
  const auth = h.api.get().ui.auth, challenge = h.pending('/api/parent/challenge'); assert.ok(auth);
  auth.autoPin = '123456'; auth.tx.grant = 'old-grant';
  const writesBefore = h.xhrs.filter(x => x.method !== 'GET').length;
  hide(h); assert.equal(h.state(), null); assert.equal(h.ui().auth, false); assert.equal(auth.autoPin, null); assert.equal(auth.tx.grant, null);
  assert.doesNotMatch(h.html(), /待核对的草稿|普通原因|123456|secret-password/);
  show(h); h.session(); assert.equal(h.state(), null); assert.equal(h.api.get().ui.form, null);
  const latest = snapshot('family-a', 7); latest.state.childName = '服务器新昵称'; h.pending('/api/state').respond(200, latest);
  const restored = h.api.get().ui.form; assert.equal(restored.data.name, '待核对的草稿'); assert.equal(restored.data.reason, '普通原因'); assert.equal(restored.openedRevision, 1);
  assert.doesNotMatch(JSON.stringify(h.api.get().drafts) + JSON.stringify(restored), /123456|654321|secret-grant|secret-password/);
  assert.equal(h.state().childName, '服务器新昵称'); assert.equal(h.ui().revision, 7); assert.equal(h.ui().auth, false); assert.equal(h.api.get().retry, null);
  challenge.respond(200, { ...snapshot('family-a'), challengeId: 'stale-challenge', method: 'pin' });
  assert.equal(h.xhrs.filter(x => x.method !== 'GET').length, writesBefore);
  h.api.action({ type: 'points.add', name: '待核对的草稿', points: 5, reason: '普通原因' }, '已保存');
  assert.equal(h.ui().auth, false); assert.equal(h.xhrs.filter(x => x.method !== 'GET').length, writesBefore); assert.equal(restored.openedRevision, 7);
});

test('v14 focus alone leaves input DOM intact and a same-scope cross-tab notification restores drafts', () => {
  const h = harness(); h.login(); h.api.open('task', { title: '尚未保存', date: '2026-11-17', type: 'event', remindDays: 7 });
  const form = h.api.get().ui.form, html = h.html(); h.emitWindow('focus'); assert.equal(h.api.get().ui.form, form); assert.equal(h.html(), html);
  h.session(); assert.equal(h.api.get().ui.form, form); assert.equal(h.html(), html);
  h.emitWindow('storage', { key: 'ttjf-saas-auth-change-v1', newValue: 'other-member-was-invited' });
  assert.equal(h.state(), null); completeResume(h, 2); assert.equal(h.api.get().ui.form.data.title, '尚未保存'); assert.equal(h.api.get().ui.form.openedRevision, 1);
  hide(h); show(h); const held = h.pending('/api/session'); hide(h); assert.equal(held.aborted, true); show(h); completeResume(h, 3); assert.equal(h.api.get().ui.form.data.title, '尚未保存');
});

test('v14 a changed session, user, family membership, or role discards the sealed draft', () => {
  for (const change of ['session', 'user', 'membership', 'role', 'logout']) {
    const h = harness(); h.login(); h.api.open('profile', { childName: '仅甲会话草稿', childAvatar: '' }); hide(h); show(h);
    if (change === 'logout') h.pending('/api/session').respond(200, { authenticated: false });
    else h.session(true, change === 'membership' ? [FAMILIES[1]] : change === 'role' ? [{ ...FAMILIES[0], role: 'parent' }, FAMILIES[1]] : FAMILIES, change === 'user' ? 'user-two' : USER.id, change === 'session' ? 'new-session-token' : change === 'user' ? 'csrf-user-two' : 'csrf-user-one');
    assert.equal(h.api.get().ui.form, null); assert.deepEqual(Object.keys(h.api.get().drafts), []);
    if (h.window.FamilySaas.status().view === 'loading-family') {
      const id = h.window.FamilySaas.status().familyId; h.pending('/api/state').respond(200, { ...snapshot(id), userId: h.window.FamilySaas.status().userId });
    }
    assert.equal(h.api.get().ui.form, null); assert.doesNotMatch(h.html(), /仅甲会话草稿/);
  }
});

test('v14 original photo input receives hidden picker results but cannot cross a session boundary', () => {
  for (const changed of [false, true]) {
    const h = harness(); h.login(); h.api.open('profile', { childName: '头像草稿', childAvatar: '' });
    const input = h.element('avatar-file'); input.tagName = 'INPUT'; input.type = 'file'; input.click = () => {}; h.elements.set(input.id, input); const holder = h.element('profile-input'); holder.appendChild(input);
    h.click('avatar-choose', '', true); hide(h); assert.equal(input.parentNode, h.document.body); assert.equal(input.hidden, true);
    input.files = [{ type: 'image/jpeg', size: 400, slice() { return {}; } }]; h.emitDocument('change', { target: input }); assert.equal(h.readers.length, 0);
    show(h); h.session(true, FAMILIES, USER.id, changed ? 'new-session' : 'csrf-user-one');
    const replacement = h.element('avatar-file'); holder.appendChild(replacement); h.document.querySelector = selector => selector === '#editor-form #avatar-file' ? replacement : null;
    h.pending('/api/state').respond(200, snapshot('family-a'));
    if (changed) { assert.equal(input.parentNode, null); h.emitDocument('change', { target: input }); assert.equal(h.readers.length, 0); assert.equal(h.api.get().ui.form, null); }
    else {
      assert.equal(input.parentNode, holder); assert.equal(input.hidden, false); assert.equal(h.readers.length, 1);
      const reader = h.readers[0]; reader.result = new Uint8Array([255, 216, 255, 0]).buffer; reader.onload(); h.images[0].onload();
      assert.match(h.api.get().ui.form.data.childAvatar, /^data:image\/jpeg;base64,/); assert.equal(h.api.get().ui.form.data.childName, '头像草稿');
      assert.equal(h.xhrs.some(x => x.url === '/api/action'), false);
    }
  }
});

test('v14 removed targets return safely while disabled maintenance drafts remain editable', () => {
  for (const kind of ['task', 'pointItem', 'reward']) {
    const h = harness(); h.login(); const list = kind === 'task' ? 'tasks' : kind === 'pointItem' ? 'pointItems' : 'rewards', item = copy(h.state()[list][0]);
    item.name = '维护草稿'; h.api.open(kind, item); hide(h); show(h); completeResume(h, 2, state => { state[list] = state[list].filter(row => row.id !== item.id); });
    assert.notEqual(h.ui().form, kind);
  }
  for (const kind of ['pointItem', 'reward']) {
    const h = harness(); h.login(); const list = kind === 'pointItem' ? 'pointItems' : 'rewards', item = copy(h.state()[list][0]); item.name = '重新启用前的修改'; item.enabled = false;
    h.api.open(kind, item); hide(h); show(h); completeResume(h, 2, state => { state[list].find(row => row.id === item.id).enabled = false; });
    assert.equal(h.ui().form, kind); assert.equal(h.api.get().ui.form.data.name, '重新启用前的修改'); assert.equal(h.api.get().ui.form.openedRevision, 1);
  }
});

test('v14 family lifecycle forms send canonical writes with CSRF and refresh session authority', () => {
  const cases = [
    { kind: 'rename-family', method: 'PATCH', suffix: '', body: { name: '新家庭名' } },
    { kind: 'transfer-owner', method: 'POST', suffix: '/transfer-owner', body: { userId: 'parent-two', currentPassword: 'Current-password-14' } },
    { kind: 'delete-family', method: 'DELETE', suffix: '', body: { name: '甲家庭', currentPassword: 'Current-password-14' } },
    { kind: 'leave-family', method: 'POST', suffix: '/leave', body: {} }
  ];
  for (const item of cases) {
    const h = harness(); h.session(true, item.kind === 'leave-family' ? [{ ...FAMILIES[0], role: 'parent' }, FAMILIES[1]] : FAMILIES); h.family(); h.window.FamilySaas.openSettings(); h.click('family-settings'); h.click(item.kind);
    if (item.kind === 'transfer-owner') h.pending('/api/families/family-a/members').respond(200, { members: [{ userId: 'parent-two', email: 'parent@example.test', role: 'parent', verified: true }] });
    if (item.kind === 'leave-family') h.click('confirm-leave'); else h.submit(item.kind, item.body);
    const request = h.pending('/api/families/family-a' + item.suffix, item.method); assert.ok(request); assert.deepEqual(request.body, item.body); assert.equal(request.headers['X-CSRF-Token'], 'csrf-user-one');
    const previousSession = h.pending('/api/session'); request.respond(200, { ok: true, family: { id: 'family-a', role: 'owner' } }); assert.notEqual(h.pending('/api/session'), previousSession); assert.equal(h.state(), null);
    h.session(true, item.kind === 'transfer-owner' ? [{ ...FAMILIES[0], role: 'parent' }] : []);
    if (item.kind === 'transfer-owner') { h.pending('/api/state').respond(200, snapshot('family-a')); assert.equal(h.window.FamilySaas.isOwner(), false); }
  }
  const h = harness(); h.session(false); h.click('delete-account'); h.submit('delete-account', { email: USER.email, currentPassword: 'Current-password-14' });
  const deletion = h.pending('/api/auth/delete-account'); assert.equal(deletion.headers['X-CSRF-Token'], 'csrf-user-one'); assert.equal(deletion.body.email, USER.email);
  deletion.respond(409, { code: 'ACCOUNT_OWNS_FAMILIES' }); assert.match(h.html(), /仍有家庭未移交或删除/); assert.doesNotMatch(h.html(), /Current-password-14/);
  h.submit('delete-account', { email: USER.email, currentPassword: 'Current-password-14' }); h.pending('/api/auth/delete-account').respond(200, { ok: true }); h.pending('/api/session').respond(200, { authenticated: false });
  assert.equal(h.window.FamilySaas.status().view, 'login'); assert.equal(h.state(), null);
});

test('v14 SaaS calendar, reminders, points timestamps and midnight follow Shanghai calibrated time', () => {
  const before = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles'; const h = harness(); h.login();
    assert.equal(h.api.today(), '2026-11-16'); assert.equal(h.api.clock(), '16:00'); assert.equal(h.api.niceTime('2026-11-16T08:00:00Z'), '11/16 16:00'); assert.equal(h.api.niceDate('2026-11-17'), '11月17日');
    const state = h.api.get().state; state.tasks = [{ id: 'due', type: 'task', title: '上海到点', date: '2026-11-16', time: '15:59', remindDays: 0, deleted: false, done: false, note: '', createdAt: NOW.toISOString() }, { id: 'later', type: 'task', title: '上海未到点', date: '2026-11-16', time: '16:01', remindDays: 0, deleted: false, done: false, note: '', createdAt: NOW.toISOString() }];
    assert.deepEqual(Array.from(h.api.due(), t => t.id), ['due']);
    const action = h.api.makeAction({ kind: 'points' }, { name: '校准时间', points: '5', reason: '', recordTime: '16:00' }); assert.equal(action.at, '2026-11-16T08:00:00.000Z');
    h.api.open('task', { id: 'due', type: 'event', title: '重要事件', date: '2026-11-16', time: '18:00', remindDays: 7 }); h.click('task-tomorrow', 'due', true);
    assert.equal(h.api.get().ui.form.data.type, 'event'); assert.equal(h.api.get().ui.form.data.remindDays, 7); assert.equal(h.api.get().ui.form.data.date, '2026-11-17');
    h.advance(8 * 3600 * 1000); assert.equal(h.api.today(), '2026-11-17'); assert.equal(h.api.clock(), '00:00'); assert.equal(h.api.playStatus().familyDay, '2026-11-17');
  } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
});

test('v14 only the nonprivate device sound boolean persists across refresh and logout stops playback', () => {
  const stored = {}, h = harness({ stored }); h.login(); h.click('sound', '', true); assert.equal(h.api.get().ui.sound, true); assert.equal(stored['ttjf-saas-device-sound-v1'], 'true');
  h.window.FamilySaas.logout(); assert.equal(h.api.get().ui.sound, false); assert.ok(h.audio.includes('complete')); h.pending('/api/auth/logout').respond(200, { ok: true });
  const refreshed = harness({ stored }); refreshed.login(); assert.equal(refreshed.api.get().ui.sound, true);
  assert.ok(refreshed.calls.reads.every(key => key === 'ttjf-saas-device-sound-v1' || key === 'ttjf-saas-auth-change-v1'));
  assert.ok(h.calls.writes.every(([key, value]) => key === 'ttjf-saas-device-sound-v1' ? value === 'true' || value === 'false' : key === 'ttjf-saas-auth-change-v1' && !/user|family|@|csrf/.test(value)));
  const blocked = harness({ storageThrows: true }); blocked.login(); blocked.click('sound', '', true); hide(blocked); show(blocked); completeResume(blocked); assert.equal(blocked.api.get().ui.sound, true);
});

const AUTH_SIGNAL = 'ttjf-saas-auth-change-v1';
function storageSignal(h, value) { h.emitWindow('storage', { key: AUTH_SIGNAL, newValue: value }); }
function bothSignals(h, value) { storageSignal(h, value); h.channels[0].onmessage({ data: value }); }
function tryResumeLocked(h) {
  h.emitWindow('focus'); hide(h); show(h); h.emitWindow('pageshow', { persisted: true }); h.window.FamilySaas.recheck();
  storageSignal(h, 'ordinary-account-notification'); h.click('retry-session'); h.click('select-family', 'family-a');
}

test('v14 logout-start keeps other tabs and reloads masked until matching settled, with no duplicate signal effects', () => {
  const stored = {}, observer = harness({ stored }); observer.login(); observer.api.open('profile', { childName: '退出时不能重现的草稿', childAvatar: '' });
  const initiator = harness({ stored, onWrite(key, value) { if (key === AUTH_SIGNAL) storageSignal(observer, value); }, onBroadcast(value) { observer.channels[0].onmessage({ data: value }); } }); initiator.login();
  initiator.window.FamilySaas.logout(); const start = stored[AUTH_SIGNAL], post = initiator.pending('/api/auth/logout');
  assert.match(start, /^logout-start:/); assert.equal(post.headers['X-CSRF-Token'], 'csrf-user-one'); assert.equal(observer.window.FamilySaas.status().view, 'logout-wait');
  assert.equal(observer.window.FamilySaas.status().userId, null); assert.equal(observer.state(), null); assert.doesNotMatch(observer.html(), /甲私有孩子|退出时不能重现的草稿/);
  const requestCount = observer.xhrs.length, epoch = observer.window.FamilySaas.status().epoch; tryResumeLocked(observer); bothSignals(observer, start);
  assert.equal(observer.xhrs.length, requestCount); assert.equal(observer.window.FamilySaas.status().epoch, epoch); assert.equal(observer.state(), null);
  const reloaded = harness({ stored }); assert.equal(reloaded.xhrs.length, 0); assert.equal(reloaded.window.FamilySaas.status().view, 'logout-wait');
  hide(initiator); assert.notEqual(post.aborted, true); post.respond(200, { ok: true });
  assert.equal(observer.xhrs.length, requestCount + 1); observer.pending('/api/session').respond(200, { authenticated: false });
  const settled = stored[AUTH_SIGNAL]; assert.equal(settled, start.replace('logout-start:', 'logout-settled:'));
  bothSignals(observer, start); bothSignals(observer, settled); assert.equal(observer.xhrs.length, requestCount + 1); assert.equal(observer.window.FamilySaas.status().view, 'login'); assert.deepEqual(Object.keys(observer.api.get().drafts), []);
  bothSignals(reloaded, settled); reloaded.pending('/api/session').respond(200, { authenticated: false }); assert.equal(reloaded.window.FamilySaas.status().view, 'login');
});

test('v14 failed or unknown logout remains locked and explicit retries fetch CSRF without restoring a family', () => {
  for (const currentSession of ['active', 'expired', 'invalid']) {
    const stored = {}, h = harness({ stored }); h.login(); h.api.open('profile', { childName: '绝不能恢复', childAvatar: '' }); h.window.FamilySaas.logout(); h.pending('/api/auth/logout').ontimeout();
    assert.match(stored[AUTH_SIGNAL], /^logout-failed:/); const requests = h.xhrs.length; tryResumeLocked(h); assert.equal(h.xhrs.length, requests); assert.equal(h.state(), null); assert.equal(h.window.FamilySaas.status().view, 'logout-error');
    const retry = harness({ stored }); assert.equal(retry.xhrs.length, 0); assert.match(retry.html(), /重试退出/); retry.click('logout'); assert.deepEqual(retry.xhrs.map(x => x.url), ['/api/session']);
    if (currentSession === 'expired') retry.pending('/api/session').respond(200, { authenticated: false });
    else if (currentSession === 'invalid') { retry.pending('/api/session').respond(200, {}); assert.equal(retry.window.FamilySaas.status().view, 'logout-error'); assert.match(stored[AUTH_SIGNAL], /^logout-failed:/); retry.click('logout'); retry.pending('/api/session').respond(200, { authenticated: false }); }
    else { retry.session(); assert.equal(retry.state(), null); assert.equal(retry.window.FamilySaas.status().userId, null); assert.doesNotMatch(retry.html(), /甲家庭|甲私有孩子|绝不能恢复/); assert.equal(retry.pending('/api/auth/logout').headers['X-CSRF-Token'], 'csrf-user-one'); retry.pending('/api/auth/logout').respond(401, { code: 'AUTH_REQUIRED' }); }
    assert.equal(retry.window.FamilySaas.status().view, 'login'); assert.equal(retry.xhrs.some(x => x.url === '/api/state'), false); assert.match(stored[AUTH_SIGNAL], /^logout-settled:/);
  }
});

test('v14 simultaneous logout converges on one live request and stale notifications cannot unlock it', () => {
  const stored = {}, left = harness({ stored }), right = harness({ stored }); left.login(); right.login();
  left.window.FamilySaas.logout(); const first = stored[AUTH_SIGNAL]; right.window.FamilySaas.logout(); const second = stored[AUTH_SIGNAL];
  const winner = first > second ? left : right, loser = winner === left ? right : left, winSignal = first > second ? first : second, loseSignal = first > second ? second : first;
  bothSignals(left, second); bothSignals(right, first);
  assert.notEqual(winner.pending('/api/auth/logout').aborted, true); assert.equal(loser.pending('/api/auth/logout').aborted, true);
  const count = loser.xhrs.length; bothSignals(loser, loseSignal.replace('logout-start:', 'logout-settled:')); bothSignals(winner, loseSignal.replace('logout-start:', 'logout-failed:'));
  assert.equal(loser.xhrs.length, count); assert.equal(winner.window.FamilySaas.status().view, 'logout'); assert.equal(loser.state(), null);
  loser.pending('/api/auth/logout').respond(200, { ok: true }); assert.equal(loser.xhrs.length, count);
  winner.pending('/api/auth/logout').respond(401, { code: 'AUTH_REQUIRED' }); const settled = stored[AUTH_SIGNAL]; assert.equal(settled, winSignal.replace('logout-start:', 'logout-settled:'));
  bothSignals(loser, settled); loser.pending('/api/session').respond(200, { authenticated: false }); bothSignals(loser, loseSignal); bothSignals(winner, loseSignal);
  assert.equal(left.window.FamilySaas.status().view, 'login'); assert.equal(right.window.FamilySaas.status().view, 'login');
});

test('v14 BroadcastChannel logout lock still works when localStorage is blocked', () => {
  const observer = harness({ storageThrows: true }); observer.login(); const initiator = harness({ storageThrows: true, onBroadcast(value) { observer.channels[0].onmessage({ data: value }); } }); initiator.login();
  initiator.window.FamilySaas.logout(); const requests = observer.xhrs.length; tryResumeLocked(observer); assert.equal(observer.xhrs.length, requests); assert.equal(observer.state(), null);
  initiator.pending('/api/auth/logout').respond(200, { ok: true }); observer.pending('/api/session').respond(200, { authenticated: false }); assert.equal(observer.window.FamilySaas.status().view, 'login');
});


