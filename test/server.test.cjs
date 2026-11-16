'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('../server.cjs');
const Model = require('../model.js');
const NOW = new Date(2026, 10, 14, 12, 30, 0);
const PIN = '246810';
const PNG_AVATAR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMImBYAAAJwATedyl3YAAAAAElFTkSuQmCC';
// Add a standards-compliant PNG tEXt chunk, keeping a real 1x1 image while
// exercising the avatar/transport limits without allocating a giant bitmap.
function largePngAvatar(textBytes) {
  const image = Buffer.from(PNG_AVATAR.split(',')[1], 'base64');
  const data = Buffer.from('Test\0' + 'x'.repeat(textBytes), 'ascii');
  const type = Buffer.from('tEXt', 'ascii');
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([type, data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) { crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  }
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return 'data:image/png;base64,' + Buffer.concat([image.subarray(0, -12), chunk, image.subarray(-12)]).toString('base64');
}
const localAssistant = () => ({ status: () => ({ mode: 'local', label: '指令演示' }),
  interpret: async () => ({ kind: 'clarify', message: '请补充具体内容' }) });

function request(server, method, pathname, options = {}) {
  const body = options.raw !== undefined ? options.raw : (options.body === undefined ? undefined : JSON.stringify(options.body));
  const headers = Object.assign({}, body === undefined ? {} : { 'Content-Type': 'application/json' }, options.headers);
  if (body !== undefined && !options.chunked) { headers['Content-Length'] = Buffer.byteLength(body); }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: pathname, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let value = text;
        try { value = JSON.parse(text); } catch (_) { /* static response */ }
        resolve({ status: res.statusCode, headers: res.headers, body: value, text });
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('test request timeout')));
    req.on('error', reject);
    req.end(body);
  });
}
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
}
function close(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) { return resolve(); }
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
}
async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'family-dashboard-test-'));
  const rootDir = path.join(directory, 'public');
  const dataFile = path.join(rootDir, 'data', 'state.json');
  fs.mkdirSync(path.join(rootDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'index.html'), '<!doctype html><title>Family</title>');
  for (const name of ['app.js', 'model.js', 'assistant.js', 'pet.js']) { fs.writeFileSync(path.join(rootDir, name), 'window.testLoaded = true;'); }
  for (const name of ['styles.css', 'pet.css']) { fs.writeFileSync(path.join(rootDir, name), 'body { margin: 0; }'); }
  fs.writeFileSync(path.join(rootDir, 'assets', 'star.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  fs.writeFileSync(path.join(rootDir, 'secret.txt'), 'private');
  fs.writeFileSync(path.join(rootDir, 'assets', 'private.json'), '{"private":true}');
  const config = Object.assign({ rootDir, dataFile, now: () => NOW, parentPin: PIN, assistantService: localAssistant() }, options);
  const server = createServer(config);
  t.after(async () => {
    await close(server);
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('family-dashboard-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await listen(server);
  return { server, directory, rootDir, dataFile, config };
}
const state = server => request(server, 'GET', '/api/state');
const post = (server, pathname, body, headers) => request(server, 'POST', pathname, { body, headers });
const credit = (id, points = 5) => ({ id, type: 'points.add', name: '阅读', points, reason: '主动分享故事' });
const challenge = (server, action, revision = 1) => post(server, '/api/parent/challenge', { revision, action });
const verify = (server, challengeId, answer = PIN) => post(server, '/api/parent/verify', { challengeId, answer });
async function authorize(server, action, revision = 1, answer = PIN) {
  const started = await challenge(server, action, revision);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const checked = await verify(server, started.body.challengeId, answer);
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  return checked.body.grant;
}
async function submit(server, action, revision = 1, answer = PIN) {
  const grant = await authorize(server, action, revision, answer);
  return post(server, '/api/action', { revision, action, grant });
}
function mathAnswer(challengeBody) {
  const match = /^(\d+) \+ (\d+) = \?$/.exec(challengeBody.question);
  assert.ok(match, 'a randomly generated addition question is displayed');
  return String(Number(match[1]) + Number(match[2]));
}
function publicSnapshot(envelope) { return { revision: envelope.revision, state: envelope.state, familyDay: Model.dateKey(NOW), parent: { configured: envelope.parent.configured, method: envelope.parent.method } }; }

test('initial state and metadata expose only public fields, while one private envelope persists hashes', async t => {
  const f = await fixture(t);
  assert.deepEqual((await request(f.server, 'GET', '/api/health')).body, { ok: true, revision: 1 });
  const snapshot = await state(f.server);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.headers['cache-control'], 'no-store');
  assert.deepEqual(Model.totals(snapshot.body.state), { earned: 128, spent: 40, available: 88 });
  const saved = JSON.parse(fs.readFileSync(f.dataFile, 'utf8'));
  assert.deepEqual(publicSnapshot(saved), snapshot.body);
  assert.equal(saved.parent.method, 'pin');
  assert.match(saved.parent.salt, /^[a-f0-9]{32}$/);
  assert.match(saved.parent.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(saved.receipts, {});
  assert.ok(!fs.readFileSync(f.dataFile, 'utf8').includes('"' + PIN + '"'));
  assert.deepEqual(snapshot.body.parent, { configured: true, method: 'pin' });
  assert.equal(snapshot.body.receipts, undefined);
  const meta = await request(f.server, 'GET', '/api/meta');
  assert.deepEqual(meta.body, { revision: 1, parent: { configured: true, method: 'pin' }, assistant: { mode: 'local', label: '指令演示' }, now: NOW.toISOString(), familyDay: Model.dateKey(NOW) });
  const other = createServer(f.config);
  assert.equal(other.listening, false);
  await close(other);
});

test('every non-public action fails without a real grant and cannot change the file', async t => {
  const f = await fixture(t);
  const before = fs.readFileSync(f.dataFile, 'utf8');
  const commands = [credit('deny-credit'), { id: 'deny-redeem', type: 'reward.redeem', rewardId: 'reward-pencil' },
    { id: 'deny-approve', type: 'redemption.approve', requestId: 'request-any', expectedPoints: 12 },
    { id: 'deny-item', type: 'pointItem.save', item: { name: '测试', points: 3 } },
    { id: 'deny-reward', type: 'reward.save', reward: { name: '测试', points: 3 } },
    { id: 'deny-task', type: 'task.save', task: { title: '测试', date: '2026-11-14' } },
    { id: 'deny-delete', type: 'task.delete', taskId: 'task-reading' },
    { id: 'deny-restore', type: 'task.restore', taskId: 'task-reading' },
    { id: 'deny-setting', type: 'settings.update', settings: { monthEndDays: 1 } },
    { id: 'deny-profile', type: 'profile.update', childName: '小满', childAvatar: PNG_AVATAR },
    { id: 'deny-pet-buy', type: 'pet.buy', itemId: 'snack', quantity: 1, expectedPoints: 3 },
    { id: 'deny-parent', type: 'parent.configure', method: 'math' }];
  for (const action of commands) {
    const response = await post(f.server, '/api/action', { revision: 1, action });
    assert.equal(response.status, 403, action.type);
    assert.equal(response.body.code, 'PARENT_REQUIRED');
  }
  const forged = await post(f.server, '/api/action', { revision: 1, action: credit('forged'), grant: { parent: true, method: 'math' }, parentVerified: true });
  assert.equal(forged.status, 403);
  assert.equal(forged.body.code, 'GRANT_INVALID');
  assert.equal(fs.readFileSync(f.dataFile, 'utf8'), before);
});

test('the eight public actions work before parent setup without a grant and never award or spend points', async t => {
  const { server } = await fixture(t, { parentPin: undefined });
  let revision = 1;
  const actions = [
    { id: 'public-ack', type: 'task.ack', taskId: 'task-reading' },
    { id: 'public-snooze', type: 'task.snooze', taskId: 'task-reading', minutes: 10 },
    { id: 'public-toggle', type: 'task.toggle', taskId: 'task-reading', points: 999, parent: true },
    { id: 'public-request', type: 'redemption.request', rewardId: 'reward-pencil' },
    { id: 'public-cancel', type: 'redemption.cancel', requestId: 'request-public-request' },
    { id: 'public-pet', type: 'pet.configure', kind: 'capybara', name: '团团' },
    { id: 'public-care', type: 'pet.care', care: 'feed', source: 'free' },
    { id: 'public-scene', type: 'pet.scene', sceneId: 'home' }
  ];
  for (const action of actions) {
    const response = await post(server, '/api/action', { revision, action });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.revision, ++revision);
    assert.deepEqual(Model.totals(response.body.state), { earned: 128, spent: 40, available: 88 });
  }
  const snapshot = await state(server);
  assert.equal(snapshot.body.state.tasks[0].done, true);
  assert.equal(snapshot.body.state.requests[0].status, 'cancelled');
});

test('verified actions increment revision durably and are visible to another reader', async t => {
  const f = await fixture(t);
  const action = credit('award-1');
  const grant = await authorize(f.server, action);
  const origin = 'http://127.0.0.1:' + f.server.address().port;
  const response = await post(f.server, '/api/action', { revision: 1, action, grant }, { Origin: origin });
  assert.equal(response.status, 200);
  assert.equal(response.body.revision, 2);
  assert.equal(Model.totals(response.body.state).earned, 133);
  const disk = JSON.parse(fs.readFileSync(f.dataFile, 'utf8'));
  assert.deepEqual(publicSnapshot(disk), response.body);
  assert.match(disk.receipts['award-1'].digest, /^[a-f0-9]{64}$/);
  assert.deepEqual((await state(f.server)).body, response.body);
  assert.equal(fs.readdirSync(path.dirname(f.dataFile)).filter(name => name.endsWith('.tmp')).length, 0);
});

test('lost-response retries accept only the identical complete action, independent of key order or stale revision', async t => {
  const f = await fixture(t);
  const action = credit('award-1');
  const first = await submit(f.server, action);
  const before = fs.readFileSync(f.dataFile, 'utf8');
  const duplicate = await post(f.server, '/api/action', { revision: 1, action });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(duplicate.body, first.body);
  const reordered = { reason: action.reason, points: action.points, name: action.name, type: action.type, id: action.id };
  assert.equal((await post(f.server, '/api/action', { revision: 2, action: reordered })).status, 200);
  for (const changed of [credit('award-1', 50), Object.assign({}, action, { ignoredExtra: true }), { id: action.id, type: 'task.toggle', taskId: 'task-bag' }]) {
    const response = await post(f.server, '/api/action', { revision: 1, action: changed });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'ACTION_ID_REUSED');
  }
  assert.equal(fs.readFileSync(f.dataFile, 'utf8'), before);
  const stale = await post(f.server, '/api/action', { revision: 1, action: credit('new-action') });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body, first.body);
});

test('a grant is bound to the full action including id, amount, reason, optional fields and revision', async t => {
  const { server } = await fixture(t);
  const action = credit('bound');
  const grant = await authorize(server, action);
  for (const mutation of [{ id: 'other-id' }, { points: 99 }, { reason: '变更原因' }, { note: '新增字段' }, { type: 'reward.redeem', rewardId: 'reward-pencil' }]) {
    const response = await post(server, '/api/action', { revision: 1, action: Object.assign({}, action, mutation), grant });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'GRANT_INVALID');
  }
  assert.equal((await post(server, '/api/action', { revision: 2, action, grant })).status, 409);
  assert.equal((await post(server, '/api/action', { revision: 1, action, grant })).status, 200);
  assert.equal(Model.totals((await state(server)).body.state).earned, 133);
});

