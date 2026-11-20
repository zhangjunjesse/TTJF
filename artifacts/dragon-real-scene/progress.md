# Real dragon scene integration

- Scope: farm/scene.js; targeted host tests only. No generated bundle writes.
- Baseline: existing scene controller uses raw mesh vertices for fitting/diagnostics and Workshop-only world cleanup.
- Contract agreed with product_dragon: optional root-local frameProfile { bounds, points }, measurePoints(anatomy), dispose(), homeYaw; renderer passes webgl2 and quality.
- In progress: inspect fixed-camera, pause, context restore, and lifetime paths; preserve capybara and station behavior.

## Host implementation checkpoint

- Added optional frameProfile envelope consumption, current-pose measurement hooks, and model-provided home yaw.
- Renderer capability forwarded as quality=high|low and webgl2.
- Added releaseWorld: rig.dispose() runs before Workshop.dispose(); shadow mapPass is also disposed at final teardown.
- Preserved fixed home camera, capybara behavior, station orientation, drag/pick arbitration, and response durations.
- Baseline host tests: 9/9 passed, 20.8 s.
- After host changes: targeted ordinary interactions 6/6 passed; rig envelope/lifetime contracts 2/2 passed.
- Full envelope-era host suite is running against the old model; final new-dragon integration remains pending product_dragon output.

## Static batching checkpoint

- Workshop.bake now preserves SkinnedMesh and morph-target meshes.
- Actual Skeleton displacement and morph expression still work after static batches are merged: passed.
- Complete pre-new-dragon controller suite: 11/11 passed, 19.9 s.
- Current rig-only suite including the batching regression: 3/3 passed, 0.93 s.
- farm/scene.js syntax check: passed.
- Pending: new-model full-turn fit/occupancy and actual renderer/browser confirmation after the other agents finish the adapter and growth attachments.

## Actual dragon findings

- Native WebGL2 runtime passed: reduced-motion fixed frame, real mouse drag/tap, pause, DOM detach/reattach, single render loop; 67 frames / 2230 ms (~30 fps), 195 draw calls and ~500k scene triangles before low-density geometry.
- Native WebGL1 initially failed program link: Three r160 skin shader uses GLSL3 texelFetch/textureSize. Host now requests CPU skinning for every WebGL1 context; real WebGL1 runtime then passed 2/2 (~29.8 fps on desktop Edge).
- Rebuild allocations stabilized exactly across repeated growth/wardrobe cycles (610 buffers / 12 textures / 40 programs for the tested high-density scene).
- Final renderer.dispose() leaves Three-internal background/depth/placeholder allocations. Host now force-loses its dedicated context after final disposal and clears renderer/canvas/cleanup references; waiting for rebuilt bundle verification.
- Existing home prominence check initially failed stage 3. Investigation found measure.js skipped SkinnedMesh.updateMatrixWorld(), double-scaling tails in the profile after growth. Product dragon agent corrected matrix updates; stage 5 profile tail recovered from z=-5.95 to -3.63 (true neutral -3.53).
- Parent provided actual host sizes: phone about 346x322; mini gallery about 718x449.
- Host now compensates the home camera's .22 horizontal component in model yaw, keeps the same farm camera, uses a neutral front-side gallery fill, and selects low density for small/short hosts or WebGL1. Responsive quality transitions rebuild only the dragon.

## Complete handoff

- Final costume bundle SHA-256: c9f2db1bc3de29589865f8300d96b02eceff8089f4bc40ec250f2534841b9f2b (2,852,555 bytes).
- Final WebGL2 release passed: every GL resource is deleted or invalidated by the dedicated context ending; live counts all zero.
- Final WebGL2 low-density runtime passed 2/2: 64 frames in 2219 ms (~28.8 fps), 195 calls, 312,199 scene triangles; no page, shader, GL or network errors.
- Final host contracts passed 9/9; syntax checks and git diff --check passed for owned scene/primitives files.
- WebGL1/WebGL2 context recovery with per-call tracing passed, and WebGL1 no-float runtime passed.
- All-stage home/gallery frame and scope checks passed; responsive quality/cpu fallback check passed.
- Full evidence and exact limits: verification.md. Root owns final SaaS page/screenshot review and bundle generation. No bundle was written and no commit was created by this agent.
