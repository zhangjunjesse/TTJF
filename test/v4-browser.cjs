'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');
const B = require('./browser.cjs');
const { ROOT, ARTIFACTS, PIN, FIXTURE_TIME, VIEWPORTS, SELECTORS, Model,
  action, click, fill, fillForm, state, ui, totals, connected, navigate,
  closeSheet, noSheet, verify, submitProtected, openCredit, reachable, bounded, delay } = B;
const { createAssistantService } = require('../assistant-service.cjs');
const snap = (page, name) => B.capture(page, name, 'v4');
const PUBLIC_BOUNDARY = 'Real Edge rendered DOM and hit-tested pointer coordinates; no physical iPad/Safari, software keyboard, microphone, audible playback, wake word or long-running-device evidence.';
const METADATA = 'V4_QA_ORIGINAL_METADATA_MUST_NOT_BE_SENT';
const output = path.join(ARTIFACTS, 'v4-browser-results.json');

async function form(page, expected) {
  await page.waitForFunction(name => window.FamilyDemo.getUI().form === name, {}, expected);
}
async function aiFill(page, context, text) {
  await fill(page, '[name="aiText"]', text);
  const remote = await page.evaluate(() => location.protocol !== 'file:' && window.__FAMILY_OFFLINE__ !== true);
  const response = remote ? page.waitForResponse(value => value.url().endsWith('/api/assistant') && value.request().method() === 'POST') : null;
  await click(page, action('ai-fill', context));
  if (response) { await response; }
  await page.waitForFunction(() => window.FamilyDemo.getUI().aiBusy === false);
}
async function pointsValue(page, value) {
  await page.waitForFunction(expected => Number(document.querySelector('[name="points"]')?.value) === expected, {}, value);
}
async function openRewards(page) {
  await click(page, action('jump-rewards'));
  await form(page, 'rewards');
}
async function growth(page) {
  return page.evaluate(() => window.FamilyModel.growth(window.FamilyDemo.getState()));
}
async function upload(page, filename) {
  const chooser = page.waitForFileChooser();
  await click(page, action('avatar-choose'));
  await (await chooser).accept([filename]);
}
async function avatarInfo(page, dataUrl) {
  return page.evaluate(source => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      resolve({ width: image.naturalWidth, height: image.naturalHeight,
        first: Array.from(context.getImageData(8, 8, 1, 1).data),
        last: Array.from(context.getImageData(image.naturalWidth - 9, image.naturalHeight - 9, 1, 1).data) });
    };
    image.onerror = reject; image.src = source;
  }), dataUrl);
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) { crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, content) {
  const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(content.length); crc.writeUInt32BE(crc32(Buffer.concat([name, content])));
  return Buffer.concat([length, name, content, crc]);
}
function pngFixture(width, height, extraBytes = 0) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const cropStart = (width - Math.min(width, height)) / 2;
  const leftColor = [220, 30, 40], rightColor = [30, 210, 50], centerColor = [35, 90, 220];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      const rgb = x < cropStart ? leftColor : x >= width - cropStart ? rightColor : centerColor;
      raw[offset] = rgb[0]; raw[offset + 1] = rgb[1]; raw[offset + 2] = rgb[2];
    }
  }
  const metadata = Buffer.concat([Buffer.from('Comment\0' + METADATA), Buffer.alloc(extraBytes, 65)]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('tEXt', metadata), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
function fixtures() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const files = {
    valid: path.join(ARTIFACTS, 'v4-avatar-source.png'),
    svg: path.join(ARTIFACTS, 'v4-avatar-rejected.svg'),
    large: path.join(ARTIFACTS, 'v4-avatar-over-8mib.png'),
    pixels: path.join(ARTIFACTS, 'v4-avatar-over-16mp.png')
  };
  fs.writeFileSync(files.valid, pngFixture(600, 400));
  fs.writeFileSync(files.svg, '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/></svg>');
  fs.writeFileSync(files.large, pngFixture(600, 400, 8 * 1024 * 1024));
  fs.writeFileSync(files.pixels, pngFixture(4001, 4001));
  return files;
}
function seeded(xp, kind = 'plant') {
  const value = Model.createSeed(new Date(FIXTURE_TIME));
  value.points = xp ? [{ id: 'fixture-earned', name: '成长阶段测试', points: xp, reason: '测试夹具中的累计积分', at: new Date(FIXTURE_TIME).toISOString() }] : [];
  value.redemptions = []; value.requests = []; value.appliedActions = [];
  value.pet = { kind, name: kind === 'plant' ? '芽芽' : '团团' };
  return value;
}
async function mockProvider() {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) { chunks.push(chunk); }
    calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: 'action', action: {
      type: 'points.add', payload: { name: '整理书包', points: 5, reason: '自己收好了书包' }
    } }) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, service: createAssistantService({ apiKey: 'qa-local-provider-only', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'qa-fixture' }),
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

