// Approved Forest Bud Dragon / A, shared by every product companion view.
// Revision 3: a full front-to-back baby pear, wider haunches and planted feet;
// arms leave the round abdomen readable and wings join the actual shoulder skin.
// Belly scutes and markings project onto that same surface. Tail is a separate
// continuous, deforming sculpt. Assembled visual review belongs to the host.
// Coordinates: Y up, +Z front. Soles at 0; neck axis (0, 1.72, 0.03).
// Animation input: seconds, a 0..1 wave envelope, reduced-motion boolean, and
// optional {kind,phase,weight,side}. Activity weights include the host's fade.
import * as THREE from 'three';
import { makeTail } from './tail.js';

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smooth = (v) => { const t = clamp(v, 0, 1); return t * t * (3 - 2 * t); };
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// Hermite interpolation keeps the pear and the neck one continuous surface.
function interpolate(stops, x, field = 1) {
  if (x <= stops[0][0]) return stops[0][field];
  const last = stops.length - 1;
  if (x >= stops[last][0]) return stops[last][field];
  let i = 0;
  while (stops[i + 1][0] < x) i += 1;
  const a = stops[i], b = stops[i + 1];
  const before = stops[Math.max(0, i - 1)], after = stops[Math.min(last, i + 2)];
  const span = b[0] - a[0], t = (x - a[0]) / span;
  const m0 = (b[field] - before[field]) / (b[0] - before[0]);
  const m1 = (after[field] - a[field]) / (after[0] - a[0]);
  return (2*t*t*t - 3*t*t + 1)*a[field] + (t*t*t - 2*t*t + t)*m0*span
    + (-2*t*t*t + 3*t*t)*b[field] + (t*t*t - t*t)*m1*span;
}

function curve(points) {
  return new THREE.CatmullRomCurve3(points.map(p => V(...p)), false, 'centripetal', 0.5);
}

function geometry(positions, indices, colors) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (colors) g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function mergeGeometry(inputs) {
  let total = 0;
  const expanded = inputs.map(g => {
    const n = g.index ? g.toNonIndexed() : g;
    total += n.attributes.position.array.length;
    return n;
  });
  const positions = new Float32Array(total), normals = new Float32Array(total);
  let offset = 0;
  for (let i = 0; i < expanded.length; i += 1) {
    const g = expanded[i];
    positions.set(g.attributes.position.array, offset);
    normals.set(g.attributes.normal.array, offset);
    offset += g.attributes.position.array.length;
    if (g !== inputs[i]) g.dispose();
    inputs[i].dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  out.computeBoundingSphere();
  return out;
}

// Sweep uses a projected front vector, so curved limbs and tail have stable frames.
function swept(path, radii, { steps = 56, sides = 28, colorAt = null } = {}) {
  const sample = (t, angle, lift = 0) => {
    const at = clamp(t, 0, 1), tangent = path.getTangentAt(at).normalize();
    let front = V(0, 0, 1).addScaledVector(tangent, -tangent.z);
    if (front.lengthSq() < 0.02) front = V(0, 1, 0).addScaledVector(tangent, -tangent.y);
    front.normalize();
    const across = tangent.clone().cross(front).normalize();
    const ra = Math.max(0.0005, interpolate(radii, at, 1));
    const rb = Math.max(0.0005, interpolate(radii, at, 2));
    const normal = front.clone().multiplyScalar(Math.cos(angle) / ra)
      .addScaledVector(across, Math.sin(angle) / rb).normalize();
    const point = path.getPointAt(at).addScaledVector(front, Math.cos(angle) * ra)
      .addScaledVector(across, Math.sin(angle) * rb).addScaledVector(normal, lift);
    return { point, normal };
  };
  const positions = [], indices = [], colors = colorAt ? [] : null;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    for (let j = 0; j <= sides; j += 1) {
      const a = j / sides * TAU;
      const p = sample(t, a).point;
      positions.push(p.x, p.y, p.z);
      if (colors) { const c = colorAt(t, a); colors.push(c.r, c.g, c.b); }
      if (i < steps && j < sides) {
        const n = i * (sides + 1) + j;
        indices.push(n, n + 1, n + sides + 1, n + 1, n + sides + 2, n + sides + 1);
      }
    }
  }
  // Close both ends; intersections sit inside their adjoining sculpted pieces.
  for (const end of [0, 1]) {
    const center = path.getPointAt(end), index = positions.length / 3;
    positions.push(center.x, center.y, center.z);
    if (colors) { const c = colorAt(end, 0); colors.push(c.r, c.g, c.b); }
    const row = end * steps * (sides + 1);
    for (let j = 0; j < sides; j += 1) {
      if (end) indices.push(index, row + j, row + j + 1);
      else indices.push(index, row + j + 1, row + j);
    }
  }
  const shape = geometry(positions, indices, colors);
  shape.userData.sweep = { steps, sides };
  return { geometry: shape, sample };
}

function armFrame(path, u, out) {
  const along = path.getTangentAt(u).normalize();
  let front = V(0, 0, 1).addScaledVector(along, -along.z);
  if (front.lengthSq() < .025) front = V(0, 1, 0).addScaledVector(along, -along.y);
  front.normalize();
  const across = along.clone().cross(front).normalize();
  return out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(across, along, front));
}

