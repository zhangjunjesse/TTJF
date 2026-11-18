'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modules = Promise.all([
  import('three'),
  import(pathToFileURL(path.join(__dirname, '..', 'farm', 'primitives.js')).href),
  import(pathToFileURL(path.join(__dirname, '..', 'farm', 'companions.js')).href)
]);
const actions = { pet: 'affection', feed: 'snack', wash: 'wash', train: 'ball', celebrate: 'celebration' };
const effectNames = ['affection', 'snack', 'crumbs', 'wash', 'ball', 'celebration'];

async function fixture(t, kind, stage) {
  const [THREE, { Workshop }, { makeCompanion, animateCompanion }] = await modules;
  const workshop = new Workshop(), pet = makeCompanion(workshop, kind, stage, 1);
  t.after(() => workshop.dispose());
  assert.ok(pet.root instanceof THREE.Group, 'tests exercise real Three.js scene objects');
  pet.root.position.set(3, 7, -2); pet.root.rotation.y = 1.15;
  return { THREE, workshop, pet, animate: (seconds, response, reducedMotion = false) => animateCompanion(pet, seconds, response, reducedMotion) };
}

function transforms(root) {
  const rows = [];
  root.traverse(node => {
    rows.push([...node.position.toArray(), ...node.quaternion.toArray(), ...node.scale.toArray(), node.visible]);
  });
  return rows;
}

function bodyPose(pet) {
  return [pet.body, pet.head, ...pet.limbs, ...pet.wings, ...pet.eyes, ...(pet.tail ? [pet.tail] : [])]
    .map(node => [...node.position.toArray(), ...node.quaternion.toArray(), ...node.scale.toArray()]);
}

function anatomy(pet) {
  return { points: new Float32Array(pet.bodyPoints), min: pet.bodyBounds.min.toArray(), max: pet.bodyBounds.max.toArray(), count: pet.anatomyVertexCount };
}

function assertPlacement(pet) {
  assert.equal(pet.root.rotation.y, 1.15, 'care preserves the yaw chosen by the renderer');
  assert.equal(pet.root.position.x, 3); assert.equal(pet.root.position.z, -2);
}

function assertEffect(pet, action) {
  const props = pet.interactions, expected = actions[action];
  assert.equal(props.action, action);
  assert.equal(props.root.visible, true);
  assert.equal(props[expected].visible, true, action + ' shows its own prop');
  for (const name of effectNames) {
    if (name !== expected && !(action === 'feed' && name === 'crumbs')) assert.equal(props[name].visible, false, action + ' clears ' + name);
  }
  let meshes = 0;
  props[expected].traverseVisible(node => { if (node.isMesh) meshes++; });
  assert.ok(meshes > 0, 'the action cue contains drawable geometry');
  for (const row of transforms(pet.root)) assert.ok(row.slice(0, -1).every(Number.isFinite), action + ' has finite transforms');
  assertPlacement(pet);
}

function resources(root) {
  const nodes = new Set(), geometries = new Set(), materials = new Set();
  root.traverse(node => {
    nodes.add(node);
    if (node.geometry) geometries.add(node.geometry);
    if (node.material) for (const material of Array.isArray(node.material) ? node.material : [node.material]) materials.add(material);
  });
  return { nodes, geometries, materials };
}

function assertSameMembers(actual, expected, label) {
  assert.equal(actual.size, expected.size, label + ' count is stable across frames');
  for (const resource of actual) assert.ok(expected.has(resource), label + ' identities are reused');
}

function assertSameResources(actual, expected) {
  for (const key of ['nodes', 'geometries', 'materials']) assertSameMembers(actual[key], expected[key], key);
}

