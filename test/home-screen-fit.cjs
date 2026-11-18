'use strict';

const assert = require('node:assert/strict');

const SCROLL_REGIONS = ['html', 'body', '.app-shell', '.app-main', '.interaction-home', '.pet-home-card', '.pet-preview-panel', '.home-behaviors'];

async function scrollState(page) {
  return page.evaluate(selectors => ({
    window: { x: scrollX, y: scrollY },
    regions: selectors.flatMap(selector => {
      const node = document.querySelector(selector);
      if (!node || !node.getClientRects().length) return [];
      return [{ selector, left: node.scrollLeft, top: node.scrollTop, width: node.clientWidth, height: node.clientHeight,
        scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight }];
    })
  }), SCROLL_REGIONS);
}

function unscrolled(state, label) {
  assert.ok(Math.abs(state.window.x) <= 1 && Math.abs(state.window.y) <= 1, label + ': document moved ' + JSON.stringify(state));
  for (const region of state.regions) assert.ok(Math.abs(region.left) <= 1 && Math.abs(region.top) <= 1,
    label + ': region moved ' + JSON.stringify(region));
}

async function noScroll(page, probe = false) {
  const before = await scrollState(page);
  unscrolled(before, 'single screen');
  for (const region of before.regions) assert.ok(region.scrollWidth <= region.width + 1 && region.scrollHeight <= region.height + 1,
    'single-screen contents must fit, including hidden overflow: ' + JSON.stringify(region));
  if (!probe) return { before };
  const attempted = await page.evaluate(selectors => {
    const moved = [];
    // overflow:hidden can still hide a second programmatic scroll container.
    // Probe it explicitly so a screenshot alone cannot pass this contract.
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (!node || !node.getClientRects().length) continue;
      const left = node.scrollLeft, top = node.scrollTop;
      node.scrollTo({ left: 100000, top: 100000, behavior: 'instant' });
      moved.push({ selector, left: node.scrollLeft, top: node.scrollTop });
      node.scrollTo({ left, top, behavior: 'instant' });
    }
    window.scrollTo({ left: 100000, top: 100000, behavior: 'instant' });
    moved.push({ selector: 'window', left: scrollX, top: scrollY });
    window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
    return moved;
  }, SCROLL_REGIONS);
  assert.ok(attempted.every(region => Math.abs(region.left) <= 1 && Math.abs(region.top) <= 1),
    'scroll attempts must not move a single-screen region: ' + JSON.stringify(attempted));
  const point = await page.$eval('.app-main', node => {
    const box = node.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  });
  await page.mouse.move(point.x, point.y);
  for (const direction of [1, -1]) {
    await page.mouse.wheel({ deltaX: direction * 250, deltaY: direction * 400 });
    await new Promise(resolve => setTimeout(resolve, 100));
    unscrolled(await scrollState(page), 'native wheel ' + direction);
  }
  return { before, attempted, after: await scrollState(page) };
}

