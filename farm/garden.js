import * as THREE from 'three';
import { group, TAU } from './primitives.js';
import { makeGround, hash, noise } from './world-terrain.js';

export const PLOT_POSITIONS = [[1, -1.2], [3.4, -1.2], [5.8, -1.2], [1, 1.4], [3.4, 1.4], [5.8, 1.4]];
export const SLOT_POSITIONS = { entry: [-2.1, -1.2], center: [-4.8, 5.9], edge: [8.4, 2.8], fence: [1, -8.7], path: [-2.2, 6.1] };
const leafColors = [0x83af67, 0xa6c779, 0x6eaa70, 0xb7cb7a];
const flowerColors = [0xf0b0a0, 0xffd987, 0xf4e5c0];

// Server-aligned projections expose remainingMs. Only older standalone callers
// without that field fall back to wall-clock timestamps; status owns maturity.
export function cropPhase(plot, now = Date.now()) {
  if (plot.status === 'ready') return 3;
  if (plot.status !== 'growing') return 0;
  const start = new Date(plot.plantedAt).getTime(), end = new Date(plot.readyAt).getTime();
  const remaining = Number.isFinite(plot.remainingMs) ? plot.remainingMs : end - now;
  const progress = end > start ? Math.max(0, Math.min(.99, 1 - remaining / (end - start))) : 0;
  return progress < .34 ? 0 : progress < .72 ? 1 : 2;
}

function roundedSoil(w, parent, color, size, pos) {
  const [x, y, z] = size, r = .16, shape = new THREE.Shape();
  shape.moveTo(-x / 2 + r, -z / 2);
  shape.lineTo(x / 2 - r, -z / 2); shape.quadraticCurveTo(x / 2, -z / 2, x / 2, -z / 2 + r);
  shape.lineTo(x / 2, z / 2 - r); shape.quadraticCurveTo(x / 2, z / 2, x / 2 - r, z / 2);
  shape.lineTo(-x / 2 + r, z / 2); shape.quadraticCurveTo(-x / 2, z / 2, -x / 2, z / 2 - r);
  shape.lineTo(-x / 2, -z / 2 + r); shape.quadraticCurveTo(-x / 2, -z / 2, -x / 2 + r, -z / 2);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: y, steps: 1, bevelEnabled: true, bevelSegments: 1, bevelSize: .045, bevelThickness: .035, curveSegments: 3 });
  geo.rotateX(-Math.PI / 2); w.geometries.add(geo);
  return w.add(parent, geo, color, pos);
}

function flower(w, parent, x, z, scale = 1, index = 0) {
  const g = group(parent, [x, .08, z]); g.scale.setScalar(scale);
  w.beam(g, 0x658f57, [0, 0, 0], [0, .37, 0], .025);
  w.orb(g, 0x7cac62, [-.10, .16, 0], [.16, .045, .07], 0).rotation.z = -.35;
  for (let i = 0; i < 5; i++) { const a = i * TAU / 5; w.orb(g, flowerColors[index % 3], [Math.cos(a) * .12, .38, Math.sin(a) * .12], [.10, .045, .09], 0); }
  w.orb(g, 0xd7a645, [0, .42, 0], [.065, .045, .065], 0);
}
function tree(w, parent, x, z, height, autumn = false) {
  const g = group(parent, [x, 0, z]);
  w.cylinder(g, 0x94704b, [.10, height * .38, 0], .18, height * .76, .11);
  for (const s of [-1, 1]) w.beam(g, 0x94704b, [.08, height * .45, 0], [s * .62, height * .71, -.13], .10);
  const colors = autumn ? [0xd6bd76, 0xe0c986, 0xb5bb6b, 0xd3a666] : leafColors;
  [[-.50, .78, .05, .83], [.48, .80, -.02, .92], [0, .98, 0, .90], [.08, .76, .60, .73]].forEach((v, i) => {
    w.orb(g, colors[i], [v[0], v[1] * height, v[2]], [v[3], v[3] * .95, v[3]], 1).rotation.y = i;
  });
}

export function makeTerrain(w) {
  return makeGround(w);
}