for (const kind of ['plant', 'capybara']) for (let stage = 1; stage <= 5; stage++) {
  const label = kind + ' stage ' + stage;

  test(label + ': care actions have distinct cues and poses, and replacement/completion restores the model', async t => {
    const { THREE, pet, animate } = await fixture(t, kind, stage);
    animate(3, null);
    const original = anatomy(pet), idle = transforms(pet.root), poses = new Set();
    const measured = new THREE.Box3(), point = new THREE.Vector3();
    for (let i = 0; i < pet.bodyPoints.length; i += 3) measured.expandByPoint(point.fromArray(pet.bodyPoints, i));
    assert.ok(measured.min.distanceTo(pet.bodyBounds.min) < 1e-6 && measured.max.distanceTo(pet.bodyBounds.max) < 1e-6);
    assert.equal(pet.anatomyVertexCount, pet.bodyPoints.length / 3);

    // Consecutive calls deliberately replace an active action without an idle
    // frame, so a previous snack, bubble or pose cannot linger into the next.
    for (const action of Object.keys(actions)) {
      animate(3, { kind: action, progress: .52, look: .12 });
      assertEffect(pet, action);
      poses.add(JSON.stringify(bodyPose(pet)));
      assert.deepEqual(anatomy(pet), original, 'care does not change the stored anatomy projection');
    }
    assert.equal(poses.size, Object.keys(actions).length, 'body responses differ even without their props');

    for (const action of Object.keys(actions)) {
      animate(3, { kind: action, progress: .55 });
      animate(3, null);
      assert.deepEqual(transforms(pet.root), idle, action + ' clears all changed transforms and props');
      animate(3, { kind: action, progress: .55 });
      animate(3, { kind: action, progress: 1 });
      assert.deepEqual(transforms(pet.root), idle, action + ' also resets at its completed progress');
    }
    assert.deepEqual(anatomy(pet), original);
  });

  test(label + ': reduced motion keeps each care cue static and clears it on completion', async t => {
    const { pet, animate } = await fixture(t, kind, stage);
    animate(0, null, true);
    const idle = transforms(pet.root);
    for (const action of Object.keys(actions)) {
      animate(0, { kind: action, progress: 0 }, true);
      assertEffect(pet, action);
      const cue = transforms(pet.root);
      animate(17, { kind: action, progress: .4 }, true);
      assert.deepEqual(transforms(pet.root), cue, action + ' does not oscillate with time or progress');
      animate(43, { kind: action, progress: .9 }, true);
      assert.deepEqual(transforms(pet.root), cue);
      assert.equal(pet.root.position.y, 0, 'reduced motion does not bounce');
      animate(0, { kind: action, progress: 1 }, true);
      assert.deepEqual(transforms(pet.root), idle, 'completed static cue disappears');
      animate(0, { kind: action, progress: .5 }, true);
      animate(0, null, true);
      assert.deepEqual(transforms(pet.root), idle, 'response removal also clears the cue');
    }
    assert.ok(pet.eyes.every(eye => eye.scale.y === 1), 'reduced-motion idle restores open eyes');
  });

  test(label + ': repeated care frames reuse scene resources and Workshop releases all owned resources', async t => {
    const { workshop, pet, animate } = await fixture(t, kind, stage);
    const before = resources(pet.root), owned = { geometries: new Set(workshop.geometries), materials: new Set(workshop.materials), textures: new Set(workshop.textures) };
    for (const geometry of before.geometries) assert.ok(owned.geometries.has(geometry), 'scene geometry is owned by Workshop');
    for (const material of before.materials) assert.ok(owned.materials.has(material), 'scene material is owned by Workshop');
    const names = Object.keys(actions);
    for (let frame = 0; frame < 200; frame++) {
      animate(frame / 30, { kind: names[frame % names.length], progress: (frame % 100) / 100 }, frame % 7 === 0);
      assertPlacement(pet);
    }
    assertSameResources(resources(pet.root), before);
    for (const key of ['geometries', 'materials', 'textures']) assertSameMembers(workshop[key], owned[key], key);
    const disposals = new Map();
    for (const resource of [...owned.geometries, ...owned.materials, ...owned.textures]) {
      disposals.set(resource, 0);
      resource.addEventListener('dispose', () => disposals.set(resource, disposals.get(resource) + 1));
    }
    workshop.dispose(); workshop.dispose();
    for (const count of disposals.values()) assert.equal(count, 1, 'each owned resource is disposed exactly once');
    assert.equal(workshop.geometries.size, 0); assert.equal(workshop.materials.size, 0); assert.equal(workshop.textures.size, 0);
  });
}

