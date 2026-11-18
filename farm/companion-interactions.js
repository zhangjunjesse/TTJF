import * as THREE from 'three';
import { group } from './primitives.js';

const TAU = Math.PI * 2;
const HAPPY = /harvest|grow|level|points|upgrade|celebrate|unlock|earn/;
const clamp = value => Math.max(0, Math.min(1, value));
const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };

function affectionProps(w, root, headY) {
  const affection = group(root);
  const outline = [[0, -.15], [-.15, -.02], [-.17, .08], [-.12, .15], [-.045, .15], [0, .09], [.045, .15], [.12, .15], [.17, .08], [.15, -.02]];
  for (let i = 0; i < 3; i++) {
    const heart = group(affection, [i === 1 ? .82 : -.78 + i * .12, headY + .20 + i * .20, .34]);
    w.polygon(heart, i === 1 ? 0xe9a382 : 0xd5807b, outline, .035);
    w.bake(heart);
  }
  return affection;
}

function snackProps(w, root) {
  const snack = group(root);
  w.orb(snack, 0xd88b55, [0, 0, 0], [.17, .17, .15]);
  w.orb(snack, 0xedb06e, [-.055, .045, .09], [.075, .07, .045]);
  w.cylinder(snack, 0x75523d, [0, .17, 0], .022, .12, .018, [0, 0, -.20]);
  w.polygon(snack, 0x7c9d65, [[0, 0], [.04, .09], [.16, .11], [.13, .02]], .018, [.005, .18, 0], [.25, -.3, -.3]);
  w.bake(snack);
  const crumbs = group(root);
  for (let i = 0; i < 3; i++) w.orb(crumbs, 0xebc287, [0, 0, 0], [.032, .026, .025], 0);
  return { snack, crumbs };
}

function washProps(w, root, headY) {
  const wash = group(root);
  const geometry = w.geometry('companion-bubble', () => new THREE.SphereGeometry(1, 10, 7));
  const material = w.material(0xb7e2dc, { transparent: true, opacity: .58, depthWrite: false });
  const places = [[-.77, headY - .24, .44], [.78, headY + .03, .36], [-.62, headY + .43, .14], [.62, headY + .55, .04], [-.47, .83, .61], [.44, 1.18, .65], [.03, headY + .59, .25]];
  places.forEach((position, i) => {
    const bubble = group(wash, position), radius = .10 + (i % 3) * .035;
    bubble.scale.setScalar(radius);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.noShadow = true; bubble.add(mesh);
    const shine = w.orb(bubble, 0xf0f8e5, [-.32, .38, .78], [.14, .20, .08], 0);
    shine.userData.noShadow = true;
  });
  return wash;
}

function playProps(w, root) {
  const ball = group(root, [0, .25, 1.12]);
  w.ball(ball, 0xd39a56, [0, 0, 0], [.23, .23, .23]);
  w.ring(ball, 0x6baba5, [0, 0, 0], .224, .025, [Math.PI / 2, 0, 0]);
  w.ring(ball, 0xeee0ae, [0, 0, 0], .224, .019);
  w.bake(ball);
  return ball;
}

function celebrationProps(w, root, headY) {
  const celebration = group(root);
  for (let i = 0; i < 6; i++) {
    const angle = -.15 + i * Math.PI / 5;
    const star = group(celebration, [Math.cos(angle) * .72, headY + .12 + Math.sin(angle) * .42, .20]);
    w.star(star, i % 2 ? 0xb6cb8a : 0xe9c479, [0, 0, 0], i % 2 ? .095 : .12);
    w.bake(star);
  }
  return celebration;
}

export function makeCompanionInteractions(w, pet) {
  const root = group(pet.root);
  root.name = 'companion-interactions'; root.userData.companionDecoration = true;
  const affection = affectionProps(w, root, pet.headY), { snack, crumbs } = snackProps(w, root);
  const wash = washProps(w, root, pet.headY), ball = playProps(w, root), celebration = celebrationProps(w, root, pet.headY);
  const groups = { affection, snack, crumbs, wash, ball, celebration }, rest = [];
  Object.entries(groups).forEach(([name, item]) => {
    item.name = 'companion-' + name; item.visible = false;
    item.traverse(node => {
      rest.push({ node, position: node.position.clone(), rotation: node.rotation.clone(), scale: node.scale.clone() });
      if (node.isMesh) { node.userData.noShadow = true; node.castShadow = false; node.receiveShadow = false; }
    });
  });
  root.visible = false;
  return { root, ...groups, groups: Object.values(groups), rest, mouth: new THREE.Vector3(), snackStart: new THREE.Vector3(.68, .92, 1.40), action: '' };
}

