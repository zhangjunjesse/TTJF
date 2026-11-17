'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const M = require('../model.js');
const ROOT = path.resolve(__dirname, '..');
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const FARM_SOURCE = fs.readFileSync(path.join(ROOT, 'farm-ui.js'), 'utf8');
const START = new Date(2026, 10, 16, 8);
const DAY = 24 * 60 * 60 * 1000;
const EIGHT_HOURS = 8 * 60 * 60 * 1000;
const copy = value => JSON.parse(JSON.stringify(value));
const amounts = (carrot = 0, strawberry = 0, sunflower = 0) => ({ carrot, strawberry, sunflower });
function frozen(value) {
  Object.values(value).forEach(item => { if (item && typeof item === 'object') frozen(item); });
  return Object.freeze(value);
}
function startFarm(now = START) {
  return M.apply(M.createSeed(now), { id: 'ui-fixture-start', type: 'farm.start' }, now);
}
function snapshot(at, revision = 10, state = M.createSeed(START)) {
  return { revision, state: copy(state), serverNow: new Date(at).toISOString(), familyDay: M.dateKey(new Date(at)),
    parent: { configured: true, method: 'pin' } };
}

function appClock() {
  // Compile the complete source first. A partial-function extraction must never hide
  // a syntax error in the app. The hook only stops bootstrap before network/render.
  new vm.Script(APP_SOURCE, { filename: 'app.js' });
  const marker = "  if (!M) { document.getElementById('app').innerHTML";
  const index = APP_SOURCE.indexOf(marker);
  assert.ok(index > 0, 'the app bootstrap marker must exist');
  assert.equal(APP_SOURCE.indexOf(marker, index + marker.length), -1, 'the bootstrap marker must be unique');
  const hook = `
    window.__farmClockTest = {
      accept: setSnapshot,
      now: farmClock,
      read: function () { return { state: clone(state), revision: revision, familyDay: familyDay,
        serverTime: serverTime, serverReceived: serverReceived, connected: connected,
        parent: clone(meta.parent) }; }
    };
    return;
`;
  let elapsed = 0;
  let wallTime = +START;
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [wallTime])); }
    static now() { return wallTime; }
  }
  const storage = new Map();
  const fakeWindow = { FamilyModel: M, performance: { now: () => elapsed }, addEventListener() {} };
  const sandbox = {
    window: fakeWindow,
    document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; } },
    location: { protocol: 'http:' },
    localStorage: { getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)) },
    Date: TestDate,
    // A clock acceptance test must never escape into requests, real timers, or DOM rendering.
    XMLHttpRequest: function () { throw new Error('unexpected network request in clock test'); },
    setTimeout() { throw new Error('unexpected real timer in clock test'); },
    setInterval() { throw new Error('unexpected polling startup in clock test'); }
  };
  vm.runInNewContext(APP_SOURCE.slice(0, index) + hook + APP_SOURCE.slice(index), sandbox, { filename: 'app-clock-vm.js' });
  return {
    accept: fakeWindow.__farmClockTest.accept,
    now: () => fakeWindow.__farmClockTest.now().getTime(),
    read: () => copy(fakeWindow.__farmClockTest.read()),
    stored: () => JSON.parse(storage.get('little-steps-demo-v1')),
    advance: milliseconds => { elapsed += milliseconds; },
    wall: timestamp => { wallTime = +new Date(timestamp); }
  };
}

function farmUI(state, now = START, formData = { view: 'care' }) {
  let renders = 0;
  let html = '';
  const toasts = [];
  const c = { state, now: new Date(now), familyDay: M.dateKey(now), local: true, connected: false,
    pending: false, retry: null, auth: null, view: 'points', form: { kind: 'farm', data: copy(formData) },
    pet: state.pet, growth: M.growth(state), reducedMotion: true };
  const fakeWindow = { FamilyModel: M, addEventListener() {} };
  const fakeDocument = { addEventListener() {}, querySelectorAll() { return []; } };
  vm.runInNewContext(FARM_SOURCE, { window: fakeWindow, document: fakeDocument }, { filename: 'farm-ui.js' });
  const farm = fakeWindow.FamilyFarmUI;
  function paint() {
    renders++;
    // The real app paints the home behind its panel. Both paths are production
    // markup functions; this adapter only omits the browser and WebGL surfaces.
    farm.home();
    html = farm.panel(c.form);
  }
  farm.setup({ context: () => c, render: paint, icon: () => '',
    sheet: (title, subtitle, body) => body, toast: text => toasts.push(text) });
  return { farm, context: c, paint, renders: () => renders, html: () => html, toasts };
}