function makeFence(w, root) {
  for (let i = 0; i < 13; i++) {
    const x = -.65 + i * .32;
    w.box(root, 0xdec897, [x, .35, -8.68], [.13, .70, .08]);
    w.cone(root, 0xe7d4a5, [x, .75, -8.68], [.09, .13, .055]);
  }
  w.box(root, 0xb59765, [1.3, .26, -8.72], [4.2, .09, .10]);
  w.box(root, 0xb59765, [1.3, .57, -8.72], [4.2, .09, .10]);
}
export function makeDecoration(w, slot, id) {
  const root = group(); const p = SLOT_POSITIONS[slot];
  if (slot !== 'fence' && slot !== 'path') root.position.set(p[0], 0, p[1]);
  if (id === 'fence') makeFence(w, root);
  else if (id === 'path') {
    for (let i = 0; i < 8; i++) {
      const z = 4.9 - i * .68, x = -2.4 + Math.sin(i * .5) * .23;
      const stone = w.cylinder(root, i % 2 ? 0xa9a089 : 0xb6aa8c, [x, .025, z], .38 + Math.sin(i * 2.3) * .035, .04); stone.scale.set(1, 1, .63 + (i % 3) * .06); stone.rotation.y = i * .7;
    }
  } else if (id === 'flowerpot' || id === 'pot') {
    w.cylinder(root, 0xcd9470, [0, .28, 0], .25, .49, .34);
    w.cylinder(root, 0xe3ae83, [0, .51, 0], .38, .13);
    w.cylinder(root, 0x6f6044, [0, .585, 0], .31, .015);
    const bouquet = group(root, [0, .51, 0]);
    for (let i = 0; i < 5; i++) flower(w, bouquet, Math.cos(i * 1.7) * .19, Math.sin(i * 1.7) * .19, 1.15, i);
  } else if (id === 'mailbox') {
    w.cylinder(root, 0xa9815d, [0, .50, 0], .09, 1);
    w.box(root, 0x76a7ad, [0, 1.02, 0], [.63, .40, .40]);
    w.ball(root, 0x91bec0, [0, 1.19, 0], [.32, .20, .22]);
    w.box(root, 0xf3dfb5, [0, 1.03, .207], [.45, .26, .025]);
    w.box(root, 0xdf927c, [.35, 1.30, 0], [.04, .38, .05]);
    w.box(root, 0xdf927c, [.44, 1.47, 0], [.20, .12, .06]);
    w.star(root, 0xf6cb71, [0, 1.03, .23], .09);
  } else if (id === 'picnic') {
    roundedSoil(w, root, 0xe49c88, [1.45, .025, 1.16], [0, .045, 0]);
    for (let i = -2; i <= 2; i++) w.box(root, 0xf3d6ab, [i * .27, .083, 0], [.08, .008, 1.14]);
    for (let i = -1; i <= 1; i++) w.box(root, 0xf3d6ab, [0, .087, i * .32], [1.42, .008, .07]);
    w.cylinder(root, 0xaa7d50, [.35, .24, -.25], .23, .29, .28);
    w.ring(root, 0x8e6744, [.35, .47, -.25], .21, .035);
    w.ball(root, 0xf1d9ab, [-.28, .14, .15], [.23, .08, .16]);
    w.ball(root, 0xdc8a6f, [-.10, .16, -.18], [.08, .08, .08]);
  } else if (['rabbitstatue', 'rabbit', 'bunny', 'rabbitStatue', 'rabbit-statue'].includes(id)) {
    w.cylinder(root, 0xbabca3, [0, .10, 0], .44, .20);
    w.ball(root, 0xf0dec1, [0, .48, 0], [.29, .39, .25]);
    w.ball(root, 0xf0dec1, [0, .85, .08], [.27, .25, .23]);
    for (const s of [-1, 1]) { w.ball(root, 0xf0dec1, [s * .14, 1.18, .03], [.09, .30, .085]); w.ball(root, 0xd0ad9c, [s * .14, 1.20, .10], [.035, .20, .018]); w.ball(root, 0x705d51, [s * .105, .88, .29], [.026, .033, .018]); }
    w.ball(root, 0xd09c90, [0, .80, .31], [.041, .031, .023]);
  } else if (id === 'trellis') {
    for (const s of [-1, 1]) w.box(root, 0xb18d60, [s * .59, 1.01, 0], [.12, 2.02, .12]);
    for (let i = 0; i < 5; i++) w.box(root, 0xc8aa7b, [0, .35 + i * .38, 0], [1.35, .075, .08]);
    for (let i = 0; i < 4; i++) w.box(root, 0xc8aa7b, [-.45 + i * .30, 1.05, 0], [.045, 1.75, .06]);
    for (let i = 0; i < 10; i++) { const a = i * 1.6; w.orb(root, leafColors[i % 4], [Math.cos(a) * .54, .3 + i * .17, .11], [.22, .13, .12], 0); if (i % 2) w.orb(root, 0xe4a097, [Math.cos(a) * .54 + .1, .3 + i * .17, .23], [.11, .10, .05], 1); }
  } else if (id === 'windmill') {
    w.cylinder(root, 0xf2d6a5, [0, .85, 0], .34, 1.7, .20);
    w.cone(root, 0x8ebcba, [0, 1.88, 0], [.44, .51, .44]);
    const rotor = group(root, [0, 1.58, .39]);
    for (let i = 0; i < 4; i++) {
      const blade = group(rotor); blade.rotation.z = i * Math.PI / 2;
      w.beam(blade, 0xba8e60, [0, 0, 0], [0, .83, 0], .028);
      w.polygon(blade, i % 2 ? 0x91bdb7 : 0xf0bf76, [[0, .20], [.23, .27], [.19, .81], [0, .78]], .025, [0, 0, 0]);
    }
    w.star(rotor, 0xffdd8d, [0, 0, .04], .13); w.bake(rotor); rotor.removeFromParent(); w.bake(root); root.add(rotor); root.userData.rotor = rotor; return root;
  } else {
    // A tiny weathered corner peg marks an available slot without a round pad.
    w.box(root, 0x967851, [0, .06, 0], [.09, .12, .09]);
    for (let i = 0; i < 3; i++) w.orb(root, 0xb6ad91, [(i - 1) * .15, .035, .10], [.045, .025, .045], 0);
  }
  w.bake(root); return root;
}

