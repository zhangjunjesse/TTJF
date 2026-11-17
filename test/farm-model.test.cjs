'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const M = require('../model.js');
const NOW = new Date(2026, 10, 16, 8, 0, 0);
const EIGHT_HOURS = 8 * 60 * 60 * 1000;
const copy = value => JSON.parse(JSON.stringify(value));
const amounts = (carrot = 0, strawberry = 0, sunflower = 0) => ({ carrot, strawberry, sunflower });
function freeze(value) {
  Object.values(value).forEach(item => { if (item && typeof item === 'object') { freeze(item); } });
  return Object.freeze(value);
}
function act(state, type, values = {}, now = NOW) {
  return M.apply(state, { id: 'farm-test-' + (state.appliedActions.length + 1), type, ...values }, now);
}
function atGrowth(xp) {
  const state = M.createSeed(NOW);
  state.points = xp ? [{ id: 'earned-fixture', itemId: '', name: '历史成长', points: xp, reason: '测试累计资格', at: NOW.toISOString() }] : [];
  state.redemptions = [];
  return state;
}
function started(xp = 500) { return act(atGrowth(xp), 'farm.start'); }
function financial(state) {
  const growth = M.growth(state);
  delete growth.stageName; // Switching partner changes the name, not progress.
  return copy({ points: state.points, redemptions: state.redemptions, requests: state.requests,
    petPurchases: state.petPurchases, totals: M.totals(state), growth });
}
function stocked(xp = 500, inventory = amounts(100, 100, 100)) {
  const state = started(xp);
  // Deliberate in-memory fixture: no family file or runtime server is touched.
  state.farm.inventory = inventory;
  return state;
}