async function screenFit(page, { preview = false, probe = false } = {}) {
  const measured = await page.evaluate(isPreview => {
    const visible = node => {
      if (!node) return false;
      const box = node.getBoundingClientRect(), style = getComputedStyle(node);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const rect = node => {
      const box = node.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    };
    const within = (box, area) => box.left >= area.left - 1 && box.top >= area.top - 1 && box.right <= area.right + 1 && box.bottom <= area.bottom + 1;
    const height = window.visualViewport?.height || innerHeight;
    const viewport = { left: 0, top: 0, right: innerWidth, bottom: height };
    const selectors = ['.app-header', '.app-main', '.interaction-home', '.pet-home-card', '.pet-home-heading', '.pet-growth-summary',
      '.pet-name', '.pet-level', '.pet-growth-numbers', '.growth-track', '.pet-home-stage', '.bottom-nav',
      isPreview ? '.pet-preview-panel' : '.pet-home-interactions'];
    const showDashboard = !isPreview || (innerWidth >= 700 && height > 620);
    if (showDashboard) selectors.push('.credit-card', '.credit-score', '.credit-actions', '.home-behaviors');
    if (isPreview) selectors.push('.pet-preview-description', '.pet-stage-choices', '.pet-look-choices');
    const regions = selectors.map(selector => {
      const node = document.querySelector(selector);
      if (!visible(node)) return { selector, visible: false };
      const box = rect(node), clippedBy = [];
      const container = node.closest('.pet-home-card') || node.closest('.credit-card') || node.closest('.interaction-home');
      const parentContainer = container === node ? node.parentElement.closest('.interaction-home') || node.parentElement.closest('.app-main') : container;
      if (parentContainer && !within(box, rect(parentContainer))) clippedBy.push('content outside ' + parentContainer.className);
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), area = rect(parent);
        const clipX = /^(hidden|clip|scroll|auto)$/.test(style.overflowX), clipY = /^(hidden|clip|scroll|auto)$/.test(style.overflowY);
        if ((clipX && (box.left < area.left - 1 || box.right > area.right + 1)) ||
            (clipY && (box.top < area.top - 1 || box.bottom > area.bottom + 1))) clippedBy.push(parent.className || parent.tagName);
      }
      return { selector, visible: true, ...box, inViewport: within(box, viewport), clippedBy };
    });
    const overlaps = [];
    const groups = [['.app-header', '.app-main', '.bottom-nav'], ['.credit-card', '.pet-home-card', '.home-behaviors'],
      ['.pet-home-heading', '.pet-growth-summary', '.pet-home-stage', '.pet-home-interactions', '.pet-preview-panel'],
      ['.pet-name', '.pet-level', '.pet-growth-numbers'], ['.pet-preview-heading', '.pet-stage-choices', '.pet-look-row']];
    for (const group of groups) for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const first = document.querySelector(group[i]), second = document.querySelector(group[j]);
      if (!visible(first) || !visible(second) || first.contains(second) || second.contains(first)) continue;
      const a = rect(first), b = rect(second);
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1)
        overlaps.push({ selectors: [group[i], group[j]], first: a, second: b });
    }
    const targets = [...document.querySelectorAll('.app-header button, .bottom-nav button, .interaction-home button')].filter(visible).map(node => {
      const box = rect(node), blocked = [];
      // Quarter points avoid rounded corners while detecting partial coverage.
      for (const [fx, fy] of [[.5, .5], [.25, .25], [.75, .25], [.25, .75], [.75, .75]]) {
        const hit = document.elementFromPoint(box.left + box.width * fx, box.top + box.height * fy);
        if (!hit || (hit !== node && !node.contains(hit))) blocked.push(hit && (hit.className.baseVal || hit.className || hit.tagName));
      }
      return { action: node.dataset.action, id: node.dataset.id, name: node.getAttribute('aria-label') || node.textContent.trim(),
        ...box, inViewport: within(box, viewport), blocked, disabled: node.disabled };
    });
    let portraitSpacing = null;
    if (!isPreview && document.querySelector('.interaction-home.home-portrait') && innerWidth < 700) {
      portraitSpacing = {};
      if (height >= 650) {
        const score = rect(document.querySelector('.credit-score')), actions = rect(document.querySelector('.credit-actions')),
          earned = rect(document.querySelector('.credit-value')), available = rect(document.querySelector('.credit-redeemable')),
          history = rect(document.querySelector('.credit-history-hint')), chest = rect(document.querySelector('.credit-scene-art')),
          add = rect(document.querySelector('[data-action="add-points"]')),
          redeem = rect(document.querySelector('[data-action="jump-rewards"]'));
        portraitSpacing.wallet = { score, actions, earned, available, history, add, redeem,
          amountGap: available.left - earned.right, historyGap: history.left - available.right,
          actionGap: redeem.left - add.right, rowGap: actions.top - score.bottom, chestGap: history.top - chest.bottom };
      }
      if (height >= 700) portraitSpacing.behaviors = {
        heading: rect(document.querySelector('.home-behavior-heading')),
        cards: rect(document.querySelector('.home-behavior-buttons'))
      };
    }
    return { preview: isPreview, viewport: { width: innerWidth, height }, showDashboard, regions, overlaps, targets, portraitSpacing };
  }, preview);
  for (const region of measured.regions) {
    assert.equal(region.visible, true, 'required screen region: ' + JSON.stringify(region));
    assert.ok(region.inViewport && !region.clippedBy.length, 'screen region is clipped: ' + JSON.stringify(region));
  }
  const { width, height } = measured.viewport;
  if (width >= 480 && width < 700 && width > height && height <= 620) {
    const stage = measured.regions.find(region => region.selector === '.pet-home-stage');
    assert.ok(stage.height >= 100, 'short landscape keeps a usable pet scene: ' + JSON.stringify(stage));
  }
  assert.deepEqual(measured.overlaps, [], 'independent screen regions must not cover one another');
  assert.ok(measured.targets.length, 'single-screen controls must exist');
  for (const target of measured.targets) {
    assert.ok(target.width >= 47.9 && target.height >= 47.9, '48px screen control: ' + JSON.stringify(target));
    assert.ok(target.inViewport && !target.blocked.length && !target.disabled, 'screen control must be directly reachable: ' + JSON.stringify(target));
  }
  const required = preview ? ['farm-pet-current', 'farm-pet-stage', 'farm-pet-look'] :
    ['farm-pet-preview', 'farm-pet-touch', 'farm-pet-play', 'farm-open', 'add-points', 'jump-rewards', 'records'];
  for (const action of [...required, 'nav', 'voice', 'preferences', 'profile-edit']) assert.ok(measured.targets.some(target => target.action === action),
    'missing reachable screen action: ' + action);
  if (measured.portraitSpacing?.wallet) {
    const wallet = measured.portraitSpacing.wallet;
    assert.ok(wallet.amountGap >= 6 && wallet.historyGap >= 6, 'wallet amounts and record label stay separate: ' + JSON.stringify(wallet));
    assert.ok(wallet.rowGap >= 6, 'wallet labels have space above the actions: ' + JSON.stringify(wallet));
    assert.ok(wallet.chestGap >= 2, 'the record link clears the chest: ' + JSON.stringify(wallet));
    assert.ok(Math.abs(wallet.add.top - wallet.redeem.top) <= 1 && wallet.actionGap >= 6,
      'phone wallet actions share a row with a visible gap: ' + JSON.stringify(wallet));
  }
  if (measured.portraitSpacing?.behaviors) {
    const behavior = measured.portraitSpacing.behaviors;
    assert.ok(behavior.heading.bottom <= behavior.cards.top + 1, 'phone behavior title stays above the cards: ' + JSON.stringify(behavior));
  }
  measured.scroll = await noScroll(page, probe);
  return measured;
}

module.exports = { screenFit, noScroll, scrollState, unscrolled };
