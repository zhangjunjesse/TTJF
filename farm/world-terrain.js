import * as THREE from 'three';
import { group, TAU } from './primitives.js';

// Murmur/value-noise method adapted from Harvest Hollow render/ground.js (MIT),
// fixed revision 9b23e1a1fe2b19e117a3005efce21417052ded97. See assets/farm/CREDITS.md.
export function hash(x, z) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) + Math.imul(z | 0, 0x165667b1) + 0x9e3779b9) | 0;
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const fade = t => t * t * (3 - 2 * t);
export const smooth = (a, b, x) => fade(Math.max(0, Math.min(1, (x - a) / (b - a))));
export function noise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = fade(x - ix), fz = fade(z - iz);
  const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}
export const riverZ = x => -13.8 + Math.sin(x * .13) * 1.6 + Math.sin(x * .33) * .35;
export function heightAt(x, z) {
  const river = Math.abs(z - riverZ(x));
  const bank = -.85 * (1 - smooth(1.25, 2.9, river));
  const hills = smooth(12, 23, Math.max(Math.abs(x), Math.abs(z))) * (.3 + noise(x * .10, z * .10) * 1.3);
  // Hills rise beside the banks, never across the channel or over its water.
  return bank + hills * smooth(1.9, 5.0, river);
}
function segmentDistance(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - ax - t * dx, z - az - t * dz);
}
export function pathDistance(x, z) {
  return Math.min(
    Math.abs(x - (-2.2 + .22 * Math.sin(z * .35))),
    segmentDistance(x, z, -13, 4.5, 13, 4.5),
    segmentDistance(x, z, -4.4, -2.5, -2.2, -1.5),
    segmentDistance(x, z, -2.2, -6.8, 10.7, -6.8)
  );
}
let mapData = null, detailData = null;
function groundMap() {
  if (mapData) return mapData;
  const size = 1024, data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const x = i / (size - 1) * 80 - 40, z = j / (size - 1) * 80 - 40;
    const warp = noise(x * .085 - 2.7, z * .085 + 4.1) * 2.5;
    const n = noise(x * .22 + 7 + warp, z * .22 - 4 - warp), small = noise(x * 1.7, z * 1.7), grain = hash(i, j) - .5;
    const wild = smooth(9, 17, Math.max(Math.abs(x), Math.abs(z)));
    let r = 91 + n * 48 + small * 6 - wild * 11;
    let g = 127 + n * 48 + small * 6 - wild * 9;
    let b = 49 + n * 38 + small * 4 - wild * 1;
    const bank = 1 - smooth(2.1, 3.3, Math.abs(z - riverZ(x)) + (small - .5) * .22);
    r += bank * 28; g -= bank * 10; b += bank * 18;
    const road = (1 - smooth(.55, 1.10, pathDistance(x, z) + (small - .5) * .21)) * (1 - bank);
    const track = 1 - smooth(.12, .27, Math.abs(Math.abs(x + 2.2) - .39));
    const worn = road * (.91 + .09 * small);
    r = r * (1 - worn) + (170 + n * 17 + grain * 7 - track * 4) * worn;
    g = g * (1 - worn) + (141 + n * 13 + grain * 6 - track * 5) * worn;
    b = b * (1 - worn) + (95 + n * 10 + grain * 5 - track * 3) * worn;
    // Quiet footprint occlusion grounds the porch and the permanent animal yards.
    const houseAO = Math.exp(-Math.pow((x + 4.4) / 2.6, 6) - Math.pow((z + 4) / 2.3, 6)) * .12;
    const penWear = (1 - smooth(1.2, 2, Math.hypot((x - 6.0) * .85, (z - 6.8)))) * .08;
    const k = (j * size + i) * 4, shade = 1 - houseAO - penWear;
    data[k] = (r + grain * 3) * shade; data[k + 1] = (g + grain * 4) * shade; data[k + 2] = (b + grain * 3) * shade; data[k + 3] = 255;
  }
  mapData = data; return data;
}
function detailMap() {
  if (detailData) return detailData;
  const size = 256, data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const k = (j * size + i) * 4, n = hash(i, j), blade = hash(i >> 1, j >> 2);
    const v = 213 + n * 30 + blade * 12;
    data[k] = v; data[k + 1] = v; data[k + 2] = v; data[k + 3] = 255;
  }
  detailData = data; return data;
}
function texture(w, data, size, repeat = false) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = repeat ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.anisotropy = 4; t.needsUpdate = true; w.textures.add(t); return t;
}
export function makeGround(w) {
  const root = group(), positions = [], normals = [], uvs = [], indices = [];
  const n = 160;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const x = i / n * 80 - 40, z = j / n * 80 - 40;
    positions.push(x, heightAt(x, z), z); normals.push(0, 1, 0); uvs.push(i / n, j / n);
    if (i < n && j < n) { const a = j * (n + 1) + i; indices.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2); }
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); geo.setIndex(indices); geo.computeVertexNormals(); w.geometries.add(geo);
  const mat = w.material(0xffffff, { map: texture(w, groundMap(), 1024) });
  const detail = texture(w, detailMap(), 256, true);
  mat.onBeforeCompile = shader => {
    shader.uniforms.farmGrassDetail = { value: detail };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 farmGroundUv;').replace('#include <begin_vertex>', '#include <begin_vertex>\nfarmGroundUv = position.xz;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D farmGrassDetail; varying vec2 farmGroundUv;').replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= texture2D(farmGrassDetail, farmGroundUv * .32).r;');
  };
  const mesh = new THREE.Mesh(geo, mat); mesh.receiveShadow = true; mesh.userData.keep = true; root.add(mesh);
  makeRiver(w, root); return root;
}
function makeRiver(w, root) {
  const positions = [], colors = [], indices = [], col = new THREE.Color();
  for (let i = 0; i <= 160; i++) {
    const x = -40 + i * .5, z = riverZ(x), width = 1.65 + Math.sin(x * .27) * .15;
    for (let k = 0; k < 5; k++) {
      positions.push(x, -.57 + .007 * Math.sin(x), z + (k - 2) * width / 2);
      col.set(k === 0 || k === 4 ? 0x64a9ab : k === 1 || k === 3 ? 0x3c929d : 0x267787); colors.push(col.r, col.g, col.b);
      if (i < 160 && k < 4) { const a = i * 5 + k; indices.push(a, a + 1, a + 5, a + 1, a + 6, a + 5); }
    }
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); geo.setIndex(indices); geo.computeVertexNormals(); w.geometries.add(geo);
  const mat = w.material(0xffffff, { vertexColors: true, side: THREE.DoubleSide });
  const water = new THREE.Mesh(geo, mat); water.receiveShadow = true; water.userData.keep = true; root.add(water);
  const sparkle = group(root);
  for (let i = 0; i < 94; i++) {
    const x = -30 + hash(i, 731) * 60, z = riverZ(x) + (hash(i, 732) - .5) * 2.4;
    w.box(sparkle, i % 3 ? 0x8fc5c2 : 0xc3ded0, [x, -.55, z], [.1 + hash(i, 734) * .35, .008, .018 + hash(i, 735) * .015], [0, .2, 0]);
  }
  w.bake(sparkle); sparkle.traverse(m => { if (m.isMesh) m.castShadow = false; });
  const bridge = group(root, [-2.2, .02, riverZ(-2.2)]);
  for (let i = 0; i < 18; i++) w.box(bridge, i % 3 ? 0x9b7046 : 0xad8151, [0, .04 + Math.sin(i / 17 * Math.PI) * .22, -2.12 + i * .25], [2.1, .12, .23]);
  for (const side of [-1, 1]) for (let i = 0; i < 5; i++) {
    w.box(bridge, 0x79512f, [side * 1.04, .53, -2 + i], [.12, 1.06, .12]);
    if (i < 4) w.box(bridge, 0xb38a54, [side * 1.04, .88, -1.5 + i], [.11, .10, 1.05]);
  }
  w.bake(bridge);
}
export function fenceRun(w, root, ax, az, bx, bz, step = 1.1, height = .76) {
  const dx = bx - ax, dz = bz - az, length = Math.hypot(dx, dz), count = Math.max(1, Math.round(length / step));
  for (let i = 0; i <= count; i++) {
    const x = ax + dx * i / count, z = az + dz * i / count;
    w.box(root, 0x99713f, [x, height / 2, z], [.115, height, .115]);
    w.cone(root, 0xc09b58, [x, height + .035, z], [.085, .13, .085], [0, Math.PI / 4, 0]);
    if (i < count) for (const y of [height * .37, height * .76]) {
      const beam = w.box(root, 0xbc8e4d, [x + dx / count / 2, y, z + dz / count / 2], [length / count + .04, .085, .06]);
      beam.rotation.y = -Math.atan2(dz, dx);
    }
  }
}
export function grassTuft(w, root, x, z, scale, flower = false, seed = 1) {
  const positions = [], colors = [], c = new THREE.Color();
  const y = heightAt(x, z) + .015, n = flower ? 4 : 6;
  for (let i = 0; i < n; i++) {
    const a = (i / n * TAU) + hash(seed, i) * .6, r = .12 * scale, h = (.22 + hash(seed + 3, i) * .28) * scale;
    const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
    const dx = Math.cos(a + Math.PI / 2) * .045 * scale, dz = Math.sin(a + Math.PI / 2) * .045 * scale;
    positions.push(px - dx, y, pz - dz, px + dx, y, pz + dz, px + Math.cos(a) * .12 * scale, y + h, pz + Math.sin(a) * .12 * scale);
    [0x638038, 0x749847, flower ? 0xc2b85c : 0x9aaa52].forEach(color => { c.set(color); colors.push(c.r, c.g, c.b); });
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); geo.computeVertexNormals(); w.geometries.add(geo);
  const mesh = new THREE.Mesh(geo, w.paint); mesh.material.side = THREE.DoubleSide; root.add(mesh);
  if (flower) for (let j = 0; j < 2; j++) {
    const h = .31 * scale + j * .11 * scale, xx = x + (j - .5) * .15 * scale;
    w.beam(root, 0x68833e, [xx, y, z], [xx, y + h, z], .012 * scale);
    for (let k = 0; k < 5; k++) { const a = k * TAU / 5; w.orb(root, seed % 3 ? 0xece4b0 : 0xe1b34f, [xx + Math.cos(a) * .054 * scale, y + h, z + Math.sin(a) * .054 * scale], [.048 * scale, .021 * scale, .048 * scale], 0); }
    w.orb(root, 0xd5a234, [xx, y + h + .015, z], [.025 * scale, .023 * scale, .025 * scale], 0);
  }
}