test('a successful verification cannot be replayed and its grant cannot authorize a second action', async t => {
  const { server } = await fixture(t);
  const action = credit('once');
  const started = await challenge(server, action);
  const verified = await verify(server, started.body.challengeId);
  assert.equal(verified.status, 200);
  assert.equal((await verify(server, started.body.challengeId)).status, 410);
  const first = await post(server, '/api/action', { revision: 1, action, grant: verified.body.grant });
  assert.equal(first.status, 200);
  const another = await post(server, '/api/action', { revision: 2, action: credit('twice'), grant: verified.body.grant });
  assert.equal(another.status, 403);
  assert.deepEqual((await state(server)).body, first.body);
  assert.equal((await post(server, '/api/action', { revision: 1, action, grant: verified.body.grant })).status, 200);
});

test('expired challenges and grants fail without writing, using the injectable clock', async t => {
  let time = NOW.getTime();
  const { server } = await fixture(t, { now: () => new Date(time) });
  const action = credit('expiring');
  const started = await challenge(server, action);
  assert.equal(Date.parse(started.body.expiresAt), time + 120000);
  time += 120001;
  const expired = await verify(server, started.body.challengeId);
  assert.equal(expired.status, 410);
  assert.equal(expired.body.code, 'CHALLENGE_EXPIRED');
  const grant = await authorize(server, action);
  time += 60001;
  const expiredGrant = await post(server, '/api/action', { revision: 1, action, grant });
  assert.equal(expiredGrant.status, 410);
  assert.equal(expiredGrant.body.code, 'GRANT_EXPIRED');
  assert.equal((await state(server)).body.revision, 1);
});

test('wrong-answer limits survive fresh challenges and forged forwarding headers', async t => {
  let time = NOW.getTime();
  const { server } = await fixture(t, { now: () => new Date(time) });
  const action = credit('rate-test');
  const first = await challenge(server, action);
  const second = await challenge(server, action);
  for (let i = 0; i < 3; i++) { assert.equal((await verify(server, first.body.challengeId, '000000')).status, 403); }
  assert.equal((await verify(server, first.body.challengeId, PIN)).status, 410);
  for (let i = 0; i < 2; i++) { assert.equal((await verify(server, second.body.challengeId, '000000')).status, 403); }
  const limited = await post(server, '/api/parent/verify', { challengeId: second.body.challengeId, answer: PIN }, { 'X-Forwarded-For': '203.0.113.44' });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'RATE_LIMITED');
  assert.ok(Number(limited.headers['retry-after']) > 0);
  assert.equal((await challenge(server, action)).status, 429);
  time += 300001;
  assert.ok(await authorize(server, action));
  assert.equal((await state(server)).body.revision, 1);
});

test('challenge creation is bounded even before verification', async t => {
  const { server } = await fixture(t);
  for (let i = 0; i < 20; i++) { assert.equal((await challenge(server, credit('limit-' + i))).status, 200); }
  const limited = await challenge(server, credit('limit-final'));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.retryAfter, 60);
});

test('parent configuration changes require the old method and persist no plaintext PIN or fast PIN receipt', async t => {
  const f = await fixture(t);
  const action = { id: 'new-parent-pin', type: 'parent.configure', method: 'pin', pin: '654321' };
  const updated = await submit(f.server, action);
  assert.equal(updated.status, 200);
  assert.deepEqual(Model.totals(updated.body.state), { earned: 128, spent: 40, available: 88 });
  const text = fs.readFileSync(f.dataFile, 'utf8');
  assert.ok(!text.includes('654321'));
  assert.ok(!text.includes('"' + PIN + '"'));
  assert.equal(JSON.parse(text).receipts[action.id].algorithm, 'scrypt');
  assert.equal(updated.body.state.parent, undefined);
  assert.equal(updated.body.state.settings.pin, undefined);
  assert.equal((await post(f.server, '/api/action', { revision: 1, action })).status, 200);
  const started = await challenge(f.server, credit('after-pin'), 2);
  assert.equal((await verify(f.server, started.body.challengeId, PIN)).status, 403);
  assert.equal((await verify(f.server, started.body.challengeId, '654321')).status, 200);
  await close(f.server);
  const restarted = createServer(Object.assign({}, f.config, { parentPin: '000000' }));
  t.after(() => close(restarted));
  await listen(restarted);
  const restartChallenge = await challenge(restarted, credit('after-restart'), 2);
  assert.equal((await verify(restarted, restartChallenge.body.challengeId, '000000')).status, 403);
  assert.equal((await verify(restarted, restartChallenge.body.challengeId, '654321')).status, 200);
});

test('math challenges use the saved method, reveal no answer and can authorize a method change only once', async t => {
  const { server } = await fixture(t);
  assert.equal((await submit(server, { id: 'choose-math', type: 'parent.configure', method: 'math' })).status, 200);
  assert.deepEqual((await request(server, 'GET', '/api/meta')).body.parent, { configured: true, method: 'math' });
  const action = { id: 'back-to-pin', type: 'parent.configure', method: 'pin' };
  const started = await challenge(server, action, 2);
  assert.equal(started.body.method, 'math');
  assert.deepEqual(Object.keys(started.body).sort(), ['challengeId', 'expiresAt', 'method', 'question']);
  assert.equal((await post(server, '/api/parent/verify', { challengeId: started.body.challengeId, answer: PIN, method: 'pin' })).status, 403);
  const verified = await verify(server, started.body.challengeId, mathAnswer(started.body));
  assert.equal(verified.status, 200);
  assert.equal((await post(server, '/api/action', { revision: 2, action, grant: verified.body.grant })).status, 200);
  assert.equal((await request(server, 'GET', '/api/meta')).body.parent.method, 'pin');
  assert.ok(await authorize(server, credit('original-pin-retained'), 3));
});

test('stale challenges and grants require a fresh confirmation after another device writes', async t => {
  const { server } = await fixture(t);
  const action = credit('stale-grant');
  const grant = await authorize(server, action);
  const pending = await challenge(server, credit('stale-challenge'));
  const concurrent = await post(server, '/api/action', { revision: 1, action: { id: 'other-device', type: 'task.toggle', taskId: 'task-bag' } });
  assert.equal(concurrent.status, 200);
  const oldVerify = await verify(server, pending.body.challengeId);
  assert.equal(oldVerify.status, 409);
  assert.deepEqual(oldVerify.body, concurrent.body);
  assert.equal((await post(server, '/api/action', { revision: 1, action, grant })).status, 409);
  const changedRevision = await post(server, '/api/action', { revision: 2, action, grant });
  assert.equal(changedRevision.status, 403);
  assert.equal(changedRevision.body.code, 'GRANT_INVALID');
  assert.equal((await submit(server, action, 2)).status, 200);
});

test('simultaneous authorized redemptions cannot overspend or reuse the losing grant at a new revision', async t => {
  const { server } = await fixture(t);
  const actions = ['buy-1', 'buy-2'].map(id => ({ id, type: 'reward.redeem', rewardId: 'reward-burger', expectedPoints: 60 }));
  const grants = await Promise.all(actions.map(action => authorize(server, action)));
  const results = await Promise.all(actions.map((action, i) => post(server, '/api/action', { revision: 1, action, grant: grants[i] })));
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
  const loser = results.findIndex(row => row.status === 409);
  assert.equal(Model.totals(results[loser].body.state).available, 28);
  assert.equal((await post(server, '/api/action', { revision: 2, action: actions[loser], grant: grants[loser] })).status, 403);
  const fresh = await challenge(server, actions[loser], 2);
  assert.equal(fresh.status, 400);
  assert.match(fresh.body.error, /还差/);
  assert.equal((await state(server)).body.revision, 2);
});

test('the real request-to-approval API writes one redemption under concurrent parent confirmations', async t => {
  const { server } = await fixture(t);
  const requested = await post(server, '/api/action', { revision: 1, action: { id: 'child-request', type: 'redemption.request', rewardId: 'reward-pencil' } });
  assert.equal(requested.status, 200);
  assert.equal(Model.totals(requested.body.state).available, 88);
  const requestId = requested.body.state.requests[0].id;
  const actions = ['parent-a', 'parent-b'].map(id => ({ id, type: 'redemption.approve', requestId, expectedPoints: 12 }));
  const grants = await Promise.all(actions.map(action => authorize(server, action, 2)));
  const results = await Promise.all(actions.map((action, i) => post(server, '/api/action', { revision: 2, action, grant: grants[i] })));
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
  const final = (await state(server)).body;
  assert.deepEqual(Model.totals(final.state), { earned: 128, spent: 52, available: 76 });
  assert.equal(final.state.requests[0].status, 'approved');
  assert.equal(final.state.redemptions.filter(row => row.id === final.state.requests[0].redemptionId).length, 1);
  assert.equal((await challenge(server, { id: 'repeat-approve', type: 'redemption.approve', requestId, expectedPoints: 12 }, 3)).status, 400);
});

