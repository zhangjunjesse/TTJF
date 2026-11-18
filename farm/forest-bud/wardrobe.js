import * as THREE from 'three';
import { group } from '../primitives.js';
import { dragonForm, dressDragon, makeDragonDetails, animateDragonDetails } from '../dragon-forms.js';

// All stages are built from the approved newborn sculpture. Growth changes its
// proportions, curled horns and living leaf wings; the two looks only change
// clothes. Neither a preview nor a wardrobe writes to the family ledger.
const GROWTH = [
  { size: 1, head: [1, 1, 1], body: [1.07, 1, 1.04], wing: 1, spread: 0, horn: 1, tail: 1,
    skin: 0xb5cd78, leaf: 0x91ae53 },
  { size: 1.06, head: [.98, .99, 1], body: [1.07, 1.025, 1.04], wing: 1.18, spread: .08, horn: 1.10, tail: 1.07,
    skin: 0x93bc76, leaf: 0x74a96b },
  { size: 1.12, head: [.96, .98, 1.02], body: [1.07, 1.05, 1.04], wing: 1.43, spread: .20, horn: 1.22, tail: 1.14,
    skin: 0x73b4c2, leaf: 0x69b6c7 },
  { size: 1.18, head: [.98, 1.02, 1.04], body: [1.09, 1.075, 1.05], wing: 1.70, spread: .35, horn: 1.35, tail: 1.21,
    skin: 0xb19bc9, leaf: 0xa091cc },
  { size: 1.24, head: [1, 1.04, 1.06], body: [1.11, 1.10, 1.06], wing: 1.94, spread: .48, horn: 1.48, tail: 1.28,
    skin: 0xe0bf79, leaf: 0xd4b56d }
];

function changeGrowthShape(anchors, stage) {
  const growth = GROWTH[stage - 1];
  anchors.puppet.scale.setScalar(growth.size);
  anchors.body.scale.set(...growth.body);
  // Head joints sit inside the body, but the head keeps its own round volume.
  anchors.neck.scale.set(1 / growth.body[0], 1, 1 / growth.body[2]);
  anchors.head.scale.set(...growth.head);
  anchors.tail.scale.setScalar(growth.tail);
  anchors.wings.forEach((wing, index) => {
    wing.scale.setScalar(growth.wing);
    if (!growth.spread) return;
    const leaves = group(null); leaves.name = 'forest-bud-grown-leaf-fan';
    while (wing.children.length) leaves.add(wing.children[0]);
    leaves.rotation.z = (index ? 1 : -1) * growth.spread;
    wing.add(leaves);
  });
  if (stage > 1) {
    const horns = [];
    anchors.expression.traverse(node => {
      if (node.isMesh && /inward curled ivory horn/.test(node.name)) horns.push(node);
    });
    horns.forEach(horn => {
      const side = horn.name.startsWith('left') ? -1 : 1;
      const base = group(horn.parent, [side * .465, 1.005, -.065]);
      base.name = 'forest-bud-growing-curled-horn';
      base.add(horn); horn.position.set(-side * .465, -1.005, .065);
      base.scale.set(1 + (growth.horn - 1) * .55, growth.horn, growth.horn);
    });
  }
}

// Reuse the original painted gradients and warm cheeks. The remap happens after
// the face pigment and eyelid shaders, so the growing palette covers the muzzle
// as well as the body without changing pupils, eye whites, cream scutes or horns.
function growthPalette(root, stage) {
  if (stage === 1) return;
  const growth = GROWTH[stage - 1], changed = new Set();
  root.traverse(mesh => {
    if (!mesh.isMesh) return;
    const leaf = /leaf wing|tail leaf|succulent leaf|leaf rib|leaf vein|leaf rim/.test(mesh.name);
    const skin = /torso|round tail skin|skin marking|haunch ankle|arm wrist|knuckle|thumb|soft finger|rounded skull|skin eyelid|eyelid margin|leaf freckle|wing shoulder/.test(mesh.name);
    if (!leaf && !skin) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (changed.has(material)) continue;
      changed.add(material);
      const tint = new THREE.Color(leaf ? growth.leaf : growth.skin);
      const previousCompile = material.onBeforeCompile;
      const previousKey = material.customProgramCacheKey.bind(material);
      const glsl = [tint.r, tint.g, tint.b].map(value => value.toFixed(6)).join(',');
      material.onBeforeCompile = shader => {
        previousCompile.call(material, shader);
        shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `
          vec3 budGrowthTint = vec3(${glsl});
          float budGrowthMask = smoothstep(-.012, .055, diffuseColor.g - diffuseColor.r)
            * smoothstep(.015, .12, diffuseColor.g - diffuseColor.b);
          float budGrowthLight = dot(diffuseColor.rgb, vec3(.2126, .7152, .0722));
          vec3 budGrowthColor = budGrowthTint * budGrowthLight
            / max(.04, dot(budGrowthTint, vec3(.2126, .7152, .0722)));
          diffuseColor.rgb = mix(diffuseColor.rgb, budGrowthColor, budGrowthMask * .96);
          #include <roughnessmap_fragment>
        `);
      };
      material.customProgramCacheKey = () => previousKey() + '|forest-bud-growth-' + stage + '-' + tint.getHexString();
      material.userData.forestBudPalette = stage;
      material.needsUpdate = true;
    }
  });
}

