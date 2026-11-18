import * as THREE from 'three';

// WebGL1 without float vertex textures cannot draw Three's SkinnedMesh.
// Use the same tail skeleton on the CPU only for that capability fallback.
export function makeCpuTailSkin(root, enabled) {
  const pairs=[],point=new THREE.Vector3();
  if(enabled) {
    const sources=[];root.traverse(node=>{if(node.isSkinnedMesh)sources.push(node);});
    for(const source of sources) {
      const geometry=source.geometry.clone();
      geometry.deleteAttribute('skinIndex');geometry.deleteAttribute('skinWeight');
      const mesh=new THREE.Mesh(geometry,source.material);
      mesh.name=source.name;mesh.position.copy(source.position);mesh.quaternion.copy(source.quaternion);mesh.scale.copy(source.scale);
      mesh.castShadow=source.castShadow;mesh.receiveShadow=source.receiveShadow;
      source.parent.add(mesh);source.visible=false;
      pairs.push({source,mesh});
    }
  }
  const bones=pairs.length?pairs[0].source.skeleton.bones:[];
  const last=new Float64Array(bones.length*7).fill(Infinity),sample=new Float64Array(last.length);
  return {
    update() {
      if(!pairs.length)return;
      let changed=false;
      for(let i=0;i<bones.length;i++) {
        bones[i].position.toArray(sample,i*7);bones[i].quaternion.toArray(sample,i*7+3);
      }
      for(let i=0;i<sample.length;i++)if(sample[i]!==last[i]){changed=true;break;}
      if(!changed)return;last.set(sample);
      root.updateWorldMatrix(true,false);root.updateMatrixWorld(true);
      for(const {source,mesh} of pairs) {
        const positions=mesh.geometry.attributes.position;
        for(let i=0;i<positions.count;i++) {
          source.getVertexPosition(i,point);positions.setXYZ(i,point.x,point.y,point.z);
        }
        positions.needsUpdate=true;mesh.geometry.computeVertexNormals();
      }
    },
    dispose(){pairs.length=0;}
  };
}