test('feeding approaches the posed muzzle; ball play and growth remain distinct from legacy yard acknowledgement', async t => {
  const { pet, animate } = await fixture(t, 'capybara', 5);
  animate(0, { kind: 'feed', progress: .10 });
  const early = pet.interactions.snack.position.distanceTo(pet.interactions.mouth);
  animate(0, { kind: 'feed', progress: .44 });
  assert.ok(pet.interactions.snack.position.distanceTo(pet.interactions.mouth) < early, 'food moves toward the muzzle');
  const full = pet.interactions.snack.scale.x;
  animate(0, { kind: 'feed', progress: .74 });
  assert.ok(pet.interactions.snack.scale.x < full, 'food gets eaten');
  animate(0, { kind: 'train', progress: .20 });
  const ball = pet.interactions.ball.position.clone(), paws = pet.limbs.map(arm => arm.quaternion.toArray());
  animate(0, { kind: 'train', progress: .60 });
  assert.ok(ball.distanceTo(pet.interactions.ball.position) > .05, 'play ball moves');
  assert.notDeepEqual(pet.limbs.map(arm => arm.quaternion.toArray()), paws, 'paws respond during ball play');
  for (const kind of ['harvest', 'grow', 'level', 'points', 'upgrade', 'unlock', 'earn']) {
    animate(5.21, { kind, progress: .5 });
    assert.equal(pet.interactions.action, 'celebrate');
    assert.equal(pet.interactions.celebration.visible, true);
    assert.ok(pet.eyes.every(eye => eye.scale.y < .1), 'existing blink remains at its apex');
  }
  animate(0, { kind: 'care', progress: .5 });
  assert.equal(pet.interactions.root.visible, false, 'legacy animal care has no home care prop');
  assert.ok(pet.limbs.some(arm => Math.abs(arm.rotation.z) > .1), 'legacy yard acknowledgement remains visible');
});

test('forest-bud life visits all awake gestures, rests between them, then wakes with a stretch', async () => {
  const { createPetLife } = await import(pathToFileURL(path.join(__dirname, '..', 'farm', 'forest-bud', 'pet-life.js')).href);
  const life = createPetLife(() => .25), transitions = [];
  let previous = '';
  for (let tick = 0; tick <= 1800; tick++) {
    const pose = life.update(tick / 10, false);
    if (pose.kind !== previous) { transitions.push(pose.kind); previous = pose.kind; }
    assert.ok(Number.isFinite(pose.phase) && pose.phase >= 0 && pose.phase <= 1);
    assert.ok(Number.isFinite(pose.weight) && pose.weight >= 0 && pose.weight <= 1);
  }
  for (const kind of ['look', 'sniff', 'groom', 'stretch', 'doze']) assert.ok(transitions.includes(kind), kind + ' occurs autonomously');
  for (let i = 1; i < transitions.length; i++) assert.ok(transitions[i] === 'rest' || transitions[i - 1] === 'rest', 'a quiet interval separates gestures');
  const nap = transitions.indexOf('doze');
  assert.deepEqual(transitions.slice(nap, nap + 3), ['doze', 'rest', 'stretch'], 'waking is followed by a stretch');
});

test('forest-bud life attention fades the current nap, reduced motion rests, and directors do not share a clock', async () => {
  const { createPetLife } = await import(pathToFileURL(path.join(__dirname, '..', 'farm', 'forest-bud', 'pet-life.js')).href);
  const first = createPetLife(() => .25), second = createPetLife(() => .25);
  let now = 0, sleepy;
  for (; now < 100; now += .1) {
    const pose = first.update(now, false);
    if (pose.kind === 'doze' && pose.weight > .8) { sleepy = { ...pose }; break; }
  }
  assert.ok(sleepy, 'the isolated director reaches a nap');
  assert.deepEqual(second.update(0, false), {kind:'rest',phase:0,weight:0,side:1}, 'another director remains at its own start');
  first.attend(now);
  assert.ok(first.update(now + .12, false, true).weight < sleepy.weight, 'attention fades the sleeping pose');
  assert.equal(first.update(now + .3, false, true).kind, 'rest');
  assert.equal(first.update(now + 20, true).kind, 'rest', 'reduced motion cannot start an autonomous gesture');
  assert.equal(first.update(now + 20, false).kind, 'rest', 'leaving reduced motion gives the pet a fresh quiet interval');
});

