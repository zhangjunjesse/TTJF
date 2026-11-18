import * as THREE from 'three';
import { group } from './primitives.js';
import { sculpture, sweep, lens, roundedPanel, ribbon, line } from './companion-sculpt.js';

// Visual stages follow the existing five growth stages. These palettes and
// clothes are presentation data; they do not introduce an unlock or currency.
const FORMS = [
  { skin: 0xa4c6a2, muzzle: 0xd0dfb0, belly: 0xeee5bf, dark: 0x638d78, horn: 0xe8dfba, wing: 0x91b998, light: 0xd2e6b0, accent: 0xeeb65f, cloth: 0xe5e8cc,
    headY: 1.72, headScale: [1.06, 1.02, .92], width: 1.02, height: 1.66, shoulder: 1.27, fin: .55, hornSize: .31, wingScale: .60, tailScale: .61 },
  { skin: 0x95b96c, muzzle: 0xcbdc8d, belly: 0xf0dda4, dark: 0x52845d, horn: 0xe9ca83, wing: 0x7fbc82, light: 0xd9e6a0, accent: 0xf1b953, cloth: 0xe99a59,
    headY: 1.88, headScale: [1, 1, .97], width: .94, height: 1.78, shoulder: 1.40, fin: .85, hornSize: .54, wingScale: .63, tailScale: .82 },
  { skin: 0x589fac, muzzle: 0x9acfc9, belly: 0xd7e5cf, dark: 0x376d81, horn: 0xd9e0bd, wing: 0x6bbdcd, light: 0xb5e2dc, accent: 0xecc477, cloth: 0x446b8d,
    headY: 2.00, headScale: [.98, 1.03, 1.03], width: .96, height: 1.90, shoulder: 1.49, fin: 1.03, hornSize: .76, wingScale: .72, tailScale: .96 },
  { skin: 0x9185bd, muzzle: 0xc6b8df, belly: 0xe3d5e4, dark: 0x61578e, horn: 0xc7ded8, wing: 0xaa98d4, light: 0xd5ccec, accent: 0x86d2c5, cloth: 0x52658e,
    headY: 2.10, headScale: [1.03, 1.06, 1.04], width: 1.04, height: 1.98, shoulder: 1.58, fin: 1.13, hornSize: .91, wingScale: .82, tailScale: .96 },
  { skin: 0xd5b169, muzzle: 0xf0d990, belly: 0xf0e4bd, dark: 0x8d8350, horn: 0xf2e1b1, wing: 0xe0c47c, light: 0xf1dfa5, accent: 0x62b49d, cloth: 0x418b7d,
    headY: 2.18, headScale: [1.06, 1.09, 1.06], width: 1.11, height: 2.04, shoulder: 1.65, fin: 1.20, hornSize: 1, wingScale: .80, tailScale: 1.04 }
];
const LEAF = [[0, -.30], [-.15, -.10], [-.18, .18], [0, .49], [.18, .18], [.15, -.10]];
const WINGS = [
  [[0, -.02], [.08, .27], [.25, .48], [.45, .54], [.49, .30], [.39, .08], [.18, -.08]],
  [[0, 0], [.20, .43], [.65, .76], [.85, .66], [.67, .30], [.93, .06], [.50, .08], [.37, -.18], [.18, -.07]],
  [[0, -.07], [.16, .38], [.62, .85], [1.22, .80], [1.07, .51], [.92, .29], [.76, .33], [.62, -.10], [.42, .04], [.21, -.09]],
  [[0, 0], [.16, .51], [.50, 1.05], [.90, 1.26], [.87, .86], [1.20, .52], [.90, .29], [.75, .37], [.60, -.16], [.39, .04], [.20, -.06]],
  [[0, -.05], [.09, .55], [.40, 1.16], [.65, 1.36], [.78, .94], [1.03, 1.10], [1.01, .65], [1.28, .74], [1.08, .29], [.81, .17], [.56, -.16], [.32, -.05]]
];
const GOLD = 0xd5b367, IVORY = 0xf4e9c8, CORAL = 0xd9786d;

export const dragonForm = stage => FORMS[stage - 1];

