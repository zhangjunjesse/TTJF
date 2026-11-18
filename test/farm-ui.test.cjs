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

function farmSceneUI() {
  const state = startFarm(), scenes = [], attached = new Set();
  let creditImage = null;
  const context = { ready: true, state, now: START, familyDay: M.dateKey(START), local: true, connected: true,
    view: 'points', form: { kind: 'farm', data: { view: 'care' } }, pet: state.pet, growth: M.growth(state), reducedMotion: true, earnedPoints: 25, availablePoints: 0 };
  const initialView = () => ({ x: 0, z: 0, zoom: 1, focus: null });
  const target = { firstChild: null, closest: () => true,
    getAttribute: name => name === 'data-farm-scene' ? context.form ? 'expanded' : 'home' : null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000, bottom: 800 }),
    insertBefore(surface) { attached.add(surface); surface.parentNode = target; },
    removeChild(surface) { attached.delete(surface); surface.parentNode = null; } };
  const document = { hidden: false, addEventListener() {}, createElement: () => ({}), querySelector: selector => selector === '[data-credit-scene]' ? creditImage : null,
    querySelectorAll: selector => selector === '[data-farm-scene]' ? [target] : [] };
  const window = { FamilyModel: M, addEventListener() {}, FamilyFarmScene: { mount(surface, options) {
    let view = initialView();
    const scene = { options, disposed: false, paused: false, reactions: [],
      update(next) { this.options = next; }, pause(value) { this.paused = value; }, resize() {},
      react(kind, target) { this.reactions.push({ kind, target }); },
      dispose() { this.disposed = true; },
      camera(action = {}) { if (action.restore) view = copy(action.restore); return { navigation: copy(view) }; },
      focus(value) { view.focus = copy(value); },
      diagnostics() { return { lighting: this.options.lighting, camera: { navigation: copy(view) } }; },
      ready() { this.options.onStatus({ ready: true }); },
      userView(value) { view = copy(value); }
    };
    scenes.push(scene); return scene;
  } } };
  vm.runInNewContext(FARM_SOURCE, { window, document }, { filename: 'farm-scene-ui.js' });
  const farm = window.FamilyFarmUI;
  farm.setup({ context: () => context, render: () => farm.afterRender(), icon: () => '' });
  return { farm, context, scenes, attached, initialView, replaceCreditImage() {
    creditImage = { src: '', attributes: {}, setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; if (name === 'src') this.src = ''; } };
    return creditImage;
  } };
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

