import * as THREE from 'three';
import { makeEye } from './eyes.js';

// Approved product sculpt. +Y is up and +Z faces the camera; root is the neck joint.
// The skull, cheeks, short snout, and lower jaw share one closed, rounded skin.
// Face features and the separate eyes query that same surface, including its
// shallow sockets. Mouth and nostrils are rendered directly in this skin.
// 2026-11-18: 24,249 finite skull vertices, no flipped faces, residual <=
// 6.42e-8. Combined head: 59 meshes / 117,568 triangles, build 638ms,
// 120 blink frames 180ms. Syntax and shader-hook checks passed.
const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp;
const mix = THREE.MathUtils.lerp;
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const gauss = (x, center, width) => Math.exp(-(((x - center) / width) ** 2));
const smooth = (a, b, value) => {
  const t = clamp((value - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// Every growth stage uses this same approved sculpt. Cache only immutable CPU
// numbers, never scene objects, live expression geometry or GPU allocations.
// Reopening the gallery then avoids solving the implicit skull again.
const skullTemplates = new Map();
const skinProjectionCache = new Map();

function microTexture() {
  const side = 128;
  const data = new Uint8Array(side * side * 4);
  let seed = 914872;
  for (let i = 0; i < side * side; i++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    const value = 110 + Math.round((seed / 4294967296) * 34);
    data.set([value, value, value, 255], i * 4);
  }
  const texture = new THREE.DataTexture(data, side, side, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(12, 9);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

// A distance-like ellipsoid field preserves an actual round section, unlike a
// front-only height bump whose narrow crest becomes a spike from the side.
function ellipsoid(x, y, z, cx, cy, cz, rx, ry, rz) {
  const px = (x - cx) / rx, py = (y - cy) / ry, pz = (z - cz) / rz;
  const k0 = Math.hypot(px, py, pz);
  const k1 = Math.hypot(px / rx, py / ry, pz / rz);
  return k1 < .0000001 ? -Math.min(rx, ry, rz) : k0 * (k0 - 1) / k1;
}

function union(a, b, radius) {
  const h = Math.max(radius - Math.abs(a - b), 0) / radius;
  return Math.min(a, b) - h * h * radius * .25;
}

function headField(x, y, z) {
  const skull = ellipsoid(x, y, z, 0, .625, -.015, .685, .555, .540);
  const jaw = ellipsoid(x, y, z, 0, .225, .080, .530, .275, .435);
  const leftCheek = ellipsoid(x, y, z, -.410, .360, .135, .290, .265, .415);
  const rightCheek = ellipsoid(x, y, z, .410, .360, .135, .290, .265, .415);
  const nose = ellipsoid(x, y, z, 0, .342, .385, .375, .225, .380);
  const lowerSnout = ellipsoid(x, y, z, 0, .205, .320, .340, .175, .310);
  const cheeks = union(leftCheek, rightCheek, .14);
  const snout = union(nose, lowerSnout, .13);
  let field = union(union(skull, jaw, .20), cheeks, .19);
  field = union(field, snout, .17);

  // These are small surface recesses, not the source of the head silhouette.
  // The socket stays shallow enough to retain a full baby-dragon forehead.
  const front = smooth(.10, .40, z);
  const sockets = .013 * (gauss(x, -.328, .188) + gauss(x, .328, .188)) * gauss(y, .641, .190);
  return field + sockets * front;
}

function skinZ(x, y) {
  const key = x + ':' + y;
  if (skinProjectionCache.has(key)) return skinProjectionCache.get(key);
  // Find the visible front root of the very same implicit skin that is meshed
  // below. All eye and marking vertices use this projection.
  let inside = -.055;
  if (headField(x, y, inside) > 0) {
    let nearest = Infinity;
    for (let i = 0; i <= 24; i++) {
      const candidate = -.50 + i * .055;
      const value = headField(x, y, candidate);
      if (value < nearest) { nearest = value; inside = candidate; }
    }
  }
  let outside = .98;
  for (let i = 0; i < 27; i++) {
    const middle = (inside + outside) * .5;
    if (headField(x, y, middle) < 0) inside = middle;
    else outside = middle;
  }
  const depth = (inside + outside) * .5;
  if (skinProjectionCache.size < 8192) skinProjectionCache.set(key, depth);
  return depth;
}

function skinNormal(x, y, z) {
  const e = .00035;
  return V(headField(x + e, y, z) - headField(x - e, y, z),
    headField(x, y + e, z) - headField(x, y - e, z),
    headField(x, y, z + e) - headField(x, y, z - e)).normalize();
}

const skinBase = new THREE.Color('#b5cd78');
const skinWarm = new THREE.Color('#d0d991');
const cheekWarm = new THREE.Color('#f0c398');
const cheekBlush = new THREE.Color('#e6ac89');
const muzzleWarm = new THREE.Color('#d7dfa0');
const skinBack = new THREE.Color('#9ab871');
function skinColor(x, y, front = 1) {
  const color = skinBase.clone();
  color.lerp(skinBack, (1 - front) * .58);
  color.lerp(skinWarm, .23 * gauss(y, .85, .43) * front);
  const cheek = Math.min(1, (gauss(x, -.47, .20) + gauss(x, .47, .20)) * gauss(y, .35, .175)) * Math.pow(front, .55);
  color.lerp(cheekWarm, .94 * cheek);
  color.lerp(cheekBlush, .38 * cheek * gauss(y, .38, .115));
  color.lerp(muzzleWarm, .42 * gauss(x, 0, .29) * gauss(y, .35, .17) * front);
  color.lerp(new THREE.Color('#e1d6a0'), .28 * gauss(y, -.002, .09) * front);
  return color;
}

// Mouth and nostrils are pigment on the exact skin fragments. Their depth is
// the skull depth, so there is no second surface to shimmer against the mesh.
// Pixel derivatives keep the strokes smooth at every scale and viewing angle.
function paintFace(material) {
  const linear = hex => {
    const c = new THREE.Color(hex);
    return `vec3(${c.r.toFixed(6)}, ${c.g.toFixed(6)}, ${c.b.toFixed(6)})`;
  };
  material.customProgramCacheKey = () => 'bud-skin-pigment-v4';
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBudSkinPosition;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBudSkinPosition = position;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `
      #include <common>
      varying vec3 vBudSkinPosition;
      float budBell(float value, float center, float width) {
        float q = (value - center) / width;
        return exp(-q * q);
      }
      float budStroke(float distance, float radius) {
        float aa = max(fwidth(distance) * .80, .00035);
        return 1.0 - smoothstep(radius - aa, radius + aa, distance);
      }
      float budSmile(vec2 p) {
        float ax = abs(p.x);
        float r = min(ax / .342, 1.0);
        float y = .182 + .094 * pow(r, 1.85);
        float slope = (.094 * 1.85 / .342) * pow(r, .85);
        float distance = abs(p.y - y) / sqrt(1.0 + slope * slope);
        float taper = 1.0 - smoothstep(.316, .350, ax);
        float line = budStroke(distance, .0038 + .0013 * sqrt(max(0.0, 1.0 - r * r))) * taper;
        // A single short tapered corner continues the smile without beads.
        vec2 q = vec2(ax, p.y);
        vec2 a = vec2(.336, .273), b = vec2(.346, .300);
        vec2 ab = b - a;
        float t = clamp(dot(q - a, ab) / dot(ab, ab), 0.0, 1.0);
        float corner = budStroke(length(q - mix(a, b, t)), mix(.0032, .0006, t));
        corner *= 1.0 - smoothstep(.72, 1.0, t);
        return max(line, corner);
      }
      float budNostril(vec2 p) {
        // Mirror the same short diagonal curved slit onto the two nose wings.
        vec2 q = vec2(abs(p.x) - .147, p.y - .388);
        vec2 a = vec2(-.016, -.010), b = vec2(-.008, .026), c = vec2(.015, .015);
        float mask = 0.0;
        for (int i = 0; i < 10; i++) {
          float t0 = float(i) * .1, t1 = t0 + .1;
          vec2 start = mix(mix(a, b, t0), mix(b, c, t0), t0);
          vec2 finish = mix(mix(a, b, t1), mix(b, c, t1), t1);
          vec2 ab = finish - start;
          float h = clamp(dot(q - start, ab) / dot(ab, ab), 0.0, 1.0);
          float t = mix(t0, t1, h);
          float radius = .0007 + .0051 * pow(max(0.0, sin(3.14159265 * t)), .70);
          mask = max(mask, budStroke(length(q - mix(start, finish, h)), radius));
        }
        return mask;
      }
    `).replace('#include <color_fragment>', `
      #include <color_fragment>
      vec3 budP = vBudSkinPosition;
      float budFront = smoothstep(.33, .51, budP.z);
      vec2 budPadUV = vec2(budP.x / .339, (budP.y - .350) / .184);
      float budPad = (1.0 - smoothstep(.70, 1.14, length(budPadUV))) * budFront;
      // The pale pistachio pad reads as a soft volume, with no drawn outline.
      diffuseColor.rgb = mix(diffuseColor.rgb, ${linear('#d8dfa2')}, .76 * budPad);
      float budWing = budBell(abs(budP.x), .290, .042) * budBell(budP.y, .347, .111) * budFront;
      diffuseColor.rgb = mix(diffuseColor.rgb, ${linear('#b8b781')}, .20 * budWing);
      float budCrown = budBell(budP.x, 0.0, .215) * budBell(budP.y, .425, .075) * budPad;
      diffuseColor.rgb = mix(diffuseColor.rgb, ${linear('#e1e6af')}, .16 * budCrown);
      float budSmileMask = budSmile(budP.xy) * budFront;
      diffuseColor.rgb = mix(diffuseColor.rgb, ${linear('#89764d')}, .91 * budSmileMask);
      float budNoseMask = budNostril(budP.xy) * smoothstep(.58, .67, budP.z);
      diffuseColor.rgb = mix(diffuseColor.rgb, ${linear('#62613b')}, .97 * budNoseMask);
    `);
  };
}

function bufferMesh(name, positions, indices, material, colors, uv) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (colors) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  if (uv) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.userData.companionAnatomy = name === 'smooth-union rounded skull snout cheeks and jaw'
    || name === 'folded succulent leaf with front and back';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function makeSkull(material, low) {
  const skullTemplate=skullTemplates.get(low);
  if (skullTemplate) {
    const geometry = new THREE.BufferGeometry();
    for (const [name, item] of Object.entries(skullTemplate.attributes)) {
      geometry.setAttribute(name, new THREE.BufferAttribute(item.array.slice(), item.itemSize));
    }
    geometry.setIndex(new THREE.BufferAttribute(skullTemplate.index.slice(), 1));
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'smooth-union rounded skull snout cheeks and jaw';
    mesh.userData.companionAnatomy = true;
    mesh.castShadow = true; mesh.receiveShadow = true;
    return mesh;
  }
  const positions = [], normals = [], colors = [], uv = [], indices = [];
  const rows = low?76:136, columns = low?96:176;
  for (let row = 0; row <= rows; row++) {
    const theta = row / rows * Math.PI;
    for (let column = 0; column <= columns; column++) {
      const phi = column / columns * TAU;
      const dx = Math.sin(theta) * Math.cos(phi), dy = Math.cos(theta), dz = Math.sin(theta) * Math.sin(phi);
      let inside = 0, outside = 1.55;
      for (let i = 0; i < 27; i++) {
        const distance = (inside + outside) * .5;
        if (headField(dx * distance, .56 + dy * distance, -.035 + dz * distance) < 0) inside = distance;
        else outside = distance;
      }
      const distance = (inside + outside) * .5;
      const x = dx * distance, y = .56 + dy * distance, z = -.035 + dz * distance;
      positions.push(x, y, z);
      const normal = skinNormal(x, y, z);
      normals.push(normal.x, normal.y, normal.z);
      const front = smooth(-.14, .55, normal.z);
      const color = skinColor(x, y, front);
      colors.push(color.r, color.g, color.b);
      uv.push(column / columns, row / rows);
      if (row < rows && column < columns) {
        const a = row * (columns + 1) + column, b = a + columns + 1;
        indices.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
  }
  const mesh = bufferMesh('smooth-union rounded skull snout cheeks and jaw', positions, indices, material, colors, uv);
  // Field normals also match at the UV seam and pole vertices.
  mesh.geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  skullTemplates.set(low, { attributes:Object.fromEntries(Object.entries(mesh.geometry.attributes)
    .map(([name, attribute]) => [name, {array:attribute.array.slice(), itemSize:attribute.itemSize}])),
    index:mesh.geometry.index.array.slice() });
  return mesh;
}

// Sweep an actual round section along a curve, with a tapered radius.
function sweep(name, sample, radiusAt, material, segments = 48, sides = 10, colorAt, density=1) {
  segments=Math.max(12,Math.round(segments*density));sides=Math.max(5,Math.round(sides*density));
  const positions = new Float32Array((segments + 1) * (sides + 1) * 3);
  const normals = new Float32Array(positions.length);
  const colors = colorAt ? new Float32Array(positions.length) : null;
  const indices = [], uv = [];
  const geometry = new THREE.BufferGeometry();
  for (let i = 0; i <= segments; i++) {
    for (let j = 0; j <= sides; j++) {
      uv.push(j / sides, i / segments);
      if (i < segments && j < sides) {
        const a = i * (sides + 1) + j, b = a + sides + 1;
        indices.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (colors) geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  function refresh() {
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const point = sample(t);
      const tangent = sample(Math.min(1, t + .002)).sub(sample(Math.max(0, t - .002))).normalize();
      let normal = V(-tangent.y, tangent.x, 0);
      if (normal.lengthSq() < .00001) normal = V(1, 0, 0);
      normal.normalize();
      const binormal = tangent.clone().cross(normal).normalize();
      const radius = radiusAt(t);
      for (let j = 0; j <= sides; j++) {
        const angle = j / sides * TAU;
        const direction = normal.clone().multiplyScalar(Math.cos(angle)).addScaledVector(binormal, Math.sin(angle));
        const offset = (i * (sides + 1) + j) * 3;
        positions[offset] = point.x + direction.x * radius;
        positions[offset + 1] = point.y + direction.y * radius;
        positions[offset + 2] = point.z + direction.z * radius;
        normals[offset] = direction.x;
        normals[offset + 1] = direction.y;
        normals[offset + 2] = direction.z;
        if (colors) {
          const color = colorAt(t, j / sides);
          colors[offset] = color.r; colors[offset + 1] = color.g; colors[offset + 2] = color.b;
        }
      }
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.normal.needsUpdate = true;
    if (colors) geometry.attributes.color.needsUpdate = true;
    geometry.computeBoundingSphere();
  }
  refresh();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, refresh };
}

function marking(root, x, y, width, height, rotation, material, low=false) {
  const positions = [], indices = [];
  const rows = low?14:22, columns = low?6:8, cosine = Math.cos(rotation), sine = Math.sin(rotation);
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    const radius = Math.sin(t * Math.PI) ** .87 * (.86 + .14 * t);
    for (let j = 0; j <= columns; j++) {
      const lx = width * radius * (j / columns * 2 - 1), ly = height * (2 * t - 1);
      const px = x + lx * cosine - ly * sine, py = y + lx * sine + ly * cosine;
      positions.push(px, py, skinZ(px, py) + .0022);
      if (i < rows && j < columns) {
        const a = i * (columns + 1) + j, b = a + columns + 1;
        indices.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
  }
  const mesh = bufferMesh('painted leaf freckle', positions, indices, material);
  mesh.castShadow = false;
  root.add(mesh);
}

function makeEar(sign, material, veinMaterial, edgeMaterial, low) {
  const earSweep=(name,sample,radiusAt,paint,segments,sides)=>sweep(name,sample,radiusAt,paint,segments,sides,null,low?.65:1);
  const root = new THREE.Group();
  root.name = sign > 0 ? 'right leaf ear' : 'left leaf ear';
  const point = (u, v, back = false) => {
    const belly = Math.sin(Math.PI * u);
    const width = .183 * belly ** .79;
    const x = sign * (.637 + .480 * u - .69 * width * v);
    const y = .482 + .460 * u + .73 * width * v + (sign < 0 ? -.035 * u : .012 * u);
    const z = -.078 + .104 * u + .093 * belly * (1 - .78 * v * v) + .032 * belly * v
      + .055 * u ** 4 - (back ? .022 * belly + .004 : 0);
    return V(x, y, z);
  };
  const positions = [], colors = [], uv = [], indices = [];
  const rows = low?22:32, columns = low?12:18, faceCount = (rows + 1) * (columns + 1);
  for (let face = 0; face < 2; face++) {
    for (let i = 0; i <= rows; i++) {
      const u = i / rows;
      for (let j = 0; j <= columns; j++) {
        const v = j / columns * 2 - 1;
        const p = point(u, v, face === 1);
        positions.push(p.x, p.y, p.z);
        const color = new THREE.Color(face ? '#7f9a43' : '#9bb745');
        color.lerp(new THREE.Color('#c1ca66'), .35 * (1 - Math.abs(v)) + .12 * u);
        colors.push(color.r, color.g, color.b);
        uv.push(u, j / columns);
        if (i < rows && j < columns) {
          const a = face * faceCount + i * (columns + 1) + j, b = a + columns + 1;
          const reverse = (sign > 0) !== (face === 1);
          if (reverse) indices.push(a, a + 1, b, b, a + 1, b + 1);
          else indices.push(a, b, a + 1, b, b + 1, a + 1);
        }
      }
    }
  }
  root.add(bufferMesh('folded succulent leaf with front and back', positions, indices, material, colors, uv));
  const midrib = earSweep('raised central leaf rib', t => point(t, 0).add(V(0, 0, .010)), t => .009 * (1 - t) + .0018, veinMaterial, 48, 8);
  root.add(midrib.mesh);
  for (const start of [.22, .39, .56, .72]) {
    for (const side of [-1, 1]) {
      root.add(earSweep('fine secondary leaf vein', t => point(start + .135 * t, side * .91 * t).add(V(0, 0, .006)), t => .0033 * (1 - .73 * t), veinMaterial, 24, 6).mesh);
    }
  }
  for (const side of [-1, 1]) {
    root.add(earSweep('soft leaf rim', t => point(t, side).add(V(0, 0, .001)), t => .0045 * Math.sin(t * Math.PI) + .0005, edgeMaterial, 48, 6).mesh);
  }
  // Keep the sculpted vertices untouched. The hinge sits inside the skull,
  // so small leaf gestures rotate at the attachment instead of peeling away.
  const hinge = new THREE.Group();
  hinge.name = sign > 0 ? 'right leaf ear root hinge' : 'left leaf ear root hinge';
  hinge.position.set(sign * .637, .482, -.078);
  root.position.copy(hinge.position).negate();
  hinge.add(root);
  return hinge;
}

function makeHorn(sign, material, low) {
  const lower = sign < 0 ? .027 : 0;
  const points = [
    [.465, 1.005, -.065], [.552, 1.175, -.035], [.580, 1.330, .008],
    [.513, 1.438, .061], [.405, 1.447, .112], [.337, 1.398, .145],
    [.353, 1.360, .153], [.399, 1.380, .151],
  ].map(([x, y, z], index) => V(sign * x, y - lower * Math.min(1, index / 2), z));
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const cream = new THREE.Color('#f5dba4');
  const tip = new THREE.Color('#fff0c3');
  const base = new THREE.Color('#b2c579');
  return sweep(sign < 0 ? 'left inward curled ivory horn' : 'right inward curled ivory horn',
    t => curve.getPointAt(t),
    t => .145 * (1 - t) ** .70 + .004 + .016 * Math.sin(Math.PI * t),
    material, 112, 20,
    (t, angle) => {
      const color = base.clone().lerp(cream, smooth(.015, .185, t));
      color.lerp(tip, .30 * smooth(.35, 1, t));
      const groove = Math.sin(t * 156 + .34 * Math.sin(angle * TAU)) * .011 * Math.sin(Math.PI * t);
      color.multiplyScalar(1 + groove);
      return color;
    },low?.65:1).mesh;
}

const actionWindow = (phase, enterStart, enterEnd, leaveStart, leaveEnd) =>
  smooth(enterStart, enterEnd, phase) * (1 - smooth(leaveStart, leaveEnd, phase));

// These poses are relative to the neck. The activity director owns duration,
// selection and interruption; phase shapes the acting, weight blends it away.
function activityPose(activity) {
  const phase = Number.isFinite(activity?.phase) ? clamp(activity.phase, 0, 1) : 0;
  const side = activity?.side < 0 ? -1 : 1;
  const pose = {
    x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0,
    gazeX: 0, gazeY: 0, converge: 0, closure: 0,
    earPrick: 0, earFold: 0, earTwitch: 0,
  };
  switch (activity?.kind) {
    case 'look': {
      const notice = actionWindow(phase, .015, .12, .70, .93);
      const follow = actionWindow(phase, .14, .36, .65, .96);
      pose.yaw = side * .185 * follow;
      pose.pitch = -.030 * follow;
      pose.roll = -side * .040 * follow;
      pose.y = .008 * follow;
      // The first eye movement is deliberately ahead of the neck turn.
      pose.gazeX = side * notice * (.032 - .017 * follow);
      pose.gazeY = .010 * notice;
      pose.earPrick = .70 * notice;
      pose.earTwitch = gauss(phase, .16, .050) + .50 * gauss(phase, .60, .065);
      break;
    }
    case 'sniff': {
      const focus = actionWindow(phase, .02, .14, .70, .94);
      const reach = actionWindow(phase, .14, .30, .66, .94);
      // Two short holds leave a quiet beat between the little inhalations.
      const first = actionWindow(phase, .30, .335, .365, .405);
      const second = actionWindow(phase, .49, .525, .555, .595);
      const inhale = first + second;
      pose.z = .046 * reach + .015 * inhale;
      pose.y = -.007 * reach + .004 * inhale;
      pose.pitch = .055 * reach + .021 * inhale;
      pose.yaw = side * .024 * reach;
      pose.roll = -side * .014 * reach;
      pose.gazeX = side * .007 * focus;
      pose.gazeY = -.020 * focus;
      pose.converge = -.005 * focus;
      pose.closure = .11 * reach + .17 * inhale;
      pose.earPrick = .45 * reach;
      pose.earTwitch = .80 * inhale;
      break;
    }
    case 'groom': {
      const lean = actionWindow(phase, .10, .29, .70, .92);
      const contact = actionWindow(phase, .26, .32, .66, .74);
      const wipes = gauss(phase, .40, .055) + gauss(phase, .60, .055);
      // The matching paw is already in front of the cheek; stay close to the
      // neutral skull position so the hand never has to chase a turning face.
      pose.x = side * .014 * lean;
      pose.z = .005 * lean;
      pose.pitch = .035 * lean + .015 * wipes;
      pose.yaw = side * .025 * lean;
      pose.roll = -side * (.025 * lean + .010 * wipes);
      pose.gazeX = side * .013 * lean;
      pose.gazeY = -.023 * lean;
      pose.closure = .76 * contact + .24 * wipes;
      pose.earFold = .30 * lean;
      pose.earTwitch = .55 * wipes;
      break;
    }
    case 'stretch': {
      const arch = actionWindow(phase, .08, .34, .66, .96);
      pose.pitch = -.175 * arch;
      pose.yaw = side * .018 * arch;
      pose.roll = side * .025 * arch;
      pose.y = .021 * arch;
      pose.z = -.018 * arch;
      pose.gazeY = .012 * arch;
      pose.closure = .78 * arch + .20 * gauss(phase, .51, .14);
      pose.earPrick = .72 * arch;
      pose.earTwitch = .50 * gauss(phase, .78, .07);
      break;
    }
    case 'doze': {
      const sleepy = actionWindow(phase, .035, .28, .70, .98);
      const nod = .012 * gauss(phase, .45, .12) + .022 * gauss(phase, .67, .075);
      pose.pitch = .105 * sleepy + nod;
      pose.yaw = side * .018 * sleepy;
      pose.roll = side * .065 * sleepy;
      pose.y = -.012 * sleepy;
      pose.z = .008 * sleepy;
      pose.gazeY = -.014 * sleepy;
      // Fully closed through the middle of the doze, then a slow awakening.
      pose.closure = actionWindow(phase, .07, .24, .72, .98);
      pose.earFold = .76 * sleepy;
      break;
    }
    case 'rest': {
      const settle = actionWindow(phase, .04, .26, .72, .98);
      pose.pitch = .024 * settle;
      pose.yaw = side * .040 * settle;
      pose.roll = -side * .018 * settle;
      pose.gazeX = side * .009 * settle;
      pose.gazeY = -.009 * settle;
      pose.closure = .16 * settle + .62 * gauss(phase, .53, .06);
      pose.earFold = .22 * settle;
      break;
    }
  }
  return pose;
}

export function makeHead({quality='high'}={}) {
  const low=quality==='low';
  const root = new THREE.Group();
  root.name = 'Bud forest dragon sculpted head';
  const bump = microTexture();
  const skin = new THREE.MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, roughness: .60, metalness: 0, bumpMap: bump, bumpScale: .00125, clearcoat: .08, clearcoatRoughness: .65 });
  const skinRim = new THREE.MeshPhysicalMaterial({ color: '#c2ce88', roughness: .57, bumpMap: bump, bumpScale: .0008, clearcoat: .08 });
  const horn = new THREE.MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, roughness: .39, bumpMap: bump, bumpScale: .0008, clearcoat: .14, clearcoatRoughness: .38 });
  const ear = new THREE.MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, roughness: .54, side: THREE.DoubleSide, bumpMap: bump, bumpScale: .0007, clearcoat: .12 });
  const vein = new THREE.MeshStandardMaterial({ color: '#afbf61', roughness: .56 });
  const earEdge = new THREE.MeshStandardMaterial({ color: '#a6bb56', roughness: .66 });
  const lash = new THREE.MeshStandardMaterial({ color: '#34301c', roughness: .73 });
  const brow = new THREE.MeshStandardMaterial({ color: '#59633a', roughness: .80 });
  const markingMaterial = new THREE.MeshStandardMaterial({ color: '#93ad62', roughness: .65, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const eyeMaterials = {
    skinRim, lash, brow,
    lid: new THREE.MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, roughness: .58, side: THREE.DoubleSide, bumpMap: bump, bumpScale: .0006 }),
    sclera: new THREE.MeshPhysicalMaterial({ color: '#f2ecd8', roughness: .40, clearcoat: .18, clearcoatRoughness: .18 }),
    iris: new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: .53, clearcoat: .18, clearcoatRoughness: .28 }),
    pupil: new THREE.MeshPhysicalMaterial({ color: '#11170e', roughness: .38, clearcoat: .18, clearcoatRoughness: .20 }),
    glint: new THREE.MeshBasicMaterial({ color: '#fffdf2', toneMapped: false }),
    glintSoft: new THREE.MeshBasicMaterial({ color: '#e7dfc1', toneMapped: false, transparent: true, opacity: .63 }),
  };
  paintFace(skin);
  root.add(makeSkull(skin,low));
  const ears = [-1, 1].map(sign => ({ sign, root: makeEar(sign, ear, vein, earEdge,low) }));
  ears.forEach(item => root.add(item.root));
  root.add(makeHorn(-1, horn,low), makeHorn(1, horn,low));

  for (const [x, y, w, h, angle] of [
    [0, 1.044, .033, .077, -.17], [-.093, .977, .036, .069, .61], [.105, .975, .035, .067, -.67],
    [-.043, .898, .036, .060, .15], [.078, .894, .033, .057, -.33],
    [-.052, .535, .020, .041, .63], [.023, .565, .021, .045, -.30], [.073, .519, .019, .034, -.75],
  ]) marking(root, x, y, w, h, angle, markingMaterial,low);

  const eyes = [-1, 1].map(sign => makeEye(sign, eyeMaterials, { skinZ, skinColor, low }));
  eyes.forEach(eye => root.add(eye.root));
  // Eye materials are templates cloned for each eye's clipping uniforms.
  // Their local textures remain shared by the live clones and their owner.
  Object.values(eyeMaterials).forEach(material => material.dispose());
  root.userData.design = 'A / forest bud dragon / isolated continuous head study';
  root.userData.nominalBounds = { jaw: -.06, cranium: 1.18, horn: 1.53, nose: .77 };
  const motion = new THREE.Group();
  motion.name = 'neck-local expression motion';
  while (root.children.length) motion.add(root.children[0]);
  root.add(motion);
  function update(t = 0, wave = 0, reduced = false, activity = null) {
    const time = Number.isFinite(t) ? t : 0;
    const waving = clamp(Number(wave) || 0, 0, 1);
    const weight = reduced ? 0 : (Number.isFinite(activity?.weight) ? clamp(activity.weight, 0, 1) : 0) * (1 - waving);
    const pose = activityPose(activity);
    const quiet = 1 - .70 * weight;
    motion.rotation.x = reduced ? 0 : (.012 * Math.sin(time * .83) - .025 * waving) * quiet + pose.pitch * weight;
    motion.rotation.y = reduced ? 0 : .016 * Math.sin(time * .41) * quiet + pose.yaw * weight;
    motion.rotation.z = reduced ? 0 : (.018 * Math.sin(time * .58) + .028 * waving) * quiet + pose.roll * weight;
    motion.position.set(pose.x * weight, pose.y * weight, pose.z * weight);
    const phase = ((time + .9) % 6.8 + 6.8) % 6.8;
    const closure = reduced ? 0 : Math.max(gauss(phase, 5.74, .066), .72 * gauss(phase, 5.99, .053));
    eyes.forEach((eye, index) => {
      const sign = index === 0 ? -1 : 1;
      eye.blink(.82 * (1 - closure) * (1 - clamp(pose.closure * weight, 0, 1)));
      eye.irisRoot.position.x = reduced ? 0 : .004 * Math.sin(time * .42) * quiet + (pose.gazeX + sign * pose.converge) * weight;
      eye.irisRoot.position.y = reduced ? 0 : .0028 * Math.sin(time * .53) * quiet + pose.gazeY * weight;
    });
    ears.forEach(({ sign, root: hinge }) => {
      const rustle = Math.sin(time * 1.27 + sign * .8);
      const twitch = Math.sin(time * 20 + sign * 1.7) * pose.earTwitch * weight;
      const listening = activity?.side === sign ? 1 : .68;
      hinge.rotation.x = reduced ? 0 : .003 * rustle * quiet + .033 * pose.earFold * weight + .014 * twitch * listening;
      hinge.rotation.y = reduced ? 0 : sign * (.003 * rustle * quiet + .021 * pose.earPrick * weight) + .013 * twitch * listening;
      hinge.rotation.z = reduced ? 0 : sign * (.004 * rustle * quiet + (.055 * pose.earPrick - .045 * pose.earFold) * weight) + .020 * twitch * listening;
    });
  }
  update(0, 0, true);
  return { root, update, motion, eyes, ears:ears.map(item => item.root) };
}