function resetProps(props) {
  props.root.visible = false; props.action = '';
  props.groups.forEach(item => { item.visible = false; });
  props.rest.forEach(({ node, position, rotation, scale }) => {
    node.position.copy(position); node.rotation.copy(rotation); node.scale.copy(scale);
  });
}

function squintEyes(pet, amount) {
  if (pet.squintEyes) pet.squintEyes(amount);
  else pet.eyes.forEach(eye => { eye.scale.y *= 1 - amount; });
}

function affectionatePose(pet, progress, amount) {
  pet.head.rotation.z += amount * .16; pet.head.rotation.x -= amount * .09;
  pet.head.position.x += amount * .06; pet.body.rotation.z -= amount * .025;
  squintEyes(pet, amount * .20);
  pet.limbs.forEach((arm, i) => { arm.rotation.z = (i ? 1 : -1) * amount * .16; arm.rotation.x -= amount * .10; });
  const affection = pet.interactions.affection; affection.visible = true;
  affection.children.forEach((heart, i) => {
    heart.position.y += progress * .28; heart.position.x += (i === 1 ? 1 : -1) * progress * .10;
    heart.rotation.z = (i - 1) * .15 + amount * .08; heart.scale.setScalar(.70 + amount * .40);
  });
}

function eatingPose(pet, progress, amount, reducedMotion) {
  const chew = reducedMotion ? .6 : Math.sin(progress * Math.PI * 14) * smooth((progress - .30) / .14) * (1 - smooth((progress - .78) / .16));
  pet.head.rotation.x += amount * .09 + chew * .035;
  pet.head.position.y -= Math.abs(chew) * .025;
  pet.limbs.forEach((arm, i) => { arm.rotation.z = (i ? -.23 : .18) * amount; arm.rotation.x -= (i ? .67 : .50) * amount; });
  const props = pet.interactions;
  // The target follows the real head pose and baby proportions, rather than a
  // fixed world point. The snack reaches the muzzle before shrinking away.
  if (pet.resolveMouth) pet.resolveMouth(props.mouth);
  else props.mouth.set(.06, -.25, pet.kind === 'capybara' ? 1.21 : 1.06).multiply(pet.head.scale).applyEuler(pet.head.rotation).add(pet.head.position);
  props.snack.visible = progress < .84;
  props.snack.position.copy(props.snackStart).lerp(props.mouth, smooth(progress / .40));
  props.snack.rotation.z = -.28 + smooth(progress / .40) * .33;
  props.snack.scale.setScalar(1 - smooth((progress - .50) / .32) * .94);
  props.crumbs.visible = !reducedMotion && progress > .43 && progress < .85;
  props.crumbs.position.copy(props.mouth);
  props.crumbs.children.forEach((crumb, i) => {
    const spread = clamp((progress - .43) / .42);
    crumb.position.set((i - 1) * (.08 + spread * .15), -.03 - spread * (.18 + i * .035), .05 + spread * .11);
    crumb.scale.multiplyScalar(1 - spread * .75);
  });
}

function washingPose(pet, progress, amount, reducedMotion) {
  const shake = reducedMotion ? .03 : Math.sin(progress * TAU * 3) * .065;
  pet.head.rotation.x += amount * .065; pet.head.rotation.z += shake * amount;
  pet.body.rotation.z -= shake * amount * .40;
  pet.limbs.forEach((arm, i) => { arm.rotation.z = (i ? 1 : -1) * amount * .28; arm.rotation.x -= amount * .08; });
  squintEyes(pet, amount * .15);
  pet.interactions.wash.visible = true;
  pet.interactions.wash.children.forEach((bubble, i) => {
    const drift = reducedMotion ? .14 : progress * .34;
    bubble.position.y += drift;
    bubble.position.x += reducedMotion ? 0 : Math.sin(progress * TAU + i) * .045;
    bubble.scale.multiplyScalar(.70 + amount * .40);
  });
}

