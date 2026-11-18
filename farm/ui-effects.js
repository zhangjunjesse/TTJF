import * as THREE from 'three';
import { Workshop, group, TAU } from './primitives.js';

const WIDTH = 192, HEIGHT = 256;
const srgb = Uint8Array.from({ length: 256 }, (_, value) => {
  const linear = value / 255;
  return Math.round(255 * (linear <= .0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - .055));
});

// A decorative projection only. The balance is still written and read by the
// domain/DOM; these few coins deliberately do not represent individual points.
export function createCreditScene(transferCanvas) {
  const workshop = new Workshop(), scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(26, WIDTH / HEIGHT, .1, 30);
  camera.position.set(3.5, 3.1, 6.8); camera.lookAt(0, .98, 0);
  scene.add(new THREE.HemisphereLight(0xfff4cf, 0x456a52, 2.0));
  const sun = new THREE.DirectionalLight(0xffe5aa, 2.1); sun.position.set(-3, 5, 4); scene.add(sun);
  const fill = new THREE.DirectionalLight(0xa4d8d3, .65); fill.position.set(4, 1, -2); scene.add(fill);
  const treasury = group(scene), chest = group(treasury, [0, .02, 0]);
  treasury.rotation.y = -.16;
  const gold = 0xd59526, cream = 0xffe2a0, wood = 0xb57243, edge = 0xe7b85e, dark = 0x74422b;
  workshop.box(chest, dark, [0, .22, 0], [1.76, .43, 1.11]);
  for (let i = 0; i < 3; i++) workshop.box(chest, i % 2 ? wood : edge, [0, .30 + i * .20, .55], [1.82, .18, .10]);
  for (const x of [-.87, .87]) workshop.box(chest, wood, [x, .46, 0], [.12, .70, 1.14]);
  const lid = group(chest, [0, .75, -.53]); lid.rotation.x = -.62;
  workshop.box(lid, wood, [0, .46, 0], [1.85, .91, .12]);
  for (const x of [-.62, .62]) {
    workshop.box(chest, gold, [x, .46, .62], [.13, .65, .055]);
    workshop.box(lid, gold, [x, .46, .08], [.13, .89, .04]);
  }
  workshop.box(chest, gold, [0, .48, .64], [.27, .26, .08]);
  workshop.orb(chest, dark, [0, .48, .69], [.032, .055, .02], 0);
  workshop.bake(chest);
  const coins = [];
  for (let i = 0; i < 11; i++) {
    const coin = group(treasury, [((i % 4) - 1.5) * .34, .72 + Math.floor(i / 4) * .09, -.18 + (i % 3) * .24]);
    workshop.cylinder(coin, i % 2 ? gold : edge, [0, 0, 0], .23, .09);
    workshop.ring(coin, cream, [0, .052, 0], .15, .012, [Math.PI / 2, 0, 0]);
    workshop.bake(coin); coins.push(coin);
  }
  const star = group(treasury, [0, 1.78, .05]);
  workshop.star(star, gold, [0, 0, 0], .62);
  workshop.star(star, cream, [0, 0, .045], .47);
  workshop.bake(star);
  const glints = [];
  for (let i = 0; i < 5; i++) {
    const angle = i * TAU / 5;
    const glint = group(treasury, [Math.cos(angle) * 1.10, 1.30 + Math.sin(angle) * .72, .18]);
    workshop.star(glint, i % 2 ? cream : edge, [0, 0, 0], .065 + (i % 2) * .025);
    workshop.bake(glint); glints.push(glint);
  }
  scene.traverse(node => { if (node.isMesh) { node.castShadow = false; node.receiveShadow = false; } });
  transferCanvas.width = WIDTH; transferCanvas.height = HEIGHT;
  const context = transferCanvas.getContext('2d', { alpha: true });
  if (!context) { workshop.dispose(); throw new Error('Credit image transfer is unavailable'); }
  const image = context.createImageData(WIDTH, HEIGHT), pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  const clearColor = new THREE.Color(), viewport = new THREE.Vector4(), scissor = new THREE.Vector4();
  let target = null, disposed = false, lastFrame = -Infinity, frames = 0, balance = -1, dirty = true, pulseStart = null;
  function updateBalance(value) {
    const next = Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
    if (next === balance) return;
    balance = next; dirty = true;
    const count = next > 0 ? Math.min(11, 3 + Math.floor(Math.log10(next + 1) * 3)) : 0;
    coins.forEach((coin, i) => { coin.visible = i < count; });
  }
  function render(renderer, time, options, publish) {
    if (disposed) return;
    updateBalance(options.balance);
    const elapsed = pulseStart === null ? 0 : Math.max(0, time - pulseStart);
    const success = pulseStart !== null && elapsed < (options.reducedMotion ? 650 : 1400);
    if (pulseStart !== null && !success) { pulseStart = null; dirty = true; }
    if (!dirty && (options.reducedMotion || time - lastFrame < 1000 / (success ? 12 : 6))) return;
    const seconds = options.reducedMotion ? 0 : time / 1000;
    const pulse = success ? options.reducedMotion ? .6 : Math.sin(Math.min(1, elapsed / 1400) * Math.PI) : 0;
    treasury.rotation.y = -.16 + Math.sin(seconds * .55) * .14;
    star.rotation.y = options.reducedMotion ? -.06 : Math.sin(seconds * .8) * .30;
    star.rotation.z = options.reducedMotion ? 0 : Math.sin(seconds * .64) * .06;
    star.position.y = 1.78 + (options.reducedMotion ? 0 : Math.sin(seconds * 1.3) * .055) + pulse * .18;
    star.scale.setScalar(1 + pulse * .20);
    glints.forEach((glint, i) => {
      glint.scale.setScalar((options.reducedMotion ? .72 : .6 + Math.sin(seconds * 1.5 + i * 1.8) * .3) + pulse * .65);
      glint.rotation.z = options.reducedMotion ? 0 : seconds * .16 + i * .4;
    });
    if (!target) target = new THREE.WebGLRenderTarget(WIDTH, HEIGHT, { depthBuffer: true, stencilBuffer: false, samples: renderer.capabilities.isWebGL2 ? 2 : 0 });
    const previousTarget = renderer.getRenderTarget(), clearAlpha = renderer.getClearAlpha(), shadows = renderer.shadowMap.enabled;
    renderer.getClearColor(clearColor); renderer.getViewport(viewport); renderer.getScissor(scissor);
    const scissorTest = renderer.getScissorTest();
    try {
      renderer.shadowMap.enabled = false; renderer.setRenderTarget(target); renderer.setScissorTest(false); renderer.setClearColor(0x000000, 0);
      renderer.clear(); renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, WIDTH, HEIGHT, pixels);
    } finally {
      renderer.setRenderTarget(previousTarget); renderer.setViewport(viewport); renderer.setScissor(scissor); renderer.setScissorTest(scissorTest);
      renderer.setClearColor(clearColor, clearAlpha); renderer.shadowMap.enabled = shadows;
    }
    // Render targets contain linear RGB and have their origin at the bottom.
    // Convert once during the bounded copy so the DOM image matches sRGB UI art.
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
      const source = ((HEIGHT - y - 1) * WIDTH + x) * 4, dest = (y * WIDTH + x) * 4;
      image.data[dest] = srgb[pixels[source]]; image.data[dest + 1] = srgb[pixels[source + 1]];
      image.data[dest + 2] = srgb[pixels[source + 2]]; image.data[dest + 3] = pixels[source + 3];
    }
    context.putImageData(image, 0, 0);
    publish(transferCanvas.toDataURL('image/png'));
    lastFrame = time; dirty = false; frames++;
  }
  return {
    render,
    pulse(time) { if (!disposed) { pulseStart = time; dirty = true; } },
    invalidate() { dirty = true; },
    hasResponse: () => pulseStart !== null,
    diagnostics: () => ({ enabled: !disposed, width: WIDTH, height: HEIGHT, frameCount: frames, maxFps: pulseStart === null ? 6 : 12, success: pulseStart !== null }),
    resetTarget() { target?.dispose(); target = null; dirty = true; },
    dispose() {
      if (disposed) return;
      disposed = true; pulseStart = null; target?.dispose(); target = null; workshop.dispose(); scene.clear();
      transferCanvas.width = 0; transferCanvas.height = 0;
    }
  };
}

