'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const THREE = require('three');
const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'farm/scene.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const modules = Promise.all(['primitives', 'companions', 'garden'].map(name => import(pathToFileURL(path.join(ROOT, 'farm', name + '.js')).href)));

// Exercise the public renderer controller with real companion geometry,
// cameras, raycasting and animation. Only browser plumbing and GPU submission
// are substituted; integration browsers verify native touch arbitration.
class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  send(type, values = {}) {
    const event = { type, isPrimary: true, pointerId: 1, button: 0, pointerType: 'mouse', prevented: false,
      preventDefault() { this.prevented = true; }, ...values };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }
}
class Renderer {
  constructor() {
    this.shadowMap = {}; this.renderLists = { dispose() {} }; this.capabilities = { isWebGL2: true };
    this.info = { render: { calls: 0, triangles: 0 }, memory: {}, programs: [] }; this.ratio = 1;
  }
  setClearColor() {}
  getPixelRatio() { return this.ratio; }
  setPixelRatio(value) { this.ratio = value; }
  setSize() {}
  render(scene, camera) { this.lastScene = scene; this.lastCamera = camera; this.info.render.calls++; }
  dispose() {}
}
async function fixture(overrides = {}, decorateCompanion = () => {}, capabilities = { isWebGL2: true, floatVertexTextures: true }) {
  const [primitives, companions, garden] = await modules, { group } = primitives;
  let time = 1000, nextFrame = 0, currentCompanion, gpu;
  const frames = new Map(), document = new Events(), window = new Events(), picks = [];
  const box = { left: 20, top: 30, width: 420, height: 310 };
  const rectangle = () => ({ ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height });
  document.hidden = false; window.devicePixelRatio = 1;
  const canvas = Object.assign(new Events(), { dataset: {}, style: {}, attributes: {}, captured: null,
    getBoundingClientRect: rectangle, setAttribute(name, value) { this.attributes[name] = value; },
    setPointerCapture(id) { this.captured = id; },
    releasePointerCapture(id) { if (this.captured === id) { this.captured = null; this.send('lostpointercapture', { pointerId: id }); } },
    remove() { this.removed = true; } });
  document.createElement = () => canvas;
  document.querySelectorAll = () => canvas.removed ? [] : [canvas];
  const element = { isConnected: true, getBoundingClientRect: rectangle, appendChild() {} };
  const bindings = { THREE: { ...THREE, WebGLRenderer: class extends Renderer { constructor() { super(); this.capabilities = { ...capabilities }; gpu = this; } } },
    ...primitives, ...garden, ...companions,
    makeCompanion(...args) { currentCompanion = companions.makeCompanion(...args); decorateCompanion(currentCompanion); return currentCompanion; },
    makeTerrain: () => group(), makeEnvironment: () => group(), makeDecoration: () => group(), makePlot: () => group(),
    HOUSE_POSITION: [-4.4, -4.2], PET_POSITION: [-2.2, 2.7], ANIMAL_POSITIONS: {},
    loadModels: async () => ({ clone: () => group(), dispose() {} }), addWindowGlow() {}, makeNightLights: () => group(),
    WORLD_STATIONS: { points: '积分' }, normalizePresentation: value => value === 'points' ? 'points' : 'farm',
    makeWorldStation: () => ({ id: 'points', label: '积分', root: new THREE.Mesh(new THREE.BoxGeometry(3, 3, 2), new THREE.MeshBasicMaterial()), companionPosition: [3, .025, 1], companionScale: .72, landmarks: [] }),
    animateWorldStation() {}, makeStationAccent: () => null, animateStationAccent() {}, createCreditScene() { throw new Error('credit disabled in this fixture'); } };
  const context = vm.createContext({ imports: bindings, document, window, performance: { now: () => time },
    requestAnimationFrame: callback => { const id = ++nextFrame; frames.set(id, callback); return id; }, cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver: class { observe() {} disconnect() {} } });
  const api = vm.runInContext('(function () { const { ' + Object.keys(bindings).join(', ') + ' } = imports;\n' + source + '\nreturn { mount, diagnostics }; })()', context);
  let controller;
  controller = api.mount(element, { mode: 'home', reducedMotion: true, companionView: { interactive: true, preview: false },
    pet: { kind: 'capybara', name: '小伙伴' }, growth: { stage: 1, stars: 0 }, farm: { plots: [{ id: 'p1', index: 0, unlocked: true, status: 'empty' }] },
    onSelect(target) { picks.push({ ...target }); controller.react('pet', target); }, ...overrides });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.diagnostics().ready, true, JSON.stringify(controller.diagnostics()));
  const point = () => {
    currentCompanion.root.updateMatrixWorld(true);
    const vertex = new THREE.Vector3(0, 1.08, .34).applyMatrix4(currentCompanion.root.matrixWorld).project(gpu.lastCamera);
    return { clientX: box.left + (vertex.x + 1) * box.width / 2, clientY: box.top + (1 - vertex.y) * box.height / 2 };
  };
  return { controller, canvas, document, window, box, picks, point, companion: () => currentCompanion,
    tap(position = point()) { canvas.send('pointerdown', position); canvas.send('pointerup', position); },
    advance(milliseconds) {
      const end = time + milliseconds;
      while (frames.size && time < end) { time = Math.min(end, time + 34); const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(time)); }
      time = end;
    } };
}

