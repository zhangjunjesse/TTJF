import * as THREE from 'three';
import { Workshop } from './primitives.js';
import { makeCompanion, animateCompanion } from './companions.js';

const query = new URLSearchParams(location.search);
const kind = query.get('kind') || 'plant', stage = Number(query.get('stage') || 5), lineup = query.has('lineup');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio)); renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0xd2d8b6);
const ambient = new THREE.HemisphereLight(0xcfe4ed, 0x756344, 1.05); scene.add(ambient);
const sun = new THREE.DirectionalLight(0xffebc7, 2.7); sun.position.set(-15, 22, 11); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = -12; sun.shadow.camera.right = 12; sun.shadow.camera.top = 8; sun.shadow.camera.bottom = -8;
sun.shadow.camera.near = .5; sun.shadow.camera.far = 70; sun.shadow.normalBias = .025; sun.shadow.bias = -.00015; sun.shadow.radius = 3; scene.add(sun);
const fill = new THREE.DirectionalLight(0xb7d3df, .25); fill.position.set(8, 5, -8); scene.add(fill);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshLambertMaterial({ color: 0x9baf75 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = -.006; ground.receiveShadow = true; scene.add(ground);
const w = new Workshop(), pets = [];
const camera = new THREE.OrthographicCamera(); camera.near = .1; camera.far = 100;
const angle = query.get('angle') || 'three-quarter';
let viewHeight = lineup ? 4.8 : 3.8;
const target = new THREE.Vector3(0, 1.43, .05);
const direction = angle === 'profile' ? new THREE.Vector3(1, .23, .01) : angle === 'back' ? new THREE.Vector3(.55, .35, -1) : angle === 'front' ? new THREE.Vector3(0, .20, 1) : new THREE.Vector3(.48, .38, 1);
camera.position.copy(target).addScaledVector(direction.normalize(), 22); camera.lookAt(target);
const aspect = innerWidth / innerHeight; camera.left = -viewHeight * aspect / 2; camera.right = viewHeight * aspect / 2; camera.top = viewHeight / 2; camera.bottom = -viewHeight / 2; camera.updateProjectionMatrix();
if (lineup) {
  camera.position.set(0, 6.6, 22); camera.lookAt(0, 1.45, 0);
  for (let i = 1; i <= 5; i++) { const pet = makeCompanion(w, kind, i, i === 5 ? 1 : 0); pet.root.position.x = (i - 3) * 3.35; scene.add(pet.root); pets.push(pet); }
} else { const pet = makeCompanion(w, kind, stage, 1); scene.add(pet.root); pets.push(pet); }
function render(seconds = 0, response = null, reduced = true) { pets.forEach(pet => animateCompanion(pet, seconds, response, reduced)); scene.updateMatrixWorld(true); renderer.render(scene, camera); }
function stats() {
  return pets.map(pet => {
    let meshes = 0, transparent = 0, vertices = 0, triangles = 0;
    pet.root.traverse(m => { if (m.isMesh) { meshes++; vertices += m.geometry.attributes.position.count; triangles += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3; if (m.material.transparent) transparent++; } });
    const bounds = new THREE.Box3().setFromObject(pet.root);
    const sampled = new THREE.Box3(), sample = new THREE.Vector3();
    for (let i = 0; i < pet.bodyPoints.length; i += 3) { sample.fromArray(pet.bodyPoints, i); sampled.expandByPoint(sample); }
    const anatomyBoundsMatchVertices = sampled.min.distanceTo(pet.bodyBounds.min) < 1e-6 && sampled.max.distanceTo(pet.bodyBounds.max) < 1e-6;
    return { kind: pet.kind, stage: pet.stage, meshes, transparent, vertices, triangles, anatomyVertexCount: pet.anatomyVertexCount, anatomyBoundsMatchVertices,
      anatomy: { min: pet.bodyBounds.min.toArray(), max: pet.bodyBounds.max.toArray(), height: pet.bodyBounds.max.y - pet.bodyBounds.min.y },
      visual: { min: bounds.min.toArray(), max: bounds.max.toArray() }, finite: Array.from(pet.bodyPoints).every(Number.isFinite),
      eyes: pet.eyes.map(e => ({ world: e.getWorldPosition(new THREE.Vector3()).toArray(), scaleY: e.scale.y })),
      limbs: pet.limbs.map(l => ({ rotation: l.rotation.toArray() })) };
  });
}
window.CompanionFixture = { render, stats, pets, camera, renderer, dispose() { w.dispose(); ground.geometry.dispose(); ground.material.dispose(); sun.shadow.map?.dispose(); sun.shadow.mapPass?.dispose(); renderer.dispose(); } };
render(); window.fixtureReady = true;
