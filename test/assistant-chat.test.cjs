'use strict';
process.env.TZ='Asia/Shanghai';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const M=require('../model.js');
const T=require('../assistant-tools.cjs');
const {createAssistantService}=require('../assistant-service.cjs');
const now=new Date('2026-11-22T09:00:00+08:00');
const seed=()=>M.createSeed(now);
const validAvatar='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+KvAkAAAAASUVORK5CYII=';
const local=()=>createAssistantService({apiKey:'',chatEnabled:false});
function provider(message,inspect) {
  return async (url,options)=>{
    if (inspect) inspect(url,options,JSON.parse(options.body));
    return new Response(JSON.stringify({choices:[{message}]}),{status:200,headers:{'Content-Type':'application/json'}});
  };
}
function jsonText(candidate,inspect) {
  return createAssistantService({apiKey:'test-key',chatEnabled:true,fetch:provider({content:JSON.stringify(candidate)},inspect)});
}
function natural(content,inspect) { return createAssistantService({apiKey:'test-key',chatEnabled:true,fetch:provider({content},inspect)}); }
function tools(calls,inspect) {
  return createAssistantService({apiKey:'test-key',chatEnabled:true,fetch:provider({tool_calls:calls.map(([name,args],index)=>({id:'call-'+index,type:'function',function:{name,arguments:JSON.stringify(args)}}))},inspect)});
}
function types(result) { return (result.kind==='steps'?result.steps:[result]).filter(row=>row.kind==='action').map(row=>row.action.type); }

test('config: system prompts and 24 public tool contracts are readable and server-bounded',()=>{
  for (const name of ['system.md','legacy-system.md','point-item-create-system.md','tools.json']) assert.ok(fs.readFileSync(path.join(__dirname,'..','config','assistant',name),'utf8').length>100);
  const definitions=T.toolDefinitions(); assert.equal(definitions.length,24);
  for (const tool of definitions) { assert.equal(tool.type,'function'); assert.ok(tool.function.description); assert.equal(tool.function.parameters.additionalProperties,false); }
  assert.equal(T.validateCall('__proto__',{}),false);
  assert.equal(T.validateCall('read_balance',{grant:'fake'}),false);
  assert.equal(T.validateCall('read_ledger',{days:0}),false);
  assert.equal(T.validateCall('read_tasks',{date:'2026-11-22',includeDone:'true'}),false);
  for (const after of [[],[-1],[6],[0,0]]) assert.equal(T.validateCall('read_balance',{after}),false);
  assert.equal(T.validateCall('read_balance',{after:[0]}),true); assert.equal(T.validateCall('cancel_draft',{}),true);
  definitions[0].function.name='changed'; assert.equal(T.toolDefinitions()[0].function.name,'read_balance');
});
test('local: recurring rule and a single actual award stay distinct without writing state',async()=>{
  const state=seed(),before=JSON.stringify(state),service=local();
  const rule=await service.chat('以后自己读书满二十分钟，奖励五分',state,now);
  const award=await service.chat('今天独立阅读加5分',state,now);
  assert.equal(rule.action.type,'pointItem.save'); assert.equal(rule.action.payload.item.points,5);
  assert.deepEqual(award.action,{type:'points.add',payload:{name:'独立阅读',points:5}});
  assert.equal(award.source,'local'); assert.equal(award.mode,'local');
  assert.equal(JSON.stringify(state),before);
});
test('local: a homophone in an award keeps the behavior and score without awarding ordinary portions',async()=>{
  const service=local(), state=seed();
  state.pointItems.push({id:'water-plants',name:'照看薄荷',points:5,enabled:true});
  state.pointItems.push({id:'disabled-plants',name:'照看罗勒',points:5,enabled:false});
  const before=JSON.stringify(state);
  for (const [input,name,points] of [
    ['自己刷牙加一份','自己刷牙',1],
    ['自己刷牙加一分','自己刷牙',1],
    ['自己睡觉加一份','自己睡觉',1],
    ['自己睡觉，加 １ 份！','自己睡觉',1],
    ['照看薄荷，加 2 份。','照看薄荷',2],
    ['照看薄荷，加２份！','照看薄荷',2]
  ]) {
    const result=await service.chat(input,state,now);
    assert.deepEqual(result.action,{type:'points.add',payload:{name,points}},input);
  }
  for (const input of ['早餐再加一份','给我一份早餐','刷牙杯加一份','不要给自己刷牙加一份',
    '照看罗勒加一份','自己睡觉加一份早餐','自己睡觉加一份吗？','自己睡觉不加一份',
    '自己睡觉加一份，刷牙加二份','早餐+1份']) {
    assert.ok(!types(await service.chat(input,state,now)).includes('points.add'),input);
  }
  assert.equal(JSON.stringify(state),before);
});

test('local: a single positive award sign preserves the behavior as an uncommitted draft',async()=>{
  const service=local(),state=seed(),before=JSON.stringify(state);
  for (const [input,name,points] of [
    ['自己睡觉+1分','自己睡觉',1],
    ['自己睡觉 ＋ １ 分。','自己睡觉',1],
    ['自己睡觉，+ 1 分！','自己睡觉',1],
    ['行为：自己睡觉，＋１分。','自己睡觉',1],
    ['自己刷牙+一分','自己刷牙',1],
    ['整理书包 + ２ 分!','整理书包',2],
    ['自己睡觉加１分。','自己睡觉',1],
    ['主动帮助别人+1分','主动帮助别人',1],
    ['主动请教问题+1分','主动请教问题',1],
    ['没有挑食+1分','没有挑食',1],
    ['不用提醒就自己刷牙+1分','不用提醒就自己刷牙',1],
    ['独立阅读20分钟+1分','独立阅读20分钟',1]
  ]) {
    const result=await service.chat(input,state,now);
    assert.equal(result.kind,'action',input+': '+JSON.stringify(result));
    assert.deepEqual(result.action,{type:'points.add',payload:{name,points}},input);
    assert.equal(result.source,'local');
    assert.equal(result.mode,'local');
  }
  assert.equal(JSON.stringify(state),before,'the assistant only prepares an editable draft');
});

test('local: positive award notation does not turn questions, negations or calculations into awards',async()=>{
  const service=local(),state=seed(),before=JSON.stringify(state);
  for (const input of [
    '+1分','35+100等于多少','35+100分','自己睡觉+1+2分','自己睡觉+-1分','自己睡觉＋－１分',
    '自己睡觉+1.5分','自己睡觉＋１．５分','自己睡觉+1分，刷牙+2分','自己睡觉+1分还是+2分',
    '自己睡觉+1分钟','自己睡觉加一份钟','自己睡觉+1分吗？','自己睡觉+1分？',
    '不要给自己睡觉+1分','自己睡觉别+1分','别给自己睡觉＋１分','自己睡觉-1分',
    '自己睡觉+1分，1+2等于几','没有自己睡觉+1分','不想给自己睡觉+1分',
    '自己睡觉无需+1分','查询自己睡觉+1分','查看自己睡觉+1分','如果自己睡觉+1分',
    '三十五+一百分','查一下自己睡觉+1分','自己睡觉不需要+1分','自己睡觉不用+1分',
    '不用给自己睡觉+1分','不需要给自己睡觉+1分','请问自己睡觉+1分',
    '自己睡觉没必要+1分','没必要给自己睡觉+1分'
  ]) {
    assert.ok(!types(await service.chat(input,state,now)).includes('points.add'),input);
  }
  assert.equal(JSON.stringify(state),before);
});

