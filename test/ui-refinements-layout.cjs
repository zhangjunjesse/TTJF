'use strict';

// Short, isolated browser run for each viewport. Never connects to a live family.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const B = require('./browser.cjs');
const { screenFit } = require('./home-screen-fit.cjs');
const CASE = process.env.UI_LAYOUT_CASE || 'home';
assert.ok(['home', 'long'].includes(CASE), 'UI_LAYOUT_CASE must be home or long');
const width = Number(process.env.UI_LAYOUT_WIDTH || 905);
const height = Number(process.env.UI_LAYOUT_HEIGHT || (width === 320 ? 568 : width === 390 ? 844 : 892));
const out = path.join(B.ARTIFACTS, 'ui-layout-' + CASE + '-' + width + 'x' + height + '-' + Date.now());
fs.mkdirSync(out, { recursive: true });
const report = { status: 'running', case: CASE, viewport: { width, height }, checks: [], screenshots: [] };
function persist() { fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2)); }
async function shot(page, name) {
  const file = path.join(out, name + '.png');
  await page.screenshot({ path: file, fullPage: false }); report.screenshots.push(file); persist();
}
async function panel(page, name) {
  const result = await page.$eval('.sheet', el => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom,
      viewportWidth: innerWidth, viewportHeight: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  assert.equal(result.overflow, false, name + ': horizontal overflow');
  assert.ok(result.x >= -1 && result.y >= -1 && result.right <= width + 1 && result.bottom <= height + 1,
    name + ': dialog outside viewport ' + JSON.stringify(result));
  if (name !== 'editor') assert.ok(Math.abs(result.x + result.width / 2 - width / 2) < 2, name + ': centered dialog');
  report.checks.push({ name, ...result }); persist();
}
async function main() {
  let browser, env, page;
  persist();
  try {
    browser = await B.launch();
    for (const count of CASE === 'long' ? [2] : [1, 2, 4]) {
      const state = B.Model.createSeed(new Date(B.FIXTURE_TIME));
      state.pointItems = state.pointItems.slice(0, count);
      if (CASE === 'long') state.points = [{ ...state.points[0], points: 123456789 }];
      env = await B.createEnvironment(browser, { state });
      page = await env.newPage({ width, height });
      page.setDefaultTimeout(8000);
      await env.load(page);
      await page.waitForFunction(() => {
        const img = document.querySelector('[data-credit-scene]');
        return img && img.complete && img.naturalWidth > 0;
      });
      const cards = await page.$$eval('.home-behavior', nodes => nodes.map(el => {
        const r = el.getBoundingClientRect(), icon = el.querySelector('.behavior-symbol').getBoundingClientRect();
        return { height: r.height, width: r.width, iconWidth: icon.width, iconHeight: icon.height };
      }));
      const wide = width >= 700 && height > 450;
      assert.equal(cards.length, wide ? count : Math.min(2, count));
      for (const card of cards) {
        assert.ok(card.height >= 44 && card.height <= 160, 'behavior card stretched: ' + JSON.stringify(card));
        assert.ok(Math.abs(card.iconWidth - card.iconHeight) < 1 && card.iconHeight <= 48, 'behavior icon stretched');
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.equal(await page.$eval('[data-testid="earned-points"]', el => Number(el.textContent)), B.Model.totals(state).earned);
      assert.equal(await page.$eval('[data-testid="available-points"]', el => Number(el.textContent)), B.Model.totals(state).available);
      const walletFits = await page.$eval('.credit-score', el => {
        const box = el.getBoundingClientRect();
        return ['.credit-kicker', '.credit-value', '.credit-redeemable', '.credit-history-hint'].flatMap(selector => {
          const node = el.querySelector(selector), r = node.getBoundingClientRect();
          if (selector === '.credit-history-hint' && (!r.width || !r.height || getComputedStyle(node).display === 'none')) return [];
          return { selector, fits: r.left >= box.left && r.top >= box.top && r.right <= box.right && r.bottom <= box.bottom,
            rect: r.toJSON(), container: box.toJSON() };
        });
      });
      assert.ok(walletFits.every(item => item.fits), 'both wallet amounts and labels fit without clipping: ' + JSON.stringify(walletFits));
      const homeLayout = await screenFit(page, { probe: count === 2 });
      const bodyMinimum = { '320x568': 100, '390x844': 170, '1024x768': 240 }[width + 'x' + height];
      if (bodyMinimum && CASE === 'home') {
        const body = await page.evaluate(() => window.FamilyDemo.getUI().farmRender.renderer.bodyScreenBounds);
        assert.equal(B.Model.growth(state).stage, 3, 'third-stage companion fixture');
        assert.ok(body && body.height >= bodyMinimum, 'visible companion body height: ' + JSON.stringify(body));
        report.checks.push({ name: 'third-stage-companion-height', height: body.height, minimum: bodyMinimum });
      }
      const entry = await page.$eval(B.action('farm-pet-preview'), button => {
        const summary = button.closest('.pet-growth-summary'), box = button.getBoundingClientRect(),
          area = summary && summary.getBoundingClientRect();
        return { inGrowth: !!summary, inHeading: !!button.closest('.pet-home-heading'),
          fits: !!area && box.left >= area.left && box.right <= area.right && box.top >= area.top && box.bottom <= area.bottom,
          width: box.width, height: box.height, primary: button.classList.contains('primary') };
      });
      assert.ok(entry.inGrowth && !entry.primary && entry.fits && entry.width >= 47.9 && entry.height >= 47.9,
        'the secondary gallery entry fits the actual growth summary with a 48px target: ' + JSON.stringify(entry));
      assert.equal(await page.$('.pet-home-card .pet-rotation-tools, .pet-home-card .pet-drag-hint, .pet-home-card ' +
        B.action('farm-pet-rotate') + ', .pet-home-card ' + B.action('farm-pet-reset')), null);
      report.checks.push({ name: 'home-' + count + '-behaviors', cards, galleryEntry: entry, homeLayout });
      await shot(page, 'home-' + count);
      if (count === 2 && CASE === 'home') {
        await B.click(page, B.action('choose-point'));
        await page.waitForSelector('#editor-form');
        await panel(page, 'editor');
        const fields = await page.$$eval('#editor-form .field input:not([type="checkbox"]), #editor-form .field select', nodes => nodes.map(el => {
          const r = el.getBoundingClientRect(), wrapper = el.closest('.field');
          return { name: el.name, height: r.height, wrapperBorder: getComputedStyle(wrapper).borderTopWidth };
        }));
        for (const field of fields) {
          assert.ok(field.height >= 44 && field.height <= 56, 'field height: ' + JSON.stringify(field));
          assert.equal(field.wrapperBorder, '0px', 'nested input border');
        }
        report.checks.push({ name: 'compact-fields', fields });
        await shot(page, 'editor');
        await B.fillForm(page, { reason: '布局验证：主动完成了今天的阅读' });
        await B.click(page, B.SELECTORS.submit, { scroll: false });
        await page.waitForSelector('.points-confirm-dialog');
        await panel(page, 'points-confirm');
        await B.reachable(page, B.action('points-confirm'));
        await shot(page, 'points-confirm');
        await B.confirmPoints(page);
        await page.waitForSelector(B.SELECTORS.answer);
        await panel(page, 'parent-pin');
        await B.reachable(page, B.SELECTORS.answer);
        await B.reachable(page, B.SELECTORS.verify);
        assert.equal(await page.$eval(B.SELECTORS.answer, el => el === document.activeElement), true, 'PIN field receives focus');
        await shot(page, 'parent-pin');
        await B.click(page, B.action('parent-cancel'));
        assert.equal(env.requests.some(request => request.path === '/api/action'), false, 'layout checks must not write business data');
        assert.deepEqual(await B.state(page), state);
      }
      assert.deepEqual(env.errors, []);
      await env.close(); env = null;
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = error.stack; process.exitCode = 1;
    if (page && !page.isClosed()) await shot(page, 'failure').catch(() => {});
  } finally {
    persist(); if (env) await env.close(); if (browser) await browser.close();
  }
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