function visibleModelSignature(pet) {
  const hash = createHash('sha256');
  pet.root.updateMatrixWorld(true);
  pet.root.traverseVisible(node => {
    if (!node.isMesh) return;
    hash.update(JSON.stringify(node.matrixWorld.elements));
    for (const key of ['position', 'normal', 'color']) {
      const attribute = node.geometry.attributes[key];
      if (attribute) hash.update(Buffer.from(attribute.array.buffer, attribute.array.byteOffset, attribute.array.byteLength));
    }
    const index = node.geometry.index;
    if (index) hash.update(Buffer.from(index.array.buffer, index.array.byteOffset, index.array.byteLength));
    hash.update(JSON.stringify((Array.isArray(node.material) ? node.material : [node.material]).map(material =>
      ({ color: material.color?.toArray(), opacity: material.opacity, transparent: material.transparent }))));
  });
  return hash.digest('hex');
}

test('opted-in home taps select the actual companion and preserve the host pet reaction', async () => {
  const f = await fixture();
  try {
    f.tap(); assert.deepEqual(f.picks, [{ type: 'pet', id: 'pet' }]);
    const state = f.controller.diagnostics();
    assert.equal(state.companion.reaction.kind, 'pet'); assert.equal(state.companion.reaction.duration, 2200);
    assert.equal(state.companion.action, 'pet'); assert.equal(f.canvas.style.touchAction, 'pan-y');
    f.tap({ clientX: f.box.left + 2, clientY: f.box.top + 2 }); assert.equal(f.picks.length, 1, 'background never opens a farm object');
  } finally { f.controller.dispose(); }
});

test('home horizontal pet drags rotate without selecting, while vertical touch never rotates or activates the companion', async () => {
  const f = await fixture();
  try {
    const start = f.point(), navigation = JSON.stringify(f.controller.diagnostics().camera.navigation);
    f.canvas.send('pointerdown', start);
    f.canvas.send('pointermove', { clientX: start.clientX + 100, clientY: start.clientY + 3 });
    f.canvas.send('pointerup', { clientX: start.clientX + 100, clientY: start.clientY + 3 });
    assert.ok(Math.abs(f.controller.diagnostics().companion.rotation) > .5); assert.equal(f.picks.length, 0);
    assert.equal(JSON.stringify(f.controller.diagnostics().camera.navigation), navigation);
    f.controller.rotateCompanion({ reset: true });
    const touch = { ...f.point(), pointerType: 'touch' };
    f.canvas.send('pointerdown', touch); assert.equal(f.canvas.captured, null);
    const move = f.canvas.send('pointermove', { ...touch, clientX: touch.clientX + 2, clientY: touch.clientY + 90 });
    f.canvas.send('pointerup', { ...touch, clientX: touch.clientX + 2, clientY: touch.clientY + 90 });
    assert.equal(move.prevented, false, 'the gesture handler leaves vertical routing to the home container');
    assert.equal(f.controller.diagnostics().companion.rotation, 0); assert.equal(f.picks.length, 0);
    f.canvas.send('pointerdown', touch);
    f.canvas.send('pointermove', { ...touch, clientX: touch.clientX - 85, clientY: touch.clientY + 2 });
    assert.equal(f.canvas.captured, 1); f.canvas.send('pointerup', touch);
    assert.ok(f.controller.diagnostics().companion.rotation < -.5); assert.equal(f.picks.length, 0);
  } finally { f.controller.dispose(); }
});

