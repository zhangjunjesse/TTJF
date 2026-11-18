import * as THREE from 'three';
import { Workshop } from '../../farm/primitives.js';
import { makeCompanion, animateCompanion } from '../../farm/companions.js';

const params = new URLSearchParams(location.search);
const stage = Number(params.get('stage') || 1), variant = params.get('variant') || 'default';
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = .98;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0xd4e1ce);
scene.add(new THREE.HemisphereLight(0xe6f0ff, 0xb89868, .92));
const sun = new THREE.DirectionalLight(0xffe6bd, 2.35); sun.position.set(-4.3, 6.7, 3.7);
sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: .5, far: 21 });
sun.shadow.normalBias = .008; sun.shadow.bias = -.00024; scene.add(sun);
const fill = new THREE.DirectionalLight(0xe1ecff, .70); fill.position.set(2.6, 1.65, 5.8); scene.add(fill);
const rim = new THREE.DirectionalLight(0xffdfaa, 1.45); rim.position.set(2, 4, -3); scene.add(rim);
const plane = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({ color: 0xb0c18c, roughness: .95 }));
plane.rotation.x = -Math.PI / 2; plane.position.y = -.006; plane.receiveShadow = true; scene.add(plane);
const workshop = new Workshop(), pet = makeCompanion(workshop, 'plant', stage, 0, { variant });
scene.add(pet.root);
const angle = params.get('angle') || 'three-quarter';
pet.root.rotation.y = angle === 'front' ? 0 : angle === 'back' ? Math.PI - .35 : angle === 'side' ? -Math.PI / 2 : -.66;
animateCompanion(pet, 0, null, true);
const bounds = new THREE.Box3(), point = new THREE.Vector3();
pet.root.updateMatrixWorld(true);
for (let i = 0; i < pet.frameProfile.points.length; i += 3) bounds.expandByPoint(point.fromArray(pet.frameProfile.points, i).applyMatrix4(pet.root.matrixWorld));
const aspect = innerWidth / innerHeight;
const height = Math.max(bounds.max.y - bounds.min.y + .48, (bounds.max.x - bounds.min.x + .48) / aspect);
const center = bounds.getCenter(new THREE.Vector3());
const camera = new THREE.OrthographicCamera(-height * aspect / 2, height * aspect / 2, height / 2, -height / 2, .1, 100);
camera.position.set(0, center.y + .65, 15); camera.lookAt(0, center.y, 0);
const errors = [];
renderer.debug.onShaderError = (gl, program, vertex, fragment) => errors.push({program:gl.getProgramInfoLog(program),vertex:gl.getShaderInfoLog(vertex),fragment:gl.getShaderInfoLog(fragment)});
function render(seconds = 0, response = null, reduced = true) { animateCompanion(pet, seconds, response, reduced); renderer.render(scene, camera); }
window.GrowthFixture = { pet, render, stats() {
  let invalid = 0, meshes = 0;
  pet.root.traverse(node => {
    if (node.isMesh) meshes++;
    if ([...node.position.toArray(), ...node.scale.toArray(), ...node.quaternion.toArray()].some(value => !Number.isFinite(value))) invalid++;
  });
  return { stage, variant, angle, invalid, meshes, shaderErrors: errors, programs: renderer.info.programs.length, memory: renderer.info.memory };
}, dispose() { pet.dispose(); workshop.dispose(); plane.geometry.dispose(); plane.material.dispose(); sun.shadow.map?.dispose(); renderer.dispose(); } };
render(); window.fixtureReady = true;