test('home previews project a separate 3D stage without changing actual growth or family state', () => {
  const ui = farmSceneUI(); ui.context.form = null;
  const before = copy(ui.context.state), realGrowth = copy(ui.context.growth);
  const home = ui.farm.home(); ui.farm.afterRender();
  assert.match(home, /免费陪伴互动/);
  assert.doesNotMatch(home, /data-action="farm-pet-(?:rotate|reset)"|pet-rotation-tools|pet-drag-hint/);
  assert.doesNotMatch(home, /data-action="farm-(?:harvest|seeds|start)"/);
  assert.doesNotMatch(home, /每获得 1 积分，增加 1 成长值|兑换不影响成长/,
    'the single-screen home keeps growth explanations in the gallery');
  assert.match(home, /role="progressbar" aria-label="本阶段成长进度"/);
  assert.match(home, new RegExp('aria-valuemin="' + realGrowth.previousAt + '" aria-valuemax="' + realGrowth.nextAt + '" aria-valuenow="' + realGrowth.xp + '"'));
  assert.match(home, /id="home-feedback"[^>]*role="status"[^>]*aria-live="polite"/,
    'home feedback remains available after removing the permanent footer');
  ui.farm.handle('farm-pet-preview');
  for (let stage = 1; stage <= 5; stage++) {
    ui.farm.handle('farm-pet-stage', String(stage));
    assert.equal(ui.farm.diagnostics().previewStage, stage);
    assert.equal(ui.scenes[0].options.growth.stage, stage);
    assert.equal(ui.scenes[0].options.companionView.preview, true);
    for (const variant of ['default', 'festival']) {
      ui.farm.handle('farm-pet-look', variant);
      assert.equal(ui.scenes[0].options.growth.stage, stage, 'look changes retain the selected stage');
      assert.equal(ui.scenes[0].options.companionView.variant, variant);
      const markup = ui.farm.home();
      assert.match(markup, /每获得 1 积分，增加 1 成长值/);
      assert.match(markup, /兑换不影响成长/);
      assert.match(markup, /data-action="farm-pet-look" data-id="default"/);
      assert.match(markup, /data-action="farm-pet-look" data-id="festival"/);
      assert.deepEqual(ui.context.growth, realGrowth);
      assert.deepEqual(ui.context.state, before);
    }
    assert.deepEqual(ui.context.growth, realGrowth);
    assert.deepEqual(ui.context.state, before);
  }
  assert.match(ui.farm.home(), /成长图鉴/);
  ui.farm.handle('farm-pet-current');
  assert.equal(ui.farm.diagnostics().previewStage, null);
  assert.equal(ui.scenes[0].options.growth.stage, realGrowth.stage);
  assert.equal(ui.scenes[0].options.companionView.preview, false);
  assert.equal(ui.scenes[0].options.companionView.variant, 'default');
  assert.doesNotMatch(ui.farm.home(), /data-action="farm-pet-look"/);
  ui.farm.handle('farm-pet-preview');
  assert.equal(ui.scenes[0].options.companionView.variant, 'default', 'reopening begins from the ordinary look');
});

test('preview is cleared on real growth changes, station release, and family disposal', () => {
  const ui = farmSceneUI(); ui.context.form = null; ui.farm.home(); ui.farm.afterRender();
  ui.farm.handle('farm-pet-preview'); ui.farm.handle('farm-pet-stage', '5'); ui.farm.handle('farm-pet-look', 'festival');
  ui.context.growth = { ...ui.context.growth, xp: ui.context.growth.xp + 1 };
  ui.farm.home(); ui.farm.afterRender();
  assert.equal(ui.farm.diagnostics().previewStage, null);
  assert.equal(ui.scenes[0].options.companionView.variant, 'default');
  ui.farm.handle('farm-pet-preview'); ui.farm.handle('farm-pet-stage', '5'); ui.farm.handle('farm-pet-look', 'festival'); ui.farm.releaseScene();
  assert.equal(ui.farm.diagnostics().previewStage, null);
  ui.farm.afterRender();
  assert.equal(ui.scenes.at(-1).options.companionView.variant, 'default');
  ui.farm.handle('farm-pet-preview'); ui.farm.handle('farm-pet-stage', '4'); ui.farm.handle('farm-pet-look', 'festival'); ui.farm.dispose();
  assert.equal(ui.farm.diagnostics().previewStage, null);
  assert.equal(ui.farm.diagnostics().renderer, null);
});

test('gallery looks are unavailable to another species, an inactive preview, or a protected panel', () => {
  const ui = farmSceneUI(); ui.context.form = null; ui.farm.home(); ui.farm.afterRender();
  const before = copy(ui.context.state);
  ui.farm.handle('farm-pet-look', 'festival');
  ui.farm.handle('farm-pet-stage', '5');
  assert.equal(ui.farm.diagnostics().previewStage, null, 'a look action cannot start its own gallery');
  assert.equal(ui.scenes[0].options.companionView.variant, 'default');
  ui.farm.handle('farm-pet-preview');
  ui.farm.handle('farm-pet-look', 'unsupported');
  assert.equal(ui.scenes[0].options.companionView.variant, 'default');
  ui.farm.handle('farm-pet-current');
  ui.context.pet = { kind: 'capybara', name: '水豚' };
  ui.farm.home(); ui.farm.afterRender(); ui.farm.handle('farm-pet-preview'); ui.farm.handle('farm-pet-look', 'festival');
  assert.doesNotMatch(ui.farm.home(), /data-action="farm-pet-look"/);
  assert.equal(ui.scenes[0].options.companionView.variant, 'default');
  ui.farm.handle('farm-pet-current'); ui.context.pet = before.pet;
  ui.farm.home(); ui.farm.afterRender();
  for (const blocked of [{ form: { kind: 'farm', data: {} } }, { auth: {} }, { view: 'rewards' }]) {
    Object.assign(ui.context, { form: null, auth: null, view: 'points' }, blocked);
    ui.farm.handle('farm-pet-preview'); ui.farm.handle('farm-pet-look', 'festival');
    assert.equal(ui.farm.diagnostics().previewStage, null);
  }
  assert.deepEqual(ui.context.state, before);
});