test('interrupted pointers cannot become taps after resize, visibility, pause, context or capture changes', async () => {
  const f = await fixture();
  try {
    const cases = [
      () => f.canvas.send('pointercancel'), () => f.canvas.send('lostpointercapture'), () => f.controller.resize(),
      () => { f.document.hidden = true; f.document.send('visibilitychange'); f.document.hidden = false; f.document.send('visibilitychange'); },
      () => { f.controller.pause(true); f.controller.pause(false); }, () => f.window.send('blur'),
      () => { f.canvas.send('webglcontextlost'); f.canvas.send('webglcontextrestored'); }, () => f.controller.update({ lighting: 'night' })
    ];
    for (const interrupt of cases) { const start = f.point(); f.canvas.send('pointerdown', start); interrupt(); f.canvas.send('pointerup', start); assert.equal(f.picks.length, 0); }
    f.canvas.send('pointerdown', f.point()); f.canvas.send('pointerdown', { ...f.point(), pointerId: 2, isPrimary: false }); f.canvas.send('pointerup', f.point());
    assert.equal(f.picks.length, 0); f.tap(); assert.equal(f.picks.length, 1, 'a new clean tap still works');
  } finally { f.controller.dispose(); }
});

test('keyboard and preview rotations reset independently of expanded farm navigation and picking', async () => {
  const f = await fixture();
  try {
    f.canvas.send('keydown', { key: 'ArrowRight' }); assert.ok(f.controller.diagnostics().companion.rotation > 0);
    f.canvas.send('keydown', { key: 'Home' }); assert.equal(f.controller.diagnostics().companion.rotation, 0);
    f.controller.update({ mode: 'expanded' });
    f.controller.camera({ panX: 2, panZ: 1, zoomBy: 1.2 });
    const navigation = JSON.stringify(f.controller.diagnostics().camera.navigation);
    assert.equal(f.controller.diagnostics().companion.interactive, false);
    f.controller.rotateCompanion({ delta: 1 }); assert.equal(f.controller.diagnostics().companion.rotation, 0);
    const target = f.controller.diagnostics().hitTargets.find(item => item.type === 'plot');
    f.tap({ clientX: target.center.x, clientY: target.center.y }); assert.equal(f.picks.at(-1).type, 'plot');
    f.controller.update({ mode: 'home' }); f.controller.rotateCompanion({ delta: 1 });
    f.controller.update({ growth: { stage: 5, stars: 0 }, companionView: { interactive: true, preview: true } });
    let state = f.controller.diagnostics().companion; assert.equal(state.stage, 5); assert.equal(state.preview, true); assert.equal(state.rotation, 0);
    f.controller.update({ mode: 'expanded' }); assert.equal(JSON.stringify(f.controller.diagnostics().camera.navigation), navigation);
    f.controller.update({ presentation: 'points', mode: 'home' }); assert.equal(f.controller.diagnostics().companion.interactive, false);
  } finally { f.controller.dispose(); }
  assert.equal(f.controller.diagnostics().companion.rotation, 0); assert.equal(f.controller.diagnostics().disposed, true);
});

