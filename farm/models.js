import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import carrot from '../assets/farm/models/carrot.glb';
import strawberry from '../assets/farm/models/strawberry.glb';
import sunflower from '../assets/farm/models/sunflower.glb';
import chicken from '../assets/farm/models/chicken.glb';
import rabbit from '../assets/farm/models/rabbit.glb';
import house1 from '../assets/farm/models/farmhouse-1.glb';
import house2 from '../assets/farm/models/farmhouse-2.glb';
import house3 from '../assets/farm/models/farmhouse-3.glb';
import props from '../assets/farm/models/props.glb';
import debris from '../assets/farm/models/debris.glb';
import apple from '../assets/farm/models/apple_tree.glb';
import pine from '../assets/farm/models/pine.glb';
import coop from '../assets/farm/models/coop.glb';
import hutch from '../assets/farm/models/hutch.glb';
import well from '../assets/farm/models/stone_well.glb';
import hay from '../assets/farm/models/hay_bales.glb';
import scarecrow from '../assets/farm/models/scarecrow.glb';
import flowers from '../assets/farm/models/flower_bed.glb';
import wheelbarrow from '../assets/farm/models/wheelbarrow.glb';
import lantern from '../assets/farm/models/lantern.glb';
import barn from '../assets/farm/models/barn.glb';
import bench from '../assets/farm/models/sunset_bench.glb';

const urls = { carrot, strawberry, sunflower, chicken, rabbit, house1, house2, house3, props, debris, apple, pine, coop, hutch, well, hay, scarecrow, flowers, wheelbarrow, lantern, barn, bench };
function bytes(data) {
  const raw = atob(data.slice(data.indexOf(',') + 1)), result = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) result[i] = raw.charCodeAt(i);
  return result.buffer;
}

export async function loadModels() {
  const manager = new THREE.LoadingManager();
  // All buffers are embedded in the GLBs; deny any accidental external resource.
  manager.setURLModifier(url => {
    if (/^(data:|blob:)/.test(url)) return url;
    throw new Error('FARM_EXTERNAL_ASSET_BLOCKED');
  });
  const loader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
  const models = {}, resources = new Set();
  function release() {
    resources.forEach(resource => resource.dispose()); resources.clear();
  }
  try {
    // Sequential parsing also caps peak decoder/buffer memory on older iPads.
    for (const [key, data] of Object.entries(urls)) {
      const gltf = await loader.parseAsync(bytes(data), '');
      gltf.scene.traverse(node => {
        if (!node.isMesh) return;
        resources.add(node.geometry);
        const old = node.material;
        const material = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: !!node.geometry.attributes.color, side: old?.side ?? THREE.FrontSide });
        resources.add(material);
        if (old?.color) material.color.copy(old.color);
        node.material = material; node.castShadow = true; node.receiveShadow = true;
        if (Array.isArray(old)) old.forEach(m => m.dispose()); else old?.dispose();
      });
      models[key] = gltf.scene;
    }
    return {
      models,
      dispose: release,
      clone(key, nodeName, maxSize, useHeight = false) {
        const source = models[key]?.getObjectByName(nodeName);
        if (!source) throw new Error('FARM_MODEL_MISSING:' + nodeName);
        const node = source.clone(true), root = new THREE.Group(); root.add(node);
        root.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(root), size = bounds.getSize(new THREE.Vector3());
        const factor = maxSize / (useHeight ? size.y : Math.max(size.x, size.z));
        root.scale.setScalar(factor);
        node.position.x -= (bounds.min.x + bounds.max.x) / 2;
        node.position.z -= (bounds.min.z + bounds.max.z) / 2;
        node.position.y -= bounds.min.y;
        return root;
      }
    };
  } catch (error) { release(); throw error; }
}