test('forest-bud autonomous body and eyes wake for real care, recover, and leave another companion untouched', async t => {
  const [THREE, { Workshop }, { makeCompanion, animateCompanion }] = await modules;
  const workshop = new Workshop(), pet = makeCompanion(workshop, 'plant', 1);
  const other = makeCompanion(workshop, 'plant', 1);
  t.after(() => { pet.dispose(); other.dispose(); workshop.dispose(); });
  animateCompanion(other, 0, null, true);
  const quietOther = transforms(other.root), before = resources(pet.root);
  let napAt = null;
  for (let tick = 0; tick < 650; tick++) {
    const seconds = tick / 10;
    animateCompanion(pet, seconds, null, false);
    if (pet.activity.kind === 'doze' && pet.activity.weight > .7) { napAt = seconds; break; }
  }
  assert.notEqual(napAt, null, 'the product rig reaches its own sleepy pose');
  assert.ok(pet.eyes.some(eye => eye.userData.openness < .75), 'the real lids close while dozing');
  const greeting = {kind:'greet',progress:.1,start:1};
  animateCompanion(pet, napAt + .1, greeting, false);
  greeting.progress = .55; animateCompanion(pet, napAt + .4, greeting, false);
  assert.equal(pet.interactions.action, 'pet', 'touch produces the product greeting cue');
  assert.equal(pet.activity.kind, 'rest', 'attention releases the nap instead of holding closed eyes');
  // A normal blink may coincide with the wake-up frame. Observe the greeting
  // over that short blink window instead of requiring an unblinking animal.
  let openEyes = false;
  for (let frame = 0; frame < 9; frame++) {
    greeting.progress = .55 + frame * .025;
    animateCompanion(pet, napAt + .4 + frame * .05, greeting, false);
    openEyes ||= pet.eyes.every(eye => eye.userData.openness > .6);
  }
  assert.ok(openEyes, 'awake greeting reopens the real lids');
  const feed = {kind:'feed',progress:.44,start:2};
  animateCompanion(pet, napAt + 1, feed, false);
  pet.root.updateWorldMatrix(true, true);
  const mouth = pet.anchors.mouth.getWorldPosition(new THREE.Vector3()); pet.root.worldToLocal(mouth);
  assert.ok(pet.interactions.mouth.distanceTo(mouth) < 1e-6, 'snack follows the real posed muzzle through neck and stage transforms');
  assert.ok(pet.interactions.snack.position.distanceTo(mouth) < .01, 'snack reaches that muzzle');
  animateCompanion(pet, napAt + 1.1, null, true);
  const reduced = transforms(pet.root);
  animateCompanion(pet, napAt + 20, null, true);
  assert.deepEqual(transforms(pet.root), reduced, 'the whole living rig remains still with reduced motion');
  assert.equal(pet.interactions.root.visible, false, 'care completion clears its cue');
  assert.deepEqual(transforms(other.root), quietOther, 'another companion has no shared pose or response state');
  assertSameResources(resources(pet.root), before);
});

test('forest-bud dynamic measurements use deformed tail vertices and release owned skeleton textures exactly once', async t => {
  const [THREE, { Workshop }, { makeCompanion, animateCompanion }] = await modules;
  const workshop = new Workshop(), pet = makeCompanion(workshop, 'plant', 3);
  t.after(() => { pet.dispose(); workshop.dispose(); });
  const profile = pet.frameProfile;
  assert.ok(profile.bounds instanceof THREE.Box3 && !profile.bounds.isEmpty());
  assert.ok(Array.from(profile.points).every(Number.isFinite));
  pet.root.scale.setScalar(.72); pet.root.rotation.y = -.66;
  const beforeRender = pet.measurePoints(false).slice();
  pet.root.updateMatrixWorld(true);
  const afterRender = pet.measurePoints(false);
  assert.equal(beforeRender.length, afterRender.length);
  assert.ok(beforeRender.every((value, i) => Math.abs(value - afterRender[i]) < 1e-6), 'pre-render measurements update inverse skin bindings after growth and host scaling');
  animateCompanion(pet, 0, null, false);
  const early = pet.measurePoints(false).slice();
  for (let frame = 1; frame <= 20; frame++) animateCompanion(pet, frame / 30, null, false);
  assert.notDeepEqual(pet.measurePoints(false), early, 'measurements include the current living pose');
  const owned = [...workshop.geometries, ...workshop.materials, ...workshop.textures];
  const disposals = new Map(owned.map(resource => [resource, 0]));
  for (const resource of owned) resource.addEventListener('dispose', () => disposals.set(resource, disposals.get(resource) + 1));
  const skeletons = new Set(); pet.root.traverse(node => { if (node.isSkinnedMesh) skeletons.add(node.skeleton); });
  assert.ok(skeletons.size > 0 && [...skeletons].every(skeleton => workshop.textures.has(skeleton.boneTexture)), 'GPU bone textures are registered before the first render');
  pet.dispose(); pet.dispose(); workshop.dispose(); workshop.dispose();
  assert.ok([...disposals.values()].every(count => count === 1), 'explicit rig disposal and Workshop disposal do not double dispose resources');
  assert.ok([...skeletons].every(skeleton => skeleton.boneTexture === null), 'disposed skeletons retain no GPU bone texture');
});