export function dragonCrystal(w, parent, pos, scale, tilt = 0, hex = 0x86d2c5) {
  return sculpture(w, parent, hex, [
    { y: 0, rx: .11, rz: .09 }, { y: .11, rx: .18, rz: .13 },
    { y: .34, rx: .12, rz: .10 }, { y: .55, rx: .012, rz: .01 }
  ], { sides: 5, position: pos, scale, rotation: [0, .13, tilt] });
}

export function makeDragonWing(w, root, side, stage, form) {
  const pivot = group(root, [side * .46, form.shoulder + .02, -.31]);
  pivot.name = 'dragon-wing-' + side;
  pivot.scale.set(side * form.wingScale, form.wingScale, form.wingScale);
  pivot.rotation.y = side * -.22;
  lens(w, pivot, form.wing, WINGS[stage - 1], .105);
  const tip = stage === 1 ? [.45, .54] : stage === 2 ? [.65, .76] : stage === 3 ? [1.22, .80] : stage === 4 ? [.90, 1.26] : [.65, 1.36];
  lens(w, pivot, form.light, [[.12, .12], [.20, tip[1] * .64], tip, [tip[0] * .60, tip[1] * .38]], .037, [0, 0, .079]);
  sweep(w, pivot, form.dark, [[0, -.02, .02], [.17, tip[1] * .48, .09], [tip[0] * .56, tip[1] * .88, .05], [...tip, .01]], [.060, .048, .030, .006]);
  if (stage >= 3) {
    const second = stage === 3 ? [.92, .29] : stage === 4 ? [1.20, .52] : [1.28, .74];
    sweep(w, pivot, form.dark, [[.13, .25, .07], [.45, .32, .11], [...second, .01]], [.034, .025, .006]);
  }
  if (stage >= 4) {
    lens(w, pivot, form.accent, [[-.06, 0], [0, -.09], [.07, 0], [0, .15]], .075, [...tip, .025]);
  }
  if (stage === 5) {
    sweep(w, pivot, form.dark, [[.18, .29, .08], [.53, .66, .10], [1.03, 1.10, .02]], [.029, .021, .005]);
    lens(w, pivot, form.accent, [[-.05, 0], [0, -.07], [.05, 0], [0, .12]], .065, [1.03, 1.10, .025]);
  }
  pivot.userData.baseY = pivot.rotation.y;
  w.bake(pivot); return pivot;
}

export function dragonTailTip(w, tail, stage, form) {
  const tip = group(tail, [1.30, .26, -.91]);
  if (stage === 4) {
    dragonCrystal(w, tip, [0, -.12, 0], [.55, .95, .55], -.30, form.accent);
    dragonCrystal(w, tip, [-.13, -.13, 0], [.36, .60, .40], .45, form.light);
    dragonCrystal(w, tip, [.11, -.11, -.03], [.34, .61, .36], -.75, form.muzzle);
    return;
  }
  const count = stage === 3 || stage === 5 ? 3 : 1;
  for (let i = 0; i < count; i++) {
    const leaf = lens(w, tip, i === 1 ? form.light : stage >= 3 ? form.accent : form.muzzle, LEAF, .075, [i ? (i - 1.5) * .13 : 0, 0, 0], [.2, .18, -.35 + (i ? (i - 1.5) * 1.3 : 0)]);
    leaf.scale.setScalar(stage === 1 ? .66 : stage === 5 ? 1.08 : .86);
  }
}

