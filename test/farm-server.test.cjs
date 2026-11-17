'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('../server.cjs');
const M = require('../model.js');
const NOW = new Date(2026, 10, 16, 8, 0, 0);
const EIGHT_HOURS = 8 * 60 * 60 * 1000;
const PIN = '246810';
const amounts = (carrot = 0, strawberry = 0, sunflower = 0) => ({ carrot, strawberry, sunflower });
const copy = value => JSON.parse(JSON.stringify(value));
function request(server, method, route, body) {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: route, method, agent: false,
      headers: encoded === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }
    }, res => {
      const buffers = [];
      res.on('data', part => buffers.push(part));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(buffers).toString('utf8');
        let body = text;
        try { body = JSON.parse(text); } catch (_) { /* a permitted static asset */ }
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('farm HTTP test timeout')));
    req.on('error', reject);
    req.end(encoded);
  });
}
const get = fixture => request(fixture.server, 'GET', '/api/state');
const post = (fixture, action, revision, extra = {}) => request(fixture.server, 'POST', '/api/action', { revision, action, ...extra });
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-http-test-'));
  const rootDir = path.join(directory, 'public');
  const dataFile = path.join(directory, 'private', 'state.json');
  fs.mkdirSync(path.join(rootDir, 'assets'), { recursive: true });
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  for (const name of ['index.html', 'farm-ui.js', 'farm.css', 'farm-scene.js', 'farm-secret.js']) {
    fs.writeFileSync(path.join(rootDir, name), 'fixture ' + name);
  }
  fs.writeFileSync(path.join(rootDir, 'assets', 'model.glb'), 'not a public route');
  if (options.state) { fs.writeFileSync(dataFile, JSON.stringify({ revision: 1, state: options.state })); }
  const config = { rootDir, dataFile, now: options.now || (() => new Date(NOW)), parentPin: options.parentPin,
    assistantService: { status: () => ({ mode: 'local', label: '测试' }), interpret: async () => ({ kind: 'clarify', message: '测试' }) } };
  const f = { config, dataFile, directory, server: createServer(config), sequence: 0 };
  t.after(async () => {
    await close(f.server);
    // Cleanup can only target the freshly created test directory, never the repo.
    assert.equal(fs.realpathSync(path.dirname(directory)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(directory), /^farm-http-test-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await listen(f.server);
  assert.notEqual(f.server.address().port, 4178);
  f.restart = async () => {
    await close(f.server);
    f.server = createServer(config);
    await listen(f.server);
    assert.notEqual(f.server.address().port, 4178);
  };
  f.disk = () => fs.readFileSync(dataFile, 'utf8');
  return f;
}
async function commit(f, type, values = {}, status = 200) {
  const current = await get(f);
  const result = await post(f, { id: 'http-farm-' + (++f.sequence), type, ...values }, current.body.revision);
  assert.equal(result.status, status, JSON.stringify(result.body));
  return result;
}
function inMemoryState(xp = 500, inventory) {
  let state = M.createSeed(NOW);
  state.points = xp ? [{ id: 'fixture-points', itemId: '', name: '累计成长', points: xp, reason: '测试资格', at: NOW.toISOString() }] : [];
  state.redemptions = [];
  if (inventory) {
    state = M.apply(state, { id: 'fixture-start', type: 'farm.start' }, NOW);
    state.farm.inventory = inventory;
  }
  return state;
}

test('snapshots expose one server time sample and only the three farm static entry files', async t => {
  let calls = 0;
  let time = new Date(NOW);
  const f = await fixture(t, { now: () => { calls++; return new Date(time); } });
  const before = calls;
  const snapshot = await get(f);
  assert.equal(calls - before, 1);
  assert.equal(snapshot.body.serverNow, time.toISOString());
  assert.equal(snapshot.body.familyDay, M.dateKey(time));
  assert.equal(snapshot.body.state.farm, null);
  assert.deepEqual(snapshot.body.parent, { configured: false, method: null });
  assert.equal(snapshot.body.receipts, undefined);
  for (const route of ['/farm-ui.js', '/farm.css', '/farm-scene.js']) {
    const result = await request(f.server, 'GET', route);
    assert.equal(result.status, 200);
    assert.match(result.headers['content-type'], /javascript|css/);
  }
  for (const route of ['/farm-secret.js', '/assets/model.glb', '/private/state.json', '/server.cjs']) {
    assert.equal((await request(f.server, 'GET', route)).status, 404, route);
  }
  assert.equal((await request(f.server, 'GET', '/../private/state.json')).status, 400);
  time = new Date(2026, 10, 17, 0, 0, 0);
  const next = await get(f);
  assert.equal(next.body.serverNow, time.toISOString());
  assert.equal(next.body.familyDay, '2026-11-17');
  assert.equal(next.body.revision, snapshot.body.revision);
  assert.equal(next.body.state.farm, null);
});

test('all six farm actions work publicly without setup and never change the points ledger', async t => {
  const f = await fixture(t);
  const original = (await get(f)).body.state;
  let response = await commit(f, 'farm.start');
  assert.equal(response.body.state.farm.initialized, true);
  response = await commit(f, 'farm.harvest');
  assert.deepEqual(response.body.state.farm.inventory, amounts(3));
  response = await commit(f, 'farm.exchange', { itemId: 'flowerpot' });
  assert.deepEqual(response.body.state.farm.inventory, amounts());
  response = await commit(f, 'farm.place', { slot: 'entry', itemId: 'flowerpot' });
  assert.equal(response.body.state.farm.placements.entry, 'flowerpot');
  response = await commit(f, 'farm.plant', { cropId: 'strawberry' });
  assert.equal(M.farmStatus(response.body.state, response.body.serverNow, response.body.familyDay).plots.filter(plot => plot.status === 'growing').length, 4);
  response = await commit(f, 'farm.animalCare', { animalId: 'rabbit', care: 'pet' });
  assert.equal(response.body.state.farm.animalCare.length, 1);
  assert.deepEqual(response.body.parent, { configured: false, method: null });
  for (const key of ['points', 'redemptions', 'requests', 'petPurchases', 'petCare', 'settings', 'tasks', 'childName', 'childAvatar', 'pet']) {
    assert.deepEqual(response.body.state[key], original[key], key);
  }
  assert.deepEqual(M.totals(response.body.state), { earned: 128, spent: 40, available: 88 });
  assert.equal(M.growth(response.body.state).xp, 128);
  assert.equal(response.body.revision, 7);
  assert.equal(Object.keys(JSON.parse(f.disk()).receipts).length, 6);
});

test('simultaneous starts and welcome harvests commit once and exact retries survive a restart', async t => {
  const f = await fixture(t);
  const starts = [{ id: 'start-device-a', type: 'farm.start' }, { id: 'start-device-b', type: 'farm.start' }];
  const starting = await Promise.all(starts.map(action => post(f, action, 1)));
  assert.deepEqual(starting.map(result => result.status).sort(), [200, 409]);
  const winner = starting.findIndex(result => result.status === 200);
  const gift = copy(starting[winner].body.state.farm.welcomeGift);
  assert.equal((await post(f, starts[winner], 1)).status, 200);
  assert.equal((await post(f, starts[1 - winner], 2)).status, 400);
  const action = { id: 'same-welcome-harvest', type: 'farm.harvest' };
  const duplicates = await Promise.all([post(f, action, 2), post(f, action, 2)]);
  assert.deepEqual(duplicates.map(result => result.status), [200, 200]);
  assert.deepEqual(duplicates[0].body, duplicates[1].body);
  assert.equal(duplicates[0].body.revision, 3);
  assert.deepEqual(duplicates[0].body.state.farm.inventory, amounts(3));
  await f.restart();
  const retry = await post(f, action, 2);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, duplicates[0].body);
  assert.equal(retry.body.state.farm.welcomeGift.batchId, gift.batchId);
  assert.equal(retry.body.state.farm.welcomeGift.harvestedAt, NOW.toISOString());
  const different = await post(f, { ...action, plotIds: ['p1'] }, 3);
  assert.equal(different.status, 400);
  assert.equal(different.body.code, 'ACTION_ID_REUSED');
  await commit(f, 'farm.start', {}, 400);
  assert.deepEqual((await get(f)).body.state.farm.inventory, amounts(3));
});

test('two different devices cannot harvest the same batch or debit the same materials twice', async t => {
  const f = await fixture(t);
  await commit(f, 'farm.start');
  const harvests = [{ id: 'harvest-a', type: 'farm.harvest' }, { id: 'harvest-b', type: 'farm.harvest', plotIds: ['p1'] }];
  const harvested = await Promise.all(harvests.map(action => post(f, action, 2)));
  assert.deepEqual(harvested.map(result => result.status).sort(), [200, 409]);
  assert.deepEqual((await get(f)).body.state.farm.inventory, amounts(3));
  const loser = harvested.findIndex(result => result.status === 409);
  assert.equal((await post(f, harvests[loser], 3)).status, 400);
  const exchanges = [{ id: 'exchange-a', type: 'farm.exchange', itemId: 'flowerpot' }, { id: 'exchange-b', type: 'farm.exchange', itemId: 'flowerpot' }];
  const exchanged = await Promise.all(exchanges.map(action => post(f, action, 3)));
  assert.deepEqual(exchanged.map(result => result.status).sort(), [200, 409]);
  const final = (await get(f)).body;
  assert.deepEqual(final.state.farm.inventory, amounts());
  assert.equal(final.state.farm.owned.filter(id => id === 'flowerpot').length, 1);
  const retry = await post(f, exchanges[exchanged.findIndex(result => result.status === 409)], final.revision);
  assert.equal(retry.status, 400);
  assert.match(retry.body.error, /已经拥有/);
  assert.deepEqual((await get(f)).body, final);
});

test('eight-hour readiness uses server time across downtime and persists planting, placement and care', async t => {
  let clock = new Date(NOW);
  const f = await fixture(t, { now: () => new Date(clock), state: inMemoryState(100) });
  await commit(f, 'farm.start');
  await commit(f, 'farm.harvest');
  const planting = await commit(f, 'farm.plant', { cropId: 'strawberry' });
  const batchIds = planting.body.state.farm.plots.map(plot => plot.batchId);
  const plantedDisk = f.disk();
  clock = new Date(+NOW + EIGHT_HOURS - 1);
  await f.restart();
  assert.equal(f.disk(), plantedDisk);
  const early = await commit(f, 'farm.harvest', {}, 400);
  assert.match(early.body.error, /成熟/);
  assert.equal(f.disk(), plantedDisk);
  clock = new Date(+NOW + EIGHT_HOURS);
  const mature = (await get(f)).body;
  assert.equal(mature.serverNow, clock.toISOString());
  assert.equal(M.farmStatus(mature.state, mature.serverNow, mature.familyDay).readyCount, 4);
  assert.deepEqual(mature.state.farm.plots.map(plot => plot.batchId), batchIds);
  const harvested = await commit(f, 'farm.harvest');
  assert.deepEqual(harvested.body.state.farm.inventory, amounts(3, 12));
  await commit(f, 'farm.exchange', { itemId: 'flowerpot' });
  await commit(f, 'farm.place', { slot: 'entry', itemId: 'flowerpot' });
  await commit(f, 'farm.animalCare', { animalId: 'chicken', care: 'feed' });
  await commit(f, 'farm.plant', { cropId: 'carrot', plotIds: ['p1'] });
  const saved = (await get(f)).body;
  await f.restart();
  assert.deepEqual((await get(f)).body, saved);
  clock = new Date(+clock + 80 * EIGHT_HOURS);
  const later = (await get(f)).body;
  const status = M.farmStatus(later.state, later.serverNow, later.familyDay);
  assert.equal(status.readyCount, 1);
  assert.equal(status.emptyCount, 3);
  assert.deepEqual(status.inventory, amounts(0, 12));
  assert.equal(status.placements.entry, 'flowerpot');
  assert.equal(status.animals[0].careCount, 1);
});

test('insufficient, locked and already-owned exchanges fail without any partial crop deduction', async t => {
  const f = await fixture(t, { state: inMemoryState(100, amounts(6, 2)) });
  const before = f.disk();
  const shortage = await commit(f, 'farm.exchange', { itemId: 'picnic' }, 400);
  assert.match(shortage.body.error, /草莓/);
  const locked = await commit(f, 'farm.exchange', { itemId: 'windmill' }, 400);
  assert.match(locked.body.error, /成长/);
  const owned = await commit(f, 'farm.exchange', { itemId: 'path' }, 400);
  assert.match(owned.body.error, /已经拥有/);
  await commit(f, 'farm.plant', { cropId: 'sunflower' }, 400);
  await commit(f, 'farm.plant', { cropId: 'carrot', plotIds: ['p6'] }, 400);
  assert.equal(f.disk(), before);
  const canBuy = M.farmStatus((await get(f)).body.state, NOW).catalog.find(item => item.id === 'flowerpot');
  assert.equal(canBuy.canBuy, true);
  const success = await commit(f, 'farm.exchange', { itemId: 'flowerpot' });
  assert.deepEqual(success.body.state.farm.inventory, amounts(3, 2));
  assert.ok(success.body.state.farm.owned.includes('flowerpot'));
  assert.deepEqual(M.totals(success.body.state), { earned: 100, spent: 0, available: 100 });
});

test('different competing exchanges cannot spend one shared crop inventory twice', async t => {
  const f = await fixture(t, { state: inMemoryState(500, amounts(12, 12)) });
  const commands = [{ id: 'compete-house', type: 'farm.exchange', itemId: 'house2' },
    { id: 'compete-mailbox', type: 'farm.exchange', itemId: 'mailbox' }];
  const results = await Promise.all(commands.map(action => post(f, action, 1)));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const winner = results.findIndex(result => result.status === 200);
  const saved = (await get(f)).body;
  assert.deepEqual(saved.state.farm.inventory, winner === 0 ? amounts() : amounts(3, 3));
  assert.equal(saved.state.farm.owned.includes(commands[winner].itemId), true);
  assert.equal(saved.state.farm.owned.includes(commands[1 - winner].itemId), false);
  const retried = await post(f, commands[1 - winner], saved.revision);
  assert.equal(retried.status, 400);
  assert.match(retried.body.error, /还缺/);
  assert.deepEqual((await get(f)).body, saved);
});

test('house upgrades require level two first and persist exactly one upgraded house', async t => {
  const f = await fixture(t, { state: inMemoryState(500, amounts(36, 36, 24)) });
  const before = f.disk();
  const skipped = await commit(f, 'farm.exchange', { itemId: 'house3' }, 400);
  assert.match(skipped.body.error, /先建成2级/);
  assert.equal(f.disk(), before);
  const second = await commit(f, 'farm.exchange', { itemId: 'house2' });
  assert.equal(second.body.state.farm.houseLevel, 2);
  assert.deepEqual(second.body.state.farm.inventory, amounts(24, 24, 24));
  const action = { id: 'upgrade-third', type: 'farm.exchange', itemId: 'house3' };
  const third = await post(f, action, second.body.revision);
  assert.equal(third.status, 200);
  assert.equal(third.body.state.farm.houseLevel, 3);
  assert.deepEqual(third.body.state.farm.inventory, amounts());
  await f.restart();
  assert.deepEqual((await post(f, action, second.body.revision)).body, third.body);
  assert.deepEqual(third.body.state.farm.owned, ['fence', 'path', 'house2', 'house3']);
  assert.deepEqual(M.totals(third.body.state), { earned: 500, spent: 0, available: 500 });
  await commit(f, 'farm.exchange', { itemId: 'house3' }, 400);
});

test('failed atomic save leaves materials, ownership and receipts untouched for a successful exact retry', async t => {
  const f = await fixture(t, { state: inMemoryState(500, amounts(6, 3)) });
  const before = f.disk();
  const rename = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === f.dataFile) { throw new Error('injected write failure in test directory'); }
    return rename(source, destination);
  });
  const action = { id: 'retry-atomic-exchange', type: 'farm.exchange', itemId: 'picnic' };
  const failed = await post(f, action, 1);
  assert.equal(failed.status, 500);
  assert.equal(failed.body.code, 'SAVE_FAILED');
  assert.equal(f.disk(), before);
  assert.equal((await get(f)).body.revision, 1);
  assert.deepEqual((await get(f)).body.state.farm.inventory, amounts(6, 3));
  mocked.mock.restore();
  const saved = await post(f, action, 1);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 2);
  assert.deepEqual(saved.body.state.farm.inventory, amounts());
  assert.ok(saved.body.state.farm.owned.includes('picnic'));
  const retried = await post(f, action, 1);
  assert.deepEqual(retried.body, saved.body);
  const envelope = JSON.parse(f.disk());
  assert.equal(Object.keys(envelope.receipts).length, 1);
  assert.equal(fs.readdirSync(path.dirname(f.dataFile)).filter(name => name.endsWith('.tmp')).length, 0);
});