function tilledEarth(w, root) {
  if (!w.cache.has('tilled-material')) {
    const data = new Uint8Array(128 * 128 * 4);
    for (let j = 0; j < 128; j++) for (let i = 0; i < 128; i++) {
      const n = noise(i * .11, j * .11), grit = hash(i, j), furrow = Math.pow(.5 + .5 * Math.sin(i / 128 * Math.PI * 14 + noise(i * .03, j * .07) * .5), 3);
      const k = (j * 128 + i) * 4, v = .76 + n * .17 + grit * .13 - furrow * .12;
      data[k] = 132 * v; data[k + 1] = 93 * v; data[k + 2] = 57 * v; data[k + 3] = 255;
    }
    const texture = new THREE.DataTexture(data, 128, 128, THREE.RGBAFormat); texture.colorSpace = THREE.SRGBColorSpace; texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter; texture.generateMipmaps = true; texture.anisotropy = 4; texture.needsUpdate = true; w.textures.add(texture);
    w.cache.set('tilled-material', w.material(0xffffff, { map: texture }));
  }
  const geometry = w.geometry('tilled-surface', () => {
    const g = new THREE.PlaneGeometry(1.96, 2.1, 42, 28); g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i); p.setY(i, .094 + (.5 + .5 * Math.cos((x + .98) / 1.96 * Math.PI * 14 + noise(x * 3,z * 4) * .5)) * .025 + (noise(x * 14, z * 14) - .5) * .007); }
    g.computeVertexNormals(); return g;
  });
  const mesh = new THREE.Mesh(geometry, w.cache.get('tilled-material')); mesh.receiveShadow = true; mesh.userData.keep = true; root.add(mesh);
}

export function makePlot(w, assets, plot, index, now) {
  const root = group(), p = PLOT_POSITIONS[index]; root.position.set(p[0], .016, p[1]);
  const locked = !plot.unlocked || plot.status === 'locked';
  w.box(root, locked ? 0x7a914d : 0x64452d, [0, .035, 0], [2.04, .07, 2.19]);
  w.box(root, locked ? 0x859d54 : 0x61432c, [0, .076, 0], [1.91, .018, 2.05]);
  // A thin, dark timber edge sits only just above the loose earth.
  for (const side of [-1, 1]) {
    w.box(root, 0x795735, [side * 1.01, .083, 0], [.042, .055, 2.2]);
    w.box(root, 0x6f4f30, [0, .083, side * 1.08], [2.07, .055, .042]);
  }
  if (locked) {
    for (let i = 0; i < 3; i++) w.cone(root, leafColors[i], [(i - 1) * .3, .36, .20], [.09, .32, .09]);
    w.ring(root, 0xded4ad, [0, .55, -.13], .11, .035);
    w.box(root, 0xded4ad, [0, .43, -.13], [.27, .21, .10]);
  } else {
    tilledEarth(w, root);
    for (let i = 0; i < 18; i++) {
      const x = (hash(i, index + 33) - .5) * 1.8, z = (hash(i, index + 37) - .5) * 1.95;
      w.orb(root, i % 2 ? 0x62452e : 0x775334, [x, .117, z], [.025, .016, .035], 0);
    }
    const ready = plot.status === 'ready';
    if (plot.cropId && (plot.status === 'growing' || ready)) {
      const crop = plot.cropId === 'radish' ? 'carrot' : plot.cropId;
      const stage = cropPhase(plot, now);
      if (['carrot', 'strawberry', 'sunflower'].includes(crop)) {
        // Upstream crop nodes are already planted clusters. Keep one generous
        // cluster per bed instead of shrinking several complete clusters.
        const plant = assets.clone(crop, `crop-${crop}-${stage}`, crop === 'sunflower' ? 1.63 : 1.73);
        plant.position.set(0, .10, 0); plant.rotation.y = .04; root.add(plant);
      }
    }
    // A ripe flag is stable, never a flashing timer.
    w.beam(root, 0xac8a5d, [.77, .2, -.72], [.77, .78, -.72], .028);
    w.polygon(root, ready ? 0xf4cb74 : 0xddd1a8, [[0, 0], [.25, -.05], [.19, -.25], [0, -.20]], .025, [.77, .74, -.72]);
  }
  w.bake(root); return root;
}