test('farm status is a pure ES5 UMD projection and normalization never creates operations', () => {
  const legacy = M.createSeed(NOW);
  assert.equal(legacy.farm, null);
  delete legacy.farm;
  const before = JSON.stringify(legacy);
  const status = M.farmStatus(freeze(legacy), NOW, '2026-11-16');
  assert.equal(status.initialized, false);
  assert.deepEqual(status.inventory, amounts());
  assert.deepEqual(status.owned, []);
  assert.equal(status.houseLevel, 0);
  assert.equal(status.readyCount, 0);
  assert.equal(status.welcomeGift, null);
  assert.equal(status.lastHarvest, null);
  assert.equal(status.catalog.some(item => item.canBuy || item.owned), false);
  assert.equal(JSON.stringify(legacy), before);
  const normalized = M.normalize(legacy);
  assert.equal(normalized.farm, null);
  assert.deepEqual(normalized.appliedActions, []);
  assert.deepEqual(M.normalize(normalized), normalized);
  assert.equal(JSON.stringify(legacy), before);
  const source = fs.readFileSync(require.resolve('../model.js'), 'utf8');
  const code = source.replace(/'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, ' ');
  assert.doesNotMatch(code, /\b(?:let|const|class|async|await)\b|=>|\.\.\.|\?\./);
  const context = { window: {} };
  vm.runInNewContext(source, context);
  const browser = context.window.FamilyModel;
  assert.deepEqual(copy(browser.farmStatus(browser.createSeed(NOW), NOW)), M.farmStatus(M.createSeed(NOW), NOW));
  const browserFarm = browser.apply(browser.createSeed(NOW), { id: 'browser-start', type: 'farm.start' }, NOW);
  assert.equal(browser.farmStatus(browserFarm, NOW).readyCount, 1);
});

test('explicit start grants one tagged mature carrot plot without fictional planting or ownership', () => {
  const state = freeze(atGrowth(500));
  const original = JSON.stringify(state);
  const command = { id: 'start-once', type: 'farm.start' };
  let farm = M.apply(state, command, NOW);
  const status = M.farmStatus(farm, NOW);
  assert.equal(status.initialized, true);
  assert.equal(status.readyCount, 1);
  assert.equal(status.emptyCount, 5);
  assert.deepEqual(status.owned, ['fence', 'path']);
  assert.equal(status.houseLevel, 1);
  assert.deepEqual(status.inventory, amounts());
  assert.equal(status.plots[0].status, 'ready');
  assert.equal(status.plots[0].cropId, 'carrot');
  assert.equal(status.plots[0].welcomeGift, true);
  assert.equal(status.plots[0].plantedAt, null);
  assert.equal(status.plots[0].readyAt, NOW.toISOString());
  assert.deepEqual(status.placements, { fence: 'fence', path: 'path', entry: null, center: null, edge: null });
  assert.strictEqual(M.apply(farm, command, NOW), farm);
  assert.throws(() => act(farm, 'farm.start'), /已经开启/);
  farm = act(farm, 'farm.harvest');
  const gift = copy(farm.farm.welcomeGift);
  assert.equal(gift.harvestedAt, NOW.toISOString());
  assert.deepEqual(farm.farm.inventory, amounts(3));
  farm = act(M.normalize(farm), 'pet.configure', { kind: 'capybara', name: '团团' });
  assert.deepEqual(farm.farm.welcomeGift, gift);
  assert.throws(() => act(farm, 'farm.start'), /已经开启/);
  assert.deepEqual(financial(farm), financial(state));
  assert.equal(JSON.stringify(state), original);
});

test('maximum public action IDs retain distinct persistent planting batches', () => {
  const identifier = 'a'.repeat(200);
  let state = M.apply(atGrowth(500), { id: identifier, type: 'farm.start' }, NOW);
  assert.equal(state.farm.welcomeGift.batchId, 'welcome-' + identifier);
  state = act(state, 'farm.harvest');
  state = M.apply(state, { id: 'b'.repeat(200), type: 'farm.plant', cropId: 'sunflower' }, NOW);
  assert.equal(new Set(state.farm.plots.map(plot => plot.batchId)).size, 6);
  state = M.apply(state, { id: 'c'.repeat(200), type: 'farm.animalCare', animalId: 'chicken', care: 'pet' }, NOW);
  state = M.apply(state, { id: 'd'.repeat(200), type: 'farm.harvest' }, new Date(+NOW + EIGHT_HOURS));
  assert.deepEqual(state.farm.inventory, amounts(3, 0, 18));
  assert.deepEqual(M.normalize(state), state);
});

test('all farm thresholds use cumulative earnings even after the available balance is spent', () => {
  for (const [xp, limit, strawberry, sunflower, rabbit, next] of [
    [0, 2, false, false, false, 30], [29, 2, false, false, false, 30],
    [30, 3, true, false, false, 100], [99, 3, true, false, false, 100],
    [100, 4, true, false, true, 250], [249, 4, true, false, true, 250],
    [250, 5, true, true, true, 500], [499, 5, true, true, true, 500], [500, 6, true, true, true, null]
  ]) {
    let state = atGrowth(xp);
    if (xp) { state.redemptions = [{ id: 'spent-fixture', rewardId: 'reward-pencil', name: '礼品', points: xp, category: 'daily', note: '', at: NOW.toISOString() }]; }
    state = act(state, 'farm.start');
    const status = M.farmStatus(state, NOW);
    assert.equal(M.totals(state).available, 0);
    assert.equal(status.plotLimit, limit);
    assert.equal(status.plots.filter(plot => plot.unlocked).length, limit);
    assert.deepEqual(status.plots.map(plot => plot.id), ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    assert.deepEqual(status.plots.map(plot => plot.index), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(status.crops.map(crop => crop.unlocked), [true, strawberry, sunflower]);
    assert.deepEqual(status.animals.map(animal => animal.unlocked), [true, rabbit]);
    assert.equal(status.nextUnlock && status.nextUnlock.threshold, next);
    assert.deepEqual(status.owned, ['fence', 'path']);
    assert.equal(status.houseLevel, 1);
  }
});

test('planting free seeds respects locks, occupied plots and all three eight-hour recipes', () => {
  const young = freeze(started(0));
  assert.throws(() => act(young, 'farm.plant', { cropId: 'strawberry' }), /尚未解锁/);
  assert.throws(() => act(young, 'farm.plant', { cropId: 'carrot', plotIds: ['p3'] }), /尚未解锁/);
  const grown = act(young, 'farm.plant', { cropId: 'carrot' });
  assert.equal(grown.farm.plots[0].welcomeGift, true);
  assert.equal(M.farmStatus(grown, NOW).plots[1].status, 'growing');
  assert.throws(() => act(grown, 'farm.plant', { cropId: 'carrot' }), /空田/);
  assert.throws(() => act(grown, 'farm.plant', { cropId: 'carrot', plotIds: ['p2'] }), /空田/);
  let state = act(started(), 'farm.harvest');
  for (const [index, cropId] of ['carrot', 'strawberry', 'sunflower'].entries()) {
    state = act(state, 'farm.plant', { cropId, plotIds: ['p' + (index + 1)] });
  }
  const status = M.farmStatus(state, NOW);
  assert.deepEqual(status.plots.slice(0, 3).map(plot => plot.cropId), ['carrot', 'strawberry', 'sunflower']);
  assert.deepEqual(status.plots.slice(0, 3).map(plot => plot.remainingMs), [EIGHT_HOURS, EIGHT_HOURS, EIGHT_HOURS]);
  assert.equal(new Set(status.plots.slice(0, 3).map(plot => plot.batchId)).size, 3);
  assert.equal(status.emptyCount, 3);
  assert.deepEqual(financial(state), financial(started()));
});

test('the exact eight-hour boundary and server downtime derive readiness without modifying storage', () => {
  let state = act(started(0), 'farm.harvest');
  state = freeze(act(state, 'farm.plant', { cropId: 'carrot' }));
  const before = JSON.stringify(state);
  const justBefore = new Date(+NOW + EIGHT_HOURS - 1);
  const exact = new Date(+NOW + EIGHT_HOURS);
  const after = new Date(+NOW + EIGHT_HOURS + 365 * 86400000);
  assert.equal(M.farmStatus(state, justBefore).readyCount, 0);
  assert.equal(M.farmStatus(state, justBefore).plots[0].remainingMs, 1);
  assert.equal(M.farmStatus(state, justBefore).nextReadyAt, exact.toISOString());
  assert.throws(() => act(state, 'farm.harvest', {}, justBefore), /成熟/);
  assert.equal(M.farmStatus(state, exact).readyCount, 2);
  assert.equal(M.farmStatus(state, exact).nextReadyAt, null);
  assert.equal(M.farmStatus(M.normalize(state), after).readyCount, 2);
  assert.equal(JSON.stringify(state), before);
  const harvested = act(state, 'farm.harvest', {}, after);
  assert.deepEqual(harvested.farm.inventory, amounts(9));
  assert.equal(M.farmStatus(harvested, after).emptyCount, 2);
  assert.equal(M.farmStatus(harvested, new Date(+after + 10 * EIGHT_HOURS)).readyCount, 0);
});

test('bulk and selected harvests only consume ready batches once and report the exact varieties', () => {
  let state = started(100);
  state = act(state, 'farm.plant', { cropId: 'strawberry', plotIds: ['p2', 'p3'] });
  state = act(state, 'farm.plant', { cropId: 'carrot', plotIds: ['p4'] }, new Date(+NOW + 1000));
  const exact = new Date(+NOW + EIGHT_HOURS);
  const command = { id: 'batch-harvest', type: 'farm.harvest', plotIds: ['p1', 'p2', 'p4'] };
  state = M.apply(state, command, exact);
  assert.deepEqual(state.farm.inventory, amounts(3, 3));
  assert.deepEqual(state.farm.lastHarvest.crops, amounts(3, 3));
  assert.deepEqual(state.farm.lastHarvest.plotIds, ['p1', 'p2']);
  assert.equal(state.farm.lastHarvest.batchIds.length, 2);
  assert.strictEqual(M.apply(state, command, exact), state);
  assert.equal(M.farmStatus(state, exact).plots[2].status, 'ready');
  assert.equal(M.farmStatus(state, exact).plots[3].status, 'growing');
  state = act(state, 'farm.harvest', {}, exact);
  assert.deepEqual(state.farm.inventory, amounts(3, 6));
  assert.throws(() => act(state, 'farm.harvest', {}, exact), /成熟/);
  state = act(state, 'farm.harvest', {}, new Date(+exact + 1000));
  assert.deepEqual(state.farm.inventory, amounts(6, 6));
  assert.deepEqual(M.normalize(state), state);
});

test('invalid plot selections and caller-supplied economics fail without partial effects', () => {
  const state = freeze(started());
  const before = JSON.stringify(state);
  for (const plotIds of [[], ['p1', 'p1'], ['p7'], ['constructor'], ['__proto__'], [null], 'p2', {}, ['p2', 'p7']]) {
    for (const type of ['farm.plant', 'farm.harvest']) {
      assert.throws(() => act(state, type, { ...(type === 'farm.plant' ? { cropId: 'carrot' } : {}), plotIds }));
    }
  }
  const commands = [
    ['farm.start', {}], ['farm.plant', { cropId: 'carrot' }], ['farm.harvest', {}],
    ['farm.exchange', { itemId: 'flowerpot' }], ['farm.place', { slot: 'fence', itemId: null }],
    ['farm.animalCare', { animalId: 'chicken', care: 'feed' }]
  ];
  for (const [type, values] of commands) {
    for (const field of ['points', 'inventory', 'yield', 'durationMs', 'cost', 'readyAt', 'plantedAt', 'farmMode', 'familyDay', 'day', 'now', 'threshold']) {
      assert.throws(() => act(state, type, { ...values, [field]: 0 }), /客户端字段/);
    }
  }
  assert.throws(() => act(state, 'farm.plant', { cropId: 'radish' }), /不存在/);
  assert.throws(() => act(state, 'farm.points.add', { points: 999 }), /不支持/);
  assert.equal(JSON.stringify(state), before);
});

test('every non-start farm action requires explicit initialization', () => {
  const state = freeze(atGrowth(500));
  for (const [type, values] of [
    ['farm.plant', { cropId: 'carrot' }], ['farm.harvest', {}], ['farm.exchange', { itemId: 'flowerpot' }],
    ['farm.place', { slot: 'path', itemId: null }], ['farm.animalCare', { animalId: 'chicken', care: 'pet' }]
  ]) { assert.throws(() => act(state, type, values), /先开启/); }
  assert.equal(state.farm, null);
});

test('inventory overflow rejects the entire harvest including the welcome claim', () => {
  const state = stocked(500, amounts(Number.MAX_SAFE_INTEGER));
  const before = JSON.stringify(state);
  assert.throws(() => act(freeze(state), 'farm.harvest'), /库存/);
  assert.equal(JSON.stringify(state), before);
  assert.equal(state.farm.welcomeGift.harvestedAt, null);
  assert.equal(state.farm.plots[0].cropId, 'carrot');
});

test('welcome crops can buy one flowerpot and ownership does not automatically place or re-buy it', () => {
  let state = act(started(0), 'farm.harvest');
  const before = financial(state);
  const item = M.farmStatus(state, NOW).catalog.find(row => row.id === 'flowerpot');
  assert.equal(item.canBuy, true);
  assert.deepEqual(item.cost, amounts(3));
  assert.deepEqual(item.missing, amounts());
  const command = { id: 'flower-once', type: 'farm.exchange', itemId: 'flowerpot' };
  state = M.apply(state, command, NOW);
  assert.deepEqual(state.farm.inventory, amounts());
  assert.deepEqual(state.farm.owned, ['fence', 'path', 'flowerpot']);
  assert.equal(state.farm.placements.entry, null);
  assert.strictEqual(M.apply(state, command, NOW), state);
  assert.throws(() => act(state, 'farm.exchange', { itemId: 'flowerpot' }), /已经拥有/);
  assert.deepEqual(financial(state), before);
});

test('exchange checks every crop, ownership and unlock before atomic material deductions', () => {
  const short = freeze(stocked(30, amounts(6, 2)));
  const before = JSON.stringify(short);
  const picnic = M.farmStatus(short, NOW).catalog.find(row => row.id === 'picnic');
  assert.equal(picnic.canBuy, false);
  assert.deepEqual(picnic.missing, amounts(0, 1));
  assert.throws(() => act(short, 'farm.exchange', { itemId: 'picnic' }), /草莓/);
  assert.equal(JSON.stringify(short), before);
  assert.throws(() => act(stocked(0), 'farm.exchange', { itemId: 'picnic' }), /成长/);
  assert.throws(() => act(stocked(100), 'farm.exchange', { itemId: 'windmill' }), /成长/);
  assert.throws(() => act(short, 'farm.exchange', { itemId: 'unknown' }), /不存在/);
  assert.throws(() => act(short, 'farm.exchange', { itemId: 'fence' }), /已经拥有/);
  const enough = freeze(stocked(30, amounts(6, 3)));
  const bought = act(enough, 'farm.exchange', { itemId: 'picnic' });
  assert.deepEqual(bought.farm.inventory, amounts());
  assert.ok(bought.farm.owned.includes('picnic'));
  assert.deepEqual(enough.farm.inventory, amounts(6, 3));
  assert.deepEqual(financial(bought), financial(enough));
});

test('house upgrades require the prior level and consume fixed materials without extra buildings', () => {
  let state = stocked();
  assert.throws(() => act(state, 'farm.exchange', { itemId: 'house3' }), /先建成2级/);
  state = act(state, 'farm.exchange', { itemId: 'house2' });
  assert.equal(state.farm.houseLevel, 2);
  assert.deepEqual(state.farm.inventory, amounts(88, 88, 100));
  state = act(state, 'farm.exchange', { itemId: 'house3' });
  assert.equal(state.farm.houseLevel, 3);
  assert.deepEqual(state.farm.inventory, amounts(64, 64, 76));
  assert.throws(() => act(state, 'farm.exchange', { itemId: 'house2' }), /已经拥有/);
  assert.throws(() => act(state, 'farm.exchange', { itemId: 'house3' }), /已经拥有/);
  assert.throws(() => act(state, 'farm.place', { slot: 'house', itemId: null }), /位置/);
  assert.deepEqual(financial(state), financial(stocked()));
});

test('decorations can be exchanged once and freely swapped or put away only in their own slot', () => {
  let state = stocked();
  for (const itemId of ['flowerpot', 'picnic', 'rabbitstatue', 'mailbox', 'trellis', 'windmill']) {
    state = act(state, 'farm.exchange', { itemId });
  }
  assert.equal(state.farm.owned.length, 8);
  assert.deepEqual(state.farm.inventory, amounts(58, 76, 79));
  const inventory = copy(state.farm.inventory);
  const owned = copy(state.farm.owned);
  for (const [slot, itemId] of [['entry', 'flowerpot'], ['entry', 'mailbox'], ['center', 'picnic'],
    ['center', 'rabbitstatue'], ['edge', 'trellis'], ['edge', 'windmill'], ['fence', null], ['path', null], ['path', 'path']]) {
    state = act(state, 'farm.place', { slot, itemId });
    assert.equal(state.farm.placements[slot], itemId);
  }
  state = act(state, 'farm.place', { slot: 'entry', itemId: null });
  assert.equal(state.farm.placements.entry, null);
  assert.deepEqual(state.farm.owned, owned);
  assert.deepEqual(state.farm.inventory, inventory);
  assert.throws(() => act(state, 'farm.place', { slot: 'entry', itemId: 'windmill' }), /位置不符/);
  assert.throws(() => act(started(), 'farm.place', { slot: 'entry', itemId: 'flowerpot' }), /尚未拥有/);
  assert.throws(() => act(state, 'farm.place', { slot: 'unknown', itemId: null }), /位置/);
});

test('each animal counts only its first daily interaction; cards and reactions persist without streaks', () => {
  let state = started(100);
  const initial = financial(state);
  for (let day = 0; day < 7; day++) {
    const now = new Date(2026, 10, 16 + day * 2, 12);
    state = act(state, 'farm.animalCare', { animalId: 'chicken', care: 'feed' }, now);
    state = act(state, 'farm.animalCare', { animalId: 'chicken', care: 'pet' }, now);
    state = act(state, 'farm.animalCare', { animalId: 'chicken', care: 'feed' }, now);
    if (day < 3) { state = act(state, 'farm.animalCare', { animalId: 'rabbit', care: 'pet' }, now); }
    const chicken = M.farmStatus(state, now).animals[0];
    assert.equal(chicken.careCount, day + 1);
    assert.equal(chicken.caredToday, true);
    assert.equal(chicken.cardUnlocked, day >= 2);
    assert.equal(chicken.actionUnlocked, day === 6);
  }
  const status = M.farmStatus(M.normalize(state), new Date(2027, 0, 1));
  assert.deepEqual(status.animals.map(animal => animal.careCount), [7, 3]);
  assert.deepEqual(status.animals.map(animal => animal.caredToday), [false, false]);
  assert.deepEqual(status.animals.map(animal => animal.cardUnlocked), [true, true]);
  assert.deepEqual(status.animals.map(animal => animal.actionUnlocked), [true, false]);
  assert.equal(state.farm.animalCare.length, 10);
  assert.deepEqual(state.farm.inventory, amounts());
  assert.deepEqual(financial(state), initial);
  assert.throws(() => act(started(0), 'farm.animalCare', { animalId: 'rabbit', care: 'feed' }), /尚未解锁/);
  assert.throws(() => act(state, 'farm.animalCare', { animalId: 'chicken', care: 'wash' }), /种类/);
});

test('animal projections use the supplied server family day even on a device with another date', () => {
  const late = new Date(2026, 10, 16, 23, 59, 59, 999);
  const midnight = new Date(2026, 10, 17, 0, 0, 0);
  let state = act(started(), 'farm.animalCare', { animalId: 'chicken', care: 'feed' }, late);
  assert.equal(M.farmStatus(state, new Date(2035, 0, 1), '2026-11-16').animals[0].caredToday, true);
  assert.equal(M.farmStatus(state, late, '2026-11-17').animals[0].caredToday, false);
  state = act(state, 'farm.animalCare', { animalId: 'chicken', care: 'pet' }, midnight);
  assert.deepEqual(state.farm.animalCare.map(row => row.day), ['2026-11-16', '2026-11-17']);
  state = act(state, 'farm.animalCare', { animalId: 'chicken', care: 'feed' }, late);
  assert.equal(state.farm.animalCare.length, 2, 'a repeated older day cannot count again');
});

test('farm mode preserves old care records and exploration including the original daily bonus', () => {
  let state = M.createSeed(NOW);
  for (const care of ['feed', 'wash']) { state = act(state, 'pet.care', { care, source: 'free' }); }
  state = act(state, 'pet.buy', { itemId: 'snack', quantity: 2, expectedPoints: 6 });
  const oldRows = copy(state.petCare);
  const oldPurchases = copy(state.petPurchases);
  const oldPet = M.petStatus(state, NOW);
  const balance = financial(state);
  state = act(state, 'farm.start');
  for (const care of ['train', 'feed', 'wash', 'train', 'feed', 'wash']) {
    state = act(state, 'pet.care', { care, source: 'free' });
  }
  assert.deepEqual(state.petCare.slice(0, oldRows.length), oldRows);
  assert.deepEqual(state.petPurchases, oldPurchases);
  assert.ok(state.petCare.slice(oldRows.length).every(row => row.farmMode === true));
  let status = M.petStatus(state, NOW);
  assert.equal(status.exploration, oldPet.exploration);
  assert.deepEqual(status.caredToday, ['feed', 'wash']);
  assert.equal(status.dailyBonusEarned, false, 'new train does not complete the archived three-kind bonus');
  assert.equal(status.freeUsed, 2);
  assert.equal(status.freeUnlimited, true);
  assert.equal(status.purchasesEnabled, false);
  assert.deepEqual(status.inventory, { snack: 2, dew: 0, ball: 0 });
  const command = { id: 'old-stock-once', type: 'pet.care', care: 'feed', source: 'inventory' };
  state = M.apply(state, command, NOW);
  assert.strictEqual(M.apply(state, command, NOW), state);
  assert.equal(M.petStatus(state, NOW).inventory.snack, 1);
  state = act(state, 'pet.care', { care: 'feed', source: 'inventory' });
  assert.equal(M.petStatus(state, NOW).inventory.snack, 0);
  assert.throws(() => act(state, 'pet.care', { care: 'feed', source: 'inventory' }), /库存/);
  assert.throws(() => act(state, 'pet.buy', { itemId: 'snack', quantity: 1, expectedPoints: 3 }), /停止购买/);
  assert.throws(() => act(state, 'pet.care', { care: 'feed', source: 'free', farmMode: false }), /客户端字段/);
  status = M.petStatus(M.normalize(state), NOW);
  assert.equal(status.exploration, oldPet.exploration);
  assert.deepEqual(status.unlockedScenes, oldPet.unlockedScenes);
  assert.equal(status.sceneId, oldPet.sceneId);
  assert.deepEqual(financial(state), balance);
  assert.deepEqual(state.farm.inventory, amounts());
});

test('already-earned exploration badges, paid stock and free quota stay unchanged until start', () => {
  let state = M.createSeed(NOW);
  for (const care of ['feed', 'wash', 'train']) { state = act(state, 'pet.care', { care, source: 'free' }); }
  const oldStatus = M.petStatus(state, NOW);
  assert.equal(oldStatus.exploration, 4);
  assert.equal(oldStatus.dailyBonusEarned, true);
  assert.throws(() => act(state, 'pet.care', { care: 'feed', source: 'free' }), /免费/);
  assert.equal(M.petStatus(state, NOW).purchasesEnabled, true);
  const records = copy(state.petCare);
  state = act(state, 'farm.start');
  state = act(state, 'pet.care', { care: 'feed', source: 'free' });
  assert.deepEqual(state.petCare.slice(0, 3), records);
  const status = M.petStatus(state, NOW);
  for (const key of ['exploration', 'sceneId', 'dailyBonusEarned', 'freeUsed', 'freeRemaining']) { assert.equal(status[key], oldStatus[key]); }
  assert.deepEqual(status.unlockedScenes, ['home', 'forest']);
});

test('farm projections do not leak mutable crop, inventory, cost, ownership or placement references', () => {
  const state = freeze(stocked());
  const original = JSON.stringify(state);
  const expected = M.farmStatus(state, NOW);
  const projection = M.farmStatus(state, NOW);
  projection.crops[0].durationMs = 0;
  projection.catalog[2].cost.carrot = 0;
  projection.catalog[2].missing.carrot = 999;
  projection.inventory.carrot = 0;
  projection.owned.push('windmill');
  projection.placements.entry = 'mailbox';
  projection.plots[0].cropId = 'sunflower';
  projection.animals[0].careCount = 999;
  projection.welcomeGift.harvestedAt = NOW.toISOString();
  assert.deepEqual(M.farmStatus(state, NOW), expected);
  assert.equal(JSON.stringify(state), original);
});

test('malformed persisted farms fail closed instead of repairing rewards or erasing old history', () => {
  const initial = act(started(), 'farm.animalCare', { animalId: 'chicken', care: 'feed' });
  const changes = [
    state => { state.farm = {}; },
    state => { state.farm.initialized = false; },
    state => { state.farm.plots.pop(); },
    state => { state.farm.plots[1].id = 'p1'; },
    state => { state.farm.inventory.carrot = -1; },
    state => { state.farm.inventory.strawberry = 1.5; },
    state => { state.farm.inventory = { carrot: 0, strawberry: 0 }; },
    state => { state.farm.welcomeGift.harvestedAt = NOW.toISOString(); },
    state => { state.farm.plots[0].plantedAt = new Date(+NOW - EIGHT_HOURS).toISOString(); },
    state => { state.farm.owned.push('fence'); },
    state => { state.farm.owned.push('unknown'); },
    state => { state.farm.houseLevel = 3; },
    state => { state.farm.placements.entry = 'flowerpot'; },
    state => { state.farm.placements.path = 'fence'; },
    state => { state.farm.placements.house = null; },
    state => { state.farm.animalCare.push({ ...state.farm.animalCare[0], id: 'duplicate-day' }); },
    state => { state.farm.animalCare[0].animalId = 'cow'; },
    state => { state.farm.animalCare[0].day = '2026-02-30'; },
    state => { state.farm.animalCare[0].care = 'wash'; }
  ];
  for (const change of changes) {
    const malformed = copy(initial);
    change(malformed);
    const before = JSON.stringify(malformed);
    assert.throws(() => M.normalize(freeze(malformed)));
    assert.equal(JSON.stringify(malformed), before);
  }
  const planted = act(initial, 'farm.plant', { cropId: 'carrot', plotIds: ['p2'] });
  planted.farm.plots[1].readyAt = NOW.toISOString();
  assert.throws(() => M.normalize(planted), /成熟时间/);
});