test('farm prefixes and payload fields cannot bypass the public whitelist or submit rewards and dates', async t => {
  const f = await fixture(t, { parentPin: PIN });
  await commit(f, 'farm.start');
  const before = f.disk();
  for (const type of ['farm.points.add', 'farm.buy', 'farm.reset', 'farm.constructor', 'farm.__proto__', 'points.add', 'pet.buy']) {
    const result = await commit(f, type, { points: 999 }, 403);
    assert.equal(result.body.code, 'PARENT_REQUIRED');
  }
  for (const [type, values] of [
    ['farm.start', {}], ['farm.plant', { cropId: 'carrot' }], ['farm.harvest', {}],
    ['farm.exchange', { itemId: 'flowerpot' }], ['farm.place', { slot: 'entry', itemId: null }],
    ['farm.animalCare', { animalId: 'chicken', care: 'feed' }]
  ]) {
    for (const key of ['points', 'inventory', 'familyDay']) {
      const response = await commit(f, type, { ...values, [key]: 999 }, 400);
      assert.match(response.body.error, /客户端字段/);
    }
  }
  assert.equal(f.disk(), before);
  const snapshot = (await get(f)).body;
  const action = { id: 'forged-envelope-clock', type: 'farm.animalCare', animalId: 'chicken', care: 'feed' };
  const result = await post(f, action, snapshot.revision, { familyDay: '2099-01-01', serverNow: '2099-01-01T00:00:00Z', points: 999 });
  assert.equal(result.status, 200);
  assert.equal(result.body.state.farm.animalCare[0].day, M.dateKey(NOW));
  assert.equal(result.body.state.farm.animalCare[0].at, NOW.toISOString());
  assert.deepEqual(M.totals(result.body.state), M.totals(snapshot.state));
});

