'use strict';
process.env.TZ = 'Asia/Shanghai';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../model.js');
const A = require('../assistant.js');
const {createAssistantService} = require('../assistant-service.cjs');
const now = new Date('2026-11-15T12:30:00+08:00');
function seed() { return M.createSeed(now); }
test('Mandarin dictation separates replaced interim words from final segments without losing repeated words', () => {
  const recognition = {};
  A.configureSpeech(recognition);
  assert.deepEqual(recognition, {lang:'zh-CN', continuous:true, interimResults:true, maxAlternatives:3});
  const final = words => Object.assign([{transcript:words, confidence:0.94}], {isFinal:true});
  const first = final('好好');
  assert.deepEqual(A.speechTranscript([first, [{transcript:'书'}]]),
    {finalText:'好好', interimText:'书', uncertain:false});
  assert.deepEqual(A.speechTranscript([first, final('收好书包')]),
    {finalText:'好好收好书包', interimText:'', uncertain:false});
});
test('Close family-name alternatives can be reviewed while conflicting amounts keep the leading transcript', () => {
  function hear(leading, alternative, hints, confidence = 0.92) {
    const segment = Object.assign([{transcript:leading, confidence}, {transcript:alternative, confidence:0.90}], {isFinal:true});
    return A.speechTranscript([segment], hints);
  }
  assert.deepEqual(hear('给晨月加五分', '给晨悦加五分', ['晨悦']),
    {finalText:'给晨悦加五分', interimText:'', uncertain:true});
  assert.equal(hear('给晨月加五分', '给晨悦加五分', ['晨月', '晨悦']).finalText, '给晨月加五分');
  assert.deepEqual(hear('给晨月加五分', '给晨悦加十分', ['晨悦']),
    {finalText:'给晨月加五分', interimText:'', uncertain:true});
  assert.equal(hear('查积分', '查积分', [], 0).uncertain, true);
  assert.equal(hear('提醒我去买书', '提醒我去卖书', []).uncertain, true);
  assert.equal(hear('提醒我买书。', '提醒我买书', []).uncertain, false);
});
function provider(candidate, inspect) {
  return async (url, options) => {
    if (inspect) { inspect(url, options); }
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(candidate)}}]}), {status:200,headers:{'Content-Type':'application/json'}});
  };
}

