'use strict';

const FamilyAssistant = require('./assistant.js');
const Model = require('./model.js');
const fs = require('node:fs');
const path = require('node:path');
const { createChat } = require('./assistant-chat.cjs');
function readAssistantConfig(name) { return fs.readFileSync(path.join(__dirname, 'config', 'assistant', name), 'utf8').trim(); }

const SYSTEM = readAssistantConfig('legacy-system.md');

const POINT_ITEM_CREATE_SYSTEM = readAssistantConfig('point-item-create-system.md');

function createAssistantService(options = {}) {
  const apiKey = options.apiKey === undefined ? (process.env.AI_API_KEY || '') : options.apiKey;
  const baseUrl = options.baseUrl || process.env.AI_BASE_URL || 'https://api.openai.com/v1';
  const model = options.model || process.env.AI_MODEL || 'gpt-4.1-mini';
  const fetchImpl = options.fetch || global.fetch;
  const timeoutMs = options.timeoutMs === undefined ? 12000 : options.timeoutMs;
  const formOnly = options.formOnly === undefined ? process.env.AI_FORM_ONLY === '1' : options.formOnly;
  // A configured legacy/form provider does not authorize sending ordinary
  // conversations. Only this explicit server-side switch enables chat AI.
  const chatEnabled = options.chatEnabled === undefined ? process.env.AI_CHAT_ENABLED === '1' : options.chatEnabled;
  let endpoint, deepSeek = false;
  if (apiKey) {
    const parsed = new URL(baseUrl.replace(/\/+$/, '') + '/chat/completions');
    if (parsed.username || parsed.password || parsed.hash || parsed.search) { throw new Error('AI_BASE_URL 不能包含身份信息、查询或片段'); }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) { throw new Error('AI_BASE_URL 需要 HTTPS，本机模型可用 localhost HTTP'); }
    endpoint = parsed.toString();
    deepSeek = parsed.hostname === 'api.deepseek.com';
  }
  if (typeof fetchImpl !== 'function') { throw new Error('AI 服务需要 Node.js 22 的 fetch'); }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { throw new Error('AI 超时必须为正数'); }
  if (typeof formOnly !== 'boolean') { throw new Error('formOnly 必须为布尔值'); }
  if (typeof chatEnabled !== 'boolean') { throw new Error('chatEnabled 必须为布尔值'); }

  function status() {
    return { mode: apiKey ? 'connected' : 'local', label: apiKey ? 'AI 已配置' : '指令演示', ...(apiKey && formOnly ? {formOnly:true} : {}) };
  }
  function context(state, now, inputOptions) {
    const inputMode = inputOptions.context || 'general';
    if (inputMode === 'pointItemCreate') { return { inputMode }; }
    const selected = inputOptions.targetId && state.pointItems.find(p => p.id === inputOptions.targetId);
    const pointItem = p => ({id:p.id,name:p.name,points:p.points,enabled:p.enabled,...(inputMode === 'pointItems' ? {reason:p.reason || ''} : {})});
    const result = {
      localDate: Model.dateKey(now), localTime: ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2),
      inputMode, selectedPointItemId: inputOptions.targetId || '',
      pointItems: state.pointItems.filter(p => inputMode !== 'points' || p.enabled).slice(0,80).map(pointItem)
    };
    if (selected) { result.selectedPointItem = pointItem(selected); }
    if (inputMode !== 'pointItems') { result.points = Model.totals(state); }
    if (inputMode === 'general') {
      result.monthEndDays = state.settings.monthEndDays;
      result.rewards = state.rewards.filter(r => r.enabled).map(r => ({id:r.id,name:r.name,points:r.points,category:r.category}));
      result.tasks = state.tasks.filter(t => !t.deleted && !t.done).slice(-80).map(t => ({id:t.id,title:t.title,date:t.date,time:t.time,type:t.type}));
    }
    return result;
  }
  async function readBounded(response) {
    if (Number(response.headers.get('content-length') || 0) > 262144) { throw new Error('RESPONSE_TOO_LARGE'); }
    if (!response.body) { throw new Error('EMPTY_RESPONSE'); }
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) { break; }
        size += part.value.byteLength;
        if (size > 262144) { await reader.cancel(); throw new Error('RESPONSE_TOO_LARGE'); }
        chunks.push(Buffer.from(part.value));
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally { reader.releaseLock(); }
  }
  async function interpret(text, state, suppliedNow, inputOptions = {}) {
    if (!inputOptions || typeof inputOptions !== 'object' || Array.isArray(inputOptions) || !['general','points','pointItems','pointItemCreate'].includes(inputOptions.context || 'general') ||
        (inputOptions.context === 'pointItemCreate' && inputOptions.targetId !== undefined && inputOptions.targetId !== '')) {
      return {kind:'clarify',question:'请从当前加分或常用项管理入口重新开始。', ...status()};
    }
    if (typeof text !== 'string' || !text.trim() || text.length > 1200) {
      return {kind:'clarify',question:'一次说一件事就好，请输入 1–1200 字。', ...status()};
    }
    const now = suppliedNow === undefined ? new Date() : new Date(suppliedNow);
    const creatingPointItem = inputOptions.context === 'pointItemCreate';
    if (!apiKey || (formOnly && !creatingPointItem)) {
      try { return FamilyAssistant.interpret(text, state, now, inputOptions); }
      catch (_) { return {kind:'clarify',question:'请核对日期和时间，再试一次。', ...status()}; }
    }
    // Verification data is not included in the model context, even if a user asks.
    if (/密码|验证码|验证题|核验题|解锁|绕过/.test(text)) {
      return {kind:'clarify',question:'家长验证需要在验证界面完成，我不会读取或代答。', ...status()};
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method:'POST', redirect:'error', signal:controller.signal,
        headers:{'Content-Type':'application/json','Authorization':'Bearer ' + apiKey},
        body:JSON.stringify({model,temperature:0,max_tokens:650,response_format:{type:'json_object'},
          ...(creatingPointItem && deepSeek ? {thinking:{type:'disabled'}} : {}),messages:[
          {role:'system',content:creatingPointItem ? POINT_ITEM_CREATE_SYSTEM : SYSTEM},
          {role:'user',content:JSON.stringify({context:context(state, now, inputOptions),instruction:text})}
        ]})
      });
      if (!response.ok) { throw new Error('PROVIDER_FAILED'); }
      const envelope = JSON.parse(await readBounded(response));
      let content = envelope && envelope.choices && envelope.choices[0] && envelope.choices[0].message && envelope.choices[0].message.content;
      if (typeof content !== 'string' || content.length > 12000) { throw new Error('INVALID_MODEL_OUTPUT'); }
      content = content.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
      const candidate = JSON.parse(content);
      const result = FamilyAssistant.normalize(candidate, state, now, creatingPointItem ? {...inputOptions,sourceText:text} : inputOptions);
      result.mode = 'connected'; result.label = 'AI 已整理';
      return result;
    } catch (_) {
      // Never leak provider errors, credentials, or silently pretend an AI request succeeded.
      return {kind:'clarify',question:'AI 暂时没能完成整理。输入已保留，可以重试，或直接使用加分、礼品和提醒按钮。',mode:'connected',label:'AI 暂不可用'};
    } finally { clearTimeout(timer); }
  }
  const conversation = createChat({apiKey,endpoint,model,fetchImpl,timeoutMs,readBounded,enabled:chatEnabled,formOnly,interpret});
  return { status, interpret, chat:conversation.chat, chatStatus:conversation.status };
}

module.exports = { createAssistantService };