test('animal care deduplicates across devices, natural midnight and repeated visits without streak resets', async t => {
  let clock = new Date(2026, 10, 16, 23, 59, 59, 999);
  const f = await fixture(t, { now: () => new Date(clock) });
  await commit(f, 'farm.start');
  const actions = [{ id: 'animal-device-a', type: 'farm.animalCare', animalId: 'chicken', care: 'feed' },
    { id: 'animal-device-b', type: 'farm.animalCare', animalId: 'chicken', care: 'pet' }];
  const results = await Promise.all(actions.map(action => post(f, action, 2)));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const loser = results.findIndex(result => result.status === 409);
  const repeated = await post(f, actions[loser], 3);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.state.farm.animalCare.length, 1);
  assert.equal(repeated.body.familyDay, '2026-11-16');
  clock = new Date(2026, 10, 17, 0, 0, 0);
  const nextDay = await commit(f, 'farm.animalCare', { animalId: 'chicken', care: 'feed' });
  assert.equal(nextDay.body.familyDay, '2026-11-17');
  assert.equal(nextDay.body.state.farm.animalCare.length, 2);
  for (let day = 0; day < 5; day++) {
    clock = new Date(2026, 10, 20 + day * 2, 12);
    await commit(f, 'farm.animalCare', { animalId: 'chicken', care: 'pet' });
    await commit(f, 'farm.animalCare', { animalId: 'chicken', care: 'feed' });
  }
  await f.restart();
  const final = (await get(f)).body;
  const chicken = M.farmStatus(final.state, new Date(2040, 0, 1), final.familyDay).animals[0];
  assert.equal(chicken.careCount, 7);
  assert.equal(chicken.caredToday, true);
  assert.equal(chicken.cardUnlocked, true);
  assert.equal(chicken.actionUnlocked, true);
  assert.deepEqual(final.state.farm.inventory, amounts());
  assert.deepEqual(M.totals(final.state), { earned: 128, spent: 40, available: 88 });
});

