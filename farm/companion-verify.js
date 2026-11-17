'use strict';
// Own, isolated character fixture. Never writes historical screenshots or data.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const esbuild = require('esbuild');
const puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const out = path.join(__dirname, 'verification');
const pass = (process.env.COMPANION_PASS || '01').replace(/[^a-z0-9-]/gi, '');
const only = (process.env.COMPANION_SHOTS || 'plant-5-three-quarter,capybara-5-three-quarter,plant-lineup,capybara-lineup').split(',');
const prefix = 'v12-companion-' + pass;
const report = { fixture: 'Original character-only Three.js fixture; no live service, family state or imported character assets.', pass, sourceHashes: {}, screenshots: [], models: [], checks: [], errors: [] };
for (const source of ['farm/companions.js', 'farm/companion-sculpt.js']) report.sourceHashes[source] = createHash('sha256').update(fs.readFileSync(path.join(ROOT, source))).digest('hex');
(async () => {
  const file = path.join(out, prefix + '-fixture.html');
  if (fs.existsSync(file)) throw new Error('Evidence pass exists; use a new COMPANION_PASS to preserve history.');
  const result = await esbuild.build({ absWorkingDir: ROOT, entryPoints: ['farm/companion-preview.js'], bundle: true, format: 'iife', platform: 'browser', target: ['safari15'], minify: true, write: false });
  fs.writeFileSync(file, '<!doctype html><html><head><meta charset="utf-8"><title>Companion sculpture evidence</title><style>html,body{margin:0;overflow:hidden}canvas{display:block}</style></head><body><script>' + result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script') + '</script></body></html>');
  const browser = await puppeteer.launch({ executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage(); page.on('pageerror', error => report.errors.push(error.message));
    for (const shot of only) {
      const pieces = shot.split('-'), kind = pieces[0], lineup = pieces[1] === 'lineup', stage = lineup ? 5 : Number(pieces[1]);
      const angle = pieces.slice(2).join('-') || 'three-quarter';
      await page.setViewport({ width: lineup ? 2000 : 1000, height: lineup ? 560 : 900, deviceScaleFactor: 1 });
      await page.goto(pathToFileURL(file).href + '?kind=' + kind + '&stage=' + stage + '&angle=' + angle + (lineup ? '&lineup' : ''), { waitUntil: 'load' });
      await page.waitForFunction(() => window.fixtureReady);
      const stats = await page.evaluate(() => CompanionFixture.stats()); report.models.push(...stats);
      const screenshot = prefix + '-' + shot + '.png'; await page.screenshot({ path: path.join(out, screenshot) }); report.screenshots.push(screenshot);
      if (stats.some(s => !s.finite || !s.anatomyVertexCount || !s.anatomyBoundsMatchVertices || s.anatomy.height < 2)) throw new Error('Invalid anatomical measurement: ' + shot);
      // Animations must preserve animated eye parent transforms after batching.
      const base = await page.evaluate(() => CompanionFixture.stats());
      await page.evaluate(() => CompanionFixture.render(5.21, { progress: .5, kind: 'harvest', look: .16 }, false));
      const action = await page.evaluate(() => CompanionFixture.stats());
      if (action.some(s => s.eyes.some(e => e.scaleY > .10))) throw new Error('Blink did not close at apex');
      if (action.some((s, i) => s.limbs[0].rotation[2] === base[i].limbs[0].rotation[2])) throw new Error('Harvest arm response missing');
      report.checks.push({ shot, finiteAnatomy: true, anatomyBoundsMatchVertices: true, blink: true, harvestMotion: true });
      if (process.env.COMPANION_ACTIONS === '1' && !lineup && angle === 'three-quarter') {
        const actionShot = prefix + '-' + shot + '-harvest-blink.png';
        await page.screenshot({ path: path.join(out, actionShot) }); report.screenshots.push(actionShot);
      }
      await page.evaluate(() => CompanionFixture.render(5.21, null, true));
      const reduced = await page.evaluate(() => CompanionFixture.stats());
      if (reduced.some(s => s.eyes.some(e => e.scaleY !== 1) || s.limbs.some(l => l.rotation[2] !== 0))) throw new Error('Reduced-motion idle did not restore neutral pose');
      report.checks[report.checks.length - 1].reducedMotionIdle = true;
      const released = await page.evaluate(() => { CompanionFixture.dispose(); return { ...CompanionFixture.renderer.info.memory }; });
      if (released.geometries !== 0 || released.textures !== 0) throw new Error('Fixture resource disposal left GPU allocations: ' + JSON.stringify(released));
      report.checks[report.checks.length - 1].releasedGpuAllocations = released;
    }
    if (report.errors.length) throw new Error(report.errors.join('\n'));
  } finally { await browser.close(); fs.writeFileSync(path.join(out, prefix + '-report.json'), JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify({ pass, screenshots: report.screenshots, errors: report.errors, models: report.models.map(m => ({ kind: m.kind, stage: m.stage, anatomyHeight: m.anatomy.height, vertices: m.vertices, meshes: m.meshes })) }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