test('spoken date and half-hour become a precise editable draft without state changes', () => {
  const state = seed(), before = JSON.stringify(state);
  const result = A.interpret('明天早上七点半提醒带水杯', state, now);
  assert.equal(result.kind, 'action');
  assert.equal(result.mode, 'local');
  assert.deepEqual(result.action, {type:'task.save',payload:{task:{type:'task',title:'带水杯',date:'2026-11-16',time:'07:30',note:'',remindDays:0}}});
  assert.equal(JSON.stringify(state), before);
});
test('evening and future reminders use correct time and event domain', () => {
  const state = seed();
  assert.equal(A.interpret('明晚七点提醒带水杯', state, now).action.payload.task.time, '19:00');
  const future = A.interpret('2026年11月25日下午三点提醒去看牙', state, now);
  assert.equal(future.action.payload.task.type, 'event');
  assert.equal(future.action.payload.task.time, '15:00');
});
test('missing or invalid dates and times ask instead of inventing a schedule', () => {
  for (const phrase of ['明天提醒带水杯', '下个月提醒看牙', '明天25点提醒喝水', '2026年13月1日七点提醒带水杯']) {
    assert.equal(A.interpret(phrase, seed(), now).kind, 'clarify', phrase);
  }
  const allDay = A.interpret('明天全天提醒带水杯', seed(), now);
  assert.equal(allDay.kind, 'action');
  assert.equal(allDay.action.payload.task.time, '');
});
test('a time-only correction keeps the original reminder day and identity', () => {
  const state = M.apply(seed(), {id:'add-cup',type:'task.save',task:{type:'task',title:'带水杯',date:'2026-11-16',time:'07:30'}}, now);
  const result = A.interpret('把带水杯改到八点', state, now);
  assert.equal(result.action.payload.task.id, 'task-add-cup');
  assert.equal(result.action.payload.task.date, '2026-11-16');
  assert.equal(result.action.payload.task.time, '08:00');
});
test('points drafts keep concrete reasons and reject absent, decimal or negative amounts', () => {
  const state = seed(), before = M.totals(state);
  const result = A.interpret('他刚才主动收好了书包，给五分', state, now);
  assert.equal(result.action.payload.points, 5);
  assert.equal(result.action.payload.reason, '他刚才主动收好了书包');
  assert.deepEqual(M.totals(state), before);
  for (const phrase of ['给五分','加-5分，整理书包','整理书包，给1.5分']) {
    assert.equal(A.interpret(phrase, state, now).kind, 'clarify', phrase);
  }
});
test('named local awards accept an omitted reason without borrowing a template preset', () => {
  const state = seed(), before = JSON.stringify(state);
  for (const context of ['general', 'points']) {
    for (const [sentence, name, reason] of [
      ['行为：阅读，加5分', '阅读', ''],
      ['自主阅读，加5分', '自主阅读', ''],
      ['表现好，加5分', '表现好', '表现好'],
      ['行为：阅读，原因：读完后分享了故事，加5分', '阅读', '读完后分享了故事']
    ]) {
      const result = A.interpret(sentence, state, now, {context});
      assert.equal(result.kind, 'action', sentence + ': ' + JSON.stringify(result));
      assert.deepEqual(result.action.payload, {name, points: 5, reason});
      assert.doesNotMatch(result.summary, /undefined|null|·\s*$/);
    }
  }
  assert.equal(JSON.stringify(state), before, 'parsing only creates a draft');
});
test('gift creation maps an explicit category and price', () => {
  const r = A.interpret('添加一个周末吃汉堡的礼品，六十分', seed(), now);
  assert.equal(r.kind, 'action');
  assert.deepEqual(r.action.payload.reward, {name:'吃汉堡',points:60,category:'weekend',enabled:true,icon:'burger'});
});
test('queries use real balances and never echo an invented AI answer', () => {
  const state = seed();
  assert.match(A.interpret('我还有多少积分', state, now).answer, /88/);
  assert.match(A.interpret('还差多少分能换汉堡', state, now).answer, /积分已经够/);
  assert.match(A.normalize({kind:'answer',answer:'你有999999分'}, state, now).answer, /88/);
  assert.doesNotMatch(A.normalize({kind:'answer',answer:'你有999999分'}, state, now).answer, /999999/);
});
test('model cannot return a grant, configure the parent, or perform a final redemption', () => {
  const state = seed();
  for (const type of ['parent.configure','reward.redeem','redemption.approve','settings.update','pet.buy','pet.care','pet.scene','__proto__']) {
    assert.equal(A.normalize({kind:'action',action:{type,payload:{rewardId:'reward-pencil',grant:'fake'}}}, state, now).kind, 'clarify');
  }
  const safe = A.normalize({kind:'action',grant:'fake',action:{type:'points.add',payload:{name:'整理书包',points:5,reason:'主动收好书包',grant:'fake',parent:true,saveAsTemplate:true}}}, state, now);
  assert.equal(safe.kind, 'action');
  assert.equal(safe.action.payload.grant, undefined);
  assert.equal(safe.action.payload.saveAsTemplate, undefined, 'Saving a template must be the visible form choice, not a hidden AI field');
  assert.equal(safe.grant, undefined);
});
test('award normalization keeps reasons optional while validating names, amounts and reason types', () => {
  const state = seed(), before = JSON.stringify(state);
  for (const reason of [undefined, null, '', '   ', '表现好', '  独立读完一章  ']) {
    const payload = {name: '阅读', points: 5};
    if (reason !== undefined) payload.reason = reason;
    const result = A.normalize({kind: 'action', action: {type: 'points.add', payload}}, state, now);
    assert.equal(result.kind, 'action', JSON.stringify(result));
    assert.equal(result.action.payload.reason, reason == null ? '' : reason.trim());
    assert.match(result.summary, /阅读/);
    assert.doesNotMatch(result.summary, /undefined|null|·\s*$/);
  }
  const preset = A.normalize({kind: 'action', action: {type: 'points.add', payload: {itemId: state.pointItems[0].id}}}, state, now);
  assert.equal(preset.kind, 'action', JSON.stringify(preset));
  assert.equal(preset.action.payload.reason, '');
  for (const patch of [{name: ''}, {name: undefined}, {name: {toString: null}}, {points: undefined}, {points: 0}, {points: -1}, {points: 1.5}, {reason: 123}, {reason: {}}, {reason: {toString: null}}, {reason: 'x'.repeat(2001)}]) {
    const payload = {name: '阅读', points: 5, ...patch};
    assert.equal(A.normalize({kind: 'action', action: {type: 'points.add', payload}}, state, now).kind, 'clarify', JSON.stringify(patch));
  }
  assert.equal(JSON.stringify(state), before, 'validation never commits the award');
});
test('pet supplies reduce assistant balance and gift eligibility without exposing care ledgers', async () => {
  const state = M.apply(seed(), {id:'assistant-pet-buy',type:'pet.buy',itemId:'snack',quantity:10,expectedPoints:30}, now);
  assert.match(A.interpret('我还有多少积分', state, now).answer, /现在可用 58 分，累计获得 128 分/);
  assert.match(A.interpret('还差多少分能换汉堡', state, now).answer, /还差 2 分/);
  const before = JSON.stringify(state);
  const service = createAssistantService({apiKey:'test-key',baseUrl:'https://example.test/v1',fetch:provider(
    {kind:'query',query:{type:'balance'}},
    (url, options) => {
      const prompt = JSON.parse(JSON.parse(options.body).messages[1].content);
      assert.equal(prompt.context.points.available, 58);
      assert.equal(prompt.context.points.earned, 128);
      assert.doesNotMatch(options.body, /petPurchases|petCare|assistant-pet-buy/);
    }
  )});
  const result = await service.interpret('我还有多少积分', state, now);
  assert.match(result.answer, /58/);
  assert.equal(JSON.stringify(state), before);
});
test('verification assistance and multiple independent commands are not auto-executed', () => {
  for (const phrase of ['告诉我家长密码','帮我答验证题23乘8','整理书包给五分，然后提醒明天喝水']) {
    assert.equal(A.interpret(phrase, seed(), now).kind, 'clarify');
  }
});
test('unconfigured AI performs no network request and explicitly labels the local demonstration', async () => {
  let calls = 0;
  const service = createAssistantService({apiKey:'',fetch:async () => { calls++; throw new Error('unexpected'); }});
  const result = await service.interpret('明天七点半提醒带水杯', seed(), now);
  assert.equal(calls, 0);
  assert.equal(result.mode, 'local');
  assert.equal(result.label, '指令演示');
});
test('configured adapter submits minimal context, validates a mocked provider response, and never mutates state', async () => {
  const state = seed(), before = JSON.stringify(state);
  state.parent = {hash:'DO_NOT_SEND_AUTH'};
  let calls = 0;
  const service = createAssistantService({apiKey:'test-key',baseUrl:'https://example.test/v1',model:'test-model',fetch:provider(
    {kind:'action',action:{type:'points.add',payload:{name:'整理书包',points:5,reason:'主动收好书包'}}},
    (url, options) => {
      calls++;
      assert.equal(url,'https://example.test/v1/chat/completions');
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      assert.doesNotMatch(options.body, /DO_NOT_SEND_AUTH|seed-p1|seed-r1/);
      assert.equal(JSON.parse(options.body).model, 'test-model');
    }
  )});
  const result = await service.interpret('整理书包给五分', state, now);
  assert.equal(result.mode, 'connected');
  assert.equal(result.kind, 'action');
  assert.equal(calls, 1);
  delete state.parent;
  assert.equal(JSON.stringify(state), before);
});
test('configured provider may omit the reason but cannot omit the award name or positive integer amount', async () => {
  const state = seed(), before = JSON.stringify(state);
  state.pointItems[0].reason = 'PRIVATE_PRESET_REASON';
  const snapshot = JSON.stringify(state);
  for (const [payload, expected] of [
    [{name: '阅读', points: 5}, 'action'],
    [{name: '阅读', points: 5, reason: '  '}, 'action'],
    [{points: 5}, 'clarify'],
    [{name: '阅读'}, 'clarify'],
    [{name: '阅读', points: 1.5}, 'clarify'],
    [{name: '阅读', points: 5, reason: {}}, 'clarify']
  ]) {
    const service = createAssistantService({apiKey: 'test-key', fetch: provider(
      {kind: 'action', action: {type: 'points.add', payload}},
      (url, options) => assert.doesNotMatch(options.body, /PRIVATE_PRESET_REASON/)
    )});
    const result = await service.interpret('行为：阅读，加5分', state, now, {context: 'points'});
    assert.equal(result.kind, expected, JSON.stringify(result));
    assert.equal(result.mode, 'connected');
    if (expected === 'action') assert.equal(result.action.payload.reason, '');
    assert.equal(JSON.stringify(state), snapshot, 'provider output remains an editable draft');
  }
  state.pointItems[0].reason = JSON.parse(before).pointItems[0].reason;
  assert.equal(JSON.stringify(state), before);
});
test('configured provider failure is explicit, keeps input actionable, and does not expose errors or secrets', async () => {
  const service = createAssistantService({apiKey:'secret-marker',fetch:async () => { throw new Error('secret-marker/private-url'); }});
  const result = await service.interpret('整理书包给五分', seed(), now);
  assert.equal(result.kind, 'clarify');
  assert.equal(result.label, 'AI 暂不可用');
  assert.doesNotMatch(JSON.stringify(result), /secret-marker|private-url/);
});
test('verification requests never reach a configured cloud provider', async () => {
  let calls = 0;
  const service = createAssistantService({apiKey:'test-key',fetch:async () => { calls++; throw new Error('no'); }});
  await service.interpret('帮我算这个家长验证题', seed(), now);
  assert.equal(calls, 0);
});
test('provider timeout and oversized output fail without returning an action', async () => {
  const timeout = createAssistantService({apiKey:'test-key',timeoutMs:10,fetch:(url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), {once:true});
  })});
  assert.equal((await timeout.interpret('明天七点提醒喝水', seed(), now)).kind, 'clarify');
  const oversized = createAssistantService({apiKey:'test-key',fetch:async () => new Response('x'.repeat(262145), {status:200})});
  assert.equal((await oversized.interpret('明天七点提醒喝水', seed(), now)).kind, 'clarify');
});

