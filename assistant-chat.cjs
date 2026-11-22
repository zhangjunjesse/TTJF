'use strict';

const fs = require('node:fs');
const path = require('node:path');
const A = require('./assistant.js');
const M = require('./model.js');
const T = require('./assistant-tools.cjs');
const SYSTEM = fs.readFileSync(path.join(__dirname,'config','assistant','system.md'),'utf8').trim();
const SCOPES = ['general','points','pointItems','pointItemCreate'];
const clean = value => typeof value === 'string' ? value.trim() : '';
function contextOf(options) {
  if (options.context === undefined) return {view:'home',form:''};
  if (typeof options.context === 'string') return SCOPES.includes(options.context) ? {scope:options.context,view:'home',form:''} : null;
  if (!T.plain(options.context)) return null;
  const context = T.copy(options.context,['view','form','targetId']);
  if (Object.keys(context).some(key => typeof context[key]!=='string' || context[key].length>200)) return null;
  if (context.targetId && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(context.targetId)) return null;
  // Form/view names are presentation hints, not authority to choose any entity.
  for (const key of ['view','form']) if (context[key] && !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(context[key])) return null;
  return context;
}
function preflight(text) {
  if (/(?:改|修改|更换|重置)(?:邮箱|密码)|(?:账号|账户|登录)密码|密码.*(?:修改|更换|重置)|注销(?:账号|账户)|登录|注册|手机号/.test(text)) return T.route('family');
  if (/密码|验证码|验证题|核验题|口令|解锁|绕过|忽略.*验证|\bpin\b|授权令牌|会话凭据/i.test(text)) return T.route('parent');
  if (/邀请(?:码|家人|成员)|家庭成员|创建家庭|删除家庭|退出家庭|切换家庭|转让(?:家庭|所有者)|我是家长|管理员权限/.test(text)) return T.route('family');
  if (/农场|作物/.test(text)) return T.route('farm');
  if (/喂(?:龙|伙伴)|照料|浇水|伙伴.*(?:改名|装扮|买|购买)|宠物|换伙伴|更换伙伴/.test(text)) return T.route('partner');
  if (/孩子.*(?:改名|头像)|(?:修改|更换)(?:头像|孩子名字)/.test(text)) return T.route('profile');
  return null;
}
function modelContext(state,now,context,text) {
  const parts=M.calendarParts(now,T.ZONE), limit=6, truncated={}, ambiguous={};
  function project(rows,keys,field,kind) {
    const matches=T.namedMatches(rows,text,field), selected=rows.find(row=>row.id===context.targetId);
    const chosen=selected?[selected,...matches.filter(row=>row.id!==selected.id)]:matches;
    truncated[kind]=chosen.length>limit; ambiguous[kind]=matches.length>1;
    return chosen.slice(0,limit).map(row=>T.copy(row,keys));
  }
  return {familyDay:parts.date,localTime:parts.time,view:context.view || '',form:context.form || '',targetId:context.targetId || '',
    pointItems:project(state.pointItems,['id','name','points','enabled'],'name','pointItems'),rewards:project(state.rewards,['id','name','points','category','enabled'],'name','rewards'),
    tasks:project(state.tasks.filter(row=>!row.deleted),['id','title','date','time','type','done'],'title','tasks'),
    requests:project((state.requests || []).filter(row=>row.status==='pending'),['id','rewardId','name','points','status'],'name','requests'),
    disclosure:{candidateLimit:limit,truncated,ambiguous,note:'仅列本轮明确匹配或选定的对象；其余内容由本地 read 工具查询。'}};
}
function historyForModel(messages) {
  if (!Array.isArray(messages)) return [];
  const filtered=[];
  for (const row of messages.slice(0,64)) {
    if (!T.plain(row) || !['user','assistant'].includes(row.role)) continue;
    let text=clean(row.text || row.content);
    if (!text || preflight(text)) continue;
    // Do not replay historical business answers, model instructions, or results
    // as authoritative context. The current state and draft are sent separately.
    if (row.role==='assistant') continue;
    filtered.push(text);
  }
  // The store already picked a few relevant older quotations. Filter first,
  // then share the budget so a long recent exchange cannot erase those facts.
  const selected=filtered.length>24?[...filtered.slice(0,4),...filtered.slice(-20)]:filtered;
  const perMessage=Math.min(1200,Math.floor(12000/Math.max(1,selected.length)));
  return selected.map(text=>({role:'user',text:text.slice(0,perMessage)}));
}
function draftState(draft,status) {
  if (!T.plain(status) || !Array.isArray(status.actions)) return {draft,status:null,committed:false};
  const actions=status.actions.slice(0,6).filter(row=>T.plain(row) && Number.isSafeInteger(row.index) && row.index>=0 && row.index<6 && ['pending','committed'].includes(row.status)).map(row=>T.copy(row,['index','type','status']));
  const summary={actions,...(Number.isSafeInteger(status.sourceRevision)?{sourceRevision:status.sourceRevision}:{}),...(typeof status.familyDay==='string' && /^\d{4}-\d{2}-\d{2}$/.test(status.familyDay)?{familyDay:status.familyDay}:{})};
  const committed=new Set(actions.filter(row=>row.status==='committed').map(row=>row.index));
  if (!T.plain(draft)) return {draft:null,status:summary,committed:committed.size>0};
  if (draft.kind!=='steps') return {draft:committed.has(0)?null:draft,status:summary,committed:committed.size>0};
  const steps=Array.isArray(draft.steps)?draft.steps.filter((row,index)=>!committed.has(index)):[];
  return {draft:steps.length?T.joinSteps(steps):null,status:summary,committed:committed.size>0};
}
function safeDraft(draft,state,now) {
  if (!T.plain(draft)) return null;
  const result=T.normalizeResult(draft,state,now);
  function keep(row) {
    if (row.kind==='action') return {kind:row.kind,action:row.action};
    if (row.kind==='form') return {kind:row.kind,form:row.form,fields:row.fields};
    if (row.kind==='steps') return {kind:row.kind,steps:row.steps.map(keep).filter(Boolean)};
    return null;
  }
  return keep(result);
}
function recentText(options) {
  return (Array.isArray(options.messages)?options.messages:[]).filter(row=>row && row.role==='user' && typeof (row.text || row.content)==='string').slice(-1).map(row=>row.text || row.content).join('\n');
}
function legacyNow(now) { const parts=M.calendarParts(now,T.ZONE); return new Date(parts.date+'T'+parts.time+':00'); }
function applyCorrection(text,state,now,options) {
  const draft=T.activeDraft(options);
  if (!draft || !T.sameDraftCorrection(text,draft)) return null;
  const scores=T.numericValues(text), p=draft.fields || draft.action && draft.action.payload;
  if (!p) return null;
  const type=draft.kind==='form'?'pointItem.save':draft.action.type, source=p.item || p.reward || p.task || p;
  if (type==='points.add' || type==='pointItem.save') {
    const fields={...source}; delete fields.itemId; delete fields.at;
    const toRule=/不是(?:这次|今天)|以后|每次|每天|(?:改成|改为|是|要)(?:常用|规则)|只(?:设置|建|存).*规则/.test(text) && !/不是规则|不要规则|只(?:加|记)这次|只(?:加|记)一次/.test(text);
    const toAward=/不是(?:规则|以后|每天|每次)|不要规则|(?:只|就)(?:加|记|给)?(?:这次|今天|一次)|这次(?:实际)?(?:加|给|记)|一次性/.test(text);
    if (scores.length===1) fields.points=scores[0];
    if (scores.length>1) return T.clarify('听到了多个分值，这个候选最后使用多少分？');
    const rename=/(?:行为名称|名称|名字|改名)(?:改为|改成|是|为|叫)?\s*[:：]?\s*([^，,。；;]+)/.exec(text);
    if (rename) fields.name=rename[1].trim();
    if (!fields.name && !scores.length && /每天|每次|阅读|读书|整理/.test(text)) fields.name=text.replace(/^(?:行为|名称)[:：]?/,'').trim();
    if (/停用|禁用/.test(text)) fields.enabled=false;
    else if (/启用/.test(text)) fields.enabled=true;
    if (toRule || type==='pointItem.save' && !toAward) return T.normalizeAction({type:'pointItem.save',payload:{item:fields}},state,now,{...options,text,enforceIntent:true});
    delete fields.id; delete fields.enabled;
    // A template preset is not proof that its reason happened this time.
    if (type==='pointItem.save') delete fields.reason;
    return T.normalizeAction({type:'points.add',payload:fields},state,now,{...options,text,enforceIntent:true});
  }
  if (type==='reward.save' && scores.length===1) return T.normalizeAction({type,payload:{reward:{...source,points:scores[0]}}},state,now,{...options,text,enforceIntent:true});
  if (type==='task.save') {
    const normalized=A.interpret(text,state,legacyNow(now));
    if (normalized.kind==='action' && normalized.action.type==='task.save') return T.normalizeAction({type,payload:{task:{...source,...normalized.action.payload.task}}},state,now,{...options,text,enforceIntent:true});
    // Reuse the existing time/date parser on a synthetic instruction, never by
    // applying the draft to state or inventing a durable task id.
    if (/\d[:：]\d|点|时|明天|后天|今天|全天/.test(text)) {
      const phrase=(/今天|明天|后天|\d{4}-\d|\d月|周[一二三四五六日天]/.test(text)?'':source.date+' ')+text.replace(/^(?:不对|不是|改成|改为|改到|调整为|那)/,'')+'提醒'+source.title;
      const parsed=A.interpret(phrase,state,legacyNow(now));
      if (parsed.kind==='action' && parsed.action.type==='task.save') return T.normalizeAction({type,payload:{task:{...source,...parsed.action.payload.task}}},state,now,{...options,text,enforceIntent:true});
    }
  }
  return null;
}
function localSingle(text,state,now,options={}) {
  const fixed=preflight(text); if (fixed) return fixed;
  const query=T.readQueryFromText(text,state); if (query) return T.queryResult(query,state,now,{...options,text});
  const correction=applyCorrection(text,state,now,options); if (correction) return correction;
  if (/^(?:你好|您好|嗨|hello|hi|谢谢)[！!。\s]*$/i.test(text) || /能帮.*什么|怎么用|有哪些功能/.test(text)) return {kind:'answer',title:'家长助手',answer:'可以帮你查积分和七日小结、整理本次加分、设置常用行为、核对礼品资格和提醒。候选由你确认后再保存。'};
  if (/该(?:给|加|奖)|(?:给|加)几分|(?:给|加).*多少分.*(?:合适|好)|分值.*(?:建议|合适)/.test(text)) return T.executeTool('read_guidance',{topic:'points',behavior:text.slice(0,120)},state,now);
  if (/偷懒|懒惰|不努力|这周.*(?:评价|建议|分析)|(?:这周|最近).*(?:表现如何|表现怎么样|是否努力|是不是认真)/.test(text)) return T.executeTool('read_guidance',{topic:'week'},state,now,{...options,text});
  if (/七日|7日|七天|7天|最近一周|本周.*(?:小结|总结)|一周.*(?:小结|总结)/.test(text) && !/规则|每次|提醒/.test(text)) return T.executeTool('read_week_summary',{},state,now,{...options,text});
  if (/流水|积分记录|加分记录|消费记录|收支|积分历史/.test(text) && !/添加|新增|修改|删除/.test(text)) return T.executeTool('read_ledger',{},state,now);
  if (/查看.*(?:家庭设置|积分设置)|(?:心愿礼品|月末天数|月底天数).*(?:多少|什么|几天)|月末.*(?:最后几天|多少天)/.test(text)) return T.executeTool('read_family_settings',{},state,now);
  if (/申请.*(?:状态|有哪些|记录)|(?:查看|看看|哪些|待审批|待确认).*(?:申请|审批)|^(?:申请|审批)记录/.test(text)) return T.executeTool('read_requests',{},state,now);
  if (/(?:查看|看看|有哪些|什么|列出).*(?:规则|常用行为|常用项|模板)|(?:规则|常用行为|常用项|模板).*(?:有哪些|是什么)/.test(text)) return T.executeTool('read_rules',{includeDisabled:/停用|全部/.test(text)},state,now);
  const rewardMatches=T.namedMatches(state.rewards,text,'name');
  if (/只查|只看|不兑|不要兑|别兑|不申请|先不兑|还差|差多少|够不够|够.*换|能(?:不能)?(?:兑|换)|可兑换|换什么|礼品.*(?:条件|资格|价格|多少)|(?:查看|看看).*礼品/.test(text) && /兑|换|礼品|汉堡|铅笔|橡皮|还差|差多少/.test(text)) {
    if (rewardMatches.length>1) return T.clarify('有多个符合描述的礼品，请说完整名称。');
    const selected=options.context && state.rewards.find(row=>row.id===options.context.targetId);
    return T.executeTool('read_rewards',rewardMatches.length===1?{rewardId:rewardMatches[0].id}:selected?{rewardId:selected.id}:{onlyEligible:/能换什么|可以换什么/.test(text)},state,now);
  }
  if (/现在够了吗|现在够不够|那够了吗|现在能换了吗/.test(text)) {
    const prior=T.namedMatches(state.rewards,recentText(options),'name');
    return T.executeTool('read_rewards',prior.length===1?{rewardId:prior[0].id}:{},state,now);
  }
  if (/余额|多少(?:个)?积分|还有多少分|剩(?:余|下)多少分|查积分|累计.*分|已(?:消费|兑换).*分/.test(text) && !/新增|添加|改为|改成/.test(text)) return T.executeTool('read_balance',{},state,now);
  if (/批准|审批|同意.*(?:兑换|申请)|确认(?:兑换|申请)/.test(text)) {
    const pending=(state.requests || []).filter(row=>row.status==='pending'), matches=T.namedMatches(pending,text,'name');
    const row=matches.length===1?matches[0]:pending.length===1 && !rewardMatches.length?pending[0]:null;
    return row?T.executeTool('draft_redemption_approval',{requestId:row.id},state,now,{...options,text,enforceIntent:true,targetId:row.id}):T.clarify('要批准哪条待确认申请？请从申请列表选择。');
  }
  if (/取消.*(?:申请|兑换)|撤回.*申请/.test(text)) {
    const pending=(state.requests || []).filter(row=>row.status==='pending'), matches=T.namedMatches(pending,text,'name'), row=matches.length===1?matches[0]:pending.length===1?pending[0]:null;
    return row?T.executeTool('draft_redemption_cancel',{requestId:row.id},state,now,{...options,text,enforceIntent:true,targetId:row.id}):T.clarify('要取消哪条兑换申请？请从申请列表选择。');
  }
  if (/完成|恢复.*未完成|知道了|稍后|晚点|十分钟后|10分钟后/.test(text) && !/加.*分|给.*分|规则|常用|每次/.test(text)) {
    const matches=T.namedMatches(state.tasks.filter(row=>!row.deleted),text,'title');
    if (matches.length===1) return T.executeTool('draft_reminder_status',{taskId:matches[0].id,operation:/恢复/.test(text)?'undo':/知道了/.test(text)?'ack':/稍后|晚点|分钟后/.test(text)?'snooze':'done'},state,now,{...options,text,enforceIntent:true});
    if (/提醒|事项/.test(text)) return T.clarify('要处理哪条提醒？请说完整名称或从列表选择。');
  }
  if (/删除.*(?:规则|常用)|(?:规则|常用).*删除/.test(text)) {
    const matches=T.namedMatches(state.pointItems,text,'name');
    return matches.length===1?T.executeTool('draft_rule_delete',{itemId:matches[0].id},state,now,{...options,text,enforceIntent:true}):T.clarify('要删除哪个常用行为？请说完整名称。');
  }
  const recurring=/以后|每天|每日|每次|规则|常用行为|常用项|常用加分|模板/.test(text) && !/不是规则|不要规则|只(?:加|记)这次|只(?:加|记)一次/.test(text);
  if (recurring && !/今天.*(?:加|给)|这次.*(?:加|给)/.test(text)) {
    const selected=options.context && options.context.targetId;
    let result;
    if (/把|修改|调整|停用|启用|改名|改为|改成/.test(text) && !/新建|新增|添加/.test(text)) result=A.interpret(text.replace(/规则|常用行为/g,'常用项'),state,legacyNow(now),{context:'pointItems',...(selected?{targetId:selected}:{})});
    else result=A.interpret(text.replace(/^(?:设置|建立|设一个|定一个)(?:规则)?[:：]?/,'新增常用行为：'),state,legacyNow(now),{context:'pointItemCreate'});
    return result.kind==='action' || result.kind==='form'?T.normalizeResult(result,state,now,{...options,text,enforceIntent:true}):result;
  }
  const context=options.context || {}, scope=context.scope || (context.form==='points'?'points':context.form==='pointItem' && context.targetId?'pointItems':'general');
  const selected=state.tasks.find(row=>row.id===context.targetId && !row.deleted), phrase=selected && /^(?:改|调整|推迟)/.test(text)?'把'+selected.title+text:text;
  const result=A.interpret(phrase,state,legacyNow(now),{context:scope,...(context.targetId?{targetId:context.targetId}:{})});
  if (result.kind==='action') {
    if (result.action.type==='points.add') {
      const payload=result.action.payload;
      if (!/(?:原因|理由)(?:是|为|[:：])|因为/.test(text)) delete payload.reason;
      const described=text.replace(/(?:[，,]\s*)?(?:原因|理由)(?:是|为|[:：]).*$/,'').replace(/(?:加|给|奖励|记)(?:上|积分)?(?:孩子|他|她)?\s*[零〇一二两三四五六七八九十百\d]+\s*(?:积分|分(?!钟))/g,'').replace(/[零〇一二两三四五六七八九十百\d]+\s*(?:积分|分(?!钟))/g,'').replace(/^(?:请)?(?:帮我)?(?:给)?(?:孩子|他|她)?\s*(?:今天|这次|刚才|行为[:：]|名称[:：])*/,'').replace(/^[，,。:：\s]+|[，,。:：\s]+$/g,'');
      if (described && described.length<=120) payload.name=described;
    }
    return T.normalizeResult(result,state,now,{...options,text,enforceIntent:true});
  }
  if (result.kind==='answer') {
    if (/提醒|事项|安排/.test(text)) {
      const day=/后天/.test(text)?M.addDays(M.dateKey(now,T.ZONE),2,T.ZONE):/明天/.test(text)?M.addDays(M.dateKey(now,T.ZONE),1,T.ZONE):M.dateKey(now,T.ZONE);
      return T.executeTool('read_tasks',{date:day},state,now);
    }
    return T.executeTool('read_balance',{},state,now);
  }
  return {kind:'clarify',question:result.question && !/当前是本地指令演示/.test(result.question)?result.question:'可以帮你查积分、设置常用行为、整理本次加分、核对礼品或提醒。请说具体想做什么。'};
}
function localChat(text,state,now,options={}) {
  const sequenced=text.replace(/[，,]?\s*(?:加完(?:后)?|加分后|记完(?:后)?)\s*(?=查|看|核对)/g,'；');
  const parts=sequenced.split(/(?:然后|另外|顺便|同时|并且|[；;]|[，,]\s*再)/).map(clean).filter(Boolean);
  if (parts.length>6) return T.clarify('一次最多整理六项，请把复杂任务分开描述。');
  return T.deferFollowups(T.joinSteps(parts.map(part=>localSingle((T.noRedemption(text) && /兑|换/.test(part) && !T.noRedemption(part)?'只查不兑，':'')+part,state,now,{...options,text:part}))),text);
}
function tagged(result,source,label) {
  const stamp={mode:source==='model'?'connected':'local',source,label:label || (source==='model'?'AI 已整理':'本地助手')};
  if (result.kind==='steps') result={...result,steps:result.steps.map(row=>({...row,...stamp}))};
  return {...result,...stamp};
}
function reusesUnrelatedDraft(result,text,options) {
  const draft=T.activeDraft(options);
  if (!draft || T.sameDraftCorrection(text,draft)) return false;
  const prior=draft.fields || draft.action && draft.action.payload, old=prior && (prior.item || prior);
  if (!old || !old.name) return false;
  const core=old.name.replace(/^(?:(?:今天|这次|以后|每天|每日|自主|独立|自己|主动))+/,'').replace(/读书/g,'阅读');
  if (core && text.replace(/读书/g,'阅读').includes(core)) return false;
  const steps=result.kind==='steps'?result.steps:[result];
  return steps.some(row=>row.kind==='action' && ['points.add','pointItem.save'].includes(row.action.type) && (row.action.payload.item || row.action.payload).name===old.name);
}
function createChat({apiKey,endpoint,model,fetchImpl,timeoutMs,readBounded,enabled,formOnly,interpret}) {
  function status() { return {enabled:!!enabled,mode:apiKey && enabled?'connected':'local',label:apiKey && enabled?'AI 家长助手':'本地助手',formOnly:!!apiKey && formOnly && !enabled}; }
  async function chat(text,state,suppliedNow,inputOptions={}) {
    if (typeof text!=='string' || !text.trim() || text.length>1200) return tagged(T.clarify('请输入 1–1200 字，说明想查什么或整理什么。'),'local');
    const now=suppliedNow===undefined?new Date():new Date(suppliedNow), context=T.plain(inputOptions)?contextOf(inputOptions):null;
    if (!context || !Number.isFinite(+now)) return tagged(T.clarify('请从当前家庭重新打开助手后再试。'),'local');
    const prior=draftState(inputOptions.draft,inputOptions.draftStatus);
    const options={...inputOptions,context,text:text.trim(),draft:prior.draft,draftStatus:prior.status}, fixed=preflight(text);
    if (fixed) return tagged(fixed,'local');
    if (T.isDraftCancellation(text)) return tagged({kind:'answer',answer:'当前待确认草稿已取消，历史记录保留，账本没有变化。',cancelDraft:true},'local');
    if (prior.committed && !T.activeDraft(options) && /^(?:改成|改为|改到|调整为|不对|不是|应该|分值改)/.test(text.trim())) return tagged(T.clarify('此前候选已办理，不能把它改成另一笔。查看或更正记录请打开对应界面；新增一笔请明确说明。'),'local');
    const currentQuery=T.readQueryFromText(text,state);
    if (!apiKey || !enabled) {
      if (apiKey && formOnly && context.form==='pointItem' && !context.targetId && !T.activeDraft(options) && !currentQuery && !/查|余额|记录|小结|有哪些|什么|改为|改成|停用|启用/.test(text)) {
        const result=await interpret(text,state,now,{context:'pointItemCreate'});
        return {...result,source:result.mode==='connected'?'model':'local'};
      }
      try { return T.fitResult(tagged(localChat(text,state,now,options),'local'),state,now); }
      catch (_) { return tagged(T.clarify('请核对日期、时间和目标，或打开对应表单补充。'),'local'); }
    }
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const body={model,temperature:0,max_tokens:1600,tools:T.toolDefinitions(),tool_choice:'auto',messages:[
        {role:'system',content:SYSTEM},{role:'user',content:JSON.stringify({context:modelContext(state,now,context,text),messages:historyForModel(options.messages),draft:safeDraft(options.draft,state,now),draftStatus:options.draftStatus,instruction:text.trim()})}]};
      const response=await fetchImpl(endpoint,{method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json','Authorization':'Bearer '+apiKey},body:JSON.stringify(body)});
      if (!response.ok) throw new Error('PROVIDER_FAILED');
      const envelope=JSON.parse(await readBounded(response)), message=envelope && envelope.choices && envelope.choices[0] && envelope.choices[0].message;
      if (!message || !T.plain(message)) throw new Error('INVALID_MODEL_OUTPUT');
      let result;
      if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
        if (message.tool_calls.length>6) throw new Error('TOO_MANY_TOOLS');
        const steps=message.tool_calls.map(call=>{
          if (!T.plain(call) || call.type!=='function' || !T.plain(call.function) || typeof call.function.arguments!=='string' || call.function.arguments.length>10000) throw new Error('INVALID_TOOL_CALL');
          const args=JSON.parse(call.function.arguments);
          if (!T.validateCall(call.function.name,args)) throw new Error('INVALID_TOOL_ARGUMENTS');
          return T.executeTool(call.function.name,args,state,now,{...options,enforceIntent:true});
        });
        result=T.joinSteps(steps);
      } else {
        if (typeof message.content!=='string' || message.content.length>18000) throw new Error('INVALID_MODEL_OUTPUT');
        const candidate=JSON.parse(message.content.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
        result=T.normalizeResult(candidate,state,now,{...options,enforceIntent:true});
      }
      if (!currentQuery && reusesUnrelatedDraft(result,text,options)) throw new Error('STALE_DRAFT_REPLAY');
      return T.fitResult(tagged(T.deferFollowups(currentQuery?T.queryResult(currentQuery,state,now,options):result,text),'model'),state,now);
    } catch (error) {
      // A local result remains useful, and is visibly distinguished from a
      // successful model request. No provider exception or credentials escape.
      try { return T.fitResult(tagged(localChat(text,state,now,options),'fallback',error.message==='STALE_DRAFT_REPLAY'?'AI 结果未采用，已按本轮描述整理':'AI 暂不可用，已用本地规则整理'),state,now); }
      catch (_) { return tagged(T.clarify('AI 暂时无法整理，请使用对应表单或稍后重试。'),'fallback','AI 暂不可用'); }
    } finally { clearTimeout(timer); }
  }
  return {chat,status};
}
module.exports={createChat,localChat,contextOf,historyForModel};
