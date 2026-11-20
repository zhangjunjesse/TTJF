# Forest Bud growth implementation — complete

- Owned production files: farm/dragon-forms.js, farm/forest-bud/wardrobe.js.
- Shared factory: equipForestBud(workshop, pet, {stage, stars, variant, quality}), called for both real growth and gallery previews.
- Five forms keep the approved newborn's curled horns, leaf wings, pear body and continuous long tail. Stage 1 growth look adds no egg shell or clothing. Higher forms change proportions, horn curl size, wing spread and skin/leaf palette.
- Existing growth and festival outfit identities are retained. All garments fit the exact indexed skin surface. Held objects follow true palm anchors and keep an upright/outward orientation. The cloak has a real central tail opening.
- stars > 0 retains a small earned chest-star badge. Looks and previews add no persistence or currency rules.
- Quality low disables garment sheen/clearcoat. Exact triangle queries use a 32 x 48 candidate grid to keep gallery changes quick.

## Executed checks

- node --check farm/dragon-forms.js, farm/forest-bud/wardrobe.js: passed.
- node artifacts/forest-bud-growth/smoke.mjs 1 through 5, run as five separate short checks: passed for all ten looks. Finite geometry/transforms, unchanged anatomy when changing clothes, distinct drawable clothes, held-palm contact through five interactions, complete exactly-once resource cleanup.
- node artifacts/forest-bud-growth/capture.cjs N three-quarter final, N=1..5: passed. All ten real Edge/WebGL renders have no shader errors or invalid transforms and share stable source hashes.
- Earned star 0 vs 2: passed (badge absent/present).
- Actual rendered front, greeting and back images opened. Fitted cloth and strap layering corrected; split cloak no longer intersects the central tail root.
- final-report.json is the authoritative final check summary. Files prefixed pass-final are the final ten neutral images. Earlier evidence includes two corrected harness issues and is not counted as successful final acceptance.

## Boundary

Isolated component preview only. Root owns product integration screenshots and unified build. No physical iPad/Safari claim. Existing five growth names and five festival names still fit; initial description should say curled horns, leaf wings and long tail rather than an egg shell.