function harvestRace() {
  let state = startFarm();
  state = M.apply(state, { id: 'ui-plant-strawberry', type: 'farm.plant', cropId: 'strawberry', plotIds: ['p2'] }, START);
  const now = new Date(+START + EIGHT_HOURS);
  const first = { id: 'device-a-harvest', type: 'farm.harvest', plotIds: ['p1'] };
  const second = { id: 'device-b-harvest', type: 'farm.harvest', plotIds: ['p2'] };
  const afterFirst = M.apply(state, first, now);
  const afterSecond = M.apply(afterFirst, second, new Date(+now + 1));
  return { now, first, second, afterFirst, afterSecond };
}

test('complete application and farm UI sources compile before installing VM hooks', () => {
  assert.doesNotThrow(() => new vm.Script(APP_SOURCE, { filename: 'app.js' }));
  assert.doesNotThrow(() => new vm.Script(FARM_SOURCE, { filename: 'farm-ui.js' }));
});

test('same-revision older and identical clock samples cannot rewind time or re-anchor elapsed time', () => {
  const clock = appClock();
  const current = snapshot(new Date(2026, 10, 17, 0, 0, 3));
  assert.equal(clock.accept(current), true);
  clock.advance(2500);
  const originalAnchor = clock.read().serverReceived;
  const delayed = snapshot(new Date(2026, 10, 16, 23, 59, 59));
  assert.equal(clock.accept(delayed), true, 'the data revision remains acceptable');
  assert.equal(clock.now(), Date.parse(current.serverNow) + 2500);
  assert.equal(clock.read().familyDay, '2026-11-17');
  assert.equal(clock.read().serverReceived, originalAnchor);
  clock.advance(1500);
  assert.equal(clock.accept(copy(current)), true);
  assert.equal(clock.now(), Date.parse(current.serverNow) + 4000, 'equal samples must not reset the elapsed offset');
  assert.equal(clock.read().serverReceived, originalAnchor);
  assert.equal(clock.read().familyDay, '2026-11-17');
  assert.equal(clock.read().connected, true);
});

test('lower-revision snapshots cannot replace state, parent settings, clock, or family day', () => {
  const clock = appClock();
  const accepted = snapshot(START);
  clock.accept(accepted);
  clock.advance(1000);
  const old = snapshot(new Date(+START + DAY), 9);
  old.state.childName = '旧响应中的姓名';
  old.parent = { configured: false, method: null };
  assert.equal(clock.accept(old), false);
  assert.equal(clock.now(), +START + 1000);
  assert.equal(clock.read().familyDay, '2026-11-16');
  assert.deepEqual(clock.read().state, accepted.state);
  assert.deepEqual(clock.stored(), accepted.state);
  assert.deepEqual(clock.read().parent, { configured: true, method: 'pin' });
});

test('a strictly newer same-revision clock sample advances the family day without a domain write', () => {
  const clock = appClock();
  const previousDay = snapshot(new Date(2026, 10, 16, 23, 59, 59));
  const nextDay = snapshot(new Date(2026, 10, 17, 0, 0, 2));
  clock.accept(previousDay);
  clock.advance(3000);
  assert.equal(clock.accept(nextDay), true);
  assert.equal(clock.read().familyDay, '2026-11-17');
  assert.equal(clock.now(), Date.parse(nextDay.serverNow));
  clock.advance(750);
  assert.equal(clock.now(), Date.parse(nextDay.serverNow) + 750);
  assert.equal(clock.read().revision, 10);
  assert.deepEqual(clock.read().state, previousDay.state);
  assert.deepEqual(clock.stored(), previousDay.state);
});

test('a higher revision retains authority to replace state and the server clock sample', () => {
  const clock = appClock();
  clock.accept(snapshot(new Date(2026, 10, 17, 12)));
  clock.advance(5000);
  const newer = snapshot(new Date(2026, 10, 16, 23), 11);
  newer.state.childName = '新版本昵称';
  assert.equal(clock.accept(newer), true);
  assert.equal(clock.read().revision, 11);
  assert.equal(clock.read().state.childName, '新版本昵称');
  assert.equal(clock.read().familyDay, '2026-11-16');
  assert.equal(clock.now(), Date.parse(newer.serverNow));
  clock.advance(1000);
  assert.equal(clock.now(), Date.parse(newer.serverNow) + 1000);
});

test('shared farm time follows performance elapsed time rather than changes to the device wall clock', () => {
  const clock = appClock();
  clock.accept(snapshot(START));
  clock.wall(new Date(2035, 0, 1));
  clock.advance(1200);
  assert.equal(clock.now(), +START + 1200);
  clock.wall(new Date(2000, 0, 1));
  clock.advance(1800);
  assert.equal(clock.now(), +START + 3000);
  assert.equal(clock.read().familyDay, '2026-11-16');
});

