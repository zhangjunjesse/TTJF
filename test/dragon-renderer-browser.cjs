'use strict';

// Short, isolated renderer groups. They exercise the generated production
// bundle in native desktop WebGL; they never load or write a family account.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const B = require('./browser.cjs');
const ROOT = path.resolve(__dirname, '..');
const CASE = process.env.DRAGON_RENDER_CASE || 'runtime';
assert.ok(['fit', 'runtime', 'release', 'context'].includes(CASE));
const WEBGL1 = process.env.DRAGON_RENDER_WEBGL1 === '1';
const NO_FLOAT = process.env.DRAGON_RENDER_NO_FLOAT === '1';
const TRACE_GL = process.env.DRAGON_RENDER_TRACE_GL === '1';
assert.ok(!NO_FLOAT || WEBGL1, 'NO_FLOAT requires a WebGL1 context');
const STAGE = Number(process.env.DRAGON_RENDER_STAGE || 5);
assert.ok(Number.isInteger(STAGE) && STAGE >= 1 && STAGE <= 5);
const WIDTH = Number(process.env.DRAGON_RENDER_WIDTH || 366), HEIGHT = Number(process.env.DRAGON_RENDER_HEIGHT || 310);
const PREVIEW = process.env.DRAGON_RENDER_PREVIEW === '1';
const INSETS = { top: Number(process.env.DRAGON_RENDER_INSET_TOP || 35), right: 0,
  bottom: Number(process.env.DRAGON_RENDER_INSET_BOTTOM || (PREVIEW ? 0 : 64)), left: 0 };
const RUN = new Date().toISOString().replace(/[^0-9]/g, '') + '-' + process.pid;
const OUT = path.join(process.env.TEST_ARTIFACT_DIR ? path.resolve(process.env.TEST_ARTIFACT_DIR) :
  path.join(ROOT, 'artifacts', 'dragon-real-scene'), CASE + '-' + (WEBGL1 ? 'webgl1' : 'webgl2') + (NO_FLOAT ? '-cpu' : '') + '-' + RUN);
fs.mkdirSync(OUT, { recursive: true });
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const sourceHashes = () => Object.fromEntries(['farm-scene.js', 'farm/scene.js', 'farm/primitives.js', 'farm/companions.js', 'test/dragon-renderer-browser.cjs']
  .map(file => [file, sha(fs.readFileSync(path.join(ROOT, file)))]));
const report = { group: CASE, webgl1: WEBGL1, noFloat: NO_FLOAT, stage: STAGE, preview: PREVIEW, width: WIDTH, height: HEIGHT,
  startedAt: new Date().toISOString(), status: 'running', checks: [], snapshots: [], screenshots: [], errors: [], shaderErrors: [], requests: [],
  sourceHashes: sourceHashes(), boundaries: [
    'Native headless desktop Edge WebGL, with WebGL2 disabled when requested; no physical iPad/Safari claim.',
    'NO_FLOAT withholds OES_texture_float from the native WebGL1 renderer to exercise its actual CPU-skin fallback.',
    'Tracked WebGL allocations and renderer.info are lifetime evidence, not measurements of physical RAM, VRAM or device thermals.',
    'The isolated example-data fixture has no family storage or economic API; screenshots require visual review.'
  ] };