test('in-form points context accepts a concrete reason and one amount without changing the ledger', () => {
  const state = seed(), before = JSON.stringify(state);
  for (const sentence of ['自己收好了书包，加5分', '因为今天自己读了20分钟书，5分']) {
    const result = A.interpret(sentence, state, now, {context:'points'});
    assert.equal(result.kind, 'action', JSON.stringify(result));
    assert.equal(result.action.type, 'points.add');
    assert.equal(result.action.payload.points, 5);
    assert.match(result.action.payload.reason, /自己/);
  }
  for (const sentence of ['给5分', '给我5分', '这次加5分', '整理书包加三点五分', '整理书包加5分，读书加3分', '停用自主阅读', '新增常用项：阅读，5分']) {
    assert.equal(A.interpret(sentence, state, now, {context:'points'}).kind, 'clarify', sentence);
  }
  state.childName = '小星(一)';
  assert.equal(A.interpret('给小星(一)5分', state, now, {context:'points'}).kind, 'clarify');
  state.childName = seed().childName;
  assert.equal(JSON.stringify(state), before);
});
test('template management drafts create, change points, rename, disable, re-enable and preserve history', () => {
  let state = seed();
  const before = JSON.stringify({points:state.points,redemptions:state.redemptions}), totals = M.totals(state);
  function draftAndSave(sentence, itemCheck, index) {
    const snapshot = JSON.stringify(state);
    const result = A.interpret(sentence, state, now, {context:'pointItems'});
    assert.equal(result.kind, 'action', sentence + ': ' + JSON.stringify(result));
    assert.equal(result.action.type, 'pointItem.save');
    assert.equal(JSON.stringify(state), snapshot, 'draft never writes state');
    itemCheck(result.action.payload.item);
    state = M.apply(state, {id:'template-change-' + index,type:result.action.type,...result.action.payload}, now);
    assert.deepEqual(M.totals(state), totals);
    assert.equal(JSON.stringify({points:state.points,redemptions:state.redemptions}), before);
  }
  draftAndSave('新增常用项：整理书包，3分，预设原因：今天自己收好了书包', item => {
    assert.equal(item.name, '整理书包'); assert.equal(item.points, 3); assert.equal(item.reason, '今天自己收好了书包');
  }, 1);
  draftAndSave('把整理书包改为9分', item => { assert.equal(item.points, 9); assert.equal(item.reason, '今天自己收好了书包'); }, 2);
  draftAndSave('停用整理书包', item => { assert.equal(item.enabled, false); }, 3);
  draftAndSave('启用整理书包', item => { assert.equal(item.enabled, true); }, 4);
  draftAndSave('把整理书包改名为自己收拾书包', item => { assert.equal(item.name, '自己收拾书包'); assert.equal(item.points, 9); }, 5);
  draftAndSave('把自己收拾书包的预设原因改为今天整理好了课本和文具', item => { assert.equal(item.reason, '今天整理好了课本和文具'); }, 6);
});
test('template management needs an unambiguous target and never turns into an award', () => {
  const state = seed();
  for (const sentence of ['自己收好书包加5分', '改为8分', '新增常用项：读书', '把不存在的模板改为3分', '停用自主阅读，然后启用专心完成作业']) {
    assert.equal(A.interpret(sentence, state, now, {context:'pointItems'}).kind, 'clarify', sentence);
  }
  const target = state.pointItems[0];
  const result = A.interpret('分值改为8分', state, now, {context:'pointItems',targetId:target.id});
  assert.equal(result.kind, 'action');
  assert.equal(result.action.payload.item.id, target.id);
  assert.equal(result.action.payload.item.points, 8);
  assert.equal(result.action.payload.item.name, target.name);
  assert.equal(A.interpret('把专心完成作业改为9分', state, now, {context:'pointItems',targetId:target.id}).kind, 'clarify');
  const other = {...target,id:'another-template'};
  state.pointItems.push(other);
  assert.equal(A.interpret('把自主阅读改为8分', state, now, {context:'pointItems'}).kind, 'clarify');
});
test('normalization enforces input context, selected target and domain checks even on id collision', () => {
  const state = seed(), id = state.pointItems[0].id;
  assert.equal(A.normalize({kind:'action',action:{type:'points.add',payload:{name:'收拾',points:5,reason:'自己收好书包'}}}, state, now, {context:'pointItems'}).kind, 'clarify');
  assert.equal(A.normalize({kind:'action',action:{type:'pointItem.save',payload:{item:{name:'阅读',points:5}}}}, state, now, {context:'points'}).kind, 'clarify');
  assert.equal(A.normalize({kind:'action',action:{type:'pointItem.save',payload:{item:{id:state.pointItems[1].id,points:8}}}}, state, now, {context:'pointItems',targetId:id}).kind, 'clarify');
  state.appliedActions.push('ai-check-' + now.getTime());
  assert.equal(A.normalize({kind:'action',action:{type:'pointItem.save',payload:{item:{id,points:-1}}}}, state, now, {context:'pointItems'}).kind, 'clarify');
  const valid = A.normalize({kind:'action',action:{type:'pointItem.save',payload:{item:{id,points:8,grant:'fake',childAvatar:'fake'}}}}, state, now, {context:'pointItems'});
  assert.equal(valid.kind, 'action');
  assert.equal(valid.action.payload.item.grant, undefined);
  assert.equal(valid.action.payload.item.childAvatar, undefined);
});
test('configured management sends disabled templates and selected context but excludes photos and unrelated data', async () => {
  const state = seed(), id = state.pointItems[0].id;
  state.pointItems[0].enabled = false;
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+KvAkAAAAASUVORK5CYII=';
  state.childAvatar = png;
  state.parent = {hash:'PRIVATE_AUTH_MARKER'};
  let calls = 0;
  const service = createAssistantService({apiKey:'test-key',fetch:provider(
    {kind:'action',action:{type:'pointItem.save',payload:{item:{id,enabled:true}}}},
    (url, options) => {
      calls++;
      const context = JSON.parse(JSON.parse(options.body).messages[1].content).context;
      assert.equal(context.inputMode, 'pointItems');
      assert.equal(context.selectedPointItemId, id);
      assert.equal(context.selectedPointItem.enabled, false);
      assert.equal(context.pointItems.find(p => p.id === id).enabled, false);
      assert.equal(context.tasks, undefined);
      assert.equal(context.rewards, undefined);
      assert.doesNotMatch(options.body, /childAvatar|data:image|iVBORw0|PRIVATE_AUTH_MARKER|seed-p1/);
    }
  )});
  const result = await service.interpret('重新启用', state, now, {context:'pointItems',targetId:id});
  assert.equal(calls, 1);
  assert.equal(result.kind, 'action', JSON.stringify(result));
  assert.equal(result.action.payload.item.enabled, true);
  assert.equal(state.pointItems[0].enabled, false);
  assert.equal(state.childAvatar, png);
});
test('provider draft cannot cross from template management into a real award', async () => {
  const service = createAssistantService({apiKey:'test-key',fetch:provider({kind:'action',action:{type:'points.add',payload:{name:'阅读',points:5,reason:'自己读书'}}})});
  const result = await service.interpret('管理自主阅读', seed(), now, {context:'pointItems'});
  assert.equal(result.kind, 'clarify');
  assert.match(result.question, /不会直接给孩子加分/);
});