test('credit frames follow the current DOM image, clear at release, and ignore a stale family scene callback', () => {
  const ui = farmSceneUI(); ui.context.form = null;
  const firstImage = ui.replaceCreditImage(); ui.farm.afterRender();
  const scene = ui.scenes[0], oldCallback = scene.options.onCreditFrame;
  assert.equal(scene.options.credit.enabled, true); assert.equal(scene.options.credit.balance, 25);
  oldCallback('data:image/png;base64,first'); assert.equal(firstImage.src, 'data:image/png;base64,first');
  const secondImage = ui.replaceCreditImage(); ui.farm.afterRender();
  scene.options.onCreditFrame('data:image/png;base64,current');
  assert.equal(secondImage.src, 'data:image/png;base64,current');
  assert.equal(firstImage.src, 'data:image/png;base64,first');
  ui.farm.complete({ type: 'points.add' });
  assert.deepEqual(scene.reactions, [{ kind: 'earn', target: 'pet' }]);
  ui.farm.releaseScene(); assert.equal(secondImage.src, '');
  oldCallback('data:image/png;base64,late'); assert.equal(secondImage.src, '');
  ui.farm.afterRender(); const currentScene = ui.scenes[1];
  currentScene.options.onCreditFrame('data:image/png;base64,new'); assert.equal(secondImage.src, 'data:image/png;base64,new');
  ui.context.ready = false;
  currentScene.options.onCreditFrame('data:image/png;base64,blocked'); assert.equal(secondImage.src, 'data:image/png;base64,new');
  ui.farm.complete({ type: 'points.add' }); assert.equal(currentScene.reactions.length, 0);
  ui.farm.dispose(); assert.equal(secondImage.src, '');
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

test('a business station releases the farm renderer while preserving night and the exact navigation on return', () => {
  const ui = farmSceneUI(), original = JSON.stringify(ui.context.state);
  ui.farm.afterRender(); const first = ui.scenes[0]; first.ready();
  ui.farm.handle('farm-lighting');
  const chosen = { x: 4.25, z: -3.75, zoom: 1.8, focus: { type: 'plot', id: 'p2' } };
  first.userView(chosen);
  const staleStatus = first.options.onStatus;
  ui.context.form = { kind: 'points', data: {} }; ui.farm.releaseScene(); ui.farm.afterRender();
  assert.equal(first.disposed, true); assert.equal(ui.attached.size, 0);
  assert.equal(ui.farm.diagnostics().renderer, null);
  ui.context.form = { kind: 'farm', data: { view: 'care' } }; ui.farm.afterRender();
  const returned = ui.scenes[1]; returned.ready();
  assert.equal(ui.attached.size, 1);
  assert.equal(ui.farm.diagnostics().renderer.lighting, 'night');
  assert.deepEqual(copy(ui.farm.diagnostics().renderer.camera.navigation), chosen,
    'restoring the same panel must not replace a user view with its default focus');
  staleStatus({ error: 'late released renderer failure' });
  assert.equal(ui.farm.diagnostics().sceneState, 'ready');
  assert.equal(JSON.stringify(ui.context.state), original, 'view choices never modify family state');
});

test('releasing a replacement before models are ready retains the pending navigation snapshot', () => {
  const ui = farmSceneUI(); ui.farm.afterRender(); ui.scenes[0].ready();
  const chosen = { x: -2.5, z: 6.5, zoom: 1.4, focus: { type: 'pet', id: 'pet' } };
  ui.scenes[0].userView(chosen); ui.farm.releaseScene();
  ui.farm.afterRender(); const loading = ui.scenes[1];
  ui.farm.releaseScene(); assert.equal(loading.disposed, true);
  ui.farm.afterRender(); ui.scenes[2].ready();
  assert.deepEqual(copy(ui.farm.diagnostics().renderer.camera.navigation), chosen);
  assert.equal(ui.attached.size, 1);
});

test('leaving first-load details before models are ready retains the requested detail focus on return', () => {
  for (const [data, expected] of [
    [{ view: 'care' }, { type: 'pet', id: 'pet' }],
    [{ view: 'animal', animalId: 'chicken' }, { type: 'animal', id: 'chicken' }],
    [{ view: 'plot', plotId: 'p2' }, { type: 'plot', id: 'p2' }]
  ]) {
    const ui = farmSceneUI(); ui.context.form.data = data;
    ui.farm.afterRender(); const firstLoad = ui.scenes[0];
    ui.context.form = { kind: 'points', data: {} }; ui.farm.releaseScene(); ui.farm.afterRender();
    assert.equal(firstLoad.disposed, true);
    ui.context.form = { kind: 'farm', data }; ui.farm.afterRender(); ui.scenes[1].ready();
    assert.deepEqual(copy(ui.farm.diagnostics().renderer.camera.navigation.focus), expected, data.view);
    assert.equal(ui.attached.size, 1);
  }
});

test('a pending new detail focus takes precedence over an older navigation snapshot after repeated loading releases', () => {
  const ui = farmSceneUI(); ui.farm.afterRender(); ui.scenes[0].ready();
  ui.scenes[0].userView({ x: -2, z: 4, zoom: 1.7, focus: { type: 'pet', id: 'pet' } });
  ui.farm.releaseScene();
  ui.context.form = { kind: 'farm', data: { view: 'plot', plotId: 'p3' } }; ui.farm.afterRender();
  ui.farm.releaseScene(); ui.farm.afterRender(); ui.scenes[2].ready();
  const view = copy(ui.farm.diagnostics().renderer.camera.navigation);
  assert.deepEqual(view.focus, { type: 'plot', id: 'p3' });
  assert.equal(view.zoom, 1.7, 'the new detail focus does not discard the prior zoom');
  assert.equal(ui.attached.size, 1);
});

test('context loss after a ready scene does not discard the last user navigation when leaving', () => {
  const ui = farmSceneUI(); ui.farm.afterRender(); const first = ui.scenes[0]; first.ready();
  const chosen = { x: 1.5, z: -6.25, zoom: 1.6, focus: { type: 'animal', id: 'chicken' } };
  first.userView(chosen); first.options.onStatus({ error: 'FARM_CONTEXT_LOST', webgl: false });
  ui.farm.releaseScene(); ui.farm.afterRender(); ui.scenes[1].ready();
  assert.deepEqual(copy(ui.farm.diagnostics().renderer.camera.navigation), chosen);
});

test('a family boundary clears both a released navigation snapshot and its night preference', () => {
  const ui = farmSceneUI(); ui.farm.afterRender(); ui.scenes[0].ready();
  ui.farm.handle('farm-lighting');
  ui.scenes[0].userView({ x: 8, z: -4, zoom: 2, focus: { type: 'plot', id: 'p3' } });
  ui.farm.releaseScene(); ui.farm.dispose();
  ui.context.form = null; ui.farm.afterRender(); ui.scenes[1].ready();
  const next = ui.farm.diagnostics().renderer;
  assert.equal(next.lighting, 'day');
  assert.deepEqual(copy(next.camera.navigation), ui.initialView());
});
