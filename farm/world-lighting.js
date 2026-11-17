import * as THREE from 'three';
import { group } from './primitives.js';

// Warm window emission follows the actual blue glass vertex colours in the
// farmhouse mesh. Mullions, shutters, the roof and walls retain their geometry.
export function addWindowGlow(w, house, uniform) {
  house.traverse(mesh => {
    if (!mesh.isMesh || !mesh.geometry.attributes.color) return;
    const material = mesh.material.clone(); w.materials.add(material); mesh.material = material;
    material.onBeforeCompile = shader => {
      shader.uniforms.farmNight = uniform;
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying float farmUp;').replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nfarmUp = abs(objectNormal.y);');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float farmNight;\nvarying float farmUp;').replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\nfloat windowMask = step(vColor.r * 1.20, vColor.g) * step(vColor.r * 1.30, vColor.b) * step(0.22, vColor.b);\nwindowMask *= (1.0 - smoothstep(0.3, 0.7, farmUp)) * mix(1.0, 0.16, smoothstep(0.45, 0.60, vColor.r));\ntotalEmissiveRadiance += vec3(2.6, 1.10, 0.21) * windowMask * farmNight;');
    };
    material.customProgramCacheKey = () => 'farm-window-emission-v2';
  });
}
export function makeNightLights(w, world, hasHouse) {
  const root = group(world), data = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const d = Math.hypot((x-31.5)/31.5,(y-31.5)/31.5), k=(y*64+x)*4;
    data[k]=255;data[k+1]=255;data[k+2]=255;data[k+3]=Math.max(0,Math.pow(1-Math.min(1,d),2))*255;
  }
  const texture = new THREE.DataTexture(data,64,64,THREE.RGBAFormat); texture.magFilter=THREE.LinearFilter;texture.minFilter=THREE.LinearFilter;texture.needsUpdate=true;w.textures.add(texture);
  const poolMaterial = new THREE.MeshBasicMaterial({color:0xffb651,map:texture,transparent:true,opacity:.34,blending:THREE.AdditiveBlending,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1});w.materials.add(poolMaterial);
  const lampMaterial = new THREE.MeshBasicMaterial({color:0xffd178});w.materials.add(lampMaterial);
  const plane = w.geometry('lamp-pool',()=>new THREE.PlaneGeometry(1,1));
  for(const [x,z] of [[-3.5,-1],[-3.5,6.3],[.1,4.7],[8.1,4.5]]) {
    const glow=new THREE.Mesh(w.geometry('night-lamp-glass',()=>new THREE.BoxGeometry(.15,.19,.15)),lampMaterial);glow.position.set(x,1.18,z);glow.userData.keep=true;root.add(glow);
    const pool=new THREE.Mesh(plane,poolMaterial);pool.rotation.x=-Math.PI/2;pool.position.set(x,.03,z);pool.scale.set(4.4,4.4,1);pool.userData.keep=true;root.add(pool);
  }
  // A small fixed light set gives real falloff on nearby characters, railings and
  // the porch. These lights do not allocate any extra shadow maps.
  for(const [x,y,z,power,range] of [...(hasHouse?[[-4.15,1.3,-2.2,8,5.0]]:[]),[-3.5,1.12,6.3,4.5,4.5],[.1,1.12,4.7,4.5,4.5],[8.1,1.12,4.5,4.5,4.5]]) {
    const light=new THREE.PointLight(0xffbc63,power,range,2);light.position.set(x,y,z);root.add(light);
  }
  root.visible=false;return root;
}