// Preserve each original cross-section in its own curve frame. A folded elbow
// needs its actual sweep parameter: spatial weights can bind across the fold,
// and blended opposing bone rotations collapse its thick, rounded skin.
function prepareArmSurface(shape, restPath) {
  const position = shape.attributes.position, local = new Float32Array(position.array.length), groups = new Map();
  const sweep = shape.userData.sweep, ringVertices = sweep ? (sweep.steps + 1) * (sweep.sides + 1) : 0;
  const offset = V(), inverse = new THREE.Quaternion();
  for (let i = 0; i < position.count; i += 1) {
    const u = sweep
      ? i < ringVertices ? Math.floor(i / (sweep.sides + 1)) / sweep.steps : i === ringVertices ? 0 : 1
      : clamp(shape.userData.surfaceParameters[i], .02, .98);
    let group = groups.get(u);
    if (!group) { group = { u, indices: [], center: restPath.getPointAt(u), inverse: armFrame(restPath, u, new THREE.Quaternion()).invert() }; groups.set(u, group); }
    group.indices.push(i);
    offset.fromBufferAttribute(position, i).sub(group.center).applyQuaternion(inverse.copy(group.inverse)).toArray(local, i * 3);
  }
  return { shape, local, groups: [...groups.values()] };
}

function deformArmSurface(surface, posePath, handTwist, scratch) {
  const position = surface.shape.attributes.position;
  for (const group of surface.groups) {
    posePath.getPointAt(group.u, scratch.center);
    armFrame(posePath, group.u, scratch.frame);
    scratch.twist.setFromAxisAngle(posePath.getTangentAt(group.u), handTwist * smooth((group.u - .56) / .4));
    scratch.frame.premultiply(scratch.twist);
    for (const i of group.indices) {
      scratch.point.fromArray(surface.local, i * 3).applyQuaternion(scratch.frame).add(scratch.center);
      position.setXYZ(i, scratch.point.x, scratch.point.y, scratch.point.z);
    }
  }
  position.needsUpdate = true; surface.shape.computeVertexNormals();
}

// Retarget existing skin and paint continuously; the original palm remains
// rigid so its rounded nails never shear when the forearm is raised.
function makeArmRig(root, arm, wrist, restPoints) {
  const restPath = curve(restPoints), posePath = curve(restPoints), surfaces = [];
  restPath.arcLengthDivisions = 96; posePath.arcLengthDivisions = 64;
  root.updateMatrixWorld(true);
  const inverseArm = arm.matrixWorld.clone().invert(), sources = [];
  arm.traverse(object => { if (object.isMesh && object.parent === arm) sources.push(object); });
  for (const source of sources) {
    const original = source.geometry, shape = original.clone();
    shape.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverseArm, source.matrixWorld));
    // Mesh.raycast also uses these bounds; an old raised-paw sphere misses
    // the lowered forearm even when frustum culling is disabled.
    shape.boundingBox = new THREE.Box3(V(-1,-.85,-.4),V(1,.8,1));
    shape.boundingSphere = shape.boundingBox.getBoundingSphere(new THREE.Sphere());
    source.geometry = shape; original.dispose();
    source.position.set(0,0,0); source.quaternion.identity(); source.scale.set(1,1,1);
    surfaces.push(prepareArmSurface(shape, restPath));
  }
  const hand = new THREE.Group(); hand.name = `${arm.name} · palm attachment`;
  hand.position.copy(restPath.getPointAt(1)); arm.add(hand); hand.add(wrist); wrist.position.sub(hand.position);
  const inverseHandFrame = armFrame(restPath, 1, new THREE.Quaternion()).invert();
  const scratch = { point: V(), center: V(), frame: new THREE.Quaternion(), twist: new THREE.Quaternion() };
  const previous = restPoints.map(() => V(Infinity,Infinity,Infinity)); let previousTwist = Infinity;
  arm.userData.deformation = 'Continuous original sweep sections and paint; rigid palm; no surface remeshing';
  return {
    hand,
    pose(points, handTwist = 0) {
      if (handTwist === previousTwist && points.every((point,i) => point.equals(previous[i]))) return;
      posePath.points.forEach((point, i) => point.copy(points[i])); posePath.updateArcLengths();
      surfaces.forEach(surface => deformArmSurface(surface, posePath, handTwist, scratch));
      hand.position.copy(posePath.getPointAt(1)); armFrame(posePath, 1, hand.quaternion).multiply(inverseHandFrame);
      scratch.twist.setFromAxisAngle(posePath.getTangentAt(1), handTwist); hand.quaternion.premultiply(scratch.twist);
      points.forEach((point,i) => previous[i].copy(point)); previousTwist = handTwist;
    },
  };
}