test('local: plus signs in reminder text keep the existing reminder route',async()=>{
  const state=seed(),before=JSON.stringify(state);
  const result=await local().chat('明天七点提醒做1+1练习题',state,now);
  assert.equal(result.kind,'action',JSON.stringify(result));
  assert.deepEqual(result.action,{type:'task.save',payload:{task:{type:'task',title:'做1+1练习题',date:'2026-11-23',time:'07:00',note:'',remindDays:0}}});
  assert.equal(JSON.stringify(state),before);
});
test('local: unspecified reasons never overwrite a manually completed award form',async()=>{
  for (const text of ['今天独立阅读加5分','行为：阅读，加5分','自主阅读，加5分']) {
    const result=await local().chat(text,seed(),now,{context:{form:'points',view:'points'}});
    assert.equal(result.kind,'action',JSON.stringify(result));
    assert.equal(Object.hasOwn(result.action.payload,'reason'),false);
    const manuallyFilled={name:'手填行为',points:3,reason:'自己选了一本书'};
    assert.equal({...manuallyFilled,...result.action.payload}.reason,'自己选了一本书');
  }
  const explicit=await local().chat('行为：阅读，原因：自己选了一本书，加5分',seed(),now);
  assert.equal(explicit.action.payload.reason,'自己选了一本书');
});
test('local: incomplete rules retain known fields and accept a later score',async()=>{
  const service=local(),state=seed(),draft=await service.chat('每天阅读20分钟',state,now);
  assert.equal(draft.kind,'form'); assert.deepEqual(draft.fields,{name:'每天阅读20分钟'});
  const next=await service.chat('5分',state,now,{draft,messages:[{role:'user',text:'每天阅读20分钟'}]});
  assert.equal(next.action.type,'pointItem.save'); assert.equal(next.action.payload.item.points,5);
  assert.equal(next.action.payload.item.name,'每天阅读20分钟');
});
test('local: the latest correction switches between rule and award without borrowing a preset reason',async()=>{
  const service=local(),state=seed();
  const rule=await service.chat('每天独立阅读，每次5分',state,now);
  const once=await service.chat('不是规则，只给这次，改成8分',state,now,{draft:rule});
  assert.equal(once.action.type,'points.add'); assert.equal(once.action.payload.points,8); assert.equal(once.action.payload.reason,undefined);
  const recurring=await service.chat('不是这次，是以后每次，改成6分',state,now,{draft:once});
  assert.equal(recurring.action.type,'pointItem.save'); assert.equal(recurring.action.payload.item.points,6);
});
test('local: rule edits require a unique current entity and keep untouched fields',async()=>{
  const state=seed(),before=JSON.stringify(state),service=local();
  const result=await service.chat('把自主阅读改成每次8分',state,now);
  assert.equal(result.action.payload.item.id,'point-reading'); assert.equal(result.action.payload.item.points,8);
  assert.equal(result.action.payload.item.reason,state.pointItems[0].reason);
  state.pointItems.push({...state.pointItems[0],id:'duplicate-reading'});
  assert.equal((await service.chat('把自主阅读改成每次8分',state,now)).kind,'clarify');
  state.pointItems.pop(); assert.equal(JSON.stringify(state),before);
});
test('local: selected rule and reminder edits work with short corrections',async()=>{
  const service=local(),state=seed();
  const rule=await service.chat('分值改为8分',state,now,{context:{form:'pointItem',targetId:'point-reading'}});
  assert.equal(rule.action.payload.item.id,'point-reading'); assert.equal(rule.action.payload.item.points,8);
  const reminder=await service.chat('改到明天八点',state,now,{context:{form:'task',view:'reminders',targetId:'task-bag'}});
  assert.equal(reminder.action.payload.task.id,'task-bag'); assert.equal(reminder.action.payload.task.date,'2026-11-23');
  assert.equal(reminder.action.payload.task.time,'08:00');
});
test('local: balance, ledger, week, rules, requests and settings are deterministic live queries',async()=>{
  const state=M.apply(seed(),{id:'pet-spend',type:'pet.buy',itemId:'snack',quantity:1,expectedPoints:3},now),before=JSON.stringify(state),service=local();
  const balance=await service.chat('积分余额',state,now), ledger=await service.chat('查看积分流水',state,now), week=await service.chat('查看七日小结',state,now);
  assert.equal(balance.data.available,85); assert.equal(ledger.data.rows.find(row=>row.kind==='partner').points,-3); assert.equal(week.data.available,85);
  assert.equal((await service.chat('有哪些常用行为规则',state,now)).query.type,'rules');
  assert.equal((await service.chat('看看兑换申请记录',state,now)).data.rows.length,0);
  assert.equal((await service.chat('查看家庭积分设置',state,now)).data.monthEndDays,3);
  assert.equal(JSON.stringify(state),before);
});
test('local: reward queries use availability and never propose redemption for only-check requests',async()=>{
  const state=seed(),before=JSON.stringify(state),service=local();
  const result=await service.chat('只查不兑，看看够不够换汉堡',state,now);
  assert.equal(result.kind,'answer'); assert.equal(result.data.rows.length,1); assert.equal(result.data.rows[0].id,'reward-burger');
  assert.equal(result.data.rows[0].allowed,true); assert.deepEqual(types(result),[]);
  const weekday=await service.chat('只查不兑，看看够不够换汉堡',state,new Date('2026-11-23T09:00:00+08:00'));
  assert.equal(weekday.data.rows[0].allowed,false); assert.match(weekday.answer,/周六|周日/);
  const selected=await service.chat('选定礼品还差多少分',state,now,{context:{form:'reward',targetId:'reward-trip'}});
  assert.equal(selected.data.rows[0].gap,92);
  assert.equal(JSON.stringify(state),before);
});
test('local: a reminder completion is a candidate and never silently awards points',async()=>{
  const state=seed(),before=JSON.stringify(state);
  const result=await local().chat('完成读一会儿喜欢的书',state,now);
  assert.deepEqual(result.action,{type:'task.toggle',payload:{taskId:'task-reading'}});
  assert.equal(JSON.stringify(state),before);
});
test('local: verification, family, partner, farm and profile requests route without networking',async()=>{
  const service=local();
  for (const [text,route] of [['帮我答家长验证题','parent'],['邀请家庭成员','family'],['给伙伴换装扮','partner'],['打开农场','farm'],['修改孩子头像','profile']]) {
    const result=await service.chat(text,seed(),now); assert.equal(result.kind,'route'); assert.equal(result.route,route); assert.equal(result.source,'local');
  }
});
test('local: an explicitly configured legacy provider does not authorize sending ordinary chat',async()=>{
  let calls=0;
  const service=createAssistantService({apiKey:'test-key',chatEnabled:false,formOnly:false,fetch:async()=>{calls++;throw new Error('unexpected');}});
  assert.equal((await service.chat('积分余额',seed(),now)).source,'local'); assert.equal(calls,0);
  assert.equal(service.status().mode,'connected'); assert.equal(service.chatStatus().mode,'local');
});
test('local: form-only AI keeps its isolated new-rule flow and never sends history or drafts',async()=>{
  let calls=0;
  const service=createAssistantService({apiKey:'test-key',formOnly:true,chatEnabled:false,fetch:provider({content:JSON.stringify({kind:'form',form:'pointItem',fields:{name:'每天阅读20分钟',points:5}})},(_url,_options,body)=>{
    calls++; const input=JSON.parse(body.messages[1].content);
    assert.deepEqual(input.context,{inputMode:'pointItemCreate'}); assert.equal(input.messages,undefined); assert.equal(input.draft,undefined);
    assert.doesNotMatch(JSON.stringify(body),/HISTORY_PRIVATE|PRIVATE_PARENT|PRIVATE_AVATAR|seed-p1/);
  })});
  const state=seed(); state.parent={hash:'PRIVATE_PARENT'}; state.childAvatar=validAvatar;
  const result=await service.chat('每天阅读20分钟，奖励5分',state,now,{context:{form:'pointItem'},messages:[{role:'user',text:'HISTORY_PRIVATE'}]});
  assert.equal(result.mode,'connected'); assert.equal(result.action.type,'pointItem.save'); assert.equal(calls,1);
  await service.chat('积分余额',seed(),now,{context:{form:'pointItem'},messages:[{role:'user',text:'HISTORY_PRIVATE'}]}); assert.equal(calls,1);
});
test('local: Shanghai family day is preserved when the host timezone is UTC',async()=>{
  const prior=process.env.TZ; process.env.TZ='UTC';
  try {
    const actual=new Date('2026-11-22T16:30:00Z'),result=await local().chat('今天早上七点半提醒带水杯',seed(),actual);
    assert.equal(result.action.payload.task.date,'2026-11-23'); assert.equal(result.action.payload.task.time,'07:30');
    assert.equal((await local().chat('查看七日小结',seed(),actual)).data.to,'2026-11-23');
  } finally { process.env.TZ=prior; }
});
test('model: trusted tool calls read minimized state and keep bounded history as conversation data',async()=>{
  const state=seed(); state.parent={hash:'PRIVATE_AUTH'}; state.childAvatar=validAvatar; state.pointItems[0].reason='PRIVATE_PRESET';
  let calls=0;
  const service=tools([['read_balance',{}]],(_url,options,body)=>{
    calls++; const input=JSON.parse(body.messages[1].content);
    assert.equal(input.context.familyDay,'2026-11-22'); assert.equal(input.messages.length,3); assert.equal(input.messages[0].text,'我想查看积分');
    assert.match(input.messages[1].text,/密码.*解释密码管理/); assert.equal(input.messages[2].role,'assistant'); assert.equal(input.messages[2].text,'FABRICATED_ANSWER');
    assert.equal(body.tools.length,24); assert.doesNotMatch(options.body,/PRIVATE_AUTH|PRIVATE_PRESET|CREDENTIAL_SENTINEL|999999|seed-p1|seed-r1/);
    assert.doesNotMatch(options.body,/data:image/);
  });
  const result=await service.chat('积分余额',state,now,{messages:[{role:'user',text:'我想查看积分'},{role:'user',text:'密码 CREDENTIAL_SENTINEL，解释密码管理'},{role:'assistant',text:'FABRICATED_ANSWER',result:{answer:'999999分'}}]});
  assert.equal(result.mode,'connected'); assert.equal(result.source,'model'); assert.equal(result.data.available,88); assert.equal(calls,1);
});
test('model: an enabled but unconfigured provider reports unavailable without invoking the local interpreter',async()=>{
  const service=createAssistantService({chatEnabled:true,apiKey:''});
  assert.equal(service.chatStatus().mode,'unavailable');
  await assert.rejects(service.chat('今天阅读加5分',seed(),now),/ASSISTANT_UNAVAILABLE/);
});
test('model: explicit credentials are masked in the outgoing turn and past messages',async()=>{
  const instruction='家长 PIN 是 135790，密码为“山楂 月亮”，请介绍家长验证。';
  const history='{"password":"!synthetic only","otp":"643210"}，密码如下：PRIVATE_A，核验题的答案是PRIVATE_B';
  const draft={kind:'action',action:{type:'points.add',payload:{name:'阅读',points:3,reason:'我的登录密码是： PRIVATE_C，密码就是PRIVATE_D'}}};
  const service=natural('请在应用的家长验证页面设置。',(_url,options,body)=>{
    const input=JSON.parse(body.messages[1].content);
    assert.doesNotMatch(options.body,/135790|山楂|月亮|synthetic only|643210|PRIVATE_[ABCD]/);
    assert.match(input.instruction,/请介绍家长验证/);
    assert.match(input.messages[0].text,/已隐藏/);
  });
  const result=await service.chat(instruction,seed(),now,{messages:[{role:'user',text:history}],draft});
  assert.equal(result.source,'model');
});