const persist = () => fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(report, null, 2) + '\n');
let browser, page;
persist();
async function check(label, fn) {
  report.current = label; persist();
  await fn(); report.checks.push({ label, result: 'passed' }); persist(); console.log('PASS ' + label);
}
async function snapshot(label) {
  const state = await page.evaluate(() => ({ renderer: controller.diagnostics(), scene: FamilyFarmScene.diagnostics(), gpu: __dragonGpu.snapshot() }));
  report.snapshots.push({ label, ...state }); persist(); return state;
}
async function healthy(label) {
  const state = await snapshot(label), d = state.renderer;
  assert.ok(d.ready && d.webgl && !d.error, JSON.stringify(d));
  assert.equal(d.contextVersion, WEBGL1 ? 1 : 2);
  assert.ok(d.drawCalls > 0 && d.triangles > 0, 'the native renderer must submit visible geometry');
  assert.ok(state.gpu.programs.every(program => program.linked), JSON.stringify(state.gpu.programs.filter(program => !program.linked).slice(0, 3)));
  assert.deepEqual(state.gpu.errors, [], 'the native context must have no GL errors');
  assert.equal(state.gpu.traceErrors.length, 0, 'each traced native GL call must succeed: ' + JSON.stringify(state.gpu.traceErrors[0]));
  assert.deepEqual(report.errors, []); assert.deepEqual(report.shaderErrors, []);
  return state;
}
async function capture(name) {
  await page.evaluate(() => controller.rotateCompanion({ delta: 0 }));
  const handle = await page.$('canvas.family-farm-canvas'), filename = name + '.png', file = path.join(OUT, filename);
  const bytes = await handle.screenshot({ path: file }); await handle.dispose();
  report.screenshots.push({ file: filename, sha256: sha(bytes) }); persist();
}
async function ready() {
  await page.waitForFunction(() => controller.diagnostics().ready ||
    (controller.diagnostics().error && !controller.diagnostics().contextLost), { timeout: 15000 });
}
async function update(options) { await page.evaluate(value => controller.update(value), options); await ready(); }
async function open() {
  browser = await B.launch(); page = await browser.newPage();
  page.on('pageerror', error => { report.errors.push(error.message); persist(); });
  page.on('console', message => {
    if (message.type() === 'error' && /webgl|shader|program|render/i.test(message.text())) { report.shaderErrors.push(message.text()); persist(); }
  });
  page.on('request', request => { if (/^https?:/.test(request.url())) { report.requests.push(request.url()); persist(); } });
  await page.setViewport({ width: Math.max(390, WIDTH), height: Math.max(844, HEIGHT + 120), deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(({ forceWebgl1, noFloat, traceGl }) => {
    const nativeContext = HTMLCanvasElement.prototype.getContext, contexts = [], seen = new WeakSet();
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      if (forceWebgl1 && type === 'webgl2') return null;
      const gl = nativeContext.call(this, type, ...args);
      if (!gl || !/^webgl|^experimental-webgl/.test(type) || seen.has(gl)) return gl;
      seen.add(gl);
      const resources = {};
      for (const kind of ['Buffer', 'Texture', 'Program', 'Framebuffer', 'Renderbuffer']) {
        const live = new Set(), create = gl['create' + kind].bind(gl), remove = gl['delete' + kind].bind(gl);
        resources[kind] = { live, created: 0, deleted: 0, invalidated: 0 };
        gl['create' + kind] = (...values) => { const item = create(...values); if (item) { live.add(item); resources[kind].created++; } return item; };
        gl['delete' + kind] = item => { if (live.delete(item)) resources[kind].deleted++; return remove(item); };
      }
      if (noFloat) {
        const extension = gl.getExtension.bind(gl);
        gl.getExtension = name => /^OES_texture_float(?:_linear)?$/i.test(name) ? null : extension(name);
      }
      const state = { gl, resources, restored: false, traceErrors: [], traceErrorCounts: {} }; contexts.push(state);
      this.addEventListener('webglcontextlost', () => {
        for (const resource of Object.values(resources)) { resource.invalidated += resource.live.size; resource.live.clear(); }
      });
      this.addEventListener('webglcontextrestored', () => { state.restored = true; });
      if (traceGl) {
        const methods = new Set();
        for (let prototype = Object.getPrototypeOf(gl); prototype && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)) {
          for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(prototype))) if (typeof descriptor.value === 'function') methods.add(name);
        }
        const nativeError = gl.getError.bind(gl);
        for (const name of methods) {
          if (['constructor', 'getError', 'isContextLost'].includes(name)) continue;
          const native = gl[name].bind(gl);
          gl[name] = (...values) => {
            const result = native(...values);
            if (state.restored && !gl.isContextLost()) {
              const error = nativeError();
              if (error !== gl.NO_ERROR) {
                state.traceErrorCounts[name] = (state.traceErrorCounts[name] || 0) + 1;
                if (state.traceErrors.length < 12) state.traceErrors.push({ method: name, error, stack: new Error().stack });
              }
            }
            return result;
          };
        }
      }
      return gl;
    };
    window.__dragonGpu = { snapshot() {
      const state = contexts[contexts.length - 1]; if (!state) return null;
      const { gl, resources } = state, errors = [], lost = gl.isContextLost();
      const isWebgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
      if (!lost) for (let i = 0; i < 16; i++) { const error = gl.getError(); if (error === gl.NO_ERROR) break; errors.push(error); }
      return { contextLost: lost, version: lost ? null : gl.getParameter(gl.VERSION),
        floatVertexTextures: !lost && gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) > 0 && (isWebgl2 || !!gl.getExtension('OES_texture_float')),
        resources: Object.fromEntries(Object.entries(resources).map(([kind, value]) => [kind,
          { live: lost ? 0 : value.live.size, invalidatedByContextLoss: value.invalidated + (lost ? value.live.size : 0), created: value.created, deleted: value.deleted }])),
        programs: lost ? [] : Array.from(resources.Program.live, program => ({ linked: !!gl.getProgramParameter(program, gl.LINK_STATUS), log: gl.getProgramInfoLog(program) })),
        errors, traceErrors: state.traceErrors, traceErrorCounts: state.traceErrorCounts };
    } };
  }, { forceWebgl1: WEBGL1, noFloat: NO_FLOAT, traceGl: TRACE_GL });
  const params = new URLSearchParams({ kind: 'plant', stage: STAGE, mode: 'home', width: WIDTH, height: HEIGHT });
  await page.goto(pathToFileURL(path.join(ROOT, 'farm/verification/v12-fixture.html')).href + '?' + params, { waitUntil: 'load' });
  await page.waitForFunction(() => window.controller, { timeout: 10000 });
  await update({ companionView: { interactive: true, preview: PREVIEW, variant: 'default' }, viewInsets: INSETS, reducedMotion: true });
  await healthy('initial');
}
const groups = {
  async fit() {
    await check('The complete five-stage rig outline remains inside a fixed full-turn frame for the selected stage', async () => {
      for (const variant of PREVIEW ? ['default', 'festival'] : ['default']) {
        await update({ companionView: { interactive: true, preview: PREVIEW, variant } });
        const before = await snapshot(variant + '-front'), camera = JSON.stringify(before.renderer.camera);
        const rect = await page.$eval('#farm', node => node.getBoundingClientRect().toJSON());
        const front = before.renderer.petScreenBounds, body = before.renderer.bodyScreenBounds;
        report.occupancy ||= []; report.occupancy.push({ variant, outlineHeight: front.height / (HEIGHT - INSETS.top - INSETS.bottom), anatomyHeight: body.height / (HEIGHT - INSETS.top - INSETS.bottom) });
        assert.ok(front.height >= (HEIGHT - INSETS.top - INSETS.bottom) * .5, 'the full companion remains prominent');
        for (let angle = 0; angle < 16; angle++) {
          await page.evaluate(() => controller.rotateCompanion({ delta: Math.PI / 8 }));
          const d = (await snapshot(variant + '-turn-' + angle)).renderer, bounds = d.petScreenBounds;
          assert.equal(JSON.stringify(d.camera), camera, 'turning changes no camera coordinates');
          assert.ok(bounds.left >= rect.left + INSETS.left - 1 && bounds.right <= rect.right - INSETS.right + 1 &&
            bounds.top >= rect.top + INSETS.top - 1 && bounds.bottom <= rect.bottom - INSETS.bottom + 1, JSON.stringify({ variant, angle, rect, bounds }));
        }
        await capture(variant + '-full-turn');
      }
    });
  },
  async runtime() {
    await check('Reduced motion settles to a fixed frame; native drag and tap use the rendered dragon', async () => {
      await B.delay(120); const a = await snapshot('static-a'); await B.delay(160); const b = await snapshot('static-b');
      assert.equal(a.renderer.frameCount, b.renderer.frameCount); assert.equal(b.renderer.running, false);
      const bounds = b.renderer.bodyScreenBounds, x = (bounds.left + bounds.right) / 2, y = (bounds.top + bounds.bottom) / 2;
      const initial = b.renderer.companion.rotation;
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 55, y + 1, { steps: 5 }); await page.mouse.up();
      const dragged = (await snapshot('native-drag')).renderer;
      assert.ok(Math.abs(dragged.companion.rotation - initial) > .1, 'native drag turns the actual rig');
      assert.deepEqual(dragged.camera, b.renderer.camera); assert.equal(await page.evaluate(() => picks.length), 0);
      await page.evaluate(() => controller.rotateCompanion({ reset: true }));
      await page.mouse.click(x, y);
      assert.deepEqual(await page.evaluate(() => picks), [{ type: 'pet', id: 'pet' }]);
    });
    await check('Idle animation, pause, detach and resume use a bounded single render loop', async () => {
      await update({ reducedMotion: false }); const before = await snapshot('motion-start'), start = Date.now();
      await B.delay(2200); const after = await healthy('motion-end'), elapsed = Date.now() - start;
      const frames = after.renderer.frameCount - before.renderer.frameCount;
      report.performance = { elapsedMs: elapsed, frames, observedFps: frames * 1000 / elapsed, reportedFps: after.renderer.fps, drawCalls: after.renderer.drawCalls, triangles: after.renderer.triangles };
      assert.ok(frames > 2 && frames <= Math.ceil(elapsed * 30 / 1000) + 3);
      await page.evaluate(() => controller.pause(true)); const paused = (await snapshot('paused')).renderer;
      await B.delay(120); assert.equal((await snapshot('paused-still')).renderer.frameCount, paused.frameCount);
      await page.evaluate(() => controller.pause(false));
      await page.evaluate(() => { window.detachedFarm = document.querySelector('#farm'); detachedFarm.remove(); });
      await B.delay(120); const detached = (await snapshot('detached')).renderer;
      await B.delay(120); assert.equal((await snapshot('detached-still')).renderer.frameCount, detached.frameCount);
      await page.evaluate(() => { document.body.appendChild(detachedFarm); controller.resize(); });
      await B.delay(120); const resumed = await healthy('resumed');
      assert.ok(resumed.renderer.frameCount > detached.frameCount); assert.equal(resumed.scene.canvasCount, 1); assert.ok(resumed.scene.activeCount <= 1);
      await capture('runtime');
    });
  },
  async release() {
    await check('Repeated stage and wardrobe rebuilds reach stable GPU allocations and final disposal releases rig resources', async () => {
      const cycle = async () => {
        await update({ growth: { stage: STAGE === 5 ? 1 : 5, stars: 1 }, companionView: { interactive: true, preview: true, variant: 'festival' } });
        await update({ growth: { stage: STAGE, stars: 1 }, companionView: { interactive: true, preview: PREVIEW, variant: 'default' } });
      };
      await cycle(); const warmed = await healthy('warmed');
      for (let index = 0; index < 2; index++) { await cycle(); await snapshot('rebuild-cycle-' + index); }
      const rebuilt = await healthy('rebuilt');
      assert.deepEqual(rebuilt.renderer.memory, warmed.renderer.memory, 'same rendered form has stable geometry, texture and program allocation counts');
      for (const kind of ['Buffer', 'Texture', 'Program', 'Framebuffer', 'Renderbuffer']) assert.equal(rebuilt.gpu.resources[kind].live, warmed.gpu.resources[kind].live, kind + ' resources stabilize after warm-up');
      await page.evaluate(() => controller.dispose()); const ended = await snapshot('disposed');
      assert.equal(ended.renderer.disposed, true); assert.equal(ended.renderer.running, false); assert.equal(ended.scene.canvasCount, 0);
      assert.equal(ended.gpu.resources.Buffer.live, 0); assert.equal(ended.gpu.resources.Program.live, 0);
      assert.equal(ended.gpu.resources.Texture.live, 0); assert.equal(ended.gpu.contextLost, true, 'the dedicated renderer ends its native context');
      assert.equal(ended.gpu.resources.Framebuffer.live, 0); assert.equal(ended.gpu.resources.Renderbuffer.live, 0);
      for (const resource of Object.values(ended.gpu.resources)) assert.equal(resource.created, resource.deleted + resource.invalidatedByContextLoss, 'every created GL resource is deleted or invalidated by ending its context');
    });
  },
  async context() {
    await check('A real WebGL loss restores the latest requested rig and wardrobe in the same canvas', async () => {
      const before = (await snapshot('before-loss')).renderer;
      await page.evaluate(() => {
        const canvas = document.querySelector('canvas.family-farm-canvas'), gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        window.dragonContextExtension = gl.getExtension('WEBGL_lose_context');
        if (!dragonContextExtension) throw new Error('Native WEBGL_lose_context is required');
        dragonContextExtension.loseContext();
      });
      await page.waitForFunction(() => controller.diagnostics().contextLost, { timeout: 5000 });
      const lost = (await snapshot('lost')).renderer;
      assert.equal(lost.ready, false); assert.equal(lost.running, false);
      await page.evaluate(stage => { controller.update({ growth: { stage, stars: 1 }, companionView: { interactive: true, preview: true, variant: 'festival' } }); dragonContextExtension.restoreContext(); }, STAGE);
      await page.waitForFunction(() => !controller.diagnostics().contextLost && controller.diagnostics().ready, { timeout: 15000 });
      const restored = (await healthy('restored')).renderer;
      assert.equal(restored.canvasId, before.canvasId); assert.equal(restored.companion.stage, STAGE); assert.equal(restored.companion.variant, 'festival');
      assert.equal(restored.companion.showcase, true); assert.equal(restored.companion.rotation, 0);
      await capture('restored');
    });
  }
};
async function run() {
  try {
    await open(); await groups[CASE]();
    assert.deepEqual(report.requests, [], 'embedded assets do not issue external requests');
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.failure = error.stack || String(error); process.exitCode = 1; }
  finally {
    report.sourceHashesAfter = sourceHashes(); report.finishedAt = new Date().toISOString(); persist();
    await browser?.close(); console.log(JSON.stringify({ group: CASE, status: report.status, checks: report.checks.length, output: OUT, failure: report.failure?.slice(0, 700) || null }));
  }
}
if (require.main === module) run();
module.exports = { run };
