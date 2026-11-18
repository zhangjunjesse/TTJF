import * as THREE from 'three';
import { group } from '../primitives.js';
import { makeCompanionInteractions, animateCompanionInteraction } from '../companion-interactions.js';
import { makeBody } from './body/body.js';
import { makeHead } from './face/face.js';
import { makeButterfly } from './butterfly.js';
import { createPetLife } from './pet-life.js';
import { ownForestBudResources } from './resources.js';
import { makeForestBudMeasurements, measureForestBudProfile } from './measure.js';
import { equipForestBud } from './wardrobe.js';
import { makeCpuTailSkin } from './cpu-skin.js';

const clamp=value=>Math.max(0,Math.min(1,value));
const smooth=value=>{const p=clamp(value);return p*p*(3-2*p);};
const GREETING=new Set(['pet','touch','greet']);

function savePose(nodes) {
  return nodes.filter(Boolean).map(node=>({node,position:node.position.clone(),rotation:node.quaternion.clone(),scale:node.scale.clone()}));
}

function resetPose(rest) {
  for(const pose of rest) {
    pose.node.position.copy(pose.position); pose.node.quaternion.copy(pose.rotation); pose.node.scale.copy(pose.scale);
  }
}

function clock(state, seconds) {
  const input=Number.isFinite(seconds)?seconds:0;
  if(state.lastInput===null) state.time=input;
  else {
    const delta=input-state.lastInput;
    // A hidden or paused renderer resumes at the current pose. It does not
    // fast-forward a nap or jump into a gesture missed while off screen.
    if(delta>=0&&delta<=1) state.time+=delta;
  }
  state.lastInput=input;
  return state.time;
}