async function runSuite() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const selected = process.env.V4_GROUPS ? process.env.V4_GROUPS.split(',').map(value => value.trim()).filter(Boolean) : null;
  const hash = name => fs.existsSync(path.join(ROOT, name)) ? crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, name))).digest('hex') : null;
  const report = { version: '0.4', browser: 'Microsoft Edge / Chromium, real DOM and hit-tested mouse',
    deviceBoundary: PUBLIC_BOUNDARY, assistantBoundary: 'Local instruction demonstration; a separately labelled loopback mock provider verifies outbound privacy. Neither is a real external LLM run.',
    fixtureBoundary: 'Fixed/accelerated clock; synthetic avatar with tagged metadata; isolated real HTTP servers and real model state. Stage gallery uses controlled starting ledgers, never claims user-earned points.',
    startedAt: new Date().toISOString(), requested: selected || 'all',
    sourceHashes: Object.fromEntries(['app.js', 'model.js', 'server.cjs', 'assistant.js', 'assistant-service.cjs', 'styles.css', 'pet.js', 'pet.css', 'index.html'].map(name => [name, hash(name)])),
    exportHash: hash('export/little-steps-demo.html'), checks: [], failed: [], errors: [], layouts: [], skipped: [] };
  const browser = await B.launch();
  let groupName = '', current;
  async function check(label, run) {
    try { await run(); report.checks.push({ group: groupName, label }); console.log('PASS ' + groupName + ': ' + label); }
    catch (error) { error.check = label; throw error; }
  }
  async function group(name, run, options = {}) {
    if (selected && !selected.includes(name)) { return; }
    groupName = name;
    const env = await B.createEnvironment(browser, { ...options,
      assistantService: options.assistantService || createAssistantService({ apiKey: '' }) });
    try {
      current = await env.newPage(); await env.load(current);
      await run(env, current, check);
      assert.deepEqual(env.errors, [], 'No uncaught page script errors');
    } catch (error) {
      report.failed.push({ group: name, check: error.check || 'setup', message: error.message, stack: error.stack });
      console.error('FAIL ' + name + ': ' + error.message);
      if (current && !current.isClosed()) { await snap(current, name + '-failure').catch(() => {}); }
    } finally { report.errors.push(...env.errors.map(message => ({ group: name, message }))); await env.close(); current = null; }
  }
  try {
    await group('layout', async (env, page, check) => {
      for (const [name, width, height] of VIEWPORTS) {
        await page.setViewport({ width, height });
        // Chromium resolves setViewport before the app's visualViewport resize event.
        // Wait for the actual new layout, so an old coordinate is never clicked.
        await page.waitForFunction(() => Math.abs(document.querySelector('.bottom-nav').getBoundingClientRect().bottom - innerHeight) <= 1, { timeout: 3000 });
        await check(name + ': two fixed tabs, prominent points/companion, reachable lower-frequency redemption, no horizontal overflow', async () => {
          await navigate(page, 'points');
          assert.equal(await page.$$('.bottom-nav [data-action="nav"]').then(items => items.length), 2);
          assert.ok(await page.$('.growth-home .credit-card')); assert.ok(await page.$('.growth-home .companion-card svg'));
          assert.equal(await page.$('#main .rewards-grid'), null, 'Full gift catalog must not dominate the points home');
          await bounded(page); await reachable(page, SELECTORS.nav);
          const layoutData = { name, width, height };
          await page.$eval('#main', element => { element.scrollTop = 0; });
          if (name === 'ipad-landscape') {
            await reachable(page, action('add-points'));
            await reachable(page, action('choose-point'));
            await reachable(page, action('pet-interact'));
            await reachable(page, '.growth-progress p');
            layoutData.critical = await page.evaluate(() => {
              const navTop = document.querySelector('.bottom-nav').getBoundingClientRect().top;
              const bounds = selector => Array.from(document.querySelectorAll(selector)).map(element => {
                const box = element.getBoundingClientRect(); return { text: element.textContent.trim(), top: box.top, bottom: box.bottom };
              });
              return { navTop, behaviors: bounds('button[data-action="choose-point"]'), interactions: bounds('button[data-action="pet-interact"]'), growth: bounds('.growth-progress p') };
            });
            assert.equal(layoutData.critical.behaviors.length, 4);
            assert.equal(layoutData.critical.interactions.length, 3);
            for (const box of [...layoutData.critical.behaviors, ...layoutData.critical.interactions, ...layoutData.critical.growth]) {
              assert.ok(box.bottom <= layoutData.critical.navTop, 'iPad initial-screen control/content hidden by navigation: ' + JSON.stringify(box));
            }
          }
          if (width <= 390) {
            layoutData.mobile = await page.evaluate(() => {
              const behaviors = document.querySelector('.frequent-behaviors').getBoundingClientRect();
              const card = document.querySelector('.companion-card').getBoundingClientRect();
              const scene = document.querySelector('.companion-scene').getBoundingClientRect();
              return { behaviorsTop: behaviors.top, companionTop: card.top, cardWidth: card.width, sceneWidth: scene.width, sceneHeight: scene.height };
            });
            assert.ok(layoutData.mobile.behaviorsTop < layoutData.mobile.companionTop, 'Frequent award behaviors come before the companion on a phone');
            assert.ok(layoutData.mobile.sceneWidth >= layoutData.mobile.cardWidth * 0.8, 'Phone companion scene uses the full card width');
            assert.ok(layoutData.mobile.sceneHeight >= 180);
          }
          await click(page, action('add-points')); await reachable(page, SELECTORS.close); await reachable(page, SELECTORS.submit);
          await closeSheet(page); await noSheet(page);
          await snap(page, name + '-points');
          await openRewards(page); await click(page, action('redeem', 'reward-pencil'));
          assert.equal((await ui(page)).form, 'request');
          await reachable(page, SELECTORS.close); await reachable(page, SELECTORS.submit);
          await closeSheet(page); await form(page, 'rewards'); await closeSheet(page); await noSheet(page);
          await navigate(page, 'reminders'); await bounded(page); await reachable(page, SELECTORS.nav);
          await click(page, action('task-new')); await reachable(page, SELECTORS.close); await reachable(page, SELECTORS.submit);
          await closeSheet(page); await noSheet(page); await snap(page, name + '-reminders');
          report.layouts.push({ ...layoutData, horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth) });
        });
        await check(name + ': profile, companion settings and contextual AI remain usable within the sheet', async () => {
          await navigate(page, 'points');
          await click(page, action('profile-edit')); await reachable(page, SELECTORS.close); await reachable(page, SELECTORS.submit);
          const chooser = page.waitForFileChooser();
          await click(page, action('avatar-choose')); await (await chooser).cancel();
          await closeSheet(page); await noSheet(page);
          await click(page, action('pet-config')); await reachable(page, SELECTORS.close); await reachable(page, SELECTORS.submit);
          await closeSheet(page); await noSheet(page);
          await click(page, action('add-points')); await click(page, action('ai-fill', 'points'));
          await reachable(page, SELECTORS.close); await reachable(page, SELECTORS.submit);
          await closeSheet(page); await noSheet(page);
        });
      }
    });

    await group('points-ai', async (env, page, check) => {
      await check('Contextual AI fills the same editable points form without committing; every actual award is verified', async () => {
        const before = await totals(page);
        await click(page, action('add-points'));
        await aiFill(page, 'points', '自己收好了书包，加5分');
        await pointsValue(page, 5);
        await page.waitForFunction(() => document.querySelector('[name="reason"]').value.includes('书包'));
        assert.equal((await ui(page)).form, 'points'); assert.deepEqual(await totals(page), before);
        const request = env.requests.filter(item => item.path === '/api/assistant').at(-1);
        assert.equal(request.body.context, 'points');
        assert.equal(env.requests.filter(item => item.path === '/api/action').length, 0);
        await fillForm(page, { reason: '家长核对：今天确实自己收好了书包' });
        await snap(page, 'context-points-draft');
        await click(page, SELECTORS.submit, { scroll: false }); await verify(page, '000000');
        assert.deepEqual(await totals(page), before);
        await verify(page); await noSheet(page);
        assert.equal((await totals(page)).earned, before.earned + 5);
        await openCredit(page, { points: 2, reason: '下一次独立记录仍需核验' });
        await click(page, SELECTORS.submit, { scroll: false });
        assert.equal((await totals(page)).earned, before.earned + 5);
        await verify(page); await noSheet(page);
        assert.equal((await totals(page)).earned, before.earned + 7);
      });
    });

    await group('template-ai', async (env, page, check) => {
      let item;
      await check('Template-management AI creates a reviewable verified template, never an accidental award', async () => {
        const before = await totals(page), ledger = (await state(page)).points;
        await click(page, action('point-list'));
        await aiFill(page, 'pointItems', '新增常用项：整理书包，3分，预设原因：今天自己收好了书包');
        await form(page, 'pointItem'); await pointsValue(page, 3);
        assert.equal((await state(page)).pointItems.some(value => value.name === '整理书包'), false);
        await click(page, SELECTORS.submit, { scroll: false });
        assert.deepEqual(await totals(page), before);
        await verify(page); await form(page, 'point-list');
        const restored = await page.evaluate(() => ({ busy: window.FamilyDemo.getUI().aiBusy,
          disabled: document.querySelector('button[data-action="ai-fill"]').disabled,
          text: document.querySelector('[name="aiText"]').value,
          status: document.querySelector('#context-ai-status').textContent }));
        assert.equal(restored.busy, false); assert.equal(restored.disabled, false);
        assert.doesNotMatch(restored.status, /正在整理/, 'Returned management screen must not show a stale pending state: ' + JSON.stringify(restored));
        assert.equal(restored.text, '', 'A successfully saved template clears the consumed description');
        assert.match(restored.status, /已保存|已更新/);
        item = (await state(page)).pointItems.find(value => value.name === '整理书包'); assert.ok(item);
        assert.equal(item.points, 3); assert.match(item.reason, /书包/);
        assert.deepEqual((await state(page)).points, ledger); assert.deepEqual(await totals(page), before);
        assert.ok(env.requests.filter(value => value.path === '/api/assistant').every(value => value.body.context === 'pointItems'));
      });
      await check('Cancel keeps the description without a stale busy message and another management request remains usable', async () => {
        const description = '把整理书包改为4分', before = await totals(page);
        await aiFill(page, 'pointItems', description); await form(page, 'pointItem'); await pointsValue(page, 4);
        await closeSheet(page); await form(page, 'point-list');
        assert.equal((await ui(page)).aiBusy, false);
        assert.equal(await page.$eval('button[data-action="ai-fill"]', element => element.disabled), false);
        assert.equal(await page.$eval('[name="aiText"]', element => element.value), description);
        assert.doesNotMatch(await page.$eval('#context-ai-status', element => element.textContent), /正在整理/);
        assert.equal((await state(page)).pointItems.find(value => value.id === item.id).points, 3);
        await snap(page, 'context-template-cancel');
        await aiFill(page, 'pointItems', '把整理书包改为6分'); await form(page, 'pointItem'); await pointsValue(page, 6);
        await closeSheet(page); await form(page, 'point-list');
        assert.deepEqual(await totals(page), before);
        assert.equal((await state(page)).pointItems.find(value => value.id === item.id).points, 3);
      });
      await check('Editing name, points, preset reason, disabling and enabling stays in template management with a fresh verification each time', async () => {
        const before = await totals(page), ledger = (await state(page)).points;
        for (const operation of [
          { text: '把整理书包改为9分', expect: value => value.points === 9 },
          { text: '把整理书包的预设原因改为自己把第二天的课本和文具放好了', expect: value => /课本/.test(value.reason) },
          { text: '把整理书包改名为自己收拾书包', expect: value => value.name === '自己收拾书包' },
          { text: '停用自己收拾书包', expect: value => value.enabled === false },
          { text: '启用自己收拾书包', expect: value => value.enabled === true }
        ]) {
          const saved = (await state(page)).pointItems.find(value => value.id === item.id);
          await click(page, action('point-item-edit', item.id));
          await aiFill(page, 'pointItems', operation.text);
          await page.waitForFunction(() => document.querySelector('[name="aiText"]') && !document.querySelector('button[data-action="ai-fill"]').disabled);
          await delay(250);
          assert.deepEqual((await state(page)).pointItems.find(value => value.id === item.id), saved);
          await click(page, SELECTORS.submit, { scroll: false }); await verify(page); await form(page, 'point-list');
          assert.ok(operation.expect((await state(page)).pointItems.find(value => value.id === item.id)), operation.text);
          assert.deepEqual(await totals(page), before); assert.deepEqual((await state(page)).points, ledger);
        }
        await snap(page, 'context-template-management');
      });
    });

    await group('ai-races', async (env, page, check) => {
      let held;
      await page.setRequestInterception(true);
      page.on('request', request => {
        if (request.url().endsWith('/api/assistant')) { held = request; }
        else { request.continue(); }
      });
      await check('Typing manually during contextual AI processing is preserved when the late result arrives', async () => {
        await openCredit(page);
        await fill(page, '[name="aiText"]', '自己收好了书包，加5分');
        await click(page, action('ai-fill', 'points'));
        assert.ok(held, 'The real outgoing assistant request is deliberately held');
        await fillForm(page, { points: 7, reason: 'AI等待时家长新补充的事实，不能被覆盖' });
        await reachable(page, SELECTORS.submit);
        const response = page.waitForResponse(value => value.url().endsWith('/api/assistant'));
        await held.continue(); await response; await delay(200);
        assert.equal(await page.$eval('[name="reason"]', element => element.value), 'AI等待时家长新补充的事实，不能被覆盖');
        assert.equal(Number(await page.$eval('[name="points"]', element => element.value)), 7);
        assert.equal((await totals(page)).earned, 128);
        await snap(page, 'context-late-manual-edit');
      });
      await check('Closing an in-flight AI draft and opening profile cannot let the late response overwrite the new scene', async () => {
        held = null;
        await fill(page, '[name="aiText"]', '把今天的书包整理好了，加6分');
        await click(page, action('ai-fill', 'points')); assert.ok(held);
        await closeSheet(page); await noSheet(page);
        await click(page, action('profile-edit'));
        await fillForm(page, { childName: '要保留的新资料草稿' });
        await held.continue().catch(error => {
          if (!/Invalid InterceptionId|already handled|Target closed/i.test(error.message)) { throw error; }
        });
        await delay(450);
        assert.equal((await ui(page)).form, 'profile');
        assert.equal(await page.$eval('[name="childName"]', element => element.value), '要保留的新资料草稿');
        assert.equal((await state(page)).childName, '小禾');
        assert.equal(env.requests.filter(value => value.path === '/api/action').length, 0);
        await snap(page, 'context-cancel-new-scene');
      });
      await check('Assistant request failure preserves manual input and a normal verified save remains usable', async () => {
        await closeSheet(page); await noSheet(page);
        await openCredit(page, { reason: '网络失败后仍然保留这次实际原因' });
        held = null;
        await fill(page, '[name="aiText"]', '自己收好了书包，加5分');
        await click(page, action('ai-fill', 'points')); assert.ok(held);
        await held.abort('failed'); await delay(200);
        assert.equal(await page.$eval('[name="reason"]', element => element.value), '网络失败后仍然保留这次实际原因');
        await click(page, SELECTORS.submit, { scroll: false }); await verify(page); await noSheet(page);
        assert.equal((await totals(page)).earned, 133);
      });
    });

    await group('companions', async (env, page, check) => {
      const before = await totals(page);
      await check('Both companions have three visibly distinct free interactions and public switching preserves growth', async () => {
        for (const kind of ['plant', 'capybara']) {
          if (kind === 'capybara') {
            await click(page, action('pet-config'));
            await click(page, action('pet-kind', kind)); await fillForm(page, { petName: '团团' });
            await click(page, SELECTORS.submit, { scroll: false }); await noSheet(page);
            assert.equal((await state(page)).pet.kind, kind);
          }
          await page.waitForSelector('.companion-card svg[data-pet-kind="' + kind + '"]');
          const reactions = kind === 'plant' ? ['pet', 'water', 'sun'] : ['pet', 'feed', 'play'];
          const actionsBefore = env.requests.filter(value => value.path === '/api/action').length;
          const markup = [];
          for (const reaction of reactions) {
            await click(page, action('pet-interact', reaction));
            const selector = '.companion-card svg[data-pet-reaction="' + reaction + '"]';
            await page.waitForSelector(selector);
            markup.push(await page.$eval(selector, element => element.innerHTML));
            assert.deepEqual(await totals(page), before); assert.equal((await growth(page)).xp, 128);
            await snap(page, 'companion-' + kind + '-reaction-' + reaction);
          }
          assert.equal(new Set(markup).size, 3, 'All three reactions must have distinct visible SVG content');
          await click(page, action('pet-touch'));
          await page.waitForSelector('.companion-card svg[data-pet-reaction="pet"]');
          assert.equal(env.requests.filter(value => value.path === '/api/action').length, actionsBefore, 'Companion interactions must not send ledger or other mutations');
          await snap(page, 'companion-' + kind + '-phone');
        }
        assert.equal(env.requests.filter(value => value.path === '/api/parent/challenge').length, 0);
        await page.reload({ waitUntil: 'load' }); await connected(page);
        assert.equal((await state(page)).pet.kind, 'capybara'); assert.equal((await growth(page)).stage, 3);
      });
      await check('Reduced-motion rendering still provides a clear static interaction and no sustained animation', async () => {
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
        await page.reload({ waitUntil: 'load' }); await connected(page);
        await click(page, action('pet-interact', 'feed'));
        const selector = '.companion-card svg.pet-scene';
        assert.equal(await page.$eval(selector, element => element.getAttribute('data-pet-reduced-motion')), 'true');
        assert.equal(await page.$eval(selector, element => element.getAttribute('data-pet-reaction')), 'feed');
        const continuous = await page.$$eval('.companion-card svg *', elements => elements.filter(element => {
          const style = getComputedStyle(element);
          return style.animationName !== 'none' && style.animationDuration.split(',').some(value => parseFloat(value) > 0.05);
        }).length);
        assert.equal(continuous, 0); assert.deepEqual(await totals(page), before);
        await snap(page, 'companion-reduced-motion');
      });
    });

    for (const kind of ['plant', 'capybara']) {
      for (const [index, xp] of [0, 30, 100, 250, 500].entries()) {
        await group('gallery', async (env, page, check) => {
          await check(kind + ' stage ' + (index + 1) + ': real home renders the stage derived from its starting ledger', async () => {
            await page.setViewport({ width: 1024, height: 768 });
            const stage = index + 1;
            await page.waitForSelector('.companion-card svg[data-pet-kind="' + kind + '"][data-pet-stage="' + stage + '"]');
            const value = await growth(page); assert.equal(value.stage, stage); assert.equal(value.xp, xp);
            assert.ok((await page.$eval('.companion-card', element => element.textContent)).includes(value.stageName));
            await page.$eval('.companion-card', element => element.scrollIntoView({ block: 'center' }));
            await snap(page, 'companion-' + kind + '-stage' + stage);
          });
        }, { state: seeded(xp, kind) });
      }
    }

    await group('growth-redemption', async (env, page, check) => {
      await check('Verified awards cross all visual thresholds, then stars continue; spending from the secondary panel never reduces growth', async () => {
        assert.equal((await growth(page)).stage, 1);
        for (const [xp, stage, level] of [[30, 2, 2], [100, 3, 3], [250, 4, 4], [500, 5, 5], [750, 5, 6]]) {
          const before = await totals(page);
          await openCredit(page, { points: xp - before.earned, reason: '核对本次积分，让累计成长达到' + xp });
          await click(page, SELECTORS.submit, { scroll: false });
          assert.equal((await growth(page)).xp, before.earned);
          await verify(page); await noSheet(page);
          const value = await growth(page);
          assert.equal(value.xp, xp); assert.equal(value.stage, stage); assert.equal(value.level, level);
          await page.waitForSelector('.companion-card svg[data-pet-stage="' + stage + '"]');
          const text = await page.$eval('.companion-card', element => element.textContent);
          assert.ok(text.includes(value.stageName)); assert.ok(text.includes(String(value.remaining)));
        }
        assert.equal((await growth(page)).stars, 1);
        const before = await totals(page), grown = await growth(page);
        await openRewards(page); await click(page, action('redeem', 'reward-pencil'));
        await click(page, SELECTORS.submit, { scroll: false }); await form(page, 'rewards');
        const request = (await state(page)).requests.find(value => value.status === 'pending'); assert.ok(request);
        assert.deepEqual(await totals(page), before);
        await click(page, '.sheet ' + action('redemption-approve', request.id));
        await click(page, SELECTORS.submit, { scroll: false }); await verify(page); await form(page, 'rewards');
        assert.equal((await totals(page)).available, before.available - 12);
        assert.equal((await totals(page)).earned, before.earned); assert.deepEqual(await growth(page), grown);
        await closeSheet(page); await noSheet(page); await snap(page, 'growth-after-redemption');
        await click(page, action('pet-growth')); await snap(page, 'growth-explained');
      });
    }, { state: seeded(29) });

    if (!selected || selected.includes('profile')) {
      const files = fixtures(), provider = await mockProvider();
      try {
        await group('profile', async (env, page, check) => {
          let avatar;
          await check('A real file chooser locally crops the tagged photo; cancel writes nothing and profile save requires PIN', async () => {
            const before = await totals(page), original = fs.readFileSync(files.valid);
            await click(page, action('profile-edit'));
            await upload(page, files.valid);
            await page.waitForSelector('.sheet img.profile-avatar-image');
            avatar = await page.$eval('.sheet img.profile-avatar-image', element => element.src);
            assert.match(avatar, /^data:image\/jpeg;base64,/); assert.ok(avatar.length <= 160000);
            const info = await avatarInfo(page, avatar);
            assert.equal(info.width, 192); assert.equal(info.height, 192);
            for (const pixel of [info.first, info.last]) {
              assert.ok(pixel[2] > 180 && pixel[0] < 80 && pixel[1] < 130, 'Center crop must exclude the red/green side stripes');
            }
            assert.equal(Buffer.from(avatar.split(',')[1], 'base64').includes(Buffer.from(METADATA)), false);
            assert.notEqual(avatar.split(',')[1], original.toString('base64'));
            assert.equal((await state(page)).childAvatar, '');
            assert.equal(env.requests.filter(item => item.path === '/api/action').length, 0);
            await snap(page, 'avatar-local-preview');
            await closeSheet(page); await noSheet(page);
            assert.equal((await state(page)).childAvatar, '');
            await click(page, action('profile-edit'));
            // The product may retain the unsaved draft; if not, choose it again.
            if (!(await page.$('.sheet img.profile-avatar-image'))) { await upload(page, files.valid); await page.waitForSelector('.sheet img.profile-avatar-image'); }
            await fillForm(page, { childName: '小芽' });
            await click(page, SELECTORS.submit, { scroll: false });
            assert.equal((await state(page)).childAvatar, ''); assert.equal((await state(page)).childName, '小禾');
            await verify(page, '000000'); assert.equal((await state(page)).childAvatar, '');
            await verify(page); await noSheet(page);
            const saved = await state(page); avatar = saved.childAvatar;
            assert.equal(saved.childName, '小芽'); assert.match(avatar, /^data:image\/jpeg;base64,/);
            assert.deepEqual(await totals(page), before);
            await page.reload({ waitUntil: 'load' }); await connected(page);
            assert.equal((await state(page)).childAvatar, avatar); assert.equal((await state(page)).childName, '小芽');
            assert.ok(await page.$('img.profile-avatar-image'));
            const writes = env.requests.filter(value => value.path === '/api/action' || value.path === '/api/parent/challenge');
            assert.ok(writes.length); assert.ok(writes.every(value => !JSON.stringify(value.body).includes(original.toString('base64'))));
            await snap(page, 'avatar-persisted-home');
          });
          await check('SVG, over-8MiB files and over-16MP photos are rejected without replacing the saved avatar', async () => {
            await click(page, action('profile-edit'));
            for (const [filename, pattern] of [[files.svg, '格式|JPEG|PNG|WebP|支持'], [files.large, '8|大小|体积'], [files.pixels, '像素|16']]) {
              await upload(page, filename);
              await page.waitForFunction(source => new RegExp(source).test(document.querySelector('#avatar-status').textContent), {}, pattern);
              assert.equal((await state(page)).childAvatar, avatar);
              assert.equal(await page.$eval('.sheet img.profile-avatar-image', element => element.src), avatar);
            }
            await snap(page, 'avatar-rejected-input');
            await closeSheet(page); await noSheet(page);
          });
          await check('The real assistant HTTP path sends no photo or original metadata to a loopback mock model; removing an avatar is also verified', async () => {
            await click(page, action('add-points'));
            await aiFill(page, 'points', '自己收好了书包，加5分'); await pointsValue(page, 5);
            assert.equal(provider.calls.length, 1);
            const outgoing = JSON.stringify(provider.calls[0]);
            assert.equal(outgoing.includes('childAvatar'), false); assert.equal(outgoing.includes('data:image/'), false);
            assert.equal(outgoing.includes(METADATA), false); assert.equal(outgoing.includes(avatar), false);
            assert.equal(outgoing.includes(PIN), false);
            const browserRequest = env.requests.filter(value => value.path === '/api/assistant').at(-1);
            assert.equal(JSON.stringify(browserRequest.body).includes('data:image/'), false);
            assert.equal((await totals(page)).earned, 128, 'An AI candidate after photo saving must still be only a draft');
            await closeSheet(page); await noSheet(page);
            await click(page, action('profile-edit')); await click(page, action('avatar-remove'));
            assert.equal((await state(page)).childAvatar, avatar);
            await click(page, SELECTORS.submit, { scroll: false }); await verify(page); await noSheet(page);
            assert.equal((await state(page)).childAvatar, ''); assert.equal((await state(page)).childName, '小芽');
          });
        }, { assistantService: provider.service });
      } finally { await provider.close(); }
    }

    if (process.env.V4_OFFLINE === '1' || selected && selected.some(name => name === 'offline' || name === 'offline-hosted')) {
      await group('offline', async (env, page, check) => {
        await check('Final single-file export exactly embeds the current app, model, assistant, pet renderer and both stylesheets', async () => {
          const html = fs.readFileSync(path.join(ROOT, 'export', 'little-steps-demo.html'), 'utf8').replace(/\r\n/g, '\n');
          for (const name of ['model.js', 'assistant.js', 'pet.js', 'app.js']) {
            const source = fs.readFileSync(path.join(ROOT, name), 'utf8').replace(/\r\n/g, '\n').replace(/<\/script/g, '<\\/script');
            assert.ok(html.includes('<script>' + source + '</script>'), name + ' differs from the exported executable');
          }
          for (const name of ['styles.css', 'pet.css']) { assert.ok(html.includes(fs.readFileSync(path.join(ROOT, name), 'utf8').replace(/\r\n/g, '\n')), name + ' missing'); }
          assert.match(html, /window\.__FAMILY_OFFLINE__\s*=\s*true/);
          assert.equal(/<script\s+src=|<link[^>]+rel="stylesheet"/.test(html), false);
        });
        await check('Offline file supports the real avatar chooser, local PIN setup, context filling and companion persistence without HTTP', async () => {
          const external = [], filename = path.join(ARTIFACTS, 'v4-avatar-source.png');
          fs.writeFileSync(filename, pngFixture(600, 400));
          await page.setRequestInterception(true);
          page.on('request', request => {
            if (/^https?:/.test(request.url())) { external.push(request.url()); request.abort(); }
            else { request.continue(); }
          });
          await page.goto(pathToFileURL(path.join(ROOT, 'export', 'little-steps-demo.html')).href, { waitUntil: 'load' });
          await page.waitForFunction(() => window.FamilyDemo && window.FamilyPet);
          assert.equal((await ui(page)).connected, false);
          await click(page, action('pet-interact', 'water'));
          await page.waitForSelector('.companion-card svg[data-pet-reaction="water"]');
          assert.equal((await growth(page)).xp, 128);
          await click(page, action('profile-edit')); await upload(page, filename);
          await page.waitForSelector('.sheet img.profile-avatar-image');
          await fillForm(page, { childName: '离线小芽' });
          await click(page, SELECTORS.submit, { scroll: false });
          await page.waitForSelector('#parent-form [name="setupPin"]');
          await fill(page, '#parent-form [name="setupPin"]', PIN); await fill(page, '#parent-form [name="setupConfirm"]', PIN);
          await click(page, SELECTORS.verify, { scroll: false }); await noSheet(page);
          await click(page, action('pet-config')); await click(page, action('pet-kind', 'capybara')); await fillForm(page, { petName: '离线团团' });
          await click(page, SELECTORS.submit, { scroll: false }); await noSheet(page);
          await click(page, action('add-points')); await aiFill(page, 'points', '自己收好了书包，加5分');
          await page.waitForFunction(() => document.querySelector('[name="reason"]').value.includes('书包'));
          assert.equal((await totals(page)).earned, 128);
          await click(page, SELECTORS.submit, { scroll: false }); await verify(page); await noSheet(page);
          await page.reload({ waitUntil: 'load' }); await page.waitForFunction(() => window.FamilyDemo && window.FamilyPet);
          const saved = await state(page); assert.equal(saved.childName, '离线小芽'); assert.equal(saved.pet.name, '离线团团'); assert.equal(saved.pet.kind, 'capybara');
          assert.equal((await avatarInfo(page, saved.childAvatar)).width, 192); assert.equal((await growth(page)).xp, 133);
          assert.deepEqual(external, []); await snap(page, 'offline-growth-avatar');
        });
      });
      await group('offline-hosted', async (env, page, check) => {
        await check('The v0.4 export remains local over a real HTTP host, with pet changes persisted and no API calls', async () => {
          const html = fs.readFileSync(path.join(ROOT, 'export', 'little-steps-demo.html')), extra = [];
          const server = http.createServer((request, response) => {
            if (request.url === '/offline.html') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); }
            else { if (request.url !== '/favicon.ico') { extra.push(request.url); } response.writeHead(404); response.end(); }
          });
          await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
          try {
            await page.goto('http://127.0.0.1:' + server.address().port + '/offline.html', { waitUntil: 'load' });
            await page.waitForFunction(() => window.FamilyDemo && window.FamilyPet);
            assert.equal(await page.evaluate(() => window.__FAMILY_OFFLINE__), true); assert.equal((await ui(page)).connected, false);
            await click(page, action('pet-config')); await click(page, action('pet-kind', 'capybara')); await fillForm(page, { petName: '本机团团' });
            await click(page, SELECTORS.submit, { scroll: false }); await noSheet(page);
            await page.reload({ waitUntil: 'load' }); await page.waitForFunction(() => window.FamilyDemo && window.FamilyPet);
            assert.equal((await state(page)).pet.name, '本机团团'); assert.equal((await growth(page)).xp, 128);
            await click(page, action('pet-interact', 'feed')); await page.waitForSelector('.companion-card svg[data-pet-reaction="feed"]');
            assert.deepEqual(extra, []); await snap(page, 'offline-http-companion');
          } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        });
      });
    } else { report.skipped.push('Final v0.4 offline package has not been selected for this run.'); }
  } finally {
    await browser.close();
    report.passed = report.checks.length; report.finishedAt = new Date().toISOString();
    const run = { requested: report.requested, startedAt: report.startedAt, finishedAt: report.finishedAt,
      sourceHashes: report.sourceHashes, exportHash: report.exportHash, passed: report.passed, failed: report.failed };
    let final = report;
    if (selected && fs.existsSync(output)) {
      const previous = JSON.parse(fs.readFileSync(output, 'utf8'));
      final = { ...previous, ...report,
        checks: previous.checks.filter(item => !selected.includes(item.group)).concat(report.checks),
        failed: previous.failed.filter(item => !selected.includes(item.group)).concat(report.failed),
        layouts: selected.includes('layout') ? report.layouts : previous.layouts,
        errors: (previous.errors || []).filter(item => !selected.includes(item.group)).concat(report.errors),
        runs: (previous.runs || []).concat(run), requested: 'cumulative targeted runs' };
      final.passed = final.checks.length;
    } else { final.runs = [run]; }
    fs.writeFileSync(output, JSON.stringify(final, null, 2));
  }
  console.log(report.passed + ' checks passed; ' + report.failed.length + ' failed.');
  process.exitCode = report.failed.length ? 1 : 0;
  return report;
}

if (require.main === module) { runSuite().catch(error => { console.error(error); process.exitCode = 1; }); }
module.exports = { runSuite, seeded, fixtures, pngFixture, avatarInfo, mockProvider };