test('new-template context treats a description as a fresh draft even when its name already exists', () => {
  const state = seed(), before = JSON.stringify(state), options = {context:'pointItemCreate'};
  for (const [sentence, name] of [
    ['自主阅读，5分', '自主阅读'],
    ['以后自己读书满二十分钟，奖励五分', '以后自己读书满二十分钟'],
    ['新增常用行为：每天阅读20分钟，奖励5积分', '每天阅读20分钟']
  ]) {
    const result = A.interpret(sentence, state, now, options);
    assert.equal(result.kind, 'action', JSON.stringify(result));
    assert.deepEqual(result.action, {type:'pointItem.save',payload:{item:{name,points:5}}});
  }
  const reading = A.interpret('每天阅读20分钟', state, now, options);
  assert.equal(reading.kind, 'form');
  assert.equal(reading.form, 'pointItem');
  assert.deepEqual(reading.fields, {name:'每天阅读20分钟'});
  assert.deepEqual(reading.missing, ['points']);
  assert.match(reading.question, /多少分/);
  const amount = A.interpret('5分', state, now, options);
  assert.equal(amount.kind, 'form');
  assert.deepEqual(amount.fields, {points:5});
  assert.deepEqual(amount.missing, ['name']);
  assert.equal(JSON.stringify(state), before, 'creating drafts never changes existing templates or balances');
});