test('model: unrelated catalogs stay local and truncation or ambiguous matches are explicit',async()=>{
  const state=seed(); state.tasks[0].title='UNRELATED_TASK_SENTINEL'; state.rewards[0].name='UNRELATED_REWARD_SENTINEL';
  const service=tools([['read_balance',{}]],(_url,options,body)=>{
    const context=JSON.parse(body.messages[1].content).context;
    assert.deepEqual(context.tasks,[]); assert.deepEqual(context.pointItems,[]); assert.deepEqual(context.rewards,[]);
    assert.doesNotMatch(options.body,/UNRELATED_TASK_SENTINEL|UNRELATED_REWARD_SENTINEL/);
  });
  await service.chat('积分余额',state,now);
  for (let index=0;index<8;index++) state.rewards.push({id:'matching-'+index,name:'绘本',points:10,category:'daily',icon:'pencil',enabled:true});
  const duplicate=tools([['read_rewards',{}]],(_url,_options,body)=>{
    const context=JSON.parse(body.messages[1].content).context;
    assert.equal(context.rewards.length,6); assert.equal(context.disclosure.truncated.rewards,true); assert.equal(context.disclosure.ambiguous.rewards,true);
  });
  await duplicate.chat('绘本够不够',state,now);
});
test('model: selected older quotations and assistant wording survive within the history budget',async()=>{
  const messages=[{role:'user',text:'EARLY_RELEVANT_RULE 阅读每次8分'}];
  for (let index=0;index<8;index++) messages.push({role:'user',text:'近期对话'+index},{role:'assistant',text:'只读旧回答'+index});
  const service=tools([['read_rules',{}]],(_url,_options,body)=>{
    const history=JSON.parse(body.messages[1].content).messages;
    assert.equal(history.length,17); assert.match(history[0].text,/EARLY_RELEVANT_RULE/); assert.equal(history.at(-1).text,'只读旧回答7');
    assert.equal(history.at(-1).role,'assistant');
  });
  assert.equal((await service.chat('查看常用行为规则',seed(),now,{messages})).source,'model');
});
test('model: a typed balance query computes live data while untyped prose stays model wording',async()=>{
  const state=seed(),before=JSON.stringify(state);
  const result=await tools([['read_balance',{}]]).chat('随便看一项',state,now);
  assert.equal(result.kind,'answer'); assert.equal(result.data.available,88); assert.doesNotMatch(result.answer,/999999/); assert.equal(result.source,'model');
  const prose=await natural('你有999999分。').chat('积分余额',state,now);
  assert.equal(prose.scope,'conversation'); assert.equal(prose.answer,'你有999999分。'); assert.equal(prose.query,undefined); assert.deepEqual(types(prose),[]);
  assert.equal(JSON.stringify(state),before);
});
test('model: unknown tools and extra argument fields fail without local reinterpretation',async()=>{
  for (const call of [['grant_parent',{}],['draft_award',{name:'阅读',points:5,grant:'fake'}],['read_balance',{familyId:'other'}]]) {
    const state=seed(),before=JSON.stringify(state);
    await assert.rejects(tools([call]).chat('今天阅读加5分',state,now),error=>error instanceof Error && !/test-key|fake|other/.test(error.message));
    assert.equal(JSON.stringify(state),before);
  }
});
test('model: native tools remain an explicit allowlist without sensitive actions or extra parameters',async()=>{
  const state=seed(),before=JSON.stringify(state);
  for (const name of ['parent.configure','family.delete','pet.buy','pet.care','points.delete','__proto__']) {
    await assert.rejects(tools([[name,{}]]).chat('帮我处理一下',state,now));
  }
  for (const call of [['draft_award',{name:'阅读',points:5,saveAsTemplate:true}],['draft_direct_redemption',{rewardId:'reward-burger',expectedPoints:1}]]) {
    await assert.rejects(tools([call]).chat('今天阅读加5分',state,now));
  }
  assert.equal(JSON.stringify(state),before);
});
test('model: valid explicit entity IDs control candidates while missing IDs remain invalid',async()=>{
  const state=seed();
  const selected=await tools([['draft_rule',{id:'point-focus',points:8}]]).chat('把这个改成每次8分',state,now,{context:{form:'pointItem',targetId:'point-reading'}});
  assert.equal(selected.kind,'action'); assert.equal(selected.action.payload.item.id,'point-focus'); assert.equal(selected.source,'model');
  state.pointItems.push({...state.pointItems[0],id:'duplicate-reading'}); const before=JSON.stringify(state);
  const duplicate=await tools([['draft_rule',{id:'point-reading',points:8}]]).chat('把自主阅读改成每次8分',state,now);
  assert.equal(duplicate.kind,'action'); assert.equal(duplicate.action.payload.item.id,'point-reading');
  const unknown=await tools([['draft_rule',{id:'missing-rule',points:8}]]).chat('处理这个',state,now);
  assert.equal(unknown.kind,'clarify'); assert.equal(unknown.source,'model'); assert.deepEqual(types(unknown),[]);
  assert.equal(JSON.stringify(state),before);
});
test('model: valid provider scores are not replaced by numbers parsed from the utterance',async()=>{
  const state=seed(),before=JSON.stringify(state),draft={kind:'action',action:{type:'pointItem.save',payload:{item:{name:'阅读',points:5}}}};
  for (const text of ['每天阅读20分钟','每天阅读3次','每天阅读奖励3.5分','每天阅读奖励-5分','改成8分']) {
    const result=await tools([['draft_rule',{name:'模型选择的规则',points:13}]]).chat(text,state,now,{draft,messages:[{role:'user',text:'每天阅读奖励5分'}]});
    assert.equal(result.kind,'action',text+JSON.stringify(result)); assert.equal(result.action.payload.item.name,'模型选择的规则'); assert.equal(result.action.payload.item.points,13); assert.equal(result.source,'model');
  }
  const incomplete=await tools([['draft_rule',{name:'先保留名称'}]]).chat('每次8分',state,now);
  assert.equal(incomplete.kind,'form'); assert.equal(incomplete.fields.name,'先保留名称'); assert.equal(incomplete.fields.points,undefined);
  for (const points of [3.5,-5,0]) {
    await assert.rejects(tools([['draft_rule',{name:'无效规则',points}]]).chat('随意处理',state,now));
  }
  assert.equal(JSON.stringify(state),before);
});
test('model: provider award names and reasons remain intact without text-based rewriting',async()=>{
  const state=seed(),before=JSON.stringify(state);
  for (const reason of ['', '今天独立阅读','从未提到的原因']) {
    const result=await tools([['draft_award',{name:'模型选择的行为',points:5,reason}]]).chat('今天独立阅读加5分',state,now);
    assert.equal(result.kind,'action'); assert.equal(result.action.payload.name,'模型选择的行为'); assert.equal(result.action.payload.reason,reason); assert.equal(result.source,'model');
  }
  const without=await tools([['draft_award',{name:'阅读',points:5}]]).chat('阅读加5分，原因：自己选了一本书',state,now);
  assert.equal(Object.hasOwn(without.action.payload,'reason'),false,'the program does not add omitted model fields');
  assert.equal(JSON.stringify(state),before);
});
test('model: provider chooses award, rule or redemption candidate independently of wording',async()=>{
  const state=seed(),before=JSON.stringify(state);
  const award=await tools([['draft_award',{name:'阅读',points:5}]]).chat('以后每天阅读每次5分',state,now);
  assert.equal(award.kind,'action'); assert.equal(award.action.type,'points.add'); assert.equal(award.source,'model');
  for (const [name,type] of [['draft_redemption_request','redemption.request'],['draft_direct_redemption','reward.redeem']]) {
    const result=await tools([[name,{rewardId:'reward-burger'}]]).chat('只查不兑，看看够不够换汉堡',state,now);
    assert.equal(result.kind,'action'); assert.equal(result.action.type,type); assert.equal(result.source,'model');
  }
  assert.equal(JSON.stringify(state),before,'model proposals never perform the mutation');
});
test('model: approval, cancellation, direct redemption, deletion and settings are only validated candidates',async()=>{
  const state=M.apply(seed(),{id:'request-burger',type:'redemption.request',rewardId:'reward-burger'},now),before=JSON.stringify(state),request=state.requests[0];
  for (const [name,args,text,type] of [
    ['draft_redemption_approval',{requestId:request.id},'批准一起吃汉堡申请','redemption.approve'],
    ['draft_redemption_cancel',{requestId:request.id},'取消一起吃汉堡申请','redemption.cancel'],
    ['draft_direct_redemption',{rewardId:'reward-burger'},'直接兑换一起吃汉堡','reward.redeem'],
    ['draft_rule_delete',{itemId:'point-reading'},'删除自主阅读常用行为','pointItem.delete'],
    ['draft_settings',{monthEndDays:5},'把月末天数设为5天','settings.update']
  ]) {
    const result=await tools([[name,args]]).chat(text,state,now); assert.equal(result.kind,'action',JSON.stringify(result)); assert.equal(result.action.type,type);
  }
  assert.equal(JSON.stringify(state),before);
});
test('model: provider failures, timeout and invalid transport reject instead of invoking local rules',async()=>{
  const state=seed(),before=JSON.stringify(state),failures=[
    createAssistantService({apiKey:'PRIVATE_KEY',chatEnabled:true,fetch:async()=>{throw new Error('PRIVATE_KEY PRIVATE_HOST');}}),
    createAssistantService({apiKey:'test-key',chatEnabled:true,timeoutMs:5,fetch:(_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('PRIVATE_TIMEOUT'))))}),
    createAssistantService({apiKey:'test-key',chatEnabled:true,fetch:async()=>new Response('x'.repeat(262145),{status:200})}),
    createAssistantService({apiKey:'test-key',chatEnabled:true,fetch:async()=>new Response('{}',{status:503})}),
    createAssistantService({apiKey:'test-key',chatEnabled:true,fetch:async()=>new Response('{bad envelope',{status:200})}),
    createAssistantService({apiKey:'test-key',chatEnabled:true,fetch:async()=>new Response('{"choices":[]}',{status:200})})
  ];
  for (const service of failures) await assert.rejects(service.chat('积分余额',state,now),error=>error instanceof Error && !/PRIVATE_|test-key/.test(error.message));
  assert.equal(JSON.stringify(state),before);
  const disabled=await local().chat('积分余额',state,now);
  assert.equal(disabled.data.available,88); assert.equal(disabled.source,'local'); assert.equal(disabled.mode,'local');
});
test('followup: committed status reaches the model and a new proposal still waits for confirmation',async()=>{
  const state=seed(),before=JSON.stringify(state),draft={kind:'action',action:{type:'points.add',payload:{name:'阅读',points:5}}}; let calls=0;
  const service=tools([['draft_award',{name:'模型新候选',points:8}]],(_url,_options,body)=>{
    calls++; const input=JSON.parse(body.messages[1].content); assert.deepEqual(input.draft,draft); assert.equal(input.draftStatus.actions[0].status,'committed');
  });
  const result=await service.chat('改成8分',state,now,{draft,draftStatus:{actions:[{index:0,type:'points.add',status:'committed'}],sourceRevision:2,familyDay:'2026-11-22'}});
  assert.equal(result.kind,'action'); assert.equal(result.action.payload.name,'模型新候选'); assert.equal(result.action.payload.points,8); assert.equal(result.source,'model'); assert.equal(calls,1);
  assert.equal(JSON.stringify(state),before);
});
test('followup: ordered draft context keeps real statuses and excludes action credentials',async()=>{
  const draft={kind:'steps',steps:[{kind:'action',action:{type:'points.add',payload:{name:'阅读',points:5}}},{kind:'route',route:'points'},{kind:'action',action:{type:'task.save',payload:{task:{title:'带水杯',date:'2026-11-23',time:'08:00',type:'task'}}}}]};
  const service=tools([['read_balance',{}]],(_url,options,body)=>{
    const input=JSON.parse(body.messages[1].content); assert.deepEqual(input.draft,draft);
    assert.deepEqual(input.draftStatus.actions,[{index:0,type:'points.add',status:'committed'},{index:2,type:'task.save',status:'pending'}]); assert.doesNotMatch(options.body,/ACTION_CREDENTIAL/);
  });
  await service.chat('现在积分余额',seed(),now,{draft,draftStatus:{actions:[{index:0,actionId:'ACTION_CREDENTIAL',type:'points.add',status:'committed'},{index:2,type:'task.save',status:'pending'}]}});
});
test('followup: add-then-check waits for the real commit, sees the new balance, and never requests redemption',async()=>{
  const state=seed(); state.rewards.push({id:'reward-book',name:'绘本',points:93,category:'daily',icon:'pencil',enabled:true});
  const before=JSON.stringify(state),result=await local().chat('今天独立阅读加5分，加完看看能不能换绘本，先别兑换',state,now);
  assert.equal(result.kind,'steps',JSON.stringify(result)); assert.deepEqual(types(result),['points.add']);
  const deferred=result.steps[1]; assert.equal(deferred.deferred,true); assert.deepEqual(deferred.after,[0]); assert.equal(deferred.data,undefined); assert.doesNotMatch(deferred.answer,/88|不够|还差/);
  assert.equal(T.read('read_rewards',{rewardId:'reward-book'},state,now).data.rows[0].allowed,false);
  assert.deepEqual(T.resolveFollowup(result,state,now,{committedIndexes:[]}),result);
  const saved=M.apply(state,{id:'confirmed-award',type:'points.add',...result.steps[0].action.payload},now);
  const resolved=T.resolveFollowup(result,saved,now,{committedIndexes:[0]});
  assert.equal(resolved.steps[1].deferred,false); assert.equal(resolved.steps[1].data.available,93); assert.equal(resolved.steps[1].data.rows[0].allowed,true);
  assert.equal(saved.requests.length,0); assert.equal(saved.redemptions.length,state.redemptions.length); assert.equal(JSON.stringify(state),before);
});
test('followup: model tools defer reads only through typed dependencies and refresh after a real commit',async()=>{
  const calls=[['draft_award',{name:'独立阅读',points:5}],['read_rewards',{rewardId:'reward-burger',after:[0]}]];
  const state=seed(),before=JSON.stringify(state),result=await tools(calls).chat('按你理解安排',state,now);
  assert.equal(result.steps[1].deferred,true); assert.deepEqual(result.steps[1].after,[0]); assert.equal(result.steps[1].data,undefined);
  assert.deepEqual(T.resolveFollowup(result,state,now,{committedIndexes:[]}),result);
  const monday=new Date('2026-11-23T09:00:00+08:00'),updated=M.apply(state,{id:'confirmed-monday',type:'points.add',name:'独立阅读',points:5},monday);
  const resolved=T.resolveFollowup(result,updated,monday,{committedIndexes:[0]});
  assert.equal(resolved.steps[1].data.available,93); assert.equal(resolved.steps[1].data.rows[0].allowed,false); assert.match(resolved.steps[1].answer,/周六|周日/);
  const immediate=await tools([calls[0],['read_rewards',{rewardId:'reward-burger'}]]).chat('独立阅读加5分，然后看看汉堡够不够，先别兑换',state,now);
  assert.notEqual(immediate.steps[1].deferred,true); assert.equal(immediate.steps[1].data.available,88);
  assert.equal(JSON.stringify(state),before);
});
test('followup: missing dependencies and unknown query types cannot trigger writes or invented answers',()=>{
  const state=seed(),before=JSON.stringify(state),result={kind:'steps',steps:[{kind:'action',action:{type:'points.add',payload:{name:'阅读',points:5}}},{kind:'answer',deferred:true,after:[0],query:{type:'parent.secret'},answer:'等待核对'}]};
  assert.deepEqual(T.resolveFollowup(result,state,now,{committedIndexes:[]}),result);
  assert.equal(T.resolveFollowup(result,state,now,{committedIndexes:[0]}).steps[1].kind,'clarify'); assert.equal(JSON.stringify(state),before);
});
test('local: score guidance and growth questions return real record facts without labeling children',async()=>{
  const state=seed(),before=JSON.stringify(state),service=local();
  const advice=await service.chat('阅读该给几分？',state,now);
  assert.equal(advice.kind,'answer'); assert.equal(advice.query.type,'guidance'); assert.equal(advice.data.rows[0].points,5); assert.match(advice.answer,/自主阅读.*5 分/);
  const week=await service.chat('这周是不是偷懒',state,now);
  assert.equal(week.kind,'answer'); assert.equal(week.query.topic,'week'); assert.equal(week.data.earned,88); assert.equal(week.data.available,88); assert.doesNotMatch(week.answer,/偷懒|懒惰|不努力/);
  assert.deepEqual(types(advice),[]); assert.deepEqual(types(week),[]); assert.equal(JSON.stringify(state),before);
});
test('local: account and password changes route to account-family UI rather than child profile',async()=>{
  for (const text of ['改邮箱','修改密码','注销账号','登录账号']) assert.equal((await local().chat(text,seed(),now)).route,'family');
  assert.equal((await local().chat('修改孩子头像',seed(),now)).route,'profile');
});
test('local: explicit draft cancellation remains available without AI and does not cancel business requests',async()=>{
  const service=local();
  for (const text of ['取消这张草稿','这笔先不记了','把当前草稿取消']) {
    const state=seed(),before=JSON.stringify(state),result=await service.chat(text,state,now);
    assert.equal(result.cancelDraft,true); assert.equal(result.source,'local'); assert.deepEqual(types(result),[]); assert.equal(JSON.stringify(state),before);
  }
  for (const text of ['取消汉堡申请','取消这张草稿然后帮我加分','已取消','你好']) assert.equal(T.isDraftCancellation(text),false);
  const invented=await jsonText({kind:'answer',cancelDraft:true,query:{type:'balance'}}).chat('积分余额',seed(),now);
  assert.equal(invented.cancelDraft,undefined);
});
test('correction regression: independent queries and new behaviors never reuse the previous draft name',async()=>{
  const service=local(),state=seed(),draft=await service.chat('今天独立阅读加5分',state,now),snapshot=JSON.stringify(draft),before=JSON.stringify(state);
  const query=await service.chat('那帮我看看积分余额',state,now,{draft});
  assert.equal(query.kind,'answer'); assert.equal(query.query.type,'balance'); assert.deepEqual(types(query),[]);
  const rule=await service.chat('每天整理书包，每次3分',state,now,{draft});
  assert.equal(rule.action.type,'pointItem.save'); assert.match(rule.action.payload.item.name,/整理书包/); assert.doesNotMatch(rule.action.payload.item.name,/阅读/);
  const award=await service.chat('这次整理书包加8分',state,now,{draft});
  assert.equal(award.action.type,'points.add'); assert.equal(award.action.payload.name,'整理书包'); assert.equal(award.action.payload.points,8);
  const correction=await service.chat('那把分值改成8分',state,now,{draft});
  assert.equal(correction.action.payload.name,'独立阅读'); assert.equal(correction.action.payload.points,8);
  assert.equal(JSON.stringify(draft),snapshot,'read and independent messages do not mutate the pending draft'); assert.equal(JSON.stringify(state),before);
});
test('correction regression: current wording and prior drafts do not replace a valid model-selected candidate',async()=>{
  const draft={kind:'action',action:{type:'points.add',payload:{name:'独立阅读',points:5}}},snapshot=JSON.stringify(draft),state=seed(),before=JSON.stringify(state);
  const result=await tools([['draft_award',{name:'独立阅读',points:5}]]).chat('那帮我看看积分余额',state,now,{draft});
  assert.equal(result.kind,'action'); assert.equal(result.action.payload.name,'独立阅读'); assert.equal(result.action.payload.points,5); assert.equal(result.source,'model');
  assert.equal(JSON.stringify(draft),snapshot); assert.equal(JSON.stringify(state),before);
});
function weekFixture() {
  const actual=new Date('2026-12-01T09:00:00+08:00'),state=M.createEmptyFamily({childName:'测试孩子'},actual);
  state.pointItems=[{id:'reading-rule',name:'自主阅读',points:5,reason:'',enabled:true},{id:'tidy-rule',name:'整理书包',points:8,reason:'',enabled:true}];
  state.points=[
    {id:'outside-window',itemId:'reading-rule',name:'自主阅读',points:41,reason:'',at:'2026-11-24T01:00:00.000Z'},
    {id:'last-week-reading',itemId:'reading-rule',name:'自主阅读',points:11,reason:'',at:'2026-11-29T15:59:59.000Z'},
    {id:'monday-reading',itemId:'reading-rule',name:'自主阅读',points:5,reason:'',at:'2026-11-29T16:00:00.000Z'},
    {id:'monday-other',itemId:'tidy-rule',name:'整理书包',points:17,reason:'',at:'2026-11-30T01:00:00.000Z'},
    {id:'tuesday-reading',itemId:'reading-rule',name:'独立阅读',points:7,reason:'',at:'2026-12-01T01:00:00.000Z'}
  ];
  return {actual,state};
}
test('week regression: this week starts Monday in Shanghai, crosses months and filters only requested behavior',async()=>{
  const {actual,state}=weekFixture(),before=JSON.stringify(state),service=local();
  const result=await service.chat('这周阅读加了几分',state,actual);
  assert.equal(result.kind,'answer'); assert.equal(result.query.type,'week'); assert.equal(result.query.period,'week'); assert.equal(result.query.behavior,'阅读');
  assert.equal(result.data.from,'2026-11-30'); assert.equal(result.data.to,'2026-12-01'); assert.equal(result.data.earned,12);
  assert.match(result.answer,/2026-11-30.*2026-12-01/); assert.match(result.answer,/阅读/); assert.doesNotMatch(result.answer,/29 分|40 分/);
  const rolling=await service.chat('最近7天阅读加了几分',state,actual);
  assert.equal(rolling.query.period,'last7'); assert.equal(rolling.data.from,'2026-11-25'); assert.equal(rolling.data.earned,23);
  assert.equal(JSON.stringify(state),before);
});
test('week regression: Monday includes only its Shanghai date and a whole-week summary includes other behaviors',async()=>{
  const {state}=weekFixture(),monday=new Date('2026-11-30T09:00:00+08:00'),service=local();
  const reading=await service.chat('本周阅读加了几分',state,monday);
  assert.equal(reading.data.from,'2026-11-30'); assert.equal(reading.data.to,'2026-11-30'); assert.equal(reading.data.earned,5);
  const summary=await service.chat('本周小结',state,monday);
  assert.equal(summary.query.period,'week'); assert.equal(summary.data.earned,22); assert.match(summary.answer,/本周/);
  const recent=await service.chat('最近七天小结',state,monday);
  assert.equal(recent.query.period,'last7'); assert.equal(recent.data.from,'2026-11-24'); assert.equal(recent.data.earned,74);
});
test('week regression: provider-selected periods, behaviors and query kinds are not rewritten from user text',async()=>{
  const {actual,state}=weekFixture(),before=JSON.stringify(state);
  const last7=await tools([['read_week_summary',{period:'last7',behavior:'整理书包'}]]).chat('这周阅读加了几分',state,actual);
  assert.equal(last7.query.period,'last7'); assert.equal(last7.query.behavior,'整理书包'); assert.equal(last7.data.earned,17);
  const week=await tools([['read_week_summary',{period:'week',behavior:'阅读'}]]).chat('最近7天整理书包加了几分',state,actual);
  assert.equal(week.query.period,'week'); assert.equal(week.query.behavior,'阅读'); assert.equal(week.data.earned,12);
  const balance=await tools([['read_balance',{}]]).chat('这周阅读加了几分',state,actual);
  assert.equal(balance.query.type,'balance'); assert.equal(balance.data.available,M.totals(state).available); assert.equal(balance.source,'model');
  const custom=T.executeTool('read_ledger',{days:30},state,actual),explicit=T.executeTool('read_ledger',{days:30,period:'last7'},state,actual);
  assert.equal(custom.data.from,'2026-11-02'); assert.equal(custom.data.period,undefined);
  assert.equal(explicit.data.from,'2026-11-25'); assert.equal(explicit.data.period,'last7');
  assert.equal(JSON.stringify(state),before);
});
test('correction regression: model names remain intact even when a previous behavior differs from current wording',async()=>{
  const draft={kind:'action',action:{type:'points.add',payload:{name:'独立阅读',points:5}}},snapshot=JSON.stringify(draft),state=seed(),before=JSON.stringify(state);
  const rule=await tools([['draft_rule',{name:'独立阅读',points:3}]]).chat('每天整理书包，每次3分',state,now,{draft});
  assert.equal(rule.action.type,'pointItem.save'); assert.equal(rule.action.payload.item.name,'独立阅读'); assert.equal(rule.source,'model');
  const award=await tools([['draft_award',{name:'独立阅读',points:8}]]).chat('这次整理书包加8分',state,now,{draft});
  assert.equal(award.action.payload.name,'独立阅读'); assert.equal(award.action.payload.points,8); assert.equal(award.source,'model');
  assert.equal(JSON.stringify(draft),snapshot); assert.equal(JSON.stringify(state),before);
});
test('list regression: long rules are bounded, explicitly partial and omit unused preset reasons',async()=>{
  const state=seed(); state.pointItems=Array.from({length:30},(_,index)=>({id:'large-rule-'+index,name:'常用行为'+index,points:5,reason:'预设原因'.repeat(300),enabled:true}));
  const result=await local().chat('查看常用行为规则',state,now);
  assert.equal(result.kind,'answer'); assert.equal(result.data.total,30); assert.equal(result.data.hasMore,true); assert.equal(result.data.rows.length,12);
  assert.equal(result.data.rows[0].reason,undefined); assert.match(result.answer,/共 30 条/); assert.ok(Buffer.byteLength(JSON.stringify(result))<20000);
});
test('list regression: reward eligibility and a late named reward match the full catalog before limiting rows',async()=>{
  const state=seed(); state.rewards=Array.from({length:40},(_,index)=>({id:'long-reward-'+index,name:'停用礼品'+index,points:1,category:'daily',icon:'pencil',enabled:false}));
  state.rewards.push({id:'late-book',name:'最后一本绘本',points:80,category:'daily',icon:'pencil',enabled:true}); state.settings.preferredReward='';
  const eligible=await local().chat('现在可以换什么',state,now);
  assert.equal(eligible.data.total,1); assert.equal(eligible.data.rows[0].id,'late-book'); assert.equal(eligible.data.hasMore,false);
  const named=await local().chat('最后一本绘本还差多少分',state,now);
  assert.equal(named.data.rows[0].id,'late-book'); assert.equal(named.data.rows[0].gap,0);
});
test('list regression: six large read results together stay below the actual chat result limit',async()=>{
  const state=seed(),longName='这是很长但合法的记录名称'.repeat(8).slice(0,110);
  state.pointItems=Array.from({length:50},(_,index)=>({id:'rule-'+index,name:longName+index,points:5,reason:'长预设'.repeat(500),enabled:true}));
  state.rewards=Array.from({length:50},(_,index)=>({id:'reward-'+index,name:longName+index,points:1,category:'daily',icon:'pencil',enabled:true})); state.settings.preferredReward='';
  state.tasks=Array.from({length:50},(_,index)=>({...state.tasks[0],id:'task-'+index,title:longName+index}));
  state.requests=Array.from({length:50},(_,index)=>({id:'request-'+index,rewardId:'reward-'+index,name:longName+index,points:1,category:'daily',status:'cancelled',createdAt:now.toISOString(),updatedAt:now.toISOString(),redemptionId:''}));
  const before=JSON.stringify(state),service=tools([['read_rules',{limit:50}],['read_rewards',{limit:50}],['read_tasks',{limit:50}],['read_requests',{limit:50}],['read_rules',{limit:50}],['read_rewards',{limit:50}]]);
  const result=await service.chat('分别查看规则、礼品、提醒和申请',state,now);
  assert.equal(result.kind,'steps'); assert.equal(result.steps.length,6); assert.ok(Buffer.byteLength(JSON.stringify(result))<=18000,Buffer.byteLength(JSON.stringify(result)));
  for (const row of result.steps) { assert.equal(row.kind,'answer'); assert.equal(row.data.total,50); assert.equal(row.data.hasMore,true); assert.ok(row.data.rows.length>=1); assert.match(row.answer,/共 50 条/); }
  assert.equal(JSON.stringify(state),before);
});
test('conversation regression: captured natural greeting and identity responses remain model replies verbatim',async()=>{
  const state=seed(),before=JSON.stringify(state),cases=[
    ['hi','你好！需要看积分余额、记录加分，还是设置规则和提醒？告诉我就行。'],
    ['你是谁','我是“小小向前”的家庭成长管理助手，可以帮你按家里真实记录查看积分、规则、提醒和礼品资格，也能把想做的操作整理成候选，等你确认后再在应用里办理。\n\n你想先看什么？比如积分余额、这周的记录，或者某个行为该给几分。']
  ];
  for (const [text,content] of cases) {
    let calls=0; const result=await natural(content,()=>{calls++;}).chat(text,state,now);
    assert.equal(result.kind,'answer'); assert.equal(result.scope,'conversation'); assert.equal(result.answer,content);
    assert.equal(result.source,'model'); assert.equal(result.mode,'connected'); assert.equal(result.label,'AI 回复'); assert.equal(calls,1);
    assert.equal(result.query,undefined); assert.deepEqual(types(result),[]);
  }
  assert.equal(JSON.stringify(state),before);
});
test('conversation regression: bilingual capabilities, general chat and product instructions use model wording',async()=>{
  for (const [text,content] of [
    ['What can you help me with?',"I can explain the app, help you review your records, and prepare drafts for you to confirm. Let's start with what matters to you."],
    ['Who are you?',"I'm the family growth assistant in Little Steps. I can help you understand the app and prepare changes for your confirmation."],
    ['Tell me about yourself.',"I'm here to help you understand Little Steps and prepare requests for you to review."],
    ['你有什么用？','可以解释这个应用的功能、查看真实记录，也能先整理候选供你核对。'],
    ['这个应用能帮我做些什么？','你可以在这里管理常用行为、积分、礼品和提醒，具体办理由你确认。'],
    ['Hey there, how are you?','Hi there! Ready to help. What would make your family routine easier today?'],
    ['如何在这里设置提醒？','可以打开提醒，填写事项、日期和时间，核对后再确认保存。我也能先帮你整理候选。'],
    ['How do I use this app?',"1. Start with what you want to do.\n2. Review the draft in the app.\n3. Confirm only when it matches your intent."]
  ]) {
    const result=await natural(content).chat(text,seed(),now);
    assert.equal(result.scope,'conversation',text+JSON.stringify(result)); assert.equal(result.answer,content); assert.equal(result.source,'model');
  }
});
test('conversation regression: native conversation tools and raw content preserve wording without semantic filters',async()=>{
  for (const message of ['我是这个应用的家庭成长助手。可以解释功能、查看记录或准备待确认的候选。','我已经替你保存了。你有９９９积分。']) {
    for (const service of [tools([['respond_conversation',{message}]]),natural(message),createAssistantService({apiKey:'test-key',chatEnabled:true,fetch:provider({content:message,tool_calls:null})})]) {
      const result=await service.chat('请说说你想到的内容',seed(),now);
      assert.equal(result.kind,'answer'); assert.equal(result.scope,'conversation'); assert.equal(result.answer,message); assert.equal(result.source,'model'); assert.deepEqual(types(result),[]);
    }
  }
});
test('conversation regression: all content remains literal text including valid business JSON examples',async()=>{
  const award={kind:'action',action:{type:'points.add',payload:{name:'阅读',points:5}}},examples=[
    award,
    {kind:'form',form:'pointItem',fields:{name:'每天阅读',points:5}},
    {kind:'query',query:{type:'balance'}},
    {kind:'answer',scope:'conversation',answer:'你好'},
    {kind:'answer',answer:'你有999999分',query:{type:'balance'}},
    {kind:'conversation',message:'你好'},
    {kind:'clarify',question:'要调整哪一个行为？'},
    {kind:'route',route:'parent'},
    {kind:'steps',steps:[award,{kind:'query',query:{type:'balance',after:[0]}}]},
    {kind:'answer',scope:'conversation',answer:'模型回复',action:award.action},
    {kind:'answer',cancelDraft:true,query:{type:'balance'}},
    {tool_calls:[{id:'example',type:'function',function:{name:'draft_award',arguments:'{"name":"阅读","points":5}'}}]}
  ];
  const contents=['{"kind":"answer","answer":"你好"','```json\n{"kind":"answer","answer":\n```','[{"kind":"answer","answer":"你好"}]','{"recipe":"香蕉奶昔","servings":2}','[1,2,3]','"literal quoted answer"','42','true','1. 今天散步20分钟\n2. 明天休息','```js\nconst balance = 5 + 8;\n```','```json\n{"kind":"query","query":{"type":"balance"}}\n```','{"kind":"story","title":"小龙的第5次旅行"}',...examples.map(value=>JSON.stringify(value)),'\n  '+JSON.stringify(award)+'  \n'];
  const state=seed(),before=JSON.stringify(state),draft={kind:'action',action:{type:'points.add',payload:{name:'原候选',points:3}}},snapshot=JSON.stringify(draft);
  for (const content of contents) {
    const result=await natural(content).chat('给我一个JSON示例，只展示文字',state,now,{draft});
    assert.equal(result.kind,'answer'); assert.equal(result.scope,'conversation',content); assert.equal(result.answer,content); assert.equal(result.source,'model'); assert.deepEqual(types(result),[]);
    assert.equal(result.query,undefined); assert.equal(result.data,undefined); assert.equal(result.route,undefined); assert.equal(result.cancelDraft,undefined);
  }
  assert.equal(JSON.stringify(state),before); assert.equal(JSON.stringify(draft),snapshot);
});
test('conversation regression: numeric, status and operation wording is not a programmatic refusal trigger',async()=>{
  for (const content of ['你现在有999999分。','你的积分已经足够兑换礼品了。','Your balance is 999999 points.','I have saved your changes.','Your redemption request is approved.','我已经替你申请兑换了。','我这就帮你加分。','You are now verified as a parent.','你好，你有９９９积分。','I added five points for you.','你家有5条提醒。','Your reminder is tomorrow.','今天没有未完成的提醒。']) {
    const state=seed(),before=JSON.stringify(state),result=await natural(content).chat('请继续说',state,now);
    assert.equal(result.scope,'conversation',content); assert.equal(result.answer,content); assert.deepEqual(types(result),[]); assert.equal(result.source,'model'); assert.equal(result.mode,'connected');
    assert.equal(result.query,undefined); assert.equal(result.data,undefined); assert.equal(result.cancelDraft,undefined); assert.equal(JSON.stringify(state),before);
  }
  const write=await natural('Done, I added five points.').chat('今天独立阅读加5分',seed(),now);
  assert.equal(write.scope,'conversation'); assert.equal(write.answer,'Done, I added five points.'); assert.deepEqual(types(write),[]); assert.equal(write.source,'model');
});
test('conversation regression: disabled AI stays local while a failed connected request rejects',async()=>{
  let calls=0;
  const disabled=createAssistantService({apiKey:'test-key',chatEnabled:false,formOnly:true,fetch:async()=>{calls++;throw new Error('unexpected');}});
  for (const text of ['你是谁','Who are you?','How do I use this app?','hello there']) {
    const result=await disabled.chat(text,seed(),now,{context:{form:'pointItem'}});
    assert.equal(result.kind,'answer'); assert.equal(result.source,'local'); assert.equal(result.mode,'local'); assert.match(result.answer,/本地/); assert.doesNotMatch(result.answer,/我是.*AI/);
  }
  assert.equal(calls,0,'form-only AI must not receive ordinary conversation');
  const failed=createAssistantService({apiKey:'test-key',chatEnabled:true,fetch:async()=>{throw new Error('PROVIDER_FAILURE_PRIVATE');}});
  await assert.rejects(failed.chat('介绍一下自己',seed(),now),error=>error instanceof Error && !/PROVIDER_FAILURE_PRIVATE|test-key/.test(error.message));
});
test('conversation regression: draft then hello then an explicit score correction keeps the same pending behavior',async()=>{
  const service=local(),state=seed(),draft=await service.chat('今天独立阅读加5分',state,now),before=JSON.stringify(draft);
  const hello=await natural('你好！想先聊聊应用怎么用，还是整理一件待确认的小事？').chat('hello',state,now,{draft});
  assert.equal(hello.scope,'conversation'); assert.equal(hello.cancelDraft,undefined); assert.deepEqual(types(hello),[]); assert.equal(JSON.stringify(draft),before);
  const corrected=await service.chat('改成8分',state,now,{draft,messages:[{role:'user',text:'hello'},{role:'assistant',text:hello.answer,result:hello}]});
  assert.equal(corrected.action.type,'points.add'); assert.equal(corrected.action.payload.name,'独立阅读'); assert.equal(corrected.action.payload.points,8);
});
test('conversation regression: the provider chooses tools, queries and clarifications even for a greeting',async()=>{
  const draft={kind:'action',action:{type:'points.add',payload:{name:'独立阅读',points:5}}},snapshot=JSON.stringify(draft),state=seed(),before=JSON.stringify(state);
  for (const service of [tools([['draft_award',{name:'独立阅读',points:5}]]),tools([['draft_award',{name:'打招呼',points:5}]])]) {
    const result=await service.chat('hi',state,now,{draft});
    assert.equal(result.kind,'action'); assert.equal(result.action.type,'points.add'); assert.equal(result.source,'model'); assert.equal(result.query,undefined);
  }
  for (const service of [tools([['read_balance',{}]])]) {
    const result=await service.chat('hi',state,now,{draft}); assert.equal(result.kind,'answer'); assert.equal(result.query.type,'balance'); assert.equal(result.data.available,88); assert.equal(result.source,'model');
  }
  const question='余额这部分要先看哪一项，还是先解释5分的例子？';
  for (const service of [tools([['ask_clarification',{question}]])]) {
    const result=await service.chat('hi',state,now,{draft}); assert.equal(result.kind,'clarify'); assert.equal(result.question,question); assert.equal(result.source,'model');
  }
  assert.equal(JSON.stringify(draft),snapshot); assert.equal(JSON.stringify(state),before);
});
test('conversation regression: a greeting mixed with an explicit business request still uses controlled candidates',async()=>{
  const text='hi，今天独立阅读加5分',state=seed(),before=JSON.stringify(state);
  for (const service of [local(),tools([['draft_award',{name:'独立阅读',points:5}]])]) {
    const result=await service.chat(text,state,now);
    assert.equal(result.kind,'action'); assert.deepEqual(result.action,{type:'points.add',payload:{name:'独立阅读',points:5}});
  }
  assert.equal(JSON.stringify(state),before);
});
test('conversation regression: Chinese and English greeting-prefixed reminder requests remain executable candidates',async()=>{
  const state=seed(),before=JSON.stringify(state),task={type:'task',title:'阅读',date:'2026-11-23',time:'20:00',note:'',remindDays:0};
  for (const [text,service] of [
    ['你好，明天晚上八点提醒我阅读',local()],
    ['你好明天晚上八点提醒我阅读',local()],
    ['你好，明天晚上八点提醒我阅读',tools([['draft_reminder',task]])],
    ['Hi, remind me to read tomorrow at 8',tools([['draft_reminder',{...task,time:'08:00'}]])]
  ]) {
    const result=await service.chat(text,state,now);
    assert.equal(result.kind,'action',text+JSON.stringify(result)); assert.equal(result.action.type,'task.save');
    const saved=M.apply(state,{id:'verify-reminder-candidate',type:result.action.type,...result.action.payload},now,'Asia/Shanghai');
    const actual=saved.tasks.find(row=>row.id==='task-verify-reminder-candidate');
    assert.equal(actual.date,'2026-11-23'); assert.equal(actual.time,text.startsWith('Hi')?'08:00':'20:00'); assert.equal(actual.title,'阅读');
  }
  const usage=await natural('可以先填事项、日期和时间，核对候选后再确认保存。').chat('你好，提醒功能怎么用？',state,now);
  assert.equal(usage.scope,'conversation'); assert.equal(usage.source,'model');
  assert.equal(JSON.stringify(state),before,'candidate checks and synthetic execution do not mutate the input ledger');
});