test('all species and five stages fill the reserved home frame through a full yaw turn', async () => {
  const f = await fixture();
  try {
    for (const width of [493, 294]) {
      f.box.width = width; f.box.height = width === 493 ? 402 : 310;
      f.controller.update({ viewInsets: { top: 35, bottom: 64, left: 0, right: 0 } });
      for (const kind of ['plant', 'capybara']) for (const stage of [1, 2, 3, 4, 5]) {
        f.controller.update({ pet: { kind, name: '伙伴' }, growth: { stage, stars: 0 } });
        const front = f.controller.diagnostics().petScreenBounds;
        assert.ok(front.height >= (width === 493 ? f.box.height * .64 : (f.box.height - 99) * .75), 'prominent companion: ' + JSON.stringify({ width, kind, stage, front }));
        for (let angle = 0; angle < 16; angle++) {
          f.controller.rotateCompanion({ delta: Math.PI / 8 });
          const bounds = f.controller.diagnostics().petScreenBounds;
          assert.ok(bounds.left >= f.box.left && bounds.right <= f.box.left + f.box.width && bounds.top >= f.box.top + 35 && bounds.bottom <= f.box.top + f.box.height - 64,
            JSON.stringify({ width, kind, stage, angle, bounds }));
        }
      }
    }
  } finally { f.controller.dispose(); }
});

test('every dragon gallery stage has two distinct visible looks that fit a full turn without reserving removed controls', async () => {
  const f = await fixture({ pet: { kind: 'plant', name: '小龙' } });
  try {
    for (const width of [493, 294]) {
      f.box.width = width; f.box.height = width === 493 ? 340 : 220;
      f.controller.update({ viewInsets: { top: 35, bottom: 0, left: 0, right: 0 } });
      for (const stage of [1, 2, 3, 4, 5]) {
        const looks = new Map();
        for (const variant of ['default', 'festival']) {
          f.controller.update({ growth: { stage, stars: 0 }, companionView: { interactive: true, preview: true, variant } });
          const current = f.controller.diagnostics();
          assert.equal(current.companion.kind, 'plant'); assert.equal(current.companion.stage, stage);
          assert.equal(current.companion.variant, variant); assert.equal(current.companion.preview, true);
          assert.equal(current.companion.showcase, true); assert.equal(current.world.terrain, 'showcase');
          assert.equal(current.camera.viewInsets.bottom, 0, 'removed rotation buttons reserve no gallery space');
          assert.equal(current.companion.rotation, 0, 'changing the stage or look begins from its front');
          looks.set(variant, visibleModelSignature(f.companion()));
          for (let angle = 0; angle < 16; angle++) {
            f.controller.rotateCompanion({ delta: Math.PI / 8 });
            const bounds = f.controller.diagnostics().petScreenBounds;
            assert.ok(bounds && bounds.width > 0 && bounds.height > 0);
            assert.ok(bounds.left >= f.box.left && bounds.right <= f.box.left + f.box.width &&
              bounds.top >= f.box.top + 35 && bounds.bottom <= f.box.top + f.box.height,
            JSON.stringify({ width, stage, variant, angle, bounds }));
          }
        }
        assert.notEqual(looks.get('default'), looks.get('festival'), 'the chosen look changes drawable geometry or materials at stage ' + stage);
        f.controller.update({ companionView: { interactive: true, preview: true, variant: 'default' } });
        assert.equal(visibleModelSignature(f.companion()), looks.get('default'), 'returning to the ordinary look restores identical drawable geometry and materials');
      }
    }
  } finally { f.controller.dispose(); }
});