test('new-template normalization checks partial fields and never borrows an existing id or missing value', () => {
  const state = seed(), before = JSON.stringify(state), options = {context:'pointItemCreate',sourceText:'每天阅读20分钟'};
  const partial = A.normalize({kind:'form',form:'pointItem',fields:{name:'  每天阅读20分钟  ',reason:' 手动约定的原因 ',grant:'fake'},missing:[],question:'已保存'}, state, now, options);
  assert.equal(partial.kind, 'form');
  assert.deepEqual(partial.fields, {name:'每天阅读20分钟',reason:'手动约定的原因'});
  assert.deepEqual(partial.missing, ['points']);
  assert.doesNotMatch(partial.question, /已保存/);
  const patches = [{id:state.pointItems[0].id}, {id:''}, {name:{}}, {name:'x'.repeat(121)},
    {points:0}, {points:-1}, {points:1.5}, {points:'5'}, {points:Number.MAX_SAFE_INTEGER + 1}, {reason:{}}, {reason:'x'.repeat(2001)}, {enabled:'true'}];
  for (const patch of patches) {
    const result = A.normalize({kind:'form',form:'pointItem',fields:{name:'阅读',...patch}}, state, now, options);
    assert.equal(result.kind, 'clarify', JSON.stringify(patch));
  }
  for (const candidate of [
    {kind:'query',query:{type:'balance'}},
    {kind:'action',action:{type:'points.add',payload:{name:'阅读',points:5}}},
    {kind:'form',form:'reward',fields:{name:'阅读',points:5}}
  ]) { assert.equal(A.normalize(candidate, state, now, options).kind, 'clarify'); }
  assert.equal(A.normalize({kind:'form',form:'pointItem',fields:{name:'阅读'}}, state, now, {...options,targetId:state.pointItems[0].id}).kind, 'clarify');
  const explicit = A.normalize({kind:'form',form:'pointItem',fields:{name:'阅读',points:5,reason:'约定的原因',enabled:false}}, state, now, {context:'pointItemCreate',sourceText:'阅读每次5分，原因：约定的原因，暂不启用'});
  assert.equal(explicit.kind, 'action');
  assert.deepEqual(explicit.action.payload.item, {name:'阅读',points:5,reason:'约定的原因',enabled:false});
  assert.equal(JSON.stringify(state), before);
});

