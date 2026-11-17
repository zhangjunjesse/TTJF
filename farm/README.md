# FamilyFarmScene 1.2.0 · TTJF v0.12

This is the renderer used by the existing TTJF application, not a separate game or an embedded upstream page. Economy and persistence are owned by [the farm decision](../docs/farm-design-proposal.md), [the domain model](../model.js), and [the existing server](../server.cjs). The rejected v0.11 visual evidence remains historical.

## Build and use

```sh
npm run build:farm
node --check farm-scene.js
npm run test:farm-renderer
```

The build pins `three@0.160.1`, targets Safari 15, verifies all 22 GLBs against their recorded size and SHA-256, and emits one ordinary IIFE. It embeds model buffers, textures, Meshopt WebAssembly, and retained MIT notices; it uses no runtime CDN, import map, worker download, external model, or external WASM request. GLB normalized Int16 attributes are expanded to floating point **before** world transforms to prevent overflow.

```js
const c = FamilyFarmScene.mount(element, {
  mode: 'home',                       // home | expanded
  farm: FamilyModel.farmStatus(state, now, familyDay),
  pet: {kind: 'plant', name: '芽芽'},   // plant | capybara
  growth: {stage: 3, stars: 0, xp: 128},
  lighting: 'day',                    // day | night; view only
  viewInsets: {top: 0, right: 0, bottom: 0, left: 0},
  reducedMotion: false,
  onSelect(target) { /* open the corresponding real app panel */ },
  onStatus(status) { /* show readiness or a useful fallback */ }
});
c.update({mode: 'expanded'});          // preserves renderer and canvas
c.camera({zoomBy: 1.2});
c.camera({panX: 1, panZ: 0});
c.camera({reset: true});
c.focus({type: 'plot', id: 'p1'});
c.react('harvest');                    // finite animation, no domain writes
c.react('care', {type: 'animal', id: 'rabbit'});
c.pause(true);
c.pause(false);
c.resize();
c.diagnostics();
c.dispose();                          // idempotent
```

The host owns accessible HTML buttons, projections, all transactions, pending/retry feedback, loading/errors and container geometry. Target types are `plot/p1..p6`, `animal/chicken|rabbit`, `pet/pet`, `house/house`, and `slot/entry|center|edge|fence|path`. Returning a selection never changes saved state. Previewing a house or decoration uses a cloned render projection; committing still requires the existing server action.

## World, companion and camera

The 80×80 continuous landscape contains the farmhouse and barn, six cultivation beds, animal yards, connected paths, river/bridge, orchard, layered forest, rocks, grass and farm props. Terrain, recessed river banks, soil ridges and surface detail are composed for TTJF. [Source records](../assets/farm/CREDITS.md) distinguish upstream CC0 packs from MIT-generated geometry and source references. Original companions are authored in [companions.js](companions.js) and [companion-sculpt.js](companion-sculpt.js): connected low-poly anatomy, fitted eyes and clothing, grounded feet, ten distinct growth forms, blinking and finite interaction responses.

Home uses a perspective close-up: the companion is the main subject while the house, paths and fields stay in the same world behind it. Expanded mode uses a fixed-angle orthographic camera with pan and zoom. Phone framing shows a normally scaled local area, not a shrunken island. The host supplies measured panel insets so a focused object lands in the unobscured viewport. An ordinary state poll does not reset navigation.

Expanded input: single-pointer drag pans; wheel or `+`/`−` zooms; `Home` resets; arrow keys pan; Enter/Space selects the pet. Visible 48px buttons and HTML object lists provide touch and keyboard equivalents. Selection requires the same primary pointer, less than 650ms and at most 8 CSS px of movement. Cancellation, a second pointer or a drag suppresses selection.

Only supplied `farm`, `pet`, `growth`, lighting and camera options are read. Growing crops use server-projected `remainingMs` when present; only `status:'ready'` is ripe. Day/night only changes lighting, with no clock, crop, animal-care or persistence effect. Night uses cool ambient/moonlight, warm windows and small lamp pools; glass roofs do not emit light.

## Rendering and lifecycle

Static assemblies are merged into vertex-colour Lambert meshes. The scene uses textured ground/soil/water and a 2048px directional shadow map updated when needed. There is no heavy postprocessing. The frame cap is 30fps and DPR cap 1.25. Visibility changes, explicit pause, context loss and detached/zero-sized containers stop rendering; reduced motion settles after a finite response. ResizeObserver and a window-resize fallback are supported. Disposal removes observers, handlers, animation scheduling, geometries, materials, textures, renderer and registry entries.

Diagnostic fields include mode, lighting, readiness/error, canvas identity, frame count/fps, DPR, draw calls/triangles, texture/geometry counts, context version, camera state, `bodyScreenBounds`, `petScreenBounds` and hit targets. Body bounds project sampled anatomical mesh vertices and exclude tail, wings, ground and effects. Compare memory only after model loading, selection, both lighting modes and the relevant preview have warmed up. `externalAssetRequests:0` is a code invariant; network interception separately checks actual requests.

The frozen v0.12 bundle is **2,735,892 bytes**, gzip (Node default) **1,153,655 bytes**; SHA-256 `b0b1526889b498aecaf59cc6b16d7d79d4677b20fbfb90f754d112f7abd879de`. World review scenes measured about **41 calls by day / 49 by night**, around **216k triangles**. They are desktop observations, not A8 performance claims. Final app measurements and any later fixes are recorded in [v0.12 verification](../artifacts/v12-verification.md).

## Evidence and limits

[The component runner](verify-v12.cjs) uses isolated file fixtures; [the application runner](../test/v12-browser.cjs) uses temporary family stores and real hit-tested mouse/touch events. [Companion review](verification/v12-companion-visual-review.md) retains the actual shape iterations, exact-vertex bounds, animation and disposal evidence. The final reference comparison and production-source hashes belong to [the app visual review](../artifacts/v12-visual-review.md). Test counts do not establish aesthetic parity.

The old [43-check component report](verification/component-results.json) belongs to v0.11 and does not verify this replacement scene. Physical iPad mini 4 / iPadOS 15.8.7 startup, ten-minute thermal/memory behaviour, native multitouch and real OS background recovery remain unverified. Desktop Edge, forced WebGL1 and Safari15-target compilation cover only part of that boundary.