function eggShell(w, body, festival, form) {
  const sides = 16, vertices = [], indices = [];
  const lip = Array.from({ length: sides }, (_, i) => .65 + [0, .09, -.06, .16, -.035, .04, -.055, .14][i % 8]);
  const rings = [
    { radius: [.39, .34], heights: Array(sides).fill(.10) },
    { radius: [.65, .52], heights: Array(sides).fill(.32) },
    { radius: [.67, .54], heights: lip },
    { radius: [.61, .48], heights: lip.map(y => y - .015) },
    { radius: [.58, .45], heights: Array(sides).fill(.31) }
  ];
  // The irregular broken edge has an inner wall; it is not a flat front decal.
  rings.forEach(r => { for (let i = 0; i < sides; i++) { const a = i * Math.PI * 2 / sides; vertices.push(Math.cos(a) * r.radius[0], r.heights[i], .02 + Math.sin(a) * r.radius[1]); } });
  for (let r = 0; r < rings.length - 1; r++) for (let i = 0; i < sides; i++) { const a = r * sides + i, b = r * sides + (i + 1) % sides, c = b + sides, d = a + sides; indices.push(a, c, b, a, d, c); }
  const geometry = w.geometry('dragon-egg-' + (festival ? 'festival' : 'default'), () => {
    const indexed = new THREE.BufferGeometry();
    indexed.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); indexed.setIndex(indices);
    const flat = indexed.toNonIndexed(); indexed.dispose(); flat.computeVertexNormals(); return flat;
  });
  w.add(body, geometry, festival ? 0xe8b5b5 : form.cloth);
  line(w, body, festival ? 0xc67581 : 0x8da997, [[-.26, .52, .533], [-.16, .42, .55], [-.23, .34, .55], [-.07, .24, .51]], .013);
  for (const side of [-1, 1]) {
    const patch = lens(w, body, festival ? IVORY : 0x8ab8ad, [[-.09, 0], [0, -.08], [.10, 0], [0, .13]], .018, [side * .40, .40, .45], [0, side * .35, side * .22]);
    patch.scale.setScalar(festival ? 1.25 : 1);
  }
}

function neckerchief(w, body, form, main, light, fit) {
  const y = form.collarY ?? form.shoulder + .23;
  const ends = form.forestBud ? [.31, .23] : [.39, .27];
  const layer = form.forestBud ? (x, at) => fit(x, at) + .030 : fit;
  ribbon(w, body, main, [[-ends[0], y, .19], [-ends[1], y - .08, .42], [0, y - .14, .54], [ends[1], y - .08, .42], [ends[0], y, .18]], form.forestBud ? .13 : .18, .045, layer);
  const front = fit(.03, y - .14);
  lens(w, body, light, [[-.17, .10], [.18, .04], [.03, -.33]], .042, [.03, y - .14, Number.isFinite(front) ? front + .055 : .58], [-.15, 0, -.12]);
}

function forestCape(w, back, main, trim, length, width, shoulder) {
  // Two joined cloth panels leave a real opening around the central tail root.
  // A closed, uncut mantle would be pierced by the living tail in back views.
  const rows = 20, columns = 10;
  const gap = y => .36 * (1 - THREE.MathUtils.smoothstep(shoulder + y, .70, 1.04));
  const outer = t => .35 + (width - .35) * Math.sin(t * Math.PI / 2) ** .8;
  const zAt = t => -.30 * Math.sin(t * Math.PI / 2) ** .8 - .07 * t;
  for (const side of [-1, 1]) {
    const positions = [], indices = [], faceSize = (rows + 1) * (columns + 1);
    for (const face of [0, 1]) for (let row = 0; row <= rows; row++) {
      const t = row / rows, y = -length * t, inner = gap(y), edge = outer(t);
      for (let column = 0; column <= columns; column++) {
        const u = column / columns, x = inner + (edge - inner) * u;
        positions.push(side * x, y, zAt(t) + .025 * face - .025 * Math.sin(t * Math.PI) * u * u);
        if (row < rows && column < columns) {
          const a = face * faceSize + row * (columns + 1) + column, b = a + columns + 1;
          const faceIndices = side * (face ? -1 : 1) > 0 ? [a, a + 1, b, b, a + 1, b + 1] : [a, b, a + 1, b, b + 1, a + 1];
          indices.push(...faceIndices);
        }
      }
    }
    const rim = [];
    for (let column = 0; column <= columns; column++) rim.push(column);
    for (let row = 1; row <= rows; row++) rim.push(row * (columns + 1) + columns);
    for (let column = columns - 1; column >= 0; column--) rim.push(rows * (columns + 1) + column);
    for (let row = rows - 1; row > 0; row--) rim.push(row * (columns + 1));
    rim.forEach((a, i) => { const b = rim[(i + 1) % rim.length]; indices.push(a, b, a + faceSize, b, b + faceSize, a + faceSize); });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices);
    geometry.computeVertexNormals(); w.geometries.add(geometry); w.add(back, geometry, main);
    const inner = gap(-length), edge = outer(1), z = zAt(1) - .008;
    ribbon(w, back, trim, [[side * (inner + .025), -length + .012, z], [side * ((inner + edge) / 2), -length - .004, z], [side * (edge - .025), -length + .012, z]], .045, .018);
  }
}