// The source torso and head are indexed smooth geometry. Project clothes onto
// their actual front triangles, including narrow shoulders and the crown band.
function frontFit(mesh, offsetY = 0) {
  const vertices = mesh.geometry.attributes.position, index = mesh.geometry.index;
  const count = index ? index.count : vertices.count, memo = new Map();
  const ray = new THREE.Ray(), a = new THREE.Vector3(), b = new THREE.Vector3();
  const c = new THREE.Vector3(), hit = new THREE.Vector3();
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  const bounds = mesh.geometry.boundingBox, columns = 32, rows = 48;
  const xScale = columns / (bounds.max.x - bounds.min.x), yScale = rows / (bounds.max.y - bounds.min.y);
  const xCell = x => Math.max(0, Math.min(columns - 1, Math.floor((x - bounds.min.x) * xScale)));
  const yCell = y => Math.max(0, Math.min(rows - 1, Math.floor((y - bounds.min.y) * yScale)));
  const cells = Array.from({ length: columns * rows }, () => []);
  const triangle = i => {
    a.fromBufferAttribute(vertices, index ? index.getX(i) : i);
    b.fromBufferAttribute(vertices, index ? index.getX(i + 1) : i + 1);
    c.fromBufferAttribute(vertices, index ? index.getX(i + 2) : i + 2);
  };
  // Index exact XY triangle bounds once. A fit query intersects only the local
  // candidates, retaining the same skin surface without a rounded approximation.
  for (let i = 0; i < count; i += 3) {
    triangle(i);
    const left = xCell(Math.min(a.x, b.x, c.x)), right = xCell(Math.max(a.x, b.x, c.x));
    const bottom = yCell(Math.min(a.y, b.y, c.y)), top = yCell(Math.max(a.y, b.y, c.y));
    for (let y = bottom; y <= top; y++) for (let x = left; x <= right; x++) cells[y * columns + x].push(i);
  }
  return (x, y) => {
    const key = x.toFixed(6) + ':' + y.toFixed(6);
    if (memo.has(key)) return memo.get(key);
    const at = y + offsetY;
    if (x < bounds.min.x || x > bounds.max.x || at < bounds.min.y || at > bounds.max.y) return -Infinity;
    ray.origin.set(x, at, 3); ray.direction.set(0, 0, -1);
    let front = -Infinity;
    for (const i of cells[yCell(at) * columns + xCell(x)]) {
      triangle(i);
      if (ray.intersectTriangle(a, b, c, false, hit)) front = Math.max(front, hit.z);
    }
    memo.set(key, front); return front;
  };
}

// Garment geometry and the existing stage props share the Workshop's ownership.
// Cloth uses the same soft physical lighting as the dragon instead of replacing
// the sculpture's materials or flattening its animated skeleton into one mesh.
function curvedGarment(workshop, source, fit) {
  const points = source.attributes.position, index = source.index, positions = [];
  const vertex = i => {
    const n = index ? index.getX(i) : i, x = points.getX(n), y = points.getY(n), z = points.getZ(n);
    const front = z > 0 ? fit(x, y) : -Infinity;
    return [x, y, z, Number.isFinite(front) ? z - front : null];
  };
  const middle = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2,
    a[3] === null || b[3] === null ? null : (a[3] + b[3]) / 2];
  const emit = (a, b, c, depth) => {
    if (depth) {
      const ab = middle(a, b), bc = middle(b, c), ca = middle(c, a);
      emit(a, ab, ca, depth - 1); emit(ab, b, bc, depth - 1);
      emit(ca, bc, c, depth - 1); emit(ab, bc, ca, depth - 1); return;
    }
    for (const point of [a, b, c]) {
      const front = point[3] === null ? -Infinity : fit(point[0], point[1]);
      positions.push(point[0], point[1], Number.isFinite(front) ? front + point[3] : point[2]);
    }
  };
  for (let i = 0; i < (index ? index.count : points.count); i += 3) emit(vertex(i), vertex(i + 1), vertex(i + 2), 2);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals(); workshop.geometries.add(geometry); return geometry;
}