test('gallery looks are scoped to dragon previews and returning to farming restores the chosen navigation and lighting', async () => {
  const actualGrowth = { stage: 1, stars: 0 }, pet = { kind: 'plant', name: '小龙' };
  const f = await fixture({ mode: 'expanded', pet, growth: actualGrowth, lighting: 'night' });
  try {
    f.controller.camera({ panX: 2, panZ: 1, zoomBy: 1.2 });
    const before = JSON.stringify(f.controller.diagnostics().camera);
    f.controller.update({ mode: 'home', growth: { stage: 5, stars: 0 }, companionView: { interactive: true, preview: true, variant: 'festival' } });
    assert.equal(f.controller.diagnostics().companion.variant, 'festival');
    f.canvas.send('keydown', { key: 'ArrowRight' }); assert.ok(f.controller.diagnostics().companion.rotation > 0);
    f.canvas.send('keydown', { key: 'Home' }); assert.equal(f.controller.diagnostics().companion.rotation, 0);
    f.controller.update({ mode: 'expanded', growth: actualGrowth, companionView: { interactive: false, preview: false, variant: 'festival' } });
    const restored = f.controller.diagnostics();
    assert.equal(restored.companion.variant, 'default'); assert.equal(restored.companion.showcase, false);
    assert.equal(restored.companion.stage, actualGrowth.stage); assert.equal(restored.companion.rotation, 0);
    assert.equal(restored.lighting, 'night'); assert.equal(restored.world.terrain, 'continuous');
    assert.equal(JSON.stringify(restored.camera), before, 'preview leaves expanded camera navigation untouched');
    const cases = [
      { mode: 'expanded' }, { presentation: 'points' }, { pet: { kind: 'capybara', name: '水豚' } },
      { companionView: { interactive: false, preview: true, variant: 'festival' } },
      { companionView: { interactive: true, preview: false, variant: 'festival' } }
    ];
    for (const overrides of cases) {
      f.controller.update({ mode: 'home', presentation: 'farm', pet, growth: actualGrowth,
        companionView: { interactive: true, preview: true, variant: 'festival' }, ...overrides });
      const state = f.controller.diagnostics();
      assert.equal(state.companion.variant, 'default'); assert.equal(state.companion.showcase, false);
      assert.equal(state.world.terrain, 'continuous');
    }
    f.controller.update({ mode: 'home', presentation: 'farm', pet, growth: actualGrowth,
      companionView: { interactive: true, preview: true, variant: 'unsupported' } });
    assert.equal(f.controller.diagnostics().companion.variant, 'default');
    assert.equal(f.controller.diagnostics().companion.showcase, true, 'invalid styling falls back to an ordinary gallery view');
  } finally { f.controller.dispose(); }
});

test('care responses have bounded readable durations and reduced motion returns to idle', async () => {
  const f = await fixture();
  try {
    for (const kind of ['pet', 'feed', 'wash', 'train', 'celebrate', 'grow', 'level']) {
      f.controller.react(kind, 'pet');
      const response = f.controller.diagnostics().companion.reaction;
      assert.equal(response.kind, kind); assert.ok(response.duration >= 2000 && response.duration <= 2600);
      assert.notEqual(f.controller.diagnostics().companion.action, '');
      f.advance(response.duration + 50);
      assert.equal(f.controller.diagnostics().companion.reaction, null); assert.equal(f.controller.diagnostics().companion.action, '');
      assert.equal(f.controller.diagnostics().running, false);
    }
  } finally { f.controller.dispose(); }
});

test('allocated care props and active care poses never change a business station frame', async () => {
  const ordinary = await fixture({ presentation: 'points' });
  const oversized = await fixture({ presentation: 'points' }, pet => pet.interactions.root.scale.setScalar(20));
  try {
    const expected = JSON.stringify(ordinary.controller.diagnostics().camera);
    assert.equal(JSON.stringify(oversized.controller.diagnostics().camera), expected, 'hidden effect allocation cannot affect the visible sculpture frame');
    for (const kind of ['pet', 'feed', 'wash', 'train', 'celebrate']) {
      ordinary.controller.react(kind, 'pet'); ordinary.controller.resize();
      assert.equal(JSON.stringify(ordinary.controller.diagnostics().camera), expected, kind + ' keeps station framing');
      ordinary.advance(2700); ordinary.controller.resize();
      assert.equal(JSON.stringify(ordinary.controller.diagnostics().camera), expected, kind + ' returns to the identical idle frame');
    }
  } finally { ordinary.controller.dispose(); oversized.controller.dispose(); }
});