export function makeForestBud(workshop, stage, stars=0, opts={}) {
  const root=group(), puppet=group(root);
  const quality=opts.quality==='low'||opts.webgl2===false?'low':'high';
  let bodyModel=makeBody({quality}), headModel=makeHead({quality}), butterfly=makeButterfly();
  const neck=group(bodyModel.neckAnchor);
  const variant=opts.variant==='festival'?'festival':'default';
  root.name='Forest Bud Dragon companion'; root.userData.companionVariant=variant;
  bodyModel.root.scale.set(1.07,1,1.04); neck.scale.set(1/1.07,1,1/1.04);
  neck.rotation.z=.22; neck.add(headModel.root); puppet.add(bodyModel.root);
  const mouthAnchor=group(headModel.motion,[.04,.22,.80]); mouthAnchor.name='Posed muzzle attachment';
  butterfly.root.userData.companionDecoration=true; root.add(butterfly.root);
  const cpuSkin=makeCpuTailSkin(root,opts.boneTextures===false);
  const resources=ownForestBudResources(workshop,root,opts.quality==='low'||opts.webgl2===false);
  const pet={root,body:bodyModel.root,head:headModel.root,limbs:bodyModel.arms,wings:bodyModel.wings,
    tail:bodyModel.tail.root,eyes:headModel.eyes.map(eye=>eye.root),kind:'plant',stage,variant,homeYaw:-.66,
    anchors:{puppet,body:bodyModel.root,torso:bodyModel.torso,chest:bodyModel.chest,neck,
      head:headModel.root,expression:headModel.motion,leftArm:bodyModel.arms[0],rightArm:bodyModel.arms[1],
      leftHand:bodyModel.hands[0],rightHand:bodyModel.hands[1],wings:bodyModel.wings,tail:bodyModel.tail.root,
      leftFoot:bodyModel.feet[0],rightFoot:bodyModel.feet[1],ears:headModel.ears,mouth:mouthAnchor},
    activity:{kind:'rest',phase:0,weight:0,side:1},disposed:false};
  pet.wardrobe=equipForestBud(workshop,pet,{stage,stars,variant,quality})||null;
  pet.restHeadPosition=pet.head.position.clone(); pet.restHeadScale=pet.head.scale.clone();
  pet.restBodyScale=pet.body.scale.clone(); pet.bodyScaleY=pet.body.scale.y;
  const rest=savePose([pet.body,pet.head,...pet.limbs,...pet.wings,pet.tail]);
  const inverse=new THREE.Matrix4(), mouth=new THREE.Vector3();
  pet.resolveMouth=target=>{
    root.updateWorldMatrix(true,true); inverse.copy(root.matrixWorld).invert();
    return target.setFromMatrixPosition(mouthAnchor.matrixWorld).applyMatrix4(inverse);
  };
  pet.squintEyes=amount=>headModel.eyes.forEach(eye=>eye.blink(eye.root.userData.openness*(1-clamp(amount))));
  function pose(t,wave,reduced,activity) {
    const time=reduced?0:t, grooming=activity?.kind==='groom'?activity.weight:0;
    resetPose(rest);
    puppet.scale.y=pet.anchors.puppet.userData.restScaleY*(1+(reduced?0:Math.sin(time*2.2)*.0026));
    neck.rotation.set(-.012+Math.sin(time*1.23)*.012-wave*.035,
      .035+Math.sin(time*.9)*.021,.22-.18*grooming+Math.sin(time*1.12)*.015+wave*.065);
    bodyModel.update(t,wave,reduced,activity); headModel.update(t,wave,reduced,activity);
    cpuSkin.update();
    butterfly.update(time,activity||{kind:'rest',phase:0,weight:0,side:1});
    pet.wardrobe?.update?.(time,reduced);
  }
  puppet.userData.restScaleY=puppet.scale.y;
  pose(0,0,true,null); root.updateWorldMatrix(true,true);
  root.worldToLocal(mouth.set(0,.56,0).applyMatrix4(pet.head.matrixWorld));
  pet.headY=mouth.y;
  pet.interactions=makeCompanionInteractions(workshop,pet);
  const measurements=makeForestBudMeasurements(pet);
  pet.frameProfile=measureForestBudProfile(measurements,pose);
  const state={pose,life:createPetLife(),time:0,lastInput:null,lastResponse:null,lastKind:'',measurements,resources};
  pet.forestBud=state;
  pet.dispose=()=>{
    if(pet.disposed)return; pet.disposed=true;
    pet.wardrobe?.dispose?.(); cpuSkin.dispose();resources.dispose(); measurements.dispose();
    const nodes=[];root.traverse(node=>nodes.push(node));
    nodes.forEach(node=>node.clear());root.removeFromParent();
    rest.length=0; pet.limbs=[];pet.wings=[];pet.eyes=[];pet.anchors={};
    pet.interactions=null;pet.wardrobe=null;pet.dragonDetails=null;pet.forestBud=null;
    pet.bodyPoints=new Float32Array(0);pet.frameProfile=null;
    pet.resolveMouth=null;pet.squintEyes=null;pet.anatomyVertexCount=0;
    state.pose=null;state.life=null;state.lastResponse=null;state.measurements=null;state.resources=null;
    bodyModel=null;headModel=null;butterfly=null;
  };
  return pet;
}

export function animateForestBud(pet,seconds,response,reducedMotion) {
  const state=pet.forestBud;if(!state||pet.disposed)return;
  pet.root.position.y=0;
  const now=clock(state,seconds), value=Number(response?.progress)||0;
  const active=!!response&&!!response.kind&&response.kind!=='idle'&&value<1;
  const key=active?(response.start??response):null;
  if(active&&(key!==state.lastResponse||response.kind!==state.lastKind))state.life.attend(now);
  state.lastResponse=key;state.lastKind=active?response.kind:'';
  const activity=state.life.update(now,reducedMotion,active);
  Object.assign(pet.activity,activity);
  if(pet.activity.kind==='groom'&&pet.heldHands) {
    const held=pet.heldHands;
    if(held.left&&held.right) pet.activity.kind='sniff';
    else if(held.left) pet.activity.side=1;
    else if(held.right) pet.activity.side=-1;
  }
  const progress=reducedMotion?.52:clamp(value);
  const wave=active&&GREETING.has(response.kind)?smooth(progress/.12)*(1-smooth((progress-.85)/.15)):0;
  state.pose(now,wave,reducedMotion,pet.activity);
  pet.head.rotation.y+=Number(response?.look)||0;
  animateCompanionInteraction(pet,response,reducedMotion);
  // Held props keep their grip and upright direction after care rotates the
  // shoulders. The same update is also used while measuring neutral outfits.
  pet.wardrobe?.update?.(reducedMotion?0:now,reducedMotion,response);
}
