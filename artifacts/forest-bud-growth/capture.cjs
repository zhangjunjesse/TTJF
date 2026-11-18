'use strict';
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const B = require('../../test/browser.cjs');
const output = __dirname, root = path.resolve(__dirname, '../..');
const stage = Number(process.argv[2] || 1), angle = process.argv[3] || 'three-quarter';
const pass = process.argv[4] || '01';
const action = process.argv[5] || '';
(async () => {
  const bundle = await esbuild.build({ absWorkingDir: root, entryPoints: ['artifacts/forest-bud-growth/preview.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser', target: ['safari15'] });
  const html = path.join(output, 'fixture-' + createHash('sha256').update(bundle.outputFiles[0].text).digest('hex').slice(0, 12) + '.html');
  if (!fs.existsSync(html)) fs.writeFileSync(html, '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden}canvas{display:block}</style></head><body><script>' + bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script') + '</script></body></html>');
  const sourceHashes = Object.fromEntries(['farm/dragon-forms.js', 'farm/forest-bud/wardrobe.js', 'farm/forest-bud/companion.js', 'farm/companions.js'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
  const browser = await B.launch(), report = { stage, angle, action, sourceHashes, checks: [], errors: [] };
  try {
    const page = await browser.newPage(); await page.setViewport({ width: 1000, height: 1000, deviceScaleFactor: 1 });
    page.on('pageerror', error => report.errors.push(error.message));
    for (const variant of ['default', 'festival']) {
      await page.goto(pathToFileURL(html).href + '?' + new URLSearchParams({ stage, angle, variant }), { waitUntil: 'load' });
      await page.waitForFunction(() => window.fixtureReady, { timeout: 30000 });
      if (action) await page.evaluate(kind => GrowthFixture.render(2.4, { kind, progress: .52 }, false), action);
      const stats = await page.evaluate(() => GrowthFixture.stats()); report.checks.push(stats);
      await page.screenshot({ path: path.join(output, `pass-${pass}-stage-${stage}-${variant}-${angle}${action ? '-' + action : ''}.png`) });
      await page.evaluate(() => GrowthFixture.dispose());
      fs.writeFileSync(path.join(output, `pass-${pass}-stage-${stage}-${angle}${action ? '-' + action : ''}.json`), JSON.stringify(report, null, 2));
      if (stats.invalid || stats.shaderErrors.length || report.errors.length) throw new Error('Invalid look: ' + JSON.stringify(stats));
    }
  } finally { await browser.close(); fs.writeFileSync(path.join(output, `pass-${pass}-stage-${stage}-${angle}${action ? '-' + action : ''}.json`), JSON.stringify(report, null, 2)); }
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; });