function cape(w, body, form, main, trim, length = 1.07, width = .70) {
  const back = group(body, [0, form.shoulder + .18, form.forestBud ? -.31 : -.38]);
  if (form.forestBud) forestCape(w, back, main, trim, length, width, form.shoulder + .18);
  else {
    sculpture(w, back, main, [
    { y: -length, rx: width * .90, rz: .08, z: -.37 },
    { y: -length * .77, rx: width, rz: .12, z: -.31 },
    { y: -length * .34, rx: width * .80, rz: .14, z: -.15 },
    { y: 0, rx: .35, rz: .12, z: 0 }
  ], { sides: 12, power: 3 });
    ribbon(w, back, trim, [[-width * .86, -length + .025, -.42], [-width * .46, -length - .01, -.44], [0, -length - .02, -.46], [width * .46, -length - .01, -.44], [width * .86, -length + .025, -.42]], .065, .025);
  }
  for (const side of [-1, 1]) ribbon(w, body, trim, form.forestBud ? [[side * .24, form.shoulder + .19, -.23], [side * .35, form.shoulder + .15, .04], [side * .25, form.shoulder + .06, .41]] : [[side * .30, form.shoulder + .19, -.19], [side * .46, form.shoulder + .15, .07], [side * .33, form.shoulder + .06, .41]], form.forestBud ? .07 : .10, .045, form.bodyFit);
  return back;
}

function bow(w, parent, pos, main, light, size = 1) {
  const root = group(parent, pos); root.scale.setScalar(size);
  for (const side of [-1, 1]) {
    lens(w, root, main, [[0, 0], [side * .27, .14], [side * .32, -.09], [side * .18, -.15]], .06);
    lens(w, root, light, [[side * .035, -.04], [side * .18, -.11], [side * .17, -.35], [side * .08, -.29]], .027, [0, 0, -.02]);
  }
  roundedPanel(w, root, light, .14, .17, .07, .035, [0, -.005, .045]);
}

function crown(w, head, form, festival) {
  const main = festival ? 0xb75765 : form.cloth;
  ribbon(w, head, GOLD, [[-.45, .39, .13], [-.23, .48, .30], [0, .51, .36], [.23, .48, .30], [.45, .39, .13]], .12, .048, form.headFit);
  for (const side of [-1, 0, 1]) {
    const front = form.headFit?.(side * .24, .47);
    const z = Number.isFinite(front) ? front + .035 : .25 - Math.abs(side) * .05;
    lens(w, head, GOLD, [[-.11, 0], [-.095, .17], [0, side ? .30 : .40], [.095, .17], [.11, 0]], .06, [side * .24, .47, z]);
    dragonCrystal(w, head, [side * .24, .58, z + .04], [side ? .34 : .43, side ? .36 : .55, .32], side * -.20, main);
  }
}

function shoulderPlates(w, limbs, main, trim) {
  limbs.forEach((arm, i) => {
    const side = i ? 1 : -1;
    lens(w, arm, trim, [[-.21, -.12], [-.24, .04], [-.10, .18], [.13, .17], [.24, .03], [.21, -.12]], .08, [side * .055, -.04, .13]);
    lens(w, arm, main, [[-.16, -.07], [-.17, .035], [-.075, .13], [.10, .13], [.17, .03], [.15, -.07]], .07, [side * .055, -.04, .205]);
  });
}

