import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Shared low-poly primitives and a single vertex-colour Lambert material per scene.
// Baking static assemblies cuts draw calls without changing their silhouettes.
export class Workshop {
  constructor() {
    this.geometries = new Set();
    this.materials = new Set();
    this.textures = new Set();
    this.cache = new Map();
    this.paint = this.material(0xffffff, { vertexColors: true });
  }
  material(color, options = {}) {
    const m = new THREE.MeshLambertMaterial({ color, ...options });
    this.materials.add(m);
    return m;
  }
  geometry(key, create) {
    if (!this.cache.has(key)) {
      const geometry = create();
      this.cache.set(key, geometry);
      this.geometries.add(geometry);
    }
    return this.cache.get(key);
  }
  add(parent, geo, color, position, scale, rotation) {
    const key = 'm' + color;
    if (!this.cache.has(key)) this.cache.set(key, this.material(color));
    const mesh = new THREE.Mesh(geo, this.cache.get(key));
    if (position) mesh.position.set(...position);
    if (scale) mesh.scale.set(...scale);
    if (rotation) mesh.rotation.set(...rotation);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  orb(p, color, pos, size = [1, 1, 1], detail = 1) {
    return this.add(p, this.geometry('orb' + detail, () => new THREE.IcosahedronGeometry(1, detail)), color, pos, size);
  }
  ball(p, color, pos, size = [1, 1, 1]) {
    return this.add(p, this.geometry('ball', () => new THREE.SphereGeometry(1, 16, 10)), color, pos, size);
  }
  box(p, color, pos, size, rot) {
    return this.add(p, this.geometry('box', () => new THREE.BoxGeometry(1, 1, 1)), color, pos, size, rot);
  }
  cone(p, color, pos, size, rot) {
    return this.add(p, this.geometry('cone', () => new THREE.ConeGeometry(1, 1, 7)), color, pos, size, rot);
  }
  cylinder(p, color, pos, radius, height, top = radius, rot) {
    const key = `cylinder:${radius}:${height}:${top}`;
    return this.add(p, this.geometry(key, () => new THREE.CylinderGeometry(top, radius, height, 10)), color, pos, null, rot);
  }
  ring(p, color, pos, radius, tube = .035, rot) {
    const key = `ring:${radius}:${tube}`;
    return this.add(p, this.geometry(key, () => new THREE.TorusGeometry(radius, tube, 5, 32)), color, pos, null, rot);
  }
  beam(p, color, a, b, radius) {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
    const mesh = this.cylinder(p, color, start.clone().add(end).multiplyScalar(.5).toArray(), radius, start.distanceTo(end));
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.sub(start).normalize());
    return mesh;
  }
  polygon(p, color, points, depth, pos, rot) {
    const shape = new THREE.Shape();
    points.forEach((v, i) => i ? shape.lineTo(...v) : shape.moveTo(...v));
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
    this.geometries.add(geometry);
    return this.add(p, geometry, color, pos, null, rot);
  }
  star(p, color, pos, radius = .16) {
    const points = [];
    for (let i = 0; i < 10; i++) { const a = Math.PI / 2 + i * Math.PI / 5; const r = i % 2 ? radius * .48 : radius; points.push([Math.cos(a) * r, Math.sin(a) * r]); }
    return this.polygon(p, color, points, .035, pos);
  }
  bake(root) {
    root.updateMatrixWorld(true);
    const inverse = root.matrixWorld.clone().invert(), pieces = [];
    const remove = [];
    root.traverse(mesh => {
      // A static batch cannot retain a rig's skin weights, bone palette or
      // expression targets. Leave deforming meshes attached to their live rig.
      if (!mesh.isMesh || mesh.isSkinnedMesh || mesh.morphTargetInfluences?.length || Array.isArray(mesh.material) || mesh.material.transparent || mesh.material.map || mesh.userData.keep) return;
      const geom = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      // Imported GLBs use KHR_mesh_quantization. Expand normalized integer
      // positions BEFORE transforming; writing metre coordinates back to an
      // Int16 attribute otherwise wraps/clamps buildings and crop geometry.
      for (const key of ['position', 'normal']) {
        const attribute = geom.attributes[key];
        if (attribute && !(attribute.array instanceof Float32Array)) {
          const values = new Float32Array(attribute.count * attribute.itemSize);
          for (let i = 0; i < attribute.count; i++) {
            values[i * attribute.itemSize] = attribute.getX(i);
            values[i * attribute.itemSize + 1] = attribute.getY(i);
            values[i * attribute.itemSize + 2] = attribute.getZ(i);
          }
          geom.setAttribute(key, new THREE.BufferAttribute(values, attribute.itemSize));
        }
      }
      geom.applyMatrix4(inverse.clone().multiply(mesh.matrixWorld));
      for (const key of Object.keys(geom.attributes)) if (!['position', 'normal', 'color'].includes(key)) geom.deleteAttribute(key);
      if (!geom.attributes.normal) geom.computeVertexNormals();
      const n = geom.attributes.position.count, color = mesh.material.color;
      const source = geom.attributes.color, colors = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        colors[i * 3] = (source ? source.getX(i) : 1) * color.r;
        colors[i * 3 + 1] = (source ? source.getY(i) : 1) * color.g;
        colors[i * 3 + 2] = (source ? source.getZ(i) : 1) * color.b;
      }
      geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geom.clearGroups(); pieces.push(geom); remove.push(mesh);
    });
    if (!pieces.length) return root;
    const merged = mergeGeometries(pieces, false);
    pieces.forEach(g => g.dispose());
    if (merged) {
      this.geometries.add(merged);
      remove.forEach(m => m.removeFromParent());
      const mesh = new THREE.Mesh(merged, this.paint);
      mesh.castShadow = true; mesh.receiveShadow = true;
      root.add(mesh);
    }
    return root;
  }
  dispose() {
    this.geometries.forEach(g => g.dispose());
    this.materials.forEach(m => m.dispose());
    this.textures.forEach(t => t.dispose());
    this.cache.clear(); this.geometries.clear(); this.materials.clear(); this.textures.clear();
  }
}
export const group = (parent, pos = [0, 0, 0]) => {
  const g = new THREE.Group(); g.position.set(...pos); if (parent) parent.add(g); return g;
};
export const TAU = Math.PI * 2;