test('conversation: arbitrary utterances, clock questions and arithmetic are decided by the model',async()=>{
  const nonce=crypto.randomUUID(),state=seed(),before=JSON.stringify(state),cases=[
    ['请解释气球为什么会浮起来，暗号是'+nonce,'因为气球和周围空气的密度不同。暗号：'+nonce],
    ['现在是几点？','按当前家庭时间，是2026年11月22日09:00。'],
    ['17乘以23再减5是多少？','17 × 23 − 5 = 386。'],
    ['讲一个讲了5次才说完的小故事','小龙找了3片叶子，把第5片留给明天。'],
    ['我们换个话题：如果城市没有红绿灯会怎样？','大家需要别的办法约定路口先后，例如环岛或互相让行。']
  ];
  for (const [text,content] of cases) {
    let calls=0; const result=await natural(content,(_url,_options,body)=>{
      calls++; const input=JSON.parse(body.messages[1].content); assert.equal(input.instruction,text); assert.equal(input.context.localTime,'09:00');
    }).chat(text,state,now);
    assert.equal(calls,1); assert.equal(result.kind,'answer'); assert.equal(result.scope,'conversation'); assert.equal(result.answer,content); assert.equal(result.source,'model'); assert.equal(result.query,undefined); assert.deepEqual(types(result),[]);
  }
  assert.equal(JSON.stringify(state),before);
});

