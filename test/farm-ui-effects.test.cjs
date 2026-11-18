'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const effects = import(pathToFileURL(path.join(__dirname, '..', 'farm', 'ui-effects.js')).href);

function transfer() {
  const frames = [];
  const canvas = { width: 0, height: 0, getContext(type, options) {
    assert.equal(type, '2d'); assert.equal(options.alpha, true);
    return { createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData(image) { frames.push(new Uint8ClampedArray(image.data)); } };
  }, toDataURL(type) { assert.equal(type, 'image/png'); return 'data:image/png;base64,frame-' + frames.length; } };
  return { canvas, frames };
}

function renderer() {
  const targets = [], scenes = [], disposedTargets = [];
  const originalTarget = { name: 'original' }, viewport = [7, 8, 600, 400], scissor = [3, 4, 500, 350];
  let target = originalTarget, alpha = .75, color = 0x123456, test = true;
  const currentViewport = viewport.slice(), currentScissor = scissor.slice();
  const api = { capabilities: { isWebGL2: true }, shadowMap: { enabled: true }, failRead: false,
    getRenderTarget: () => target,
    setRenderTarget(next) {
      target = next;
      if (next?.isWebGLRenderTarget && !targets.includes(next)) {
        targets.push(next); next.addEventListener('dispose', () => disposedTargets.push(next));
      }
    },
    getClearAlpha: () => alpha,
    getClearColor: into => into.setHex(color),
    setClearColor(next, nextAlpha) { color = typeof next === 'number' ? next : next.getHex(); alpha = nextAlpha; },
    getViewport: into => into.fromArray(currentViewport), getScissor: into => into.fromArray(currentScissor),
    setViewport: value => { currentViewport.splice(0, 4, ...value.toArray()); },
    setScissor: value => { currentScissor.splice(0, 4, ...value.toArray()); },
    getScissorTest: () => test, setScissorTest: value => { test = value; }, clear() {},
    render(scene, camera) {
      assert.equal(api.shadowMap.enabled, false); assert.equal(test, false); assert.equal(alpha, 0);
      assert.equal(scene.isScene, true); assert.equal(camera.isPerspectiveCamera, true); scenes.push(scene);
    },
    readRenderTargetPixels(renderTarget, x, y, width, height, pixels) {
      if (api.failRead) throw new Error('synthetic GPU read failure');
      assert.equal(renderTarget.width, 192); assert.equal(renderTarget.height, 256);
      pixels.set([64, 128, 255, 128], 0);
      pixels.set([16, 32, 64, 255], (height - 1) * width * 4);
    }
  };
  return { api, targets, scenes, disposedTargets, state: () => ({ target, alpha, color, test,
    shadows: api.shadowMap.enabled, viewport: currentViewport.slice(), scissor: currentScissor.slice() }) };
}

test('treasury transfers alpha/sRGB frames through the supplied renderer and restores every changed renderer state', async () => {
  const { createCreditScene } = await effects, image = transfer(), gpu = renderer(), art = createCreditScene(image.canvas), published = [];
  const previous = gpu.state();
  art.render(gpu.api, 1000, { balance: 25, reducedMotion: false }, value => published.push(value));
  assert.equal(published.length, 1); assert.match(published[0], /^data:image\/png;/);
  assert.deepEqual(gpu.state(), previous);
  assert.deepEqual(Array.from(image.frames[0].slice(0, 4)), [71, 99, 137, 255], 'top row is flipped and converted from linear RGB');
  assert.deepEqual(Array.from(image.frames[0].slice(-192 * 4, -192 * 4 + 4)), [137, 188, 255, 128], 'alpha remains intact');
  assert.equal(gpu.targets.length, 1); assert.equal(gpu.targets[0].samples, 2);
  art.render(gpu.api, 1050, { balance: 25, reducedMotion: false }, value => published.push(value));
  assert.equal(published.length, 1, 'idle transfer is capped');
  art.render(gpu.api, 1170, { balance: 25, reducedMotion: false }, value => published.push(value));
  assert.equal(published.length, 2); assert.equal(gpu.targets.length, 1, 'frames reuse the same render target');
  art.dispose();
});

test('reduced motion is static, success feedback is bounded, and a replacement DOM image can request a fresh frame', async () => {
  const { createCreditScene } = await effects, image = transfer(), gpu = renderer(), art = createCreditScene(image.canvas), published = [];
  const frame = time => art.render(gpu.api, time, { balance: 0, reducedMotion: true }, value => published.push(value));
  frame(1000); frame(5000); assert.equal(published.length, 1);
  art.invalidate(); frame(5100); assert.equal(published.length, 2);
  art.pulse(6000); frame(6000); assert.equal(published.length, 3); assert.equal(art.hasResponse(), true);
  frame(6200); assert.equal(published.length, 3, 'reduced motion success accent does not animate');
  frame(6700); assert.equal(published.length, 4); assert.equal(art.hasResponse(), false);
  frame(9000); assert.equal(published.length, 4); art.dispose();
});

test('a failed GPU read still restores state, and context recovery replaces and disposes its render target', async () => {
  const { createCreditScene } = await effects, image = transfer(), gpu = renderer(), art = createCreditScene(image.canvas);
  const previous = gpu.state(); gpu.api.failRead = true;
  assert.throws(() => art.render(gpu.api, 1000, { balance: 3 }, () => {}), /GPU read failure/);
  assert.deepEqual(gpu.state(), previous);
  gpu.api.failRead = false; art.resetTarget(); assert.equal(gpu.disposedTargets.length, 1);
  art.render(gpu.api, 1001, { balance: 3 }, () => {}); assert.equal(gpu.targets.length, 2);
  const geometries = new Set(), materials = new Set(), released = new Set();
  gpu.scenes.at(-1).traverse(node => {
    if (node.geometry) geometries.add(node.geometry);
    if (node.material) materials.add(node.material);
  });
  for (const resource of [...geometries, ...materials]) resource.addEventListener('dispose', () => released.add(resource));
  assert.ok(geometries.size > 0 && materials.size > 0, 'actual Three meshes were rendered');
  art.dispose(); art.dispose();
  assert.equal(gpu.disposedTargets.length, 2);
  assert.equal(released.size, geometries.size + materials.size);
  assert.equal(image.canvas.width, 0); assert.equal(image.canvas.height, 0);
  assert.equal(art.diagnostics().enabled, false);
  art.render(gpu.api, 2000, { balance: 3 }, () => { throw new Error('late frame after disposal'); });
});