export function makeBody({quality='high'}={}) {
  const low=quality==='low';
  const sculptSweep=(path,radii,options={})=>swept(path,radii,{...options,
    steps:low?Math.max(12,Math.round((options.steps||56)*.55)):(options.steps||56),
    sides:low?Math.max(5,Math.round((options.sides||28)*.60)):(options.sides||28)});
  const root = new THREE.Group();
  root.name = 'A · Forest Bud Dragon · body';
  root.userData.bodyInterface = 'makeBody/update(seconds,waveEnvelope,reducedMotion,activity?)';
  root.userData.neckAnchor = [0, 1.72, 0.03];

  const colors = {
    skin: new THREE.Color('#abc768'), skinHigh: new THREE.Color('#b5cd78'),
    skinShade: new THREE.Color('#a3be65'), spot: new THREE.Color('#94ae59'),
    belly: new THREE.Color('#eed59f'), bellyEdge: new THREE.Color('#ddc38c'),
    claw: new THREE.Color('#f1dcac'), leaf: new THREE.Color('#91ae53'),
    fold: new THREE.Color('#809f47'), vein: new THREE.Color('#b4c76d'),
    veinBack: new THREE.Color('#839d4b'), tailBelly: new THREE.Color('#d7c693'),
  };
  const skin = new THREE.MeshPhysicalMaterial({
    color: colors.skin, roughness: 0.66, metalness: 0, sheen: 0.16,
    sheenColor: new THREE.Color('#e4e9b3'), sheenRoughness: 0.85, clearcoat: 0.015,
  });
  const skinPainted = skin.clone(); skinPainted.color.set(0xffffff); skinPainted.vertexColors = true;
  const bellyMaterial = new THREE.MeshPhysicalMaterial({
    vertexColors: true, roughness: 0.73, metalness: 0, sheen: 0.08,
    sheenColor: new THREE.Color('#fff0ca'), sheenRoughness: 0.85,
  });
  const clawMaterial = new THREE.MeshPhysicalMaterial({
    color: colors.claw, roughness: 0.43, metalness: 0, clearcoat: 0.11, clearcoatRoughness: 0.58,
  });
  const leafMaterial = new THREE.MeshPhysicalMaterial({
    vertexColors: true, roughness: 0.65, metalness: 0, sheen: 0.13,
    sheenColor: new THREE.Color('#d4dd91'), sheenRoughness: 0.8,
  });
  const veinMaterial = new THREE.MeshStandardMaterial({ color: colors.vein, roughness: 0.73 });
  const veinBackMaterial = new THREE.MeshStandardMaterial({ color: colors.veinBack, roughness: 0.76 });
  const sphereGeometry = new THREE.SphereGeometry(1, low?20:40, low?14:28);

  function mesh(g, m, parent, name) {
    const object = new THREE.Mesh(g, m);
    object.name = name || '';
    object.userData.companionAnatomy = m === skin || name === 'Continuous pear torso and neck';
    object.castShadow = true; object.receiveShadow = true;
    parent.add(object);
    return object;
  }
  function soft(parent, center, scale, material = skin, name = '') {
    const object = mesh(sphereGeometry, material, parent, name);
    object.position.set(...center); object.scale.set(...scale);
    return object;
  }
  function tube(parent, points, radii, material, name, options) {
    const shape = sculptSweep(curve(points), radii, options);
    shape.mesh = mesh(shape.geometry, material, parent, name);
    return shape;
  }
  function skinColor(y, angle = 0) {
    const upper = smooth((y - 0.3) / 1.65);
    return colors.skin.clone().lerp(colors.skinHigh, upper * 0.78)
      .lerp(colors.skinShade, (1 - Math.cos(angle)) * 0.055);
  }

  // The abdomen is nearly as deep as it is wide, rather than a flattened front.
  // Its rounded breast and haunches flow into the narrower neck without a seam.
  const bodyRig = new THREE.Group(); bodyRig.name = 'Breathing torso'; root.add(bodyRig);
  const profile = [
    [0.21, 0.14, 0.21, -0.015], [0.28, 0.335, 0.325, -0.010],
    [0.43, 0.50, 0.448, -0.008], [0.66, 0.58, 0.523, 0.008],
    [0.90, 0.585, 0.552, 0.026], [1.12, 0.524, 0.510, 0.032],
    [1.33, 0.451, 0.431, 0.027], [1.50, 0.392, 0.360, 0.022],
    [1.68, 0.336, 0.301, 0.03], [1.84, 0.312, 0.263, 0.03],
    [1.92, 0.292, 0.245, 0.03],
  ];
  function bodyPoint(y, angle) {
    const rx = interpolate(profile, y, 1), rz = interpolate(profile, y, 2);
    return V(Math.sin(angle) * rx, y, Math.cos(angle) * rz + interpolate(profile, y, 3));
  }
  function bodySurface(angle, y, lift = 0) {
    const position = bodyPoint(y, angle);
    const alongY = bodyPoint(y + 0.0005, angle).sub(bodyPoint(y - 0.0005, angle));
    const alongA = bodyPoint(y, angle + 0.0005).sub(bodyPoint(y, angle - 0.0005));
    const normal = alongA.cross(alongY).normalize();
    return { point: position.addScaledVector(normal, lift), normal };
  }
  {
    const positions = [], indices = [], paint = [], rings = low?48:86, sides = low?56:104;
    for (let i = 0; i <= rings; i += 1) {
      const y = 0.21 + i / rings * 1.71;
      for (let j = 0; j <= sides; j += 1) {
        const a = j / sides * TAU, p = bodyPoint(y, a), c = skinColor(y, a);
        positions.push(p.x, p.y, p.z); paint.push(c.r, c.g, c.b);
        if (i < rings && j < sides) {
          const n = i * (sides + 1) + j;
          indices.push(n, n + 1, n + sides + 1, n + 1, n + sides + 2, n + sides + 1);
        }
      }
    }
    for (const end of [0, 1]) {
      const y = end ? 1.92 : 0.21, index = positions.length / 3;
      positions.push(0, y, interpolate(profile, y, 3));
      const c = skinColor(y); paint.push(c.r, c.g, c.b);
      const row = end * rings * (sides + 1);
      for (let j = 0; j < sides; j += 1) {
        if (end) indices.push(index, row + j, row + j + 1);
        else indices.push(index, row + j + 1, row + j);
      }
    }
    mesh(geometry(positions, indices, paint), skinPainted, bodyRig, 'Continuous pear torso and neck');
  }

  // Markings are small curved surfaces hugging the actual sculpt, with soft color edges.
  function marking(parent, surface, center, size, rotation = 0, tone = colors.spot, tintAt = () => colors.skin) {
    const positions = [], paint = [], indices = [], surfaceParameters = [], layers = low?3:5, sides = low?18:28;
    const emit = (r, a) => {
      let px = Math.cos(a) * r * (0.88 - Math.sin(a) * 0.14);
      let py = Math.sin(a) * r;
      const x = (px * Math.cos(rotation) - py * Math.sin(rotation)) * size[0];
      const y = (px * Math.sin(rotation) + py * Math.cos(rotation)) * size[1];
      const u = center[0] + x, v = center[1] + y;
      const p = surface(u, v, 0.0022).point;
      const c = tone.clone().lerp(tintAt(u, v), smooth((r - 0.78) / 0.22) * 0.88);
      positions.push(p.x, p.y, p.z); paint.push(c.r, c.g, c.b); surfaceParameters.push(v);
    };
    emit(0, 0);
    for (let layer = 1; layer <= layers; layer += 1) {
      for (let j = 0; j < sides; j += 1) emit(layer / layers, j / sides * TAU);
    }
    for (let j = 0; j < sides; j += 1) indices.push(0, 1 + j, 1 + (j + 1) % sides);
    for (let i = 0; i < layers - 1; i += 1) {
      const a = 1 + i * sides, b = a + sides;
      for (let j = 0; j < sides; j += 1) {
        const k = (j + 1) % sides;
        indices.push(a + j, b + j, a + k, a + k, b + j, b + k);
      }
    }
    // Surface parameter handedness varies between the trunk and limb sweeps.
    const g = geometry(positions, indices, paint);
    g.userData.surfaceParameters = surfaceParameters;
    const firstNormal = V().fromBufferAttribute(g.attributes.normal, 0);
    const desired = surface(center[0], center[1]).normal;
    if (firstNormal.dot(desired) < 0) {
      const index = g.index.array;
      for (let i = 0; i < index.length; i += 3) { const t = index[i + 1]; index[i + 1] = index[i + 2]; index[i + 2] = t; }
      g.computeVertexNormals();
    }
    return mesh(g, skinPainted, parent, 'Soft leaf-shaped skin marking');
  }
  const bodyMarks = [
    [0.93,1.39,.115,.060,-.18], [1.11,1.27,.145,.072,.32], [0.84,1.19,.105,.050,.4],
    [1.23,1.06,.135,.077,-.45], [1.04,.94,.12,.075,-.25],
    [1.12,.72,.17,.09,-.18], [1.37,.61,.15,.10,.24], [1.15,.48,.18,.11,.5],
    [1.49,.39,.12,.075,.4], [-1.05,1.20,.12,.063,-.3], [-1.20,.65,.16,.09,-.2],
    [-1.37,.49,.13,.073,.3], [-1.07,.39,.12,.08,-.3],
    [2.75,1.40,.12,.07,.3], [3.28,1.21,.15,.085,-.3], [3.04,.98,.14,.08,.2],
    [2.93,.64,.16,.09,-.45], [3.63,.72,.13,.075,.3],
  ];
  for (const [a,y,w,h,r] of bodyMarks) marking(bodyRig, bodySurface, [a,y], [w,h], r, colors.spot, (u,v) => skinColor(v,u));

  // Cream belly follows the pear volume. Thin, shallow overlaps make soft scutes.
  const bellyWidth = [
    [.325,.012], [.40,.13], [.55,.260], [.76,.331], [.94,.341], [1.12,.308],
    [1.31,.257], [1.5,.190], [1.64,.135],
  ];
  const bellyBands = [
    [.33,.60,.005,.052], [.60,.86,.052,.060], [.86,1.115,.060,.055],
    [1.115,1.36,.055,.042], [1.36,1.64,.042,0],
  ];
  bellyBands.forEach(([bottom, top, curveBottom, curveTop], band) => {
    const positions = [], indices = [], paint = [], anchors = [], wide = 44, tall = 16;
    for (let j = 0; j <= tall; j += 1) {
      const v = j / tall;
      for (let i = 0; i <= wide; i += 1) {
        const u = i / wide * 2 - 1, bow = Math.pow(Math.abs(u), 1.55);
        const y0 = bottom + curveBottom * bow, y1 = top + curveTop * bow;
        const y = y0 + (y1 - y0) * v + (band ? 0.0013 : 0) * (1-v);
        const rx = interpolate(profile, y, 1);
        const width = Math.min(rx * 0.91, Math.max(0.008, interpolate(bellyWidth, y)));
        const x = width * u;
        const anchor = bodySurface(Math.asin(clamp(x / rx, -1, 1)), y);
        const edgeBlend = Math.pow(Math.abs(u), 10);
        const relief = .0034 + .0025 * Math.sin(Math.PI*v) * (1-u*u) + .0016*(1-v)*(1-u*u);
        const p = anchor.point.clone().addScaledVector(anchor.normal, relief * (1-.75*edgeBlend));
        positions.push(p.x, p.y, p.z); anchors.push(anchor);
        const c = colors.belly.clone().lerp(new THREE.Color('#f2ddad'), (1-band/7)*.12)
          .lerp(colors.bellyEdge, .022*Math.pow(1-v,5))
          .lerp(skinColor(y), smooth((Math.abs(u)-.92)/.08)*.79);
        if(band===bellyBands.length-1)c.lerp(skinColor(y),smooth((y-1.575)/.065));
        paint.push(c.r,c.g,c.b);
        if (i < wide && j < tall) {
          const n = j*(wide+1)+i;
          indices.push(n,n+1,n+wide+1,n+1,n+wide+2,n+wide+1);
        }
      }
    }
    // The thin perimeter curls inward rather than leaving a cutout-like border.
    const rim = [];
    for (let i = 0; i <= wide; i += 1) rim.push(i);
    for (let j = 1; j <= tall; j += 1) rim.push(j*(wide+1)+wide);
    for (let i = wide-1; i >= 0; i -= 1) rim.push(tall*(wide+1)+i);
    for (let j = tall-1; j > 0; j -= 1) rim.push(j*(wide+1));
    const start = positions.length / 3;
    rim.forEach((n) => {
      const p = anchors[n].point.clone().addScaledVector(anchors[n].normal, -.0027);
      positions.push(p.x,p.y,p.z);
      paint.push(paint[n*3],paint[n*3+1],paint[n*3+2]);
    });
    for (let i = 0; i < rim.length; i += 1) {
      const j = (i+1)%rim.length;
      indices.push(rim[i],start+i,rim[j],rim[j],start+i,start+j);
    }
    const scute=mesh(geometry(positions,indices,paint),bellyMaterial,bodyRig,`Soft cream belly scute ${band+1}`);
    scute.castShadow=false;
  });

  // Each haunch, ankle and foot is a single continuous skin volume.
  // Small front scallops suggest toes without stacking separate ankle/foot balls.
  const feet = [];
  for (const side of [-1, 1]) {
    const foot = new THREE.Group(); foot.name = side < 0 ? 'Left planted foot' : 'Right planted foot';
    feet.push(foot);
    foot.position.set(side*.375,0,.045); foot.rotation.y = -side*.09; root.add(foot);
    const legProfile=[
      [0,.182,.235,.145],[.025,.227,.285,.148],[.10,.246,.305,.148],
      [.19,.230,.275,.097],[.31,.236,.273,.030],[.47,.269,.325,-.005],
      [.63,.260,.318,-.028],[.77,.200,.270,-.043],[.89,.100,.155,-.050],
    ];
    const positions=[],indices=[],rings=low?36:68,sides=low?40:72;
    for(let i=0;i<=rings;i+=1){
      const y=i/rings*.89,rx=interpolate(legProfile,y,1),rz=interpolate(legProfile,y,2),cz=interpolate(legProfile,y,3);
      for(let j=0;j<=sides;j+=1){
        const a=j/sides*TAU,x=Math.sin(a)*rx;
        let bump=0;
        for(const toeX of [-.145,0,.145])bump+=.03*Math.exp(-Math.pow((x-toeX)/.052,2));
        const z=cz+Math.cos(a)*rz+bump*Math.pow(Math.max(0,Math.cos(a)),5)*Math.exp(-Math.pow((y-.09)/.09,2));
        positions.push(x,y,z);
        if(i<rings&&j<sides){const n=i*(sides+1)+j;indices.push(n,n+1,n+sides+1,n+1,n+sides+2,n+sides+1);}
      }
    }
    for(const end of [0,1]){
      const y=end*.89,index=positions.length/3,row=end*rings*(sides+1);
      positions.push(0,y,interpolate(legProfile,y,3));
      for(let j=0;j<sides;j+=1){
        if(end)indices.push(index,row+j,row+j+1);else indices.push(index,row+j+1,row+j);
      }
    }
    mesh(geometry(positions,indices),skin,foot,'Continuous haunch ankle and planted foot');
    for (let toe = 0; toe < 3; toe += 1) {
      const x = (toe-1)*.145;
      const z = toe === 1 ? .478 : .447;
      const claw=soft(foot,[x,.068,z],[.045,.047,.078],clawMaterial,'Short rounded ivory toe nail');
      claw.rotation.x=.20;
    }
  }

  const leftArm = new THREE.Group(); leftArm.name = 'Greeting arm shoulder';
  leftArm.position.set(-.36,1.435,0); root.add(leftArm);
  const raisedArmPoints = [[0,0,0],[-.14,-.12,.025],[-.245,-.18,.05],[-.33,-.04,.10],[-.345,.11,.115],[-.335,.185,.115]];
  tube(leftArm,raisedArmPoints,
    [[0,.152,.160],[.2,.157,.160],[.4,.150,.154],[.6,.134,.139],[.77,.110,.155],[.90,.099,.145],[1,.024,.075]],
    skin,'Continuous raised arm wrist and open palm',{steps:78,sides:36});
  const leftWrist = new THREE.Group(); leftWrist.name = 'Greeting palm';
  leftWrist.position.set(-.34,.13,.115); leftArm.add(leftWrist);
  const raisedDigits = [[-.10,.035,-.17],[0,.065,0],[.095,.05,.16]];
  raisedDigits.forEach(([x,y,tilt]) => {
    const finger = soft(leftWrist,[x,y,0],[.059,.067,.055],skin,'Soft greeting knuckle');
    finger.rotation.z = tilt;
    const nail=soft(leftWrist,[x,y+.036,.041],[.035,.046,.030],clawMaterial,'Rounded greeting fingertip nail');
    nail.rotation.z=tilt;
  });
  const thumb = soft(leftWrist,[-.142,-.045,0],[.064,.075,.06],skin,'Soft open thumb'); thumb.rotation.z = -.65;
  const thumbNail=soft(leftWrist,[-.17,-.017,.043],[.036,.044,.029],clawMaterial,'Rounded thumb nail');thumbNail.rotation.z=-.65;

  const rightArm = new THREE.Group(); rightArm.name = 'Relaxed resting arm';
  rightArm.position.set(.36,1.425,-.01); root.add(rightArm);
  const restingArmPoints = [[0,0,0],[.12,-.15,.035],[.18,-.30,.12],[.205,-.43,.17],[.20,-.51,.19]];
  const rightShape = tube(rightArm,restingArmPoints,
    [[0,.152,.159],[.3,.158,.161],[.6,.146,.150],[.83,.118,.145],[1,.047,.075]],
    skin,'Continuous resting arm wrist and palm',{steps:68,sides:34});
  const rightWrist = new THREE.Group(); rightWrist.name = 'Loose resting hand';
  rightWrist.position.set(.20,-.455,.19); rightArm.add(rightWrist);
  [[-.09,-.043],[0,-.067],[.086,-.045]].forEach(([x,y]) => {
    soft(rightWrist,[x,y,0],[.057,.064,.055],skin,'Relaxed soft finger');
    const nail=soft(rightWrist,[x,y-.031,.043],[.034,.043,.028],clawMaterial,'Rounded resting fingertip nail');
    nail.rotation.z=-x;
  });
  soft(rightWrist,[-.12,.015,-.005],[.056,.073,.052],skin,'Resting thumb');
  soft(rightWrist,[-.13,-.012,.036],[.031,.039,.027],clawMaterial,'Rounded resting thumb nail');
  const limbSurface = (a,t,lift=0) => rightShape.sample(clamp(t,.02,.98),a,lift);
  [[-.55,.24,.21,.07,.2],[-.87,.38,.20,.075,-.4],[-.45,.48,.19,.065,-.35],[-.71,.62,.19,.068,.35]]
    .forEach(([a,t,w,h,r]) => marking(rightArm,limbSurface,[a,t],[w,h],r));

  // Lenticular leaf sculpt: both faces, a real rim, cupped cross-sections and twist.
  function leaf(parent, pathPoints, widthStops, { tone=colors.leaf, depth=.023, curl=.027, fold=0, name='Leaf blade', veinCount=4 } = {}) {
    const path = curve(pathPoints), steps = low?32:52, sides = low?12:20;
    const surface = (t,u,face=1,lift=0) => {
      const at = clamp(t,0,1), center = path.getPointAt(at), direction = path.getTangentAt(at).normalize();
      let across = V(-direction.y,direction.x,0);
      if (across.lengthSq()<.02) across = V(1,0,0);
      across.normalize();
      const width = Math.max(.001,interpolate(widthStops,at));
      const fullness = Math.sin(Math.PI*at);
      const p = center.addScaledVector(across,width*u);
      const ridge = .023*Math.exp(-u*u*15)*fullness;
      const cup = curl*u*u*fullness + fold*u*fullness;
      const thickness = .0032 + depth*Math.pow(Math.max(0,1-u*u),.8)*Math.pow(fullness,.55);
      p.z += cup + ridge + face*(thickness+lift);
      return p;
    };
    const positions=[],indices=[],paint=[];
    for (const face of [1,-1]) {
      const base=positions.length/3;
      for(let i=0;i<=steps;i+=1) {
        const t=i/steps;
        for(let j=0;j<=sides;j+=1) {
          const u=j/sides*2-1,p=surface(t,u,face);
          positions.push(p.x,p.y,p.z);
          const c=tone.clone().lerp(new THREE.Color('#b0c568'),.13*(1-u*u)+.05*Math.sin(Math.PI*t));
          if(face<0)c.multiplyScalar(.93);
          paint.push(c.r,c.g,c.b);
          if(i<steps&&j<sides) {
            const n=base+i*(sides+1)+j;
            if(face>0)indices.push(n,n+sides+1,n+1,n+1,n+sides+1,n+sides+2);
            else indices.push(n,n+1,n+sides+1,n+1,n+sides+2,n+sides+1);
          }
        }
      }
    }
    const faceSize=(steps+1)*(sides+1);
    const rim=[];
    for(let j=0;j<=sides;j+=1)rim.push(j);
    for(let i=1;i<=steps;i+=1)rim.push(i*(sides+1)+sides);
    for(let j=sides-1;j>=0;j-=1)rim.push(steps*(sides+1)+j);
    for(let i=steps-1;i>0;i-=1)rim.push(i*(sides+1));
    for(let i=0;i<rim.length;i+=1) {
      const a=rim[i],b=rim[(i+1)%rim.length];
      indices.push(a,b,a+faceSize,b,b+faceSize,a+faceSize);
    }
    const blade=mesh(geometry(positions,indices,paint),leafMaterial,parent,name);
    const frontVeins=[],backVeins=[];
    for(const face of [1,-1]) {
      const veins=face>0?frontVeins:backVeins;
      const line=[];
      for(let j=0;j<=18;j+=1)line.push(surface(.015+j/18*.97,0,face,.004));
      veins.push(sculptSweep(new THREE.CatmullRomCurve3(line),[[0,.012,.011],[.35,.011,.009],[1,.003,.003]],{steps:44,sides:10}).geometry);
      for(let i=0;i<veinCount;i+=1) {
        const t=.20+i*(.59/Math.max(1,veinCount-1));
        for(const side of [-1,1]) {
          const points=[];
          for(let k=0;k<=10;k+=1) {
            const s=k/10;
            points.push(surface(t+.135*s,side*.94*Math.pow(s,.92),face,.0038));
          }
          veins.push(sculptSweep(new THREE.CatmullRomCurve3(points),[[0,.0068,.006],[.6,.0046,.0042],[1,.0013,.0013]],{steps:20,sides:8}).geometry);
        }
      }
    }
    mesh(mergeGeometry(frontVeins),veinMaterial,parent,`${name} · raised front veins`);
    mesh(mergeGeometry(backVeins),veinBackMaterial,parent,`${name} · raised back veins`);
    return {blade,surface};
  }

  const wings=[];
  for(const side of [-1,1]) {
    const wing=new THREE.Group(); wing.name=side<0?'Left folded leaf wing':'Right folded leaf wing';
    wing.position.copy(bodySurface(side*2.30,1.43,-.024).point); root.add(wing); wings.push(wing);
    const p=(x,y,z)=>[side*x,y,z];
    soft(wing,[0,-.02,-.006],[.082,.105,.084],skin,'Natural wing shoulder');
    // Underfold remains visibly separate along its lower, darker edge.
    leaf(wing,[p(0,-.015,-.04),p(.09,-.19,-.185),p(.25,-.405,-.20),p(.38,-.595,-.14)],
      [[0,.015],[.22,.105],[.53,.141],[.8,.105],[1,.002]],
      {tone:colors.fold,depth:.021,curl:.032,fold:side*.027,name:'Inner folded leaf wing',veinCount:3});
    leaf(wing,[p(0,0,0),p(.16,.135,-.085),p(.375,-.012,-.125),p(.585,-.405,-.08)],
      [[0,.018],[.18,.105],[.43,.172],[.67,.163],[.85,.102],[1,.002]],
      {tone:colors.leaf,depth:.024,curl:.035,fold:side*.023,name:'Outer cupped leaf wing',veinCount:4});
  }

  wings.forEach(wing => wing.traverse(node => { node.userData.companionAnatomy = false; }));
  const tail=makeTail({root,tube,leaf,marking,skinPainted,colors,skinColor,low});

  const leftRig = makeArmRig(root, leftArm, leftWrist, raisedArmPoints);
  const rightRig = makeArmRig(root, rightArm, rightWrist, restingArmPoints);
  const hipHeight = .55, upperBody = new THREE.Group();
  upperBody.name = 'Planted hips · shared chest shoulder and neck posture';
  upperBody.position.y = hipHeight; root.add(upperBody);
  [bodyRig, leftArm, rightArm, ...wings].forEach(part => { upperBody.add(part); part.position.y -= hipHeight; });
  const neckAnchor = new THREE.Group(); neckAnchor.name = 'Living body neck attachment';
  neckAnchor.position.set(0, 1.66 - hipHeight, .055 / 1.04); upperBody.add(neckAnchor);

  const leftRest = [[0,0,0],[-.14,-.12,.025],[-.245,-.18,.05],[-.32,-.315,.105],[-.34,-.46,.15],[-.33,-.535,.18]];
  const leftGroom = [[0,0,0],[-.14,-.025,.10],[-.24,.04,.28],[-.22,.17,.44],[-.19,.34,.51],[-.17,.43,.53]];
  const rightGroom = [[0,0,0],[.10,.02,.12],[.17,.16,.29],[.19,.32,.493],[.15,.43,.52]];
  const leftStretch = [[0,0,0],[-.15,-.05,.005],[-.30,-.025,.025],[-.46,.04,.045],[-.59,.10,.03],[-.66,.15,.02]];
  const rightStretch = [[0,0,0],[.17,-.04,.005],[.35,0,.035],[.53,.10,.03],[.66,.16,.02]];
  const leftPose = leftRest.map(p => V(...p)), rightPose = restingArmPoints.map(p => V(...p));
  const blendArm = (points, target, weight) => points.forEach((p, i) => {
    p.x += (target[i][0] - p.x) * weight; p.y += (target[i][1] - p.y) * weight; p.z += (target[i][2] - p.z) * weight;
  });
  const poseWindow = (p, a, b, c, d) => smooth((p - a) / (b - a)) * (1 - smooth((p - c) / (d - c)));
  const puff = (p, center, width) => Math.exp(-(((p - center) / width) ** 2));

  // Every pose starts from rest. The feet and tail root stay planted while the
  // chest, shoulders and attached head share one small shift above the hips.
  function update(t=0,wave=0,reduced=false,activity=null) {
    const seconds=Number.isFinite(t)?t:0, greeting=clamp(Number(wave)||0,0,1), motion=reduced?0:1;
    const kind=activity?.kind||'rest', phase=clamp(Number(activity?.phase)||0,0,1);
    const weight=clamp(Number(activity?.weight)||0,0,1)*(1-greeting)*motion, side=activity?.side<0?-1:1;
    const active=poseWindow(phase,.08,.24,.77,1)*weight;
    const look=kind==='look'?active:0, sniff=kind==='sniff'?active:0;
    const groom=kind==='groom'?poseWindow(phase,.14,.30,.71,.94)*weight:0;
    const stretch=kind==='stretch'?poseWindow(phase,.12,.34,.69,.98)*weight:0;
    const stretchPrep=kind==='stretch'?poseWindow(phase,0,.09,.16,.27)*weight:0;
    const doze=kind==='doze'?poseWindow(phase,.08,.27,.78,1)*weight:0, rest=kind==='rest'?active:0;
    const dips=(puff(phase,.37,.07)+puff(phase,.63,.07))*sniff;
    const glance=side*(1-2*smooth((phase-.43)/.19));
    const breathPhase=seconds*1.57+.10*Math.sin(seconds*.27);
    const breathe=(Math.sin(breathPhase)+.16*Math.sin(seconds*.61+.9))*(1-.68*doze)*motion;
    const settle=motion*(Math.sin(seconds*.37+.6)*.006+Math.sin(seconds*.71)*.003)*(1-.93*doze);
    upperBody.position.set(settle*.65+look*glance*.012+rest*side*.009,hipHeight-.019*doze-.014*dips-.018*stretchPrep,.024*sniff-.012*stretch);
    upperBody.rotation.set(.009*breathe+.095*sniff+.030*dips-.045*stretch+.031*doze+.018*stretchPrep,
      look*glance*.075+groom*side*.025,-settle-look*glance*.016-groom*side*.016-rest*side*.010);
    upperBody.scale.set(1,1-.016*doze+.012*stretch-.010*stretchPrep,1);
    bodyRig.scale.set(1+breathe*.004,1,1+breathe*.007+stretch*.010);

    leftPose.forEach((p,i)=>p.set(...leftRest[i])); rightPose.forEach((p,i)=>p.set(...restingArmPoints[i]));
    blendArm(leftPose,leftStretch,stretch); blendArm(rightPose,rightStretch,stretch);
    if(side<0)blendArm(leftPose,leftGroom,groom);else blendArm(rightPose,rightGroom,groom);
    const stroke=groom*poseWindow(phase,.29,.33,.68,.72)*Math.sin((phase-.30)/.40*TAU*2);
    const working=side<0?leftPose:rightPose;
    working.forEach((p,i)=>{const tip=smooth(i/(working.length-1));p.y+=stroke*.025*tip;p.x+=side*stroke*.013*tip;});
    blendArm(leftPose,raisedArmPoints,greeting);
    const handWave=greeting*motion*Math.sin(seconds*9.5);
    leftPose.forEach((p,i)=>{const tip=smooth(i/(leftPose.length-1));p.x+=handWave*.055*tip;p.y+=greeting*motion*.012*Math.sin(seconds*4.75)*tip;});
    leftArm.position.set(-.36,1.435-hipHeight+(side<0?groom*.04:0)-stretchPrep*.025,(side<0?groom*.17:0));
    rightArm.position.set(.36,1.425-hipHeight+(side>0?groom*.08:0)-stretchPrep*.025,-.01+(side>0?groom*.19:0));
    leftArm.rotation.set(0,0,settle*.7); rightArm.rotation.set(0,0,settle*.6);
    leftRig.pose(leftPose,handWave*.13+(side<0?groom*.08:0));
    rightRig.pose(rightPose,side>0?-groom*.08:0);
    wings.forEach((wing,index)=>{
      const sign=index===0?-1:1, wingBreath=motion*(Math.sin(seconds*1.11+.8)*.012+Math.sin(seconds*.43)*.006)*(1-.94*doze);
      wing.rotation.set(stretch*.13+doze*.035,sign*(wingBreath+greeting*motion*.018+stretch*.30-doze*.06),
        sign*(wingBreath*.45+stretch*.66-doze*.045-stretchPrep*.04));
    });
    tail.update(seconds,greeting,reduced,{kind,phase,weight,side});
  }
  update(0,0,false);
  return {root,update,neckAnchor,torso:bodyRig,chest:upperBody,feet,wings,tail,
    arms:[leftArm,rightArm],hands:[leftRig.hand,rightRig.hand]};
}
