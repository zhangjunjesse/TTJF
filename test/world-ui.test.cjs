'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'world-ui.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));

function emitter(target = {}) {
  const listeners = new Map();
  target.addEventListener = (name, callback) => {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(callback);
  };
  target.emit = name => { for (const callback of listeners.get(name) || []) callback(); };
  return target;
}
function node() {
  return { hidden: false, textContent: '', attributes: {}, tabIndex: 0,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] || null; } };
}
function fixture(options = {}) {
  const app = node(), body = node(), focus = node(), nodes = {}, controllers = [], frames = new Map();
  let frameId = 0, panel = options.panel || null, stage;
  const document = emitter({ body, hidden: false, activeElement: focus,
    getElementById: id => id === 'app' ? app : id === 'world-stage' ? stage || null : null,
    querySelector: selector => ['.sheet', '.saas-card', '.reminders-screen'].includes(selector) ? panel : null,
    createElement() {
      stage = node();
      for (const selector of ['.world-stage-surface', '.world-scene-fallback', '.world-eyebrow', 'h2', '.world-caption p']) nodes[selector] = node();
      nodes['.world-stage-surface'].querySelector = selector => selector === 'canvas' ? nodes.canvas || null : null;
      stage.querySelector = selector => nodes[selector] || null;
      return stage;
    } });
  body.insertBefore = (element, before) => { assert.equal(before, app); element.parentNode = body; body.children = [element, app]; };
  const media = emitter({ matches: !!options.reducedMotion });
  const window = emitter({ innerWidth: 1440, innerHeight: 1000, visualViewport: emitter(),
    matchMedia(query) { assert.equal(query, '(prefers-reduced-motion: reduce)'); return media; },
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
    FamilyFarmScene: { mount(surface, initial) {
      if (options.mountThrows) throw new Error('synthetic WebGL unavailable');
      const controller = { options: initial, paused: false, disposed: false, sizes: 0,
        update(next) { this.options = next; }, pause(value) { this.paused = !!value; },
        resize() { this.sizes++; }, dispose() { this.disposed = true; nodes.canvas = null; },
        diagnostics() { return { presentation: this.options.presentation, paused: this.paused, disposed: this.disposed }; } };
      nodes.canvas = node(); controllers.push(controller); return controller;
    } }
  });
  if (options.sceneMissing) delete window.FamilyFarmScene;
  vm.runInNewContext(SOURCE, { window, document }, { filename: 'world-ui.js' });
  function flush() { const batch = [...frames.values()]; frames.clear(); batch.forEach(callback => callback()); }
  return { window, document, body, media, focus, nodes, controllers, frames, flush,
    api: window.FamilyWorldUI, stage: () => stage, panel(value) { panel = value; } };
}
function business(kind, extra = {}) {
  return { view: 'points', kind, auth: false,
    farm: { initialized: true, plots: [{ id: 'private-plot' }], animals: [] },
    pet: { kind: 'capybara', name: 'Private family pet' }, growth: { stage: 4, xp: 935 }, ...extra };
}

test('world host maps every supported business and account state to its required presentation', () => {
  const f = fixture();
  const forms = {
    points: ['behaviorPicker', 'points', 'point-list', 'pointItem'],
    reminders: ['homeInbox', 'task', 'taskAction'], rewards: ['rewards', 'reward-list', 'reward', 'request', 'approve'],
    history: ['records', 'petGrowth'], companion: ['petHub', 'petBuy', 'petConfig'],
    settings: ['preferences', 'unknown-form'], family: ['profile', 'familySettings'],
    voice: ['voice'], authorization: ['parentConfig'], farm: ['farm']
  };
  for (const [expected, kinds] of Object.entries(forms)) for (const kind of kinds) {
    f.api.business(business(kind));
    assert.equal(f.body.getAttribute('data-world-route'), expected, kind);
    assert.equal(f.body.getAttribute('data-world-context'), 'business');
    assert.equal(f.api.diagnostics().visible, expected !== 'farm');
    if (expected !== 'farm') assert.equal(f.api.diagnostics().renderer.presentation, expected);
  }
  f.api.business(business(null)); assert.equal(f.api.diagnostics().route, 'farm');
  f.api.business(business(null, { view: 'reminders' })); assert.equal(f.api.diagnostics().route, 'reminders');
  for (const kind of Object.values(forms).flat()) {
    f.api.business(business(kind, { auth: true })); assert.equal(f.api.diagnostics().route, 'authorization', kind);
  }
  for (const view of ['account', 'families', 'onboarding', 'create', 'join', 'invite', 'family-settings',
    'rename-family', 'transfer-owner', 'leave-family', 'delete-family', 'members', 'confirm']) {
    f.api.account(view); assert.equal(f.api.diagnostics().route, 'family', view);
  }
  for (const view of ['password', 'delete-account']) { f.api.account(view); assert.equal(f.api.diagnostics().route, 'authorization'); }
  for (const view of ['checking', 'loading-family', 'login', 'register', 'forgot', 'pending', 'unverified',
    'verify', 'reset', 'error', 'family-error', 'logout', 'logout-error', 'logout-wait', 'unknown-view']) {
    f.api.account(view); assert.equal(f.api.diagnostics().route, 'welcome', view);
  }
});

