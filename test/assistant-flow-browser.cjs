'use strict';
const assert = require('node:assert/strict');
const { createAssistantService } = require('../assistant-service.cjs');
const { executeTool } = require('../assistant-tools.cjs');
const Q = require('./saas-browser.cjs');
const { B, action, click } = Q;
const selector = name => '[data-assistant-action="' + name + '"]';
const entry = '[data-action="assistant-open"]';

async function run() {
  const device = process.env.ASSISTANT_FLOW_CASE || 'phone';
  assert.ok(['phone', 'tablet', 'landscape', 'template', 'greeting'].includes(device));
  const introductions = {
    'hi':'你好！需要看积分余额、记录加分，还是设置规则和提醒？告诉我就行。',
    '你是谁':'我是“小小向前”的家庭成长管理助手，可以帮你查看积分和提醒，也可以帮你整理待确认的加分草稿。'
  };
  const assistant = createAssistantService(device === 'greeting' ? {
    apiKey:'test-only',chatEnabled:true,fetch:async (_url, options) => {
      const request = JSON.parse(options.body);
      const {instruction} = JSON.parse(request.messages.at(-1).content);
      const content = introductions[instruction];
      assert.ok(content, 'expected the current message in the model request');
      return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content}}]});
    }
  } : {apiKey:''});
  if (device === 'template') assistant.chat = async (text, state, now) =>
    executeTool('draft_award', {itemId:'reading-rule'}, state, now, {text,enforceIntent:true});
  const env = await Q.initialize({assistantService:assistant});
  const size = device === 'tablet' ? {width:1024,height:768} : device === 'landscape' ? {width:844,height:390} : {width:390,height:844};
  const page = await env.newPage({...size,controlledClock:true});
  Q.active(page);
  page.setDefaultTimeout(7000);
  await Q.registerAndVerify(page, 'assistant-' + device + '-' + Q.RUN + '@example.test');
  const family = await Q.createFamily(page, '助手体验测试家庭', '小禾');
  const initial = await env.api(page, '/api/state');
  const setup = await env.api(page, '/api/action', 'POST', {
    revision:initial.body.revision, action:{id:'assistant-test-pin',type:'parent.setup',method:'pin',pin:Q.PIN,confirmPin:Q.PIN}
  });
  assert.equal(setup.status, 200);
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
  if (device === 'greeting') {
    await Q.check('ordinary model greetings and introductions remain attributed to AI after reopening', async () => {
      await open();
      for (const [prompt, reply] of Object.entries(introductions)) {
        await B.fill(page, '#assistant-chat-input', prompt); await click(page, '#assistant-chat-send');
        await page.waitForFunction(expected => Array.from(document.querySelectorAll('.assistant-message')).some(row =>
          row.querySelector('.assistant-message-source')?.textContent === 'AI' && row.textContent.includes(expected)), {}, reply);
      }
      await page.reload({waitUntil:'load'}); await Q.ready(page, family); await open();
      await page.waitForFunction(() => document.querySelectorAll('.assistant-message-source').length === 2);
      assert.deepEqual(await page.$$eval('.assistant-message-source', rows => rows.map(row => row.textContent)), ['AI','AI']);
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
  await Q.check('phone has one floating entry, and opening chat does not focus or record audio', async () => {
    assert.equal(await page.$$eval(entry, nodes => nodes.filter(n => n.getClientRects().length).length), 1);
    await Q.shot(page, 'phone-entry');
    await open();
    assert.notEqual(await page.evaluate(() => document.activeElement.id), 'assistant-chat-input');
    await Q.shot(page, 'phone-assistant');
    await click(page, 'button' + selector('close'));
  });
  await Q.check('assistant fills the existing award editor, with one verified award in SQLite', async () => {
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
    await click(page, Q.save); await click(page, action('points-confirm'));
    await page.waitForSelector('#parent-form [name="answer"]', {visible:true});
    assert.equal(await page.$(entry), null, 'PIN screen owns the viewport');
    await B.fill(page, '#parent-form [name="answer"]', Q.PIN); await click(page, Q.parentSubmit);
    await page.waitForSelector('#assistant-chat-input', {visible:true});
    await page.waitForFunction(() => !document.querySelector('[data-assistant-action="apply"]'));
    const rows = await ledger();
    assert.equal(rows.length, 1); assert.equal(rows[0].points, 5);
  });
  await Q.check('conversation survives refresh, then clears without removing the award', async () => {
    await page.reload({waitUntil:'load'}); await Q.ready(page, family); await open();
    await page.waitForFunction(() => document.querySelector('#family-assistant-panel').textContent.includes('今天独立阅读加5分'));
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
