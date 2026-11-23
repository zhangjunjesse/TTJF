'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAssistantService } = require('../assistant-service.cjs');
const { executeTool } = require('../assistant-tools.cjs');
const Q = require('./saas-browser.cjs');
const { B, action, click } = Q;
const selector = name => '[data-assistant-action="' + name + '"]';
const entry = '[data-action="assistant-open"]';

function launcherProgress(stage) {
  Q.report.assistantLauncher = { ...Q.report.assistantLauncher, stage, updatedAt:new Date().toISOString() };
  fs.mkdirSync(Q.OUT, {recursive:true});
  fs.writeFileSync(path.join(Q.OUT, 'launcher-progress.json'), JSON.stringify({
    ...Q.report.assistantLauncher, checks:Q.report.checks, layouts:Q.report.layouts
  }, null, 2) + '\n');
}
async function launcherLayout(page, name) {
  const value = await page.evaluate(() => {
    const rendered = node => !!node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
    const nav = document.querySelector('.bottom-nav'), launcher = nav.querySelector('.assistant-launcher');
    const measure = node => {
      const r = node.getBoundingClientRect();
      const points = [[.5,.5],[.25,.5],[.75,.5],[.5,.25],[.5,.75]];
      return { rect:r.toJSON(), hit:points.every(([x,y]) => {
        const hit = document.elementFromPoint(r.left + r.width * x, r.top + r.height * y);
        return !!hit && (hit === node || node.contains(hit));
      }), disabled:node.disabled };
    };
    const controls = Array.from(nav.querySelectorAll('[data-action="nav"], .assistant-launcher')).map(node => ({
      id:node.classList.contains('assistant-launcher') ? 'assistant' : node.dataset.id, ...measure(node)
    }));
    const stage = document.querySelector('#world-stage');
    const splitScene = document.body.dataset.worldRoute === 'reminders' && matchMedia('(min-width:701px) and (orientation:landscape)').matches;
    const style = getComputedStyle(launcher), bounds = launcher.getBoundingClientRect();
    const radius = (value, size) => value.endsWith('%') ? parseFloat(value) * size / 100 : parseFloat(value);
    const corners = ['borderTopLeftRadius','borderTopRightRadius','borderBottomRightRadius','borderBottomLeftRadius'].map(key => {
      const values = style[key].split(' ');
      return [radius(values[0],bounds.width),radius(values[1] || values[0],bounds.height)];
    });
    const decoration = ['::before','::after'].map(pseudo => {
      const value = getComputedStyle(launcher,pseudo);
      return {pseudo, visible:value.content !== 'none' && value.content !== 'normal' && value.display !== 'none' && value.visibility !== 'hidden' && Number(value.opacity) > 0,
        pointerEvents:value.pointerEvents, background:value.backgroundImage};
    });
    return { viewport:{width:innerWidth,height:innerHeight}, nav:nav.getBoundingClientRect().toJSON(), controls,
      sceneBottom:splitScene && stage && rendered(stage) ? stage.getBoundingClientRect().bottom : null,
      entries:Array.from(document.querySelectorAll('[data-action="assistant-open"]')).filter(rendered).length,
      aria:launcher && { label:launcher.getAttribute('aria-label'), controls:launcher.getAttribute('aria-controls'), popup:launcher.getAttribute('aria-haspopup') },
      orb:{button:launcher.matches('button.assistant-orb') && launcher.type === 'button', text:launcher.innerText.trim(),
        children:Array.from(launcher.children).map(node => node.tagName), decoration, corners,
        background:style.backgroundImage, overflow:style.overflow, focusable:launcher.tabIndex === 0 && launcher.getAttribute('aria-hidden') !== 'true'},
      documentWidth:document.documentElement.scrollWidth };
  });
  Q.report.layouts.push({name,...value}); launcherProgress(name);
  assert.equal(value.entries, 1, name + ': one visible assistant entry');
  assert.deepEqual(value.controls.map(control => control.id), ['points','assistant','reminders'], name + ': navigation reading order');
  const launcher = value.controls[1].rect;
  assert.ok(Math.abs(launcher.width - launcher.height) <= .5 && launcher.width <= 56, name + ': the entry is a compact circle');
  assert.equal(value.orb.button, true, name + ': the sphere itself is the assistant button');
  assert.equal(value.orb.text, '', name + ': the sphere has no visible label');
  assert.deepEqual(value.orb.children, [], name + ': the sphere has no nested icon or ornament');
  assert.ok(value.orb.decoration.every(layer => layer.visible && layer.pointerEvents === 'none' && /radial-gradient\(/.test(layer.background)),
    name + ': the pearl colors and sheen are visible material layers without pointer targets');
  assert.equal(value.orb.overflow, 'hidden', name + ': material layers are clipped inside the sphere');
  assert.ok(value.orb.corners.every(([x,y]) => x >= launcher.width / 2 - .5 && y >= launcher.height / 2 - .5), name + ': all edges form a circle');
  assert.match(value.orb.background, /radial-gradient\(/, name + ': the sphere has light and shade');
  assert.equal(value.orb.focusable, true, name + ': the sphere is available to the keyboard and accessibility tree');
  assert.ok(Math.abs(launcher.left + launcher.width / 2 - value.viewport.width / 2) <= 1.5, name + ': assistant is horizontally centered');
  assert.ok(launcher.top >= value.nav.top - 1 && launcher.bottom <= value.nav.bottom + 1, name + ': assistant stays inside the bottom navigation');
  assert.ok(Math.abs(value.viewport.height - value.nav.bottom) <= 1 && value.nav.top >= value.viewport.height - 160, name + ': navigation stays at the bottom');
  if (value.sceneBottom !== null) assert.ok(value.sceneBottom <= value.nav.top + 1, name + ': the navigation leaves the scene caption visible');
  for (const control of value.controls) {
    const rect = control.rect;
    assert.ok(rect.width >= 47.9 && rect.height >= 47.9, name + ': ' + control.id + ' has a 48px touch target');
    assert.ok(rect.left >= -1 && rect.right <= value.viewport.width + 1 && rect.top >= -1 && rect.bottom <= value.viewport.height + 1,
      name + ': ' + control.id + ' fits the viewport');
    assert.equal(control.hit, true, name + ': ' + control.id + ' is hit-testable across its touch target');
    assert.equal(control.disabled, false, name + ': ' + control.id + ' is enabled');
  }
  for (let i = 0; i < value.controls.length - 1; i++) {
    assert.ok(value.controls[i].rect.right <= value.controls[i + 1].rect.left + 1, name + ': navigation touch targets do not overlap');
  }
  assert.deepEqual(value.aria, {label:'打开家长助手',controls:'family-assistant-panel',popup:'dialog'});
  assert.ok(value.documentWidth <= value.viewport.width + 1, name + ': no horizontal overflow');
}
function launcherSnapshot(page) {
  return page.$eval('.assistant-launcher', launcher => ({
    rect:launcher.getBoundingClientRect().toJSON(),
    media:{reduced:matchMedia('(prefers-reduced-motion:reduce)').matches,forcedColors:matchMedia('(forced-colors:active)').matches},
    styles:[launcher,...launcher.querySelectorAll('*')].flatMap((node,index) => [null,'::before','::after'].map(pseudo => {
      const style = getComputedStyle(node,pseudo);
      return {index,pseudo,content:style.content,animation:style.animationName,animationDuration:style.animationDuration,playState:style.animationPlayState,
        transitionDuration:style.transitionDuration,transform:style.transform,translate:style.translate,rotate:style.rotate,scale:style.scale,
        opacity:style.opacity,filter:style.filter,background:style.backgroundImage,position:style.backgroundPosition.split(',').map(value => value.trim()),
        size:style.backgroundSize,radius:style.borderRadius,shadow:style.boxShadow};
    })),
    animations:launcher.getAnimations({subtree:true}).map(animation => ({playState:animation.playState,pending:animation.pending}))
  }));
}
async function launcherMotion(page) {
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'},{name:'forced-colors',value:'none'}]);
  await page.mouse.move(1,1); await B.delay(200);
  const first = await launcherSnapshot(page); await B.delay(200);
  const middle = await launcherSnapshot(page); await B.delay(300); const last = await launcherSnapshot(page);
  Q.report.assistantLauncher.motion = {...Q.report.assistantLauncher.motion,'no-preference':{first,middle,last}};
  launcherProgress('pearl-motion');
  assert.deepEqual(first.media, {reduced:false,forcedColors:false}, 'the normal motion preference is active');
  assert.equal(first.animations.length, 1, 'one CSS animation moves the internal pearl colors');
  assert.ok([first,middle,last].every(sample => sample.animations.length === 1 && sample.animations[0].playState === 'running' && !sample.animations[0].pending),
    'the pearl colors are drifting during the samples');
  const drift = sample => sample.styles.find(style => style.index === 0 && style.pseudo === '::before').transform;
  assert.ok([middle,last].some(sample => drift(sample) !== drift(first)), 'the internal pearl colors advance in real time');
  const fixedBody = sample => ({...sample,styles:sample.styles.map(style => style.index === 0 && style.pseudo === '::before' ? {...style,transform:null} : style)});
  [middle,last].forEach(sample => assert.deepEqual(fixedBody(sample), fixedBody(first), 'the circle, location, shadow and surface sheen stay still'));
}
async function launcherStill(page, motion) {
  const forcedColors = motion === 'forced-colors';
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:forcedColors ? 'no-preference' : 'reduce'},
    {name:'forced-colors',value:forcedColors ? 'active' : 'none'}]);
  await page.mouse.move(1,1); await B.delay(200);
  const first = await launcherSnapshot(page); await B.delay(300); const last = await launcherSnapshot(page);
  Q.report.assistantLauncher.motion = {...Q.report.assistantLauncher.motion,[motion]:{first,last}};
  launcherProgress(motion + '-still');
  assert.deepEqual(first.media, {reduced:!forcedColors,forcedColors}, motion + ': the browser applies the requested media preference');
  assert.deepEqual(first.animations, [], motion + ': the sphere has no running animations');
  assert.deepEqual(first.styles.filter(style => style.animation !== 'none' && style.animationDuration.split(',').some(duration => parseFloat(duration) > 0)), [],
    motion + ': the sphere and its decoration do not animate');
  assert.deepEqual(last, first, motion + ': the idle sphere does not rotate, breathe or move');
  if (forcedColors) assert.ok(first.styles.filter(style => style.pseudo).every(style => style.content === 'none'),
    'forced colors hide the pearl material layers');
  if (motion === 'reduce') assert.deepEqual(first.styles.filter(style => style.transitionDuration.split(',').some(duration => parseFloat(duration) > 0)), [],
    'reduced motion stops entry transitions');
}
async function launcherFlow(page, env, device, open) {
  Q.report.assistantLauncher = {case:device,boundary:'Real SaaS and isolated SQLite in desktop Chromium. Reduced motion and forced colors are emulated; a physical tablet, Safari and OS keyboard are not verified.'};
  launcherProgress('fixture-ready');
  const before = await Q.snapshot(page), marker = env.calls.length;
  await Q.check(device + ': centered assistant and both navigation tabs remain reachable in points, companion and reminders', async () => {
    await B.homeView(page, 'points'); await launcherLayout(page, 'points-home');
    await Q.shot(page, device + '-points-entry');
    await B.homeView(page, 'companion'); await launcherLayout(page, 'companion-home');
    await Q.shot(page, device + '-companion-entry');
    await click(page, action('nav', 'reminders'), {scroll:false});
    await page.waitForFunction(() => FamilyDemo.getUI().view === 'reminders');
    await launcherLayout(page, 'reminders'); await Q.shot(page, device + '-reminders-entry');
    await click(page, action('nav', 'points'), {scroll:false});
    await page.waitForFunction(() => FamilyDemo.getUI().view === 'points');
    await launcherLayout(page, 'returned-home');
  });
  await Q.check(device + ': only internal pearl colors move, and reduced motion and forced colors keep it still', async () => {
    await launcherMotion(page);
    await launcherStill(page, 'forced-colors'); await Q.shot(page, device + '-forced-colors-entry');
    await launcherStill(page, 'reduce');
    await launcherLayout(page, 'reduced-motion-home'); await Q.shot(page, device + '-reduced-motion-entry');
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'},{name:'forced-colors',value:'none'}]);
  });
  await Q.check(device + ': the pearl colors pause behind the panel and pointer and keyboard activation restore focus', async () => {
    await open(); await page.waitForFunction(() => FamilyAssistantPanel.getState().loaded);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'family-assistant-panel', 'opening does not focus the keyboard');
    await B.delay(200); const first = await launcherSnapshot(page); await B.delay(300); const last = await launcherSnapshot(page);
    Q.report.assistantLauncher.motion['panel-open'] = {first,last}; launcherProgress('panel-open-paused');
    assert.equal(first.animations.length, 1, 'the pearl drift remains available to resume');
    assert.equal(first.animations[0].playState, 'paused', 'the pearl colors pause behind the open panel');
    assert.equal(first.animations[0].pending, false, 'the pause has settled');
    assert.deepEqual(last, first, 'the pearl colors stay fixed while the assistant is open');
    assert.equal(await page.$eval('.assistant-panel-header .assistant-orb', node => node.getAnimations({subtree:true}).length), 0,
      'the panel brand does not animate');
    await Q.shot(page, device + '-assistant-open');
    await click(page, 'button' + selector('close'));
    await page.waitForFunction(() => !FamilyAssistantPanel.getState().open && document.activeElement.matches('.assistant-launcher'));
    await page.waitForFunction(() => document.querySelector('.assistant-launcher').getAnimations({subtree:true}).some(animation => animation.playState === 'running' && !animation.pending));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => FamilyAssistantPanel.getState().open && FamilyAssistantPanel.getState().loaded);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !FamilyAssistantPanel.getState().open && document.activeElement.matches('.assistant-launcher'));
    await page.focus('.bottom-nav [data-action="nav"][data-id="points"]');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.matches('.assistant-launcher')), true, 'Tab reaches the sphere after home');
    const focus = await page.$eval('.assistant-launcher', node => {
      const style = getComputedStyle(node); return {visible:node.matches(':focus-visible'),outline:style.outlineStyle,width:parseFloat(style.outlineWidth)};
    });
    assert.ok(focus.visible && focus.outline !== 'none' && focus.width >= 2, 'keyboard focus remains visible on the sphere');
    await Q.shot(page, device + '-keyboard-entry');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.matches('.bottom-nav [data-action="nav"][data-id="reminders"]')), true, 'Tab reaches reminders after the sphere');
    await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
    await page.keyboard.press('Space');
    await page.waitForFunction(() => FamilyAssistantPanel.getState().open && FamilyAssistantPanel.getState().loaded);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !FamilyAssistantPanel.getState().open && document.activeElement.matches('.assistant-launcher'));
    await launcherLayout(page, 'closed-assistant');
  });
  await Q.check(device + ': business editor keeps one nearby assistant entry and preserves the unsaved form', async () => {
    await B.homeView(page, 'points');
    await click(page, action('all-behaviors')); await click(page, action('points-new'));
    await B.fillForm(page, {name:'入口回归草稿',points:'5',reason:'打开和关闭助手后保留'});
    const draft = await page.$eval('#editor-form', form => Object.fromEntries(new FormData(form)));
    const visibleEntries = await page.$$eval(entry, nodes => nodes.filter(node => node.getClientRects().length).map(node => ({
      inSheet:!!node.closest('.sheet'), floating:node.classList.contains('assistant-launcher')
    })));
    assert.deepEqual(visibleEntries, [{inSheet:true,floating:false}], 'the sheet has one contextual entry');
    assert.equal(await page.$eval('.assistant-sheet-entry .assistant-orb', node => node.getAnimations({subtree:true}).length), 0,
      'the contextual entry does not animate');
    await open(); await page.waitForFunction(() => FamilyAssistantPanel.getState().loaded);
    await click(page, 'button' + selector('close'));
    await page.waitForFunction(() => !FamilyAssistantPanel.getState().open && document.activeElement.matches('.assistant-sheet-entry'));
    assert.deepEqual(await page.$eval('#editor-form', form => Object.fromEntries(new FormData(form))), draft);
    await Q.shot(page, device + '-editor-entry');
    await Q.home(page); await launcherLayout(page, 'closed-editor');
    assert.deepEqual(await Q.snapshot(page), before, 'entry and navigation interactions do not change family data');
    assert.deepEqual(env.calls.slice(marker).filter(call => call.path === '/api/action'), [], 'entry interactions do not submit business actions');
    assert.deepEqual(Q.report.pageErrors, []);
  });
  launcherProgress('passed');
}

