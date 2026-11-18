/* Natural-language drafts, never writes state. ES5 / Safari 15 compatible. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./model.js')); }
  else { root.FamilyAssistant = factory(root.FamilyModel); }
}(typeof window !== 'undefined' ? window : this, function (M) {
  'use strict';
  var DIGITS = { '零':0, '〇':0, '一':1, '二':2, '两':2, '三':3, '四':4, '五':5, '六':6, '七':7, '八':8, '九':9 };
  function trim(s) { return String(s || '').replace(/^\s+|\s+$/g, ''); }
  function num(s) {
    if (/^\d+$/.test(s)) { return Number(s); }
    var total = 0, current = 0, i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charAt(i);
      if (Object.prototype.hasOwnProperty.call(DIGITS, c)) { current = DIGITS[c]; }
      else if (c === '十') { total += (current || 1) * 10; current = 0; }
      else if (c === '百') { total += (current || 1) * 100; current = 0; }
      else { return NaN; }
    }
    return total + current;
  }
  function base(result) { result.mode = 'local'; result.label = '指令演示'; return result; }
  function clarify(q) { return base({kind:'clarify', question:q}); }
  function answer(a) { return base({kind:'answer', answer:a}); }
  function brief(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function find(list, id) { for (var i = 0; i < list.length; i++) { if (list[i].id === id) { return list[i]; } } return null; }
  function copyFields(source, names) {
    var out = {}, i;
    for (i = 0; i < names.length; i++) { if (Object.prototype.hasOwnProperty.call(source || {}, names[i])) { out[names[i]] = source[names[i]]; } }
    return out;
  }
  function plain(value) { return !!value && Object.prototype.toString.call(value) === '[object Object]'; }
  function candidates(list, phrase, field) {
    var exact = [], partial = [], i, name, reduced;
    for (i = 0; i < list.length; i++) {
      if (list[i].deleted || list[i].enabled === false) { continue; }
      name = list[i][field];
      if (phrase.indexOf(name) >= 0) { exact.push(list[i]); continue; }
      reduced = name.replace(/^(一起|主动|自己|小小|彩虹|小熊|一次|一份|一个)/, '').replace(/(一次|一份|一个)$/, '');
      if (reduced.length >= 2 && phrase.indexOf(reduced) >= 0) { partial.push(list[i]); continue; }
      if (/汉堡/.test(name) && /汉堡/.test(phrase)) { partial.push(list[i]); }
      else if (/书包/.test(name) && /书包/.test(phrase)) { partial.push(list[i]); }
      else if (/水杯/.test(name) && /水杯/.test(phrase)) { partial.push(list[i]); }
    }
    return exact.length ? exact : partial;
  }
  function clock(s) {
    var m = /(?:^|[^\d])(\d{1,2})[:：](\d{2})(?!\d)/.exec(s), h, minute;
    if (m) { h = Number(m[1]); minute = Number(m[2]); }
    else {
      m = /([零〇一二两三四五六七八九十\d]{1,3})(?:点|时)(?:([零〇一二两三四五六七八九十\d]{1,3})分?|([半]))?/.exec(s);
      if (!m) { return ''; }
      h = num(m[1]); minute = m[3] ? 30 : (m[2] ? num(m[2]) : 0);
    }
    if (/下午|晚上|傍晚|明晚|今晚/.test(s) && h < 12) { h += 12; }
    if (/凌晨|早上|上午/.test(s) && h === 12) { h = 0; }
    if (/中午/.test(s) && h < 11) { h += 12; }
    if (!isFinite(h) || !isFinite(minute) || h > 23 || minute > 59) { return null; }
    return (h < 10 ? '0' : '') + h + ':' + (minute < 10 ? '0' : '') + minute;
  }
  function day(s, now) {
    var today = M.dateKey(now), m, date = new Date(now.getTime()), target, offset;
    m = /(\d{4})[-年](\d{1,2})[-月](\d{1,2})日?/.exec(s);
    if (m) { return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2); }
    m = /(\d{1,2})月(\d{1,2})[日号]?/.exec(s);
    if (m) { return now.getFullYear() + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2); }
    if (/后天/.test(s)) { return M.addDays(today, 2); }
    if (/明天|明早|明晚/.test(s)) { return M.addDays(today, 1); }
    if (/今天|今晚|今早/.test(s)) { return today; }
    m = /(下周|本周|这周|周|星期)([一二三四五六日天])/.exec(s);
    if (m) {
      target = { '一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'日':0,'天':0 }[m[2]];
      offset = (target - date.getDay() + 7) % 7;
      if (m[1] === '下周') { offset = ((target || 7) - (date.getDay() || 7)) + 7; }
      return M.addDays(today, offset);
    }
    if (/下个月|下月|下星期|月底|过几天|下次|昨天/.test(s)) { return null; }
    return today;
  }
  function stripTime(s) {
    return trim(s.replace(/\d{4}[-年]\d{1,2}[-月]\d{1,2}日?/g, '').replace(/\d{1,2}月\d{1,2}[日号]?/g, '')
      .replace(/(?:下周|本周|这周|周|星期)[一二三四五六日天]/g, '').replace(/后天|明天|明早|明晚|今天|今晚|今早|早上|上午|下午|中午|晚上|凌晨|傍晚/g, '')
      .replace(/\d{1,2}[:：]\d{2}/g, '').replace(/[零〇一二两三四五六七八九十\d]{1,3}(?:点|时)(?:[零〇一二两三四五六七八九十\d]{1,3}分?|半)?/g, '')
      .replace(/^[，,。\s]+|[，,。\s]+$/g, ''));
  }
  function query(q, state, now) {
    var totals = M.totals(state), reward, rows, date, i;
    if (!q || q.type === 'balance') { return answer('现在可用 ' + totals.available + ' 分，累计获得 ' + totals.earned + ' 分。'); }
    if (q.type === 'reward_gap') {
      reward = find(state.rewards, q.rewardId);
      if (!reward || !reward.enabled) { return clarify('没有找到这个可兑换礼品，请从礼品列表选择。'); }
      if (totals.available < reward.points) { return answer('兑换“' + reward.name + '”需要 ' + reward.points + ' 分，还差 ' + (reward.points - totals.available) + ' 分。'); }
      var allowed = M.availability(state, reward.id, now);
      return answer('积分已经够换“' + reward.name + '”了。' + (allowed.allowed ? '可以先提出兑换申请，再请家长确认。' : allowed.reason + '。'));
    }
    if (q.type === 'redeemable') {
      rows = [];
      for (i = 0; i < state.rewards.length; i++) { if (M.availability(state, state.rewards[i].id, now).allowed) { rows.push(state.rewards[i].name + '（' + state.rewards[i].points + '分）'); } }
      return answer(rows.length ? '现在可以申请兑换：' + rows.join('、') + '。' : '现在没有符合积分和日期条件的礼品，可以看看各个礼品的兑换条件。');
    }
    if (q.type === 'tasks') {
      date = q.date || M.dateKey(now); M.dateKey(date); rows = [];
      for (i = 0; i < state.tasks.length; i++) { if (state.tasks[i].date === date && !state.tasks[i].deleted && !state.tasks[i].done) { rows.push((state.tasks[i].time || '当天') + ' ' + state.tasks[i].title); } }
      return answer(rows.length ? date + '：' + rows.join('；') + '。' : date + ' 没有未完成的事项。');
    }
    return clarify('可以帮你查积分、看提醒，或整理一笔加分和一个礼品。');
  }
  function scopeOf(options) {
    var scope = options && options.context || 'general';
    return ['general', 'points', 'pointItems', 'pointItemCreate'].indexOf(scope) >= 0 ? scope : '';
  }
  function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function cleanPhrase(value) { return trim(value).replace(/^[\s，,。:：;；“”「」"']+|[\s，,。:：;；“”「」"']+$/g, ''); }
  function numberTokens(s) {
    var pattern = /([零〇一二两三四五六七八九十百\d]+)\s*分(?!钟)/g, found = [], match;
    while ((match = pattern.exec(s))) { found.push({value:num(match[1]),text:match[0],index:match.index}); }
    return found;
  }
  function creationPointTokens(s) {
    var pattern = /(?:积分|分值|得分)\s*(?:(?:设置为|设为|改为|是|为)\s*|[:：=]\s*)?([零〇一二两三四五六七八九十百\d]+)(?:\s*分(?!钟))?|([零〇一二两三四五六七八九十百\d]+)\s*(?:个)?(?:积分|分(?!钟))/g,
      found = [], match, value, numberAt;
    while ((match = pattern.exec(s))) {
      value = match[1] || match[2]; numberAt = match.index + match[0].lastIndexOf(value);
      if (/[.．点]/.test(s.charAt(numberAt - 1)) || /[.．点]/.test(s.charAt(numberAt + value.length)) ||
          /(?:[-－]|负)\s*$/.test(s.slice(0, numberAt)) || /^\s*分钟/.test(s.slice(numberAt + value.length))) { continue; }
      found.push({value:num(value),text:match[0],index:match.index});
    }
    return found;
  }
  function invalidAmount(s) {
    return /[-－]\s*[零〇一二两三四五六七八九十百\d]|负[零〇一二两三四五六七八九十百\d]|[零〇一二两三四五六七八九十百\d]+[.．点][零〇一二两三四五六七八九十百\d]+\s*分/.test(s);
  }
  function awardDraft(s, state, now, options) {
    if (invalidAmount(s) || /(?:扣|减)(?:除|去)?\s*[零〇一二两三四五六七八九十百\d]+\s*分(?!钟)/.test(s)) { return clarify('当前支持正整数加分；请核对分值，不会自动扣分。'); }
    var tokens = numberTokens(s), match, reason, name;
    if (tokens.length !== 1) { return clarify(tokens.length ? '听到了多个分值，这次确认加多少分？' : '这次加多少分？请填写行为名称和分值，例如“行为：阅读，加 5 分”。'); }
    match = new RegExp('(?:加|给|奖励|记)(?:上|积分)?(?:他|她|孩子|' + escapeRegExp(state.childName) + ')?\\s*[零〇一二两三四五六七八九十百\\d]+\\s*分(?!钟)').exec(s);
    reason = match ? s.replace(match[0], '') : s.slice(0, tokens[0].index) + s.slice(tokens[0].index + tokens[0].text.length);
    reason = cleanPhrase(reason.replace(/^(请)?(帮我)?/, '').replace(new RegExp('^(?:给)?(?:孩子|他|她|' + escapeRegExp(state.childName) + ')[，,：: ]*(?=$|[，,：: ])'), '').replace(/^(?:因为|原因是|原因[:：])/, '').replace(/(?:，|,)?(?:谢谢|就好|就行)[。！!]?$/, ''));
    if (!reason || /^(谢谢|加分|奖励|积分|给我|给孩子|给他|给她|这次|再|帮我)$/.test(reason)) { return clarify('这次加分的行为叫什么？填写行为名称即可，原因可以不填。'); }
    match = /^(?:行为名称|行为|名称)\s*[:：]\s*(.*?)(?:[，,]\s*(?:原因|理由)\s*[:：]\s*(.*))?$/.exec(reason);
    if (match) { name = cleanPhrase(match[1]); reason = cleanPhrase(match[2] || ''); }
    else if (state.pointItems.some(function (item) { return item.name === reason; })) { name = reason; reason = ''; }
    else { name = /书包/.test(reason) ? '主动整理书包' : (/阅读|读书/.test(reason) ? '自主阅读' : (/收拾|整理/.test(reason) ? '主动整理' : brief(reason, 32))); }
    if (!name) { return clarify('请填写这次加分的行为名称，原因可以不填。'); }
    return normalize({kind:'action',action:{type:'points.add',payload:{name:name,points:tokens[0].value,reason:reason}}}, state, now, options);
  }
  function templateCandidates(state, s) {
    var rows = state.pointItems.map(function (p) { return {id:p.id,name:p.name}; });
    return candidates(rows, s, 'name');
  }
  function templateDraft(s, state, now, options) {
    var createForm = scopeOf(options) === 'pointItemCreate',
      create = createForm || /^(?:请)?(?:帮我)?(?:新增|新建|添加|加一个|加个|创建|增加)/.test(s), target = options && options.targetId,
      prefix = s.split(/改名|更名|改成|改为|改到|调整为|设为|设置为/)[0], found = templateCandidates(state, prefix), row,
      item = {}, tokens, nextName, reasonMatch, reasonPart, remaining, verb;
    if (/(?:然后|另外|顺便|同时|[；;]).*(?:新增|添加|停用|启用|加|给|提醒|修改|把)/.test(s)) { return clarify('一次先管理一个常用加分项，请分开描述。'); }
    if (invalidAmount(s)) { return clarify('常用加分项的分值需要是正整数。'); }
    if (target) {
      row = find(state.pointItems, target);
      if (!row) { return clarify('这个常用项已不存在，请回列表重新选择。'); }
      if (create || found.some(function (p) { return p.id !== target; })) { return clarify('正在编辑“' + row.name + '”，请核对要修改的常用项。'); }
    } else if (!create) {
      if (found.length !== 1) { return clarify('要调整哪个常用项？请说完整名称，例如“把自主阅读改为每次 8 分”。'); }
      row = find(state.pointItems, found[0].id);
    }
    tokens = createForm ? creationPointTokens(s) : numberTokens(s);
    if (tokens.length > 1 && (createForm || !/从.+(?:改|调|设)/.test(s))) { return clarify('听到多个分值，请明确这个常用项以后每次加多少分。'); }
    if (row) { item.id = row.id; }
    if (tokens.length) { item.points = tokens[tokens.length - 1].value; }
    reasonMatch = /(?:预设原因|加分原因|具体原因|原因|理由)(?:\s*(?:修改为|改成|改为|设置为|设为|写成|是|为))?\s*[:：]?\s*(.+)$/.exec(s);
    if (reasonMatch) { item.reason = cleanPhrase(reasonMatch[1]); }
    if (/停用|禁用|暂停使用|暂时不用|先不用|不再用|不要启用|删除/.test(s)) { item.enabled = false; }
    else if (/启用|恢复使用|重新开启/.test(s)) { item.enabled = true; }
    if (create) {
      if (!tokens.length && !createForm) { return clarify('新增的常用项每次加多少分？'); }
      remaining = reasonMatch ? s.slice(0, reasonMatch.index) : s;
      remaining = remaining.replace(/^(?:请)?(?:帮我)?(?:新增|新建|添加|加|创建|增加)(?:一个|个|一项)?/, '').replace(/^(?:常用加分项|常用项|加分模板|加分项|模板|常用)\s*[:：]?\s*/, '');
      if (createForm) { remaining = remaining.replace(/^(?:常用行为|行为名称|行为)\s*[:：]?\s*/, ''); }
      if (createForm && tokens.length) { remaining = remaining.replace(tokens[0].text, ''); }
      remaining = remaining.replace(/(?:每次|一次|默认|积分|加|给|奖励|记|为|设为|设置为)?\s*[零〇一二两三四五六七八九十百\d]+\s*分(?!钟)/g, '').replace(/(?:这个|的)?(?:常用加分项|常用项|加分模板|加分项|模板)(?:目)?/, '').replace(/(?:先|暂时)?停用|启用/g, '');
      if (createForm) { remaining = remaining.replace(/(?:[，,\s]*(?:完成后|以后|每次|一次|默认|奖励|加|给|记|设为|设置为))+[，,\s]*$/, ''); }
      item.name = cleanPhrase(remaining);
      if (!item.name && !createForm) { return clarify('这个常用加分项叫什么名字？例如“主动刷牙，每次 3 分”。'); }
      if (!createForm && item.reason === undefined) { item.reason = ''; }
      if (!createForm && item.enabled === undefined) { item.enabled = true; }
    } else {
      verb = /(?:改名|更名|名称(?:改成|改为|设为|设置为)?)(?:为|成|叫)?\s*[:：]?\s*(.+?)(?:[，,；;]|$)/.exec(s);
      if (verb) { nextName = cleanPhrase(verb[1]); }
      else if (!reasonMatch && !tokens.length && /改成|改为/.test(s)) { nextName = cleanPhrase(s.split(/改成|改为/).slice(1).join('')); }
      if (nextName) { item.name = nextName; }
      if (Object.keys(item).length === 1) { return clarify('想调整名称、分值、预设原因，还是停用/启用？例如“把自主阅读改成每次 8 分”。'); }
    }
    return normalize({kind:'action',action:{type:'pointItem.save',payload:{item:item}}}, state, now, options);
  }
  function normalizePointItemCreate(candidate, state, now, options) {
    if (options && options.targetId) { return clarify('这里只新建常用行为，请从管理列表修改已有行为。'); }
    var item, fields, check, checked, missing = [], tokens;
    if (candidate.kind === 'form' && candidate.form === 'pointItem' && plain(candidate.fields)) { item = candidate.fields; }
    else if (candidate.kind === 'action' && plain(candidate.action) && candidate.action.type === 'pointItem.save' && plain(candidate.action.payload) && plain(candidate.action.payload.item)) { item = candidate.action.payload.item; }
    else { return clarify('这里只填写一个新的常用行为，不会直接加分或修改已有行为。'); }
    if (Object.prototype.hasOwnProperty.call(item, 'id')) { return clarify('这里只新建常用行为，请从管理列表修改已有行为。'); }
    fields = copyFields(item, ['name','points','reason','enabled']);
    if (typeof fields.name === 'string') { fields.name = trim(fields.name); }
    if (typeof fields.reason === 'string') { fields.reason = trim(fields.reason); }
    if (fields.reason === null) { fields.reason = ''; }
    if (fields.name === undefined || fields.name === null || fields.name === '') { delete fields.name; }
    if (fields.points === undefined || fields.points === null || fields.points === '') { delete fields.points; }
    if (fields.reason === undefined) { delete fields.reason; }
    if (fields.enabled === undefined) { delete fields.enabled; }
    // Check every supplied field with the real domain rules. Temporary required
    // values exist only for validation; missing values never enter the form.
    check = copyFields(fields, ['name','points','reason','enabled']);
    if (check.name === undefined) { check.name = '待填写行为'; }
    if (check.points === undefined) { check.points = 1; }
    checked = normalize({kind:'action',action:{type:'pointItem.save',payload:{item:check}}}, state, now, {context:'pointItems'});
    if (checked.kind !== 'action') { return checked; }
    if (fields.points !== undefined && options && typeof options.sourceText === 'string') {
      tokens = creationPointTokens(options.sourceText);
      if (tokens.length !== 1 || tokens[0].value !== fields.points) { delete fields.points; }
    }
    if (fields.name === undefined) { missing.push('name'); }
    if (fields.points === undefined) { missing.push('points'); }
    if (missing.length) {
      return base({kind:'form',form:'pointItem',fields:fields,missing:missing,
        question:missing.length === 2 ? '请补充行为名称和每次的分值。' : (missing[0] === 'name' ? '这个常用行为叫什么名字？' : '这个常用行为以后每次加多少分？')});
    }
    return base({kind:'action',action:{type:'pointItem.save',payload:{item:fields}},title:'新增常用加分项',
      summary:fields.name + ' · 每次 ' + fields.points + ' 分' + (fields.enabled === undefined ? '' : ' · ' + (fields.enabled ? '启用' : '停用，保留历史'))});
  }
  function normalize(candidate, state, now, options) {
    now = now === undefined ? new Date() : new Date(now);
    var scope = scopeOf(options);
    if (!scope) { return clarify('请从当前加分或常用项管理入口重新开始。'); }
    if (!plain(candidate)) { return clarify('没有理解清楚，请换个说法。'); }
    if (candidate.kind === 'clarify') { return clarify(brief(trim(candidate.question) || '还需要哪一项信息？', 160)); }
    if (scope === 'pointItemCreate') { return normalizePointItemCreate(candidate, state, now, options); }
    if (candidate.kind === 'answer' || candidate.kind === 'query') { return query(candidate.query || {type:'balance'}, state, now); }
    if (candidate.kind !== 'action' || !plain(candidate.action) || !plain(candidate.action.payload)) { return clarify('可以说“明天七点半提醒带水杯”，或“主动整理书包，加五分”。'); }
    var type = candidate.action.type, p = candidate.action.payload, payload, flat, row, title, summary;
    if ((scope === 'points' && type !== 'points.add') || (scope === 'pointItems' && type !== 'pointItem.save')) {
      return clarify(scope === 'points' ? '这里帮你填写一次加分。管理常用项请使用常用加分项里的 AI 入口。' : '这里管理常用加分项，不会直接给孩子加分。请描述新增、修改、停用或启用。');
    }
    if (type === 'points.add') {
      payload = copyFields(p, ['itemId','name','points','reason','at']); title = '确认加分';
      row = payload.itemId ? find(state.pointItems, payload.itemId) : null;
      if (row && payload.name === undefined) { payload.name = row.name; }
      if (row && payload.points === undefined) { payload.points = row.points; }
      if (payload.reason === undefined || payload.reason === null) { payload.reason = ''; }
      if (typeof payload.reason === 'string') { payload.reason = trim(payload.reason); }
    } else if (type === 'pointItem.save' && plain(p.item)) {
      payload = {item:copyFields(p.item, ['id','name','points','reason','enabled'])};
      if (options && options.targetId) {
        if (payload.item.id && payload.item.id !== options.targetId) { return clarify('候选目标与当前编辑项不同，请重新选择。'); }
        payload.item.id = options.targetId;
      }
      row = payload.item.id ? find(state.pointItems, payload.item.id) : null;
      if (payload.item.id && !row) { return clarify('没有找到这个常用加分项，请从管理列表重新选择。'); }
      ['name','points','reason','enabled'].forEach(function (key) {
        if (payload.item[key] === undefined && row) { payload.item[key] = row[key]; }
      });
      if (payload.item.reason === undefined) { payload.item.reason = ''; }
      if (payload.item.enabled === undefined) { payload.item.enabled = true; }
      title = row ? '调整常用加分项' : '新增常用加分项';
      summary = (payload.item.name || '请填写名称') + ' · 每次 ' + payload.item.points + ' 分 · ' + (payload.item.enabled ? '启用' : '停用，保留历史');
    } else if (type === 'task.save' && plain(p.task)) {
      payload = {task:copyFields(p.task, ['id','type','title','date','time','note','remindDays'])};
      title = p.task.id ? '修改提醒' : '添加提醒';
      row = p.task.id ? find(state.tasks, p.task.id) : null;
      if (p.task.id && !row) { return clarify('要修改哪条提醒？请从列表选择。'); }
      summary = (p.task.date || (row && row.date) || '') + ' ' + (p.task.time === undefined ? ((row && row.time) || '') : p.task.time) + ' · ' + (p.task.title || (row && row.title) || '');
    } else if (type === 'reward.save' && plain(p.reward)) {
      payload = {reward:copyFields(p.reward, ['id','name','points','category','icon','enabled'])};
      title = p.reward.id ? '修改礼品' : '添加礼品';
      if (p.reward.id && !find(state.rewards, p.reward.id)) { return clarify('没有找到要修改的礼品，请从列表选择。'); }
      summary = (p.reward.name || '') + ' · ' + p.reward.points + ' 分 · ' + ({daily:'日常可兑',weekend:'周末可兑',outing:'月底可兑'}[p.reward.category || 'daily']);
    } else if (type === 'redemption.request') {
      payload = copyFields(p, ['rewardId']); row = find(state.rewards, payload.rewardId);
      if (!row) { return clarify('想兑换哪个礼品？请说礼品名称。'); }
      title = '申请兑换'; summary = row.name + ' · ' + row.points + ' 分，等待家长确认';
    } else if (type === 'task.toggle' || type === 'task.ack' || type === 'task.snooze') {
      payload = copyFields(p, ['taskId']); row = find(state.tasks, payload.taskId);
      if (!row || row.deleted) { return clarify('要处理哪条提醒？请从列表选择。'); }
      if (type === 'task.snooze') { payload.minutes = 10; }
      title = type === 'task.toggle' ? (row.done ? '恢复为未完成' : '完成提醒') : (type === 'task.ack' ? '知道了' : '10 分钟后提醒');
      summary = title + ' · ' + row.title;
    } else { return clarify('这项操作请使用页面上的对应按钮；家长验证不能由 AI 代替。'); }
    flat = {id:'ai-check-' + now.getTime(), type:type};
    while (state.appliedActions && state.appliedActions.indexOf(flat.id) >= 0) { flat.id += '-next'; }
    Object.keys(payload).forEach(function (key) { flat[key] = payload[key]; });
    try { M.apply(state, flat, now); }
    catch (error) { return clarify(error.message); }
    if (type === 'points.add') { summary = '+' + payload.points + ' 分 · ' + payload.name + (payload.reason ? ' · ' + payload.reason : ''); }
    return base({kind:'action', action:{type:type,payload:payload}, title:title, summary:summary});
  }
  function interpret(input, state, suppliedNow, options) {
    var s = trim(input), now = suppliedNow === undefined ? new Date() : new Date(suppliedNow), scope = scopeOf(options);
    if (!scope) { return clarify('请从当前加分或常用项管理入口重新开始。'); }
    if (!s || s.length > 1200 || /密码|验证码|验证题|核验题|解锁|忽略.*验证|绕过/.test(s)) { return generalInterpret(input, state, now); }
    if (scope === 'pointItemCreate') {
      if (options && options.targetId) { return clarify('这里只新建常用行为，请从管理列表修改已有行为。'); }
      if (/改名|更名|停用|禁用|删除|把.+(?:改成|改为|调整)/.test(s)) { return clarify('这里只新建常用行为，请从管理列表修改已有行为。'); }
      return templateDraft(s, state, now, {context:scope,sourceText:s});
    }
    if (scope === 'pointItems') { return templateDraft(s, state, now, options); }
    if (scope === 'points') {
      if (/常用|模板|停用|启用|改名|改为每次|改成每次/.test(s)) { return clarify('这看起来是在管理常用项，请使用常用加分项里的 AI 入口。'); }
      if (/(?:然后|另外|顺便|同时|[；;]).*(?:提醒|加分|给.*分|礼品)/.test(s)) { return clarify('一次先记录一件事，请描述这次加分的行为名称和分值。'); }
      return awardDraft(s, state, now, options);
    }
    if (/常用加分项|常用项|加分模板|加分项|新增常用|添加常用/.test(s) || (/停用|启用|改名|更名/.test(s) && templateCandidates(state, s).length)) {
      return templateDraft(s, state, now, options);
    }
    return generalInterpret(input, state, now);
  }
  function generalInterpret(input, state, suppliedNow) {
    var s = trim(input), now = suppliedNow === undefined ? new Date() : new Date(suppliedNow), date, time, match, amount, name, list, category, content, t;
    if (!s) { return clarify('说一句你想做的事，也可以直接打字。'); }
    if (s.length > 1200) { return clarify('一次说一件事就好，请缩短到 1200 字以内。'); }
    if (/密码|验证码|验证题|核验题|解锁|忽略.*验证|绕过/.test(s)) { return clarify('家长验证需要在验证界面完成，我不会读取或代答。'); }
    if (/(?:然后|另外|顺便|同时).*(?:提醒|加分|给.*分|礼品)/.test(s)) { return clarify('一次先处理一件事。请先说要添加的提醒，或这次加分的行为名称和分值。'); }
    if (/还差|差多少|够.*换/.test(s)) {
      list = candidates(state.rewards, s, 'name');
      return list.length === 1 ? query({type:'reward_gap',rewardId:list[0].id}, state, now) : clarify('想查哪个礼品？请说完整名称。');
    }
    if (/能换什么|可以换什么|可兑换.*什么/.test(s)) { return query({type:'redeemable'}, state, now); }
    if (/多少.*分|几分|多少积分|积分余额|查积分|剩余积分/.test(s) && !/给|添加|新增|加一个/.test(s)) { return query({type:'balance'}, state, now); }
    if (/(?:有什么|有哪些|查看|看看|查一下).*(?:提醒|事项|安排)|(?:提醒|安排|事项).*(?:有哪些|有什么)/.test(s)) {
      date = day(s, now); return date ? query({type:'tasks',date:date}, state, now) : clarify('要看哪一天的提醒？');
    }
    if (/(?:我要|想要|申请|帮我)?(?:兑换|换一个|换一份|换个)/.test(s) && !/添加|新增|新建|加一个/.test(s)) {
      list = candidates(state.rewards, s, 'name');
      return list.length === 1 ? normalize({kind:'action',action:{type:'redemption.request',payload:{rewardId:list[0].id}}}, state, now) : clarify('想兑换哪个礼品？请说完整名称。');
    }
    if (/添加|新增|新建|加一个|加个/.test(s) && /礼品|奖励/.test(s)) {
      match = /([零〇一二两三四五六七八九十百\d]+)\s*分/.exec(s);
      if (!match) { return clarify('这个礼品需要多少积分？'); }
      amount = num(match[1]); category = /周末/.test(s) ? 'weekend' : (/月底|月末/.test(s) ? 'outing' : 'daily');
      name = trim(s.replace(/^(请)?(帮我)?(添加|新增|新建|加)(一个|个|一项)?/, '').replace(/[零〇一二两三四五六七八九十百\d]+\s*分/g, '').replace(/(?:只在|每个)?周末|月底|月末|日常|每天|需要|积分|兑换|礼品|奖励|的|[，,。：:]/g, ''));
      if (!name) { return clarify('这个礼品叫什么名字？'); }
      return normalize({kind:'action',action:{type:'reward.save',payload:{reward:{name:name,points:amount,category:category,enabled:true,icon:{daily:'pencil',weekend:'burger',outing:'mountain'}[category]}}}}, state, now);
    }
    if (/加.*分|给.*分|奖励.*分|记.*分/.test(s)) { return awardDraft(s, state, now); }
    if (/提醒|记一下|安排|改到|改成|改为|推迟/.test(s)) {
      date = day(s, now); time = clock(s);
      if (!date) { return clarify('具体是哪一天？可以说“明天”或“11月20日”。'); }
      if (time === null) { return clarify('时间没有听清，请说一个有效时间，例如“早上七点半”。'); }
      if (/改到|改成|改为|推迟/.test(s)) {
        list = candidates(state.tasks, s, 'title');
        if (list.length !== 1) { return clarify('要改哪一条提醒？请说完整事项名称。'); }
        if (!/今天|今晚|今早|明天|明早|明晚|后天|周[一二三四五六日天]|星期|\d月|\d{4}-/.test(s)) { date = list[0].date; }
        t = {id:list[0].id,date:date}; if (time) { t.time = time; }
        t.type = date > M.addDays(M.dateKey(now), 2) ? 'event' : list[0].type;
        return normalize({kind:'action',action:{type:'task.save',payload:{task:t}}}, state, now);
      }
      content = stripTime(s).replace(/^(请)?(帮我)?(?:添加|新增|新建|记一下|安排)(?:一个|一条)?/, '');
      content = trim(content.replace(/^(提醒我|提醒孩子|提醒|记得|要)/, '').replace(/提醒(?:我|孩子)?/, '').replace(/^[，,。\s]+|[，,。\s]+$/g, ''));
      if (!content) { return clarify('要提醒做什么？'); }
      if (!time && !/全天|不定时|不设时间|当天显示/.test(s)) { return clarify('希望几点提醒？例如“明天七点半提醒带水杯”。'); }
      content = trim(content.replace(/全天|不定时|不设时间|当天显示/g, ''));
      return normalize({kind:'action',action:{type:'task.save',payload:{task:{type:date > M.addDays(M.dateKey(now), 2) ? 'event' : 'task',title:content,date:date,time:time || '',note:'',remindDays:0}}}}, state, now);
    }
    return clarify('可以说“明天七点半提醒带水杯”、“主动收好书包，给五分”，或“我还有多少积分”。当前是本地指令演示，复杂说法可以直接手动填写。');
  }
  return {interpret:interpret, normalize:normalize, query:query};
}));