test('forest-bud WebGL1 fallback animates the same tail without a visible GPU-skinned mesh', async t => {
  const [{ Workshop }, { makeCompanion, animateCompanion }] = await Promise.all([
    import(pathToFileURL(path.join(__dirname, '..', 'farm', 'primitives.js')).href),
    import(pathToFileURL(path.join(__dirname, '..', 'farm', 'companions.js')).href)
  ]);
  const workshop = new Workshop(), pet = makeCompanion(workshop, 'plant', 2, 0, {webgl2:false,quality:'low',boneTextures:false});
  t.after(() => { pet.dispose(); workshop.dispose(); });
  const visible = []; pet.tail.traverseVisible(mesh => { if (mesh.isMesh) visible.push(mesh); });
  assert.ok(visible.length > 0 && visible.every(mesh => !mesh.isSkinnedMesh), 'GLSL1 renderer sees ordinary meshes');
  animateCompanion(pet, 0, null, false);
  const before = visible.map(mesh => mesh.geometry.attributes.position.array.slice());
  for (let frame = 1; frame <= 12; frame++) animateCompanion(pet, frame / 30, null, false);
  assert.ok(visible.some((mesh, index) => mesh.geometry.attributes.position.array.some((value, i) => value !== before[index][i])), 'CPU fallback deforms the real tail');
  for (const mesh of visible) assert.ok(Array.from(mesh.geometry.attributes.position.array).every(Number.isFinite));
  animateCompanion(pet, .5, null, true);
  const still = visible.map(mesh => mesh.geometry.attributes.position.array.slice());
  animateCompanion(pet, .7, null, true);
  assert.deepEqual(visible.map(mesh => mesh.geometry.attributes.position.array), still, 'reduced motion also stills the CPU tail');
});

test('forest-bud low density preserves the approved silhouette and skeleton while reducing mesh triangles', async t => {
  const [{ Workshop }, { makeCompanion }] = await Promise.all([
    import(pathToFileURL(path.join(__dirname, '..', 'farm', 'primitives.js')).href),
    import(pathToFileURL(path.join(__dirname, '..', 'farm', 'companions.js')).href)
  ]);
  for (const stage of [1, 3, 5]) {
    const workshop = new Workshop(), high = makeCompanion(workshop, 'plant', stage, 0, {quality:'high'});
    const low = makeCompanion(workshop, 'plant', stage, 0, {quality:'low'});
    t.after(() => { high.dispose(); low.dispose(); workshop.dispose(); });
    const stats = pet => {
      let triangles = 0; const skeletons = new Set();
      pet.root.traverseVisible(mesh => {
        if (!mesh.isMesh) return;
        triangles += (mesh.geometry.index?.count || mesh.geometry.attributes.position.count) / 3;
        if (mesh.skeleton) skeletons.add(mesh.skeleton);
      });
      return {triangles,bones:[...skeletons].map(skeleton => skeleton.bones.length)};
    };
    const highStats = stats(high), lowStats = stats(low);
    assert.ok(lowStats.triangles < highStats.triangles * .42, 'low density removes over half the triangles at stage ' + stage);
    assert.deepEqual(lowStats.bones, highStats.bones, 'density does not simplify the living skeleton');
    assert.ok(high.bodyBounds.min.distanceTo(low.bodyBounds.min) < .01 && high.bodyBounds.max.distanceTo(low.bodyBounds.max) < .01, 'the real body keeps the approved outline');
    assert.ok(high.frameProfile.bounds.min.distanceTo(low.frameProfile.bounds.min) < .025 && high.frameProfile.bounds.max.distanceTo(low.frameProfile.bounds.max) < .025, 'horns, leaf wings and tail keep their full turning envelope');
  }
});
