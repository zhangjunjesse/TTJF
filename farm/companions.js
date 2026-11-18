import * as THREE from 'three';
import { group } from './primitives.js';
import { sculpture, sweep, lens, roundedPanel, ribbon, line } from './companion-sculpt.js';
import { makeCompanionInteractions, animateCompanionInteraction } from './companion-interactions.js';
import { makeForestBud, animateForestBud } from './forest-bud/companion.js';

// The capybara keeps its existing closed low-poly sculpt. The plant companion
// uses the approved forest-bud sculpt and living rig through the shared factory.
const C = {
  cream: 0xe5ddbc, ink: 0x28332d, brass: 0xc5a45c, rust: 0xb76546, rustLight: 0xc98156,
  fur: 0x977551, furLight: 0xb7976d, muzzle: 0xbda07a, furDark: 0x6e523a,
  suit: 0xd3d4ba, suitShadow: 0xa5b19d, teal: 0x487b77, tealDark: 0x355a57,
  visor: 0xbad9d5, blue: 0x647e87
};
const color = hex => new THREE.Color(hex);
const blend = (base, hex, amount) => base.lerp(color(hex), amount);

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

function eye(w, parent, eyes, pos, surface) {
  const socket = group(parent, pos);
  // A narrow lid sits against the face; no white ball or floating iris.
  const shape = [[-.108, 0], [-.078, .043], [-.025, .061], [.039, .055], [.103, .010], [.063, -.041], [0, -.050], [-.061, -.035]];
  lens(w, socket, C.furDark, shape.map(p => [p[0] * 1.12, p[1] * 1.13]), .014, [0, .005, -.006]);
  const blink = group(socket, [0, 0, .010]);
  lens(w, blink, C.ink, shape, .018);
  lens(w, blink, 0xe9e7cd, [[-.019, -.005], [-.014, .021], [.011, .025], [.020, .008], [.009, -.008]], .006, [-.045, .016, .027]);
  // The coloured outer edge is only 0.01 units deep; the eyebrow is sculpted
  // into the head's upper front plane instead of adding a separate raised bar.
  conformEyes(parent, socket, surface);
  eyes.push(socket); return socket;
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
    eye(w, head, eyes, [s * .466, .120, 0], headMesh);
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

export function makeCompanion(w, kind, stage, stars = 0, opts = {}) {
  stage = Math.max(1, Math.min(5, Math.floor(Number(stage) || 1)));
  if (kind !== 'capybara') return makeForestBud(w, stage, stars, opts);
  const variant = 'default';
  const root = group(), body = group(root), head = group(root), eyes = [], core = [], limbs = [], wings = [];
  root.userData.companionVariant = variant;
  makeCapybara(w, root, body, head, eyes, limbs, core, stage);
  const tail = null;
  // All 5 stages change proportions as well as physical equipment. The baby
  // has a broader head and shorter torso; mature companions have more neck.
  if (stage === 1) { head.scale.x *= 1.04; head.scale.y *= 1.02; body.scale.set(1.02, .90, 1.02); }
  if (stars > 0) {
    const badge = group(body, [.24, 1.28, .57]);
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
  const pet = { root, body, head, limbs, wings, eyes, tail, bodyBounds, bodyPoints: new Float32Array(bodyPoints), headY: head.position.y, bodyScaleY: body.scale.y, kind, stage, variant, anatomyVertexCount: bodyPoints.length / 3,
    restHeadPosition: head.position.clone(), restHeadScale: head.scale.clone(), restBodyScale: body.scale.clone() };
  // Props are created after the anatomy projection and static batching. They
  // remain reusable, independently animated Workshop-owned scene resources.
  pet.interactions = makeCompanionInteractions(w, pet);
  return pet;
}

export function animateCompanion(pet, seconds, response, reducedMotion) {
  if (pet.disposed) return;
  if (pet.forestBud) return animateForestBud(pet, seconds, response, reducedMotion);
  const wave = reducedMotion ? 0 : Math.sin(seconds * 1.65);
  // The renderer owns outer yaw and x/z placement, and adds the scene's base y
  // after this call. Reset our local offset and every pose channel each frame.
  pet.root.position.y = 0;
  pet.body.scale.copy(pet.restBodyScale); pet.body.scale.y *= 1 + wave * .008;
  pet.body.rotation.set(0, 0, 0);
  pet.head.position.copy(pet.restHeadPosition); pet.head.position.y += wave * .012;
  pet.head.scale.copy(pet.restHeadScale);
  pet.head.rotation.set(0, Number(response?.look) || 0, wave * .012);
  for (let i = 0; i < pet.limbs.length; i++) {
    pet.limbs[i].rotation.set(wave * .012, 0, 0);
  }
  for (let i = 0; i < pet.wings.length; i++) pet.wings[i].rotation.set(0, (pet.wings[i].userData.baseY || 0) + (i ? 1 : -1) * wave * .028, 0);
  if (pet.tail) pet.tail.rotation.set(0, wave * .045, 0);
  const cycle = seconds % 5.3;
  const blink = !reducedMotion && cycle > 5.12 ? Math.max(.06, Math.abs(cycle - 5.21) / .09) : 1;
  pet.eyes.forEach(e => { e.scale.y = blink; });
  animateCompanionInteraction(pet, response, reducedMotion);
}
