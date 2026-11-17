import * as THREE from 'three';

// Original, closed sculpture meshes. Cross-sections are designed for the two
// companions; no imported character, billboard or texture is used here.
const TAU = Math.PI * 2;
const signedPower = (value, power) => Math.sign(value) * Math.pow(Math.abs(value), power);

function finish(w, positions, indices, color, shade) {
  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  indexed.setIndex(indices);
  const geometry = indexed.toNonIndexed(); indexed.dispose();
  geometry.computeVertexNormals();
  if (shade) {
    const values = new Float32Array(geometry.attributes.position.count * 3), vertex = new THREE.Vector3();
    const normal = new THREE.Vector3(), base = new THREE.Color(color);
    for (let i = 0; i < geometry.attributes.position.count; i += 3) {
      vertex.set(0, 0, 0);
      for (let j = 0; j < 3; j++) vertex.add(new THREE.Vector3().fromBufferAttribute(geometry.attributes.position, i + j));
      vertex.multiplyScalar(1 / 3); normal.fromBufferAttribute(geometry.attributes.normal, i);
      const painted = shade(vertex, normal, base.clone(), i / 3) || base;
      for (let j = 0; j < 3; j++) painted.toArray(values, (i + j) * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(values, 3));
  }
  w.geometries.add(geometry);
  return geometry;
}

export function sculpture(w, parent, color, sections, options = {}) {
  const axis = options.axis || 'y', count = options.sides || 16;
  const positions = [], indices = [];
  for (const s of sections) {
    const center = s.center || (axis === 'y' ? [s.x || 0, s.y, s.z || 0] : [s.x || 0, s.y || 0, s.z]);
    const power = 2 / (s.power || options.power || 2.3);
    for (let j = 0; j < count; j++) {
      const angle = j * TAU / count;
      const u = signedPower(Math.cos(angle), power) * s.rx;
      const v = signedPower(Math.sin(angle), power) * (axis === 'y' ? s.rz : s.ry);
      positions.push(center[0] + u, center[1] + (axis === 'z' ? v : 0), center[2] + (axis === 'y' ? v : 0));
    }
  }
  const reverse = axis === 'y';
  function tri(a, b, c) { if (reverse) indices.push(a, c, b); else indices.push(a, b, c); }
  for (let i = 0; i < sections.length - 1; i++) for (let j = 0; j < count; j++) {
    const a = i * count + j, b = i * count + (j + 1) % count, c = b + count, d = a + count;
    // Alternate diagonals avoid conspicuous spiralling triangulation.
    if ((i + j) % 2) { tri(a, b, d); tri(b, c, d); } else { tri(a, b, c); tri(a, c, d); }
  }
  const first = sections[0], last = sections[sections.length - 1];
  const firstCenter = first.center || (axis === 'y' ? [first.x || 0, first.y, first.z || 0] : [first.x || 0, first.y || 0, first.z]);
  const lastCenter = last.center || (axis === 'y' ? [last.x || 0, last.y, last.z || 0] : [last.x || 0, last.y || 0, last.z]);
  const bottom = positions.length / 3; positions.push(...firstCenter, ...lastCenter);
  for (let j = 0; j < count; j++) {
    tri(bottom, (j + 1) % count, j);
    tri(bottom + 1, (sections.length - 1) * count + j, (sections.length - 1) * count + (j + 1) % count);
  }
  const geometry = finish(w, positions, indices, color, options.shade);
  const mesh = w.add(parent, geometry, options.shade ? 0xffffff : color, options.position, options.scale, options.rotation);
  if (options.shade) { mesh.material = w.material(0xffffff, { vertexColors: true }); }
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}

// A tapering bent solid, with rings perpendicular to its centreline. Used for
// tails, horns, fingers and seams so the silhouette is not a chain of spheres.
export function sweep(w, parent, color, points, radii, options = {}) {
  const vertices = [], indices = [], sides = options.sides || 8;
  const up = new THREE.Vector3(0, 1, 0);
  points.forEach((p, i) => {
    const before = new THREE.Vector3(...points[Math.max(0, i - 1)]);
    const after = new THREE.Vector3(...points[Math.min(points.length - 1, i + 1)]);
    const tangent = after.sub(before).normalize();
    const ref = Math.abs(tangent.dot(up)) > .92 ? new THREE.Vector3(0, 0, 1) : up;
    const u = new THREE.Vector3().crossVectors(ref, tangent).normalize();
    const v = new THREE.Vector3().crossVectors(tangent, u).normalize();
    const radius = Array.isArray(radii[i]) ? radii[i] : [radii[i], radii[i]];
    for (let j = 0; j < sides; j++) {
      const angle = j * TAU / sides;
      const point = new THREE.Vector3(...p).addScaledVector(u, Math.cos(angle) * radius[0]).addScaledVector(v, Math.sin(angle) * radius[1]);
      vertices.push(...point.toArray());
    }
  });
  for (let i = 0; i < points.length - 1; i++) for (let j = 0; j < sides; j++) {
    const a = i * sides + j, b = i * sides + (j + 1) % sides, c = b + sides, d = a + sides;
    indices.push(a, b, c, a, c, d);
  }
  const cap = vertices.length / 3; vertices.push(...points[0], ...points[points.length - 1]);
  for (let j = 0; j < sides; j++) {
    indices.push(cap, (j + 1) % sides, j);
    indices.push(cap + 1, (points.length - 1) * sides + j, (points.length - 1) * sides + (j + 1) % sides);
  }
  const geometry = finish(w, vertices, indices, color, options.shade);
  const mesh = w.add(parent, geometry, options.shade ? 0xffffff : color);
  if (options.shade) mesh.material = w.material(0xffffff, { vertexColors: true });
  mesh.castShadow = true; mesh.receiveShadow = true; return mesh;
}

// Sculpted convex leaf/almond. Its ridge and enclosed back are genuinely 3D;
// the same construction gives a flush eyelid rather than a protruding eyeball.
export function lens(w, parent, color, outline, depth = .05, position, rotation, ridge = [0, 0]) {
  const signedArea = outline.reduce((sum, p, i) => { const q = outline[(i + 1) % outline.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0);
  if (signedArea < 0) outline = [...outline].reverse();
  const positions = [], indices = [], n = outline.length;
  outline.forEach(p => positions.push(p[0], p[1], 0));
  positions.push(ridge[0], ridge[1], depth);
  positions.push(ridge[0], ridge[1], -depth * .35);
  for (let j = 0; j < n; j++) { indices.push(n, j, (j + 1) % n); indices.push(n + 1, (j + 1) % n, j); }
  const geometry = finish(w, positions, indices, color);
  const mesh = w.add(parent, geometry, color, position, null, rotation);
  mesh.castShadow = true; mesh.receiveShadow = true; return mesh;
}

export function roundedPanel(w, parent, color, width, height, depth, radius, position, rotation) {
  const x = -width / 2, y = -height / 2, r = Math.min(radius, width / 2, height / 2);
  const shape = new THREE.Shape();
  shape.moveTo(x + r, y); shape.lineTo(x + width - r, y); shape.quadraticCurveTo(x + width, y, x + width, y + r);
  shape.lineTo(x + width, y + height - r); shape.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  shape.lineTo(x + r, y + height); shape.quadraticCurveTo(x, y + height, x, y + height - r);
  shape.lineTo(x, y + r); shape.quadraticCurveTo(x, y, x + r, y);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSize: .014, bevelThickness: .014, bevelSegments: 1, steps: 1, curveSegments: 2 });
  w.geometries.add(geometry);
  const mesh = w.add(parent, geometry, color, position, null, rotation); mesh.castShadow = true; mesh.receiveShadow = true; return mesh;
}

export function ribbon(w, parent, color, centers, width, thickness = .018, fit = null) {
  if (fit) {
    const dense = [];
    centers.forEach((p, i) => {
      if (i) for (let j = 1; j < 4; j++) dense.push(p.map((v, k) => centers[i - 1][k] + (v - centers[i - 1][k]) * j / 4));
      dense.push(p);
    });
    centers = dense;
  }
  const positions = [], indices = [];
  centers.forEach((point, i) => {
    const before = centers[Math.max(0, i - 1)], after = centers[Math.min(centers.length - 1, i + 1)];
    const direction = new THREE.Vector2(after[0] - before[0], after[1] - before[1]).normalize();
    const side = new THREE.Vector2(-direction.y, direction.x).multiplyScalar(width / 2);
    for (const z of [-thickness / 2, thickness / 2]) for (const sign of [-1, 1]) {
      const x = point[0] + side.x * sign, y = point[1] + side.y * sign;
      const fitted = fit && point[2] > 0 ? fit(x, y) : null;
      positions.push(x, y, (Number.isFinite(fitted) ? fitted + .035 : point[2]) + z);
    }
  });
  for (let i = 0; i < centers.length - 1; i++) {
    const a = i * 4, b = a + 4;
    indices.push(a + 2, a + 3, b + 3, a + 2, b + 3, b + 2);
    indices.push(a + 1, a, b, a + 1, b, b + 1);
    indices.push(a, a + 2, b + 2, a, b + 2, b);
    indices.push(a + 3, a + 1, b + 1, a + 3, b + 1, b + 3);
  }
  const last = (centers.length - 1) * 4; indices.push(0, 1, 3, 0, 3, 2, last, last + 2, last + 3, last, last + 3, last + 1);
  const mesh = w.add(parent, finish(w, positions, indices, color), color); mesh.castShadow = true; return mesh;
}

export function line(w, parent, color, points, radius = .012) {
  const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
  const geometry = new THREE.TubeGeometry(curve, Math.max(6, points.length * 3), radius, 5, false);
  w.geometries.add(geometry); const mesh = w.add(parent, geometry, color); return mesh;
}