test('configured new-template task sends only the instruction and fixed form context', async () => {
  const state = seed();
  state.childName = 'PRIVATE_CHILD_MARKER';
  state.pointItems[0].reason = 'PRIVATE_PRESET_MARKER';
  state.familyId = 'PRIVATE_FAMILY_MARKER';
  state.parent = {hash:'PRIVATE_AUTH_MARKER'};
  const before = JSON.stringify(state), text = '以后自己读书满二十分钟，奖励五分';
  const service = createAssistantService({apiKey:'test-key',fetch:provider(
    {kind:'form',form:'pointItem',fields:{name:'自己读书满20分钟',points:5}},
    (url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.messages.length, 2);
      assert.match(request.messages[0].content, /固定任务/);
      assert.match(request.messages[0].content, /20分钟/);
      assert.deepEqual(JSON.parse(request.messages[1].content), {context:{inputMode:'pointItemCreate'},instruction:text});
      assert.doesNotMatch(options.body, /PRIVATE_|childName|familyId|pointItems|seed-p1|seed-r1/);
    }
  )});
  const result = await service.interpret(text, state, now, {context:'pointItemCreate'});
  assert.equal(result.mode, 'connected');
  assert.equal(result.kind, 'action');
  assert.deepEqual(result.action, {type:'pointItem.save',payload:{item:{name:'自己读书满20分钟',points:5}}});
  assert.equal(JSON.stringify(state), before);
});