test('conversation: preflight topics and cancellation phrases do not bypass a configured model',async()=>{
  const nonce=crypto.randomUUID(),content='这是模型为本轮选择的普通回复 '+nonce,state=seed(),before=JSON.stringify(state);
  for (const text of ['帮我答家长验证题','修改密码','邀请家庭成员','给伙伴换装扮','打开农场','修改孩子头像','取消这张草稿','这笔先不记了','密码管理有什么原则']) {
    let calls=0; const result=await natural(content,(_url,_options,body)=>{
      calls++; assert.equal(JSON.parse(body.messages[1].content).instruction,text);
    }).chat(text,state,now);
    assert.equal(calls,1,text); assert.equal(result.answer,content); assert.equal(result.scope,'conversation'); assert.equal(result.source,'model'); assert.equal(result.cancelDraft,undefined); assert.equal(result.route,undefined);
  }
  assert.equal(JSON.stringify(state),before);
});

test('model: typed cancellation and routing are selected by the model without text matching',async()=>{
  const state=seed(),before=JSON.stringify(state),draft={kind:'action',action:{type:'points.add',payload:{name:'阅读',points:5}}},snapshot=JSON.stringify(draft);
  const cancelled=await tools([['cancel_draft',{}]]).chat('让这张候选先回到抽屉里吧',state,now,{draft});
  assert.equal(cancelled.cancelDraft,true); assert.equal(cancelled.source,'model'); assert.deepEqual(types(cancelled),[]);
  const cancelAndRead=await tools([['cancel_draft',{}],['read_balance',{}]]).chat('按你的理解安排',state,now,{draft});
  assert.equal(cancelAndRead.cancelDraft,true); assert.equal(cancelAndRead.steps[1].data.available,88); assert.deepEqual(types(cancelAndRead),[]);
  const conflict=await tools([['cancel_draft',{}],['draft_award',{name:'阅读',points:5}]]).chat('随意处理',state,now,{draft});
  assert.equal(conflict.kind,'clarify'); assert.deepEqual(types(conflict),[]);
  const routed=await tools([['open_view',{route:'parent'}]]).chat('hello',state,now);
  assert.equal(routed.kind,'route'); assert.equal(routed.route,'parent'); assert.equal(routed.source,'model');
  assert.equal(JSON.stringify(state),before); assert.equal(JSON.stringify(draft),snapshot);
});

