'use strict';

// This module only reads state and validates proposals. M.apply returns a copy;
// no database, grant, receipt, or persistence API is available to the tools.
const M = require('./model.js');
const configured = require('./config/assistant/tools.json');
const ZONE = 'Asia/Shanghai';
const ROUTES = Object.freeze({points:'积分',pointItems:'常用行为',rewards:'礼品',redemptions:'兑换记录',reminders:'提醒',family:'家庭管理',parent:'家长验证',partner:'伙伴',farm:'农场',profile:'孩子资料',settings:'设置'});
const IMPLEMENTED = ['read_balance','read_ledger','read_week_summary','read_rules','read_rewards','read_requests','read_tasks','read_family_settings','read_guidance',
  'draft_award','draft_rule','draft_reward','draft_redemption_request','draft_redemption_approval','draft_redemption_cancel',
  'draft_direct_redemption','draft_rule_delete','draft_reminder','draft_reminder_status','draft_settings','open_view','ask_clarification'];
const contracts = new Map(configured.tools.map(tool => [tool.function.name, tool.function.parameters]));
if (configured.version !== 1 || contracts.size !== IMPLEMENTED.length || IMPLEMENTED.some(name => !contracts.has(name))) {
  throw new Error('助手工具配置与服务端白名单不一致');
}
const plain = value => !!value && Object.getPrototypeOf(value) === Object.prototype;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const clean = value => typeof value === 'string' ? value.trim() : '';
const copy = (value, keys) => Object.fromEntries(keys.filter(key => own(value, key)).map(key => [key,value[key]]));
const clarify = question => ({kind:'clarify',question});
const answer = (title, text, query, data) => ({kind:'answer',title,answer:text,query,data});
const entity = (list, id) => list.find(row => row.id === id);
function isDraftCancellation(text) {
  if (typeof text!=='string') return false;
  const value=text.trim();
  return /^(?:请|帮我)?(?:取消|撤销|放弃)(?:这张|这个|当前|这份|这次的)?(?:草稿|候选)(?:吧|就好|了)?[。！!]*$/.test(value) ||
    /^(?:这笔|这次|这个|它)(?:先)?(?:不记了|别记了|不要记了|不保存了|先不保存)(?:吧)?[。！!]*$/.test(value) ||
    /^(?:把)?(?:这张|这个|当前)(?:草稿|候选)(?:取消|撤销|放弃)(?:吧|了)?[。！!]*$/.test(value);
}
function route(view) {
  if (!own(ROUTES, view)) return clarify('请从积分、礼品、提醒或家庭页面选择要使用的功能。');
  return {kind:'route',route:view,title:'打开' + ROUTES[view],reason:'请在' + ROUTES[view] + '界面查看和确认。'};
}
function valid(schema, value) {
  if (schema.type === 'object') {
    if (!plain(value)) return false;
    if ((schema.required || []).some(key => !own(value,key))) return false;
    return Object.keys(value).every(key => own(schema.properties,key) && valid(schema.properties[key],value[key]));
  }
  if (schema.type === 'integer' && (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum)) return false;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return false;
  if (schema.type === 'string' && (typeof value !== 'string' || value.length > schema.maxLength || value.length < (schema.minLength || 0) ||
      (schema.pattern && !new RegExp(schema.pattern).test(value)))) return false;
  return !schema.enum || schema.enum.includes(value);
}
function validateCall(name, args) {
  return IMPLEMENTED.includes(name) && valid(contracts.get(name),args);
}
function toolDefinitions() { return JSON.parse(JSON.stringify(configured.tools)); }
function joinSteps(steps) {
  if (steps.length === 1) return steps[0];
  return {kind:'steps',title:'逐项核对',summary:'查询按当前记录计算；候选需要逐项确认，尚未记账。',steps};
}
function deferFollowups(result,text) {
  if (result.kind!=='steps' || !/加完|加分后|记完|之后|然后|再(?:查|看|核对)/.test(text)) return result;
  const before=[];
  return {...result,steps:result.steps.map((row,index)=>{
    if (row.kind==='action') before.push(index);
    if (row.kind!=='answer' || !row.query || !before.length) return row;
    return {kind:'answer',title:'确认后再核对',answer:'先确认前面的候选，完成后会按最新记录重新核对。',query:row.query,deferred:true,after:before.slice(),...(row.mode?{mode:row.mode}:{}),...(row.source?{source:row.source}:{}),...(row.label?{label:row.label}:{})};
  })};
}
function resolveFollowup(result,state,now,options={}) {
  if (!plain(result) || result.kind!=='steps' || !Array.isArray(result.steps)) return result;
  const committed=new Set(Array.isArray(options.committedIndexes)?options.committedIndexes:[]);
  const steps=result.steps.map((row,index)=>{
    if (!plain(row) || row.kind!=='answer' || !Array.isArray(row.after) || !row.after.length || row.after.length>6) return row;
    if (!row.after.every(dependency=>Number.isSafeInteger(dependency) && dependency>=0 && dependency<index && result.steps[dependency].kind==='action' && committed.has(dependency))) return row;
    const computed=queryResult(row.query,state,new Date(now));
    if (computed.kind!=='answer') return {...computed,after:row.after.slice(),deferred:false,mode:'local',source:'local',label:'请重新核对查询'};
    return {...computed,after:row.after.slice(),deferred:false,resolvedAt:new Date(now).toISOString(),mode:'local',source:'local',label:'已按最新记录核对'};
  });
  return {...result,steps};
}
function ledgerRows(state, since, today) {
  const rows = [];
  function append(list, kind, sign) {
    for (const row of list || []) {
      const day = M.dateKey(row.at,ZONE);
      if (day >= since && day <= today) rows.push({id:row.id,kind,name:row.name,points:sign * row.points,at:row.at,day});
    }
  }
  append(state.points,'award',1); append(state.redemptions,'redemption',-1); append(state.petPurchases,'partner',-1);
  return rows.sort((a,b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
}
function read(name, args, state, now) {
  const today = M.dateKey(now,ZONE), totals = M.totals(state);
  if (name === 'read_balance') return answer('积分余额','现在可用 ' + totals.available + ' 分，累计获得 ' + totals.earned + ' 分，已消费 ' + totals.spent + ' 分。',{type:'balance'},totals);
  if (name === 'read_ledger' || name === 'read_week_summary') {
    const days = name === 'read_week_summary' ? 7 : (args.days || 7), since = M.addDays(today,1-days,ZONE), rows = ledgerRows(state,since,today);
    const earned = rows.filter(row => row.points > 0).reduce((sum,row) => sum+row.points,0), spent = -rows.filter(row => row.points < 0).reduce((sum,row) => sum+row.points,0);
    if (name === 'read_week_summary') {
      const completed = state.tasks.filter(row => !row.deleted && row.done && row.date >= since && row.date <= today).length;
      const data = {from:since,to:today,earned,spent,net:earned-spent,completed,available:totals.available};
      return answer('七日小结',since + ' 至 ' + today + '：获得 ' + earned + ' 分，消费 ' + spent + ' 分，净变化 ' + (earned-spent) + ' 分；这七天安排中已完成 ' + completed + ' 条提醒。当前可用 ' + totals.available + ' 分。',{type:'week'},data);
    }
    const visible = rows.slice(0,args.limit || 20), data = {from:since,to:today,total:rows.length,earned,spent,rows:visible};
    return answer('积分流水',visible.length ? since + ' 至 ' + today + '：\n' + visible.map(row => row.day+' '+row.name+' '+(row.points>0?'+':'')+row.points+' 分').join('\n') + (rows.length>visible.length?'\n还有 '+(rows.length-visible.length)+' 条，请到积分记录查看。':'') : since+' 至 '+today+' 没有积分流水。',{type:'ledger',days,limit:args.limit || 20},data);
  }
  if (name === 'read_rules') {
    const rows = state.pointItems.filter(row => args.includeDisabled || row.enabled).map(row => copy(row,['id','name','points','reason','enabled']));
    return answer('常用行为规则',rows.length ? rows.map(row => row.name+'：每次 '+row.points+' 分'+(row.enabled?'':'（已停用）')).join('\n') : '还没有符合条件的常用行为规则。',{type:'rules',includeDisabled:!!args.includeDisabled},{rows});
  }
  if (name === 'read_rewards') {
    if (args.rewardId && !entity(state.rewards,args.rewardId)) return clarify('没有找到这个礼品，请从当前家庭礼品列表重新选择。');
    const pending = (state.requests || []).find(row => row.status === 'pending');
    const rows = state.rewards.filter(row => !args.rewardId || row.id === args.rewardId).map(row => {
      const permission = M.availability(state,row.id,now,ZONE);
      return {...copy(row,['id','name','points','category','enabled']),allowed:permission.allowed,reason:permission.reason,gap:Math.max(0,row.points-totals.available),pending:!!pending && pending.rewardId === row.id};
    }).filter(row => !args.onlyEligible || row.allowed);
    return answer('礼品资格',rows.length ? rows.map(row => row.name+'：'+row.points+' 分；'+(row.allowed?'积分和日期条件已满足，可以申请，仍需家长确认':row.reason)+(row.pending?'；已有待确认申请':'')).join('\n') : '现在没有符合积分和日期条件的礼品。',{type:'rewards',...args},{available:totals.available,rows});
  }
  if (name === 'read_requests') {
    const status = args.status || 'all', rows = (state.requests || []).filter(row => status === 'all' || row.status === status).map(row => copy(row,['id','rewardId','name','points','status','createdAt','updatedAt']));
    const labels = {pending:'等待家长确认',approved:'已批准',cancelled:'已取消'};
    return answer('兑换申请',rows.length ? rows.map(row => row.name+'：'+row.points+' 分，'+labels[row.status]).join('\n') : '没有符合条件的兑换申请。',{type:'requests',status},{rows});
  }
  if (name === 'read_tasks') {
    const date = args.date || today; M.dateKey(date,ZONE);
    const rows = state.tasks.filter(row => row.date === date && !row.deleted && (args.includeDone || !row.done)).map(row => copy(row,['id','title','date','time','type','done'])).sort((a,b) => a.time.localeCompare(b.time));
    return answer('提醒',rows.length ? date+'：\n'+rows.map(row => (row.time || '全天')+' '+row.title+(row.done?'（已完成）':'')).join('\n') : date+' 没有符合条件的提醒。',{type:'tasks',date,includeDone:!!args.includeDone},{date,rows});
  }
  if (name === 'read_family_settings') {
    const reward=entity(state.rewards,state.settings.preferredReward), data={monthEndDays:state.settings.monthEndDays,preferredReward:state.settings.preferredReward,preferredRewardName:reward ? reward.name : ''};
    return answer('家庭积分设置','月末礼品在每月最后 '+data.monthEndDays+' 天可申请；'+(reward?'当前心愿礼品是“'+reward.name+'”。':'还没有设置心愿礼品。'),{type:'settings'},data);
  }
  if (name === 'read_guidance') {
    if (args.topic==='week') {
      const summary=read('read_week_summary',{},state,now);
      return answer('根据已记录内容聊一聊',summary.answer+'\n这些只代表已经记录的内容，没记录也可能是漏记，不能据此判断孩子是否努力。可以和孩子一起聊聊哪里顺利、哪里需要帮助，再由家长决定下一步。',{type:'guidance',topic:'week'},summary.data);
    }
    const rows=args.behavior?namedMatches(state.pointItems.filter(row=>row.enabled),args.behavior,'name'):state.pointItems.filter(row=>row.enabled);
    const facts=rows.length?rows.slice(0,6).map(row=>row.name+'：已有规则每次 '+row.points+' 分').join('\n'):'当前没有匹配的常用行为规则。';
    return answer('分值参考',facts+'\n是否沿用已有规则由家长决定。若是新行为，可以先和孩子约定做到哪一步，再决定分值；这里只给参考，不会替你加分或新建规则。',{type:'guidance',topic:'points',...(args.behavior?{behavior:args.behavior}:{})},{rows:rows.slice(0,6).map(row=>copy(row,['id','name','points'])),truncated:rows.length>6});
  }
  return clarify('没有这个查询工具，请使用页面上的对应功能。');
}
function queryResult(query,state,now) {
  if (!plain(query) || typeof query.type !== 'string') return clarify('请选择要查询的积分、流水、规则、礼品或提醒。');
  const mapping = {balance:'read_balance',ledger:'read_ledger',week:'read_week_summary',seven_days:'read_week_summary',rules:'read_rules',point_items:'read_rules',rewards:'read_rewards',requests:'read_requests',tasks:'read_tasks',settings:'read_family_settings',guidance:'read_guidance'};
  const args = {...query}; delete args.type;
  if (query.type === 'redeemable') return executeTool('read_rewards',{...args,onlyEligible:true},state,now);
  if (query.type === 'reward_gap') return executeTool('read_rewards',args,state,now);
  return mapping[query.type] ? executeTool(mapping[query.type],args,state,now) : clarify('暂时不能查询这项内容，请打开对应界面。');
}
function sourceText(options) {
  const messages = Array.isArray(options.messages) ? options.messages : [];
  return messages.filter(row => row && row.role === 'user' && typeof (row.text || row.content) === 'string').slice(-8).map(row => row.text || row.content).concat(options.text || '').join('\n');
}
function numericValues(text) {
  const digits = {'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
  return [...text.matchAll(/(?:积分|分值)\s*(?:为|是|[:：])?\s*([零〇一二两三四五六七八九十百\d]+)|([零〇一二两三四五六七八九十百\d]+)\s*(?:个)?(?:积分|分(?!钟))/g)].filter(match => {
    const token=match[1] || match[2], at=match.index+match[0].indexOf(token), before=text.slice(0,at), after=text.slice(at+token.length);
    return !/[.．点]\s*$|(?:[-－]|负)\s*$/.test(before) && !/^\s*[.．点]/.test(after);
  }).map(match => {
    const token = match[1] || match[2];
    if (/^\d+$/.test(token)) return Number(token);
    let total=0,current=0;
    for (const char of token) { if (own(digits,char)) current=digits[char]; else if (char==='十') { total+=(current||1)*10; current=0; } else if (char==='百') { total+=(current||1)*100; current=0; } }
    return total+current;
  });
}
function activeDraft(options) {
  const result = options.draft;
  if (!plain(result)) return null;
  if (result.kind === 'action' || result.kind === 'form') return result;
  const rows = result.kind === 'steps' && Array.isArray(result.steps) ? result.steps.filter(row => row.kind === 'action' || row.kind === 'form') : [];
  return rows.length === 1 ? rows[0] : null;
}
function namedMatches(list,text,field) {
  const available = list.filter(row => !row.deleted);
  const exact = available.filter(row => typeof row[field] === 'string' && text.includes(row[field]));
  if (exact.length) return exact;
  return available.filter(row => {
    const reduced = row[field].replace(/^(一起|主动|自己|自主|小小|彩虹|小熊|一次|一份|一个)/,'').replace(/(一次|一份|一个)$/,'').replace(/^(?:吃|看|买|去)/,'');
    if (reduced.length>=2 && text.includes(reduced)) return true;
    return /阅读/.test(row[field]) && /读书/.test(text) || /读书/.test(row[field]) && /阅读/.test(text);
  });
}
function selectedId(options) {
  const context = plain(options.context) ? options.context : {};
  return clean(options.targetId || context.targetId);
}
function entityAllowed(list,id,field,options) {
  const row = entity(list,id);
  if (!row || row.deleted) return false;
  if (!options.enforceIntent) return true;
  const text = clean(options.text), matches = namedMatches(list,text,field);
  if (matches.length) return matches.some(match=>match.id===id) && (matches.length===1 || selectedId(options)===id);
  if (selectedId(options) === id) return true;
  const draft = activeDraft(options), payload = draft && draft.action && draft.action.payload;
  if (payload && [payload.itemId,payload.rewardId,payload.requestId,payload.taskId,payload.item && payload.item.id,payload.reward && payload.reward.id,payload.task && payload.task.id].includes(id)) return true;
  if (/^(?:那|这个|那个|它|改|调整|设为|换|不对|不是|是|每次|这次|以后)|^[零〇一二两三四五六七八九十百\d]+\s*分/.test(text)) {
    const prior = (options.messages || []).filter(message => message.role === 'user').slice(-1)[0];
    const previous = prior && namedMatches(list,prior.text || prior.content || '',field);
    return !!previous && previous.length === 1 && previous[0].id === id;
  }
  return false;
}
function noRedemption(text) { return /只查|只看|不兑|别兑|不要兑|先不兑|不申请|别申请|不要申请|不扣|别扣/.test(text); }
function disallowedIntent(type,options) {
  if (!options.enforceIntent) return '';
  const text = clean(options.text), recurring = /以后|每次|每天|每日|规则|常用|模板/.test(text);
  if ((type.startsWith('redemption.') || type === 'reward.redeem') && noRedemption(text)) return '这次只查询礼品资格，不会生成兑换操作。';
  if (type === 'points.add' && (/不加分|不要加|别加分|先别加|不记账/.test(text) || recurring && !/今天|这次|刚才|一次性/.test(text))) return '这是以后使用的规则吗，还是这次实际加分？请先确认。';
  if (type === 'pointItem.save' && /不是规则|不要规则|不存(?:为)?常用|只(?:加|记)这次|只(?:加|记)一次/.test(text)) return '这次只加分吗？请确认行为名称和分值。';
  return '';
}
const actionSchemas = {
  'points.add':['draft_award',null], 'pointItem.save':['draft_rule','item'], 'reward.save':['draft_reward','reward'],
  'task.save':['draft_reminder','task'], 'redemption.request':['draft_redemption_request',null],
  'redemption.cancel':['draft_redemption_cancel',null], 'pointItem.delete':['draft_rule_delete',null],
  'settings.update':['draft_settings','settings']
};
function actionPayloadValid(type,payload) {
  const shape = actionSchemas[type];
  if (shape) return shape[1] ? valid({type:'object',properties:{[shape[1]]:contracts.get(shape[0])},required:[shape[1]]},payload) : validateCall(shape[0],payload);
  const idSchema = contracts.get('draft_redemption_request').properties.rewardId;
  if (type === 'redemption.approve' || type === 'reward.redeem') {
    return valid({type:'object',properties:{[type==='reward.redeem'?'rewardId':'requestId']:idSchema,expectedPoints:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER}},required:[type==='reward.redeem'?'rewardId':'requestId','expectedPoints']},payload);
  }
  if (['task.toggle','task.ack','task.snooze'].includes(type)) return valid({type:'object',properties:{taskId:idSchema,...(type==='task.snooze'?{minutes:{type:'integer',minimum:10,maximum:10}}:{})},required:['taskId',...(type==='task.snooze'?['minutes']:[])]},payload);
  return false;
}
function normalizeAction(action,state,now,options={}) {
  if (!plain(action) || Object.keys(action).some(key => !['type','payload'].includes(key)) || !plain(action.payload) || !actionPayloadValid(action.type,action.payload)) return clarify('候选操作的字段不符合要求，请重新描述或使用对应表单。');
  const type = action.type, p = JSON.parse(JSON.stringify(action.payload)), intent = disallowedIntent(type,options);
  if (intent) return clarify(intent);
  const references = [];
  if (p.itemId) references.push([state.pointItems,p.itemId,'name']);
  if (p.item && p.item.id) references.push([state.pointItems,p.item.id,'name']);
  if (p.rewardId) references.push([state.rewards,p.rewardId,'name']);
  if (p.reward && p.reward.id) references.push([state.rewards,p.reward.id,'name']);
  if (p.taskId || p.task && p.task.id) references.push([state.tasks,p.taskId || p.task.id,'title']);
  if (p.requestId) references.push([(state.requests || []).filter(row=>type!=='redemption.approve' || row.status==='pending'),p.requestId,'name']);
  if (p.settings && p.settings.preferredReward) references.push([state.rewards,p.settings.preferredReward,'name']);
  if (references.some(([list,id,field]) => !entityAllowed(list,id,field,options))) return clarify('没有唯一确定这次要处理的对象，请说完整名称，或从列表重新选择。');
  if (options.enforceIntent) {
    const score = type === 'points.add' ? p.points : (p.item || p.reward || {}).points;
    const old = p.item && p.item.id ? entity(state.pointItems,p.item.id) : p.reward && p.reward.id ? entity(state.rewards,p.reward.id) : p.itemId ? entity(state.pointItems,p.itemId) : null;
    const draft = activeDraft(options), prior = draft && (draft.fields || draft.action && (draft.action.payload.item || draft.action.payload.reward || draft.action.payload));
    const current=numericValues(clean(options.text)), evidence=current.length?current:numericValues(sourceText(options));
    if (score !== undefined && (current.length && !current.includes(score) || !evidence.includes(score) && !(old && old.points===score) && !(prior && prior.points===score))) return clarify('请明确这次使用的积分分值，时间和次数不会当作积分。');
  }
  if (type === 'points.add') {
    if (options.enforceIntent && own(p,'reason')) {
      const draft=activeDraft(options), prior=draft && draft.action && draft.action.type==='points.add' && draft.action.payload.reason;
      const explicit=/(?:原因|理由)(?:是|为|[:：])|因为/.test(clean(options.text));
      if (!explicit && prior!==p.reason || p.reason && !clean(options.text).includes(p.reason.trim()) && prior!==p.reason) delete p.reason;
    }
  }
  if (type === 'redemption.approve' || type === 'reward.redeem') {
    const request = type==='redemption.approve' && entity(state.requests || [],p.requestId), reward = entity(state.rewards,request ? request.rewardId : p.rewardId);
    if (!reward || p.expectedPoints !== reward.points) return clarify('礼品价格或申请已变化，请按最新记录重新确认。');
  }
  if (type==='task.save' && !p.task.id && !own(p.task,'time')) return clarify('希望几点提醒？也可以明确说全天提醒。');
  if (type==='pointItem.save' && !p.item.id && (!p.item.name || !p.item.points)) {
    const fields = copy(p.item,['name','points','reason','enabled']);
    const missing = ['name','points'].filter(key => !fields[key]);
    return {kind:'form',form:'pointItem',title:'新建常用行为',fields,missing,question:missing.includes('name')?'这个常用行为叫什么？':'这个常用行为以后每次加多少分？'};
  }
  const flat = {id:'assistant-check-'+now.getTime(),type,...p};
  while ((state.appliedActions || []).includes(flat.id)) flat.id+='-next';
  try { M.apply(state,flat,now,ZONE); }
  catch (error) { return clarify(error.message); }
  const titles = {'points.add':'确认本次加分','pointItem.save':'确认常用行为规则','pointItem.delete':'确认删除常用行为','reward.save':'确认礼品设置','redemption.request':'确认兑换申请','redemption.approve':'确认批准兑换','redemption.cancel':'确认取消申请','reward.redeem':'确认直接兑换','task.save':'确认提醒','task.toggle':'确认提醒状态','task.ack':'确认知道了','task.snooze':'确认十分钟后提醒','settings.update':'确认设置'};
  let summary = '候选尚未保存，请检查后确认。';
  if (type==='points.add') { const item=p.itemId && entity(state.pointItems,p.itemId); summary=(p.name || item.name)+' · +'+(p.points || item.points)+' 分'+(p.reason?' · '+p.reason:''); }
  else if (p.item) { const row={...(entity(state.pointItems,p.item.id)||{}),...p.item}; summary=row.name+' · 每次 '+row.points+' 分'+(row.enabled===false?' · 停用':''); }
  else if (p.reward) { const row={...(entity(state.rewards,p.reward.id)||{}),...p.reward}; summary=row.name+' · '+row.points+' 分'; }
  else if (p.task) { const row={...(entity(state.tasks,p.task.id)||{}),...p.task}; summary=row.date+' '+(row.time||'全天')+' · '+row.title; }
  else if (p.rewardId) summary=entity(state.rewards,p.rewardId).name+' · '+entity(state.rewards,p.rewardId).points+' 分，尚未扣分';
  else if (p.requestId) summary=entity(state.requests,p.requestId).name+' · 需在确认界面办理';
  else if (p.taskId) summary=entity(state.tasks,p.taskId).title;
  else if (p.itemId) summary=entity(state.pointItems,p.itemId).name+' · 历史积分保留';
  return {kind:'action',action:{type,payload:p},title:titles[type],summary};
}
function executeTool(name,args,state,now,options={}) {
  if (!validateCall(name,args)) return clarify('工具名称或字段不符合要求，请重新描述。');
  if (name.startsWith('read_')) return read(name,args,state,now);
  if (name==='open_view') return route(args.route);
  if (name==='ask_clarification') {
    const question=clean(args.question);
    return clarify(!question || /已保存|已加分|已扣|已兑换|验证通过|余额|可用\s*\d/.test(question) ? '请补充要处理的事项或明确目标。' : question);
  }
  const mappings={draft_award:['points.add',args],draft_rule:['pointItem.save',{item:args}],draft_reward:['reward.save',{reward:args}],draft_reminder:['task.save',{task:args}],draft_settings:['settings.update',{settings:args}],draft_redemption_request:['redemption.request',args],draft_redemption_cancel:['redemption.cancel',args],draft_rule_delete:['pointItem.delete',args]};
  if (mappings[name]) { const [type,payload]=mappings[name]; return normalizeAction({type,payload},state,now,options); }
  if (name==='draft_redemption_approval' || name==='draft_direct_redemption') {
    const request = name==='draft_redemption_approval' && entity(state.requests || [],args.requestId), reward=entity(state.rewards,request ? request.rewardId : args.rewardId);
    if (!reward) return clarify('没有找到对应礼品或申请，请重新选择。');
    return normalizeAction({type:request?'redemption.approve':'reward.redeem',payload:{...args,expectedPoints:reward.points}},state,now,options);
  }
  const row=entity(state.tasks,args.taskId);
  if (!row || row.deleted) return clarify('这条提醒已不存在，请重新选择。');
  if ((args.operation==='done' && row.done) || (args.operation==='undo' && !row.done)) return answer('提醒状态',row.title+(row.done?'已经完成。':'已经是未完成状态。'),{type:'tasks',date:row.date,includeDone:true},{rows:[copy(row,['id','title','date','time','done'])]});
  const type={done:'task.toggle',undo:'task.toggle',ack:'task.ack',snooze:'task.snooze'}[args.operation];
  return normalizeAction({type,payload:{taskId:args.taskId,...(type==='task.snooze'?{minutes:10}:{})}},state,now,options);
}
function normalizeResult(candidate,state,now,options={}) {
  if (!plain(candidate)) return clarify('没有理解清楚，请换个说法。');
  if (candidate.kind==='steps') {
    if (!Array.isArray(candidate.steps) || candidate.steps.length<1 || candidate.steps.length>6 || candidate.steps.some(row => !plain(row) || row.kind==='steps')) return clarify('一次最多整理六项，请把复杂任务分开说。');
    return joinSteps(candidate.steps.map(row => normalizeResult(row,state,now,options)));
  }
  if (candidate.kind==='action') return normalizeAction(candidate.action,state,now,options);
  if (candidate.kind==='form' && candidate.form==='pointItem') return normalizeAction({type:'pointItem.save',payload:{item:candidate.fields}},state,now,options);
  if (candidate.kind==='query' || candidate.kind==='answer') return queryResult(candidate.query,state,now);
  if (candidate.kind==='route') return route(candidate.route);
  if (candidate.kind==='clarify') return executeTool('ask_clarification',{question:candidate.question},state,now,options);
  return clarify('请描述积分、常用行为、礼品或提醒，也可以打开对应界面。');
}
module.exports={ZONE,ROUTES,plain,copy,clarify,route,read,toolDefinitions,validateCall,executeTool,normalizeAction,normalizeResult,queryResult,joinSteps,deferFollowups,resolveFollowup,isDraftCancellation,activeDraft,namedMatches,numericValues,noRedemption};