function waistcoat(w, body, form, main, trim, fit, long = false) {
  for (const side of [-1, 1]) {
    ribbon(w, body, main, [[side * (form.forestBud ? .23 : .31), form.shoulder + .16, .23], [side * (form.forestBud ? .31 : .35), 1.37, .41], [side * .34, 1.04, .51], [side * .29, long ? .50 : .77, .45]], form.forestBud ? .20 : .27, .045, fit);
    ribbon(w, body, trim, [[side * (form.forestBud ? .16 : .27), form.shoulder + .15, .29], [side * (form.forestBud ? .22 : .19), 1.35, .53], [side * (form.forestBud ? .24 : .22), 1.05, .55]], .045, .020, (x, y) => fit(x, y) + .045);
  }
  const beltFit = form.forestBud ? (x, y) => fit(x, y) + .035 : fit;
  ribbon(w, body, trim, [[-.45, .85, .36], [-.27, .84, .49], [0, .83, .54], [.27, .84, .49], [.45, .85, .36]], .10, .035, beltFit);
  roundedPanel(w, body, GOLD, .15, .15, .03, .025, [0, .84, fit(0, .84) + (form.forestBud ? .115 : .075)]);
}

function handProp(w, arm, side, color, topColor, type, hand = null) {
  const prop = group(hand || arm, hand ? [0, -.035, .075] : [side * .19, -.52, .39]);
  prop.name = 'dragon-held-' + type;
  if (hand) { prop.userData.heldOrientation = [0, 0, -side * .20]; prop.userData.heldSide = side; }
  sweep(w, prop, color, [[0, -.51, 0], [0, .03, 0], [0, .73, 0]], [.029, .032, .022]);
  if (type === 'crystal') {
    dragonCrystal(w, prop, [0, .69, 0], [.90, .90, .90], 0, topColor);
    for (const s of [-1, 1]) sweep(w, prop, GOLD, [[0, .63, 0], [s * .14, .75, 0], [s * .13, .89, 0]], [.025, .022, .008]);
  } else if (type === 'leaf') {
    for (const s of [-1, 1]) lens(w, prop, topColor, LEAF, .055, [s * .09, .81, 0], [0, 0, s * -.52]);
  } else if (type === 'flag') {
    lens(w, prop, topColor, [[0, 0], [.43, -.08], [.27, -.23], [.40, -.39], [0, -.32]], .035, [.025, .69, 0]);
    w.star(prop, IVORY, [.15, .54, .05], .085);
  } else if (type === 'lantern') {
    // A left-hand lantern hangs outside the body instead of through the belly.
    const x = hand ? side * .27 : .27;
    line(w, prop, GOLD, [[0, .74, 0], [x * .45, .86, 0], [x, .79, 0], [x, .65, 0]], .025);
    sculpture(w, prop, topColor, [{ y: .25, rx: .10, rz: .12 }, { y: .34, rx: .20, rz: .16 }, { y: .53, rx: .20, rz: .16 }, { y: .61, rx: .10, rz: .12 }], { sides: 8, position: [x, 0, 0] });
    for (const y of [.27, .59]) roundedPanel(w, prop, GOLD, .24, .045, .22, .02, [x, y, -.11]);
    lens(w, prop, IVORY, [[-.035, 0], [0, -.06], [.035, 0], [0, .09]], .02, [x, .43, .175]);
    sweep(w, prop, GOLD, [[x, .25, 0], [x, .12, 0], [x + side * .03, .06, 0]], [.018, .018, .006]);
  } else {
    w.star(prop, topColor, [0, .80, .02], .23);
    w.star(prop, IVORY, [0, .80, .064], .10);
  }
}

function travelBag(w, body, form, fit) {
  const layer = form.forestBud ? (x, y) => fit(x, y) + .075 : fit;
  ribbon(w, body, 0x795d46, [[-.39, form.shoulder + .17, .18], [-.23, 1.42, .47], [.05, 1.10, .59], [.42, .75, .40]], .115, .035, layer);
  const bag = group(body, form.forestBud ? [.64, .64, -.09] : [.61, .74, .13]); bag.rotation.set(0, .28, -.13);
  roundedPanel(w, bag, form.cloth, .43, .46, .20, .08, [0, 0, 0]);
  roundedPanel(w, bag, 0x799caa, .45, .22, .045, .04, [0, .16, .20]);
  roundedPanel(w, bag, GOLD, .075, .12, .02, .01, [0, .055, .25]);
  const map = group(bag, [0, .30, -.01]);
  sweep(w, map, IVORY, [[-.24, 0, 0], [.24, 0, 0]], [.07, .07]);
  ribbon(w, map, form.cloth, [[-.03, .07, 0], [-.03, .03, .075], [-.03, -.05, .075]], .045, .02);
}