test('restart retains exact-payload idempotency but never revives ephemeral grants', async t => {
  const f = await fixture(t);
  const first = await submit(f.server, credit('persisted'));
  const unused = await authorize(f.server, credit('unused'), 2);
  await close(f.server);
  const restarted = createServer(Object.assign({}, f.config, { now: () => new Date(2027, 0, 1, 12) }));
  t.after(() => close(restarted));
  await listen(restarted);
  const restartedSnapshot = Object.assign({}, first.body, { familyDay: '2027-01-01' });
  assert.deepEqual((await state(restarted)).body, restartedSnapshot);
  const duplicate = await post(restarted, '/api/action', { revision: 1, action: credit('persisted') });
  assert.deepEqual(duplicate.body, restartedSnapshot);
  assert.equal((await post(restarted, '/api/action', { revision: 2, action: credit('persisted', 99) })).status, 400);
  assert.equal((await post(restarted, '/api/action', { revision: 2, action: credit('unused'), grant: unused })).status, 403);
});

test('old v1 files migrate without reseeding and unprovable legacy action IDs cannot be reused', async t => {
  const f = await fixture(t);
  await close(f.server);
  const legacy = Model.apply(Model.createSeed(NOW), credit('legacy-id'), NOW);
  delete legacy.childAvatar;
  delete legacy.pet;
  delete legacy.requests;
  legacy.tasks.forEach(row => { delete row.ackAt; delete row.snoozeUntil; });
  legacy.pointItems.forEach(row => { delete row.reason; });
  fs.writeFileSync(f.dataFile, JSON.stringify({ revision: 4, state: legacy }));
  const restarted = createServer(f.config);
  t.after(() => close(restarted));
  await listen(restarted);
  const restored = await state(restarted);
  assert.equal(restored.body.revision, 4);
  assert.equal(Model.totals(restored.body.state).earned, 133);
  assert.deepEqual(restored.body.state.requests, []);
  assert.ok(restored.body.state.tasks.every(row => row.ackAt === '' && row.snoozeUntil === ''));
  assert.equal((await post(restarted, '/api/action', { revision: 4, action: credit('legacy-id') })).body.code, 'ACTION_ID_REUSED');
  assert.equal((await submit(restarted, credit('after-migration'), 4)).status, 200);
});

test('write failure keeps the old ledger, credential and grant so the exact action can retry atomically', async t => {
  const f = await fixture(t);
  const action = { id: 'atomic-config', type: 'parent.configure', method: 'math', pin: '654321' };
  const grant = await authorize(f.server, action);
  const before = fs.readFileSync(f.dataFile, 'utf8');
  const backup = path.join(path.dirname(f.dataFile), 'state-backup.json');
  assert.equal(path.dirname(backup), path.join(f.rootDir, 'data'));
  assert.equal(f.dataFile, path.join(f.rootDir, 'data', 'state.json'));
  fs.renameSync(f.dataFile, backup);
  fs.mkdirSync(f.dataFile);
  const failed = await post(f.server, '/api/action', { revision: 1, action, grant });
  assert.equal(failed.status, 500);
  assert.equal(failed.body.code, 'SAVE_FAILED');
  assert.equal((await state(f.server)).body.revision, 1);
  assert.equal((await request(f.server, 'GET', '/api/meta')).body.parent.method, 'pin');
  assert.equal(fs.readFileSync(backup, 'utf8'), before);
  assert.equal(fs.readdirSync(path.dirname(f.dataFile)).filter(name => name.endsWith('.tmp')).length, 0);
  fs.rmdirSync(f.dataFile);
  fs.renameSync(backup, f.dataFile);
  const retry = await post(f.server, '/api/action', { revision: 1, action, grant });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.revision, 2);
  const saved = JSON.parse(fs.readFileSync(f.dataFile, 'utf8'));
  assert.equal(saved.parent.method, 'math');
  assert.ok(saved.receipts[action.id]);
  assert.deepEqual(saved.state.appliedActions, [action.id]);
});

test('invalid sensitive drafts are rejected before challenge issuance without changing disk', async t => {
  const f = await fixture(t);
  const before = fs.readFileSync(f.dataFile, 'utf8');
  for (const action of [credit('bad-zero', 0), { id: 'bad-type', type: 'points.delete' },
    { id: 'bad-reason', type: 'points.add', name: '阅读', points: 1, reason: ' ' },
    { id: 'bad-pin', type: 'parent.configure', method: 'pin', pin: '123' },
    { id: 'bad-method', type: 'parent.configure', method: 'none' }]) {
    const response = await challenge(f.server, action);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.code, 'VALIDATION_ERROR');
    assert.equal(fs.readFileSync(f.dataFile, 'utf8'), before);
  }
});

test('corrupt state, credentials and receipts fail closed and preserve the original file', async t => {
  const f = await fixture(t);
  await close(f.server);
  const valid = fs.readFileSync(f.dataFile, 'utf8');
  const cases = ['{not-json'];
  const badBalance = JSON.parse(valid); badBalance.state.redemptions[0].points = 1000; cases.push(JSON.stringify(badBalance));
  const badParent = JSON.parse(valid); badParent.parent.hash = 'bad'; cases.push(JSON.stringify(badParent));
  const missingParent = JSON.parse(valid); delete missingParent.parent; cases.push(JSON.stringify(missingParent));
  const arraySalt = JSON.parse(valid); arraySalt.parent.salt = [arraySalt.parent.salt]; cases.push(JSON.stringify(arraySalt));
  const badReceipt = JSON.parse(valid); badReceipt.receipts.unknown = { algorithm: 'sha256', digest: 'f'.repeat(64) }; cases.push(JSON.stringify(badReceipt));
  for (const raw of cases) {
    fs.writeFileSync(f.dataFile, raw);
    assert.throws(() => createServer(f.config), /已保留原文件/);
    assert.equal(fs.readFileSync(f.dataFile, 'utf8'), raw);
  }
});

test('same-origin enforcement covers action, challenge, verify and assistant, including CORS preflight', async t => {
  const { server } = await fixture(t);
  const action = credit('origin-test');
  const grant = await authorize(server, action);
  const port = server.address().port;
  const payload = { revision: 1, action, grant, text: '你好', challengeId: 'unknown', answer: PIN };
  for (const endpoint of ['/api/action', '/api/parent/challenge', '/api/parent/verify', '/api/assistant']) {
    for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'null' },
      { Origin: 'http://127.0.0.1:' + port + '.evil.example' },
      { Origin: 'http://127.0.0.1:' + port, 'Sec-Fetch-Site': 'cross-site' },
      { Referer: 'https://evil.example/form' }, { 'Sec-Fetch-Site': 'same-site' }]) {
      assert.equal((await post(server, endpoint, payload, headers)).status, 403, endpoint);
    }
    assert.equal((await request(server, 'OPTIONS', endpoint, { headers: { Origin: 'https://evil.example' } })).status, 405);
  }
  const allowed = await post(server, '/api/action', payload, { Referer: 'http://127.0.0.1:' + port + '/index.html', 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers['access-control-allow-origin'], undefined);
});

test('explicit publicOrigin supports a trusted HTTPS reverse proxy origin', async t => {
  const { server } = await fixture(t, { publicOrigin: 'https://family.example' });
  const action = credit('proxy-award');
  const grant = await authorize(server, action);
  const body = { revision: 1, action, grant };
  assert.equal((await post(server, '/api/action', body, { Origin: 'http://family.example' })).status, 403);
  assert.equal((await post(server, '/api/action', body, { Origin: 'https://family.example' })).status, 200);
});

