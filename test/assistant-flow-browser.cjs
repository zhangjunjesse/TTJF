'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAssistantService } = require('../assistant-service.cjs');
const { executeTool } = require('../assistant-tools.cjs');
const Q = require('./saas-browser.cjs');
const cloudVoice = require('./assistant-cloud-voice-browser.cjs');
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
        pointerEvents:value.pointerEvents, background:value.backgroundImage, mask:value.maskImage, fill:value.backgroundColor};
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
  assert.ok(value.orb.decoration.every(layer => layer.visible && layer.pointerEvents === 'none'),
    name + ': aurora and voice mark remain visible without pointer targets');
  const aurora = value.orb.decoration.find(layer => layer.pseudo === '::before');
  const voiceMark = value.orb.decoration.find(layer => layer.pseudo === '::after');
  assert.match(aurora.background, /radial-gradient\(/, name + ': the aurora is a clipped color layer');
  assert.match(voiceMark.mask, /data:image\/svg\+xml/, name + ': the steady voice mark uses its soundwave mask');
  assert.notEqual(voiceMark.fill, 'rgba(0, 0, 0, 0)', name + ': the voice mark has visible ink');
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
        opacity:style.opacity,filter:style.filter,color:style.color,fill:style.backgroundColor,mask:style.maskImage,background:style.backgroundImage,position:style.backgroundPosition.split(',').map(value => value.trim()),
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
  launcherProgress('aurora-motion');
  assert.deepEqual(first.media, {reduced:false,forcedColors:false}, 'the normal motion preference is active');
  assert.equal(first.animations.length, 1, 'one CSS animation moves the internal aurora colors');
  assert.ok([first,middle,last].every(sample => sample.animations.length === 1 && sample.animations[0].playState === 'running' && !sample.animations[0].pending),
    'the aurora colors are drifting during the samples');
  const drift = sample => sample.styles.find(style => style.index === 0 && style.pseudo === '::before').transform;
  assert.ok([middle,last].some(sample => drift(sample) !== drift(first)), 'the internal aurora colors advance in real time');
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
  if (forcedColors) {
    const body = first.styles.find(style => style.pseudo === null);
    const aurora = first.styles.find(style => style.pseudo === '::before');
    const voiceMark = first.styles.find(style => style.pseudo === '::after');
    assert.equal(aurora.content, 'none', 'forced colors hide the decorative aurora');
    assert.equal(voiceMark.content, '\"\"', 'forced colors retain the recognizable voice mark');
    assert.match(voiceMark.mask, /data:image\/svg\+xml/, 'forced colors retain the soundwave mask');
    assert.equal(voiceMark.fill, body.color, 'forced colors draw the voice mark in the system button text color');
  }
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
  await Q.check(device + ': only internal aurora colors move, and reduced motion and forced colors keep it still', async () => {
    await launcherMotion(page);
    await launcherStill(page, 'forced-colors'); await Q.shot(page, device + '-forced-colors-entry');
    await launcherStill(page, 'reduce');
    await launcherLayout(page, 'reduced-motion-home'); await Q.shot(page, device + '-reduced-motion-entry');
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'},{name:'forced-colors',value:'none'}]);
  });
  await Q.check(device + ': the aurora colors pause behind the panel and pointer and keyboard activation restore focus', async () => {
    await open(); await page.waitForFunction(() => FamilyAssistantPanel.getState().loaded);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'family-assistant-panel', 'opening does not focus the keyboard');
    await B.delay(200); const first = await launcherSnapshot(page); await B.delay(300); const last = await launcherSnapshot(page);
    Q.report.assistantLauncher.motion['panel-open'] = {first,last}; launcherProgress('panel-open-paused');
    assert.equal(first.animations.length, 1, 'the aurora drift remains available to resume');
    assert.equal(first.animations[0].playState, 'paused', 'the aurora colors pause behind the open panel');
    assert.equal(first.animations[0].pending, false, 'the pause has settled');
    assert.deepEqual(last, first, 'the aurora colors stay fixed while the assistant is open');
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
    const contextual = await page.$eval('.assistant-sheet-entry', node => {
      const rect = node.getBoundingClientRect();
      return {name:node.getAttribute('aria-label'), width:rect.width, height:rect.height, animations:node.getAnimations({subtree:true}).length};
    });
    assert.equal(contextual.name, '打开家长助手');
    assert.ok(contextual.width >= 48 && contextual.height >= 48, 'the contextual assistant remains easy to tap');
    assert.equal(contextual.animations, 0,
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

async function awardUnitFlow(page, env, family, open, useVoice = false) {
  const instruction = '自己刷牙加一份', marker = env.calls.length;
  const sql = async () => (await env.database.query('SELECT revision,state FROM saas_families WHERE id=$1', [family])).rows[0];
  const read = name => page.$eval('#editor-form [name="' + name + '"]', node => node.value);
  const before = await sql();
  await Q.check('local 自己刷牙加一份 opens an editable one-point award without changing SQLite', async () => {
    await open();
    if (useVoice) {
      const hold = await page.waitForSelector(selector('hold-voice'), {visible:true});
      await page.waitForFunction(node => !node.disabled, {}, hold);
      await hold.hover(); await page.mouse.down();
      await page.waitForSelector('.assistant-recording:not([hidden])');
      await page.evaluate(words => {
        window.__qaNow += 1500; // Simulate the speaking interval on this fixture's controlled clock.
        const result = Object.assign([{transcript:words, confidence:0.97}], {isFinal:true});
        window.__qaRecognizer.onresult({results:[result]});
      }, instruction);
      assert.equal(env.calls.filter(call => call.path.endsWith('/turn')).length, 0);
      await page.mouse.up();
    } else {
      await B.fill(page, '#assistant-chat-input', instruction); await click(page, '#assistant-chat-send');
    }
    await page.waitForSelector(selector('apply'), {visible:true});
    assert.equal(await page.$eval('.assistant-message-source', node => node.textContent), '本地');
    assert.match(await page.$eval('.assistant-draft-pending', node => node.textContent), /自己刷牙/);
    assert.match(await page.$eval('.assistant-draft-pending', node => node.textContent), /(?:^|\D)1\s*分/);
    await Q.shot(page, 'award-unit-one-point-draft');
    await click(page, selector('apply'));
    assert.equal(await read('name'), '自己刷牙'); assert.equal(await read('points'), '1');
    assert.deepEqual(await sql(), before, 'preparing and opening the draft leaves the family ledger unchanged');
  });
  await Q.check('editing the one-point award to two and cancelling leaves SQLite unchanged', async () => {
    await Q.type(page, '#editor-form [name="points"]', '2');
    await Q.shot(page, 'award-unit-edited-two-points');
    await click(page, '.sheet-header ' + action('form-close'));
    await page.waitForFunction(() => !FamilyDemo.getUI().form);
    assert.deepEqual(await sql(), before, 'cancelling the edited draft does not award points');
    assert.deepEqual(env.calls.slice(marker).filter(call => ['/api/action','/api/parent/challenge','/api/parent/verify'].includes(call.path)), [],
      'neither drafting nor cancelling starts an authorization or business write');
  });
  await Q.check('confirmation and parent authorization commit only the final two-point award once', async () => {
    await open(); await page.waitForSelector(selector('apply'), {visible:true}); await click(page, selector('apply'));
    assert.equal(await read('points'), '1', 'the pending assistant draft still has its original score');
    await Q.type(page, '#editor-form [name="points"]', '2'); await click(page, Q.save);
    assert.equal((await Q.ui(page)).authPhase, 'confirm');
    assert.ok(await page.$('.ledger-award-dialog'), 'the points-home assistant draft uses the same real ledger receipt');
    assert.match(await page.$eval('.ledger-award-name', node => node.textContent), /自己刷牙/);
    assert.equal(await page.$eval('.ledger-award-amount', node => node.textContent.replace(/\s+/g, '')), '+2分');
    assert.match(await page.$eval(action('points-confirm'), node => node.textContent), /家长验证/);
    assert.deepEqual(env.calls.slice(marker).filter(call => ['/api/action', '/api/parent/challenge', '/api/parent/verify'].includes(call.path)), [],
      'drafting and reviewing the edited score starts no authorization or business write');
    assert.deepEqual(await sql(), before, 'review has not committed the edited score');
    await Q.shot(page, 'award-unit-two-point-confirmation');
    await click(page, action('points-confirm'));
    await page.waitForSelector('#parent-form [name="answer"]', {visible:true});
    assert.deepEqual(await sql(), before, 'requesting parent authorization has not committed the score');
    await B.fill(page, '#parent-form [name="answer"]', Q.PIN); await click(page, Q.parentSubmit);
    await page.waitForSelector('#assistant-chat-input', {visible:true});
    await page.waitForFunction(() => !document.querySelector('[data-assistant-action="apply"]'));
    await Q.settled(page);
    const saved = await sql(), rows = saved.state.points;
    assert.equal(saved.revision, before.revision + 1); assert.equal(rows.length, 1);
    assert.equal(rows[0].name, '自己刷牙'); assert.equal(rows[0].points, 2);
    assert.deepEqual((await Q.snapshot(page)).points, rows, 'the browser and SQLite show the same final award');
    const writes = env.calls.slice(marker).filter(call => call.path === '/api/action');
    assert.equal(writes.length, 1); assert.equal(writes[0].action.type, 'points.add'); assert.equal(writes[0].action.hasGrant, true);
    assert.deepEqual(Q.report.pageErrors, []);
    await Q.shot(page, 'award-unit-final-two-point-award');
  });
  await Q.check('local screenshot phrase 自己睡觉+1分 retains its name and commits once after manual confirmation', async () => {
    const beforePlus = await sql(), replies = await page.$$eval('.assistant-message-source', nodes => nodes.length);
    await B.fill(page, '#assistant-chat-input', '自己睡觉+1分'); await click(page, '#assistant-chat-send');
    await page.waitForFunction(count => document.querySelectorAll('.assistant-message-source').length === count + 1, {}, replies);
    await Q.shot(page, 'award-plus-sleep-response');
    assert.ok(await page.$(selector('apply')), 'the screenshot phrase must produce an editable award draft');
    assert.equal(await page.$$eval('.assistant-message-source', nodes => nodes.at(-1).textContent), '本地');
    assert.match(await page.$eval('.assistant-draft-pending', node => node.textContent), /自己睡觉/);
    await click(page, selector('apply'));
    assert.equal(await read('name'), '自己睡觉'); assert.equal(await read('points'), '1');
    assert.deepEqual(await sql(), beforePlus, 'the screenshot phrase only fills the form');
    await click(page, Q.save);
    assert.equal((await Q.ui(page)).authPhase, 'confirm');
    const receipt = '.ledger-award-dialog ';
    assert.equal(await page.$eval(receipt + '.ledger-award-name', node => node.textContent.trim()), '自己睡觉');
    assert.equal(await page.$eval(receipt + '.ledger-award-amount', node => node.textContent.replace(/\s+/g, '')), '+1分');
    assert.match(await page.$eval(receipt + action('points-confirm'), node => node.textContent), /家长验证/);
    assert.deepEqual(await sql(), beforePlus, 'review still requires manual confirmation and parent authorization');
    await Q.shot(page, 'award-plus-sleep-confirmation');
    await click(page, action('points-confirm'));
    await page.waitForSelector('#parent-form [name="answer"]', {visible:true});
    assert.deepEqual(await sql(), beforePlus);
    await B.fill(page, '#parent-form [name="answer"]', Q.PIN); await click(page, Q.parentSubmit);
    await page.waitForSelector('#assistant-chat-input', {visible:true});
    await page.waitForFunction(() => !document.querySelector('[data-assistant-action="apply"]'));
    await Q.settled(page);
    const saved = await sql();
    assert.equal(saved.revision, beforePlus.revision + 1); assert.equal(saved.state.points.length, 2);
    assert.equal(saved.state.points[1].name, '自己睡觉'); assert.equal(saved.state.points[1].points, 1);
    const writes = env.calls.slice(marker).filter(call => call.path === '/api/action');
    assert.equal(writes.length, 2); assert.equal(writes[1].action.type, 'points.add'); assert.equal(writes[1].action.hasGrant, true);
    assert.deepEqual((await Q.snapshot(page)).points, saved.state.points);
    assert.deepEqual(Q.report.pageErrors, []);
    await Q.shot(page, 'award-plus-sleep-final-one-point-award');
  });
}

async function entryGesturesFlow(page, env, family) {
  const input = '#assistant-chat-input', turns = [], marker = env.calls.length;
  const sql = async () => (await env.database.query('SELECT revision,state FROM saas_families WHERE id=$1', [family])).rows[0];
  const before = await sql(), state = () => page.evaluate(() => FamilyAssistantPanel.getState());
  const text = () => page.$eval(input, node => node.value);
  const ready = () => page.waitForFunction(() => FamilyAssistantPanel.getState().loaded && !FamilyAssistantPanel.getState().busy);
  const started = () => page.evaluate(() => (window.__qaRecognizers || []).length);
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/assistant/chat/turn') {
      const {text,turnId} = JSON.parse(request.postData()); turns.push({text,turnId});
    }
  });
  Q.report.assistantEntryGestures = {boundary:'Real mobile touch events in desktop Chromium and real isolated SaaS/SQLite. Speech recognition callbacks are simulated; native microphone permissions and iPad/Safari are not verified.'};
  const progress = stage => {
    Q.report.assistantEntryGestures.stage = stage;
    fs.writeFileSync(path.join(Q.OUT, 'entry-gestures-progress.json'), JSON.stringify({stage,checks:Q.report.checks,turns,updatedAt:new Date().toISOString()}, null, 2) + '\n');
  };
  async function press(target) {
    const point = await page.$eval(target, node => {
      const r = node.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      return {x,y,hit:node.contains(document.elementFromPoint(x,y)),disabled:!!node.disabled};
    });
    assert.equal(point.hit, true, target + ' is touch reachable'); assert.equal(point.disabled, false);
    const client = await page.createCDPSession();
    await client.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[{x:point.x,y:point.y,id:1}]});
    return {...point,client};
  }
  async function move(gesture, x, y) {
    await gesture.client.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{x,y,id:1}]}); await settle();
  }
  async function release(gesture, cancel = false) {
    await page.evaluate(() => { window.__qaNow += 1500; });
    await gesture.client.send('Input.dispatchTouchEvent', {type:cancel ? 'touchCancel' : 'touchEnd',touchPoints:[]});
    await gesture.client.detach(); await settle();
  }
  async function recording(waitForAudio = true) {
    await page.waitForFunction(audio => {
      const s = FamilyAssistantPanel.getState(), overlay = document.querySelector('.assistant-recording');
      return s.open && s.holding && (!audio || s.listening) && overlay && !overlay.hidden;
    }, {timeout:3000}, waitForAudio);
    await page.evaluate(() => {
      __qaSavedRecognizer = {start:__qaRecognizer.onstart,audio:__qaRecognizer.onaudiostart,result:__qaRecognizer.onresult,end:__qaRecognizer.onend};
    });
  }
  async function hear(words) {
    await page.evaluate(words => {
      const row = Object.assign([{transcript:words,confidence:0.97}], {isFinal:true});
      __qaRecognizer.onresult({results:[row]});
    }, words);
  }
  async function late() {
    await page.evaluate(() => {
      const saved = __qaSavedRecognizer, row = Object.assign([{transcript:'迟到的语音不应发送或覆盖',confidence:0.99}], {isFinal:true});
      saved.start?.(); saved.audio?.(); saved.result?.({results:[row]}); saved.end?.(); saved.end?.();
    }); await settle();
  }
  async function cold() {
    await page.reload({waitUntil:'load'}); await Q.ready(page, family);
    await page.evaluate(() => __qaTransport.arm({path:'/api/assistant/chat/read',status:200,method:'POST'}));
  }
  progress('fixture-ready');
  await Q.check('a genuine mobile orb tap opens chat without starting the microphone or keyboard', async () => {
    await Q.shot(page, 'entry-gestures-home-phone');
    await page.tap(entry); await ready();
    assert.equal((await state()).open, true); assert.equal((await state()).listening, false);
    assert.equal(await started(), 0); assert.notEqual(await page.evaluate(() => document.activeElement.id), 'assistant-chat-input');
    assert.deepEqual(turns, []); await page.tap('button' + selector('close'));
    progress('tap-checked');
  });
  await Q.check('the first orb long press captures during history loading and sends its reliable final exactly once on the same release', async () => {
    await cold(); const gesture = await press(entry); await recording();
    await page.waitForFunction(() => __qaTransport.pending().length === 1);
    assert.equal((await state()).loaded, false, 'recording starts before the real history callback returns');
    assert.equal(await started(), 1);
    await hear('我现在有多少积分？'); assert.deepEqual(turns, []);
    await Q.shot(page, 'entry-gestures-first-hold-listening-phone');
    await page.evaluate(() => __qaTransport.release()); await ready();
    assert.equal((await state()).listening, true, 'accepting the first generation keeps the original gesture alive');
    await release(gesture); await page.waitForFunction(() => FamilyAssistantPanel.getState().messageCount === 2); await ready();
    await late(); assert.deepEqual(turns.map(turn => turn.text), ['我现在有多少积分？']);
    assert.equal(await started(), 1, 'release does not generate an extra microphone click');
    assert.equal((await state()).listening, false); assert.equal(await text(), '');
    await Q.shot(page, 'entry-gestures-first-hold-sent-phone'); progress('first-hold-sent');
  });
  await Q.check('sliding the held homepage orb upward cancels and ignores both its release click and late recognition', async () => {
    await page.tap('button' + selector('close'));
    const gesture = await press(entry); await recording(); await hear('这句首页语音要取消');
    await move(gesture, gesture.x, gesture.y - 150);
    assert.equal(await page.$eval('.assistant-recording', node => node.dataset.cancel), 'true');
    const count = await started(); await release(gesture); await late();
    assert.equal(await started(), count); assert.equal((await state()).listening, false); assert.equal(await text(), '');
    assert.equal(turns.length, 1); progress('orb-cancelled');
  });
  await Q.check('a textarea tap types normally while a long press preserves and appends to its existing draft without sending', async () => {
    const count = await started(); await page.tap(input);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'assistant-chat-input');
    await page.keyboard.type('保留的手打草稿'); assert.equal(await started(), count);
    await Q.shot(page, 'entry-gestures-textarea-typing-phone');
    const gesture = await press(input); await recording(); await hear('补充的语音');
    assert.equal(await text(), '保留的手打草稿', 'the original draft stays intact during capture');
    await release(gesture); await late();
    assert.equal(await text(), '保留的手打草稿\n补充的语音'); assert.equal(turns.length, 1);
    assert.equal((await state()).listening, false); progress('draft-preserved');
  });
  await Q.check('sliding right from the textarea leaves an editable transcript and sends only the manually corrected text', async () => {
    await B.fill(page, input, '');
    const gesture = await press(input); await recording(); await hear('先留在输入框核对');
    await move(gesture, gesture.x + 100, gesture.y);
    assert.deepEqual(await page.$eval('.assistant-recording', node => ({cancel:node.dataset.cancel,review:node.dataset.review})), {cancel:'false',review:'true'});
    await Q.shot(page, 'entry-gestures-textarea-review-phone');
    const count = await started(); await release(gesture); await late();
    assert.equal(await text(), '先留在输入框核对'); assert.equal(turns.length, 1); assert.equal(await started(), count);
    await page.tap(input); assert.equal(await page.evaluate(() => document.activeElement.id), 'assistant-chat-input');
    await B.fill(page, input, '我现在还有多少可兑换积分？'); await page.tap('#assistant-chat-send');
    await page.waitForFunction(() => FamilyAssistantPanel.getState().messageCount === 4); await ready(); await late();
    assert.deepEqual(turns.map(turn => turn.text), ['我现在有多少积分？','我现在还有多少可兑换积分？']);
    assert.equal(new Set(turns.map(turn => turn.turnId)).size, 2); progress('review-sent');
  });
  await Q.check('a system touch cancellation and a late microphone start cannot send or overwrite the textarea draft', async () => {
    await B.fill(page, input, '系统打断后仍保留这份草稿');
    await page.evaluate(() => { window.__qaDeferVoiceStart = true; });
    const gesture = await press(input); await recording(false);
    assert.equal((await state()).listening, false);
    const count = await started(); await release(gesture, true); await late();
    await page.evaluate(() => { window.__qaDeferVoiceStart = false; });
    assert.equal(await text(), '系统打断后仍保留这份草稿'); assert.equal(turns.length, 2);
    assert.equal(await started(), count); assert.equal((await state()).listening, false); assert.equal((await state()).holding, false);
    progress('late-start-rejected');
  });
  await Q.check('release before cold history arrives keeps a safe draft through that real late response and a cancelled orb tap never opens later', async () => {
    await cold(); const gesture = await press(entry); await recording();
    await page.waitForFunction(() => __qaTransport.pending().length === 1);
    await hear('历史还没加载好时先保留这段话'); await release(gesture);
    assert.equal(turns.length, 2, 'an unresolved conversation cannot auto-send');
    assert.equal(await text(), '历史还没加载好时先保留这段话');
    await page.evaluate(() => __qaTransport.release()); await ready(); await late();
    assert.equal(await text(), '历史还没加载好时先保留这段话'); assert.equal(turns.length, 2);
    await Q.shot(page, 'entry-gestures-cold-history-draft-phone');
    await page.tap('button' + selector('close'));
    const count = await started(), short = await press(entry); await release(short, true);
    await B.delay(650); assert.equal((await state()).open, false); assert.equal(await started(), count);
    assert.deepEqual(await sql(), before, 'all gestures leave the real family ledger unchanged');
    assert.deepEqual(env.calls.slice(marker).filter(call => ['/api/action','/api/parent/challenge','/api/parent/verify'].includes(call.path)), []);
    assert.deepEqual(Q.report.pageErrors, []); progress('complete');
  });
}