function defaultClothes(w, body, head, limbs, stage, form, fit) {
  // The approved Forest Bud newborn keeps its whole pear-shaped body and tail.
  if (stage === 1) { if (!form.forestBud) eggShell(w, body, false, form); return; }
  if (stage === 2) {
    neckerchief(w, body, form, form.cloth, form.accent, fit);
    const y = form.forestBud ? form.collarY - .12 : 1.54;
    bow(w, body, [-.28, y, fit(-.28, y) + .07], form.cloth, IVORY, .40);
    return;
  }
  if (stage === 3) {
    neckerchief(w, body, form, form.cloth, 0x95bdc8, fit);
    waistcoat(w, body, form, form.cloth, GOLD, fit);
    travelBag(w, body, form, fit); return;
  }
  cape(w, body, form, form.cloth, stage === 4 ? form.accent : GOLD, stage === 4 ? 1.10 : 1.39, stage === 4 ? .67 : .76);
  shoulderPlates(w, limbs, stage === 4 ? form.accent : form.cloth, GOLD);
  waistcoat(w, body, form, form.cloth, stage === 4 ? form.accent : GOLD, fit, stage === 5);
  const front = fit(0, form.shoulder + .025);
  lens(w, body, GOLD, [[-.13, 0], [0, -.16], [.13, 0], [0, .16]], .045, [0, form.shoulder + .025, front + .055]);
  dragonCrystal(w, body, [0, form.shoulder - .025, front + .095], [.48, .45, .34], 0, form.accent);
  handProp(w, limbs[0], -1, 0x837057, form.accent, stage === 4 ? 'crystal' : 'leaf', form.hands?.[0]);
  if (stage === 5) crown(w, head, form, false);
}

function flower(w, head, form) {
  const root = group(head, form.forestBud ? [-.78, .16, .10] : [-.42, .47, .03]); root.rotation.z = .23;
  if (form.forestBud) root.scale.setScalar(.72);
  for (let i = 0; i < 7; i++) {
    const angle = i * Math.PI * 2 / 7;
    const petal = lens(w, root, i % 2 ? 0xf0b1a8 : CORAL, LEAF, .045, [Math.sin(angle) * .12, Math.cos(angle) * .12, 0], [0, 0, -angle]);
    petal.scale.set(.46, .50, .60);
  }
  dragonCrystal(w, root, [0, -.045, .075], [.54, .30, .40], 0, form.accent);
}

function festivalBaby(w, body, head, limbs, form, fit) {
  if (!form.forestBud) eggShell(w, body, true, form);
  neckerchief(w, body, form, 0xd77e8d, 0xf4bdc1, fit);
  bow(w, body, [0, 1.25, fit(0, 1.25) + .075], 0xc96c82, 0xf2b5b4, form.forestBud ? .82 : 1.08);
  const hat = form.forestBud ? group(head, [0, .10, 0]) : head;
  sculpture(w, hat, 0xe9a0a6, [{ y: .44, rx: .29, rz: .25 }, { y: .55, rx: .25, rz: .22, x: -.02 }, { y: 1.10, rx: .012, rz: .012, x: -.15 }], { sides: 8 });
  ribbon(w, hat, IVORY, [[-.24, .56, .13], [0, .53, .25], [.22, .56, .13]], .095, .026);
  w.star(hat, GOLD, [-.15, 1.10, .02], .10);
  handProp(w, limbs[0], -1, 0xb48265, 0xeeb76b, 'star', form.hands?.[0]);
}