test('all POST JSON bodies preserve syntax, content-type and streaming-size bounds', async t => {
  const { server } = await fixture(t, { maxBodyBytes: 256 });
  for (const endpoint of ['/api/action', '/api/parent/challenge', '/api/parent/verify', '/api/assistant']) {
    assert.equal((await request(server, 'POST', endpoint, { raw: '{broken' })).status, 400);
    assert.equal((await post(server, endpoint, [])).status, 400);
    assert.equal((await request(server, 'POST', endpoint, { raw: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await request(server, 'POST', endpoint, { raw: 'x'.repeat(300) })).status, 413);
    assert.equal((await request(server, 'POST', endpoint, { raw: 'x'.repeat(300), chunked: true })).status, 413);
  }
  assert.equal((await post(server, '/api/action', { revision: '1', action: credit('bad') })).status, 400);
  assert.equal((await post(server, '/api/action', { revision: 1, action: { id: { toString: null }, type: 'task.toggle' } })).status, 400);
});

test('static allowlist includes assistant and pet assets and denies private files and traversal', async t => {
  const { server } = await fixture(t);
  for (const pathname of ['/', '/index.html', '/app.js', '/model.js', '/assistant.js', '/pet.js', '/pet.css', '/styles.css', '/assets/star.svg']) {
    assert.equal((await request(server, 'GET', pathname)).status, 200, pathname);
  }
  const head = await request(server, 'HEAD', '/index.html');
  assert.equal(head.status, 200); assert.equal(head.text, ''); assert.ok(Number(head.headers['content-length']) > 0);
  for (const pathname of ['/data/state.json', '/server.cjs', '/assistant-service.cjs', '/test/server.test.cjs', '/secret.txt',
    '/assets/private.json', '/docs/requirements.md', '/assets', '/api/missing', '/api/parent/setup']) {
    assert.equal((await request(server, 'GET', pathname)).status, 404, pathname);
  }
  for (const pathname of ['/../secret.txt', '/assets/%2e%2e/data/state.json', '/assets/%252e%252e/data/state.json',
    '/assets/%5c..%5cdata/state.json', '/.env', '/assets/.secret.svg', '/assets/a%00.svg', '/bad%XX']) {
    assert.equal((await request(server, 'GET', pathname)).status, 400, pathname);
  }
  assert.equal((await request(server, 'POST', '/index.html')).status, 405);
  for (const route of ['/api/action', '/api/assistant', '/api/parent/challenge', '/api/parent/verify']) {
    assert.equal((await request(server, 'GET', route)).status, 405);
  }
  assert.equal((await request(server, 'POST', '/api/state')).status, 405);
  assert.equal((await request(server, 'POST', '/api/meta')).status, 405);
});

test('assistant gets only a copied public state and can neither write a ledger nor create a grant', async t => {
  let received;
  const service = { status: () => ({ mode: 'connected', label: '测试适配器', secret: 'must-not-appear' }),
    interpret: async (text, stateValue, at) => {
      received = { text, state: JSON.parse(JSON.stringify(stateValue)), at };
      stateValue.points.push({ id: 'malicious', points: 999999 });
      stateValue.settings.pin = PIN;
      return { kind: 'draft', action: credit('assistant-draft', 99), grant: 'invented-token' };
    } };
  const f = await fixture(t, { assistantService: service });
  const before = fs.readFileSync(f.dataFile, 'utf8');
  const result = await post(f.server, '/api/assistant', { text: '  给5分  ', grant: 'private-input', pin: PIN });
  assert.equal(result.status, 200);
  assert.equal(received.text, '给5分');
  assert.equal(received.at.toISOString(), NOW.toISOString());
  assert.equal(received.state.parent, undefined);
  assert.equal(received.state.receipts, undefined);
  assert.equal(received.state.settings.pin, undefined);
  assert.equal(fs.readFileSync(f.dataFile, 'utf8'), before);
  assert.equal(Model.totals((await state(f.server)).body.state).earned, 128);
  const attempted = await post(f.server, '/api/action', { revision: 1, action: result.body.action, grant: result.body.grant });
  assert.equal(attempted.status, 403);
  const meta = await request(f.server, 'GET', '/api/meta');
  assert.deepEqual(meta.body.assistant, { mode: 'connected', label: '测试适配器' });
});

test('assistant failures disclose no provider credentials and leave the manual path usable', async t => {
  const f = await fixture(t, { assistantService: { status: () => ({ mode: 'connected', label: 'AI' }),
    interpret: async () => { throw new Error('upstream-secret-key-value'); } } });
  const response = await post(f.server, '/api/assistant', { text: '添加提醒' });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'ASSISTANT_UNAVAILABLE');
  assert.ok(!response.text.includes('upstream-secret-key-value'));
  assert.equal((await submit(f.server, credit('manual-fallback'))).status, 200);
});

test('assistant input and per-address minute budget are enforced without consulting the service', async t => {
  let time = NOW.getTime(), calls = 0;
  const { server } = await fixture(t, { now: () => new Date(time), assistantService: {
    status: () => ({ mode: 'local', label: '指令演示' }), interpret: async () => { calls++; return { kind: 'answer', text: '88分' }; } } });
  for (const text of ['', ' ', 'x'.repeat(1201)]) { assert.equal((await post(server, '/api/assistant', { text })).status, 400); }
  assert.equal(calls, 0);
  time += 60001;
  for (let i = 0; i < 12; i++) { assert.equal((await post(server, '/api/assistant', { text: '余额' })).status, 200); }
  const limited = await post(server, '/api/assistant', { text: '余额' }, { 'X-Forwarded-For': '198.51.100.9' });
  assert.equal(limited.status, 429);
  assert.equal(calls, 12);
  time += 60001;
  assert.equal((await post(server, '/api/assistant', { text: '余额' })).status, 200);
});

test('assistant has a family-wide concurrency ceiling of two and frees slots after completion', async t => {
  const pending = [];
  let bothStarted, thirdStarted;
  const started = new Promise(resolve => { bothStarted = resolve; });
  const thirdEntered = new Promise(resolve => { thirdStarted = resolve; });
  const { server } = await fixture(t, { assistantService: {
    status: () => ({ mode: 'local', label: '指令演示' }),
    interpret: () => new Promise(resolve => {
      pending.push(resolve);
      if (pending.length === 2) { bothStarted(); }
      if (pending.length === 3) { thirdStarted(); }
    }) } });
  const first = post(server, '/api/assistant', { text: '一' });
  const second = post(server, '/api/assistant', { text: '二' });
  await started;
  const limited = await post(server, '/api/assistant', { text: '三' });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.retryAfter, 1);
  for (const resolve of pending) { resolve({ kind: 'clarify', message: '完成' }); }
  assert.deepEqual((await Promise.all([first, second])).map(item => item.status), [200, 200]);
  const third = post(server, '/api/assistant', { text: '恢复后的请求' });
  await thirdEntered;
  pending[2]({ kind: 'answer', text: '可以继续' });
  assert.equal((await third).status, 200);
});

test('redemption conditions are rechecked at commit if the date changes after parent verification', async t => {
  let time = new Date(2026, 10, 15, 23, 59, 50).getTime();
  const f = await fixture(t, { now: () => new Date(time) });
  const action = { id: 'midnight-redemption', type: 'reward.redeem', rewardId: 'reward-burger', expectedPoints: 60 };
  const grant = await authorize(f.server, action);
  const before = fs.readFileSync(f.dataFile, 'utf8');
  time += 20000;
  const response = await post(f.server, '/api/action', { revision: 1, action, grant });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /周末/);
  assert.equal(fs.readFileSync(f.dataFile, 'utf8'), before);
  assert.deepEqual(Model.totals((await state(f.server)).body.state), { earned: 128, spent: 40, available: 88 });
});

test('a failed points commit does not consume its grant and a successful retry awards exactly once', async t => {
  const f = await fixture(t);
  const action = credit('failed-credit');
  const grant = await authorize(f.server, action);
  const backup = path.join(path.dirname(f.dataFile), 'state-backup.json');
  assert.equal(f.dataFile, path.join(f.rootDir, 'data', 'state.json'));
  assert.equal(path.dirname(backup), path.join(f.rootDir, 'data'));
  fs.renameSync(f.dataFile, backup);
  fs.mkdirSync(f.dataFile);
  assert.equal((await post(f.server, '/api/action', { revision: 1, action, grant })).status, 500);
  const unchanged = (await state(f.server)).body;
  assert.equal(unchanged.revision, 1);
  assert.equal(Model.totals(unchanged.state).earned, 128);
  fs.rmdirSync(f.dataFile);
  fs.renameSync(backup, f.dataFile);
  const retry = await post(f.server, '/api/action', { revision: 1, action, grant });
  assert.equal(retry.status, 200);
  assert.equal(Model.totals(retry.body.state).earned, 133);
  assert.equal((await post(f.server, '/api/action', { revision: 1, action })).status, 200);
  assert.equal(Model.totals((await state(f.server)).body.state).earned, 133);
});

test('a fresh family stays explicitly unconfigured without generating or logging a bootstrap PIN', async t => {
  const messages = [];
  t.mock.method(console, 'log', message => { messages.push(message); });
  const f = await fixture(t, { parentPin: undefined });
  const before = (await state(f.server)).body;
  assert.deepEqual(before.parent, { configured: false, method: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.dataFile, 'utf8')).parent, before.parent);
  assert.equal(messages.length, 0);
  const started = await challenge(f.server, credit('setup-required'));
  assert.equal(started.status, 403);
  assert.equal(started.body.code, 'PARENT_SETUP_REQUIRED');
  await close(f.server);
  const restarted = createServer(Object.assign({}, f.config, { parentPin: '000000' }));
  t.after(() => close(restarted));
  await listen(restarted);
  assert.deepEqual((await state(restarted)).body, before);
  assert.equal(messages.length, 0);
});

test('v3 migration adds only profile defaults while preserving the real name, requests, ledger, PIN and receipts', async t => {
  const f = await fixture(t);
  await post(f.server, '/api/action', { revision: 1, action: { id: 'old-request', type: 'redemption.request', rewardId: 'reward-pencil' } });
  const configured = { id: 'old-parent', type: 'parent.configure', method: 'pin', pin: '876543' };
  assert.equal((await submit(f.server, configured, 2)).status, 200);
  await close(f.server);
  const saved = JSON.parse(fs.readFileSync(f.dataFile, 'utf8'));
  saved.state.childName = '真实旧名字';
  delete saved.state.childAvatar;
  delete saved.state.pet;
  fs.writeFileSync(f.dataFile, JSON.stringify(saved));
  const restarted = createServer(Object.assign({}, f.config, { parentPin: '000000' }));
  t.after(() => close(restarted));
  await listen(restarted);
  const migrated = JSON.parse(fs.readFileSync(f.dataFile, 'utf8'));
  assert.equal(migrated.revision, saved.revision);
  assert.deepEqual(migrated.parent, saved.parent);
  assert.deepEqual(migrated.receipts, saved.receipts);
  assert.equal(migrated.state.childName, '真实旧名字');
  assert.equal(migrated.state.childAvatar, '');
  assert.deepEqual(migrated.state.pet, { kind: 'plant', name: '芽芽' });
  for (const field of ['points', 'redemptions', 'requests', 'tasks', 'settings', 'appliedActions', 'pointItems', 'rewards']) {
    assert.deepEqual(migrated.state[field], saved.state[field], field);
  }
  assert.equal(Model.growth(migrated.state).xp, 128);
  assert.equal(Model.growth(migrated.state).stage, 3);
  assert.equal((await post(restarted, '/api/action', { revision: 2, action: configured })).status, 200);
  const started = await challenge(restarted, credit('after-v4-migration'), 3);
  assert.equal((await verify(restarted, started.body.challengeId, '000000')).status, 403);
  assert.equal((await verify(restarted, started.body.challengeId, '876543')).status, 200);
});

test('profile photos require a payload-bound parent grant and survive restart until explicitly removed', async t => {
  const f = await fixture(t);
  const before = JSON.parse(fs.readFileSync(f.dataFile, 'utf8'));
  const action = { id: 'profile-photo', type: 'profile.update', childName: '小满', childAvatar: PNG_AVATAR };
  assert.equal((await post(f.server, '/api/action', { revision: 1, action })).status, 403);
  const grant = await authorize(f.server, action);
  for (const patch of [{ childName: '换一个名字' }, { childAvatar: '' }]) {
    assert.equal((await post(f.server, '/api/action', { revision: 1, action: Object.assign({}, action, patch), grant })).status, 403);
  }
  const updated = await post(f.server, '/api/action', { revision: 1, action, grant });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.state.childName, '小满');
  assert.equal(updated.body.state.childAvatar, PNG_AVATAR);
  assert.deepEqual(Model.totals(updated.body.state), { earned: 128, spent: 40, available: 88 });
  assert.equal(Model.growth(updated.body.state).stage, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.dataFile, 'utf8')).parent, before.parent);
  await close(f.server);
  const restarted = createServer(f.config);
  t.after(() => close(restarted));
  await listen(restarted);
  assert.deepEqual((await state(restarted)).body, updated.body);
  assert.equal((await post(restarted, '/api/action', { revision: 1, action })).status, 200);
  const removed = await submit(restarted, { id: 'remove-profile-photo', type: 'profile.update', childAvatar: '' }, 2);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.state.childName, '小满');
  assert.equal(removed.body.state.childAvatar, '');
  assert.equal(JSON.parse(fs.readFileSync(f.dataFile, 'utf8')).state.childAvatar, '');
});