test('local care and animal panels refresh at midnight even without a growing crop', () => {
  const beforeMidnight = new Date(2026, 10, 16, 23, 59, 59);
  let state = startFarm(beforeMidnight);
  state = M.apply(state, { id: 'care-before-midnight', type: 'farm.animalCare', animalId: 'chicken', care: 'feed' }, beforeMidnight);
  const original = JSON.stringify(state);
  frozen(state);
  for (const formData of [{ view: 'care' }, { view: 'animal', animalId: 'chicken' }]) {
    const ui = farmUI(state, beforeMidnight, formData);
    ui.paint();
    assert.equal(ui.farm.status().animals[0].caredToday, true);
    assert.equal(ui.farm.status().plots.some(plot => plot.status === 'growing'), false);
    const previousHTML = ui.html();
    ui.context.now = new Date(2026, 10, 17, 0, 0, 1);
    ui.context.familyDay = '2026-11-17';
    ui.farm.tick();
    assert.equal(ui.renders(), 2, formData.view + ' must repaint at midnight');
    assert.notEqual(ui.html(), previousHTML);
    assert.equal(ui.farm.status().animals[0].caredToday, false);
    assert.equal(ui.farm.status().animals[0].careCount, 1);
    ui.farm.tick();
    assert.equal(ui.renders(), 2, 'unchanged ticks must not keep repainting');
    assert.equal(JSON.stringify(state), original, 'crossing a day is display-only');
  }
});

test('a same-day animal care snapshot refreshes the panel without a crop or clock change', () => {
  const initial = startFarm();
  const ui = farmUI(initial);
  ui.paint();
  assert.equal(ui.farm.status().animals[0].caredToday, false);
  assert.match(ui.html(), /今天还没照料/);
  ui.context.state = M.apply(initial, { id: 'another-device-care', type: 'farm.animalCare', animalId: 'chicken', care: 'pet' }, START);
  ui.farm.tick();
  assert.equal(ui.renders(), 2);
  assert.equal(ui.farm.status().animals[0].caredToday, true);
  assert.equal(ui.farm.status().animals[0].careCount, 1);
  assert.match(ui.html(), /今天已照料/);
  ui.farm.tick();
  assert.equal(ui.renders(), 2);
});

test('a matching harvest receipt reports its own exact crop yield', () => {
  const race = harvestRace();
  const ui = farmUI(frozen(race.afterFirst), race.now);
  const before = JSON.stringify(ui.context.state);
  ui.farm.complete(race.first);
  assert.deepEqual(ui.toasts, ['萝卜 +3']);
  assert.deepEqual(race.afterFirst.farm.lastHarvest.crops, amounts(3));
  assert.equal(JSON.stringify(ui.context.state), before);
});

test('reconciling a lost harvest response never reports another device\'s later crop receipt', () => {
  const race = harvestRace();
  assert.ok(race.afterSecond.appliedActions.includes(race.first.id), 'a polling snapshot can confirm the lost first response');
  assert.equal(race.afterSecond.farm.lastHarvest.id, race.second.id);
  assert.deepEqual(race.afterFirst.farm.lastHarvest.crops, amounts(3));
  assert.deepEqual(race.afterSecond.farm.lastHarvest.crops, amounts(0, 3));
  const ui = farmUI(frozen(race.afterSecond), race.now);
  const before = JSON.stringify(ui.context.state);
  ui.farm.complete(race.first);
  assert.deepEqual(ui.toasts, ['收获结果已同步到背包']);
  assert.doesNotMatch(ui.toasts[0], /草莓|\+3/);
  assert.deepEqual(ui.farm.status().inventory, amounts(3, 3));
  assert.equal(JSON.stringify(ui.context.state), before);
  ui.farm.complete(race.second);
  assert.equal(ui.toasts[1], '草莓 +3', 'the later action still receives its own matching details');
});

test('farm display projections and panel navigation never alter stored domain state', () => {
  const state = frozen(startFarm());
  const original = JSON.stringify(state);
  const ui = farmUI(state);
  ui.farm.home();
  for (const data of [{ view: 'yard' }, { view: 'seed' }, { view: 'plot', plotId: 'p1' }, { view: 'care' },
    { view: 'animal', animalId: 'chicken' }, { view: 'build' }, { view: 'item', itemId: 'windmill' }, { view: 'collection' }]) {
    const html = ui.farm.panel({ kind: 'farm', data });
    assert.equal(typeof html, 'string');
    assert.ok(html.length > 0);
  }
  assert.equal(JSON.stringify(state), original);
});
