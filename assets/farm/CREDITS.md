# Family Farm scene assets and rendering references

Retrieved 2026-11-16 from [Harvest Hollow](https://github.com/KrasimirKralev/harvest-hollow/tree/9b23e1a1fe2b19e117a3005efce21417052ded97) at fixed revision `9b23e1a1fe2b19e117a3005efce21417052ded97`. All **22 local GLB Git blob hashes** were compared with that revision's recursive Git tree and matched. Per-file SHA-256, Git blob, original path, bytes and provenance notes are recorded in [SOURCES.json](SOURCES.json). The build validates each local GLB's size and SHA-256 against that record.

The unmodified GLBs total **1,542,604 bytes**. Runtime normalization selects named nodes, expands normalized/quantized attributes to floating point, applies a consistent physical scale, and bakes vertex colours into Lambert meshes. They are embedded as data URLs in the offline IIFE. No game asset is fetched at runtime.

| Models | Upstream location under `public/assets/models/` | Provenance retained |
| --- | --- | --- |
| carrot, strawberry, sunflower | crops/ | Upstream crop meshes; original pack attribution plus MIT procedural processing retained |
| chicken, rabbit | animals/ | Original CC0 pack attribution and upstream processing retained |
| farmhouse-1, farmhouse-2, farmhouse-3 | buildings/ | Upstream authored farmhouse/tier geometry and source-pack attribution; MIT notice retained |
| barn | buildings/ | Quaternius Ultimate Farm Buildings with upstream assembly/processing |
| props | props/ | Mixed procedural forest trees, grasses and props; MIT authored geometry and pack credits retained |
| debris | debris/ | Quaternius Ultimate Nature rocks/stumps/logs plus procedural weed geometry |
| apple_tree, pine | trees/ | Upstream procedural fruit/pine tree geometry (`fruitTree`, `pineTree`) |
| coop | homes/ | Quaternius ChickenCoop plus upstream generated pen/yard/trough |
| hutch | homes/ | Upstream procedural `rabbitHutch` |
| stone_well, sunset_bench | decor/ | Quaternius Medieval Village props plus upstream generated flowers/assembly |
| hay_bales, scarecrow, flower_bed, wheelbarrow, lantern | decor/ | Upstream procedural decoration generators |

The upstream [models/CREDITS.md](https://github.com/KrasimirKralev/harvest-hollow/blob/9b23e1a1fe2b19e117a3005efce21417052ded97/public/assets/models/CREDITS.md) declares its source packs **CC0 1.0**. Its full statement is retained verbatim in [UPSTREAM-CREDITS.md](UPSTREAM-CREDITS.md), including Quaternius, Kenney and vertexcat author links. Inspection of the pinned `tools/build-assets.mjs` also identified original procedural geometry and generated additions; these are **not described here as exclusively CC0**. We retain the upstream **MIT** copyright/permission notice for those contributions and the render source. The full legal texts are [CC0-1.0.txt](CC0-1.0.txt) and [HARVEST-HOLLOW-LICENSE.txt](HARVEST-HOLLOW-LICENSE.txt).

The pinned [render modules](reference/scene.js) and [model manifest](reference/model-manifest.json) were read as rendering references. The deterministic integer hash/value-noise method in `world-terrain.js` is adapted from upstream `ground.js` under MIT. The terrain layout, ground/detail textures, river-bank geometry, crop-soil surface, camera framing/navigation, lighting integration and local decoration layout were implemented for this project. Original companion modelling is local and does not reuse SVG companions. Imported forest/tree/prop models are attributed above rather than called local original work.

No upstream script, package installation, game process or server was executed. The downloaded asset-build source was only inspected to establish provenance. Three.js r160 and its bundled meshoptimizer decoder retain their MIT notices in [THIRD-PARTY-LICENSES.txt](THIRD-PARTY-LICENSES.txt). Those notices **and the Harvest Hollow MIT licence** are embedded in the generated scene bundle, preserving attribution in offline single-file distribution.