function garmentWorkshop(workshop, surfaces, quality) {
  const materials = new Map(), garment = Object.create(workshop);
  garment.material = (color, options = {}) => {
    const metal = color === 0xd5b367;
    const material = new THREE.MeshPhysicalMaterial({ color, roughness: metal ? .39 : .76,
      metalness: metal ? .32 : 0, sheen: metal || quality === 'low' ? 0 : .18, sheenRoughness: .84, ...options });
    workshop.materials.add(material); return material;
  };
  garment.add = (parent, geometry, color, position, scale, rotation) => {
    if (!materials.has(color)) materials.set(color, garment.material(color));
    const surface = !position && surfaces.find(item => item.parent === parent);
    if (surface) geometry = curvedGarment(workshop, geometry, surface.fit);
    const mesh = new THREE.Mesh(geometry, materials.get(color));
    if (position) mesh.position.set(...position);
    if (scale) mesh.scale.set(...scale);
    if (rotation) mesh.rotation.set(...rotation);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.companionWardrobe = true;
    parent.add(mesh); return mesh;
  };
  return garment;
}

function wardrobeController(w, pet, anchors, before, stage, variant, stars) {
  const owned = Object.fromEntries(Object.keys(before).map(key => [key, new Set([...w[key]].filter(value => !before[key].has(value)))]));
  const held = [];
  anchors.puppet.traverse(node => {
    if (node.userData.heldOrientation) held.push({ node,
      side: node.userData.heldSide || 0,
      rotation: new THREE.Quaternion().setFromEuler(new THREE.Euler(...node.userData.heldOrientation)) });
  });
  const chestRotation = new THREE.Quaternion(), parentRotation = new THREE.Quaternion();
  const extraRotation = new THREE.Quaternion(), vertical = new THREE.Vector3(0, 0, 1), grip = new THREE.Vector3();
  let disposed = false;
  return { stage, variant, stars,
    update(seconds, reducedMotion) {
      animateDragonDetails(pet.dragonDetails, seconds, reducedMotion);
      // Palms rotate from a hanging pose to an open greeting. Keep a held staff
      // upright in chest space while its grip follows the actual moving palm.
      anchors.chest.getWorldQuaternion(chestRotation);
      for (const item of held) {
        item.node.parent.getWorldQuaternion(parentRotation).invert();
        item.node.quaternion.copy(parentRotation).multiply(chestRotation).multiply(item.rotation);
        if (item.side) {
          item.node.parent.getWorldPosition(grip); anchors.chest.worldToLocal(grip);
          const raised = THREE.MathUtils.clamp((grip.y - .52) / .45, 0, 1);
          item.node.quaternion.multiply(extraRotation.setFromAxisAngle(vertical, -item.side * raised * .50));
        }
      }
    },
    dispose() {
      if (disposed) return; disposed = true;
      for (const key of Object.keys(owned)) for (const resource of owned[key]) if (w[key].delete(resource)) resource.dispose();
      for (const [key, value] of w.cache) if (Object.values(owned).some(values => values.has(value))) w.cache.delete(key);
      for (const values of Object.values(owned)) values.clear();
    }
  };
}

export function equipForestBud(w, pet, { stage, variant = 'default', quality = 'high', stars = 0 }) {
  const before = Object.fromEntries(['geometries', 'materials', 'textures'].map(key => [key, new Set(w[key])]));
  const anchors = pet.anchors;
  changeGrowthShape(anchors, stage);
  growthPalette(anchors.puppet, stage);
  const torso = anchors.torso.children.find(mesh => mesh.isMesh && /Continuous pear torso/.test(mesh.name));
  let skull;
  anchors.expression.traverse(mesh => { if (mesh.isMesh && /smooth-union rounded skull/.test(mesh.name)) skull = mesh; });
  const body = group(anchors.chest, [0, -.55, 0]), head = group(anchors.expression, [0, .56, 0]);
  body.name = 'forest-bud-body-wardrobe'; head.name = 'forest-bud-head-wardrobe';
  const form = { ...dragonForm(stage), forestBud: true, shoulder: 1.435, collarY: 1.57,
    hands: [anchors.leftHand, anchors.rightHand], headFit: frontFit(skull, .56) };
  const fit = frontFit(torso); form.bodyFit = fit;
  const clothes = garmentWorkshop(w, [{ parent: body, fit }, { parent: head, fit: form.headFit }], quality);
  dressDragon(clothes, body, head, [anchors.leftArm, anchors.rightArm], stage, form, variant, fit);
  if (stars > 0) {
    const badge = group(body, [-.17, 1.12, fit(-.17, 1.12) + .12]); badge.name = 'forest-bud-earned-star';
    clothes.star(badge, 0xd5b367, [0, 0, 0], .085);
  }
  pet.dragonDetails = makeDragonDetails(w, pet);
  pet.heldHands = variant === 'festival'
    ? { left: stage !== 2, right: stage === 2 || stage === 3 || stage === 4 }
    : { left: stage >= 4, right: false };
  pet.wardrobe = wardrobeController(w, pet, anchors, before, stage, variant, stars);
  return pet.wardrobe;
}