function festivalGarden(w, body, head, limbs, form, fit) {
  cape(w, body, form, CORAL, 0xf1c28e, .83, .64);
  waistcoat(w, body, form, 0xd67b70, IVORY, fit);
  bow(w, body, [0, form.shoulder + .01, fit(0, form.shoulder + .01) + .065], CORAL, 0xf3c9ac, .85);
  flower(w, head, form);
  const hand = form.hands?.[1];
  const pinwheel = group(hand || limbs[1], hand ? [.02, -.02, .08] : [.17, -.26, .44]);
  pinwheel.name = 'dragon-held-pinwheel';
  if (hand) { pinwheel.userData.heldOrientation = [0, 0, -.17]; pinwheel.userData.heldSide = 1; }
  sweep(w, pinwheel, 0xad8057, [[0, -.44, 0], [0, .51, 0]], [.026, .022]);
  for (let i = 0; i < 4; i++) lens(w, pinwheel, i % 2 ? 0xd98370 : 0xf0c56f, [[0, 0], [.26, .13], [.24, .32], [.06, .27]], .04, [0, .48, .025], [0, 0, i * Math.PI / 2]);
  dragonCrystal(w, pinwheel, [0, .44, .08], [.26, .24, .28], 0, IVORY);
}

function festivalMusician(w, body, head, limbs, form, fit) {
  cape(w, body, form, 0x74609c, 0xd99db4, 1.17, .66);
  waistcoat(w, body, form, 0x78639e, 0xe9bb8b, fit, true);
  const bowY = form.forestBud ? 1.49 : 1.65;
  bow(w, body, [0, bowY, fit(0, bowY) + .06], 0xe1a3b5, IVORY, .67);
  const hat = form.forestBud ? group(head, [0, .14, 0]) : head;
  sculpture(w, hat, 0x514e7c, [{ y: .43, rx: .44, rz: .35 }, { y: .50, rx: .44, rz: .35 }, { y: .51, rx: .29, rz: .26 }, { y: .96, rx: .33, rz: .28 }], { sides: 12, power: 3 });
  ribbon(w, hat, 0xd7a8c4, [[-.29, .64, .07], [-.18, .62, .26], [0, .62, .29], [.18, .62, .26], [.29, .64, .07]], .12, .025);
  w.star(hat, GOLD, [.04, .79, .295], .10);
  const drum = group(body, [0, .79, .66]);
  w.cylinder(drum, 0xc58aa3, [0, 0, 0], .30, .28, .30, [Math.PI / 2, 0, 0]);
  w.cylinder(drum, GOLD, [0, 0, .16], .315, .035, .315, [Math.PI / 2, 0, 0]);
  w.cylinder(drum, IVORY, [0, 0, .185], .276, .025, .276, [Math.PI / 2, 0, 0]);
  w.star(drum, 0x8a75ad, [0, 0, .21], .13);
  limbs.forEach((arm, i) => {
    const hand = form.hands?.[i], side = i ? 1 : -1;
    const stick = sweep(w, hand || arm, 0xba925d, hand ? [[0, -.035, .07], [-side * .33, .045, .51]] : [[side * .11, -.51, .40], [-side * .09, -.20, .60]], [.024, .035]);
    if (hand) { stick.name = 'dragon-held-drumstick'; stick.userData.heldOrientation = [0, 0, 0]; }
  });
}

function festivalKnight(w, body, head, limbs, form, fit) {
  cape(w, body, form, 0xefdbb0, 0xd9a661, 1.18, .75);
  waistcoat(w, body, form, 0xcc8462, GOLD, fit, true);
  shoulderPlates(w, limbs, 0xe0a171, GOLD);
  ribbon(w, head, GOLD, [[-.40, .40, .16], [0, .49, .32], [.40, .40, .16]], .07, .04, form.headFit);
  dragonCrystal(w, head, [0, .48, (form.headFit?.(0, .48) ?? .30) + .04], [.38, .40, .32], 0, 0xe4aa79);
  const hand = form.hands?.[0];
  const shield = group(hand || limbs[0], hand ? [-.02, -.035, .095] : [-.10, -.47, .46]);
  shield.name = 'dragon-held-shield';
  if (hand) shield.userData.heldOrientation = [0, 0, 0];
  lens(w, shield, GOLD, [[-.28, .28], [0, .36], [.28, .28], [.25, -.16], [0, -.38], [-.25, -.16]], .105);
  lens(w, shield, 0xcf8563, [[-.22, .23], [0, .29], [.22, .23], [.19, -.12], [0, -.29], [-.19, -.12]], .07, [0, 0, .10]);
  w.star(shield, IVORY, [0, .015, .19], .15);
  handProp(w, limbs[1], 1, 0x96734e, 0xd98f67, 'flag', form.hands?.[1]);
}