function playingPose(pet, progress, amount, reducedMotion) {
  const ball = pet.interactions.ball;
  const side = reducedMotion ? .52 : -.75 * Math.cos(progress * TAU);
  const bounce = reducedMotion ? .28 : Math.abs(Math.sin(progress * TAU * 2)) * .43;
  ball.visible = true; ball.position.set(side, .24 + bounce, 1.12);
  ball.rotation.set(progress * TAU * 1.5, progress * TAU, side * -1.4);
  ball.scale.setScalar(.72 + amount * .28);
  pet.head.rotation.y += side * .19 * amount; pet.head.rotation.x += amount * .10;
  pet.body.rotation.z -= side * .045 * amount;
  pet.limbs.forEach((arm, i) => {
    const reach = Math.max(0, side * (i ? 1 : -1));
    arm.rotation.x -= amount * (.30 + reach * .85); arm.rotation.z = (i ? 1 : -1) * amount * (.24 + reach * .25);
  });
  pet.root.position.y = reducedMotion ? 0 : bounce * amount * .09;
  if (pet.tail) pet.tail.rotation.y += reducedMotion ? .11 : Math.sin(progress * TAU * 3) * .16 * amount;
}

function joyfulPose(pet, progress, amount, reducedMotion) {
  pet.root.position.y = reducedMotion ? 0 : Math.abs(Math.sin(progress * TAU)) * amount * .22;
  pet.body.scale.y *= 1 + (reducedMotion ? .015 : Math.sin(progress * TAU * 2) * .035) * amount;
  pet.head.rotation.x -= amount * .11; pet.head.rotation.z += amount * .035;
  pet.limbs.forEach((arm, i) => { arm.rotation.z = (i ? 1 : -1) * amount * .78; arm.rotation.x -= amount * .32; });
  pet.wings.forEach((wing, i) => { wing.rotation.y += (i ? 1 : -1) * amount * .40; });
  if (pet.tail) pet.tail.rotation.y += reducedMotion ? .12 : Math.sin(progress * TAU * 3) * amount * .18;
  pet.interactions.celebration.visible = true;
  pet.interactions.celebration.children.forEach((star, i) => {
    star.position.x *= 1 + progress * .45; star.position.y += progress * .23;
    star.rotation.z = (i % 2 ? 1 : -1) * progress * .8;
    star.scale.setScalar(.55 + amount * .55);
  });
}

function attentionPose(pet, amount, reducedMotion) {
  // Expanded-yard acknowledgements such as animal care retain their original
  // small response without borrowing a home care prop.
  pet.root.position.y = reducedMotion ? 0 : amount * .035;
  pet.head.rotation.z += amount * (pet.kind === 'capybara' ? .035 : .06);
  pet.head.rotation.x -= amount * .045;
  pet.limbs.forEach((arm, i) => { arm.rotation.z = (i ? 1 : -1) * amount * .32; arm.rotation.x -= amount * .11; });
  pet.wings.forEach((wing, i) => { wing.rotation.y += (i ? 1 : -1) * amount * .20; });
  if (pet.tail) pet.tail.rotation.y += amount * .13;
}

export function animateCompanionInteraction(pet, response, reducedMotion) {
  const props = pet.interactions; resetProps(props);
  if (!response) return;
  const kind = String(response.kind || ''), value = Number(response.progress) || 0;
  const progress = reducedMotion ? .52 : clamp(value), amount = Math.sin(progress * Math.PI);
  if (!kind || kind === 'idle' || value >= 1 || progress <= 0 || progress >= 1) return;
  props.root.visible = true;
  if (kind === 'pet' || kind === 'touch' || kind === 'greet') {
    props.action = 'pet'; affectionatePose(pet, progress, amount);
  } else if (kind === 'feed') {
    props.action = 'feed'; eatingPose(pet, progress, amount, reducedMotion);
  } else if (kind === 'wash' || kind === 'water') {
    props.action = 'wash'; washingPose(pet, progress, amount, reducedMotion);
  } else if (kind === 'train' || kind === 'play') {
    props.action = 'train'; playingPose(pet, progress, amount, reducedMotion);
  } else if (HAPPY.test(kind)) {
    props.action = 'celebrate'; joyfulPose(pet, progress, amount, reducedMotion);
  } else {
    props.root.visible = false; attentionPose(pet, amount, reducedMotion);
  }
}