test('scope reset releases the private renderer and ignores its late status before an anonymous account mount', () => {
  const f = fixture(), input = business('points'), before = copy(input);
  f.api.business(input);
  const previous = f.controllers[0], lateStatus = previous.options.onStatus;
  previous.options.onStatus({ ready: true }); assert.equal(f.stage().getAttribute('data-scene-state'), 'ready');
  f.window.emit('resize'); assert.equal(f.frames.size, 1);
  f.api.reset();
  assert.equal(previous.disposed, true); assert.equal(f.stage().hidden, true); assert.equal(f.frames.size, 0);
  assert.equal(f.nodes['.world-stage-surface'].textContent, '');
  f.api.account('login');
  const current = f.controllers[1];
  assert.notEqual(current, previous); assert.equal(f.body.getAttribute('data-world-context'), 'account');
  assert.equal(current.options.farm.plots.length, 0); assert.equal(current.options.farm.animals.length, 0);
  assert.ok(!JSON.stringify(current.options).includes('private-plot'));
  assert.ok(!JSON.stringify(current.options).includes('Private family pet'));
  current.options.onStatus({ ready: true }); lateStatus({ error: 'late private failure' });
  assert.equal(f.stage().getAttribute('data-scene-state'), 'ready');
  assert.equal(f.nodes['.world-scene-fallback'].hidden, true);
  assert.deepEqual(input, before, 'presentation leaves business input untouched');
});

test('world routes reuse their renderer while returning to the farm releases it before a later mount', () => {
  const f = fixture(); f.api.business(business('points')); const controller = f.controllers[0];
  f.api.business(business('records')); assert.equal(f.controllers.length, 1); assert.equal(controller.options.presentation, 'history');
  f.document.hidden = true; f.document.emit('visibilitychange'); assert.equal(controller.paused, true);
  f.document.hidden = false; f.document.emit('visibilitychange'); assert.equal(controller.paused, false);
  f.window.emit('pagehide'); assert.equal(controller.paused, true);
  f.window.emit('pageshow'); f.flush(); assert.equal(controller.paused, false);
  f.api.business(business(null)); assert.equal(controller.disposed, true); assert.equal(f.stage().hidden, true);
  assert.equal(f.api.diagnostics().renderer, null);
  f.document.emit('visibilitychange'); f.window.emit('resize'); f.flush(); assert.equal(f.api.diagnostics().renderer, null);
  f.api.business(business('rewards')); assert.equal(f.controllers.length, 2); assert.equal(f.controllers[1].paused, false);
});

test('resize and live reduced-motion changes preserve form focus and send responsive insets', () => {
  const desktop = { left: 900, top: 110, width: 520 };
  const f = fixture({ panel: { getBoundingClientRect: () => desktop } }); f.api.business(business('points'));
  const controller = f.controllers[0];
  assert.deepEqual(copy(controller.options.viewInsets), { top: 70, right: 540, bottom: 80, left: 0 });
  assert.equal(controller.options.reducedMotion, false);
  f.media.matches = true; f.media.emit('change'); f.window.emit('resize'); f.window.visualViewport.emit('resize');
  assert.equal(f.frames.size, 1, 'viewport events share one pending refresh'); f.flush();
  assert.equal(controller.options.reducedMotion, true); assert.equal(f.document.activeElement, f.focus);
  f.window.innerWidth = 390; f.window.innerHeight = 844; f.panel({ getBoundingClientRect: () => ({ left: 12, top: 240, width: 366 }) });
  f.window.emit('resize'); f.flush();
  assert.deepEqual(copy(controller.options.viewInsets), { top: 0, right: 0, bottom: 604, left: 0 });
  assert.equal(f.stage().getAttribute('aria-hidden'), 'true'); assert.equal(f.nodes.canvas.tabIndex, -1);
  assert.equal(f.body.children[0], f.stage(), 'decoration stays outside the replaced application host');
});

test('missing or failing WebGL remains a decorative fallback and a subsequent mount can recover', () => {
  for (const options of [{ sceneMissing: true }, { mountThrows: true }]) {
    const f = fixture(options); assert.doesNotThrow(() => f.api.business(business('points')));
    assert.equal(f.stage().getAttribute('data-scene-state'), 'unavailable');
    assert.equal(f.nodes['.world-scene-fallback'].hidden, false);
    assert.match(f.nodes['.world-scene-fallback'].textContent, /各项操作仍可使用/);
    assert.equal(f.document.activeElement, f.focus);
  }
  const f = fixture(); f.api.account('login'); const controller = f.controllers[0];
  controller.options.onStatus({ error: 'FARM_CONTEXT_LOST' }); assert.equal(f.stage().getAttribute('data-scene-state'), 'unavailable');
  controller.options.onStatus({ ready: true }); assert.equal(f.stage().getAttribute('data-scene-state'), 'ready');
  assert.equal(f.nodes['.world-scene-fallback'].hidden, true);
});
