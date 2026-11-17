# v12 companion visual review

The two companions were rebuilt as original, closed low-poly sculptures. Production changes are limited to [companions.js](../companions.js) and [companion-sculpt.js](../companion-sculpt.js). The existing makeCompanion/animateCompanion interface, plant/capybara kinds, five stages, scene fields, reactions, blinking and reduced-motion idle remain available. The shared world, lighting, scene, main bundle and family data were not edited by this task.

The reference images [hero](../../artifacts/v12-reference/hero.png) and [farm-day](../../artifacts/v12-reference/farm-day.png), and the previous [plant home](plant-home.png) and [capybara home](capybara-home.png), were opened and visually inspected before redesign. The target was the reference's coherent faceted forms, warm materials, planted weight and integrated world scale.

The dragon now has a continuous pear-shaped torso/neck, one lofted head and snout, inset dark eyes, shaped arms, broad toes, a swept tail and thick leaf wings with a bent supporting skeleton. The capybara has a broad blunt muzzle, small ears, quiet almond eyes, a tailored suit, fitted straps, boots with separate soles and a solid helmet shell with an open face and transparent canopy. No external character model or character texture was used.

| Stage | 晶叶龙 | 太空水豚 |
|---|---|---|
| 1 | Short horns, wing buds, shorter body, broken shell | Shorter body, exposed fur, scarf, compact receiver |
| 2 | Longer horns, growing wings, neckerchief | Tailored suit, boots, harness, control panel, backpack |
| 3 | Gardener's satchel and fitted leather strap | Rear helmet shell, collar, ear modules and transparent canopy |
| 4 | Larger structured wings, crystal tips, short cape | Twin back tanks, rescue badge and additional hardware |
| 5 | Planted crystal-leaf crown and leaf-emblem cloak | Captain's shoulder fittings, helmet insignia and trimmed blue mantle |

Seven isolated Edge/WebGL fixture passes were preserved without overwriting historical evidence. Passes 01–05 were visual iterations; pass 06 refined exact anatomical measurements, and pass 07 added explicit GPU cleanup checks. Each reported screenshot was produced by a real Three.js render; no generated promotional image was substituted for the implementation.

Issues found by opening the renders, and then corrected:

- Initial eye placement was partly buried at the face's changing planes. Eye vertices are now projected onto the actual head surface, with additional local subdivision so they follow individual facets. The complete eye assembly blinks, leaving no unmoving dark frame.
- The first capybara boot shell intersected its underlying foot. The final boot sections fully enclose the foot while retaining a separate planted sole.
- Side views exposed spaces behind the chest straps. The front straps now follow the actual torso surface, and the control panel sits against the suit.
- Back views were too plain. The helmet received a fitted stripe and vents, the backpack received recessed control details, and capes received restrained seams, hems and insignia.
- The first world home render placed a thick stepping stone through the forefoot. This was reported to world; the final world render uses a thinner stone and corrected placement.

Useful evidence:

- [Five dragon forms](v12-companion-06-plant-lineup.png) and [five capybara forms](v12-companion-06-capybara-lineup.png), left to right stages 1–5.
- [Dragon close-up](v12-companion-06-plant-5-three-quarter.png) and [capybara close-up](v12-companion-06-capybara-5-three-quarter.png).
- [Dragon harvest and blink](v12-companion-06-plant-5-three-quarter-harvest-blink.png) and [capybara harvest and blink](v12-companion-06-capybara-5-three-quarter-harvest-blink.png).
- [Dragon back](v12-companion-05-plant-5-back.png) and [capybara back](v12-companion-05-capybara-5-back.png).
- Ten individual front views are recorded in the [pass 05 report](v12-companion-05-report.json).

The following final integrated world renders were also opened and visually inspected: [dragon expanded](../../assets/farm/review/world-v12-final-expanded-1280-plant-day.png), [capybara expanded](../../assets/farm/review/world-v12-final-expanded-1280-capybara-day.png), [390px dragon home](../../assets/farm/review/world-v12-final-home-390-plant-day.png), and [capybara night home](../../assets/farm/review/world-v12-final-home-650-capybara-night.png). The companion remains smaller than the house in the expanded world; the front-facing eyes and clothing remain legible in the close home view. The wings and helmet are complete from the elevated camera. The corrected feet and stone no longer show the earlier obvious intersection. At night the capybara retains readable facial planes and suit detail under the world's cooler fill light.

The [pass 07 report](v12-companion-07-report.json) records actual checks for all ten forms: finite anatomical vertices, anatomical bounds matching those vertices within 1e-6, blink closure, harvest arm response, neutral reduced-motion idle, no script errors, and zero remaining geometry/texture allocations after each entire lineup is disposed. Bounds use only body, head, ears, arms and feet; horns, crowns, wings, tails, clothing and helmet never enlarge the anatomical measurement. The final adult dragon is 5,470 triangles/9 meshes; the capybara is 9,238 triangles/9 meshes including its indexed transparent canopy.

Final production hashes recorded by that report:

- companions.js SHA-256: 2b61e34db97e2dab1b7b45f6406dd18f60790eaa314b4d19b3f7e9b04ac821f0
- companion-sculpt.js SHA-256: 9a9366b82c82fbd0d7a5e845a57c1f512486a38d6203f7731b97f0d379e538b3

The fixture uses [companion-preview.js](../companion-preview.js) and [companion-verify.js](../companion-verify.js), bundles only its own offline page and writes a new evidence pass each time. It refuses to overwrite an existing pass. JavaScript syntax checks passed; world performed the unified application build. These are desktop headless Edge/WebGL results, not physical iPad or Safari device evidence.
