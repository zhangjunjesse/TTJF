import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import * as THREE from 'three';
import { Workshop } from '../../farm/primitives.js';
import { makeCompanion, animateCompanion } from '../../farm/companions.js';

const stage = Number(process.argv[2] || 1), report = { stage, looks: [], checks: [] };
let anatomy;
for (const variant of ['default', 'festival']) {
  const workshop = new Workshop(), pet = makeCompanion(workshop, 'plant', stage, 0, { variant });
  const visible = crypto.createHash('sha256'), disposed = new Map();
  for (const key of ['geometries', 'materials', 'textures']) for (const resource of workshop[key]) {
    disposed.set(resource, 0); resource.addEventListener('dispose', () => disposed.set(resource, disposed.get(resource) + 1));
  }
  pet.root.updateMatrixWorld(true);
  pet.root.traverse(node => {
    if (!node.isMesh) return;
    for (const value of node.geometry.attributes.position.array) assert.ok(Number.isFinite(value), 'rendered geometry is finite');
    visible.update(Buffer.from(node.geometry.attributes.position.array.buffer));
    visible.update(JSON.stringify(node.matrixWorld.elements));
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) visible.update(String(material.color?.getHex()));
  });
  const bodyHash = crypto.createHash('sha256').update(Buffer.from(pet.bodyPoints.buffer)).digest('hex');
  if (anatomy) assert.equal(bodyHash, anatomy, 'changing clothes preserves the actual anatomy');
  anatomy = bodyHash;
  const held = [];
  pet.root.traverse(node => { if (node.userData.heldOrientation) held.push(node); });
  const grip = new THREE.Vector3(), palm = new THREE.Vector3();
  for (const kind of ['pet', 'feed', 'wash', 'train', 'celebrate']) for (const progress of [.15, .52, .85]) {
    animateCompanion(pet, 2 + progress, { kind, progress }, false);
    pet.root.updateMatrixWorld(true);
    for (const prop of held) {
      prop.getWorldPosition(grip); prop.parent.getWorldPosition(palm);
      assert.ok(grip.distanceTo(palm) < .25, 'a moving held object remains at the paw');
    }
    pet.root.traverse(node => assert.ok([...node.position.toArray(), ...node.quaternion.toArray(), ...node.scale.toArray()].every(Number.isFinite)));
  }
  animateCompanion(pet, 0, null, true);
  report.looks.push({ variant, signature: visible.digest('hex'), anatomy: bodyHash, heldProps: held.length,
    anatomyHeight: pet.bodyBounds.max.y - pet.bodyBounds.min.y });
  pet.dispose(); pet.dispose(); workshop.dispose(); workshop.dispose();
  for (const count of disposed.values()) assert.equal(count, 1, 'all owned resources dispose exactly once');
  assert.equal(workshop.geometries.size + workshop.materials.size + workshop.textures.size, 0);
}
assert.notEqual(report.looks[0].signature, report.looks[1].signature, 'the two looks change drawable geometry or materials');
report.checks = ['finite geometry/transforms', 'same anatomy across clothes', 'distinct drawable looks',
  'palm contact through five interactions', 'idempotent complete resource cleanup'];
fs.writeFileSync(new URL(`smoke-stage-${stage}.json`, import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