test('rig envelopes keep a fixed home camera and current pose diagnostics are sampled only on demand', async () => {
  let samples = 0;
  const f = await fixture({}, pet => {
    const points = [], point = new THREE.Vector3();
    pet.root.updateMatrixWorld(true);
    pet.root.traverseVisible(mesh => {
      if (!mesh.isMesh) return;
      const positions = mesh.geometry.attributes.position;
      for (let i = 0; i < positions.count; i++) {
        mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld);
        points.push(point.x, point.y, point.z);
      }
      // A dense rig must not be resampled for a turn, resize or idle frame.
      mesh.getVertexPosition = () => { throw new Error('unexpected full rig scan'); };
    });
    const silhouette = new Float32Array(points);
    pet.frameProfile = { points: silhouette, bounds: new THREE.Box3().setFromArray(silhouette), motionPadding: .05 };
    pet.homeYaw = -.66;
    pet.measurePoints = anatomy => { samples++; return anatomy ? pet.bodyPoints : silhouette; };
  });
  try {
    f.controller.update({ reducedMotion: false });
    const expected = JSON.stringify(f.controller.camera()), before = samples;
    f.controller.rotateCompanion({ delta: 1.2 }); f.controller.resize(); f.advance(1000);
    assert.equal(samples, before, 'ordinary rendering consumes the prepared rig envelope');
    assert.equal(JSON.stringify(f.controller.camera()), expected, 'a full-profile frame does not follow the pose or yaw');
    const state = f.controller.diagnostics();
    assert.equal(samples, before + 2, 'explicit diagnostics sample anatomy and the full current pose');
    assert.ok(state.petScreenBounds.height > 0 && state.bodyScreenBounds.height > 0);
    assert.ok(Math.abs(state.companion.yaw - (.54 + Math.atan(.22))) < 1e-8);
    f.controller.rotateCompanion({ reset: true });
    assert.equal(f.controller.diagnostics().companion.yaw, -.66 + Math.atan(.22), 'Home returns to the model-selected front relative to the fixed camera');
    f.controller.update({ presentation: 'points' });
    assert.equal(f.controller.diagnostics().companion.yaw, .15, 'business stations retain their original orientation');
  } finally { f.controller.dispose(); }
});

test('rebuild and disposal release rig bone textures before shared Workshop resources', async () => {
  const resources = [];
  const f = await fixture({}, pet => {
    const skeleton = new THREE.Skeleton([new THREE.Bone()]);
    skeleton.computeBoneTexture();
    const resource = { disposed: false, visualReleasedAfterRig: true };
    skeleton.boneTexture.addEventListener('dispose', () => { resource.disposed = true; });
    pet.root.traverse(mesh => {
      if (mesh.isMesh) mesh.geometry.addEventListener('dispose', () => { resource.visualReleasedAfterRig &&= resource.disposed; });
    });
    const release = pet.dispose;
    pet.dispose = () => { skeleton.dispose(); release?.(); };
    resources.push(resource);
  });
  try {
    f.controller.update({ growth: { stage: 2, stars: 0 } });
    assert.equal(resources.length, 2);
    assert.ok(resources[0].disposed && resources[0].visualReleasedAfterRig, 'rebuild retires the old rig before its geometry');
    assert.equal(resources[1].disposed, false);
    f.canvas.send('webglcontextlost');
    assert.ok(resources[1].disposed && resources[1].visualReleasedAfterRig, 'loss retires old GL resources before a new context generation exists');
    f.canvas.send('webglcontextrestored');
    assert.equal(resources.length, 3); assert.equal(resources[2].disposed, false, 'context recovery builds a fresh live rig');
    f.controller.dispose(); f.controller.dispose();
    assert.ok(resources.every(resource => resource.disposed && resource.visualReleasedAfterRig));
  } finally { f.controller.dispose(); }
});