test('public pet configuration cannot alter a ledger, child profile, growth or verification settings', async t => {
  const f = await fixture(t);
  const before = JSON.parse(fs.readFileSync(f.dataFile, 'utf8'));
  const action = { id: 'public-pet-injection', type: 'pet.configure', kind: 'capybara', name: '暖暖',
    xp: 9999, level: 99, childName: 'changed', childAvatar: PNG_AVATAR, points: [],
    redemptions: [], parent: { method: 'math' }, settings: { monthEndDays: 1 } };
  const result = await post(f.server, '/api/action', { revision: 1, action });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.state.pet, { kind: 'capybara', name: '暖暖' });
  for (const field of ['childName', 'childAvatar', 'points', 'redemptions', 'requests', 'settings']) {
    assert.deepEqual(result.body.state[field], before.state[field], field);
  }
  assert.equal(Model.growth(result.body.state).xp, 128);
  assert.equal(Model.growth(result.body.state).stageName, '星岛探员');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.dataFile, 'utf8')).parent, before.parent);
  assert.equal((await post(f.server, '/api/action', { revision: 1, action })).status, 200);
  const changed = await post(f.server, '/api/action', { revision: 2, action: Object.assign({}, action, { name: '另一个名字' }) });
  assert.equal(changed.status, 400);
  assert.equal(changed.body.code, 'ACTION_ID_REUSED');
  const unsupported = await post(f.server, '/api/action', { revision: 2, action: { id: 'fake-interaction', type: 'pet.feed', points: 100 } });
  assert.equal(unsupported.status, 403);
});

test('the 256 KiB default accepts a large valid PNG avatar but still rejects oversized photos and requests', async t => {
  const f = await fixture(t);
  const childAvatar = largePngAvatar(119895);
  assert.equal(childAvatar.length, 159998);
  const action = { id: 'large-profile', type: 'profile.update', childName: '小禾', childAvatar };
  const saved = await submit(f.server, action);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.state.childAvatar, childAvatar);
  const oversize = largePngAvatar(119898);
  assert.ok(oversize.length > 160000 && oversize.length < 256 * 1024);
  const rejected = await challenge(f.server, { id: 'too-large-photo', type: 'profile.update', childName: '小禾', childAvatar: oversize }, 2);
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /160000/);
  for (const chunked of [false, true]) {
    const response = await request(f.server, 'POST', '/api/parent/challenge', { raw: 'x'.repeat(256 * 1024 + 1), chunked });
    assert.equal(response.status, 413);
  }
  assert.equal((await state(f.server)).body.revision, 2);
});

test('avatar validation rejects unsafe formats or invalid markers before issuing a parent challenge', async t => {
  const f = await fixture(t);
  const before = fs.readFileSync(f.dataFile, 'utf8');
  const invalid = ['https://example.test/avatar.png', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    PNG_AVATAR.replace('image/png', 'image/jpeg'), 'data:image/png;base64,AA=A', PNG_AVATAR + '\n'];
  for (let i = 0; i < invalid.length; i++) {
    const result = await challenge(f.server, { id: 'invalid-avatar-' + i, type: 'profile.update', childName: '小禾', childAvatar: invalid[i] });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'VALIDATION_ERROR');
    assert.equal(result.body.challengeId, undefined);
  }
  assert.equal(fs.readFileSync(f.dataFile, 'utf8'), before);
});

test('assistant context and target are validated and forwarded without the saved photo or private state', async t => {
  const received = [];
  const service = { status: () => ({ mode: 'connected', label: '测试适配器' }),
    interpret: async (text, stateValue, at, options) => {
      received.push({ text, state: JSON.parse(JSON.stringify(stateValue)), at, options: Object.assign({}, options) });
      stateValue.childName = 'service mutation';
      return { kind: 'clarify', message: '请核对候选内容' };
    } };
  const f = await fixture(t, { assistantService: service });
  await submit(f.server, { id: 'assistant-profile', type: 'profile.update', childName: '小满', childAvatar: PNG_AVATAR });
  const before = fs.readFileSync(f.dataFile, 'utf8');
  const cases = [{}, { context: 'points' }, { context: 'pointItems', targetId: 'point-reading' }, { context: 'general', targetId: '' }];
  for (const options of cases) {
    const result = await post(f.server, '/api/assistant', Object.assign({ text: '  整理这句话  ', childAvatar: PNG_AVATAR }, options));
    assert.equal(result.status, 200);
  }
  assert.deepEqual(received.map(row => row.options), [
    { context: 'general', targetId: '' }, { context: 'points', targetId: '' },
    { context: 'pointItems', targetId: 'point-reading' }, { context: 'general', targetId: '' }
  ]);
  for (const entry of received) {
    assert.equal(entry.text, '整理这句话');
    assert.equal(entry.state.childName, '小满');
    assert.equal(entry.state.childAvatar, undefined);
    assert.equal(entry.state.parent, undefined);
    assert.equal(entry.state.receipts, undefined);
    assert.equal(entry.at.toISOString(), NOW.toISOString());
    assert.deepEqual(Model.totals(entry.state), { earned: 128, spent: 40, available: 88 });
    assert.equal(Model.growth(entry.state).xp, 128);
    assert.equal(Model.apply(entry.state, { id: 'assistant-validation', type: 'points.add', name: '阅读', points: 1, reason: '主动阅读' }, NOW).childAvatar, '');
  }
  assert.ok(!JSON.stringify(received).includes('data:image/'));
  for (const options of [{ context: 'unknown' }, { context: null }, { context: ['points'] },
    { context: 'pointItems', targetId: '../photo' }, { targetId: 12 }, { targetId: 'x'.repeat(201) }]) {
    assert.equal((await post(f.server, '/api/assistant', Object.assign({ text: '整理' }, options))).status, 400);
  }
  assert.equal(received.length, cases.length);
  assert.equal(fs.readFileSync(f.dataFile, 'utf8'), before);
  assert.equal((await state(f.server)).body.state.childAvatar, PNG_AVATAR);
});

const petBuy = (id, itemId = 'snack', quantity = 1) => ({ id, type: 'pet.buy', itemId, quantity, expectedPoints: quantity * 3 });
const petCare = (id, care = 'feed', source = 'free') => ({ id, type: 'pet.care', care, source });

test('v5 migration adds empty pet ledgers without changing the profile, PIN, receipts or original history', async t => {
  const f = await fixture(t);
  await submit(f.server, { id: 'old-photo', type: 'profile.update', childName: '原来的孩子', childAvatar: PNG_AVATAR });
  await post(f.server, '/api/action', { revision: 2, action: { id: 'old-kind', type: 'pet.configure', kind: 'capybara', name: '原来的伙伴' } });
  await close(f.server);
  const legacy = JSON.parse(fs.readFileSync(f.dataFile, 'utf8'));
  delete legacy.state.petPurchases; delete legacy.state.petCare; delete legacy.state.petScene;
  fs.writeFileSync(f.dataFile, JSON.stringify(legacy));
  const restarted = createServer(Object.assign({}, f.config, { parentPin: '000000' }));
  t.after(() => close(restarted)); await listen(restarted);
  const migrated = JSON.parse(fs.readFileSync(f.dataFile, 'utf8'));
  assert.deepEqual(migrated.parent, legacy.parent);
  assert.deepEqual(migrated.receipts, legacy.receipts);
  assert.equal(migrated.revision, legacy.revision);
  assert.deepEqual(migrated.state, Object.assign({}, legacy.state, { petPurchases: [], petCare: [], petScene: 'home' }));
  assert.equal((await state(restarted)).body.familyDay, Model.dateKey(NOW));
  assert.ok(await authorize(restarted, petBuy('after-migration'), 3));
});

test('pet purchases are parent-protected, bind the whole price and survive restart and exact retries', async t => {
  const f = await fixture(t);
  const action = petBuy('stock-once', 'snack', 2);
  const original = fs.readFileSync(f.dataFile, 'utf8');
  const denied = await post(f.server, '/api/action', { revision: 1, action });
  assert.equal(denied.status, 403); assert.equal(denied.body.code, 'PARENT_REQUIRED');
  const grant = await authorize(f.server, action);
  assert.equal(fs.readFileSync(f.dataFile, 'utf8'), original);
  const tampered = await post(f.server, '/api/action', { revision: 1, grant, action: Object.assign({}, action, { quantity: 3, expectedPoints: 9 }) });
  assert.equal(tampered.status, 403);
  const bought = await post(f.server, '/api/action', { revision: 1, grant, action });
  assert.equal(bought.status, 200);
  assert.equal(bought.body.familyDay, '2026-11-14');
  assert.deepEqual(Model.totals(bought.body.state), { earned: 128, spent: 46, available: 82 });
  assert.equal(bought.body.state.petPurchases.length, 1);
  assert.equal(bought.body.state.petPurchases[0].quantity, 2);
  assert.equal(Model.petStatus(bought.body.state, bought.body.familyDay).inventory.snack, 2);
  assert.equal(Model.petStatus(bought.body.state, bought.body.familyDay).exploration, 0);
  await close(f.server);
  const restarted = createServer(f.config); t.after(() => close(restarted)); await listen(restarted);
  const retried = await post(restarted, '/api/action', { revision: 1, action });
  assert.equal(retried.status, 200);
  assert.deepEqual(retried.body, bought.body);
  assert.equal((await post(restarted, '/api/action', { revision: 2, action: Object.assign({}, action, { quantity: 1, expectedPoints: 3 }) })).body.code, 'ACTION_ID_REUSED');
  const used = await post(restarted, '/api/action', { revision: 2, action: petCare('use-stock', 'feed', 'inventory') });
  assert.equal(used.status, 200);
  assert.equal(Model.petStatus(used.body.state, used.body.familyDay).inventory.snack, 1);
  assert.equal(Model.petStatus(used.body.state, used.body.familyDay).freeRemaining, 3);
  assert.equal(Model.growth(used.body.state).xp, 128);
});