test('configured new-template output fills known fields but cannot invent a score from a duration', async () => {
  const state = seed(), before = JSON.stringify(state);
  for (const [text, fields, expected] of [
    ['每天阅读20分钟', {name:'每天阅读20分钟'}, {name:'每天阅读20分钟'}],
    ['每天阅读20分钟', {name:'每天阅读20分钟',points:20}, {name:'每天阅读20分钟'}],
    ['每天阅读20分钟', {name:'每天阅读20分钟',points:5}, {name:'每天阅读20分钟'}],
    ['每天阅读20分钟奖励5分', {name:'每天阅读20分钟',points:20}, {name:'每天阅读20分钟'}],
    ['每天阅读奖励5分或8分', {name:'每天阅读',points:5}, {name:'每天阅读'}],
    ['每天阅读奖励3.5分', {name:'每天阅读',points:5}, {name:'每天阅读'}],
    ['每天阅读奖励3.5积分', {name:'每天阅读',points:5}, {name:'每天阅读'}],
    ['每天阅读，分值为3.5', {name:'每天阅读',points:3}, {name:'每天阅读'}],
    ['每天阅读奖励-5分', {name:'每天阅读',points:5}, {name:'每天阅读'}]
  ]) {
    const service = createAssistantService({apiKey:'test-key',fetch:provider({kind:'form',form:'pointItem',fields})});
    const result = await service.interpret(text, state, now, {context:'pointItemCreate'});
    assert.equal(result.kind, 'form', JSON.stringify(result));
    assert.deepEqual(result.fields, expected);
    assert.deepEqual(result.missing, ['points']);
    assert.equal(result.mode, 'connected');
  }
  for (const text of ['每天阅读20分钟，奖励5积分', '每天阅读20分钟，分值为五', '每天阅读20分钟，每次5分', '每次朗读1.5分钟，奖励5分']) {
    const service = createAssistantService({apiKey:'test-key',fetch:provider({kind:'form',form:'pointItem',fields:{name:'每天阅读20分钟',points:5}})});
    assert.equal((await service.interpret(text, state, now, {context:'pointItemCreate'})).kind, 'action', text);
  }
  assert.equal(JSON.stringify(state), before);
});

test('new-template provider cannot update existing templates or cross into ledger actions', async () => {
  const state = seed(), before = JSON.stringify(state);
  for (const candidate of [
    {kind:'action',action:{type:'pointItem.save',payload:{item:{id:state.pointItems[0].id,points:5}}}},
    {kind:'form',form:'pointItem',fields:{id:state.pointItems[0].id,name:'阅读',points:5}},
    {kind:'action',action:{type:'points.add',payload:{name:'阅读',points:5}}}
  ]) {
    const service = createAssistantService({apiKey:'test-key',fetch:provider(candidate)});
    assert.equal((await service.interpret('阅读每次5分', state, now, {context:'pointItemCreate'})).kind, 'clarify');
  }
  let calls = 0;
  const service = createAssistantService({apiKey:'test-key',fetch:async () => { calls++; throw new Error('unexpected provider call'); }});
  assert.equal((await service.interpret('阅读每次5分', state, now, {context:'pointItemCreate',targetId:state.pointItems[0].id})).kind, 'clarify');
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(state), before);
});

