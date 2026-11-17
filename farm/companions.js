import * as THREE from 'three';
import { group } from './primitives.js';
import { sculpture, sweep, lens, roundedPanel, ribbon, line } from './companion-sculpt.js';

// Both companions are original, closed low-poly sculptures. The deliberately
// shaped cross-sections replace the old stacked balls, white eyeballs and halos.
const C = {
  leaf: 0x779759, leafDark: 0x456a49, leafLight: 0xa8bb78, jade: 0x8bbbad,
  belly: 0xd4c28e, cream: 0xe5ddbc, ink: 0x28332d, leather: 0x805b3c,
  leatherLight: 0xaf8356, brass: 0xc5a45c, rust: 0xb76546, rustLight: 0xc98156,
  fur: 0x977551, furLight: 0xb7976d, muzzle: 0xbda07a, furDark: 0x6e523a,
  suit: 0xd3d4ba, suitShadow: 0xa5b19d, teal: 0x487b77, tealDark: 0x355a57,
  visor: 0xbad9d5, blue: 0x647e87
};
const color = hex => new THREE.Color(hex);
const blend = (base, hex, amount) => base.lerp(color(hex), amount);
const leafOutline = [[0, -.30], [-.15, -.10], [-.18, .18], [0, .49], [.18, .18], [.15, -.10]];
const eyeOutline = [[-.105, 0], [-.089, .071], [-.047, .108], [.014, .114], [.071, .083], [.104, .023], [.083, -.055], [.022, -.083], [-.047, -.065], [-.091, -.036]];

// Fit every eye vertex to the actual polygonal face, rather than placing a
// flat eye in front of the skull. The shallow closed lenses are inset solids.
function conformEyes(head, socket, surface) {
  head.updateMatrixWorld(true);
  const headInverse = head.matrixWorld.clone().invert();
  const triangles = surface.geometry.attributes.position;
  const ray = new THREE.Ray(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
  const vertex = new THREE.Vector3(), cache = new Map();
  socket.traverse(mesh => {
    if (!mesh.isMesh) return;
    // Subdivide before projection so the eye follows each head facet. A single
    // fan otherwise cuts across the brow and disappears into the face.
    for (let level = 0; level < 2; level++) {
      const source = mesh.geometry.attributes.position, refined = [];
      for (let i = 0; i < source.count; i += 3) {
        const p = new THREE.Vector3().fromBufferAttribute(source, i);
        const q = new THREE.Vector3().fromBufferAttribute(source, i + 1);
        const r = new THREE.Vector3().fromBufferAttribute(source, i + 2);
        const pq = p.clone().lerp(q, .5), qr = q.clone().lerp(r, .5), rp = r.clone().lerp(p, .5);
        for (const point of [p, pq, rp, pq, q, qr, rp, qr, r, pq, qr, rp]) refined.push(point.x, point.y, point.z);
      }
      mesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute(refined, 3));
      mesh.geometry.deleteAttribute('normal');
    }
    const matrix = headInverse.clone().multiply(mesh.matrixWorld), inverse = matrix.clone().invert();
    const points = mesh.geometry.attributes.position;
    for (let i = 0; i < points.count; i++) {
      vertex.fromBufferAttribute(points, i).applyMatrix4(matrix);
      const relief = vertex.z;
      ray.origin.set(vertex.x, vertex.y, 3); ray.direction.set(0, 0, -1);
      const key = vertex.x.toFixed(6) + '/' + vertex.y.toFixed(6);
      let front = cache.get(key);
      if (front === undefined) {
        front = -Infinity;
        for (let j = 0; j < triangles.count; j += 3) {
          a.fromBufferAttribute(triangles, j); b.fromBufferAttribute(triangles, j + 1); c.fromBufferAttribute(triangles, j + 2);
          if (ray.intersectTriangle(a, b, c, false, hit)) front = Math.max(front, hit.z);
        }
        cache.set(key, front);
      }
      if (Number.isFinite(front)) vertex.z = front + relief + .004;
      vertex.applyMatrix4(inverse); points.setXYZ(i, vertex.x, vertex.y, vertex.z);
    }
    points.needsUpdate = true; mesh.geometry.computeVertexNormals();
  });
}

function eye(w, parent, eyes, side, pos, dragon, surface) {
  const socket = group(parent, pos);
  // A narrow lid sits against the face; no white ball or floating iris.
  const shape = dragon ? eyeOutline : [[-.108, 0], [-.078, .043], [-.025, .061], [.039, .055], [.103, .010], [.063, -.041], [0, -.050], [-.061, -.035]];
  lens(w, socket, dragon ? C.leafDark : C.furDark, shape.map(p => [p[0] * 1.12, p[1] * 1.13]), .014, [0, .005, -.006]);
  const blink = group(socket, [0, 0, .010]);
  lens(w, blink, C.ink, shape, .018);
  if (dragon) lens(w, blink, 0x819759, [[-.046, -.047], [.036, -.043], [.062, -.012], [.025, .023], [-.025, .018]], .006, [.016, -.014, .022]);
  lens(w, blink, 0xe9e7cd, [[-.019, -.005], [-.014, .021], [.011, .025], [.020, .008], [.009, -.008]], .006, [dragon ? -.038 : -.045, dragon ? .038 : .016, .027]);
  // The coloured outer edge is only 0.01 units deep; the eyebrow is sculpted
  // into the head's upper front plane instead of adding a separate raised bar.
  conformEyes(parent, socket, surface);
  eyes.push(socket); return socket;
}