test('two devices cannot double-use the last free care and only the server family day restores it', async t => {
  let clock = new Date(2026, 10, 14, 23, 59, 50);
  const f = await fixture(t, { now: () => new Date(clock) });
  await post(f.server, '/api/action', { revision: 1, action: petCare('first-feed', 'feed') });
  await post(f.server, '/api/action', { revision: 2, action: petCare('second-wash', 'wash') });
  const actions = [petCare('third-a', 'train'), petCare('third-b', 'train')];
  const results = await Promise.all(actions.map(action => post(f.server, '/api/action', { revision: 3, action })));
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
  const winner = results.findIndex(row => row.status === 200);
  const saved = results[winner].body;
  assert.equal(saved.state.petCare.length, 3);
  assert.equal(saved.state.petScene, 'forest');
  assert.equal(saved.familyDay, '2026-11-14');
  assert.equal(results[1 - winner].body.familyDay, '2026-11-14');
  assert.equal(Model.petStatus(saved.state, saved.familyDay).exploration, 4);
  assert.equal(Model.petStatus(saved.state, saved.familyDay).freeRemaining, 0);
  const retryLoser = await post(f.server, '/api/action', { revision: 4, action: actions[1 - winner] });
  assert.equal(retryLoser.status, 400); assert.equal(retryLoser.body.code, 'VALIDATION_ERROR');
  for (const field of ['day', 'at', 'now', 'freeRemaining', 'exploration']) {
    const forged = await post(f.server, '/api/action', { revision: 4, action: Object.assign(petCare('forge-' + field), { [field]: '2099-01-01' }) });
    assert.equal(forged.status, 400);
  }
  const forgedDay = await post(f.server, '/api/action', { revision: 4, familyDay: '2099-01-01', action: petCare('fake-envelope-day') });
  assert.equal(forgedDay.status, 400);
  clock = new Date(2026, 10, 15, 0, 0, 10);
  const nextDay = await state(f.server);
  assert.equal(nextDay.body.familyDay, '2026-11-15');
  assert.equal((await request(f.server, 'GET', '/api/meta')).body.familyDay, '2026-11-15');
  assert.equal(Model.petStatus(nextDay.body.state, nextDay.body.familyDay).freeRemaining, 3);
  const replay = await post(f.server, '/api/action', { revision: 3, action: actions[winner] });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.state.petCare.length, 3);
  assert.equal(Model.petStatus(replay.body.state, replay.body.familyDay).freeRemaining, 3);
  const switched = await post(f.server, '/api/action', { revision: 4, action: { id: 'choose-home', type: 'pet.scene', sceneId: 'home' } });
  assert.equal(switched.status, 200);
  const cared = await post(f.server, '/api/action', { revision: 5, action: petCare('new-day-care') });
  assert.equal(cared.status, 200);
  assert.equal(cared.body.state.petCare[3].day, '2026-11-15');
  assert.equal(cared.body.state.petCare[3].at, clock.toISOString());
  assert.equal(cared.body.state.petScene, 'home');
  assert.equal(Model.petStatus(cared.body.state, cared.body.familyDay).exploration, 5);
  assert.equal(Model.petStatus(cared.body.state, cared.body.familyDay).freeRemaining, 2);
  await close(f.server);
  const restarted = createServer(f.config); t.after(() => close(restarted)); await listen(restarted);
  assert.deepEqual((await state(restarted)).body, cared.body);
  const afterRestartRetry = await post(restarted, '/api/action', { revision: 5, action: petCare('new-day-care') });
  assert.equal(afterRestartRetry.status, 200);
  assert.deepEqual(afterRestartRetry.body, cared.body);
});

test('competing inventory uses cannot overspend or silently switch to the still-available free quota', async t => {
  const f = await fixture(t);
  await submit(f.server, petBuy('one-snack'));
  const actions = [petCare('inventory-a', 'feed', 'inventory'), petCare('inventory-b', 'feed', 'inventory')];
  const responses = await Promise.all(actions.map(action => post(f.server, '/api/action', { revision: 2, action })));
  assert.deepEqual(responses.map(row => row.status).sort(), [200, 409]);
  const winner = responses.findIndex(row => row.status === 200);
  const snapshot = responses[winner].body;
  assert.equal(snapshot.state.petCare.length, 1);
  assert.equal(Model.petStatus(snapshot.state, snapshot.familyDay).inventory.snack, 0);
  assert.equal(Model.petStatus(snapshot.state, snapshot.familyDay).freeRemaining, 3);
  assert.equal((await post(f.server, '/api/action', { revision: 3, action: actions[1 - winner] })).status, 400);
  assert.equal((await post(f.server, '/api/action', { revision: 2, action: actions[winner] })).status, 200);
  assert.equal((await state(f.server)).body.state.petCare.length, 1);
  assert.deepEqual(Model.totals(snapshot.state), { earned: 128, spent: 43, available: 85 });
});

test('simultaneous protected purchases share the exact gift balance and reject a fresh overdraft', async t => {
  const f = await fixture(t); await close(f.server);
  const envelope = JSON.parse(fs.readFileSync(f.dataFile, 'utf8'));
  envelope.state.points = [{ id: 'three-points', itemId: '', name: '真实奖励', points: 3, reason: '已完成', at: NOW.toISOString() }];
  envelope.state.redemptions = [];
  fs.writeFileSync(f.dataFile, JSON.stringify(envelope));
  const restarted = createServer(f.config); t.after(() => close(restarted)); await listen(restarted);
  const actions = [petBuy('buy-a', 'snack'), petBuy('buy-b', 'dew')];
  const grants = [];
  for (const action of actions) { grants.push(await authorize(restarted, action)); }
  const outcomes = await Promise.all(actions.map((action, i) => post(restarted, '/api/action', { revision: 1, action, grant: grants[i] })));
  assert.deepEqual(outcomes.map(row => row.status).sort(), [200, 409]);
  const winner = outcomes.findIndex(row => row.status === 200);
  const snapshot = (await state(restarted)).body;
  assert.deepEqual(Model.totals(snapshot.state), { earned: 3, spent: 3, available: 0 });
  assert.equal(snapshot.state.petPurchases.length, 1);
  assert.equal(Model.growth(snapshot.state).xp, 3);
  const again = await challenge(restarted, actions[1 - winner], 2);
  assert.equal(again.status, 400);
  assert.match(again.body.error, /积分不足/);
});

test('buying inventory invalidates a pending gift grant and fresh approval rechecks the shared balance', async t => {
  const f = await fixture(t);
  const requested = await post(f.server, '/api/action', { revision: 1, action: { id: 'want-burger', type: 'redemption.request', rewardId: 'reward-burger' } });
  assert.equal(requested.status, 200);
  assert.equal(Model.totals(requested.body.state).available, 88);
  const approval = { id: 'approve-burger', type: 'redemption.approve', requestId: 'request-want-burger', expectedPoints: 60 };
  const giftGrant = await authorize(f.server, approval, 2);
  const bought = await submit(f.server, petBuy('buy-before-gift', 'snack', 10), 2);
  assert.equal(bought.status, 200);
  assert.deepEqual(Model.totals(bought.body.state), { earned: 128, spent: 70, available: 58 });
  assert.equal((await post(f.server, '/api/action', { revision: 2, action: approval, grant: giftGrant })).status, 409);
  const fresh = await challenge(f.server, approval, 3);
  assert.equal(fresh.status, 400); assert.match(fresh.body.error, /还差 2 分/);
  const after = (await state(f.server)).body;
  assert.equal(after.revision, 3);
  assert.equal(after.state.requests[0].status, 'pending');
  assert.equal(after.state.redemptions.length, requested.body.state.redemptions.length);
  assert.deepEqual(Model.totals(after.state), { earned: 128, spent: 70, available: 58 });
});

test('invalid purchase prices, quantities, locked scenes and missing sources reject before writing', async t => {
  const f = await fixture(t);
  const before = fs.readFileSync(f.dataFile, 'utf8');
  for (const [i, patch] of [{ quantity: 0 }, { quantity: 11 }, { quantity: 1.5 }, { expectedPoints: 1 },
    { expectedPoints: 30 }, { itemId: 'unknown' }, { unitPoints: 0 }].entries()) {
    const result = await challenge(f.server, Object.assign(petBuy('invalid-buy-' + i), patch));
    assert.equal(result.status, 400); assert.equal(result.body.code, 'VALIDATION_ERROR');
  }
  for (const action of [{ id: 'locked-scene', type: 'pet.scene', sceneId: 'aurora' },
    { id: 'no-source', type: 'pet.care', care: 'feed' }, petCare('empty-inventory', 'feed', 'inventory')]) {
    const result = await post(f.server, '/api/action', { revision: 1, action });
    assert.equal(result.status, 400);
  }
  assert.equal(fs.readFileSync(f.dataFile, 'utf8'), before);
});

test('one parent authorization creates the custom credit and template atomically even under concurrent retries', async t => {
  const f = await fixture(t);
  const action = Object.assign(credit('atomic-template', 6), { name: '自主阅读', saveAsTemplate: true });
  const before = fs.readFileSync(f.dataFile, 'utf8');
  const abandoned = await challenge(f.server, action);
  assert.equal((await verify(f.server, abandoned.body.challengeId, '000000')).status, 403);
  assert.equal(fs.readFileSync(f.dataFile, 'utf8'), before);
  const grant = await authorize(f.server, action);
  assert.equal((await post(f.server, '/api/action', { revision: 1, grant, action: Object.assign({}, action, { saveAsTemplate: false }) })).status, 403);
  assert.equal(fs.readFileSync(f.dataFile, 'utf8'), before);
  const outcomes = await Promise.all([1, 2].map(() => post(f.server, '/api/action', { revision: 1, action, grant })));
  assert.deepEqual(outcomes.map(row => row.status), [200, 200]);
  assert.deepEqual(outcomes[0].body, outcomes[1].body);
  const saved = outcomes[0].body;
  assert.equal(saved.revision, 2);
  assert.equal(saved.state.pointItems.length, 5);
  const template = saved.state.pointItems.find(row => row.id === 'item-atomic-template');
  assert.equal(template.name, '自主阅读'); assert.equal(template.points, 6);
  assert.equal(saved.state.points.filter(row => row.id === 'points-atomic-template').length, 1);
  assert.equal(saved.state.points.find(row => row.id === 'points-atomic-template').itemId, template.id);
  assert.equal((await post(f.server, '/api/action', { revision: 2, action: Object.assign({}, action, { saveAsTemplate: false }) })).body.code, 'ACTION_ID_REUSED');
  const next = await submit(f.server, { id: 'reuse-created', type: 'points.add', itemId: template.id, reason: '再次完成' }, 2);
  assert.equal(next.status, 200); assert.equal(next.body.state.pointItems.length, 5);
  assert.equal(Model.totals(next.body.state).earned, 140);
});