test('model: dependent reads must refer to prior action steps from the same response',async()=>{
  const state=seed(),before=JSON.stringify(state);
  for (const calls of [[['read_balance',{after:[0]}]],[['read_balance',{}],['read_balance',{after:[0]}]],[['draft_award',{name:'阅读',points:5}],['read_balance',{after:[1]}]]]) {
    const result=await tools(calls).chat('你来安排',state,now),rows=result.kind==='steps'?result.steps:[result];
    assert.equal(rows.at(-1).kind,'clarify'); assert.equal(rows.at(-1).data,undefined); assert.notEqual(rows.at(-1).deferred,true); assert.equal(result.source,'model');
  }
  assert.equal(JSON.stringify(state),before);
});

test('model: tool results and accompanying natural prose both survive with dependency indexes intact',async()=>{
  const content='我先准备一张5分候选，再等你确认。这里也可以继续讨论17 × 23。',state=seed(),before=JSON.stringify(state);
  const message={content,tool_calls:[['draft_award',{name:'阅读',points:5}],['read_balance',{after:[0]}]].map(([name,args],index)=>({id:'mixed-'+index,type:'function',function:{name,arguments:JSON.stringify(args)}}))};
  const service=createAssistantService({apiKey:'test-key',chatEnabled:true,fetch:provider(message)}),result=await service.chat('你来决定下一步',state,now);
  assert.equal(result.kind,'steps'); assert.equal(result.steps[0].action.type,'points.add'); assert.deepEqual(result.steps[1].after,[0]); assert.equal(result.steps[1].deferred,true);
  assert.equal(result.steps[2].scope,'conversation'); assert.equal(result.steps[2].answer,content); assert.equal(result.steps[2].source,'model'); assert.equal(result.source,'model');
  assert.equal(JSON.stringify(state),before);
});