function dragonWing(w, root, side, stage) {
  const pivot = group(root, [side * .45, 1.45 + stage * .045, -.30]);
  const scale = [.26, .44, .63, .80, .90][stage - 1];
  pivot.scale.set(side * scale, scale, scale);
  pivot.rotation.y = side * -.22;
  const outline = [[0, -.06], [.18, .48], [.48, .89], [.91, 1.12], [.91, .75], [.84, .47], [1.17, .35], [.91, .24], [.71, .19], [.61, -.14], [.43, .04], [.21, -.05]];
  lens(w, pivot, stage >= 4 ? 0x819c68 : 0x9db57c, outline, .115, null, null, [.39, .38]);
  lens(w, pivot, 0xb3c38a, [[.18, .29], [.48, .86], [.89, 1.08], [.71, .54], [.39, .22]], .045, [0, 0, .075], null, [.48, .55]);
  sweep(w, pivot, C.leafDark, [[0, -.05, .02], [.17, .43, .10], [.48, .87, .05], [.91, 1.12, 0]], [.075, .065, .044, .010]);
  sweep(w, pivot, C.leafDark, [[.16, .33, .09], [.48, .39, .12], [.84, .47, .02], [1.17, .35, 0]], [.043, .034, .023, .008]);
  sweep(w, pivot, C.leafDark, [[.16, .29, .08], [.38, .17, .13], [.61, -.14, 0]], [.04, .026, .008]);
  if (stage >= 4) lens(w, pivot, C.jade, [[-.065, 0], [0, -.095], [.075, 0], [0, .17]], .08, [.91, 1.10, .01]);
  pivot.userData.baseY = pivot.rotation.y;
  w.bake(pivot); return pivot;
}

function crystal(w, parent, pos, scale, tilt = 0, hex = C.jade) {
  return sculpture(w, parent, hex, [
    { y: 0, rx: .11, rz: .09 }, { y: .11, rx: .18, rz: .13 },
    { y: .34, rx: .12, rz: .10 }, { y: .55, rx: .012, rz: .01 }
  ], { sides: 5, position: pos, scale, rotation: [0, .13, tilt] });
}

function shell(w, body) {
  const sides = 16, vertices = [], indices = [];
  // Irregular broken lip with a substantial wall and open top.
  const lip = Array.from({ length: sides }, (_, i) => .64 + [0, .09, -.06, .16, -.035, .04, -.055, .14][i % 8]);
  const rings = [
    { radius: [.39, .34], heights: Array(sides).fill(.10) },
    { radius: [.65, .52], heights: Array(sides).fill(.32) },
    { radius: [.67, .54], heights: lip },
    { radius: [.61, .48], heights: lip.map(y => y - .015) },
    { radius: [.58, .45], heights: Array(sides).fill(.31) }
  ];
  rings.forEach(r => { for (let i = 0; i < sides; i++) { const a = i * Math.PI * 2 / sides; vertices.push(Math.cos(a) * r.radius[0], r.heights[i], .02 + Math.sin(a) * r.radius[1]); } });
  for (let r = 0; r < rings.length - 1; r++) for (let i = 0; i < sides; i++) { const a = r * sides + i, b = r * sides + (i + 1) % sides, c = b + sides, d = a + sides; indices.push(a, c, b, a, d, c); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); g.setIndex(indices);
  const flat = g.toNonIndexed(); g.dispose(); flat.computeVertexNormals(); w.geometries.add(flat);
  w.add(body, flat, 0xcbd2b3);
  line(w, body, 0x9cae88, [[-.26, .52, .533], [-.16, .42, .55], [-.23, .34, .55], [-.07, .24, .51]], .013);
  crystal(w, body, [.37, .33, .45], [.37, .41, .24], -.45, 0x98b6a5);
}