test('a failed atomic-template file commit retains both old collections and its grant for one successful retry', async t => {
  const f = await fixture(t);
  const action = Object.assign(credit('template-write-retry'), { saveAsTemplate: true });
  const grant = await authorize(f.server, action);
  const before = fs.readFileSync(f.dataFile, 'utf8');
  const backup = path.join(path.dirname(f.dataFile), 'v6-backup.json');
  assert.equal(f.dataFile, path.join(f.rootDir, 'data', 'state.json'));
  assert.equal(path.dirname(backup), path.join(f.rootDir, 'data'));
  fs.renameSync(f.dataFile, backup); fs.mkdirSync(f.dataFile);
  const failed = await post(f.server, '/api/action', { revision: 1, action, grant });
  assert.equal(failed.status, 500); assert.equal(failed.body.code, 'SAVE_FAILED');
  const unchanged = (await state(f.server)).body;
  assert.equal(unchanged.revision, 1); assert.equal(unchanged.state.pointItems.length, 4);
  assert.equal(unchanged.state.points.some(row => row.id === 'points-template-write-retry'), false);
  assert.equal(fs.readFileSync(backup, 'utf8'), before);
  fs.rmdirSync(f.dataFile); fs.renameSync(backup, f.dataFile);
  const succeeded = await post(f.server, '/api/action', { revision: 1, action, grant });
  assert.equal(succeeded.status, 200); assert.equal(succeeded.body.state.pointItems.length, 5);
  assert.equal((await post(f.server, '/api/action', { revision: 1, action })).status, 200);
  assert.equal((await state(f.server)).body.state.pointItems.length, 5);
});

test('a stale template grant cannot leave a half-template after another device performs care', async t => {
  const f = await fixture(t);
  const action = Object.assign(credit('stale-template'), { saveAsTemplate: true });
  const grant = await authorize(f.server, action);
  await post(f.server, '/api/action', { revision: 1, action: petCare('other-device-care') });
  const conflict = await post(f.server, '/api/action', { revision: 1, action, grant });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.familyDay, '2026-11-14');
  assert.equal(conflict.body.state.pointItems.length, 4);
  assert.equal(conflict.body.state.points.some(row => row.itemId === 'item-stale-template'), false);
  const saved = await submit(f.server, action, 2);
  assert.equal(saved.status, 200); assert.equal(saved.body.state.pointItems.length, 5);
});

const initialParent = (id, pin = '135790') => ({ id, type: 'parent.setup', method: 'pin', pin, confirmPin: pin });
const initialize = (server, action = initialParent('first-parent'), revision = 1) => post(server, '/api/action', { revision, action });

test('v8 unconfigured sensitive writes and challenges require setup without accepting caller authority', async t => {
  const f = await fixture(t, { parentPin: undefined });
  const before = fs.readFileSync(f.dataFile, 'utf8');
  const meta = (await request(f.server, 'GET', '/api/meta')).body;
  assert.equal(meta.revision, 1);
  assert.deepEqual(meta.parent, { configured: false, method: null });
  const actions = [credit('early-credit'), { id: 'early-config', type: 'parent.configure', method: 'math' },
    { id: 'early-redeem', type: 'reward.redeem', rewardId: 'reward-pencil' }, petBuy('early-buy')];
  for (const action of actions) {
    const written = await post(f.server, '/api/action', { revision: 1, action, grant: 'fake', configured: true, parent: { configured: true } });
    const started = await challenge(f.server, action);
    for (const result of [written, started]) {
      assert.equal(result.status, 403);
      assert.equal(result.body.code, 'PARENT_SETUP_REQUIRED');
      assert.deepEqual(result.body.parent, meta.parent);
      assert.equal(result.body.revision, 1);
    }
  }
  assert.equal((await challenge(f.server, initialParent('setup-does-not-need-challenge'))).body.code, 'PARENT_SETUP_REQUIRED');
  assert.equal(fs.readFileSync(f.dataFile, 'utf8'), before);
});

test('v8 first PIN setup writes only configuration and a salted receipt, then ordinary authorization works after restart', async t => {
  const f = await fixture(t, { parentPin: undefined });
  const before = (await state(f.server)).body;
  const action = initialParent('own-first-pin');
  const result = await initialize(f.server, action);
  assert.equal(result.status, 200);
  assert.equal(result.body.revision, 2);
  assert.deepEqual(result.body.parent, { configured: true, method: 'pin' });
  assert.deepEqual(result.body.state, Object.assign({}, before.state, { appliedActions: [action.id] }));
  const diskText = fs.readFileSync(f.dataFile, 'utf8');
  const disk = JSON.parse(diskText);
  assert.equal(disk.receipts[action.id].algorithm, 'scrypt');
  assert.match(disk.receipts[action.id].salt, /^[a-f0-9]{32}$/);
  assert.notEqual(disk.receipts[action.id].salt, disk.parent.salt);
  assert.ok(!diskText.includes(action.pin));
  assert.ok(!result.text.includes(action.pin));
  assert.deepEqual(Object.keys(result.body.parent).sort(), ['configured', 'method']);
  const denied = await post(f.server, '/api/action', { revision: 2, action: credit('original-business') });
  assert.equal(denied.body.code, 'PARENT_REQUIRED');
  const started = await challenge(f.server, credit('original-business'), 2);
  assert.equal((await verify(f.server, started.body.challengeId, PIN)).status, 403);
  const checked = await verify(f.server, started.body.challengeId, action.pin);
  assert.equal(checked.status, 200);
  const submitted = await post(f.server, '/api/action', { revision: 2, action: credit('original-business'), grant: checked.body.grant });
  assert.equal(submitted.status, 200);
  assert.equal(Model.totals(submitted.body.state).earned, 133);
  assert.equal((await post(f.server, '/api/action', { revision: 2, action: credit('original-business') })).body.revision, 3);
  await close(f.server);
  const restarted = createServer(Object.assign({}, f.config, { parentPin: '000000' }));
  t.after(() => close(restarted)); await listen(restarted);
  assert.deepEqual((await state(restarted)).body, submitted.body);
  assert.deepEqual((await initialize(restarted, action)).body, submitted.body);
  assert.ok(await authorize(restarted, credit('after-first-setup-restart'), 3, action.pin));
  const latestMeta = (await request(restarted, 'GET', '/api/meta')).body;
  assert.equal(latestMeta.revision, 3);
  assert.deepEqual(latestMeta.parent, result.body.parent);
});

test('v8 invalid first setup drafts never write credentials, action IDs or receipts', async t => {
  const f = await fixture(t, { parentPin: undefined });
  const before = fs.readFileSync(f.dataFile, 'utf8');
  const crossOrigin = await post(f.server, '/api/action', { revision: 1, action: initialParent('cross-origin-setup') }, { Origin: 'https://other.example' });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.body.code, 'ORIGIN_DENIED');
  assert.equal(fs.readFileSync(f.dataFile, 'utf8'), before);
  const candidates = [
    { method: 'none' }, { method: 'pin' }, { method: 'pin', pin: '123456' },
    { method: 'pin', pin: '123456', confirmPin: '654321' },
    { method: 'pin', pin: '12345', confirmPin: '12345' },
    { method: 'pin', pin: '1234567', confirmPin: '1234567' },
    { method: 'pin', pin: '123456\n', confirmPin: '123456\n' },
    { method: 'pin', pin: 123456, confirmPin: 123456 },
    { method: 'pin', pin: '１２３４５６', confirmPin: '１２３４５６' },
    { method: 'math', pin: '123456' }, { method: 'math', confirmPin: '' },
    { method: 'math', configured: false }, { method: 'math', hash: 'f'.repeat(64) }
  ];
  for (let index = 0; index < candidates.length; index++) {
    const result = await initialize(f.server, Object.assign({ id: 'bad-setup-' + index, type: 'parent.setup' }, candidates[index]));
    assert.equal(result.status, 400, JSON.stringify(candidates[index]));
    assert.equal(result.body.code, 'VALIDATION_ERROR');
    assert.equal(fs.readFileSync(f.dataFile, 'utf8'), before);
  }
  assert.deepEqual((await state(f.server)).body.parent, { configured: false, method: null });
});

test('v8 two different first setups race atomically and configured state cannot be overwritten by setup', async t => {
  const f = await fixture(t, { parentPin: undefined });
  const actions = [initialParent('first-device', '135790'), initialParent('second-device', '864209')];
  const results = await Promise.all(actions.map(action => initialize(f.server, action)));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const winner = results.findIndex(result => result.status === 200);
  const loser = 1 - winner;
  assert.equal(results[loser].body.code, 'PARENT_ALREADY_CONFIGURED');
  assert.deepEqual(results[loser].body.parent, { configured: true, method: 'pin' });
  assert.deepEqual(results[loser].body.state.appliedActions, [actions[winner].id]);
  const before = fs.readFileSync(f.dataFile, 'utf8');
  const another = await post(f.server, '/api/action', {
    revision: 2, action: Object.assign(initialParent('forged-reset'), { configured: false }),
    parent: { configured: false }, configured: false, grant: 'fake'
  });
  assert.equal(another.status, 409);
  assert.equal(another.body.code, 'PARENT_ALREADY_CONFIGURED');
  const latestRetry = await initialize(f.server, actions[loser], 2);
  assert.equal(latestRetry.body.code, 'PARENT_ALREADY_CONFIGURED');
  assert.equal((await challenge(f.server, initialParent('cannot-grant-setup'), 2)).body.code, 'PARENT_ALREADY_CONFIGURED');
  assert.equal(fs.readFileSync(f.dataFile, 'utf8'), before);
  assert.deepEqual((await initialize(f.server, actions[winner])).body, results[winner].body);
  const verifyWinner = await challenge(f.server, credit('winner-only'), 2);
  assert.equal((await verify(f.server, verifyWinner.body.challengeId, actions[loser].pin)).status, 403);
  assert.equal((await verify(f.server, verifyWinner.body.challengeId, actions[winner].pin)).status, 200);
});

