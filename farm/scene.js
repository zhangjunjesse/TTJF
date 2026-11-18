import * as THREE from 'three';
import { Workshop, group } from './primitives.js';
import { makeCompanion, animateCompanion } from './companions.js';
import { makeTerrain, makeDecoration, makePlot, cropPhase, PLOT_POSITIONS, SLOT_POSITIONS } from './garden.js';
import { makeEnvironment, HOUSE_POSITION, PET_POSITION, ANIMAL_POSITIONS } from './world-environment.js';
import { loadModels } from './models.js';
import { addWindowGlow, makeNightLights } from './world-lighting.js';
import { WORLD_STATIONS, normalizePresentation, makeWorldStation, animateWorldStation } from './world-stations.js';
import { createCreditScene, makeStationAccent, animateStationAccent } from './ui-effects.js';

// Rendering only. FamilyModel owns all economy, maturity, unlocks and storage.
const instances = new Map();
let nextId = 0, active = null;
const safe = (fn, value) => { try { if (typeof fn === 'function') fn(value); } catch (_) {} };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const HOME_VIEW_YAW = Math.atan(.22);
function isCompanionShowcase(options) {
  return options.presentation === 'farm' && options.mode === 'home' && options.pet.kind === 'plant' && options.companionView.interactive && options.companionView.preview;
}
function normalize(options) {
  const normalized = {
    mode: options?.mode === 'expanded' ? 'expanded' : 'home', lighting: options?.lighting === 'night' ? 'night' : 'day',
    presentation: normalizePresentation(options?.presentation),
    farm: options?.farm || {}, pet: options?.pet || { kind: 'plant', name: '芽芽' },
    growth: options?.growth || { stage: 1, stars: 0, xp: 0 },
    companionView: { interactive: !!options?.companionView?.interactive, preview: !!options?.companionView?.preview, variant: 'default' },
    reducedMotion: !!options?.reducedMotion, onSelect: options?.onSelect, onStatus: options?.onStatus,
    credit: { enabled: !!options?.credit?.enabled, balance: Number(options?.credit?.balance) || 0 }, onCreditFrame: options?.onCreditFrame,
    viewInsets: { top: Math.max(0, Number(options?.viewInsets?.top) || 0), right: Math.max(0, Number(options?.viewInsets?.right) || 0), bottom: Math.max(0, Number(options?.viewInsets?.bottom) || 0), left: Math.max(0, Number(options?.viewInsets?.left) || 0) }
  };
  if (isCompanionShowcase(normalized) && options?.companionView?.variant === 'festival') normalized.companionView.variant = 'festival';
  return normalized;
}
function visualSignature(options) {
  const farm = options.farm;
  if (options.presentation !== 'farm') return JSON.stringify({ presentation: options.presentation, kind: options.pet.kind, stage: options.growth.stage, stars: Math.min(1, options.growth.stars || 0) });
  return JSON.stringify({ presentation: 'farm', initialized: farm.initialized,
    plots: (farm.plots || []).slice(0, 6).map(p => ({ id: p.id, index: p.index, unlocked: p.unlocked, cropId: p.cropId, status: p.status, plantedAt: p.plantedAt, readyAt: p.readyAt, phase: cropPhase(p) })),
    houseLevel: farm.houseLevel, placements: farm.placements,
    animals: (farm.animals || []).map(a => ({ id: a.id, unlocked: a.unlocked, caredToday: a.caredToday, actionUnlocked: a.actionUnlocked })),
    kind: options.pet.kind, stage: options.growth.stage, stars: Math.min(1, options.growth.stars || 0),
    showcase: isCompanionShowcase(options), variant: options.companionView.variant
  });
}
const SHOWCASE_PALETTES = [
  { top: 0x152b31, bottom: 0x223f3d, glow: 0x477267, floor: 0x193a37, platform: 0x334b43, metal: 0xc4c7a0, light: 0x9bcbb1 },
  { top: 0x182d32, bottom: 0x263f32, glow: 0x547454, floor: 0x24392b, platform: 0x3c4b35, metal: 0xd8bd7d, light: 0xb4cc91 },
  { top: 0x142c43, bottom: 0x1b3643, glow: 0x315c6b, floor: 0x1b3440, platform: 0x324953, metal: 0xc1c4b3, light: 0x9fd8de },
  { top: 0x231e3f, bottom: 0x29334a, glow: 0x4f4d79, floor: 0x252b42, platform: 0x41435e, metal: 0xc9b9d3, light: 0xc5b7e3 },
  { top: 0x142c38, bottom: 0x1c363e, glow: 0x3a5960, floor: 0x19313b, platform: 0x30484e, metal: 0xd8be83, light: 0xc1dac8 }
];
function makeShowcaseBackdrop(w, palette) {
  const size = 128, data = new Uint8Array(size * size * 4);
  const top = new THREE.Color(palette.top), bottom = new THREE.Color(palette.bottom), glow = new THREE.Color(palette.glow);
  const base = new THREE.Color(), pixel = new THREE.Color();
  for (let y = 0; y < size; y++) {
    const v = y / (size - 1); base.lerpColors(bottom, top, v);
    for (let x = 0; x < size; x++) {
      const u = x / (size - 1), k = (y * size + x) * 4;
      // A broad, quiet pool behind the sculpture separates dark costume edges;
      // it is baked once per stage, independent of idle frames and rotation.
      const pool = Math.exp(-((u - .49) ** 2 / .15 + (v - .54) ** 2 / .30)) * .48;
      pixel.copy(base).lerp(glow, pool).convertLinearToSRGB();
      data[k] = Math.round(pixel.r * 255); data[k + 1] = Math.round(pixel.g * 255); data[k + 2] = Math.round(pixel.b * 255); data[k + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace; texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearFilter; texture.needsUpdate = true; w.textures.add(texture);
  return texture;
}
function makeShowcaseFloor(w, parent, palette) {
  const size = 64, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const radius = Math.hypot((x - 31.5) / 31.5, (y - 31.5) / 31.5), k = (y * size + x) * 4;
    data[k] = data[k + 1] = data[k + 2] = 255; data[k + 3] = Math.round(Math.max(0, 1 - radius) ** 1.5 * 210);
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearFilter; texture.needsUpdate = true; w.textures.add(texture);
  const material = w.material(palette.floor, { map: texture, transparent: true, depthWrite: false });
  const floor = new THREE.Mesh(w.geometry('showcase-floor', () => new THREE.PlaneGeometry(12, 12)), material);
  floor.rotation.x = -Math.PI / 2; floor.position.y = -.04; floor.receiveShadow = true; parent.add(floor);
}
// Later forms fill out a pair of constellations behind the wings. The stars
// and fine connecting lines share one mesh and stay still in reduced motion.
function makeShowcaseStars(w, parent, stage, palette) {
  const stars = group(parent, [-.22, 0, -1.0]);
  stars.rotation.y = .215;
  const trail = [[1.05, 1.52], [1.54, 1.89], [1.41, 2.38], [1.78, 2.76], [1.27, 3.02]];
  const flare = [[0,.105],[.023,.026],[.079,0],[.023,-.026],[0,-.105],[-.023,-.026],[-.079,0],[-.023,.026]];
  for (const side of [-1, 1]) {
    let previous;
    for (let i = 0; i < stage; i++) {
      const [x,y] = trail[i], point = [side * x, y + (side === -1 ? .15 : 0), 0];
      const star = w.polygon(stars, i % 2 ? palette.metal : palette.light, flare, .012, point);
      star.scale.setScalar(i % 2 ? .54 : .9);
      if (previous && stage >= 3) w.beam(stars, palette.glow, previous, point, .005);
      previous = point;
    }
  }
  w.bake(stars);
  stars.traverse(child => { if (child.isMesh) { child.castShadow = false; child.receiveShadow = false; } });
  return stars;
}
function makeCompanionShowcase(w, parent, stage) {
  const root = group(parent), platformRadius = 1.10, platformBottom = -.02, platformTop = .15;
  const palette = SHOWCASE_PALETTES[stage - 1], backdrop = makeShowcaseBackdrop(w, palette);
  makeShowcaseFloor(w, root, palette);
  const platform = group(root);
  for (const [radius, height, y, color] of [[platformRadius, .06, .01, 0x24333b], [platformRadius * .98, .10, .09, palette.platform], [platformRadius * .965, .025, .1375, palette.platform]]) {
    const geometry = w.geometry(`showcase-platform:${radius}:${height}`, () => new THREE.CylinderGeometry(radius, radius, height, 64));
    w.add(platform, geometry, color, [0, y, 0]);
  }
  const leaf = [[-.035, 0], [0, .075], [.035, 0], [0, -.045]];
  for (const x of [-.075, 0, .075]) w.polygon(platform, palette.metal, leaf, .003, [x, .152, .89], [-Math.PI / 2, 0, x * 5]);
  w.bake(platform);
  const metal = new THREE.MeshStandardMaterial({ color: palette.metal, metalness: .42, roughness: .36 }); w.materials.add(metal);
  const trim = new THREE.Mesh(w.geometry('showcase-trim', () => new THREE.TorusGeometry(platformRadius * .975, .012, 6, 96)), metal);
  trim.rotation.x = Math.PI / 2; trim.position.y = .145; trim.receiveShadow = true; root.add(trim);
  const glow = new THREE.Mesh(w.geometry('showcase-glow', () => new THREE.TorusGeometry(platformRadius * .995, .008, 5, 96)), new THREE.MeshBasicMaterial({ color: palette.light, transparent: true, opacity: .65, depthWrite: false, toneMapped: false }));
  w.materials.add(glow.material); glow.rotation.x = Math.PI / 2; glow.position.y = .04; root.add(glow);
  const rim = new THREE.DirectionalLight(palette.light, .70);
  rim.position.set(-2, 4, -4); rim.target.position.set(0, 1, 0); root.add(rim, rim.target);
  const stars = makeShowcaseStars(w, root, stage, palette);
  return { root, stars, platformRadius, platformBottom, platformTop, backdrop, palette };
}
export function mount(element, initialOptions = {}) {
  const id = 'family-farm-' + (++nextId), canvasId = id + '-canvas';
  let options = normalize(initialOptions), renderer = null, canvas = null, scene = null, viewCamera = null, homeCamera = null, yardCamera = null, sunlight = null, hemisphere = null, fillLight = null, nightLights = null;
  const nightUniform = { value: 0 };
  let models = null, world = null, workshop = null, station = null, companion = null, companionShowcase = null, animals = [], rotors = [], targets = [];
  let response = null, selection = null, selectionRing = null, sparkle = null, stationAccent = null;
  let creditScene = null, creditFailed = false, pendingCreditSuccess = false;
  let ready = false, error = null, disposed = false, contextLost = false, manuallyPaused = false;
  let raf = 0, lastFrame = 0, lastShadow = 0, frameCount = 0, fpsStart = 0, fpsFrames = 0, fps = 0, width = 0, height = 0, dpr = 1;
  let signature = '', resizeObserver = null, pointer = null, clockStart = performance.now(), companionRotation = 0, companionFrame = null, companionStaticBounds = null;
  let status = { ready: false, webgl: false, error: null };
  const cleanup = [], raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const petPosition = new THREE.Vector3(PET_POSITION[0], .025, PET_POSITION[1]);
  const cameraDirection = new THREE.Vector3(), cameraTarget = new THREE.Vector3();
  const navigation = { x: 0, z: 0, zoom: 1, yaw: .50, viewHeight: 18, focus: null };
  const canPan = () => options.presentation === 'farm' && options.mode === 'expanded';
  const canRotateCompanion = () => options.presentation === 'farm' && options.mode === 'home' && options.companionView.interactive;
  const companionYaw = () => (options.presentation === 'farm' && options.mode === 'home' && Number.isFinite(companion?.homeYaw) ? companion.homeYaw + HOME_VIEW_YAW : .15) + companionRotation;
  const companionQuality = () => !renderer?.capabilities.isWebGL2 || width < 720 || Math.min(width, height) < 600 ? 'low' : 'high';
  const restingCursor = () => canPan() || canRotateCompanion() ? 'grab' : 'pointer';
  function cancelPointer() {
    const previous = pointer; pointer = null;
    if (!canvas) return;
    canvas.style.cursor = restingCursor();
    if (previous) { try { canvas.releasePointerCapture(previous.id); } catch (_) {} }
  }
  function describeCanvas() {
    if (!canvas) return;
    const label = WORLD_STATIONS[options.presentation];
    canvas.dataset.presentation = options.presentation;
    canvas.style.touchAction = canPan() ? 'none' : 'pan-y'; canvas.style.cursor = restingCursor();
    canvas.setAttribute('role', label || canRotateCompanion() ? 'button' : 'img');
    canvas.setAttribute('aria-label', label ? `${label}，农场风格三维场景；点击或按回车打开地点` : canRotateCompanion() ? `${options.pet.name || '伙伴'}，点击或按回车互动，左右拖动或方向键转身，Home 键回到正面` : `${options.pet.name || '伙伴'}的农场，点击田地或伙伴；展开后可拖动浏览`);
  }
  const emit = () => { status = { ready, webgl: !!renderer && !contextLost, error }; safe(options.onStatus, { ...status }); };
  function listen(target, event, fn, opts) { target.addEventListener(event, fn, opts); cleanup.push(() => target.removeEventListener(event, fn, opts)); }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
  function canRun() { return !disposed && ready && !contextLost && !manuallyPaused && !document.hidden && element?.isConnected && width > 0 && height > 0; }
  function request() {
    if (!canRun() || raf) return;
    if (active && active !== controller) active.pause(true);
    active = controller; raf = requestAnimationFrame(tick);
  }
  function fail(code, cause) { ready = false; error = code + (cause?.message ? ': ' + String(cause.message).slice(0, 180) : ''); stop(); emit(); }
  function prepareScene() {
    if (disposed) return;
    try {
      // Updates can arrive while models load or WebGL is lost. Reconcile the
      // latest options before the host is told that this scene is ready again.
      if (models && !contextLost) {
        rebuild(); applyLighting(); resize();
        ready = !contextLost && !error;
      }
      emit(); request();
    } catch (cause) { fail('FARM_SCENE_FAILED', cause); }
  }
  function screenBounds(box, matrix) {
    if (!viewCamera || !canvas || !box || box.isEmpty()) return null;
    const r = canvas.getBoundingClientRect(), b = box.clone(); if (matrix) b.applyMatrix4(matrix);
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
      const v = new THREE.Vector3(x, y, z).project(viewCamera);
      const sx = r.left + (v.x + 1) * r.width / 2, sy = r.top + (1 - v.y) * r.height / 2;
      left = Math.min(left, sx); right = Math.max(right, sx); top = Math.min(top, sy); bottom = Math.max(bottom, sy);
    }
    return { x: left, y: top, width: right - left, height: bottom - top, left, top, right, bottom };
  }
  function projectCompanionPoints(points) {
    if (!companion || !viewCamera || !canvas || !points?.length) return null;
    const r = canvas.getBoundingClientRect(), vertex = new THREE.Vector3();
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (let i = 0; i < points.length; i += 3) {
      vertex.set(points[i], points[i + 1], points[i + 2]).applyMatrix4(companion.root.matrixWorld).project(viewCamera);
      const x = r.left + (vertex.x + 1) * r.width / 2, y = r.top + (1 - vertex.y) * r.height / 2;
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    return { x: left, y: top, width: right - left, height: bottom - top, left, top, right, bottom };
  }
  function bodyScreenBounds() {
    return projectCompanionPoints(companion?.measurePoints ? companion.measurePoints(true) : companion?.bodyPoints);
  }
  function companionScreenBounds() {
    if (!companion || !viewCamera || !canvas) return null;
    if (companion.measurePoints) return projectCompanionPoints(companion.measurePoints(false));
    const rect = canvas.getBoundingClientRect(), point = new THREE.Vector3();
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    companion.root.traverseVisible(mesh => {
      if (!mesh.isMesh) return;
      mesh.skeleton?.update();
      const positions = mesh.geometry.attributes.position;
      for (let i = 0; i < positions.count; i++) {
        mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld).project(viewCamera);
        const x = rect.left + (point.x + 1) * rect.width / 2, y = rect.top + (1 - point.y) * rect.height / 2;
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    });
    return Number.isFinite(left) ? { x: left, y: top, width: right - left, height: bottom - top, left, top, right, bottom } : null;
  }
  function addTarget(type, targetId, x, y, z, sx, sy, sz) {
    const geo = workshop.geometry('hitbox', () => new THREE.BoxGeometry(1, 1, 1));
    const mat = workshop.material(0xffffff, { visible: false });
    const mesh = new THREE.Mesh(geo, mat); mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz);
    mesh.userData.target = { type, id: targetId }; world.add(mesh); targets.push(mesh); return mesh;
  }
  function measureCompanionFrame() {
    // Fit the sculpture over a full turn. Transient care props do not change
    // the camera while their animation appears around the same companion.
    companion.root.updateMatrixWorld(true);
    const inverse = companion.root.matrixWorld.clone().invert(), point = new THREE.Vector3(), profile = [], scale = companion.root.scale;
    const frame = companion.frameProfile, padding = Math.max(0, Number(frame?.motionPadding) || 0);
    const localBounds = new THREE.Box3();
    const addPoint = () => {
      localBounds.expandByPoint(point);
      const y = point.y * scale.y, radius = Math.hypot(point.x * scale.x, point.z * scale.z) + padding * Math.max(scale.x, scale.z);
      profile.push(y - padding * scale.y, radius);
      if (padding) profile.push(y + padding * scale.y, radius);
    };
    if (frame?.points?.length) {
      // The rig supplies a bounded, precomputed envelope of its full resting
      // and care poses. Never reskin a dense model when the host resizes or turns.
      for (let i = 0; i < frame.points.length; i += 3) { point.fromArray(frame.points, i); addPoint(); }
      if (frame.bounds && !frame.bounds.isEmpty()) localBounds.union(frame.bounds);
    } else {
      companion.root.traverseVisible(mesh => {
        if (!mesh.isMesh || mesh.userData.companionDecoration) return;
        for (let node = mesh; node && node !== companion.root; node = node.parent) if (node === companion.interactions?.root) return;
        mesh.skeleton?.update();
        const positions = mesh.geometry.attributes.position, matrix = new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
        for (let i = 0; i < positions.count; i++) { mesh.getVertexPosition(i, point).applyMatrix4(matrix); addPoint(); }
      });
    }
    companionStaticBounds = localBounds.expandByScalar(padding).applyMatrix4(companion.root.matrixWorld);
    if (companionShowcase) {
      // The plinth belongs to the gallery frame, never to the dragon's body or
      // picking geometry. Account for its real lower edge without a UI inset.
      profile.push(companionShowcase.platformBottom - petPosition.y, companionShowcase.platformRadius);
      profile.push(0, companionShowcase.platformRadius);
    }
    companionFrame = new Float32Array(profile);
  }
  function releaseWorld() {
    // A rig can own GPU bone textures outside Workshop's geometry/material
    // registry. Release those before its shared visual resources are discarded.
    companion?.dispose?.();
    if (world) scene?.remove(world);
    workshop?.dispose(); renderer?.renderLists.dispose();
    world = null; workshop = null; companion = null; companionShowcase = null; companionFrame = null; companionStaticBounds = null;
    station = null; nightLights = null; targets = []; animals = []; rotors = [];
    selectionRing = null; sparkle = null; stationAccent = null; response = null;
  }
  function fitCompanionHome(aspect, tanFov) {
    const tilt = cameraDirection.y, level = Math.sqrt(1 - tilt * tilt), pad = Math.min(8, width * .025, height * .025), inset = options.viewInsets;
    const horizontal = tanFov * aspect * Math.max(.10, 1 - 2 * (Math.max(inset.left, inset.right) + pad) / width);
    const top = tanFov * Math.max(.10, 1 - 2 * (inset.top + pad) / height), bottom = tanFov * Math.max(.10, 1 - 2 * (inset.bottom + pad) / height);
    const topSlope = tilt + level / top, bottomSlope = tilt - level / bottom, sideRadius = Math.hypot(level, 1 / horizontal);
    let topLimit = -Infinity, bottomLimit = -Infinity, sideLimit = -Infinity;
    for (let i = 0; i < companionFrame.length; i += 2) {
      const y = companionFrame[i], radius = companionFrame[i + 1];
      // A vertex sweeps a horizontal circle during a full turn. Its exact
      // perspective constraint combines that same vertex's height and radius,
      // rather than unrelated tail, head and near-depth extrema.
      topLimit = Math.max(topLimit, y * topSlope + radius * Math.abs(level - tilt / top));
      bottomLimit = Math.max(bottomLimit, y * bottomSlope + radius * Math.abs(level + tilt / bottom));
      sideLimit = Math.max(sideLimit, y * tilt + radius * sideRadius);
    }
    const centerY = Math.max((topLimit - bottomLimit) / (topSlope - bottomSlope), (sideLimit - bottomLimit) / (tilt - bottomSlope));
    const distance = Math.max(topLimit - topSlope * centerY, bottomLimit - bottomSlope * centerY, sideLimit - tilt * centerY);
    cameraTarget.set(petPosition.x, petPosition.y + centerY, petPosition.z);
    return distance * tanFov * 2;
  }
  function rebuild() {
    if (!models || disposed) return;
    const quality = companionQuality(), nextSignature = visualSignature(options) + (options.pet.kind === 'capybara' ? '' : ':' + quality);
    if (signature === nextSignature && world) return;
    signature = ''; cancelPointer(); scene.background = null; releaseWorld();
    workshop = new Workshop(); world = group(scene);
    const farm = options.farm, showcase = isCompanionShowcase(options);
    if (!showcase) { world.add(makeTerrain(workshop)); world.add(makeEnvironment(workshop, models, options.presentation === 'farm' ? farm : {})); }
    let houseLevel = 0;
    if (showcase) {
      const stage = clamp(Math.floor(Number(options.growth.stage) || 1), 1, 5);
      companionShowcase = makeCompanionShowcase(workshop, world, stage);
      scene.background = companionShowcase.backdrop;
      petPosition.set(0, companionShowcase.platformTop, 0);
    } else if (options.presentation === 'farm') {
      houseLevel = clamp(Math.floor(Number(farm.houseLevel) || (farm.initialized ? 1 : 0)), 0, 3);
      if (houseLevel) {
        const house = models.clone('house' + houseLevel, 'building-farmhouse-' + houseLevel, 4.45 + houseLevel * .20);
        house.position.set(HOUSE_POSITION[0], .025, HOUSE_POSITION[1]); house.rotation.y = .05; world.add(house); workshop.bake(house); addWindowGlow(workshop, house, nightUniform);
        addTarget('house', 'house', HOUSE_POSITION[0], 2.15, HOUSE_POSITION[1], 4.5, 4.3, 4.1);
      }
      (farm.plots || []).slice(0, 6).forEach((plot, i) => {
        const index = Number.isInteger(plot.index) ? clamp(plot.index, 0, 5) : i;
        const patch = makePlot(workshop, models, plot, index, Date.now()); world.add(patch);
        const p = PLOT_POSITIONS[index]; addTarget('plot', plot.id || ('p' + (index + 1)), p[0], .40, p[1], 2.04, .80, 2.19);
      });
      const placements = farm.placements || {};
      for (const slot of Object.keys(SLOT_POSITIONS)) {
        const decor = makeDecoration(workshop, slot, placements[slot]); world.add(decor);
        if (decor.userData.rotor) rotors.push(decor.userData.rotor);
        const p = SLOT_POSITIONS[slot]; addTarget('slot', slot, p[0], slot === 'edge' ? .9 : .25, p[1], slot === 'fence' ? 2.4 : 1.1, slot === 'edge' ? 1.8 : .65, 1.1);
      }
      for (const animal of (farm.animals || []).filter(a => a.unlocked && ['chicken', 'rabbit'].includes(a.id)).slice(0, 2)) {
        const isChicken = animal.id === 'chicken', p = ANIMAL_POSITIONS[animal.id];
        const model = models.clone(animal.id, 'animal-' + animal.id, isChicken ? .62 : .64, true);
        model.position.set(p[0], .025, p[1]); model.rotation.y = isChicken ? .25 : .65; world.add(model); workshop.bake(model);
        animals.push({ root: model, id: animal.id, baseY: .025, baseAngle: model.rotation.y, actionUnlocked: !!animal.actionUnlocked });
        addTarget('animal', animal.id, p[0], .48, p[1], .95, .95, 1.08);
        if (animal.caredToday) { const badge = group(world, [p[0] + .36, .19, p[1] + .18]); workshop.star(badge, 0xe8bb59, [0, 0, 0], .105); workshop.bake(badge); }
      }
      petPosition.set(PET_POSITION[0], placements.path === 'path' ? .045 : .025, PET_POSITION[1]);
    } else {
      station = makeWorldStation(workshop, models, options.presentation, nightUniform); world.add(station.root);
      stationAccent = makeStationAccent(workshop, station);
      petPosition.set(...station.companionPosition);
      addTarget('destination', station.id, station.root.position.x + .3, 1.85, station.root.position.z - .45, 5.6, 3.7, 2.8);
    }
    const webgl2 = !!renderer.capabilities.isWebGL2;
    // Three r160's skinning shader uses GLSL3 texture fetches. WebGL1 keeps
    // the same animated rig through the companion's CPU-skinning path.
    companion = makeCompanion(workshop, options.pet.kind, clamp(Math.floor(options.growth.stage || 1), 1, 5), options.growth.stars || 0,
      { variant: options.companionView.variant, webgl2, boneTextures: webgl2 && renderer.capabilities.floatVertexTextures !== false, quality });
    companion.root.position.copy(petPosition); companion.root.scale.setScalar(station ? station.companionScale : .72); companion.root.rotation.y = companionYaw(); world.add(companion.root);
    measureCompanionFrame();
    companion.root.traverse(mesh => { if (mesh.isMesh) { mesh.castShadow = !mesh.material.transparent && !mesh.userData.noShadow; mesh.receiveShadow = !mesh.userData.noShadow; } });
    addTarget(station ? 'destination' : 'pet', station ? 'companion' : 'pet', petPosition.x, 1.1, petPosition.z, 1.55, 2.2, 1.35);
    selectionRing = workshop.ring(world, 0xf1cc67, [0, .15, 0], .70, .035, [Math.PI / 2, 0, 0]); selectionRing.visible = false; selectionRing.castShadow = false;
    sparkle = group(world); sparkle.visible = false;
    for (let i = 0; i < 7; i++) { const a = i * Math.PI * 2 / 7; workshop.star(sparkle, i % 2 ? 0xffe5a8 : 0xf2be80, [Math.cos(a) * .82, 1.20 + Math.sin(a) * .55, Math.sin(a) * .3], .07 + (i % 2) * .025); }
    workshop.bake(sparkle); sparkle.position.copy(petPosition); sparkle.traverse(m => { if (m.isMesh) m.castShadow = false; });
    if (!showcase) nightLights = makeNightLights(workshop, world, houseLevel > 0);
    if (station) { const light = new THREE.PointLight(0xffbc63, 5, 7, 2); light.position.set(station.root.position.x + .3, 1.8, station.root.position.z + 1.2); nightLights.add(light); }
    applyLighting();
    renderer.shadowMap.needsUpdate = true;
    world.updateMatrixWorld(true); fitCamera(); select(selection, false); draw(performance.now()); signature = nextSignature;
  }
  function applyLighting() {
    if (!sunlight || !hemisphere || !fillLight) return;
    const showcase = !!companionShowcase, night = !showcase && options.lighting === 'night', changed = nightUniform.value !== (night ? 1 : 0);
    nightUniform.value = night ? 1 : 0;
    if (nightLights) nightLights.visible = night;
    if (showcase) {
      // Neutral studio light keeps each stage's colour and attached equipment
      // readable. Reuse the renderer and sun shadow map across gallery switches.
      hemisphere.color.set(0xf4f2e7); hemisphere.groundColor.set(0x959789); hemisphere.intensity = 1.20;
      sunlight.color.set(0xfff0d6); sunlight.intensity = 2.30; sunlight.position.set(-3, 6, 5); sunlight.target.position.set(0, .8, 0);
      fillLight.color.set(0xe0eded); fillLight.intensity = .95; fillLight.position.set(3, 3, 4);
      scene.fog.color.set(companionShowcase.palette.bottom); scene.fog.near = 8; scene.fog.far = 32;
      renderer.setClearColor(companionShowcase.palette.bottom, 1);
      renderer.toneMappingExposure = 1.0;
      Object.assign(sunlight.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: .1, far: 20 }); sunlight.shadow.camera.updateProjectionMatrix();
      if (changed) renderer.shadowMap.needsUpdate = true;
      return;
    }
    hemisphere.color.set(night ? 0x879bce : 0xcfe4ed); hemisphere.groundColor.set(night ? 0x253e44 : 0x756344); hemisphere.intensity = night ? .9 : 1.05;
    sunlight.color.set(night ? 0x91b2ec : 0xffebc7); sunlight.intensity = night ? .82 : 2.7;
    sunlight.position.set(night ? -8 : -15, night ? 18 : 22, night ? -12 : 11); sunlight.target.position.set(0, 0, 0);
    fillLight.color.set(night ? 0x829ed1 : 0xb7d3df); fillLight.intensity = night ? .65 : .25;
    fillLight.position.set(night ? -3 : 8, night ? 7 : 5, night ? 10 : -8);
    scene.fog.color.set(night ? 0x19333c : 0xa4bba0); scene.fog.near = 65; scene.fog.far = 110; renderer.setClearColor(night ? 0x19333c : 0x90ae75, 1);
    renderer.toneMappingExposure = night ? 1.05 : 1.05;
    Object.assign(sunlight.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 85 }); sunlight.shadow.camera.updateProjectionMatrix();
    if (changed) renderer.shadowMap.needsUpdate = true;
  }
  function fitCamera() {
    if (!yardCamera || !homeCamera || !companion || width < 1 || height < 1) return;
    const aspect = width / height;
    let viewHeight;
    if (station) {
      viewCamera = yardCamera;
      cameraDirection.set(Math.sin(navigation.yaw), .80, Math.cos(navigation.yaw)).normalize();
      const right = new THREE.Vector3(Math.cos(navigation.yaw), 0, -Math.sin(navigation.yaw));
      const up = new THREE.Vector3().crossVectors(cameraDirection, right).normalize();
      // Hidden care props are allocated with the model, but never belong to a
      // station's static frame. Reuse the sculpture's resting bounds so care
      // poses and context recovery also preserve that same camera.
      const bounds = new THREE.Box3().setFromObject(station.root).union(companionStaticBounds);
      const center = bounds.getCenter(new THREE.Vector3()), corner = new THREE.Vector3();
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
        corner.set(x, y, z).sub(center); const xx = corner.dot(right), yy = corner.dot(up);
        minX = Math.min(minX, xx); maxX = Math.max(maxX, xx); minY = Math.min(minY, yy); maxY = Math.max(maxY, yy);
      }
      const inset = options.viewInsets;
      const left = Math.min(width * .8, inset.left), rightInset = Math.min(width - left - 1, inset.right);
      const top = Math.min(height * .8, inset.top), bottom = Math.min(height - top - 1, inset.bottom);
      const availableWidth = Math.max(1, width - left - rightInset), availableHeight = Math.max(1, height - top - bottom);
      // Fit the actual diorama into the unobscured rectangle. Shifting along the
      // camera plane preserves the same viewing angle on desktop and portrait.
      const unit = Math.max((maxX - minX) / (availableWidth * .88), (maxY - minY) / (availableHeight * .86));
      viewHeight = unit * height;
      cameraTarget.copy(center).addScaledVector(right, (minX + maxX) / 2).addScaledVector(up, (minY + maxY) / 2);
      cameraTarget.addScaledVector(right, -(left - rightInset) * unit / 2).addScaledVector(up, (top - bottom) * unit / 2);
      viewCamera.position.copy(cameraTarget).addScaledVector(cameraDirection, 42);
      viewCamera.left = -viewHeight * aspect / 2; viewCamera.right = viewHeight * aspect / 2;
      viewCamera.top = viewHeight / 2; viewCamera.bottom = -viewHeight / 2;
    } else if (options.mode === 'expanded') {
      viewCamera = yardCamera;
      cameraDirection.set(Math.sin(navigation.yaw), .96, Math.cos(navigation.yaw)).normalize();
      const focusTarget = targets.find(t => t.userData.target.type === navigation.focus?.type && t.userData.target.id === navigation.focus?.id);
      const restingX = aspect < .8 && !focusTarget ? .6 : 1.1;
      cameraTarget.set(restingX + navigation.x, focusTarget ? focusTarget.position.y : .45, .3 + navigation.z);
      // Portrait views deliberately crop the world at the same useful object scale.
      // The farm continues outside the frame; drag, zoom and focus explore it.
      viewHeight = Math.min((aspect < .8 ? 20.8 : 18.0) / navigation.zoom, 76 / (aspect * Math.cos(navigation.yaw) + Math.sin(navigation.yaw) / cameraDirection.y), 76 / (aspect * Math.sin(navigation.yaw) + Math.cos(navigation.yaw) / cameraDirection.y));
      if (focusTarget) {
        const inset = options.viewInsets, dx = clamp((inset.left - inset.right) / 2, -width * .4, width * .4), dy = clamp((inset.top - inset.bottom) / 2, -height * .4, height * .4), unit = viewHeight / height;
        cameraTarget.x += (-Math.cos(navigation.yaw) * dx - Math.sin(navigation.yaw) * dy / cameraDirection.y) * unit;
        cameraTarget.z += (Math.sin(navigation.yaw) * dx - Math.cos(navigation.yaw) * dy / cameraDirection.y) * unit;
      }
      // Keep the entire ground footprint inside continuous terrain even when
      // panning diagonally at the widest zoom or on an ultrawide display.
      const reachX = viewHeight * (aspect * Math.cos(navigation.yaw) + Math.sin(navigation.yaw) / cameraDirection.y) / 2;
      const reachZ = viewHeight * (aspect * Math.sin(navigation.yaw) + Math.cos(navigation.yaw) / cameraDirection.y) / 2;
      cameraTarget.x = clamp(cameraTarget.x, -39 + reachX, 39 - reachX);
      cameraTarget.z = clamp(cameraTarget.z, -39 + reachZ, 39 - reachZ);
      viewCamera.position.copy(cameraTarget).addScaledVector(cameraDirection, 42);
      viewCamera.left = -viewHeight * aspect / 2; viewCamera.right = viewHeight * aspect / 2;
      viewCamera.top = viewHeight / 2; viewCamera.bottom = -viewHeight / 2;
    } else {
      viewCamera = homeCamera;
      cameraDirection.set(.22, canRotateCompanion() ? .20 : .36, 1).normalize();
      const tanFov = Math.tan(THREE.MathUtils.degToRad(homeCamera.fov) / 2);
      const bodyHeight = (companion.bodyBounds.max.y - companion.bodyBounds.min.y) * .72;
      // Short dashboard cards need a tighter portrait: preserve the same physical
      // model scale while bringing the camera closer to its anatomical centre.
      const compactHome = height < 180;
      viewHeight = Math.max(compactHome ? 0 : 3.2, bodyHeight / (compactHome ? .72 : .58));
      const bodyWidth = (companion.bodyBounds.max.x - companion.bodyBounds.min.x) * .72;
      viewHeight = Math.max(viewHeight, bodyWidth / Math.max(.42, aspect * .74));
      cameraTarget.set(petPosition.x + clamp((aspect - .85) * .20, 0, .3), bodyHeight * .57, petPosition.z - .02);
      if (canRotateCompanion() && companionFrame) {
        // Keep a constant frame across yaw, within only the host's current
        // caption and control insets. Expanded navigation remains separate.
        viewHeight = fitCompanionHome(aspect, tanFov);
      }
      homeCamera.aspect = aspect;
      const distance = viewHeight / (2 * tanFov);
      homeCamera.position.copy(cameraTarget).addScaledVector(cameraDirection, distance);
    }
    navigation.viewHeight = viewHeight;
    viewCamera.lookAt(cameraTarget); viewCamera.updateProjectionMatrix(); viewCamera.updateMatrixWorld(true);
  }
  function cameraState() { return { zoom: station ? 1 : navigation.zoom, target: { x: cameraTarget.x, y: cameraTarget.y, z: cameraTarget.z }, yaw: navigation.yaw, viewHeight: navigation.viewHeight, projection: viewCamera?.isPerspectiveCamera ? 'perspective' : 'orthographic', viewInsets: { ...options.viewInsets }, canPan: canPan(), navigation: { x: navigation.x, z: navigation.z, zoom: navigation.zoom, focus: navigation.focus ? { ...navigation.focus } : null } }; }
  function camera(action = {}) {
    if (disposed) return cameraState();
    if (station) { fitCamera(); draw(performance.now()); request(); return cameraState(); }
    if (action.restore && typeof action.restore === 'object') {
      const saved = action.restore;
      navigation.x = Number.isFinite(saved.x) ? clamp(saved.x, -14, 14) : 0;
      navigation.z = Number.isFinite(saved.z) ? clamp(saved.z, -15, 15) : 0;
      navigation.zoom = Number.isFinite(saved.zoom) ? clamp(saved.zoom, .62, 2.5) : 1;
      const focused = targets.find(t => t.userData.target.type === saved.focus?.type && t.userData.target.id === saved.focus?.id);
      navigation.focus = focused ? { type: focused.userData.target.type, id: focused.userData.target.id } : null;
    }
    if (action.reset) { navigation.x = 0; navigation.z = 0; navigation.zoom = 1; navigation.focus = null; }
    if (Number.isFinite(action.zoomBy) && action.zoomBy > 0) navigation.zoom = clamp(navigation.zoom * action.zoomBy, .62, 2.5);
    if (Number.isFinite(action.panX)) navigation.x = clamp(navigation.x + action.panX, -14, 14);
    if (Number.isFinite(action.panZ)) navigation.z = clamp(navigation.z + action.panZ, -15, 15);
    if (action.focus) {
      const target = targets.find(t => t.userData.target.type === action.focus.type && t.userData.target.id === action.focus.id);
      if (target) { navigation.x = clamp(target.position.x - 1.1, -14, 14); navigation.z = clamp(target.position.z - .3, -15, 15); navigation.focus = { ...action.focus }; }
    }
    fitCamera(); draw(performance.now()); request(); return cameraState();
  }
  function focus(target) { return camera({ focus: target }); }
  function companionState() {
    return { kind: companion?.kind || options.pet.kind, stage: companion?.stage || clamp(Math.floor(Number(options.growth.stage) || 1), 1, 5),
      interactive: canRotateCompanion(), preview: options.companionView.preview, variant: companion?.variant || options.companionView.variant,
      showcase: !!companionShowcase, rotation: companionRotation, yaw: companionYaw(),
      action: companion?.interactions?.action || '', reaction: response ? { kind: response.kind, progress: response.progress, duration: response.duration } : null };
  }
  function rotateCompanion(action = {}) {
    if (disposed || !canRotateCompanion()) return companionState();
    if (action.reset) companionRotation = 0;
    else if (Number.isFinite(action.delta)) companionRotation = Math.atan2(Math.sin(companionRotation + action.delta), Math.cos(companionRotation + action.delta));
    if (companion) { companion.root.rotation.y = companionYaw(); renderer.shadowMap.needsUpdate = true; }
    draw(performance.now()); request(); return companionState();
  }
  function resize() {
    if (disposed || !renderer || !element) return;
    cancelPointer();
    const rect = element.getBoundingClientRect(), nextWidth = Math.max(0, Math.round(rect.width)), nextHeight = Math.max(0, Math.round(rect.height));
    width = nextWidth; height = nextHeight;
    if (!width || !height) { stop(); return; }
    dpr = Math.min(1.25, Math.max(1, window.devicePixelRatio || 1));
    if (renderer.getPixelRatio() !== dpr) renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    if (ready && models && !contextLost) rebuild();
    fitCamera(); draw(performance.now()); request();
  }
  function draw(time) {
    if (disposed || manuallyPaused || document.hidden || !element?.isConnected || !renderer || !scene || !viewCamera || !world || !companion || contextLost || !width || !height) return;
    const seconds = (time - clockStart) / 1000;
    if (companionShowcase) {
      const drift = options.reducedMotion ? 0 : Math.sin(seconds * .7);
      companionShowcase.stars.position.y = drift * .045;
      companionShowcase.stars.rotation.z = drift * .018;
    }
    if (response) { response.progress = Math.min(1, (time - response.start) / response.duration); if (response.progress >= 1) response = null; }
    animateCompanion(companion, seconds, response, options.reducedMotion); companion.root.position.y += petPosition.y; companion.root.rotation.y = companionYaw();
    animateWorldStation(station, seconds, options.reducedMotion);
    animateStationAccent(stationAccent, seconds, options.reducedMotion);
    animals.forEach((animal, i) => {
      const chosen = response && (response.target?.id === animal.id || response.target === animal.id), pulse = chosen ? Math.sin(response.progress * Math.PI) : 0;
      animal.root.position.y = animal.baseY + (options.reducedMotion ? 0 : Math.max(0, Math.sin(seconds * 1.7 + i * 2)) * .015 + pulse * (animal.actionUnlocked ? .22 : .10));
      animal.root.rotation.z = options.reducedMotion ? 0 : Math.sin(seconds * 1.35 + i) * .025 + pulse * .10;
      animal.root.rotation.y = animal.baseAngle + (options.reducedMotion ? 0 : Math.sin(seconds * .55 + i) * .13);
    });
    rotors.forEach(rotor => { if (!options.reducedMotion) rotor.rotation.z = seconds * .30; });
    if (sparkle) { sparkle.visible = !!response; sparkle.scale.setScalar(options.reducedMotion ? 1 : .85 + Math.sin((response?.progress || 0) * Math.PI) * .18); }
    world.updateMatrixWorld(true);
    // Reuse the static sun map between subtle character updates. This preserves
    // actual silhouettes and contact shadows while avoiding a full extra pass at 30Hz.
    if (time - lastShadow > 180) { renderer.shadowMap.needsUpdate = true; lastShadow = time; }
    drawCredit(time);
    try { renderer.render(scene, viewCamera); frameCount++; } catch (cause) { fail('FARM_RENDER_FAILED', cause); }
  }
  function drawCredit(time) {
    if (!options.credit.enabled || typeof options.onCreditFrame !== 'function' || creditFailed) return;
    try {
      if (!creditScene) creditScene = createCreditScene(document.createElement('canvas'));
      if (pendingCreditSuccess) { creditScene.pulse(time); pendingCreditSuccess = false; }
      creditScene.render(renderer, time, { ...options.credit, reducedMotion: options.reducedMotion }, frame => safe(options.onCreditFrame, frame));
    } catch (_) {
      // The decorative transfer must never take the interactive farm offline.
      creditScene?.dispose(); creditScene = null; creditFailed = true; pendingCreditSuccess = false; safe(options.onCreditFrame, null);
    }
  }
  function tick(time) {
    raf = 0; if (!canRun()) return;
    if (time - lastFrame >= 1000 / 30 - .5) {
      lastFrame = time - ((time - lastFrame) % (1000 / 30)); draw(time);
      fpsFrames++; if (!fpsStart) fpsStart = time;
      if (time - fpsStart >= 1000) { fps = Math.round(fpsFrames * 1000 / (time - fpsStart)); fpsStart = time; fpsFrames = 0; }
    }
    if (!options.reducedMotion || response || pendingCreditSuccess || creditScene?.hasResponse()) request();
  }
  function select(value, notify = true) {
    selection = value;
    const target = targets.find(t => t.userData.target.type === value?.type && t.userData.target.id === value?.id);
    if (selectionRing) { selectionRing.visible = !!target; if (target) { selectionRing.position.set(target.position.x, .155, target.position.z); selectionRing.scale.setScalar(target.userData.target.type === 'plot' ? 1.48 : .7); } }
    if (target && notify) { react('greet', target.userData.target); safe(options.onSelect, { ...target.userData.target }); }
  }
  function aimPointer(clientX, clientY) {
    if (!ready || !canvas || !viewCamera || disposed || contextLost || manuallyPaused || document.hidden) return false;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height || clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return false;
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, viewCamera); return true;
  }
  function hitsCompanion(clientX, clientY) {
    if (!companion || !aimPointer(clientX, clientY)) return false;
    companion.root.updateMatrixWorld(true);
    return raycaster.intersectObject(companion.root, true).some(hit => {
      for (let node = hit.object; node && node !== companion.root; node = node.parent) {
        if (!node.visible || node.userData.companionDecoration || node === companion.interactions?.root) return false;
      }
      return true;
    });
  }
  function pick(clientX, clientY) {
    if (canRotateCompanion()) { if (hitsCompanion(clientX, clientY)) { select({ type: 'pet', id: 'pet' }); draw(performance.now()); request(); } return; }
    if (!aimPointer(clientX, clientY)) return;
    const hit = raycaster.intersectObjects(targets, false)[0];
    if (hit) { select(hit.object.userData.target); draw(performance.now()); request(); }
  }
  function react(kind, target) {
    if (!disposed && kind === 'earn' && options.credit.enabled && typeof options.onCreditFrame === 'function' && !creditFailed) { pendingCreditSuccess = true; creditScene?.invalidate(); }
    if (disposed || !ready) return;
    const found = targets.find(t => t.userData.target.id === (target?.id || target));
    const look = found ? clamp((found.position.x - petPosition.x) * .08, -.22, .22) : 0;
    const reaction = kind === 'earn' ? 'celebrate' : String(kind || 'greet');
    const durations = { pet: 2200, feed: 2400, wash: 2400, train: 2600, celebrate: 2200, grow: 2400, level: 2400 };
    response = { kind: reaction, target, start: performance.now(), progress: 0, duration: durations[reaction] || (options.reducedMotion ? 650 : 1350), look };
    draw(performance.now()); request();
  }
  function diagnostics() {
    if (world) world.updateMatrixWorld(true);
    const info = renderer?.info;
    return { id, canvasId, mode: options.mode, presentation: options.presentation, ready, webgl: !!renderer && !contextLost, error, disposed,
      paused: manuallyPaused, documentHidden: !!document.hidden, contextLost, running: !!raf,
      fps: canRun() ? fps : 0, frameCount, dpr, width, height,
      drawCalls: info?.render.calls || 0, triangles: info?.render.triangles || 0,
      memory: { geometries: info?.memory.geometries || 0, textures: info?.memory.textures || 0, programs: info?.programs?.length || 0 },
      bodyScreenBounds: bodyScreenBounds(), petScreenBounds: companionScreenBounds(),
      companion: companionState(),
      station: station ? { id: station.id, label: station.label, screenBounds: screenBounds(new THREE.Box3().setFromObject(station.root)), landmarks: station.landmarks.map(item => ({ id: item.id, label: item.label, screenBounds: screenBounds(new THREE.Box3().setFromObject(item.root)) })) } : null,
      hitTargets: targets.map(t => { const b = screenBounds(new THREE.Box3().setFromObject(t)); return { ...t.userData.target, ...b, center: { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 } }; }),
      selected: selection ? { ...selection } : null, reducedMotion: options.reducedMotion, camera: cameraState(), lighting: options.lighting,
      credit: creditScene ? creditScene.diagnostics() : { enabled: false, failed: creditFailed },
      world: companionShowcase ? { width: 120, depth: 120, terrain: 'showcase', platformRadius: companionShowcase.platformRadius, platformTop: companionShowcase.platformTop } : { width: 80, depth: 80, terrain: 'continuous' },
      shadows: { enabled: !!sunlight?.castShadow, type: 'PCFSoftShadowMap', mapSize: sunlight?.shadow.mapSize.x || 0 },
      maxFps: 30, maxDpr: 1.25, externalAssetRequests: 0, contextVersion: renderer ? (renderer.capabilities.isWebGL2 ? 2 : 1) : null
    };
  }
  function dispose() {
    if (disposed) return;
    disposed = true; ready = false; cancelPointer(); companionRotation = 0; stop(); cleanup.forEach(fn => fn()); cleanup.length = 0; resizeObserver?.disconnect(); resizeObserver = null;
    canvas?.remove();
    releaseWorld();
    creditScene?.dispose(); creditScene = null; pendingCreditSuccess = false; safe(options.onCreditFrame, null);
    sunlight?.shadow.map?.dispose(); sunlight?.shadow.mapPass?.dispose(); models?.dispose(); renderer?.renderLists.dispose(); renderer?.dispose();
    // This renderer exclusively owns its canvas. Three r160 retains internal
    // background/depth programs and placeholder textures after dispose(); ending
    // the context releases those too when the host permanently leaves the farm.
    if (!contextLost) renderer?.forceContextLoss?.();
    if (active === controller) active = null; instances.delete(id);
    scene = null; models = null; renderer = null; canvas = null; viewCamera = null; homeCamera = null; yardCamera = null;
    sunlight = null; hemisphere = null; fillLight = null;
  }
  const controller = {
    update(next = {}) {
      if (disposed) return controller;
      const previousPresentation = options.presentation, previousMode = options.mode, previousView = canRotateCompanion(), previousPreview = options.companionView.preview, previousVariant = options.companionView.variant, previousKind = options.pet.kind, previousStage = options.growth.stage;
      options = normalize({ ...options, ...next });
      cancelPointer();
      if (previousPresentation !== options.presentation || previousMode !== options.mode || previousView !== canRotateCompanion() || previousPreview !== options.companionView.preview || previousVariant !== options.companionView.variant || previousKind !== options.pet.kind || previousStage !== options.growth.stage) {
        companionRotation = 0; if (companion) companion.root.rotation.y = companionYaw();
      }
      if (!options.credit.enabled) { creditScene?.dispose(); creditScene = null; pendingCreditSuccess = false; }
      else creditScene?.invalidate();
      if (previousPresentation !== options.presentation) { selection = null; navigation.x = 0; navigation.z = 0; navigation.zoom = 1; navigation.focus = null; }
      describeCanvas();
      try { if (ready) { rebuild(); applyLighting(); fitCamera(); resize(); } } catch (cause) { fail('FARM_UPDATE_FAILED', cause); }
      if (options.reducedMotion && !response && !pendingCreditSuccess && !creditScene?.hasResponse()) stop(); else request();
      safe(options.onStatus, { ...status }); return controller;
    },
    react, resize, camera, focus, rotateCompanion,
    pause(value = true) { manuallyPaused = !!value; if (manuallyPaused) { cancelPointer(); stop(); if (active === controller) active = null; } else { resize(); lastFrame = 0; request(); } return controller; },
    dispose, diagnostics
  };
  instances.set(id, controller);
  if (!element || typeof element.appendChild !== 'function') { fail('FARM_INVALID_ELEMENT'); return controller; }
  try {
    canvas = document.createElement('canvas'); canvas.id = canvasId; canvas.className = 'family-farm-canvas';
    canvas.dataset.familyFarmScene = id; canvas.tabIndex = 0; canvas.setAttribute('role', 'img');
    Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%', touchAction: options.mode === 'expanded' ? 'none' : 'pan-y', cursor: options.mode === 'expanded' ? 'grab' : 'pointer', outlineOffset: '-3px' });
    describeCanvas();
    renderer = new THREE.WebGLRenderer({ canvas, alpha: false, antialias: true, powerPreference: 'high-performance', stencil: false, depth: true });
    renderer.setClearColor(0x90ae75, 1); renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = true;
    scene = new THREE.Scene(); scene.fog = new THREE.Fog(0xa4bba0, 65, 110);
    yardCamera = new THREE.OrthographicCamera(-7, 7, 5, -5, .1, 150);
    homeCamera = new THREE.PerspectiveCamera(38, 1, .1, 150); viewCamera = yardCamera;
    hemisphere = new THREE.HemisphereLight(0xcfe4ed, 0x756344, 1.05); scene.add(hemisphere);
    sunlight = new THREE.DirectionalLight(0xffebc7, 2.7); sunlight.position.set(-15, 22, 11); sunlight.target.position.set(0,0,0); scene.add(sunlight, sunlight.target);
    sunlight.castShadow = true; sunlight.shadow.mapSize.set(2048,2048); sunlight.shadow.bias = -.0002; sunlight.shadow.normalBias = .025; sunlight.shadow.radius = 2;
    Object.assign(sunlight.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 85 }); sunlight.shadow.camera.updateProjectionMatrix();
    fillLight = new THREE.DirectionalLight(0xb7d3df, .25); fillLight.position.set(8, 5, -8); scene.add(fillLight);
    element.appendChild(canvas);
    listen(canvas, 'webglcontextlost', event => {
      event.preventDefault(); cancelPointer(); contextLost = true; ready = false; error = 'FARM_CONTEXT_LOST'; stop();
      // Old GL handles belong to the lost context. Dispose while it is still
      // lost, before Three creates a new generation of geometry/texture caches.
      // Deleting those stale handles after restoration raises INVALID_OPERATION.
      signature = ''; scene.background = null; releaseWorld();
      creditScene?.dispose(); creditScene = null; pendingCreditSuccess = false;
      sunlight.shadow.map?.dispose(); sunlight.shadow.map = null;
      sunlight.shadow.mapPass?.dispose(); sunlight.shadow.mapPass = null;
      safe(options.onCreditFrame, null); emit();
    });
    listen(canvas, 'webglcontextrestored', () => { if (disposed) return; contextLost = false; error = null; lastFrame = 0; creditFailed = false; creditScene?.resetTarget(); renderer.shadowMap.needsUpdate = true; prepareScene(); });
    listen(document, 'visibilitychange', () => { cancelPointer(); if (document.hidden) stop(); else { lastFrame = 0; resize(); request(); } });
    listen(window, 'blur', cancelPointer);
    listen(canvas, 'pointerdown', event => {
      if (!event.isPrimary || (event.button !== undefined && event.button !== 0)) { cancelPointer(); return; }
      cancelPointer();
      if (!aimPointer(event.clientX, event.clientY)) return;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, start: performance.now(), cancelled: false,
        companion: canRotateCompanion() && hitsCompanion(event.clientX, event.clientY), gesture: null };
      if (canPan()) canvas.style.cursor = 'grabbing';
      // Touch keeps its native vertical page pan until a horizontal pet turn
      // wins the gesture. Expanded farm navigation retains full capture.
      if (canPan() || (pointer.companion && event.pointerType !== 'touch')) { try { canvas.setPointerCapture(event.pointerId); } catch (_) {} }
    });
    listen(canvas, 'pointermove', event => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const deltaX = event.clientX - pointer.x, deltaY = event.clientY - pointer.y, distance = Math.hypot(deltaX, deltaY);
      if (distance > 8 && !pointer.cancelled) {
        pointer.cancelled = true;
        if (canRotateCompanion() && pointer.companion) {
          if (Math.abs(deltaX) > Math.abs(deltaY) * 1.2) { pointer.gesture = 'rotate'; canvas.style.cursor = 'grabbing'; try { canvas.setPointerCapture(event.pointerId); } catch (_) {} }
          else { cancelPointer(); return; }
        }
      }
      if (pointer.gesture === 'rotate' && canRotateCompanion()) rotateCompanion({ delta: (event.clientX - pointer.lastX) * Math.PI * 2 / Math.max(240, width) });
      if (pointer.cancelled && canPan()) {
        const dx = event.clientX - pointer.lastX, dy = event.clientY - pointer.lastY, unit = navigation.viewHeight / Math.max(1,height), yaw = navigation.yaw, tilt = cameraDirection.y;
        camera({ panX: (-dx * Math.cos(yaw) - dy * Math.sin(yaw) / tilt) * unit, panZ: (dx * Math.sin(yaw) - dy * Math.cos(yaw) / tilt) * unit });
      }
      pointer.lastX = event.clientX; pointer.lastY = event.clientY;
    });
    listen(canvas, 'pointerup', event => {
      const p = pointer; if (!p || p.id !== event.pointerId) return; cancelPointer();
      if (!p.cancelled && performance.now() - p.start < 650 && Math.hypot(event.clientX - p.x, event.clientY - p.y) <= 8) pick(event.clientX, event.clientY);
    });
    listen(canvas, 'pointercancel', cancelPointer);
    listen(canvas, 'lostpointercapture', event => { if (pointer?.id === event.pointerId) cancelPointer(); });
    listen(canvas, 'wheel', event => { if (canPan()) { event.preventDefault(); camera({ zoomBy: Math.exp(-event.deltaY * .0015) }); } }, { passive: false });
    listen(canvas, 'keydown', event => {
      if (!ready || disposed || manuallyPaused || contextLost || document.hidden) return;
      const actions = { ArrowLeft: {panX:-.6}, ArrowRight: {panX:.6}, ArrowUp: {panZ:-.6}, ArrowDown: {panZ:.6}, '+': {zoomBy:1.2}, '=': {zoomBy:1.2}, '-': {zoomBy:1/1.2}, Home: {reset:true} };
      if (canPan() && actions[event.key]) { event.preventDefault(); camera(actions[event.key]); }
      else if (canRotateCompanion() && ['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) { event.preventDefault(); rotateCompanion(event.key === 'Home' ? { reset: true } : { delta: (event.key === 'ArrowLeft' ? -1 : 1) * Math.PI / 8 }); }
      else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(station ? { type: 'destination', id: station.id } : { type:'pet',id:'pet' }); request(); }
    });
    if (typeof ResizeObserver !== 'undefined') { resizeObserver = new ResizeObserver(resize); resizeObserver.observe(element); } else listen(window, 'resize', resize);
    resize(); emit();
    loadModels().then(result => {
      if (disposed) { result.dispose(); return; } models = result;
      prepareScene();
    }).catch(cause => { if (!disposed) fail('FARM_ASSET_FAILED', cause); });
  } catch (cause) { canvas?.remove(); renderer?.dispose(); renderer = null; fail('FARM_WEBGL_UNAVAILABLE', cause); }
  return controller;
}
export function diagnostics() {
  const current = Array.from(instances.values()).map(c => c.diagnostics());
  return { version: '1.2.0', threeRevision: THREE.REVISION, activeCount: current.filter(c => c.running).length, canvasCount: typeof document !== 'undefined' ? document.querySelectorAll('canvas[data-family-farm-scene]').length : 0, instances: current };
}
export const version = '1.2.0';
