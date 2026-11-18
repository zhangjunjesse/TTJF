// Regenerate the small pictures used outside the live 3D scene.
// Run from the project with node tools/render-dragon-portraits.cjs.
const fs = require('node:fs/promises');
const path = require('node:path');
const { build } = require('esbuild');
const { launch } = require('../test/browser.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const target = path.join(root, 'assets/farm/portraits');
  const bundle = await build({
    absWorkingDir: root, entryPoints: ['tools/dragon-portrait-view.js'], bundle: true,
    write: false, format: 'iife', globalName: 'BudPortraits', logLevel: 'silent'
  });
  const browser = await launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const portraits = await page.evaluate(() => BudPortraits.render());
    if (errors.length) throw new Error(errors.join('\n'));
    if (new Set(portraits.map(portrait => portrait.url)).size !== 10) throw new Error('Expected ten distinct growth portraits');
    await fs.mkdir(target, { recursive: true });
    for (const { file, url } of portraits) {
      const prefix = 'data:image/webp;base64,';
      if (!url.startsWith(prefix)) throw new Error('Browser did not return WebP');
      await fs.writeFile(path.join(target, file), Buffer.from(url.slice(prefix.length), 'base64'));
    }
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