test('model: invalid input is rejected before provider calls without changing business state',async()=>{
  let calls=0; const service=natural('不应收到本次请求',()=>{calls++;}),state=seed(),before=JSON.stringify(state);
  for (const [text,sampled,options] of [['',now,{}],['x'.repeat(1201),now,{}],['hello','not-a-date',{}],['hello',now,{context:{view:'<script>'}}]]) {
    const result=await service.chat(text,state,sampled,options); assert.equal(result.kind,'clarify'); assert.equal(result.source,'local'); assert.deepEqual(types(result),[]);
  }
  assert.equal(calls,0); assert.equal(JSON.stringify(state),before);
});

test('model: business state and prices still validate candidates independently of phrasing',async()=>{
  const state=seed(),before=JSON.stringify(state),cases=[
    tools([['draft_redemption_request',{rewardId:'missing-reward'}]]),
    tools([['draft_redemption_approval',{requestId:'missing-request'}]]),
    tools([['draft_reminder_status',{taskId:'missing-task',operation:'done'}]]),
    tools([['draft_reminder',{type:'task',title:'读书',date:'2026-02-30',time:'20:00'}]])
  ];
  for (const service of cases) {
    const result=await service.chat('这项请按你的理解整理',state,now); assert.equal(result.kind,'clarify'); assert.equal(result.source,'model'); assert.deepEqual(types(result),[]);
  }
  const priced=await tools([['draft_direct_redemption',{rewardId:'reward-burger'}]]).chat('按你理解安排',state,now);
  assert.equal(priced.kind,'action'); assert.equal(priced.action.payload.expectedPoints,60);
  const expensive=seed(); expensive.rewards.find(row=>row.id==='reward-burger').points=10000;
  const unavailable=await tools([['draft_direct_redemption',{rewardId:'reward-burger'}]]).chat('请整理候选',expensive,now);
  assert.equal(unavailable.kind,'clarify'); assert.deepEqual(types(unavailable),[]);
  assert.equal(JSON.stringify(state),before);
});

