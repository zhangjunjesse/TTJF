import * as THREE from 'three';

function sampleIndices(geometry, limit) {
  const position = geometry.attributes.position, chosen = new Set();
  const low = [Infinity,Infinity,Infinity], high = [-Infinity,-Infinity,-Infinity];
  const extremes = [0,0,0,0,0,0];
  for (let i=0;i<position.count;i++) {
    for (let axis=0;axis<3;axis++) {
      const value=position.array[i*position.itemSize+axis];
      if (value<low[axis]) { low[axis]=value; extremes[axis]=i; }
      if (value>high[axis]) { high[axis]=value; extremes[axis+3]=i; }
    }
  }
  extremes.forEach(index=>chosen.add(index));
  const step=Math.max(1,Math.ceil(position.count/limit));
  for(let i=0;i<position.count;i+=step) chosen.add(i);
  return Array.from(chosen);
}

function visible(node, root) {
  for(let item=node;item;item=item.parent) {
    if(!item.visible) return false;
    if(item===root) break;
  }
  return true;
}

export function makeForestBudMeasurements(pet) {
  const inverse=new THREE.Matrix4(), matrix=new THREE.Matrix4(), point=new THREE.Vector3(), entries=[];
  pet.root.traverse(mesh=>{
    if(!mesh.isMesh) return;
    let decoration=false;
    for(let node=mesh;node&&node!==pet.root;node=node.parent) decoration ||= !!node.userData.companionDecoration;
    entries.push({mesh,decoration,anatomy:!!mesh.userData.companionAnatomy,
      indices:sampleIndices(mesh.geometry,mesh.isSkinnedMesh?128:96)});
  });
  const buffers=[new Float32Array(entries.reduce((n,item)=>n+item.indices.length*3,0)),
    new Float32Array(entries.filter(item=>item.anatomy).reduce((n,item)=>n+item.indices.length*3,0))];
  function updateMatrices() {
    // SkinnedMesh overrides updateMatrixWorld, not updateWorldMatrix. Run that
    // override after an ancestor grows so its inverse bind follows the scale.
    pet.root.updateWorldMatrix(true,false); pet.root.updateMatrixWorld(true);
    inverse.copy(pet.root.matrixWorld).invert();
  }
  function measure(anatomy=false, permanentOnly=false) {
    updateMatrices();
    const buffer=buffers[anatomy?1:0]; let offset=0;
    for(const entry of entries) {
      const {mesh,indices}=entry;
      if((anatomy&&!entry.anatomy)||(permanentOnly&&entry.decoration)||!visible(mesh,pet.root)) continue;
      matrix.multiplyMatrices(inverse,mesh.matrixWorld);
      for(const index of indices) {
        mesh.getVertexPosition(index,point).applyMatrix4(matrix);
        point.toArray(buffer,offset); offset+=3;
      }
    }
    return buffer.subarray(0,offset);
  }
  // Store the real neutral anatomical surface once. Animations use bounded
  // samples on demand; they never rescan the full sculpt in the frame loop.
  updateMatrices();
  const anatomy=[];
  for(const entry of entries) {
    if(!entry.anatomy) continue;
    const mesh=entry.mesh; matrix.multiplyMatrices(inverse,mesh.matrixWorld);
    for(let i=0;i<mesh.geometry.attributes.position.count;i++) {
      mesh.getVertexPosition(i,point).applyMatrix4(matrix); anatomy.push(point.x,point.y,point.z);
    }
  }
  pet.bodyPoints=new Float32Array(anatomy); pet.bodyBounds=new THREE.Box3();
  for(let i=0;i<pet.bodyPoints.length;i+=3) pet.bodyBounds.expandByPoint(point.fromArray(pet.bodyPoints,i));
  pet.anatomyVertexCount=pet.bodyPoints.length/3;
  pet.measurePoints=anatomyOnly=>measure(!!anatomyOnly);
  return {measure,dispose(){
    entries.length=0;buffers[0]=new Float32Array(0);buffers[1]=new Float32Array(0);
    pet.measurePoints=()=>new Float32Array(0);
  }};
}

export function measureForestBudProfile(measurements, pose) {
  const points=[], bounds=new THREE.Box3(), point=new THREE.Vector3();
  const states=[
    [0,0,true,null], [1.25,0,false,null], [3.7,0,false,null], [7.1,0,false,null],
    [1.3,.95,false,null],
    ...['look','sniff','groom','stretch','doze'].map((kind,index)=>[2.4,0,false,{kind,phase:.48,weight:1,side:index%2?-1:1}])
  ];
  for(const state of states) {
    pose(...state);
    const samples=measurements.measure(false,true);
    for(let i=0;i<samples.length;i+=3) {
      point.fromArray(samples,i); bounds.expandByPoint(point); points.push(point.x,point.y,point.z);
    }
  }
  pose(0,0,true,null);
  return {bounds,points:new Float32Array(points),motionPadding:.12};
}
