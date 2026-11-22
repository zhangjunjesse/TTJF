'use strict';
process.env.TZ='Asia/Shanghai';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
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
function connected(candidate,inspect) {
  return createAssistantService({apiKey:'test-key',chatEnabled:true,fetch:provider({content:JSON.stringify(candidate)},inspect)});
}
function natural(content,inspect) { return createAssistantService({apiKey:'test-key',chatEnabled:true,fetch:provider({content},inspect)}); }
function tools(calls,inspect) {
  return createAssistantService({apiKey:'test-key',chatEnabled:true,fetch:provider({tool_calls:calls.map(([name,args],index)=>({id:'call-'+index,type:'function',function:{name,arguments:JSON.stringify(args)}}))},inspect)});
}
function types(result) { return (result.kind==='steps'?result.steps:[result]).filter(row=>row.kind==='action').map(row=>row.action.type); }

test('config: system prompts and 23 public tool contracts are readable and server-bounded',()=>{
  for (const name of ['system.md','legacy-system.md','point-item-create-system.md','tools.json']) assert.ok(fs.readFileSync(path.join(__dirname,'..','config','assistant',name),'utf8').length>100);
  const definitions=T.toolDefinitions(); assert.equal(definitions.length,23);
  for (const tool of definitions) { assert.equal(tool.type,'function'); assert.ok(tool.function.description); assert.equal(tool.function.parameters.additionalProperties,false); }
  assert.equal(T.validateCall('__proto__',{}),false);
  assert.equal(T.validateCall('read_balance',{grant:'fake'}),false);
  assert.equal(T.validateCall('read_ledger',{days:0}),false);
  assert.equal(T.validateCall('read_tasks',{date:'2026-11-22',includeDone:'true'}),false);
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
  let calls=0; const service=createAssistantService({apiKey:'test-key',chatEnabled:true,fetch:async()=>{calls++;throw new Error('unexpected');}});
  for (const [text,route] of [['帮我答家长验证题','parent'],['邀请家庭成员','family'],['给伙伴换装扮','partner'],['打开农场','farm'],['修改孩子头像','profile']]) {
    const result=await service.chat(text,seed(),now); assert.equal(result.kind,'route'); assert.equal(result.route,route);
  }
  assert.equal(calls,0);
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
test('model: trusted tool calls run locally with minimized state and bounded user history',async()=>{
  const state=seed(); state.parent={hash:'PRIVATE_AUTH'}; state.childAvatar=validAvatar; state.pointItems[0].reason='PRIVATE_PRESET';
  let calls=0;
  const service=tools([['read_balance',{}]],(_url,options,body)=>{
    calls++; const input=JSON.parse(body.messages[1].content);
    assert.equal(input.context.familyDay,'2026-11-22'); assert.equal(input.messages.length,1); assert.equal(input.messages[0].text,'我想查看积分');
    assert.equal(body.tools.length,23); assert.doesNotMatch(options.body,/PRIVATE_AUTH|PRIVATE_AVATAR|PRIVATE_PRESET|CREDENTIAL_SENTINEL|FABRICATED_ANSWER|seed-p1|seed-r1/);
  });
  const result=await service.chat('积分余额',state,now,{messages:[{role:'user',text:'我想查看积分'},{role:'user',text:'密码 CREDENTIAL_SENTINEL'},{role:'assistant',text:'FABRICATED_ANSWER',result:{answer:'999999分'}}]});
  assert.equal(result.mode,'connected'); assert.equal(result.source,'model'); assert.equal(result.data.available,88); assert.equal(calls,1);
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
test('model: selected older quotations survive filtering before the history budget',async()=>{
  const messages=[{role:'user',text:'EARLY_RELEVANT_RULE 阅读每次8分'}];
  for (let index=0;index<8;index++) messages.push({role:'user',text:'近期对话'+index},{role:'assistant',text:'只读旧回答'+index});
  const service=tools([['read_rules',{}]],(_url,_options,body)=>{
    const history=JSON.parse(body.messages[1].content).messages;
    assert.equal(history.length,9); assert.match(history[0].text,/EARLY_RELEVANT_RULE/); assert.equal(history.at(-1).text,'近期对话7');
  });
  assert.equal((await service.chat('查看常用行为规则',seed(),now,{messages})).source,'model');
});
test('model: raw answers cannot fabricate balances or bypass deterministic query calculation',async()=>{
  const result=await connected({kind:'answer',answer:'你有999999分',query:{type:'balance'}}).chat('积分余额',seed(),now);
  assert.equal(result.kind,'answer'); assert.equal(result.data.available,88); assert.doesNotMatch(result.answer,/999999/);
  assert.equal((await connected({kind:'answer',answer:'已保存并加分999999'}).chat('你好',seed(),now)).kind,'clarify');
});
test('model: unknown tools and extra fields are rejected and a fallback is plainly labeled',async()=>{
  for (const call of [['grant_parent',{}],['draft_award',{name:'阅读',points:5,grant:'fake'}],['read_balance',{familyId:'other'}]]) {
    const state=seed(),before=JSON.stringify(state),result=await tools([call]).chat('今天阅读加5分',state,now);
    assert.equal(result.source,'fallback'); assert.match(result.label,/AI 暂不可用/); assert.equal(JSON.stringify(state),before);
    assert.doesNotMatch(JSON.stringify(result),/grant|other|fake/);
  }
});
test('model: public and sensitive action types remain an explicit server allowlist',async()=>{
  for (const type of ['parent.configure','family.delete','pet.buy','pet.care','points.delete','__proto__']) {
    const result=await connected({kind:'action',action:{type,payload:{}}}).chat('帮我处理一下',seed(),now);
    assert.equal(result.kind,'clarify',type);
  }
  const extra=await connected({kind:'action',action:{type:'points.add',payload:{name:'阅读',points:5,saveAsTemplate:true}}}).chat('今天阅读加5分',seed(),now);
  assert.equal(extra.kind,'clarify');
});
test('model: the selected entity and same-name ambiguity cannot be silently changed',async()=>{
  const state=seed(),candidate={kind:'action',action:{type:'pointItem.save',payload:{item:{id:'point-focus',points:8}}}};
  assert.equal((await connected(candidate).chat('把这个改成每次8分',state,now,{context:{form:'pointItem',targetId:'point-reading'}})).kind,'clarify');
  state.pointItems.push({...state.pointItems[0],id:'duplicate-reading'});
  const duplicate={kind:'action',action:{type:'pointItem.save',payload:{item:{id:'point-reading',points:8}}}};
  assert.equal((await connected(duplicate).chat('把自主阅读改成每次8分',state,now)).kind,'clarify');
});
test('model: missing, duration-derived, fractional, negative and stale scores are never fabricated',async()=>{
  for (const text of ['每天阅读20分钟','每天阅读3次','每天阅读奖励3.5分','每天阅读奖励-5分']) {
    const result=await tools([['draft_rule',{name:'每天阅读',points:5}]]).chat(text,seed(),now);
    assert.equal(result.kind,'clarify',text+JSON.stringify(result));
  }
  const draft={kind:'action',action:{type:'pointItem.save',payload:{item:{name:'阅读',points:5}}}};
  const result=await tools([['draft_rule',{name:'阅读',points:5}]]).chat('改成8分',seed(),now,{draft,messages:[{role:'user',text:'每天阅读奖励5分'}]});
  assert.equal(result.kind,'clarify');
});
test('model: unspecified reasons, invented facts and rule presets never overwrite award form reasons',async()=>{
  for (const reason of ['', '今天独立阅读','从未提到的原因']) {
    const result=await tools([['draft_award',{name:'独立阅读',points:5,reason}]]).chat('今天独立阅读加5分',seed(),now);
    assert.equal(result.kind,'action'); assert.equal(Object.hasOwn(result.action.payload,'reason'),false);
  }
  const explicit=await tools([['draft_award',{name:'阅读',points:5,reason:'自己选了一本书'}]]).chat('阅读加5分，原因：自己选了一本书',seed(),now);
  assert.equal(explicit.action.payload.reason,'自己选了一本书');
});
test('model: recurring wording cannot become one actual award and only-check cannot become redemption',async()=>{
  assert.equal((await tools([['draft_award',{name:'阅读',points:5}]]).chat('以后每天阅读每次5分',seed(),now)).kind,'clarify');
  for (const name of ['draft_redemption_request','draft_direct_redemption']) {
    const result=await tools([[name,{rewardId:'reward-burger'}]]).chat('只查不兑，看看够不够换汉堡',seed(),now);
    assert.equal(result.kind,'clarify'); assert.deepEqual(types(result),[]);
  }
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
test('model: provider failures, timeout and oversized responses use truthful local fallback',async()=>{
  const failure=createAssistantService({apiKey:'PRIVATE_KEY',chatEnabled:true,fetch:async()=>{throw new Error('PRIVATE_KEY PRIVATE_HOST');}});
  const result=await failure.chat('积分余额',seed(),now); assert.equal(result.source,'fallback'); assert.equal(result.data.available,88); assert.doesNotMatch(JSON.stringify(result),/PRIVATE_/);
  const timeout=createAssistantService({apiKey:'test-key',chatEnabled:true,timeoutMs:5,fetch:(_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('timeout'))))});
  assert.equal((await timeout.chat('积分余额',seed(),now)).source,'fallback');
  const oversized=createAssistantService({apiKey:'test-key',chatEnabled:true,fetch:async()=>new Response('x'.repeat(262145),{status:200})});
  assert.equal((await oversized.chat('积分余额',seed(),now)).source,'fallback');
});
test('followup: committed drafts cannot be corrected into another award or silently replayed',async()=>{
  let calls=0; const service=createAssistantService({apiKey:'test-key',chatEnabled:true,fetch:async()=>{calls++;throw new Error('unexpected');}});
  const draft={kind:'action',action:{type:'points.add',payload:{name:'阅读',points:5}}};
  const result=await service.chat('改成8分',seed(),now,{draft,draftStatus:{actions:[{index:0,type:'points.add',status:'committed'}],sourceRevision:2,familyDay:'2026-11-22'}});
  assert.equal(result.kind,'clarify'); assert.match(result.question,/已办理/); assert.equal(calls,0);
});
test('followup: only pending steps enter model draft context and status excludes action credentials',async()=>{
  const draft={kind:'steps',steps:[{kind:'action',action:{type:'points.add',payload:{name:'阅读',points:5}}},{kind:'route',route:'points'},{kind:'action',action:{type:'task.save',payload:{task:{title:'带水杯',date:'2026-11-23',time:'08:00',type:'task'}}}}]};
  const service=tools([['read_balance',{}]],(_url,options,body)=>{
    const input=JSON.parse(body.messages[1].content); assert.equal(input.draft.steps.length,1); assert.equal(input.draft.steps[0].action.type,'task.save');
    assert.equal(input.draftStatus.actions[0].status,'committed'); assert.doesNotMatch(options.body,/ACTION_CREDENTIAL/);
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
test('followup: model tools defer ordered reads and recompute eligibility using the current family day',async()=>{
  const service=tools([['draft_award',{name:'独立阅读',points:5}],['read_rewards',{rewardId:'reward-burger'}]]);
  const result=await service.chat('独立阅读加5分，然后看看汉堡够不够，先别兑换',seed(),now);
  assert.equal(result.steps[1].deferred,true); assert.equal(result.steps[1].data,undefined);
  const monday=new Date('2026-11-23T09:00:00+08:00'),updated=M.apply(seed(),{id:'confirmed-monday',type:'points.add',name:'独立阅读',points:5},monday);
  const resolved=T.resolveFollowup(result,updated,monday,{committedIndexes:[0]});
  assert.equal(resolved.steps[1].data.available,93); assert.equal(resolved.steps[1].data.rows[0].allowed,false); assert.match(resolved.steps[1].answer,/周六|周日/);
});
test('followup: missing dependencies and unknown query types cannot trigger writes or invented answers',()=>{
  const state=seed(),before=JSON.stringify(state),result={kind:'steps',steps:[{kind:'action',action:{type:'points.add',payload:{name:'阅读',points:5}}},{kind:'answer',deferred:true,after:[0],query:{type:'parent.secret'},answer:'等待核对'}]};
  assert.deepEqual(T.resolveFollowup(result,state,now,{committedIndexes:[]}),result);
  assert.equal(T.resolveFollowup(result,state,now,{committedIndexes:[0]}).steps[1].kind,'clarify'); assert.equal(JSON.stringify(state),before);
});
test('local: score advice uses existing rules and growth discussion describes records without labeling children',async()=>{
  const state=seed(),before=JSON.stringify(state),service=local();
  const advice=await service.chat('阅读该给几分？',state,now);
  assert.equal(advice.kind,'answer'); assert.equal(advice.query.type,'guidance'); assert.equal(advice.data.rows[0].points,5); assert.match(advice.answer,/家长决定/);
  const week=await service.chat('这周是不是偷懒',state,now);
  assert.equal(week.kind,'answer'); assert.equal(week.query.topic,'week'); assert.match(week.answer,/已经记录|记录的内容/); assert.match(week.answer,/不能据此判断/);
  assert.deepEqual(types(advice),[]); assert.deepEqual(types(week),[]); assert.equal(JSON.stringify(state),before);
});
test('local: account and password changes route to account-family UI rather than child profile',async()=>{
  for (const text of ['改邮箱','修改密码','注销账号','登录账号']) assert.equal((await local().chat(text,seed(),now)).route,'family');
  assert.equal((await local().chat('修改孩子头像',seed(),now)).route,'profile');
});
test('local: explicit draft cancellation is local, independently recognizable and never cancels a business request',async()=>{
  let calls=0; const service=createAssistantService({apiKey:'test-key',chatEnabled:true,fetch:async()=>{calls++;throw new Error('unexpected');}});
  for (const text of ['取消这张草稿','这笔先不记了','把当前草稿取消']) {
    assert.equal(T.isDraftCancellation(text),true);
    const state=seed(),before=JSON.stringify(state),result=await service.chat(text,state,now);
    assert.equal(result.cancelDraft,true); assert.equal(result.source,'local'); assert.deepEqual(types(result),[]); assert.equal(JSON.stringify(state),before);
  }
  for (const text of ['取消汉堡申请','取消这张草稿然后帮我加分','已取消','你好']) assert.equal(T.isDraftCancellation(text),false);
  assert.equal(calls,0);
  const invented=await connected({kind:'answer',cancelDraft:true,query:{type:'balance'}}).chat('积分余额',seed(),now);
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
test('correction regression: a model replay of an old award cannot turn a new balance question into a write',async()=>{
  const draft={kind:'action',action:{type:'points.add',payload:{name:'独立阅读',points:5}}},before=JSON.stringify(draft);
  const result=await tools([['draft_award',{name:'独立阅读',points:5}]]).chat('那帮我看看积分余额',seed(),now,{draft});
  assert.equal(result.kind,'answer'); assert.equal(result.query.type,'balance'); assert.deepEqual(types(result),[]); assert.equal(JSON.stringify(draft),before);
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
test('week regression: real provider outputs cannot override explicit period or behavior with total points',async()=>{
  const {actual,state}=weekFixture();
  for (const service of [tools([['read_week_summary',{}]]),tools([['read_week_summary',{period:'last7',behavior:'整理书包'}]]),connected({kind:'query',query:{type:'balance'}})]) {
    const result=await service.chat('这周阅读加了几分',state,actual);
    assert.equal(result.kind,'answer'); assert.equal(result.query.period,'week'); assert.equal(result.query.behavior,'阅读'); assert.equal(result.data.earned,12);
  }
  const rolling=await tools([['read_week_summary',{period:'week'}]]).chat('最近7天阅读加了几分',state,actual);
  assert.equal(rolling.query.period,'last7'); assert.equal(rolling.data.earned,23);
  const custom=T.executeTool('read_ledger',{days:30},state,actual),explicit=T.executeTool('read_ledger',{days:30,period:'last7'},state,actual);
  assert.equal(custom.data.from,'2026-11-02'); assert.equal(custom.data.period,undefined);
  assert.equal(explicit.data.from,'2026-11-25'); assert.equal(explicit.data.period,'last7');
});
test('correction regression: model reuse of a previous behavior falls back to the current explicit behavior',async()=>{
  const draft={kind:'action',action:{type:'points.add',payload:{name:'独立阅读',points:5}}};
  const rule=await tools([['draft_rule',{name:'独立阅读',points:3}]]).chat('每天整理书包，每次3分',seed(),now,{draft});
  assert.equal(rule.action.type,'pointItem.save'); assert.match(rule.action.payload.item.name,/整理书包/); assert.equal(rule.source,'fallback');
  const award=await tools([['draft_award',{name:'独立阅读',points:8}]]).chat('这次整理书包加8分',seed(),now,{draft});
  assert.equal(award.action.payload.name,'整理书包'); assert.equal(award.action.payload.points,8); assert.equal(award.source,'fallback');
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
test('conversation regression: the explicit tool and JSON conversation contracts use the same boundary',async()=>{
  const message='我是这个应用的家庭成长助手。可以解释功能、查看记录或准备待确认的候选。';
  for (const service of [tools([['respond_conversation',{message}]]),connected({kind:'answer',scope:'conversation',answer:message}),connected({kind:'conversation',message})]) {
    const result=await service.chat('能介绍一下自己和能做什么吗',seed(),now);
    assert.equal(result.kind,'answer'); assert.equal(result.scope,'conversation'); assert.equal(result.answer,message); assert.equal(result.source,'model');
  }
  const mixed=await connected({kind:'answer',scope:'conversation',answer:message,action:{type:'points.add',payload:{points:5}}}).chat('介绍一下自己',seed(),now);
  assert.notEqual(mixed.scope,'conversation'); assert.deepEqual(types(mixed),[]); assert.equal(mixed.source,'fallback');
  for (const service of [tools([['respond_conversation',{message:'我已经替你保存了。'}]]),connected({kind:'answer',scope:'conversation',answer:'我已经替你保存了。'})]) {
    const result=await service.chat('介绍一下自己',seed(),now); assert.equal(result.source,'fallback'); assert.equal(result.mode,'local'); assert.notEqual(result.scope,'conversation');
  }
});
test('conversation regression: malformed structured content is not reclassified as ordinary prose',async()=>{
  for (const content of ['{"kind":"answer","answer":"你好"','```json\n{"kind":"answer","answer":\n```','[{"kind":"answer","answer":"你好"}]']) {
    const result=await natural(content).chat('介绍一下自己',seed(),now);
    assert.ok(result.source!=='model' || result.scope!=='conversation','malformed protocol must use the explicit local fallback or clarification');
    assert.notEqual(result.answer,content); assert.deepEqual(types(result),[]);
  }
});
test('conversation regression: prose cannot invent ledger numbers, live status, grants or completed operations',async()=>{
  for (const content of ['你现在有999999分。','你的积分已经足够兑换礼品了。','Your balance is 999999 points.','I have saved your changes.','Your redemption request is approved.','我已经替你申请兑换了。','我这就帮你加分。','You are now verified as a parent.','你好，你有９９９积分。','I added five points for you.','你家有5条提醒。','Your reminder is tomorrow.','今天没有未完成的提醒。']) {
    const state=seed(),before=JSON.stringify(state),result=await natural(content).chat('介绍一下自己',state,now);
    assert.notEqual(result.scope,'conversation',content); assert.notEqual(result.answer,content); assert.deepEqual(types(result),[]); assert.equal(result.source,'fallback'); assert.equal(result.mode,'local');
    assert.equal(JSON.stringify(state),before);
  }
  const balance=await natural('你现在有999999分。').chat('积分余额',seed(),now);
  assert.equal(balance.query.type,'balance'); assert.equal(balance.data.available,88); assert.doesNotMatch(balance.answer,/999999/);
  assert.equal(balance.source,'fallback'); assert.equal(balance.mode,'local');
  const write=await natural('Done, I added five points.').chat('今天独立阅读加5分',seed(),now);
  assert.notEqual(write.scope,'conversation'); assert.deepEqual(types(write),[]);
  assert.equal(write.source,'fallback'); assert.equal(write.mode,'local');
});
test('conversation regression: local and offline identity answers disclose their real source',async()=>{
  let calls=0;
  const disabled=createAssistantService({apiKey:'test-key',chatEnabled:false,formOnly:true,fetch:async()=>{calls++;throw new Error('unexpected');}});
  for (const text of ['你是谁','Who are you?','How do I use this app?','hello there']) {
    const result=await disabled.chat(text,seed(),now,{context:{form:'pointItem'}});
    assert.equal(result.kind,'answer'); assert.equal(result.source,'local'); assert.equal(result.mode,'local'); assert.match(result.answer,/本地/); assert.doesNotMatch(result.answer,/我是.*AI/);
  }
  assert.equal(calls,0,'form-only AI must not receive ordinary conversation');
  const failed=createAssistantService({apiKey:'test-key',chatEnabled:true,fetch:async()=>{throw new Error('PROVIDER_FAILURE_PRIVATE');}});
  const offline=await failed.chat('介绍一下自己',seed(),now);
  assert.equal(offline.kind,'answer'); assert.equal(offline.source,'fallback'); assert.equal(offline.mode,'local'); assert.match(offline.answer,/本地/); assert.doesNotMatch(offline.answer,/我是.*AI/); assert.doesNotMatch(JSON.stringify(offline),/PROVIDER_FAILURE_PRIVATE/);
});
test('conversation regression: draft then hello then an explicit score correction keeps the same pending behavior',async()=>{
  const service=local(),state=seed(),draft=await service.chat('今天独立阅读加5分',state,now),before=JSON.stringify(draft);
  const hello=await natural('你好！想先聊聊应用怎么用，还是整理一件待确认的小事？').chat('hello',state,now,{draft});
  assert.equal(hello.scope,'conversation'); assert.equal(hello.cancelDraft,undefined); assert.deepEqual(types(hello),[]); assert.equal(JSON.stringify(draft),before);
  const corrected=await service.chat('改成8分',state,now,{draft,messages:[{role:'user',text:'hello'},{role:'assistant',text:hello.answer,result:hello}]});
  assert.equal(corrected.action.type,'points.add'); assert.equal(corrected.action.payload.name,'独立阅读'); assert.equal(corrected.action.payload.points,8);
});
test('conversation regression: unsolicited business tools and invalid JSON structures during hello are explicitly fallback',async()=>{
  const draft={kind:'action',action:{type:'points.add',payload:{name:'独立阅读',points:5}}},snapshot=JSON.stringify(draft),state=seed(),before=JSON.stringify(state);
  for (const service of [tools([['draft_award',{name:'独立阅读',points:5}]]),tools([['draft_award',{name:'打招呼',points:5}]]),tools([['read_balance',{}]]),connected(draft),connected({kind:'query',query:{type:'balance'}}),connected({unexpected:'structure'})]) {
    const result=await service.chat('hi',state,now,{draft});
    assert.equal(result.source,'fallback'); assert.equal(result.mode,'local'); assert.deepEqual(types(result),[]); assert.equal(result.cancelDraft,undefined); assert.equal(result.query,undefined);
    assert.equal(JSON.stringify(draft),snapshot); assert.equal(JSON.stringify(state),before);
  }
  const question=await connected({kind:'clarify',question:'要调整哪一个行为？'}).chat('修改行为',state,now);
  assert.equal(question.source,'model','an actual accepted model question keeps its real provenance');
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
    assert.equal(T.conversationTopic(text),'');
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