async function firstPinEditor(page, env, device, open) {
  await page.waitForFunction(() => FamilyDemo.getUI().parentConfigured === false);
  await open();
  await B.fill(page, '#assistant-chat-input', '今天独立阅读加5分'); await click(page, '#assistant-chat-send');
  await page.waitForSelector(selector('apply'), {visible:true});
  const draft = (await env.api(page, '/api/assistant/chat/read', 'POST', {})).body.draft;
  assert.equal(draft.sourceRevision, 1); assert.equal(draft.actions[0].status, 'pending');
  await click(page, selector('apply'));
  await click(page, Q.save); await click(page, action('points-confirm'));
  await page.waitForSelector('#parent-form [name="setupPin"]', {visible:true});
  assert.deepEqual((await env.api(page, '/api/state')).body.state.points, []);
  await Q.shot(page, device + '-setup');
  await B.fill(page, '#parent-form [name="setupPin"]', Q.PIN);
  await B.fill(page, '#parent-form [name="setupConfirm"]', Q.PIN);
  return draft;
}
async function holdFirstPinResponse(page) {
  await page.evaluate(() => {
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
      if (body && JSON.parse(body).action?.type === 'parent.setup') window.__qaFirstPinXhr = this;
      return send.apply(this, arguments);
    };
    window.__qaTransport.arm({path:'/api/action',status:200,method:'POST'});
  });
}
async function firstPinCommitted(page, env, device, draft) {
  await page.waitForSelector('#assistant-chat-input', {visible:true});
  await page.waitForFunction(() => !document.querySelector('[data-assistant-action="apply"]'));
  const saved = (await env.api(page, '/api/state')).body;
  assert.equal(saved.parent.configured, true);
  assert.equal(saved.revision, 3, 'only the PIN and the one award advance the family revision');
  assert.equal(saved.state.points.length, 1); assert.equal(saved.state.points[0].points, 5);
  assert.equal(saved.state.points[0].id, 'points-' + draft.actions[0].actionId);
  const current = (await env.api(page, '/api/assistant/chat/read', 'POST', {})).body;
  assert.equal(current.draft, undefined); assert.ok(current.messages.some(message => message.committed));
  Q.report.firstPin = {case:device,sourceRevision:draft.sourceRevision,revision:saved.revision,
    actionId:draft.actions[0].actionId,committedAwards:saved.state.points.length};
  await Q.shot(page, device + '-committed');
}
async function firstPinFlow(page, env, device, open) {
  const retry = device === 'first-pin-retry';
  await Q.check(retry ? 'lost PIN setup reply retries its receipt and continues the assistant award once' :
    'first parent PIN continues the same assistant award and commits it once', async () => {
    const draft = await firstPinEditor(page, env, device, open);
    if (retry) await holdFirstPinResponse(page);
    await click(page, Q.parentSubmit);
    if (retry) {
      await page.waitForFunction(() => __qaTransport.pending().length === 1);
      const configured = (await env.api(page, '/api/state')).body;
      assert.equal(configured.parent.configured, true); assert.equal(configured.revision, 2);
      assert.deepEqual(configured.state.points, []);
      // Drop only the actual response callback after the real SQLite commit.
      await page.evaluate(() => __qaFirstPinXhr.ontimeout());
      await page.waitForFunction(() => FamilyDemo.getUI().authPhase === 'setup-retry' && FamilyDemo.getUI().connected);
      assert.match(await page.$eval('#parent-error', node => node.textContent), /PIN已设置/);
      await click(page, Q.parentSubmit);
    }
    await firstPinCommitted(page, env, device, draft);
    if (retry) {
      await page.evaluate(() => __qaTransport.release());
      const setups = env.calls.filter(call => call.path === '/api/action' && call.action?.type === 'parent.setup');
      assert.equal(setups.length, 2); assert.equal(setups[0].action.id, setups[1].action.id);
      assert.equal((await env.api(page, '/api/state')).body.state.points.length, 1, 'late original response cannot repeat the award');
      Q.report.firstPin.setupRequests = setups.length;
    }
    assert.deepEqual(Q.report.pageErrors, []);
  });
}
async function concurrentFirstPinAward(page, env) {
  const current = (await env.api(page, '/api/state')).body;
  assert.equal(current.parent.configured, true); assert.equal(current.revision, 2);
  const action = {id:'first-pin-concurrent-award',type:'points.add',name:'并发记录',points:7};
  const challenge = await env.api(page, '/api/parent/challenge', 'POST', {revision:current.revision,action});
  assert.equal(challenge.status, 200);
  const verified = await env.api(page, '/api/parent/verify', 'POST', {challengeId:challenge.body.challengeId,answer:Q.PIN});
  assert.equal(verified.status, 200);
  const written = await env.api(page, '/api/action', 'POST', {revision:current.revision,action,grant:verified.body.grant});
  assert.equal(written.status, 200); assert.equal(written.body.revision, 3);
}
async function firstPinConflictFlow(page, env, device, open) {
  const afterSetup = device === 'first-pin-concurrent';
  await Q.check(afterSetup ? 'a real ledger update after PIN setup still rejects the assistant award' :
    'a concurrent family update cannot be hidden by first PIN setup', async () => {
    const draft = await firstPinEditor(page, env, device, open);
    if (afterSetup) await holdFirstPinResponse(page);
    else {
      const changed = await env.api(page, '/api/action', 'POST', {revision:draft.sourceRevision,
        action:{id:'first-pin-concurrent-pet',type:'pet.configure',kind:'plant',name:'并发改名'}});
      assert.equal(changed.status, 200); assert.equal(changed.body.revision, 2);
    }
    await click(page, Q.parentSubmit);
    if (afterSetup) {
      await page.waitForFunction(() => __qaTransport.pending().length === 1);
      await concurrentFirstPinAward(page, env);
      await page.evaluate(() => __qaTransport.release());
    }
    await page.waitForFunction(() => !FamilyDemo.getUI().auth && !FamilyDemo.getUI().pending);
    assert.match(await page.$eval('#form-error', node => node.textContent), /草稿已变化|记录已更新/);
    const saved = (await env.api(page, '/api/state')).body;
    assert.equal(saved.parent.configured, afterSetup);
    assert.equal(saved.revision, afterSetup ? 3 : 2);
    assert.deepEqual(saved.state.points.map(row => ({id:row.id,points:row.points})), afterSetup ?
      [{id:'points-first-pin-concurrent-award',points:7}] : []);
    assert.equal(saved.state.appliedActions.includes(draft.actions[0].actionId), false);
    const current = (await env.api(page, '/api/assistant/chat/read', 'POST', {})).body.draft;
    assert.equal(current.stale, true); assert.equal(current.sourceRevision, afterSetup ? 2 : 1);
    Q.report.firstPin = {case:device,sourceRevision:current.sourceRevision,revision:saved.revision,
      stale:current.stale,assistantAwardCommitted:false,concurrentAwards:saved.state.points.length};
    await Q.shot(page, device + '-rejected'); assert.deepEqual(Q.report.pageErrors, []);
  });
}

