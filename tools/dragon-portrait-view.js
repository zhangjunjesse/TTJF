import * as THREE from 'three';
import { Workshop } from '../farm/primitives.js';
import { makeCompanion, animateCompanion } from '../farm/companions.js';

// Measure the actual pose, including the skinned tail and stage equipment.
function frame(root, camera) {
  root.updateMatrixWorld(true);
  camera.updateMatrixWorld();
  const bounds = new THREE.Box2(), vertex = new THREE.Vector3(), point = new THREE.Vector2();
  root.traverseVisible(mesh => {
    if (!mesh.isMesh || !mesh.geometry.attributes.position) return;
    mesh.skeleton?.update();
    for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
      mesh.getVertexPosition(i, vertex).applyMatrix4(mesh.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
      bounds.expandByPoint(point.set(vertex.x, vertex.y));
    }
  });
  const center = bounds.getCenter(new THREE.Vector2()), size = bounds.getSize(new THREE.Vector2());
  const radius = Math.max(size.x, size.y) * .53;
  Object.assign(camera, { left: center.x - radius, right: center.x + radius, top: center.y + radius, bottom: center.y - radius });
  camera.updateProjectionMatrix();
}

export function render() {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(256, 256);
  renderer.setClearColor(0, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = .98;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xe6f0ff, 0xb89868, .92));
  for (const [color, power, x, y, z] of [[0xffe6bd, 2.35, -4.3, 6.7, 3.7], [0xe1ecff, .70, 2.6, 1.65, 5.8], [0xffdfaa, 1.95, 2, 4, -3]]) {
    const light = new THREE.DirectionalLight(color, power);
    light.position.set(x, y, z);
    scene.add(light);
  }
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, .1, 50);
  camera.position.set(0, 2.1, 9);
  camera.lookAt(0, 1.5, 0);
  const portraits = [];
  try {
    for (let stage = 1; stage <= 5; stage++) for (const variant of ['default', 'festival']) {
      const workshop = new Workshop();
      const pet = makeCompanion(workshop, 'plant', stage, 0, { variant });
      try {
        scene.add(pet.root);
        pet.root.rotation.y = pet.homeYaw ?? -.44;
        animateCompanion(pet, 0, null, true);
        frame(pet.root, camera);
        renderer.render(scene, camera);
        portraits.push({ file: 'bud-' + stage + (variant === 'festival' ? '-festival' : '') + '.webp',
          url: renderer.domElement.toDataURL('image/webp', .95) });
      } finally {
        scene.remove(pet.root);
        pet.dispose?.();
        workshop.dispose();
      }
    }
    return portraits;
  } finally { renderer.dispose(); }
}
