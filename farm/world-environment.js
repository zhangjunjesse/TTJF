import * as THREE from 'three';
import { group } from './primitives.js';
import { hash, noise, heightAt, riverZ, pathDistance, grassTuft, fenceRun } from './world-terrain.js';

export const HOUSE_POSITION = [-4.4, -4.2];
export const PET_POSITION = [-2.2, 2.7];
export const ANIMAL_POSITIONS = { chicken: [5.65, 8.1], rabbit: [-7.2, 2.3] };
export function placeModel(w, assets, parent, key, name, x, z, size, rotation = 0, height = false, y = null) {
  const mesh = assets.clone(key, name, size, height); mesh.position.set(x, y === null ? heightAt(x, z) + .02 : y, z); mesh.rotation.y = rotation; parent.add(mesh); return mesh;
}
export function makeEnvironment(w, assets, farm) {
  const root = group(), buildings = group(root), props = group(root), near = group(root), far = group(root), plants = group(root), banks = group(root);
  // A working landscape exists outside the player's six gameplay beds. Scenery
  // never creates extra harvestable crops, balances, animal unlocks or hit targets.
  placeModel(w, assets, buildings, 'barn', 'building-barn-1', 10.8, -6.3, 5.2, -.12);
  placeModel(w, assets, props, 'hay', 'decor-hay_bales', 8.5, -3.8, 1.65, .35);
  placeModel(w, assets, props, 'well', 'decor-stone_well', 8.9, .4, 1.55, .18);
  placeModel(w, assets, props, 'bench', 'decor-sunset_bench', -8.3, -4.3, 2, .18);
  placeModel(w, assets, props, 'wheelbarrow', 'decor-wheelbarrow', .1, -3.4, 1.15, -.65);
  placeModel(w, assets, props, 'scarecrow', 'decor-scarecrow', 6.7, -2.7, 1.45, -.15, true);
  placeModel(w, assets, props, 'props', 'prop-crate_stack', 8.6, -7.5, 1.2, .30);
  placeModel(w, assets, props, 'props', 'prop-barrel', -6.3, -1.9, .76, -.30, true);
  placeModel(w, assets, props, 'props', 'prop-milk_can', -6.95, -1.7, .48, 0, true);
  placeModel(w, assets, props, 'props', 'prop-sack', 9.6, -3.9, .56, .5, true);
  for (const [x, z, rotation] of [[-6.9, -2, 0], [-2.7, -5.3, .1], [-9, 5.8, .3], [10.4, 5.0, .5]]) placeModel(w, assets, props, 'flowers', 'decor-flower_bed', x, z, 1.5, rotation);
  for (const [x, z] of [[-3.5, -1], [-3.5, 6.3], [.1, 4.7], [8.1, 4.5]]) placeModel(w, assets, props, 'lantern', 'decor-lantern', x, z, 1.45, 0, true);
  // Orchard silhouettes use the pinned upstream tree geometry; mixed CC0/MIT
  // provenance and the source generator are recorded in assets/farm/CREDITS.md.
  [[9.1,-1.8,2.7],[12.0,.1,3.1],[10.8,3.0,2.6],[-8.6,-7.6,3.4]].forEach(([x,z,h],i) => placeModel(w, assets, near, 'apple', i === 1 ? 'tree-apple_tree-mature' : 'tree-apple_tree-ready', x, z, h, i * 1.41, true));
  // A layered edge grove and a quieter outer canopy; no circular island boundary.
  for (let gz = -29; gz <= 27; gz += 3.8) for (let gx = -29; gx <= 29; gx += 3.8) {
    const index = Math.round((gx + 31) * 3 + (gz + 33) * 117), x = gx + (hash(index, 1) - .5) * 2.3, z = gz + (hash(index, 2) - .5) * 2.2;
    if (x > -12.6 && x < 15.0 && z > -10 && z < 14.5) continue;
    if (Math.abs(z - riverZ(x)) < 3.8 || pathDistance(x,z) < 1.8) continue;
    if (z > 10 && x > -9 && x < 12) continue;
    const distant = Math.max(Math.abs(x), Math.abs(z)) > 20;
    if (distant && hash(index, 3) > .70) continue;
    const broad = hash(index, 4) < .39;
    const name = broad ? 'prop-forest_round_' + (1 + Math.floor(hash(index, 5) * 3)) : 'prop-forest_pine_' + (1 + Math.floor(hash(index, 5) * 2));
    const h = (broad ? 3.6 : 4.5) + hash(index, 6) * (distant ? 3 : 2.1);
    placeModel(w, assets, distant ? far : near, 'props', name, x, z, h, hash(index, 7) * Math.PI * 2, true);
    if (hash(index, 8) > .6) placeModel(w, assets, near, 'props', 'prop-bush_' + (1 + index % 2), x + 1, z + 1, 1.1 + hash(index, 9) * .7, index);
  }
  for (const [x,z,h,k] of [[-10,-4,4.8,1],[-11,7.8,4.2,2],[13.8,7.8,4.6,1],[1,-10,5.3,2],[4.3,-9.7,4.6,1],[-6.4,-10.2,4,2]]) placeModel(w, assets, near, 'props', 'prop-forest_pine_' + k, x,z,h,x,true);
  for (let i = 0; i < 75; i++) {
    const x = -29 + hash(i, 101) * 58, z = -25 + hash(i, 102) * 49;
    if (Math.abs(z - riverZ(x)) < 1.8 || pathDistance(x, z) < 1.5) continue;
    if (Math.abs(x) < 11 && z > -8 && z < 9) continue;
    placeModel(w, assets, banks, i % 4 ? 'props' : 'debris', i % 4 ? 'prop-rock_' + (i % 2 + 1) : 'debris-boulder', x, z, .45 + hash(i, 103) * 1.1, i);
  }
  [[-9.8,-1.6,1.2],[-8.1,7.3,.8],[7.5,-8.5,1.1],[12.7,4.8,.85],[-.8,-8.8,.75],[-6.8,5.9,.55]].forEach(([x,z,s],i) => placeModel(w, assets, banks, 'debris','debris-rock',x,z,s,i));
  for (let i = 0; i < 45; i++) {
    const x = -24 + i * 1.1, side = i % 2 ? 1 : -1, z = riverZ(x) + side * (1.7 + hash(i,201) * .5);
    if (Math.abs(x + 2.2) < 1.4) continue;
    placeModel(w, assets, banks,'props','prop-reeds',x,z,.5 + hash(i,202) * .6,i,true);
    if (i % 3 === 0) placeModel(w,assets,banks,'props','prop-rock_1',x+.3,z,.45 + hash(i,203) * .4,i);
    if (i % 5 === 0) placeModel(w,assets,banks,'props','prop-lilypad',x,riverZ(x)+.7,.45,i,false,-.54);
  }
  // Tufts grow in pockets, not an evenly spaced boundary necklace. Keep path,
  // bodies, beds and porches clear, and put finer flowers where the camera comes close.
  for (let i = 0; i < 1000; i++) {
    const x = -23 + hash(i, 301) * 46, z = -23 + hash(i, 302) * 44;
    if (pathDistance(x,z) < 1.02 || Math.abs(z - riverZ(x)) < 2.2) continue;
    if (x > -.35 && x < 7.1 && z > -2.6 && z < 2.7) continue;
    if (x > -7 && x < -1.9 && z > -6.7 && z < -1.7) continue;
    if (x > 3.4 && x < 8.5 && z > 4.8 && z < 9.1) continue;
    if (x > -9.2 && x < -5.3 && z > .3 && z < 4.0) continue;
    if (Math.hypot(x + 2.2, z - 2.7) < 1.1) continue;
    const pocket = noise(x * .42 + 1.8, z * .42 - 3.1);
    if (pocket < .48) continue;
    const scale = .42 + hash(i,303) * .38;
    grassTuft(w, plants, x,z,scale,i%8===0,i);
    if (pocket > .54) for (let j = 0; j < 3; j++) {
      const xx = x + (hash(i, 310 + j) - .5) * .50, zz = z + (hash(i, 320 + j) - .5) * .50;
      if (pathDistance(xx, zz) > 1.04) grassTuft(w, plants,xx,zz,scale * (.70 + hash(i, 330+j) * .3),false,i+j+100);
    }
  }
  for (let i = 0; i < 34; i++) {
    const x = -5.8 + hash(i, 401) * 4.2, z = 5.6 + hash(i,402)*2.1;
    if (pathDistance(x,z) > 1) grassTuft(w, plants,x,z,.7 + hash(i,403)*.3,i%2===0,i);
  }
  const fences = group(root);
  fenceRun(w,fences,-10.1,-8.7,-3.6,-8.7,1.2,.92); fenceRun(w,fences,-.8,-8.7,13.7,-8.7,1.2,.92);
  fenceRun(w,fences,-10.1,-8.7,-10.1,3.2,1.2,.92); fenceRun(w,fences,-10.1,5.8,-10.1,9.9,1.2,.92);
  fenceRun(w,fences,13.7,-8.7,13.7,3.1,1.2,.92); fenceRun(w,fences,13.7,6,13.7,10,1.2,.92);
  fenceRun(w,fences,-10.1,9.9,-3.4,9.9,1.2,.92); fenceRun(w,fences,-.9,9.9,13.7,9.9,1.2,.92);
  // Slim crop fence frames the soil without hiding it. The path-facing side has a gate.
  fenceRun(w,fences,-.28,-2.55,7.08,-2.55,.8,.55); fenceRun(w,fences,7.08,-2.55,7.08,2.7,.8,.55);
  fenceRun(w,fences,-.28,2.7,2.5,2.7,.8,.55); fenceRun(w,fences,4.1,2.7,7.08,2.7,.8,.55);
  if ((farm.animals || []).some(a => a.id === 'chicken' && a.unlocked)) {
    placeModel(w, assets, buildings,'coop','home-coop',5.7,7.4,4.05,0);
    placeModel(w, assets, props,'props','prop-trough',6.7,8.3,.8,0);
    placeModel(w, assets, props,'hay','decor-hay_bales',8.4,7.4,.95,.5);
  }
  if ((farm.animals || []).some(a => a.id === 'rabbit' && a.unlocked)) {
    placeModel(w, assets, buildings,'hutch','home-hutch',-7.35,2.1,3.4,.15);
    placeModel(w, assets, props,'props','prop-trough',-6.1,3.3,.65,.3);
  }
  [buildings, props, near, far, banks, fences, plants].forEach(g => w.bake(g));
  far.traverse(m => { if (m.isMesh) m.castShadow = false; });
  plants.traverse(m => { if (m.isMesh) m.castShadow = false; });
  return root;
}
