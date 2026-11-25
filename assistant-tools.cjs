'use strict';

// This module only reads state and validates proposals. M.apply returns a copy;
// no database, grant, receipt, or persistence API is available to the tools.
const M = require('./model.js');
const configured = require('./config/assistant/tools.json');
const ZONE = 'Asia/Shanghai';
const ROUTES = Object.freeze({points:'积分',pointItems:'常用行为',rewards:'礼品',redemptions:'兑换记录',reminders:'提醒',family:'家庭管理',parent:'家长验证',partner:'伙伴',farm:'农场',profile:'孩子资料',settings:'设置'});
const IMPLEMENTED = ['read_balance','read_ledger','read_week_summary','read_rules','read_rewards','read_requests','read_tasks','read_family_settings','read_guidance',
  'draft_award','draft_rule','draft_reward','draft_redemption_request','draft_redemption_approval','draft_redemption_cancel',
  'draft_direct_redemption','draft_rule_delete','draft_reminder','draft_reminder_status','draft_settings','open_view','ask_clarification','respond_conversation','cancel_draft'];
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
// Local fallback parser only; connected model execution does not classify text.
function conversationTopic(text) {
  const value=clean(text);
  if (!value) return '';
  const help=/如何|怎样|怎么.{0,20}(?:用|操作|开始|设置|添加|记录|查看|查|兑换|管理)|用法|使用方法|第一次(?:用|打开)|从哪(?:里)?开始|操作顺序|\bhow (?:do|can|should) I\b|\bhow (?:does|to|can I use)\b|\bwhere (?:do|should) I start\b/i.test(value);
  const businessCommand=/(?:加|给|奖励|记)\s*[零〇一二两三四五六七八九十百\d]+\s*(?:分(?!钟)|积分)|(?:请|帮我|直接).*(?:保存|兑换|批准|取消|修改)|提醒(?:我|我们|孩子|他|她)|\bremind (?:me|us|him|her)\b|\b(?:add|award|give|redeem|approve|cancel|save|update)\b.{0,40}\b(?:points?|credits?|reward|request|rule|reminder)\b/i.test(value);
  if (!help && (businessCommand || readQueryFromText(value) || /\b(?:my|our|current|available|remaining)\s+(?:\w+\s+){0,2}(?:balance|points?|credits?|requests?|reminders?)\b/i.test(value))) return '';
  if (help) return 'product_help';
  if (/你(?:是|叫|算是).{0,12}(?:谁|什么|名字|身份|角色|助手)|你的(?:名字|身份|角色)|(?:介绍|说说).{0,12}(?:自己|身份|你自己)|\b(?:who|what) are you\b|\b(?:introduce|describe) yourself\b|\btell me about yourself\b|\bwhat(?:'s| is| are) your (?:name|role|purpose|job)\b/i.test(value)) return 'identity';
  if (/(?:你|助手|应用|app|这里).{0,16}(?:能|可以|会|有|支持).{0,16}(?:什么|哪些|啥|用|帮助|功能)|能帮.{0,10}什么|有哪些功能|支持哪些功能|\b(?:what (?:can|do) you|what you can) (?:do|help)\b|\bwhat are your (?:features|capabilities)\b/i.test(value)) return 'capabilities';
  const greeting=/^(?:你好|您好|嗨|早安|早上好|下午好|晚上好|晚安|谢谢|辛苦了|hello\b|hi\b|hey\b|good (?:morning|afternoon|evening)\b|thank(?:s| you)\b)/i.exec(value);
  if (greeting) {
    const rest=value.slice(greeting[0].length).replace(/^[，,.。！!？?\s]+|[，,.。！!？?\s]+$/g,'');
    return !rest || /^(?:there|everyone|everybody|all|friend|friends|again)$/i.test(rest)?'greeting':conversationTopic(rest);
  }
  if (/聊(?:聊|一聊|天)|最近怎么样|你好吗|\bhow are you\b|\b(?:let's|can we) (?:chat|talk)\b/i.test(value)) return 'small_talk';
  return '';
}
function conversationReply(message) {
  if (typeof message!=='string' || !message.trim() || message.length>18000) return clarify('回复文字的格式不符合要求，请重试。');
  return {kind:'answer',scope:'conversation',title:'家长助手',answer:message};
}
// Local fallback parser only; connected cancellation uses cancel_draft.
function isDraftCancellation(text) {
  if (typeof text!=='string') return false;
  const value=text.trim();
  return /^(?:请|帮我)?(?:取消|撤销|放弃)(?:这张|这个|当前|这份|这次的)?(?:草稿|候选)(?:吧|就好|了)?[。！!]*$/.test(value) ||
    /^(?:这笔|这次|这个|它)(?:先)?(?:不记了|别记了|不要记了|不保存了|先不保存)(?:吧)?[。！!]*$/.test(value) ||
    /^(?:把)?(?:这张|这个|当前)(?:草稿|候选)(?:取消|撤销|放弃)(?:吧|了)?[。！!]*$/.test(value);
}
function periodFromText(text) {
  if (/最近\s*(?:7|七)\s*(?:天|日)|过去\s*(?:7|七)\s*(?:天|日)|近七日|近7日|七日|7日|七天|7天|最近一周|近一周/.test(text)) return 'last7';
  return /本周|这周|本星期|这个星期/.test(text)?'week':'';
}
function behaviorFromText(text,state) {
  const phrase=text.replace(/最近\s*(?:7|七)\s*(?:天|日)|过去\s*(?:7|七)\s*(?:天|日)|近七日|近7日|七日|7日|七天|7天|最近一周|近一周|本周|这周|本星期|这个星期/g,'')
    .replace(/^(?:(?:那|请|帮我|看看|查看|查询|统计|查一下|看一下|我想知道|我想看)[，,\s]*)+/,'').replace(/[？?。！!\s]+$/,'');
  const match=/^(?:给)?(.*?)(?:一共|总共|累计)?(?:加了|获得了?|拿了|得了|奖励了?|加分|得分)(?:几分|多少(?:个)?积分|多少分)?$/.exec(phrase) || /^(.*?)(?:的)?(?:积分)?(?:小结|总结|汇总|统计|流水|记录)$/.exec(phrase);
  if (!match) return '';
  let value=match[1].trim().replace(/(?:一共|总共|累计)$/,'');
  if (state && value===state.childName || /^(?:我|他|她|孩子|宝宝|全部|总共|所有行为|积分|一共|总积分)?$/.test(value)) return '';
  return value.length<=120?value:'';
}
function readQueryFromText(text,state) {
  if (/(?:然后|另外|顺便|同时|并且|[；;]|[，,]\s*再)/.test(text)) return null;
  if (/(?:加|给|奖励|记)\s*[零〇一二两三四五六七八九十百\d]+\s*(?:分(?!钟)|积分)/.test(text)) return null;
  const period=periodFromText(text), behavior=period?behaviorFromText(text,state):'';
  if (/流水|积分记录|加分记录|消费记录|收支|积分历史/.test(text) && !/添加|新增|修改|删除/.test(text)) return {type:'ledger',...(period?{period}:{}),...(behavior?{behavior}:{})};
  if (period && /小结|总结|汇总|统计|几分|多少(?:个)?积分|多少分|得分/.test(text) && !/规则|每次|提醒|该给/.test(text)) return {type:'week',period,...(behavior?{behavior}:{})};
  if (/余额|多少(?:个)?积分|还有多少分|剩(?:余|下)多少分|查积分|累计.*分|已(?:消费|兑换).*分/.test(text) && !/新增|添加|改为|改成/.test(text)) return {type:'balance'};
  return null;
}
function sameDraftCorrection(text,draft) {
  if (!plain(draft)) return false;
  const value=clean(text).replace(/^(?:(?:那么|那|请帮我|帮我|请)[，,\s]*)+/,'');
  if (/^(?:把)?(?:(?:这(?:个|张|笔)|当前|刚才的|上一个)(?:草稿|候选|行为|规则)?的?)?(?:分值|积分|行为名称|名称|名字|预设原因|原因|理由|日期|时间)(?:改成|改为|改到|调整为|设为|设置为|是|为|[:：])/.test(value)) return true;
  if (/^(?:把)?(?:这张草稿|这个候选|这笔|当前草稿|刚才那笔).*(?:改成|改为|改到|调整为|设为|启用|停用)/.test(value)) return true;
  const type=draft.kind==='form'?'pointItem.save':draft.action && draft.action.type;
  if (type==='task.save') return /^(?:改成|改为|改到|调整为|设为)(?:今天|明天|后天|\d{4}[-年]|\d{1,2}月|早上|上午|下午|晚上|全天|[零〇一二两三四五六七八九十\d]+[:：点时])/.test(value);
  const rest=value.replace(/[零〇一二两三四五六七八九十百\d]+/g,'').replace(/不对|不是|不要|应该|规则|常用|行为|加分|积分|分值|改成|改为|调整为|设置为|设为|以后|每天|每日|每次|今天|这次|一次性|一次|只|就|实际|奖励|给|加|记|是|为|分|启用|停用|[，,。:：；;！!？?\s]/g,'');
  return !rest && (numericValues(value).length>0 || /不是规则|不是(?:今天|这次|以后|每天|每次)|以后每次|只(?:给|加|记)(?:这次|一次)/.test(value));
}
function dateRange(now,period,days=7) {
  const parts=M.calendarParts(now,ZONE), back=period==='week'?(parts.weekday+6)%7:period==='last7'?6:days-1;
  return {from:M.addDays(parts.date,-back,ZONE),to:parts.date,...(period || days===7?{period:period || 'last7'}:{})};
}
function behaviorMatcher(behavior,state) {
  const canonical=value=>value.replace(/读书/g,'阅读');
  const selected=new Set(namedMatches(state.pointItems,behavior,'name').map(item=>item.id)), phrase=canonical(behavior);
  return row=>selected.has(row.itemId) || canonical(row.name).includes(phrase) || phrase.includes(canonical(row.name));
}
function pageRows(rows,limit=12) {
  return {rows:rows.slice(0,limit),total:rows.length,hasMore:rows.length>limit,limit};
}
function moreText(page) { return page.hasMore?'\n仅显示前 '+page.rows.length+' 条，共 '+page.total+' 条；更多内容请到对应记录页面查看。':''; }
function fitResult(result,state,now,preserved=[]) {
  let output=result;
  for (let attempt=0;attempt<6 && Buffer.byteLength(JSON.stringify(output))>18000;attempt++) {
    let changed=false;
    function reduce(row) {
      if (row.kind==='steps') return {...row,steps:row.steps.map(reduce)};
      if (preserved.includes(row)) return row;
      if (row.kind!=='answer' || !row.query || !row.data || !Array.isArray(row.data.rows) || row.data.rows.length<2) return row;
      const next=queryResult({...row.query,limit:Math.max(1,Math.floor(row.data.rows.length/2))},state,now);
      if (next.kind!=='answer') return row;
      changed=true;
      return {...row,...next};
    }
    output=reduce(output);
    if (!changed) break;
  }
  return output;
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
  if (schema.type === 'array') {
    return Array.isArray(value) && value.length >= (schema.minItems || 0) &&
      (schema.maxItems === undefined || value.length <= schema.maxItems) &&
      (!schema.uniqueItems || new Set(value).size === value.length) && value.every(item => valid(schema.items,item));
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
  if (!Array.isArray(steps) || !steps.length || steps.length>6) return clarify('一次最多整理六项，请把复杂任务分开说。');
  const cancelling=steps.some(row=>row.cancelDraft===true);
  if (cancelling && steps.some(row=>row.kind==='action' || row.kind==='form')) return clarify('取消草稿和新建候选请分两次办理。');
  const checked=steps.map((row,index)=>{
    if (!row.deferred) return row;
    if (!Array.isArray(row.after) || !row.after.length || !row.after.every(dependency=>Number.isSafeInteger(dependency) && dependency>=0 && dependency<index && steps[dependency].kind==='action')) return clarify('后续查询只能依赖前面的待确认操作。');
    return row;
  });
  if (checked.length === 1) return checked[0];
  return {kind:'steps',title:'逐项核对',summary:'查询按当前记录计算；候选需要逐项确认，尚未记账。',steps:checked,...(cancelling?{cancelDraft:true}:{})};
}
// Only the explicit local fallback parser uses text to infer sequencing.
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
  let changed=false;
  const steps=result.steps.map((row,index)=>{
    if (!plain(row) || row.kind!=='answer' || row.deferred!==true || !Array.isArray(row.after) || !row.after.length || row.after.length>6) return row;
    if (!row.after.every(dependency=>Number.isSafeInteger(dependency) && dependency>=0 && dependency<index && plain(result.steps[dependency]) && result.steps[dependency].kind==='action' && committed.has(dependency))) return row;
    const computed=queryResult(row.query,state,new Date(now));
    changed=true;
    if (computed.kind!=='answer') return {...computed,after:row.after.slice(),deferred:false,mode:'local',source:'local',label:'请重新核对查询'};
    return {...computed,after:row.after.slice(),deferred:false,resolvedAt:new Date(now).toISOString(),mode:'local',source:'local',label:'已按最新记录核对'};
  });
  // Existing answers are saved snapshots, including their displayed list size.
  // Only newly resolved queries may be resized to fit the result limit.
  return changed?fitResult({...result,steps},state,now,result.steps):result;
}
function ledgerRows(state, since, today) {
  const rows = [], actionIndexes = new Map((state.appliedActions || []).map((id,index)=>[id,index]));
  function append(list, kind, sign, prefix, sourceOrder) {
    for (const [index,row] of (list || []).entries()) {
      const day = M.dateKey(row.at,ZONE);
      if (day < since || day > today) continue;
      const actionId=row.id.startsWith(prefix)?row.id.slice(prefix.length):'';
      rows.push({value:{id:row.id,kind,name:row.name,points:sign * row.points,at:row.at,day,...(kind==='award'?{itemId:row.itemId}:{})},
        timestamp:new Date(row.at).getTime(),actionIndex:actionIndexes.get(actionId) ?? -1,sourceOrder,index});
    }
  }
  append(state.points,'award',1,'points-',0); append(state.redemptions,'redemption',-1,'redeem-',1); append(state.petPurchases,'partner',-1,'purchase-',2);
  // Match home-points: actual instants first, then saved action order. Legacy
  // ties keep source priority and reverse append order without inventing dates.
  return rows.sort((a,b)=>b.timestamp-a.timestamp || b.actionIndex-a.actionIndex || a.sourceOrder-b.sourceOrder || b.index-a.index).map(row=>row.value);
}
function read(name, args, state, now) {
  const today = M.dateKey(now,ZONE), totals = M.totals(state);
  if (name === 'read_balance') return answer('积分余额','现在可用 ' + totals.available + ' 分，累计获得 ' + totals.earned + ' 分，已消费 ' + totals.spent + ' 分。',{type:'balance'},totals);
  if (name === 'read_ledger' || name === 'read_week_summary') {
    const days=name==='read_week_summary'?7:(args.days || 7), range=dateRange(now,args.period,days), since=range.from;
    const all=ledgerRows(state,since,today), matches=args.behavior && behaviorMatcher(args.behavior,state), rows=matches?all.filter(row=>row.kind==='award' && matches(row)):all;
    const earned = rows.filter(row => row.points > 0).reduce((sum,row) => sum+row.points,0), spent = -rows.filter(row => row.points < 0).reduce((sum,row) => sum+row.points,0);
    if (name === 'read_week_summary') {
      if (args.behavior) return answer((range.period==='week'?'本周':'最近七日')+'行为加分',since+' 至 '+today+'，“'+args.behavior+'”相关加分共 '+earned+' 分（'+rows.length+' 笔）。这里只统计该行为的真实加分记录。',{type:'week',period:range.period,behavior:args.behavior},{...range,behavior:args.behavior,earned,count:rows.length});
      const completed = state.tasks.filter(row => !row.deleted && row.done && row.date >= since && row.date <= today).length;
      const label=range.period==='week'?'本周':'最近七日', data = {...range,earned,spent,net:earned-spent,completed,available:totals.available};
      return answer(label+'小结',label+' '+since + ' 至 ' + today + '：获得 ' + earned + ' 分，消费 ' + spent + ' 分，净变化 ' + (earned-spent) + ' 分；该范围安排中已完成 ' + completed + ' 条提醒。当前可用 ' + totals.available + ' 分。',{type:'week',period:range.period},data);
    }
    const query={type:'ledger',days,...(args.period?{period:args.period}:{}),...(args.behavior?{behavior:args.behavior}:{})};
    const summary=since+' 至 '+today+(args.behavior?'，“'+args.behavior+'”相关加分':'')+'：共获得 '+earned+' 分，消费 '+spent+' 分（'+rows.length+' 笔记录）。';
    if (args.summaryOnly) return answer('积分合计',summary,{...query,summaryOnly:true},{...range,total:rows.length,earned,spent});
    const data={...range,...pageRows(rows,args.limit || 20),earned,spent};
    const details=data.rows.length?'\n'+data.rows.map(row => row.day+' '+row.name+' '+(row.points>0?'+':'')+row.points+' 分').join('\n')+moreText(data):'\n没有符合条件的积分流水。';
    return answer('积分流水',summary+details,{...query,limit:data.limit},data);
  }
  if (name === 'read_rules') {
    const data=pageRows(state.pointItems.filter(row=>args.includeDisabled || row.enabled).map(row=>copy(row,['id','name','points','enabled'])),args.limit);
    return answer('常用行为规则',data.rows.length ? data.rows.map(row => row.name+'：每次 '+row.points+' 分'+(row.enabled?'':'（已停用）')).join('\n')+moreText(data) : '还没有符合条件的常用行为规则。',{type:'rules',includeDisabled:!!args.includeDisabled,limit:data.limit},data);
  }
  if (name === 'read_rewards') {
    if (args.rewardId && !entity(state.rewards,args.rewardId)) return clarify('没有找到这个礼品，请从当前家庭礼品列表重新选择。');
    const pending = (state.requests || []).find(row => row.status === 'pending');
    const rows = state.rewards.filter(row => !args.rewardId || row.id === args.rewardId).map(row => {
      const permission = M.availability(state,row.id,now,ZONE);
      return {...copy(row,['id','name','points','category','enabled']),allowed:permission.allowed,reason:permission.reason,gap:Math.max(0,row.points-totals.available),pending:!!pending && pending.rewardId === row.id};
    }).filter(row => !args.onlyEligible || row.allowed);
    const data={available:totals.available,...pageRows(rows,args.limit)};
    return answer('礼品资格',data.rows.length ? data.rows.map(row => row.name+'：'+row.points+' 分；'+(row.allowed?'积分和日期条件已满足，可以申请，仍需家长确认':row.reason)+(row.pending?'；已有待确认申请':'')).join('\n')+moreText(data) : '现在没有符合积分和日期条件的礼品。',{type:'rewards',...args,limit:data.limit},data);
  }
  if (name === 'read_requests') {
    const status = args.status || 'all', data=pageRows((state.requests || []).filter(row => status === 'all' || row.status === status).map(row => copy(row,['id','rewardId','name','points','status','createdAt','updatedAt'])).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),args.limit);
    const labels = {pending:'等待家长确认',approved:'已批准',cancelled:'已取消'};
    return answer('兑换申请',data.rows.length ? data.rows.map(row => row.name+'：'+row.points+' 分，'+labels[row.status]).join('\n')+moreText(data) : '没有符合条件的兑换申请。',{type:'requests',status,limit:data.limit},data);
  }
  if (name === 'read_tasks') {
    const date = args.date || today; M.dateKey(date,ZONE);
    const data={date,...pageRows(state.tasks.filter(row => row.date === date && !row.deleted && (args.includeDone || !row.done)).map(row => copy(row,['id','title','date','time','type','done'])).sort((a,b) => a.time.localeCompare(b.time)),args.limit)};
    return answer('提醒',data.rows.length ? date+'：\n'+data.rows.map(row => (row.time || '全天')+' '+row.title+(row.done?'（已完成）':'')).join('\n')+moreText(data) : date+' 没有符合条件的提醒。',{type:'tasks',date,includeDone:!!args.includeDone,limit:data.limit},data);
  }
  if (name === 'read_family_settings') {
    const reward=entity(state.rewards,state.settings.preferredReward), data={monthEndDays:state.settings.monthEndDays,preferredReward:state.settings.preferredReward,preferredRewardName:reward ? reward.name : ''};
    return answer('家庭积分设置','月末礼品在每月最后 '+data.monthEndDays+' 天可申请；'+(reward?'当前心愿礼品是“'+reward.name+'”。':'还没有设置心愿礼品。'),{type:'settings'},data);
  }
  if (name === 'read_guidance') {
    if (args.topic==='week') {
      const summary=read('read_week_summary',copy(args,['period']),state,now);
      return answer('已记录的情况',summary.answer,{type:'guidance',topic:'week',period:summary.query.period},summary.data);
    }
    const rows=args.behavior?namedMatches(state.pointItems.filter(row=>row.enabled),args.behavior,'name'):state.pointItems.filter(row=>row.enabled);
    const data=pageRows(rows.map(row=>copy(row,['id','name','points'])),args.limit || 6), facts=data.rows.length?data.rows.map(row=>row.name+'：已有规则每次 '+row.points+' 分').join('\n'):'当前没有匹配的常用行为规则。';
    return answer('已有常用行为分值',facts+moreText(data),{type:'guidance',topic:'points',...(args.behavior?{behavior:args.behavior}:{}),limit:data.limit},{...data,truncated:data.hasMore});
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
function noRedemption(text) { return /只查|只看|不兑|别兑|不要兑|先不兑|不申请|别申请|不要申请|不扣|别扣/.test(text); }
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
function normalizeAction(action,state,now) {
  if (!plain(action) || Object.keys(action).some(key => !['type','payload'].includes(key)) || !plain(action.payload) || !actionPayloadValid(action.type,action.payload)) return clarify('候选操作的字段不符合要求，请重新描述或使用对应表单。');
  const type = action.type, p = JSON.parse(JSON.stringify(action.payload));
  const references = [];
  if (p.itemId) references.push([state.pointItems,p.itemId]);
  if (p.item && p.item.id) references.push([state.pointItems,p.item.id]);
  if (p.rewardId) references.push([state.rewards,p.rewardId]);
  if (p.reward && p.reward.id) references.push([state.rewards,p.reward.id]);
  if (p.taskId || p.task && p.task.id) references.push([state.tasks,p.taskId || p.task.id]);
  if (p.requestId) references.push([state.requests || [],p.requestId]);
  if (p.settings && p.settings.preferredReward) references.push([state.rewards,p.settings.preferredReward]);
  if (references.some(([list,id]) => { const row=entity(list,id); return !row || row.deleted; })) return clarify('目标已不存在，请从当前家庭重新选择。');
  if (type === 'redemption.approve' || type === 'reward.redeem') {
    const request = type==='redemption.approve' && entity(state.requests || [],p.requestId), reward = entity(state.rewards,request ? request.rewardId : p.rewardId);
    if (!reward || p.expectedPoints !== reward.points) return clarify('礼品价格或申请已变化，请按最新记录重新确认。');
  }
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
function executeTool(name,args,state,now) {
  if (!validateCall(name,args)) return clarify('工具名称或字段不符合要求，请重新描述。');
  if (name==='respond_conversation') return conversationReply(args.message);
  if (name==='cancel_draft') return {kind:'answer',title:'草稿已取消',answer:'当前待确认草稿已取消，历史记录保留，账本没有变化。',cancelDraft:true};
  if (name.startsWith('read_')) {
    const readArgs={...args}; delete readArgs.after;
    let result;
    try { result=read(name,readArgs,state,now); }
    catch (error) { return clarify(error.message); }
    if (!args.after || result.kind!=='answer') return result;
    return {kind:'answer',title:'确认后再核对',answer:'先确认前面的候选，完成后会按最新记录重新核对。',query:result.query,deferred:true,after:args.after.slice()};
  }
  if (name==='open_view') return route(args.route);
  if (name==='ask_clarification') {
    return args.question.trim()?clarify(args.question):clarify('请补充要处理的事项或明确目标。');
  }
  const mappings={draft_award:['points.add',args],draft_rule:['pointItem.save',{item:args}],draft_reward:['reward.save',{reward:args}],draft_reminder:['task.save',{task:args}],draft_settings:['settings.update',{settings:args}],draft_redemption_request:['redemption.request',args],draft_redemption_cancel:['redemption.cancel',args],draft_rule_delete:['pointItem.delete',args]};
  if (mappings[name]) { const [type,payload]=mappings[name]; return normalizeAction({type,payload},state,now); }
  if (name==='draft_redemption_approval' || name==='draft_direct_redemption') {
    const request = name==='draft_redemption_approval' && entity(state.requests || [],args.requestId), reward=entity(state.rewards,request ? request.rewardId : args.rewardId);
    if (!reward) return clarify('没有找到对应礼品或申请，请重新选择。');
    return normalizeAction({type:request?'redemption.approve':'reward.redeem',payload:{...args,expectedPoints:reward.points}},state,now);
  }
  const row=entity(state.tasks,args.taskId);
  if (!row || row.deleted) return clarify('这条提醒已不存在，请重新选择。');
  if ((args.operation==='done' && row.done) || (args.operation==='undo' && !row.done)) return answer('提醒状态',row.title+(row.done?'已经完成。':'已经是未完成状态。'),{type:'tasks',date:row.date,includeDone:true},{rows:[copy(row,['id','title','date','time','done'])]});
  const type={done:'task.toggle',undo:'task.toggle',ack:'task.ack',snooze:'task.snooze'}[args.operation];
  return normalizeAction({type,payload:{taskId:args.taskId,...(type==='task.snooze'?{minutes:10}:{})}},state,now);
}
module.exports={ZONE,ROUTES,plain,copy,clarify,route,read,toolDefinitions,validateCall,executeTool,normalizeAction,queryResult,joinSteps,deferFollowups,resolveFollowup,fitResult,isDraftCancellation,conversationTopic,conversationReply,periodFromText,readQueryFromText,sameDraftCorrection,activeDraft,namedMatches,numericValues,noRedemption};
