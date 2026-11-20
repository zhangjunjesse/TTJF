# Real dragon scene integration verification

## Delivered scope

- `farm/scene.js`: consume the model's prepared full-turn/care envelope, sample current pose only for diagnostics, preserve the fixed farm camera, compensate the camera heading in the approved model-facing yaw, select low geometry for small/short hosts and WebGL1, preserve the turn through responsive quality changes, and add gentle frontal gallery fill.
- WebGL1 uses the same tail rig through CPU skinning because Three r160's built-in GPU-skin shader uses GLSL3 fetch operations. WebGL2 keeps GPU skinning, including low geometry on small hosts.
- Rebuild/disposal releases the rig before Workshop resources. Context loss retires the old world, credit effect and shadow targets while the context is lost; restoration builds the latest requested view in the same canvas. Final disposal also ends the dedicated context and clears renderer/canvas/listener references.
- `farm/primitives.js`: static batches preserve live skinning and morph-expression meshes.
- `test/farm-scene-interaction.test.cjs`: added prepared-envelope/diagnostic, rig lifetime, live batching and responsive quality regressions.
- `test/dragon-renderer-browser.cjs`: native WebGL1/2 short groups (`fit`, `runtime`, `release`, `context`) with allocation, program-link and optional per-call GL error checks.

## Final bundle

The final costume bundle was checked with SHA-256 `c9f2db1bc3de29589865f8300d96b02eceff8089f4bc40ec250f2534841b9f2b` (2,852,555 bytes). Its hash remained unchanged throughout the final release/runtime checks.

- Final WebGL2 repeated stage/wardrobe release: passed. Every created GL resource was either explicitly deleted or invalidated by ending the owned context; no live buffer, texture, program, framebuffer or renderbuffer remained. See `release-webgl2-20261118112705846-1628/results.json`.
- Final small-host WebGL2 runtime: passed two checks covering static reduced motion, native drag/tap, bounded animation, pause, DOM detach/reattach and one active render loop. The 2.219-second sample drew 64 frames (~28.8 fps; renderer reported 30), 195 draw calls and 312,199 scene triangles. See `runtime-webgl2-20261118112734980-11752/results.json`.
- Final host contracts: 9/9 passed in 3.72 seconds, including unchanged capybara/station interaction behavior. Syntax checks passed for scene, primitives and the native browser runner. See `final-host-contracts.log`.

## Other targeted evidence

- Original all-species/five-stage/home full-turn and prominence check passed after correcting the model's stale skin bind-matrix measurements (`fixed-matrix-all-stage-home.log`, 21.7 seconds).
- Original five-stage/two-look gallery full-turn and preview-scope checks passed (`actual-all-gallery-stages.log`, 59.3 seconds).
- Responsive low/high/low transitions preserve yaw, compact views use less than 60% of high-geometry triangles, and even float-capable WebGL1 has no drawable SkinnedMesh (`actual-quality-transition.log`).
- Native WebGL1 and WebGL2 context loss/restoration passed with per-call GL tracing and zero errors after the old-context cleanup fix (`context-webgl1-20261118112434244-24584`, `context-webgl2-20261118112535312-35664`). These ran on the preceding bundle with the same host/interface code.
- Native WebGL1 with OES float textures withheld passed runtime (`runtime-webgl1-cpu-20261118112545995-28388`).
- Native WebGL1 full-turn fit passed phone stage 1 and stage 5 at 346×322, and mini gallery stage 5 with both looks at 718×449. Phone stage 5 filled 75% of the reserved height; mini stage 5 filled 84%. Images are in the corresponding `fit-webgl1-*` directories.

## Diagnosed and fixed failures

1. WebGL1 shader link failure from Three r160 GPU skinning: resolved by CPU skinning on WebGL1.
2. Growth tail envelope expanded twice because measurement skipped SkinnedMesh's matrix update override: the dragon agent corrected the measurement path. Stage-5 profile tail depth recovered from 5.95 to 3.63 root units, close to the actual neutral 3.53.
3. Final Three disposal retained its background/depth/placeholder caches: resolved by ending the dedicated final context.
4. Restoring before retiring old GL geometry caused INVALID_OPERATION on old-buffer deletion: resolved by disposing the old world while the context is still lost.

All failed exploratory reports remain separate from passing evidence. No failed assertion was removed or relaxed to hide these defects.

## Limits

The native checks ran in headless desktop Edge with selected CSS sizes. They establish neither physical iPad/Safari performance nor mobile RAM/VRAM, heat, long suspension, or long-running stability. No family account or economic state was accessed. The root agent owns the final SaaS-page and screenshot review and generated bundle.