function festivalRoyal(w, body, head, limbs, form, fit) {
  cape(w, body, form, 0xba5c6c, IVORY, 1.47, .83);
  waistcoat(w, body, form, 0xb95c6d, GOLD, fit, true);
  shoulderPlates(w, limbs, 0xc87980, IVORY);
  neckerchief(w, body, form, 0xb95669, IVORY, fit);
  for (const side of [-1, 1]) ribbon(w, body, IVORY, [[side * .34, form.shoulder + .15, .26], [side * .23, 1.49, .47], [0, 1.28, .58]], .075, .04, fit);
  crown(w, head, form, true);
  handProp(w, limbs[0], -1, GOLD, 0xe4a373, 'lantern', form.hands?.[0]);
  w.star(body, GOLD, [.20, 1.02, fit(.20, 1.02) + .07], .095);
}

export function dressDragon(w, body, head, limbs, stage, form, variant, fit) {
  if (variant !== 'festival') { defaultClothes(w, body, head, limbs, stage, form, fit); return; }
  const outfits = [festivalBaby, festivalGarden, festivalMusician, festivalKnight, festivalRoyal];
  outfits[stage - 1](w, body, head, limbs, form, fit);
}

export function makeDragonDetails(w, pet) {
  const anchors = pet.anchors;
  const form = dragonForm(pet.stage), root = group(anchors?.puppet || pet.root);
  root.name = 'dragon-growth-details'; root.userData.companionDecoration = true;
  const count = anchors && pet.stage === 1 ? 0 : pet.stage < 3 ? 1 : pet.stage < 5 ? 2 : 3, details = [];
  for (let i = 0; i < count; i++) {
    // A few opaque, low-poly glints stay beside the tail and wing edges, well
    // below the crown. They remain legible in the neutral reduced-motion pose.
    const side = i % 2 ? -1 : 1;
    let parent = root, position = [side * (pet.stage < 3 ? .89 : 1.12), 1.00 + i * .31, -.20];
    if (anchors) {
      const wing = anchors.wings[i % 2 ? 0 : 1];
      // Decorations sit on the living outer leaf. They follow its growth and
      // movement instead of floating beside the old dragon's static bounds.
      parent = wing.getObjectByName('forest-bud-grown-leaf-fan') || wing;
      position = [side * (i === 2 ? .49 : .35), i === 2 ? -.26 : -.025, -.045];
    }
    const item = group(parent, position);
    item.name = 'dragon-leaf-growth-glint';
    item.userData.companionDecoration = true;
    if (pet.stage <= 2 || pet.stage === 5) {
      const leaf = lens(w, item, i % 2 ? form.light : form.accent, LEAF, .035, null, [0, .12, side * -.60]);
      leaf.scale.set(anchors ? .23 : .33, anchors ? .22 : .30, anchors ? .26 : .36);
    } else {
      lens(w, item, form.accent, [[-.06, 0], [0, -.13], [.06, 0], [0, .15]], .045);
    }
    w.bake(item);
    item.traverse(mesh => { if (mesh.isMesh) { mesh.userData.noShadow = true; mesh.castShadow = false; mesh.receiveShadow = false; } });
    details.push({ root: item, position: item.position.clone(), phase: i * 1.7, attached: !!anchors });
  }
  return details;
}

export function animateDragonDetails(details, seconds, reducedMotion) {
  for (const item of details || []) {
    const amount = reducedMotion ? 0 : Math.sin(seconds * .82 + item.phase);
    item.root.position.copy(item.position);
    if (!item.attached) item.root.position.y += amount * .025;
    item.root.rotation.z = amount * (item.attached ? .025 : .07);
    item.root.scale.setScalar(1 + amount * .035);
  }
}
