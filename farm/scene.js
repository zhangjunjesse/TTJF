import * as THREE from 'three';
import { Workshop, group } from './primitives.js';
import { makeCompanion, animateCompanion } from './companions.js';
import { makeTerrain, makeDecoration, makePlot, cropPhase, PLOT_POSITIONS, SLOT_POSITIONS } from './garden.js';
import { makeEnvironment, HOUSE_POSITION, PET_POSITION, ANIMAL_POSITIONS } from './world-environment.js';
import { loadModels } from './models.js';
import { addWindowGlow, makeNightLights } from './world-lighting.js';
import { WORLD_STATIONS, normalizePresentation, makeWorldStation, animateWorldStation } from './world-stations.js';

// Rendering only. FamilyModel owns all economy, maturity, unlocks and storage.
const instances = new Map();
let nextId = 0, active = null;
const safe = (fn, value) => { try { if (typeof fn === 'function') fn(value); } catch (_) {} };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const normalize = options => ({
  mode: options?.mode === 'expanded' ? 'expanded' : 'home', lighting: options?.lighting === 'night' ? 'night' : 'day',
  presentation: normalizePresentation(options?.presentation),
  farm: options?.farm || {}, pet: options?.pet || { kind: 'plant', name: '芽芽' },
  growth: options?.growth || { stage: 1, stars: 0, xp: 0 },
  reducedMotion: !!options?.reducedMotion, onSelect: options?.onSelect, onStatus: options?.onStatus,
  viewInsets: { top: Math.max(0, Number(options?.viewInsets?.top) || 0), right: Math.max(0, Number(options?.viewInsets?.right) || 0), bottom: Math.max(0, Number(options?.viewInsets?.bottom) || 0), left: Math.max(0, Number(options?.viewInsets?.left) || 0) }
});
function visualSignature(options) {
  const farm = options.farm;
  if (options.presentation !== 'farm') return JSON.stringify({ presentation: options.presentation, kind: options.pet.kind, stage: options.growth.stage, stars: Math.min(1, options.growth.stars || 0) });
  return JSON.stringify({ presentation: 'farm', initialized: farm.initialized,
    plots: (farm.plots || []).slice(0, 6).map(p => ({ id: p.id, index: p.index, unlocked: p.unlocked, cropId: p.cropId, status: p.status, plantedAt: p.plantedAt, readyAt: p.readyAt, phase: cropPhase(p) })),
    houseLevel: farm.houseLevel, placements: farm.placements,
    animals: (farm.animals || []).map(a => ({ id: a.id, unlocked: a.unlocked, caredToday: a.caredToday, actionUnlocked: a.actionUnlocked })),
    kind: options.pet.kind, stage: options.growth.stage, stars: Math.min(1, options.growth.stars || 0)
  });
}
export function mount(element, initialOptions = {}) {
  const id = 'family-farm-' + (++nextId), canvasId = id + '-canvas';
  let options = normalize(initialOptions), renderer = null, canvas = null, scene = null, viewCamera = null, homeCamera = null, yardCamera = null, sunlight = null, hemisphere = null, fillLight = null, nightLights = null;
  const nightUniform = { value: 0 };
  let models = null, world = null, workshop = null, station = null, companion = null, animals = [], rotors = [], targets = [];
  let response = null, selection = null, selectionRing = null, sparkle = null;
  let ready = false, error = null, disposed = false, contextLost = false, manuallyPaused = false;
  let raf = 0, lastFrame = 0, lastShadow = 0, frameCount = 0, fpsStart = 0, fpsFrames = 0, fps = 0, width = 0, height = 0, dpr = 1;
  let signature = '', resizeObserver = null, pointer = null, clockStart = performance.now();
  let status = { ready: false, webgl: false, error: null };
  const cleanup = [], raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const petPosition = new THREE.Vector3(PET_POSITION[0], .025, PET_POSITION[1]);
  const cameraDirection = new THREE.Vector3(), cameraTarget = new THREE.Vector3();
  const navigation = { x: 0, z: 0, zoom: 1, yaw: .50, viewHeight: 18, focus: null };
  const canPan = () => options.presentation === 'farm' && options.mode === 'expanded';
  function describeCanvas() {
    if (!canvas) return;
    const label = WORLD_STATIONS[options.presentation];
    canvas.dataset.presentation = options.presentation;
    canvas.style.touchAction = canPan() ? 'none' : 'pan-y'; canvas.style.cursor = canPan() ? 'grab' : 'pointer';
    canvas.setAttribute('role', label ? 'button' : 'img');
    canvas.setAttribute('aria-label', label ? `${label}，农场风格三维场景；点击或按回车打开地点` : `${options.pet.name || '伙伴'}的农场，点击田地或伙伴；展开后可拖动浏览`);
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
  function bodyScreenBounds() {
    if (!companion || !viewCamera || !canvas) return null;
    const r = canvas.getBoundingClientRect(), vertex = new THREE.Vector3(), points = companion.bodyPoints;
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (let i = 0; i < points.length; i += 3) {
      vertex.set(points[i], points[i + 1], points[i + 2]).applyMatrix4(companion.root.matrixWorld).project(viewCamera);
      const x = r.left + (vertex.x + 1) * r.width / 2, y = r.top + (1 - vertex.y) * r.height / 2;
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    return { x: left, y: top, width: right - left, height: bottom - top, left, top, right, bottom };
  }
  function addTarget(type, targetId, x, y, z, sx, sy, sz) {
    const geo = workshop.geometry('hitbox', () => new THREE.BoxGeometry(1, 1, 1));
    const mat = workshop.material(0xffffff, { visible: false });
    const mesh = new THREE.Mesh(geo, mat); mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz);
    mesh.userData.target = { type, id: targetId }; world.add(mesh); targets.push(mesh); return mesh;
  }
  function rebuild() {
    if (!models || disposed) return;
    const nextSignature = visualSignature(options); if (signature === nextSignature && world) return;
    signature = nextSignature;
    if (world) { scene.remove(world); workshop.dispose(); renderer.renderLists.dispose(); }
    workshop = new Workshop(); world = group(scene); station = null; targets = []; animals = []; rotors = [];
    selectionRing = null; sparkle = null; response = null;
    const farm = options.farm;
    world.add(makeTerrain(workshop)); world.add(makeEnvironment(workshop, models, options.presentation === 'farm' ? farm : {}));
    let houseLevel = 0;
    if (options.presentation === 'farm') {
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
      petPosition.set(...station.companionPosition);
      addTarget('destination', station.id, station.root.position.x + .3, 1.85, station.root.position.z - .45, 5.6, 3.7, 2.8);
    }
    companion = makeCompanion(workshop, options.pet.kind, clamp(Math.floor(options.growth.stage || 1), 1, 5), options.growth.stars || 0);
    companion.root.position.copy(petPosition); companion.root.scale.setScalar(station ? station.companionScale : .72); companion.root.rotation.y = .15; world.add(companion.root);
    companion.root.traverse(mesh => { if (mesh.isMesh) { mesh.castShadow = !mesh.material.transparent && !mesh.userData.noShadow; mesh.receiveShadow = !mesh.userData.noShadow; } });
    addTarget(station ? 'destination' : 'pet', station ? 'companion' : 'pet', petPosition.x, 1.1, petPosition.z, 1.55, 2.2, 1.35);
    selectionRing = workshop.ring(world, 0xf1cc67, [0, .15, 0], .70, .035, [Math.PI / 2, 0, 0]); selectionRing.visible = false; selectionRing.castShadow = false;
    sparkle = group(world); sparkle.visible = false;
    for (let i = 0; i < 7; i++) { const a = i * Math.PI * 2 / 7; workshop.star(sparkle, i % 2 ? 0xffe5a8 : 0xf2be80, [Math.cos(a) * .82, 1.20 + Math.sin(a) * .55, Math.sin(a) * .3], .07 + (i % 2) * .025); }
    workshop.bake(sparkle); sparkle.position.copy(petPosition); sparkle.traverse(m => { if (m.isMesh) m.castShadow = false; });
    nightLights = makeNightLights(workshop, world, houseLevel > 0);
    if (station) { const light = new THREE.PointLight(0xffbc63, 5, 7, 2); light.position.set(station.root.position.x + .3, 1.8, station.root.position.z + 1.2); nightLights.add(light); }
    applyLighting();
    renderer.shadowMap.needsUpdate = true;
    world.updateMatrixWorld(true); fitCamera(); select(selection, false); draw(performance.now());
  }
  function applyLighting() {
    if (!sunlight || !hemisphere || !fillLight) return;
    const night = options.lighting === 'night', changed = nightUniform.value !== (night ? 1 : 0);
    nightUniform.value = night ? 1 : 0;
    if (nightLights) nightLights.visible = night;
    hemisphere.color.set(night ? 0x879bce : 0xcfe4ed); hemisphere.groundColor.set(night ? 0x253e44 : 0x756344); hemisphere.intensity = night ? .9 : 1.05;
    sunlight.color.set(night ? 0x91b2ec : 0xffebc7); sunlight.intensity = night ? .82 : 2.7;
    sunlight.position.set(night ? -8 : -15, night ? 18 : 22, night ? -12 : 11);
    fillLight.color.set(night ? 0x829ed1 : 0xb7d3df); fillLight.intensity = night ? .65 : .25;
    fillLight.position.set(night ? -3 : 8, night ? 7 : 5, night ? 10 : -8);
    scene.fog.color.set(night ? 0x19333c : 0xa4bba0); renderer.setClearColor(night ? 0x19333c : 0x90ae75, 1);
    renderer.toneMappingExposure = night ? 1.05 : 1.05;
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
      const bounds = new THREE.Box3().setFromObject(station.root).union(new THREE.Box3().setFromObject(companion.root));
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
      cameraDirection.set(.22, .36, 1).normalize();
      const bodyHeight = (companion.bodyBounds.max.y - companion.bodyBounds.min.y) * .72;
      // Short dashboard cards need a tighter portrait: preserve the same physical
      // model scale while bringing the camera closer to its anatomical centre.
      const compactHome = height < 180;
      viewHeight = Math.max(compactHome ? 0 : 3.2, bodyHeight / (compactHome ? .72 : .58));
      const bodyWidth = (companion.bodyBounds.max.x - companion.bodyBounds.min.x) * .72;
      viewHeight = Math.max(viewHeight, bodyWidth / Math.max(.42, aspect * .74));
      cameraTarget.set(petPosition.x + clamp((aspect - .85) * .20, 0, .3), bodyHeight * .57, petPosition.z - .02);
      homeCamera.aspect = aspect;
      const distance = viewHeight / (2 * Math.tan(THREE.MathUtils.degToRad(homeCamera.fov) / 2));
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
  function resize() {
    if (disposed || !renderer || !element) return;
    const rect = element.getBoundingClientRect(); width = Math.max(0, Math.round(rect.width)); height = Math.max(0, Math.round(rect.height));
    if (!width || !height) { stop(); return; }
    dpr = Math.min(1.25, Math.max(1, window.devicePixelRatio || 1));
    if (renderer.getPixelRatio() !== dpr) renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false); fitCamera(); draw(performance.now()); request();
  }
  function draw(time) {
    if (disposed || manuallyPaused || document.hidden || !element?.isConnected || !renderer || !scene || !viewCamera || !world || contextLost || !width || !height) return;
    const seconds = (time - clockStart) / 1000;
    if (response) { response.progress = Math.min(1, (time - response.start) / response.duration); if (response.progress >= 1) response = null; }
    animateCompanion(companion, options.reducedMotion ? 0 : seconds, response, options.reducedMotion); companion.root.position.y += petPosition.y;
    animateWorldStation(station, seconds, options.reducedMotion);
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
    try { renderer.render(scene, viewCamera); frameCount++; } catch (cause) { fail('FARM_RENDER_FAILED', cause); }
  }
  function tick(time) {
    raf = 0; if (!canRun()) return;
    if (time - lastFrame >= 1000 / 30 - .5) {
      lastFrame = time - ((time - lastFrame) % (1000 / 30)); draw(time);
      fpsFrames++; if (!fpsStart) fpsStart = time;
      if (time - fpsStart >= 1000) { fps = Math.round(fpsFrames * 1000 / (time - fpsStart)); fpsStart = time; fpsFrames = 0; }
    }
    if (!options.reducedMotion || response) request();
  }
  function select(value, notify = true) {
    selection = value;
    const target = targets.find(t => t.userData.target.type === value?.type && t.userData.target.id === value?.id);
    if (selectionRing) { selectionRing.visible = !!target; if (target) { selectionRing.position.set(target.position.x, .155, target.position.z); selectionRing.scale.setScalar(target.userData.target.type === 'plot' ? 1.48 : .7); } }
    if (target && notify) { safe(options.onSelect, { ...target.userData.target }); react('greet', target.userData.target); }
  }
  function pick(clientX, clientY) {
    if (!ready || !canvas) return;
    const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, viewCamera); const hit = raycaster.intersectObjects(targets, false)[0];
    if (hit) { select(hit.object.userData.target); draw(performance.now()); request(); }
  }
  function react(kind, target) {
    if (disposed || !ready) return;
    const found = targets.find(t => t.userData.target.id === (target?.id || target));
    const look = found ? clamp((found.position.x - petPosition.x) * .08, -.22, .22) : 0;
    response = { kind: String(kind || 'greet'), target, start: performance.now(), progress: 0, duration: options.reducedMotion ? 650 : 1350, look };
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
      bodyScreenBounds: bodyScreenBounds(), petScreenBounds: companion ? screenBounds(new THREE.Box3().setFromObject(companion.root)) : null,
      station: station ? { id: station.id, label: station.label, screenBounds: screenBounds(new THREE.Box3().setFromObject(station.root)), landmarks: station.landmarks.map(item => ({ id: item.id, label: item.label, screenBounds: screenBounds(new THREE.Box3().setFromObject(item.root)) })) } : null,
      hitTargets: targets.map(t => { const b = screenBounds(new THREE.Box3().setFromObject(t)); return { ...t.userData.target, ...b, center: { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 } }; }),
      selected: selection ? { ...selection } : null, reducedMotion: options.reducedMotion, camera: cameraState(), lighting: options.lighting,
      world: { width: 80, depth: 80, terrain: 'continuous' }, shadows: { enabled: !!sunlight?.castShadow, type: 'PCFSoftShadowMap', mapSize: sunlight?.shadow.mapSize.x || 0 },
      maxFps: 30, maxDpr: 1.25, externalAssetRequests: 0, contextVersion: renderer ? (renderer.capabilities.isWebGL2 ? 2 : 1) : null
    };
  }
  function dispose() {
    if (disposed) return;
    disposed = true; ready = false; stop(); cleanup.forEach(fn => fn()); resizeObserver?.disconnect();
    if (canvas) { try { canvas.releasePointerCapture(pointer?.id); } catch (_) {} canvas.remove(); }
    pointer = null;
    if (world) { scene.remove(world); workshop?.dispose(); }
    sunlight?.shadow.map?.dispose(); models?.dispose(); renderer?.renderLists.dispose(); renderer?.dispose();
    if (active === controller) active = null; instances.delete(id);
    world = null; station = null; companion = null; animals = []; targets = []; rotors = []; scene = null; models = null;
  }
  const controller = {
    update(next = {}) {
      if (disposed) return controller;
      const previousPresentation = options.presentation;
      options = normalize({ ...options, ...next });
      if (previousPresentation !== options.presentation) { selection = null; navigation.x = 0; navigation.z = 0; navigation.zoom = 1; navigation.focus = null; }
      describeCanvas();
      try { if (ready) { rebuild(); applyLighting(); fitCamera(); resize(); } } catch (cause) { fail('FARM_UPDATE_FAILED', cause); }
      if (options.reducedMotion && !response) stop(); else request();
      safe(options.onStatus, { ...status }); return controller;
    },
    react, resize, camera, focus,
    pause(value = true) { manuallyPaused = !!value; if (manuallyPaused) { stop(); if (active === controller) active = null; } else { resize(); lastFrame = 0; request(); } return controller; },
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
    listen(canvas, 'webglcontextlost', event => { event.preventDefault(); contextLost = true; ready = false; error = 'FARM_CONTEXT_LOST'; stop(); emit(); });
    listen(canvas, 'webglcontextrestored', () => { if (disposed) return; contextLost = false; error = null; lastFrame = 0; renderer.shadowMap.needsUpdate = true; prepareScene(); });
    listen(document, 'visibilitychange', () => { if (document.hidden) stop(); else { lastFrame = 0; resize(); request(); } });
    listen(canvas, 'pointerdown', event => {
      if (!event.isPrimary || (event.button !== undefined && event.button !== 0)) { if (pointer) pointer.cancelled = true; return; }
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, start: performance.now(), cancelled: false };
      if (canPan()) canvas.style.cursor = 'grabbing';
      try { canvas.setPointerCapture(event.pointerId); } catch (_) {}
    });
    listen(canvas, 'pointermove', event => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const distance = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y);
      if (distance > 8) pointer.cancelled = true;
      if (pointer.cancelled && canPan()) {
        const dx = event.clientX - pointer.lastX, dy = event.clientY - pointer.lastY, unit = navigation.viewHeight / Math.max(1,height), yaw = navigation.yaw, tilt = cameraDirection.y;
        camera({ panX: (-dx * Math.cos(yaw) - dy * Math.sin(yaw) / tilt) * unit, panZ: (dx * Math.sin(yaw) - dy * Math.cos(yaw) / tilt) * unit });
      }
      pointer.lastX = event.clientX; pointer.lastY = event.clientY;
    });
    listen(canvas, 'pointerup', event => {
      const p = pointer; if (!p || p.id !== event.pointerId) return; pointer = null; canvas.style.cursor = canPan() ? 'grab' : 'pointer';
      try { canvas.releasePointerCapture(event.pointerId); } catch (_) {}
      if (!p.cancelled && performance.now() - p.start < 650 && Math.hypot(event.clientX - p.x, event.clientY - p.y) <= 8) pick(event.clientX, event.clientY);
    });
    listen(canvas, 'pointercancel', () => { pointer = null; canvas.style.cursor = canPan() ? 'grab' : 'pointer'; });
    listen(canvas, 'lostpointercapture', () => { pointer = null; });
    listen(canvas, 'wheel', event => { if (canPan()) { event.preventDefault(); camera({ zoomBy: Math.exp(-event.deltaY * .0015) }); } }, { passive: false });
    listen(canvas, 'keydown', event => {
      const actions = { ArrowLeft: {panX:-.6}, ArrowRight: {panX:.6}, ArrowUp: {panZ:-.6}, ArrowDown: {panZ:.6}, '+': {zoomBy:1.2}, '=': {zoomBy:1.2}, '-': {zoomBy:1/1.2}, Home: {reset:true} };
      if (canPan() && actions[event.key]) { event.preventDefault(); camera(actions[event.key]); }
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