async function run() {
  const device = process.env.ASSISTANT_FLOW_CASE || 'phone';
  assert.ok(['phone', 'tablet', 'landscape', 'template', 'greeting', 'launcher-phone', 'launcher-tablet',
    'first-pin', 'first-pin-retry', 'first-pin-conflict', 'first-pin-concurrent'].includes(device));
  if (device.startsWith('launcher-')) {
    Q.phase(device); Q.report.assistantLauncher = {case:device}; launcherProgress('creating-fixture');
  }
  const replies = {
    'hi':'你好！需要看积分余额、记录加分，还是设置规则和提醒？告诉我就行。',
    '你是谁':'我是“小小向前”的家庭成长管理助手，可以帮你查看积分和提醒，也可以帮你整理待确认的加分草稿。',
    '35+100等于多少':'35 + 100 = 135。',
    '现在几点':null,
    '给我的纸飞机起个名字':'叫「折翼号」怎么样？'
  };
  const assistant = createAssistantService(device === 'greeting' ? {
    apiKey:'test-only',chatEnabled:true,fetch:async (_url, options) => {
      const request = JSON.parse(options.body);
      const {instruction,context} = JSON.parse(request.messages.at(-1).content);
      if (instruction === '现在几点') {
        assert.match(context.localTime, /^\d{2}:\d{2}$/);
        replies[instruction] = '现在是北京时间 ' + context.localTime + '。';
      }
      const content = replies[instruction];
      assert.ok(content, 'expected the current message in the model request');
      return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content}}]});
    }
  } : {apiKey:''});
  if (device === 'template') assistant.chat = async (text, state, now) =>
    executeTool('draft_award', {itemId:'reading-rule'}, state, now);
  const env = await Q.initialize({assistantService:assistant});
  // The server clock is frozen while the UI estimates elapsed time between polls.
  // Start at a whole minute so the default award time cannot run ahead during input.
  env.clock(Date.parse('2026-11-23T04:30:00Z'));
  const size = device === 'tablet' || device === 'launcher-tablet' ? {width:1024,height:768} : device === 'landscape' ? {width:844,height:390} : {width:390,height:844};
  const page = await env.newPage({...size,controlledClock:true});
  Q.active(page);
  page.setDefaultTimeout(7000);
  await Q.registerAndVerify(page, 'assistant-' + device + '-' + Q.RUN + '@example.test');
  const family = await Q.createFamily(page, '助手体验测试家庭', '小禾');
  const initial = await env.api(page, '/api/state');
  const setup = device.startsWith('first-pin') ? null : await env.api(page, '/api/action', 'POST', {
    revision:initial.body.revision, action:{id:'assistant-test-pin',type:'parent.setup',method:'pin',pin:Q.PIN,confirmPin:Q.PIN}
  });
  if (setup) assert.equal(setup.status, 200);
  if (device === 'template') {
    const rule = {id:'assistant-test-template',type:'pointItem.save',item:{id:'reading-rule',name:'独立阅读',points:8,reason:'上次的情况',enabled:true}};
    const revision = setup.body.revision;
    const challenge = await env.api(page, '/api/parent/challenge', 'POST', {revision, action:rule});
    assert.equal(challenge.status, 200);
    const verified = await env.api(page, '/api/parent/verify', 'POST', {challengeId:challenge.body.challengeId,answer:Q.PIN});
    assert.equal(verified.status, 200);
    const saved = await env.api(page, '/api/action', 'POST', {revision,action:rule,grant:verified.body.grant});
    assert.equal(saved.status, 200);
  }
  await page.reload({waitUntil:'load'}); await Q.ready(page, family);
  const ledger = async () => (await env.api(page, '/api/state')).body.state.points;
  const open = async () => {
    await click(page, entry);
    await page.waitForSelector('#assistant-chat-input', {visible:true});
  };
  if (device === 'first-pin' || device === 'first-pin-retry') { await firstPinFlow(page, env, device, open); return; }
  if (device.startsWith('first-pin-')) { await firstPinConflictFlow(page, env, device, open); return; }
  if (device.startsWith('launcher-')) { await launcherFlow(page, env, device, open); return; }
  if (device === 'greeting') {
    await Q.check('greetings, arithmetic, current time and creative replies survive reopening with their model attribution', async () => {
      await open();
      for (const prompt of Object.keys(replies)) {
        await B.fill(page, '#assistant-chat-input', prompt); await click(page, '#assistant-chat-send');
        await page.waitForFunction(count => document.querySelectorAll('.assistant-message-source').length === count, {}, Object.keys(replies).indexOf(prompt) + 1);
        await page.waitForFunction(expected => Array.from(document.querySelectorAll('.assistant-message')).some(row =>
          row.querySelector('.assistant-message-source')?.textContent === 'AI' && row.textContent.includes(expected)), {}, replies[prompt]);
      }
      await page.reload({waitUntil:'load'}); await Q.ready(page, family); await open();
      const expectedReplies = Object.values(replies);
      await page.waitForFunction(count => document.querySelectorAll('.assistant-message-source').length === count, {}, expectedReplies.length);
      const saved = await page.$$eval('.assistant-message-source', rows => rows.map(row => ({source:row.textContent, message:row.closest('.assistant-message').textContent})));
      assert.deepEqual(saved.map(row => row.source), expectedReplies.map(() => 'AI'));
      saved.forEach((row, index) => assert.ok(row.message.includes(expectedReplies[index])));
      assert.equal(await page.$(selector('apply')), null);
      assert.deepEqual(await ledger(), []); assert.deepEqual(Q.report.pageErrors, []);
    });
    return;
  }
  if (device === 'template') {
    await Q.check('an award identified only by rule ID opens with that rule’s name and score', async () => {
      await click(page, action('all-behaviors')); await click(page, action('points-new'));
      await B.fillForm(page, {name:'整理桌面',points:'5',reason:'另一件事'});
      await open(); await B.fill(page, '#assistant-chat-input', '今天按独立阅读的规则加分'); await click(page, '#assistant-chat-send');
      await page.waitForSelector(selector('apply'), {visible:true}); await click(page, selector('apply'));
      const values = await page.$eval('#editor-form', form => Object.fromEntries(new FormData(form)));
      assert.equal(values.itemId, 'reading-rule'); assert.equal(values.name, '独立阅读');
      assert.equal(values.points, '8'); assert.equal(values.reason, '');
      assert.deepEqual(await ledger(), []); assert.deepEqual(Q.report.pageErrors, []);
    });
    return;
  }
  if (device !== 'phone') {
    await Q.check(device === 'tablet' ? 'iPad-sized home keeps the companion visible beside the assistant' : 'landscape keyboard leaves the chat composer and send button tappable', async () => {
      if (device === 'tablet') await click(page, action('home-view', 'companion'));
      await open();
      if (device === 'tablet') {
        const bounds = await page.$eval('#family-assistant-panel', el => ({x:el.getBoundingClientRect().left,width:el.offsetWidth}));
        assert.ok(bounds.x >= size.width / 2 && bounds.width >= 320);
        const pet = await page.$eval('#main .pet-home-stage, #main .companion-scene', node => {
          const rect = node.getBoundingClientRect(); return {right:rect.right,width:rect.width};
        });
        assert.ok(pet.width > 180 && pet.right <= bounds.x, 'the full companion stage remains beside the open drawer');
      } else {
        await page.focus('#assistant-chat-input');
        await page.evaluate(() => {
          const v = visualViewport;
          Object.defineProperty(v, 'height', {configurable:true,get:() => 188});
          v.dispatchEvent(new Event('resize'));
        });
        await page.waitForFunction(() => {
          const input = document.querySelector('#assistant-chat-input').getBoundingClientRect();
          const send = document.querySelector('#assistant-chat-send').getBoundingClientRect();
          return input.top >= 0 && input.bottom <= visualViewport.height + 1 && send.bottom <= visualViewport.height + 1;
        });
      }
      await Q.shot(page, device + '-assistant');
      assert.deepEqual(Q.report.pageErrors, []);
    });
    return;
  }
  await Q.check('phone opens its single assistant entry without focusing or recording audio', async () => {
    assert.equal(await page.$$eval(entry, nodes => nodes.filter(n => n.getClientRects().length).length), 1);
    await Q.shot(page, 'phone-entry');
    await open();
    assert.notEqual(await page.evaluate(() => document.activeElement.id), 'assistant-chat-input');
    await Q.shot(page, 'phone-assistant');
    await click(page, 'button' + selector('close'));
  });
  await Q.check('a parent edits the proposed five points to seven and saves one verified award in SQLite', async () => {
    await click(page, action('all-behaviors')); await click(page, action('points-new'));
    await B.fillForm(page, {reason:'自己选了一本书'});
    await open();
    await B.fill(page, '#assistant-chat-input', '今天独立阅读加5分');
    await click(page, '#assistant-chat-send');
    await page.waitForSelector(selector('apply'), {visible:true});
    assert.equal((await ledger()).length, 0);
    await Q.shot(page, 'phone-award-draft');
    await click(page, selector('apply'));
    const read = name => page.$eval('#editor-form [name="' + name + '"]', node => node.value);
    assert.equal(await read('points'), '5');
    assert.match(await read('name'), /阅读/);
    assert.equal(await read('reason'), '自己选了一本书');
    await B.fillForm(page, {points:'7'});
    await click(page, Q.save); await click(page, action('points-confirm'));
    await page.waitForSelector('#parent-form [name="answer"]', {visible:true});
    assert.equal(await page.$(entry), null, 'PIN screen owns the viewport');
    await B.fill(page, '#parent-form [name="answer"]', Q.PIN); await click(page, Q.parentSubmit);
    await page.waitForSelector('#assistant-chat-input', {visible:true});
    await page.waitForFunction(() => !document.querySelector('[data-assistant-action="apply"]'));
    const rows = await ledger();
    assert.equal(rows.length, 1); assert.equal(rows[0].points, 7);
  });
  await Q.check('conversation survives refresh, then clears without removing the award', async () => {
    await page.reload({waitUntil:'load'}); await Q.ready(page, family); await open();
    await page.waitForFunction(() => document.querySelector('#family-assistant-panel').textContent.includes('今天独立阅读加5分'));
    const card = await page.$eval('.assistant-draft-card', node => node.textContent);
    assert.match(card, /已办理/); assert.match(card, /\+7\s*分/); assert.doesNotMatch(card, /\+5\s*分/);
    await Q.shot(page, 'phone-edited-award-receipt');
    await click(page, selector('clear')); await click(page, selector('confirm-clear'));
    await page.waitForFunction(() => !document.querySelector('#family-assistant-panel').textContent.includes('今天独立阅读加5分'));
    assert.equal((await ledger()).length, 1);
    await page.reload({waitUntil:'load'}); await Q.ready(page, family); await open();
    await page.waitForFunction(() => !document.querySelector('[data-assistant-action="clear"]').disabled);
    assert.doesNotMatch(await page.$eval('#family-assistant-panel', n => n.textContent), /今天独立阅读加5分/);
    assert.deepEqual(Q.report.pageErrors, []);
  });
}
Q.execute(run);