test('static Workshop batches preserve live skinning and expression meshes', async () => {
  const [{ Workshop, group }] = await modules, workshop = new Workshop(), root = group();
  const geometry = new THREE.BoxGeometry(.5, .5, .5), count = geometry.attributes.position.count;
  const weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) weights[i * 4] = 1;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  workshop.geometries.add(geometry);
  const skin = new THREE.SkinnedMesh(geometry, workshop.material(0x779759)), bone = new THREE.Bone();
  skin.add(bone); root.add(skin);
  const skeleton = new THREE.Skeleton([bone]); skin.bind(skeleton);
  const expressionGeometry = new THREE.BoxGeometry(.3, .3, .3), target = expressionGeometry.attributes.position.clone();
  for (let i = 0; i < target.count; i++) target.setX(i, target.getX(i) + .4);
  expressionGeometry.morphAttributes.position = [target]; workshop.geometries.add(expressionGeometry);
  const expression = new THREE.Mesh(expressionGeometry, workshop.material(0x55774c)); root.add(expression);
  workshop.box(root, 0x332211, [0, -.5, 0], [1, .1, 1]);
  try {
    const before = skin.getVertexPosition(0, new THREE.Vector3()).clone();
    workshop.bake(root);
    assert.equal(skin.parent, root); assert.equal(expression.parent, root, 'deforming meshes stay in the drawable assembly');
    bone.position.y = .7; root.updateMatrixWorld(true); skeleton.update();
    assert.ok(Math.abs(skin.getVertexPosition(0, new THREE.Vector3()).y - before.y - .7) < 1e-6, 'the baked assembly still responds to its bone');
    const resting = expression.getVertexPosition(0, new THREE.Vector3()).x;
    expression.morphTargetInfluences[0] = .5;
    assert.ok(Math.abs(expression.getVertexPosition(0, new THREE.Vector3()).x - resting - .2) < 1e-6, 'the baked assembly still responds to its expression target');
  } finally { skeleton.dispose(); workshop.dispose(); }
});

test('compact dragon views reduce drawable geometry, preserve turns across quality changes and use a WebGL1-compatible rig', async () => {
  const triangles = pet => {
    let count = 0;
    pet.root.traverseVisible(mesh => { if (mesh.isMesh) count += (mesh.geometry.index?.count || mesh.geometry.attributes.position.count) / 3; });
    return count;
  };
  const visibleSkins = pet => {
    let count = 0; pet.root.traverseVisible(mesh => { if (mesh.isSkinnedMesh) count++; }); return count;
  };
  const f = await fixture({ pet: { kind: 'plant', name: '小龙' } });
  try {
    const compact = triangles(f.companion());
    assert.ok(visibleSkins(f.companion()) > 0, 'compact WebGL2 keeps its GPU-driven rig');
    f.controller.rotateCompanion({ delta: .7 });
    f.box.width = 900; f.box.height = 700; f.controller.resize();
    assert.ok(compact < triangles(f.companion()) * .6, 'a small host uses substantially fewer triangles than the large presentation');
    assert.ok(Math.abs(f.controller.diagnostics().companion.rotation - .7) < 1e-8, 'quality upgrades preserve the chosen turn');
    f.box.width = 346; f.box.height = 322; f.controller.resize();
    assert.equal(triangles(f.companion()), compact);
    assert.ok(Math.abs(f.controller.diagnostics().companion.rotation - .7) < 1e-8, 'quality downgrades preserve the chosen turn');
  } finally { f.controller.dispose(); }
  const webgl1 = await fixture({ pet: { kind: 'plant', name: '小龙' } }, () => {}, { isWebGL2: false, floatVertexTextures: true });
  try {
    webgl1.box.width = 900; webgl1.box.height = 700; webgl1.controller.resize();
    assert.equal(visibleSkins(webgl1.companion()), 0, 'WebGL1 uses compatible CPU skinning even when float textures exist');
    webgl1.controller.react('pet', 'pet'); webgl1.advance(400);
    assert.equal(webgl1.controller.diagnostics().companion.action, 'pet');
    assert.ok(webgl1.controller.diagnostics().petScreenBounds.height > 0);
  } finally { webgl1.controller.dispose(); }
});