function frontSurface(mesh) {
  const triangles = mesh.geometry.attributes.position;
  const ray = new THREE.Ray(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
  return (x, y) => {
    ray.origin.set(x, y, 3); ray.direction.set(0, 0, -1);
    let front = -Infinity;
    for (let j = 0; j < triangles.count; j += 3) {
      a.fromBufferAttribute(triangles, j); b.fromBufferAttribute(triangles, j + 1); c.fromBufferAttribute(triangles, j + 2);
      if (ray.intersectTriangle(a, b, c, false, hit)) front = Math.max(front, hit.z);
    }
    return front;
  };
}

function dragonClothes(w, body, head, stage, torso) {
  const fit = frontSurface(torso);
  if (stage === 1) { shell(w, body); return; }
  // An actual triangular folded neckerchief follows the chest and shoulder.
  ribbon(w, body, C.rust, [[-.38, 1.68, .22], [-.27, 1.60, .44], [0, 1.53, .54], [.29, 1.60, .42], [.43, 1.67, .18]], .17, .045);
  lens(w, body, C.rustLight, [[-.17, .10], [.18, .04], [.03, -.30]], .035, [.03, 1.54, .57], [-.15, 0, -.12]);
  if (stage >= 3) {
    ribbon(w, body, C.leather, [[-.42, 1.70, .17], [-.28, 1.49, .52], [-.08, 1.19, .62], [.16, .91, .61], [.44, .65, .42]], .13, .035, fit);
    ribbon(w, body, 0xbe9566, [[-.35, 1.61, .42], [-.22, 1.42, .57], [.02, 1.11, .65], [.28, .82, .55]], .022, .012, (x, y) => fit(x, y) + .02);
    const satchel = group(body, [.61, .74, .13]); satchel.rotation.z = -.13; satchel.rotation.y = .28;
    roundedPanel(w, satchel, C.leather, .43, .46, .20, .08, [0, 0, 0]);
    roundedPanel(w, satchel, C.leatherLight, .45, .22, .045, .04, [0, .16, .20]);
    roundedPanel(w, satchel, C.brass, .07, .12, .02, .01, [0, .055, .25]);
    line(w, satchel, 0xceb181, [[-.17, -.17, .224], [0, -.19, .224], [.17, -.17, .224]], .006);
  }
  if (stage >= 4) {
    const cape = group(body, [0, 1.72, -.38]);
    sculpture(w, cape, stage === 5 ? 0x687e53 : C.rust, [
      { y: -.90, rx: .60, rz: .075, z: -.34 }, { y: -.67, rx: .66, rz: .10, z: -.27 },
      { y: -.31, rx: .55, rz: .13, z: -.15 }, { y: 0, rx: .35, rz: .12, z: 0 }
    ], { sides: 12, power: 3 });
    const clothTrim = stage === 5 ? C.brass : C.rustLight;
    ribbon(w, cape, clothTrim, [[-.55, -.86, -.375], [-.30, -.91, -.405], [0, -.92, -.418], [.30, -.91, -.405], [.55, -.86, -.375]], .035, .018);
    for (const s of [-1, 1]) ribbon(w, cape, stage === 5 ? 0x546b46 : 0xa45a40, [[s * .17, -.08, -.14], [s * .25, -.38, -.30], [s * .32, -.70, -.38]], .023, .014);
    if (stage === 5) {
      const emblem = lens(w, cape, C.jade, leafOutline, .035, [0, -.39, -.355], [0, Math.PI, 0]);
      emblem.scale.set(.58, .56, .62);
      line(w, cape, C.brass, [[0, -.51, -.391], [0, -.37, -.400], [0, -.20, -.353]], .009);
    }
    for (const s of [-1, 1]) {
      ribbon(w, body, C.leatherLight, [[s * .36, 1.72, -.21], [s * .48, 1.70, .04], [s * .39, 1.62, .39]], .12, .045);
      lens(w, body, C.brass, [[-.075, 0], [0, -.09], [.075, 0], [0, .11]], .035, [s * .36, 1.62, .43]);
    }
  }
  if (stage >= 5) {
    // The crown is a planted leaf/crystal comb integrated into the brow.
    // It has no floating ring or unsupported overhead element.
    ribbon(w, head, C.brass, [[-.45, .39, .13], [-.23, .48, .30], [0, .51, .36], [.23, .48, .30], [.45, .39, .13]], .075, .04);
    crystal(w, head, [0, .48, .27], [.64, .83, .59], 0, 0xc2d6b4);
    for (const s of [-1, 1]) crystal(w, head, [s * .24, .45, .19], [.46, .61, .43], s * -.28);
  }
}

function makeDragon(w, root, body, head, eyes, limbs, wings, core, stage) {
  const adult = (stage - 1) / 4, height = 1.69 + adult * .18;
  const torso = sculpture(w, body, C.leaf, [
    { y: .16, rx: .34, rz: .29, z: .02 }, { y: .37, rx: .56, rz: .41, z: -.02 },
    { y: .71, rx: .62, rz: .49, z: -.01 }, { y: 1.04, rx: .58, rz: .49, z: 0 },
    { y: 1.31, rx: .47, rz: .40, z: -.01 }, { y: 1.56, rx: .34, rz: .30, z: -.01 },
    { y: height, rx: .32, rz: .29, z: .02 }
  ], { sides: 16, shade: (p, n, base) => {
    if (n.z > .40 && p.y > .33 && p.y < 1.56 && Math.abs(p.x) < .39) return blend(base, C.belly, .97);
    if (n.y < -.25 || n.z < -.6) return base.multiplyScalar(.94);
    return base;
  } }); core.push(torso);
  const headY = [1.76, 1.86, 1.94, 2.00, 2.04][stage - 1];
  head.position.set(0, headY, .02);
  const headMesh = sculpture(w, head, C.leaf, [
    { z: -.43, rx: .19, ry: .27, y: .015 }, { z: -.28, rx: .48, ry: .48, y: .025 },
    { z: -.02, rx: .64, ry: .53, y: .015 }, { z: .26, rx: .64, ry: .46, y: -.025 },
    { z: .48, rx: .53, ry: .32, y: -.11 }, { z: .71, rx: .40, ry: .23, y: -.19 },
    { z: .86, rx: .31, ry: .175, y: -.18 }
  ], { axis: 'z', sides: 16, power: 2.6, shade: (p, n, base) => {
    if (p.z > .49) return blend(base, C.leafLight, .80);
    if (p.y < -.27 && p.z > .10) return blend(base, C.belly, .45);
    return base;
  } }); core.push(headMesh);
  // Leaf-shaped cheek fins and swept, horn-like branches root into the skull.
  for (const s of [-1, 1]) {
    const fin = lens(w, head, C.leafDark, [[-.11, -.23], [-.18, .03], [0, .35], [.16, .11], [.10, -.15]], .085, [s * .58, .02, -.17], [.08, s * .70, s * -.60]);
    core.push(fin);
    lens(w, head, C.leafLight, [[-.07, -.16], [-.09, .02], [0, .23], [.08, .07], [.05, -.10]], .033, [s * .62, .045, -.105], [.08, s * .70, s * -.60]);
    const hornSize = [.48, .66, .82, .94, 1][stage - 1];
    sweep(w, head, C.belly, [[s * .38, .36, -.11], [s * (.38 + .05 * hornSize), .36 + .23 * hornSize, -.11 - .09 * hornSize], [s * (.38 + .13 * hornSize), .36 + .49 * hornSize, -.11 - .24 * hornSize], [s * (.38 + .22 * hornSize), .36 + .58 * hornSize, -.11 - .37 * hornSize]], [.10, .085, .052, .005]);
    eye(w, head, eyes, s, [s * .39, .145, 0], true, headMesh);
    lens(w, head, C.leafDark, [[-.035, -.017], [-.031, .020], [.014, .022], [.034, .002], [.018, -.019]], .007, [s * .164, -.082, .865], [-.31, s * .07, s * -.12]);
    // One tapered foreleg from shoulder to mitten, without a spherical cuff.
    const arm = group(root, [s * .45, stage === 1 ? 1.29 : 1.41, .01]);
    core.push(sculpture(w, arm, C.leaf, [
      { y: -.66, rx: .13, rz: .18, x: s * .12, z: .17 },
      { y: -.56, rx: .20, rz: .23, x: s * .14, z: .17 },
      { y: -.31, rx: .18, rz: .19, x: s * .16, z: .09 },
      { y: -.08, rx: .19, rz: .19, x: s * .08, z: .01 },
      { y: .09, rx: .14, rz: .15, x: 0, z: 0 }
    ], { sides: 12, power: 2.7 }));
    for (let i = -1; i <= 1; i++) line(w, arm, C.leafDark, [[s * .12 + i * .086, -.53, .382], [s * .12 + i * .086, -.60, .361]], .007);
    limbs.push(arm);
    // Weight-bearing haunch descends into a broad three-toed foot.
    core.push(sculpture(w, body, C.leafDark, [
      { y: .005, rx: .24, rz: .34, x: s * .38, z: .20 },
      { y: .13, rx: .29, rz: .38, x: s * .38, z: .20 },
      { y: .30, rx: .27, rz: .31, x: s * .39, z: .10 },
      { y: .49, rx: .22, rz: .25, x: s * .39, z: -.025 }
    ], { sides: 12, power: 3.0 }));
    for (let i = -1; i <= 1; i++) sweep(w, body, C.belly, [[s * .38 + i * .145, .145, .47], [s * .38 + i * .145, .10, .59], [s * .38 + i * .145, .085, .64]], [.045, .037, .004], { sides: 5 });
    wings.push(dragonWing(w, root, s, stage));
  }
  line(w, head, C.leafDark, [[-.245, -.28, .80], [-.14, -.33, .865], [0, -.346, .885], [.14, -.33, .865], [.245, -.28, .80]], .010);
  // A small leafy comb, not spheres mounted on the forehead.
  for (let i = 0; i < (stage < 3 ? 1 : 3); i++) {
    const leaf = lens(w, head, i % 2 ? C.leafDark : C.jade, leafOutline, .075, [0, .47 - i * .025, -.05 - i * .19], [i * -.18, Math.PI / 2, 0]);
    leaf.scale.setScalar(stage === 1 ? .57 : .73);
  }
  const tail = group(root, [0, .50, -.32]);
  sweep(w, tail, C.leaf, [[0, 0, 0], [.25, -.13, -.38], [.59, -.25, -.69], [.98, -.20, -.88], [1.21, -.02, -.94], [1.30, .19, -.91]], [[.27, .27], [.24, .23], [.17, .18], [.11, .13], [.07, .09], [.015, .02]], { sides: 12 });
  for (let i = 0; i < 3; i++) lens(w, tail, C.leafDark, [[-.10, 0], [0, .22], [.12, 0]], .055, [.36 + i * .29, -.02 - Math.sin(i * 1.2) * .12, -.48 - i * .20], [0, .55, -.40]);
  lens(w, tail, stage >= 4 ? C.jade : C.leafLight, leafOutline, .095, [1.30, .26, -.91], [.2, .18, -.35]);
  dragonClothes(w, body, head, stage, torso);
  return tail;
}

function capyHelmet(w, body, head, stage) {
  if (stage < 3) return;
  // Solid open-face helmet: tailored rear shell, broad jaw guard, ear hubs,
  // and a curved transparent front canopy. No torus or unsupported halo.
  sculpture(w, head, C.suit, [
    { z: -.61, rx: .44, ry: .44, y: .04 }, { z: -.49, rx: .74, ry: .66, y: .045 },
    { z: -.28, rx: .85, ry: .74, y: .06 }, { z: -.10, rx: .86, ry: .74, y: .06 }
  ], { axis: 'z', sides: 16, power: 2.5 });
  ribbon(w, head, C.teal, [[0, .48, -.625], [0, .72, -.50], [0, .81, -.29], [0, .81, -.10]], .13, .018);
  roundedPanel(w, head, C.tealDark, .38, .21, .035, .035, [0, -.03, -.627], [0, Math.PI, 0]);
  for (let i = 0; i < 3; i++) roundedPanel(w, head, C.suitShadow, .27, .022, .012, .005, [0, -.085 + i * .055, -.668], [0, Math.PI, 0]);
  for (const s of [-1, 1]) lens(w, head, C.brass, [[-.02, -.02], [.02, -.02], [.02, .02], [-.02, .02]], .008, [s * .28, -.03, -.625], [0, Math.PI, 0]);
  // The head is in front of the rear shell. The narrow arch is a closed 3D
  // half-shell following its perimeter; it does not cover the eyes or muzzle.
  const archPoints = [];
  for (let i = 0; i <= 12; i++) { const a = i * Math.PI / 12; archPoints.push([Math.cos(a) * .86, .035 + Math.sin(a) * .74, -.085]); }
  sweep(w, head, C.suitShadow, archPoints, archPoints.map(() => [.065, .055]), { sides: 6 });
  for (const s of [-1, 1]) {
    roundedPanel(w, head, C.tealDark, .24, .36, .11, .06, [s * .81, -.05, -.01], [0, s * .85, 0]);
    roundedPanel(w, head, C.suit, .16, .24, .05, .045, [s * .86, -.04, .09], [0, s * .85, 0]);
    roundedPanel(w, head, C.brass, .065, .09, .015, .016, [s * .88, -.035, .15], [0, s * .85, 0]);
  }
  // Broad collar geometry has thickness and a flat supporting base at the neck.
  sculpture(w, body, C.suitShadow, [
    { y: 1.47, rx: .44, rz: .42, z: .05 }, { y: 1.53, rx: .62, rz: .52, z: .11 },
    { y: 1.62, rx: .64, rz: .54, z: .11 }, { y: 1.66, rx: .56, rz: .46, z: .08 }
  ], { sides: 16, power: 3 });
  ribbon(w, body, C.suit, [[-.53, 1.60, .27], [-.38, 1.58, .53], [0, 1.56, .65], [.38, 1.58, .53], [.53, 1.60, .27]], .09, .05);
  const geometry = new THREE.SphereGeometry(1, 28, 18, 0, Math.PI, 0, Math.PI);
  // SphereGeometry phi in [0,pi] forms the forward (+z) half.
  w.geometries.add(geometry);
  const canopy = new THREE.Mesh(geometry, w.material(C.visor, { transparent: true, opacity: .075, depthWrite: false, side: THREE.FrontSide }));
  canopy.position.set(0, .06, .01); canopy.scale.set(.98, .85, 1.23); canopy.userData.keep = true;
  head.add(canopy);
  // Short corner glints describe the canopy without streaks across the face.
  const gleams = [
    line(w, head, 0xd9e6d8, [[-.59, .55, .59], [-.48, .64, .68], [-.32, .71, .73]], .014),
    line(w, head, 0xb4d1cb, [[.81, .16, .63], [.83, -.01, .61]], .009)
  ];
  gleams.forEach(mesh => { mesh.userData.keep = true; mesh.userData.noShadow = true; mesh.castShadow = false; });
}

function capyEquipment(w, body, head, stage, torso) {
  const fit = frontSurface(torso);
  // Explorer identity starts with an actual cloth scarf and a compact receiver.
  ribbon(w, body, stage >= 3 ? C.teal : C.rust, [[-.39, 1.64, .13], [-.28, 1.56, .44], [0, 1.49, .55], [.28, 1.56, .44], [.39, 1.64, .13]], .17, .035);
  if (stage < 3) lens(w, body, C.rustLight, [[-.15, .09], [.14, .09], [.04, -.27], [-.07, -.16]], .035, [.06, 1.48, .58], [-.18, 0, -.13]);
  const receiver = group(head, [-.68, .14, -.20]); receiver.rotation.y = -.75;
  roundedPanel(w, receiver, C.teal, .19, .25, .075, .065, [0, 0, 0]);
  roundedPanel(w, receiver, C.brass, .065, .11, .015, .02, [0, 0, .08]);
  if (stage < 3) sweep(w, receiver, C.tealDark, [[-.04, .10, 0], [-.055, .24, -.025], [-.055, .30, -.05]], [.02, .015, .009], { sides: 5 });
  if (stage < 2) return;
  const backpack = group(body, [0, 1.02, -.50]);
  sculpture(w, backpack, C.teal, [
    { y: -.39, rx: .33, rz: .13, z: -.09 }, { y: -.28, rx: .42, rz: .20, z: -.09 },
    { y: .30, rx: .40, rz: .18, z: -.10 }, { y: .45, rx: .28, rz: .13, z: -.10 }
  ], { sides: 12, power: 4 });
  roundedPanel(w, backpack, C.suit, .54, .50, .055, .08, [0, .03, -.30], [0, Math.PI, 0]);
  for (let i = 0; i < 3; i++) roundedPanel(w, backpack, C.tealDark, .30, .035, .015, .005, [0, -.04 + i * .075, -.365], [0, Math.PI, 0]);
  for (const s of [-1, 1]) lens(w, backpack, C.brass, [[-.018, -.018], [.018, -.018], [.018, .018], [-.018, .018]], .008, [s * .19, -.15, -.365], [0, Math.PI, 0]);
  for (const s of [-1, 1]) ribbon(w, body, C.teal, [[s * .29, 1.59, -.29], [s * .36, 1.49, .19], [s * .35, 1.22, .53], [s * .32, .90, .57], [s * .40, .62, .40]], .12, .035, fit);
  const panelZ = fit(0, 1.13) + .025;
  roundedPanel(w, body, C.tealDark, .40, .35, .07, .05, [0, 1.13, panelZ], [-.06, 0, 0]);
  roundedPanel(w, body, C.suit, .34, .29, .022, .035, [0, 1.13, panelZ + .074], [-.06, 0, 0]);
  roundedPanel(w, body, C.teal, .19, .075, .013, .01, [0, 1.18, panelZ + .106]);
  for (let i = 0; i < 3; i++) lens(w, body, [C.rust, C.brass, C.teal][i], [[-.022, -.018], [.022, -.018], [.022, .018], [-.022, .018]], .008, [-.083 + i * .083, 1.065, panelZ + .118]);
  // Sewn panel seams follow the convex abdomen, with a real belt buckle.
  ribbon(w, body, C.tealDark, [[-.47, .65, .29], [-.34, .64, .47], [0, .63, .59], [.34, .64, .47], [.47, .65, .29]], .072, .025, fit);
  roundedPanel(w, body, C.brass, .12, .105, .025, .015, [0, .64, fit(0, .64) + .05]);
  if (stage >= 4) {
    for (const s of [-1, 1]) {
      sculpture(w, backpack, C.suit, [
        { y: -.43, rx: .105, rz: .12, x: s * .41, z: -.10 },
        { y: -.29, rx: .16, rz: .16, x: s * .41, z: -.10 },
        { y: .29, rx: .16, rz: .16, x: s * .41, z: -.10 },
        { y: .42, rx: .10, rz: .10, x: s * .41, z: -.10 }
      ], { sides: 10 });
      sculpture(w, backpack, C.tealDark, [{ y: -.47, rx: .12, rz: .12, x: s * .41, z: -.10 }, { y: -.36, rx: .13, rz: .13, x: s * .41, z: -.10 }], { sides: 8 });
      ribbon(w, backpack, C.brass, [[s * .41 - .13, .09, .015], [s * .41, .09, .075], [s * .41 + .13, .09, .015]], .07, .024);
    }
    roundedPanel(w, body, C.rust, .18, .12, .025, .03, [-.31, 1.38, .50], [0, -.3, .08]);
    lens(w, body, C.cream, [[-.02, -.035], [.02, -.035], [.02, .035], [-.02, .035]], .01, [-.31, 1.38, .535]);
  }
  if (stage === 5) {
    // Captain's mantle and rectangular mission tabs, grounded in the suit.
    sculpture(w, backpack, C.blue, [
      { y: -.69, rx: .58, rz: .065, z: -.31 }, { y: -.41, rx: .60, rz: .08, z: -.31 },
      { y: .05, rx: .50, rz: .09, z: -.26 }, { y: .48, rx: .29, rz: .08, z: -.16 }
    ], { sides: 12, power: 4 });
    ribbon(w, backpack, C.brass, [[-.53, -.64, -.36], [-.28, -.69, -.38], [0, -.71, -.39], [.28, -.69, -.38], [.53, -.64, -.36]], .035, .018);
    for (const s of [-1, 1]) ribbon(w, backpack, 0x516d79, [[s * .19, .34, -.25], [s * .28, -.05, -.35], [s * .32, -.58, -.40]], .026, .018);
    for (const s of [-1, 1]) {
      ribbon(w, body, C.brass, [[s * .39, 1.52, .16], [s * .48, 1.47, .28], [s * .40, 1.41, .40]], .16, .05);
      for (let i = 0; i < 3; i++) roundedPanel(w, body, C.cream, .018, .085, .015, .004, [s * .43 + (i - 1) * .04, 1.46, .34], [0, s * .32, s * -.23]);
    }
    lens(w, head, C.brass, [[-.09, -.045], [-.035, .02], [0, .11], [.035, .02], [.09, -.045], [0, -.005]], .025, [0, .68, .11], [-.45, 0, 0]);
  }
  capyHelmet(w, body, head, stage);
}

function makeCapybara(w, root, body, head, eyes, limbs, core, stage) {
  const adult = (stage - 1) / 4;
  const bodySections = [
    { y: .16, rx: .40, rz: .31, z: -.03 }, { y: .38, rx: .58, rz: .44, z: -.07 },
    { y: .72, rx: .65, rz: .51, z: -.06 }, { y: 1.06, rx: .60, rz: .48, z: -.04 },
    { y: 1.33, rx: .47, rz: .36, z: -.01 }, { y: 1.56, rx: .35, rz: .29, z: .04 },
    { y: 1.72 + adult * .04, rx: .34, rz: .29, z: .04 }
  ];
  // The anatomy and suit share a tailored outline. Skin remains a complete
  // measurable sculpture under the clothing; clothing is not counted as body.
  const torso = sculpture(w, body, C.fur, bodySections, { sides: 16, power: 2.8, shade: (p, n, base) => {
    if (n.z > .5 && p.y < 1.47 && Math.abs(p.x) < .4) return blend(base, C.furLight, .55);
    return base;
  } }); core.push(torso);
  let clothingSurface = torso;
  if (stage >= 2) clothingSurface = sculpture(w, body, C.suit, bodySections.slice(0, 6).map((s, i) => ({ ...s, rx: s.rx + .026, rz: s.rz + .025, y: s.y + (i ? .003 : -.005) })), {
    sides: 16, power: 2.8, shade: (p, n, base) => n.z < -.25 ? blend(base, C.suitShadow, .6) : base
  });
  head.position.set(0, [1.79, 1.91, 1.97, 2.02, 2.06][stage - 1], .04);
  const headMesh = sculpture(w, head, C.fur, [
    { z: -.48, rx: .25, ry: .30, y: .005 }, { z: -.29, rx: .54, ry: .47, y: .04 },
    { z: -.03, rx: .67, ry: .50, y: .015 }, { z: .27, rx: .69, ry: .43, y: -.045 },
    { z: .57, rx: .61, ry: .33, y: -.11 }, { z: .84, rx: .52, ry: .265, y: -.145 },
    { z: 1.00, rx: .42, ry: .22, y: -.145 }
  ], { axis: 'z', sides: 16, power: 3.0, shade: (p, n, base) => {
    if (p.z > .56) return blend(base, C.muzzle, .68);
    if (p.y > .32) return blend(base, C.furLight, .13);
    return base;
  } }); core.push(headMesh);
  for (const s of [-1, 1]) {
    const ear = sculpture(w, head, C.fur, [
      { y: .31, rx: .14, rz: .105, x: s * .48, z: -.19 },
      { y: .44, rx: .16, rz: .11, x: s * .50, z: -.18 },
      { y: .59, rx: .12, rz: .075, x: s * .50, z: -.17 },
      { y: .65, rx: .045, rz: .035, x: s * .48, z: -.16 }
    ], { sides: 10, power: 2.6 }); core.push(ear);
    lens(w, head, 0x8a654c, [[-.077, -.085], [-.075, .042], [-.032, .095], [.048, .080], [.071, .008], [.044, -.07]], .016, [s * .50, .49, -.072], [0, s * .18, s * -.08]);
    eye(w, head, eyes, s, [s * .466, .120, 0], false, headMesh);
    // Two small incised nostrils and the characteristic long blunt nose plane.
    lens(w, head, C.furDark, [[-.051, -.014], [-.039, .018], [.020, .023], [.050, -.005], [.022, -.027]], .008, [s * .245, -.105, 1.008], [-.18, s * .04, s * -.12]);
    line(w, head, C.furDark, [[s * .30, -.28, .987], [s * .19, -.312, 1.012], [s * .065, -.311, 1.014]], .008);
    // The planted short hindfeet are flattened wedges, not white toy shoes.
    core.push(sculpture(w, body, C.furDark, [
      { y: .005, rx: .24, rz: .32, x: s * .38, z: .18 }, { y: .13, rx: .28, rz: .35, x: s * .38, z: .18 },
      { y: .25, rx: .24, rz: .29, x: s * .38, z: .13 }, { y: .37, rx: .20, rz: .21, x: s * .37, z: .025 }
    ], { sides: 12, power: 3.2 }));
    if (stage >= 2) {
      sculpture(w, body, C.tealDark, [{ y: .005, rx: .25, rz: .33, x: s * .38, z: .18 }, { y: .11, rx: .285, rz: .36, x: s * .38, z: .18 }], { sides: 12, power: 3.2 });
      sculpture(w, body, C.suit, [{ y: .112, rx: .30, rz: .375, x: s * .38, z: .18 }, { y: .15, rx: .30, rz: .375, x: s * .38, z: .18 }, { y: .27, rx: .26, rz: .315, x: s * .38, z: .13 }, { y: .385, rx: .225, rz: .235, x: s * .37, z: .025 }], { sides: 12, power: 3.2 });
      ribbon(w, body, C.teal, [[s * .38 - .17, .22, .37], [s * .38, .24, .43], [s * .38 + .17, .22, .37]], .06, .025);
    } else for (let i = -1; i <= 1; i++) line(w, body, 0x554936, [[s * .38 + i * .12, .145, .501], [s * .38 + i * .12, .085, .529]], .009);
    const arm = group(root, [s * .46, stage === 1 ? 1.25 : 1.37, -.01]);
    const sections = [
      { y: -.71, rx: .13, rz: .17, x: s * .14, z: .16 }, { y: -.62, rx: .18, rz: .21, x: s * .17, z: .16 },
      { y: -.39, rx: .17, rz: .18, x: s * .18, z: .07 }, { y: -.14, rx: .19, rz: .19, x: s * .10, z: .01 },
      { y: .08, rx: .14, rz: .15, x: 0, z: -.005 }
    ];
    core.push(sculpture(w, arm, C.fur, sections, { sides: 12, power: 2.8 }));
    if (stage >= 2) {
      sculpture(w, arm, C.suit, sections.slice(1).map(p => ({ ...p, rx: p.rx + .025, rz: p.rz + .025 })), { sides: 12, power: 2.8 });
      sculpture(w, arm, C.teal, [{ y: -.57, rx: .195, rz: .22, x: s * .17, z: .14 }, { y: -.49, rx: .20, rz: .22, x: s * .18, z: .11 }], { sides: 12, power: 2.8 });
    }
    for (let i = -1; i <= 1; i++) line(w, arm, C.furDark, [[s * .16 + i * .075, -.627, .373], [s * .16 + i * .075, -.68, .337]], .007);
    limbs.push(arm);
  }
  line(w, head, C.furDark, [[0, -.23, 1.022], [0, -.306, 1.022]], .008);
  // Tiny sculpted fur notches on the broad cheeks, never pink button cheeks.
  for (const s of [-1, 1]) for (let i = 0; i < 2; i++) line(w, head, 0x90704f, [[s * (.47 + i * .06), -.17 - i * .025, .84 - i * .095], [s * (.46 + i * .06), -.22 - i * .025, .85 - i * .095]], .006);
  capyEquipment(w, body, head, stage, clothingSurface);
}

export function makeCompanion(w, kind, stage, stars = 0) {
  stage = Math.max(1, Math.min(5, Math.floor(Number(stage) || 1)));
  const root = group(), body = group(root), head = group(root), eyes = [], core = [], limbs = [], wings = [];
  const tail = kind === 'capybara'
    ? (makeCapybara(w, root, body, head, eyes, limbs, core, stage), null)
    : makeDragon(w, root, body, head, eyes, limbs, wings, core, stage);
  // All 5 stages change proportions as well as physical equipment. The baby
  // has a broader head and shorter torso; mature companions have more neck.
  if (stage === 1) { head.scale.set(1.04, 1.02, 1.00); body.scale.set(1.02, .90, 1.02); }
  if (stars > 0) {
    const badge = group(body, [kind === 'capybara' ? .24 : -.26, 1.28, kind === 'capybara' ? .57 : .59]);
    lens(w, badge, C.brass, [[-.06, -.03], [0, -.075], [.06, -.03], [.06, .05], [0, .08], [-.06, .05]], .02);
    lens(w, badge, C.cream, [[-.022, 0], [0, .035], [.022, 0], [0, -.025]], .012, [0, 0, .025]);
  }
  // Honest anatomy-only projection data: every vertex comes from a real body,
  // head, ear, arm or foot mesh, before batching. Wings, tail, clothing, helmet,
  // crystals and decorative badges never inflate the close-up measurement.
  root.updateMatrixWorld(true);
  const bodyBounds = new THREE.Box3(), bodyPoints = [], vertex = new THREE.Vector3();
  for (const mesh of core) {
    const attribute = mesh.geometry.attributes.position;
    for (let i = 0; i < attribute.count; i++) {
      vertex.fromBufferAttribute(attribute, i).applyMatrix4(mesh.matrixWorld);
      bodyBounds.expandByPoint(vertex); bodyPoints.push(vertex.x, vertex.y, vertex.z);
    }
  }
  eyes.forEach(e => { e.userData.parent = e.parent; e.removeFromParent(); });
  w.bake(body); w.bake(head); limbs.forEach(l => w.bake(l)); if (tail) w.bake(tail);
  eyes.forEach(e => { e.userData.parent.add(e); delete e.userData.parent; w.bake(e); });
  root.traverse(mesh => { if (mesh.isMesh && !mesh.material.transparent) { mesh.castShadow = !mesh.userData.noShadow; mesh.receiveShadow = !mesh.userData.noShadow; } });
  return { root, body, head, limbs, wings, eyes, tail, bodyBounds, bodyPoints: new Float32Array(bodyPoints), headY: head.position.y, bodyScaleY: body.scale.y, kind, stage, anatomyVertexCount: bodyPoints.length / 3 };
}

export function animateCompanion(pet, seconds, response, reducedMotion) {
  const wave = reducedMotion ? 0 : Math.sin(seconds * 1.65);
  const amount = response ? Math.sin(Math.max(0, Math.min(1, response.progress || 0)) * Math.PI) : 0;
  const happy = response && /harvest|grow|level|points|upgrade|celebrate/.test(response.kind);
  pet.root.position.y = reducedMotion ? 0 : Math.max(0, amount) * (happy ? .20 : .035);
  pet.body.scale.y = (pet.bodyScaleY || 1) * (1 + wave * .008);
  pet.head.position.y = pet.headY + wave * .012;
  pet.head.rotation.z = wave * .012 + amount * (pet.kind === 'capybara' ? .035 : .06);
  pet.head.rotation.y = response?.look || 0;
  pet.head.rotation.x = amount * -.045;
  for (let i = 0; i < pet.limbs.length; i++) {
    pet.limbs[i].rotation.z = (i ? 1 : -1) * (amount * (happy ? .65 : .32));
    pet.limbs[i].rotation.x = wave * .012 + amount * -.11;
  }
  for (let i = 0; i < pet.wings.length; i++) pet.wings[i].rotation.y = (pet.wings[i].userData.baseY || 0) + (i ? 1 : -1) * (wave * .028 + amount * .20);
  if (pet.tail) pet.tail.rotation.y = wave * .045 + amount * .13;
  const cycle = seconds % 5.3;
  const blink = !reducedMotion && cycle > 5.12 ? Math.max(.06, Math.abs(cycle - 5.21) / .09) : 1;
  pet.eyes.forEach(e => { e.scale.y = blink; });
}
