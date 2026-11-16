'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const B = require('./browser.cjs');

(async () => {
  const result = { preview: process.env.FAMILY_PREVIEW_URL || 'http://127.0.0.1:4178', staticFiles: {}, offline: {}, errors: [], passed: false };
  let browser;
  try {
    for (const name of ['app.js', 'styles.css', 'model.js', 'pet.js', 'pet.css', 'index.html']) {
      const source = fs.readFileSync(path.join(B.ROOT, name));
      const response = await fetch(result.preview + '/' + name);
      assert.equal(response.status, 200, name);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), source, name + ': preview differs');
      result.staticFiles[name] = crypto.createHash('sha256').update(source).digest('hex');
    }
    browser = await B.launch();
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 390, height: 844 });
    page.on('pageerror', error => result.errors.push(error.message));
    const requests = [];
    page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
    await page.goto(pathToFileURL(path.join(B.ROOT, 'export/little-steps-demo.html')).href, { waitUntil: 'load' });
    await page.waitForFunction(() => window.FamilyDemo);
    await B.click(page, B.action('add-points'));
    await B.click(page, B.action('points-new'));
    result.offline = await page.$eval('.sheet-save', button => {
      const rect = button.getBoundingClientRect(), style = getComputedStyle(button);
      return { local: window.__FAMILY_OFFLINE__ === true, form: window.FamilyDemo.getUI().form, text: button.textContent, width: rect.width, height: rect.height, background: style.backgroundColor, foreground: style.color, inViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight };
    });
    assert.equal(result.offline.local, true);
    assert.equal(result.offline.form, 'points');
    assert.equal(result.offline.text, '加分');
    assert.ok(result.offline.width >= 72 && result.offline.height >= 48 && result.offline.inViewport);
    assert.equal(result.offline.background, 'rgb(50, 108, 81)');
    assert.deepEqual(requests, []);
    assert.deepEqual(result.errors, []);
    result.passed = true;
  } catch (error) { result.errors.push(error.message); process.exitCode = 1; }
  finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(B.ARTIFACTS, 'v10-release-check.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  }
})();