test('v8 concurrent identical setup retries commit once and reject changed PIN or confirmation under the same ID', async t => {
  const f = await fixture(t, { parentPin: undefined });
  const action = initialParent('retry-same-setup');
  const results = await Promise.all([initialize(f.server, action), initialize(f.server, action)]);
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  assert.deepEqual(results[0].body, results[1].body);
  assert.deepEqual(results[0].body.state.appliedActions, [action.id]);
  assert.equal(results[0].body.revision, 2);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(f.dataFile, 'utf8')).receipts), [action.id]);
  const changed = await initialize(f.server, initialParent(action.id, '864209'));
  assert.equal(changed.status, 400); assert.equal(changed.body.code, 'ACTION_ID_REUSED');
  const changedConfirmation = await initialize(f.server, Object.assign({}, action, { confirmPin: '864209' }));
  assert.equal(changedConfirmation.body.code, 'ACTION_ID_REUSED');
  const reordered = { confirmPin: action.pin, method: 'pin', pin: action.pin, type: 'parent.setup', id: action.id };
  assert.deepEqual((await initialize(f.server, reordered)).body, results[0].body);
});

test('v8 public progress can stale setup without closing it and the retry preserves that progress', async t => {
  const f = await fixture(t, { parentPin: undefined });
  const toggled = await post(f.server, '/api/action', { revision: 1, action: { id: 'before-parent', type: 'task.toggle', taskId: 'task-reading' } });
  assert.equal(toggled.status, 200);
  const stale = await initialize(f.server);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, undefined);
  assert.deepEqual(stale.body, toggled.body);
  assert.deepEqual(stale.body.parent, { configured: false, method: null });
  const result = await initialize(f.server, initialParent('first-parent'), 2);
  assert.equal(result.status, 200);
  assert.equal(result.body.revision, 3);
  assert.deepEqual(result.body.state.tasks, toggled.body.state.tasks);
  assert.deepEqual(result.body.state.appliedActions, ['before-parent', 'first-parent']);
});

test('v8 first setup write failure retains unset state and permits the identical atomic retry', async t => {
  const f = await fixture(t, { parentPin: undefined });
  const before = fs.readFileSync(f.dataFile, 'utf8');
  const beforeSnapshot = (await state(f.server)).body;
  const action = initialParent('first-write-retry');
  const backup = path.join(path.dirname(f.dataFile), 'v8-unset-backup.json');
  assert.equal(f.dataFile, path.join(f.rootDir, 'data', 'state.json'));
  assert.equal(path.dirname(backup), path.join(f.rootDir, 'data'));
  fs.renameSync(f.dataFile, backup); fs.mkdirSync(f.dataFile);
  const failed = await initialize(f.server, action);
  assert.equal(failed.status, 500); assert.equal(failed.body.code, 'SAVE_FAILED');
  assert.deepEqual((await state(f.server)).body, beforeSnapshot);
  assert.equal(fs.readFileSync(backup, 'utf8'), before);
  assert.equal(fs.readdirSync(path.dirname(f.dataFile)).filter(name => name.endsWith('.tmp')).length, 0);
  fs.rmdirSync(f.dataFile); fs.renameSync(backup, f.dataFile);
  const retried = await initialize(f.server, action);
  assert.equal(retried.status, 200); assert.equal(retried.body.revision, 2);
  assert.deepEqual((await initialize(f.server, action)).body, retried.body);
});

test('v8 arithmetic can be the first method without a hidden PIN and a later PIN needs current arithmetic authorization', async t => {
  const f = await fixture(t, { parentPin: undefined });
  const action = { id: 'first-math', type: 'parent.setup', method: 'math' };
  const result = await initialize(f.server, action);
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.dataFile, 'utf8')).parent, { configured: true, method: 'math' });
  assert.equal(JSON.parse(fs.readFileSync(f.dataFile, 'utf8')).receipts[action.id].algorithm, 'scrypt');
  await close(f.server);
  const restarted = createServer(f.config); t.after(() => close(restarted)); await listen(restarted);
  assert.deepEqual((await state(restarted)).body, result.body);
  assert.equal((await challenge(restarted, { id: 'missing-new-pin', type: 'parent.configure', method: 'pin' }, 2)).status, 400);
  const configure = { id: 'math-to-new-pin', type: 'parent.configure', method: 'pin', pin: '864209', confirmPin: '864209' };
  const started = await challenge(restarted, configure, 2);
  assert.equal(started.status, 200); assert.equal(started.body.method, 'math');
  const checked = await verify(restarted, started.body.challengeId, mathAnswer(started.body));
  assert.equal(checked.status, 200);
  assert.equal((await post(restarted, '/api/action', { revision: 2, action: configure })).body.code, 'PARENT_REQUIRED');
  const configured = await post(restarted, '/api/action', { revision: 2, action: configure, grant: checked.body.grant });
  assert.equal(configured.status, 200);
  assert.deepEqual(configured.body.parent, { configured: true, method: 'pin' });
  assert.ok(await authorize(restarted, credit('new-pin-proof'), 3, configure.pin));
  assert.equal(JSON.parse(fs.readFileSync(f.dataFile, 'utf8')).receipts[configure.id].algorithm, 'scrypt');
});

test('v8 changing a self-set PIN validates confirmation and still requires the currently configured PIN', async t => {
  const f = await fixture(t, { parentPin: undefined });
  const original = initialParent('initial-self-set');
  await initialize(f.server, original);
  const before = fs.readFileSync(f.dataFile, 'utf8');
  const configure = { id: 'change-self-set', type: 'parent.configure', method: 'pin', pin: '864209', confirmPin: '864209' };
  const mismatch = await challenge(f.server, Object.assign({}, configure, { confirmPin: '000000' }), 2);
  assert.equal(mismatch.status, 400);
  const started = await challenge(f.server, configure, 2);
  assert.equal((await verify(f.server, started.body.challengeId, configure.pin)).status, 403);
  assert.equal(fs.readFileSync(f.dataFile, 'utf8'), before);
  const checked = await verify(f.server, started.body.challengeId, original.pin);
  assert.equal(checked.status, 200);
  assert.equal((await post(f.server, '/api/action', { revision: 2, action: configure, grant: checked.body.grant })).status, 200);
  const after = await challenge(f.server, credit('after-self-set-change'), 3);
  assert.equal((await verify(f.server, after.body.challengeId, original.pin)).status, 403);
  assert.equal((await verify(f.server, after.body.challengeId, configure.pin)).status, 200);
});

test('v8 legacy credentials without a configured flag remain closed, retain twelve-digit PIN support and ignore replacement deployment PINs', async t => {
  const oldPin = '123456789012';
  const f = await fixture(t, { parentPin: oldPin });
  await post(f.server, '/api/action', { revision: 1, action: petCare('legacy-care') });
  await close(f.server);
  const saved = JSON.parse(fs.readFileSync(f.dataFile, 'utf8'));
  delete saved.parent.configured;
  fs.writeFileSync(f.dataFile, JSON.stringify(saved));
  const restarted = createServer(Object.assign({}, f.config, { parentPin: '000000' }));
  t.after(() => close(restarted)); await listen(restarted);
  const migrated = JSON.parse(fs.readFileSync(f.dataFile, 'utf8'));
  assert.deepEqual(migrated, Object.assign({}, saved, { parent: Object.assign({}, saved.parent, { configured: true }) }));
  const blocked = await initialize(restarted, initialParent('legacy-cannot-reset'), 2);
  assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'PARENT_ALREADY_CONFIGURED');
  const started = await challenge(restarted, credit('legacy-twelve-pin'), 2);
  assert.equal((await verify(restarted, started.body.challengeId, '000000')).status, 403);
  assert.equal((await verify(restarted, started.body.challengeId, oldPin)).status, 200);
  assert.equal(migrated.receipts['legacy-care'].algorithm, 'sha256');
  await close(restarted);
  const legacyMath = JSON.parse(fs.readFileSync(f.dataFile, 'utf8'));
  delete legacyMath.parent.configured;
  legacyMath.parent.method = 'math';
  fs.writeFileSync(f.dataFile, JSON.stringify(legacyMath));
  const mathRestarted = createServer(Object.assign({}, f.config, { parentPin: '000000' }));
  t.after(() => close(mathRestarted)); await listen(mathRestarted);
  const retained = JSON.parse(fs.readFileSync(f.dataFile, 'utf8'));
  assert.deepEqual(retained, Object.assign({}, legacyMath, { parent: Object.assign({}, legacyMath.parent, { configured: true }) }));
  const mathChallenge = await challenge(mathRestarted, credit('legacy-math-proof'), 2);
  assert.equal(mathChallenge.body.method, 'math');
  assert.equal((await verify(mathRestarted, mathChallenge.body.challengeId, mathAnswer(mathChallenge.body))).status, 200);
  assert.equal((await initialize(mathRestarted, initialParent('legacy-math-cannot-reset'), 2)).body.code, 'PARENT_ALREADY_CONFIGURED');
});

test('v8 malformed configuration states cannot reopen setup and leave their original files untouched', async t => {
  const f = await fixture(t, { parentPin: undefined });
  await initialize(f.server);
  await close(f.server);
  const valid = JSON.parse(fs.readFileSync(f.dataFile, 'utf8'));
  const parents = [
    Object.assign({}, valid.parent, { configured: false }),
    Object.assign({}, valid.parent, { configured: 'false' }),
    { configured: true, method: 'pin' },
    { configured: true, method: 'math', salt: valid.parent.salt },
    { configured: false, method: 'math' },
    { configured: false, method: null, pin: '123456' },
    { method: 'math' },
    { configured: false, method: null }
  ];
  for (const parent of parents) {
    const raw = JSON.stringify(Object.assign({}, valid, { parent }));
    fs.writeFileSync(f.dataFile, raw);
    assert.throws(() => createServer(f.config), /已保留原文件/);
    assert.equal(fs.readFileSync(f.dataFile, 'utf8'), raw);
  }
});