test('model: truncated provider replies fail without a candidate and allow the same request to retry',async()=>{
  const call={id:'candidate',type:'function',function:{name:'draft_award',arguments:JSON.stringify({name:'阅读',points:5})}},complete={tool_calls:[call]};
  for (const truncated of [{content:JSON.stringify({kind:'action',action:{type:'points.add',payload:{name:'阅读',points:5}}})},{tool_calls:[call],content:'这是尚未完整生成的回复'}]) {
    let calls=0; const state=seed(),before=JSON.stringify(state),draft={kind:'action',action:{type:'points.add',payload:{name:'原候选',points:3}}},snapshot=JSON.stringify(draft);
    const service=createAssistantService({apiKey:'test-key',chatEnabled:true,fetch:async()=>{
      calls++; return new Response(JSON.stringify({choices:[{message:calls===1?truncated:complete,finish_reason:calls===1?'length':'tool_calls'}]}),{status:200,headers:{'Content-Type':'application/json'}});
    }});
    await assert.rejects(service.chat('请准备阅读候选',state,now,{draft}),error=>error instanceof Error && error.message==='ASSISTANT_UNAVAILABLE');
    assert.equal(calls,1); assert.equal(JSON.stringify(state),before); assert.equal(JSON.stringify(draft),snapshot);
    const retried=await service.chat('请准备阅读候选',state,now,{draft});
    assert.equal(calls,2); assert.equal(retried.kind,'action'); assert.equal(retried.action.type,'points.add'); assert.equal(retried.action.payload.points,5); assert.equal(retried.source,'model');
    assert.equal(JSON.stringify(state),before); assert.equal(JSON.stringify(draft),snapshot);
  }
});