test('legacy inventories and care survive migration; farm interactions stop new exploration and old purchases', async t => {
  let old = M.createSeed(NOW);
  old = M.apply(old, { id: 'old-purchase', type: 'pet.buy', itemId: 'snack', quantity: 1, expectedPoints: 3 }, NOW);
  old = M.apply(old, { id: 'old-free-feed', type: 'pet.care', care: 'feed', source: 'free' }, NOW);
  delete old.farm;
  const original = copy(old);
  const f = await fixture(t, { state: old, parentPin: PIN });
  const migrated = (await get(f)).body;
  assert.deepEqual(migrated.state, { ...original, farm: null });
  const archived = M.petStatus(migrated.state, NOW);
  const baseline = M.totals(migrated.state);
  await commit(f, 'farm.start');
  for (const care of ['wash', 'train', 'feed', 'wash', 'train', 'feed']) {
    await commit(f, 'pet.care', { care, source: 'free' });
  }
  let snapshot = (await get(f)).body;
  const actions = [{ id: 'old-inventory-a', type: 'pet.care', care: 'feed', source: 'inventory' },
    { id: 'old-inventory-b', type: 'pet.care', care: 'feed', source: 'inventory' }];
  const spent = await Promise.all(actions.map(action => post(f, action, snapshot.revision)));
  assert.deepEqual(spent.map(result => result.status).sort(), [200, 409]);
  snapshot = (await get(f)).body;
  const shortage = await post(f, actions[spent.findIndex(result => result.status === 409)], snapshot.revision);
  assert.equal(shortage.status, 400);
  assert.match(shortage.body.error, /库存/);
  assert.equal(M.petStatus(snapshot.state, NOW).inventory.snack, 0);
  const purchase = { id: 'old-api-new-buy', type: 'pet.buy', itemId: 'snack', quantity: 1, expectedPoints: 3 };
  const refused = await request(f.server, 'POST', '/api/parent/challenge', { revision: snapshot.revision, action: purchase });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /停止购买/);
  await f.restart();
  const final = (await get(f)).body;
  assert.deepEqual(final.state.petPurchases, original.petPurchases);
  assert.deepEqual(final.state.petCare.slice(0, original.petCare.length), original.petCare);
  assert.ok(final.state.petCare.slice(original.petCare.length).every(row => row.farmMode === true));
  const status = M.petStatus(final.state, NOW);
  assert.equal(status.exploration, archived.exploration);
  assert.equal(status.dailyBonusEarned, false);
  assert.deepEqual(status.caredToday, archived.caredToday);
  assert.deepEqual(status.unlockedScenes, archived.unlockedScenes);
  assert.equal(status.freeUnlimited, true);
  assert.equal(status.purchasesEnabled, false);
  assert.deepEqual(M.totals(final.state), baseline);
  assert.deepEqual(final.state.farm.inventory, amounts());
});

test('a corrupt persisted farm fails closed and leaves the temporary original file intact', async t => {
  const f = await fixture(t);
  await commit(f, 'farm.start');
  await close(f.server);
  const saved = JSON.parse(f.disk());
  saved.state.farm.inventory.carrot = -1;
  fs.writeFileSync(f.dataFile, JSON.stringify(saved));
  const before = f.disk();
  assert.throws(() => createServer(f.config), /已保留原文件/);
  assert.equal(f.disk(), before);
});