export function makeStationAccent(workshop, station) {
  if (!station || !['points', 'authorization'].includes(station.id)) return null;
  const root = group(station.root, station.id === 'points' ? [.45, 2.95, -.61] : [.35, 2.0, .86]);
  const ring = workshop.ring(root, 0xffdfa0, [0, 0, 0], station.id === 'points' ? 1.1 : .72, .018);
  ring.material = workshop.material(0xffd68b, { transparent: true, opacity: .38, depthWrite: false, toneMapped: false });
  ring.castShadow = false; ring.receiveShadow = false;
  const glints = [];
  for (let i = 0; i < 3; i++) {
    const angle = i * TAU / 3;
    const star = workshop.star(root, 0xffe8ac, [Math.cos(angle) * .91, Math.sin(angle) * .83, .04], .065);
    star.castShadow = false; star.receiveShadow = false; glints.push(star);
  }
  return { root, ring, glints };
}

export function animateStationAccent(accent, seconds, reducedMotion) {
  if (!accent) return;
  accent.ring.material.opacity = reducedMotion ? .38 : .34 + Math.sin(seconds * 1.4) * .10;
  accent.glints.forEach((star, i) => { star.scale.setScalar(reducedMotion ? .82 : .80 + Math.sin(seconds * 1.6 + i * 2) * .2); });
}