async function run() {
  const device = process.env.ASSISTANT_FLOW_CASE || 'phone';
  assert.ok(['phone', 'tablet', 'landscape', 'template', 'greeting', 'award-unit', 'voice-award', 'launcher-phone', 'launcher-tablet',
    'first-pin', 'first-pin-retry', 'first-pin-conflict', 'first-pin-concurrent', 'cloud-voice', 'entry-gestures'].includes(device));
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
  const provider = device === 'cloud-voice' ? cloudVoice.fixture() : null;
  const env = await Q.initialize({assistantService:assistant, asrConfig:provider && {}, asrConnect:provider?.connect});
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
  if (device === 'voice-award' || device === 'entry-gestures') await page.evaluateOnNewDocument(() => {
    window.SpeechRecognition = class {
      start() {
        window.__qaRecognizer = this; (window.__qaRecognizers ||= []).push(this);
        if (!window.__qaDeferVoiceStart) { this.onstart?.(); this.onaudiostart?.(); }
      }
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    };
  });
  if (provider) await cloudVoice.setup(page);
  // Change mobile emulation only after reaching the same-origin fixture: Puppeteer
  // reloads the page when enabling touch, and its storage probe cannot run on about:blank.
  if (device === 'entry-gestures') await page.setViewport({...size,deviceScaleFactor:1,isMobile:true,hasTouch:true});
  await page.reload({waitUntil:'load'}); await Q.ready(page, family);
  const ledger = async () => (await env.api(page, '/api/state')).body.state.points;
  const open = async () => {
    await click(page, entry);
    await page.waitForSelector('#assistant-chat-input', {visible:true});
  };
  if (provider) { await cloudVoice.verify(page, env, provider); return; }
  if (device === 'entry-gestures') { Q.phase(device); await entryGesturesFlow(page, env, family); return; }
  if (device === 'first-pin' || device === 'first-pin-retry') { await firstPinFlow(page, env, device, open); return; }
  if (device.startsWith('first-pin-')) { await firstPinConflictFlow(page, env, device, open); return; }
  if (device.startsWith('launcher-')) { await launcherFlow(page, env, device, open); return; }
  if (device === 'award-unit' || device === 'voice-award') {
    Q.phase(device); await awardUnitFlow(page, env, family, open, device === 'voice-award'); return;
  }
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