test('only DeepSeek new-template requests disable provider thinking', async () => {
  const state = seed();
  for (const [baseUrl, context, disabled] of [
    ['https://api.deepseek.com', 'pointItemCreate', true],
    ['https://api.deepseek.com/v1', 'pointItemCreate', true],
    ['https://api.deepseek.com', 'general', false],
    ['https://api.deepseek.com', 'points', false],
    ['https://api.deepseek.com', 'pointItems', false],
    ['https://other.example.test/v1', 'pointItemCreate', false],
    ['https://api.deepseek.com.example.test/v1', 'pointItemCreate', false]
  ]) {
    let calls = 0;
    const candidate = context === 'pointItemCreate' ? {kind:'form',form:'pointItem',fields:{name:'阅读',points:5}} : {kind:'clarify',question:'请补充内容'};
    const service = createAssistantService({apiKey:'test-key',baseUrl,fetch:provider(candidate, (url, options) => {
      calls++;
      const request = JSON.parse(options.body);
      assert.deepEqual(request.thinking, disabled ? {type:'disabled'} : undefined, baseUrl + ' ' + context);
      assert.equal(request.max_tokens, 650);
    })});
    await service.interpret('阅读每次5分', state, now, {context});
    assert.equal(calls, 1);
  }
});

test('form-only configuration sends new-template inputs to the provider while other contexts stay local', async () => {
  const state = seed(), before = JSON.stringify(state);
  let calls = 0;
  const service = createAssistantService({apiKey:'test-key',formOnly:true,fetch:provider(
    {kind:'form',form:'pointItem',fields:{name:'自己读书满20分钟',points:5}},
    () => { calls++; }
  )});
  assert.deepEqual(service.status(), {mode:'connected',label:'AI 已配置',formOnly:true});
  for (const [context, text, kind] of [
    ['general', '我还有多少积分', 'answer'],
    ['points', '行为：阅读，加5分', 'action'],
    ['pointItems', '新增常用项：整理书包，3分', 'action']
  ]) {
    const result = await service.interpret(text, state, now, {context});
    assert.equal(result.kind, kind, JSON.stringify(result));
    assert.equal(result.mode, 'local');
    assert.equal(result.label, '指令演示');
  }
  assert.equal(calls, 0, 'general, points and management do not cross the provider boundary');
  const created = await service.interpret('以后自己读书满二十分钟，奖励五分', state, now, {context:'pointItemCreate'});
  assert.equal(created.kind, 'action');
  assert.equal(created.mode, 'connected');
  assert.deepEqual(created.action.payload.item, {name:'自己读书满20分钟',points:5});
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(state), before);
  assert.deepEqual(createAssistantService({apiKey:'',formOnly:true}).status(), {mode:'local',label:'指令演示'});
  assert.deepEqual(createAssistantService({apiKey:'test-key',formOnly:false}).status(), {mode:'connected',label:'AI 已配置'});
});

test('AI_FORM_ONLY enables the same scope and an explicit false preserves general-provider deployments', async () => {
  const previous = process.env.AI_FORM_ONLY;
  try {
    process.env.AI_FORM_ONLY = '1';
    let calls = 0;
    const fetch = provider({kind:'query',query:{type:'balance'}}, () => { calls++; });
    const scoped = createAssistantService({apiKey:'test-key',fetch});
    assert.equal(scoped.status().formOnly, true);
    assert.equal((await scoped.interpret('我还有多少积分', seed(), now)).mode, 'local');
    assert.equal(calls, 0);
    const general = createAssistantService({apiKey:'test-key',formOnly:false,fetch});
    assert.deepEqual(general.status(), {mode:'connected',label:'AI 已配置'});
    assert.equal((await general.interpret('我还有多少积分', seed(), now)).mode, 'connected');
    assert.equal(calls, 1);
  } finally {
    if (previous === undefined) { delete process.env.AI_FORM_ONLY; }
    else { process.env.AI_FORM_ONLY = previous; }
  }
});
