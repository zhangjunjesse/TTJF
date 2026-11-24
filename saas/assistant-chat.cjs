'use strict';
const crypto = require('node:crypto');
const M = require('../model.js');
const S = require('./security.cjs');
const { resolveFollowup } = require('../assistant-tools.cjs');

const VISIBLE_TURNS = 30;
const MAX_RESULT_BYTES = 20000;
// Model output stays at 20KB. A confirmed step may add up to 2000 characters
// of parent-entered notes/reasons, whose JSON encoding can use six bytes each.
const MAX_RECEIPT_BYTES = 16000;
const ACTION_TYPES = new Set(['points.add', 'pointItem.save', 'pointItem.delete', 'task.save', 'task.toggle', 'task.ack', 'task.snooze',
  'reward.save', 'reward.redeem', 'redemption.request', 'redemption.cancel', 'redemption.approve', 'settings.update']);
const response = (body, status = 200) => ({ status, body });
const failure = (status, code, error, extra) => response({ code, error, ...extra }, status);
const plain = value => !!value && Object.getPrototypeOf(value) === Object.prototype;
const familyDay = sampled => M.dateKey(sampled, 'Asia/Shanghai');
const pick = (value, keys) => Object.fromEntries(keys.filter(key => S.own(value, key)).map(key => [key, value[key]]));
const brief = value => Array.from(value).length <= 160 ? value : Array.from(value).slice(0, 160).join('') + '…（完整内容已保存在记录中）';
function recordOf(rows, id) {
  const row = rows.find(item => item.id === id);
  if (!row) throw new Error('Missing committed assistant record');
  return row;
}
function ledgerReceipt(action, state) {
  const type = action.type;
  if (type === 'points.add') {
    const record = recordOf(state.points, 'points-' + action.id), payload = pick(record, ['itemId', 'name', 'points', 'reason', 'at']);
    if (action.saveAsTemplate) { payload.itemId = ''; payload.saveAsTemplate = true; }
    return { payload, title: '已加分', summary: record.name + ' · +' + record.points + ' 分' +
      (record.reason ? ' · ' + brief(record.reason) : '') + (action.saveAsTemplate ? ' · 已保存为常用行为' : '') };
  }
  if (type === 'reward.redeem' || type === 'redemption.approve') {
    const record = recordOf(state.redemptions, 'redeem-' + action.id);
    const payload = { ...(type === 'redemption.approve' ? { requestId: action.requestId } : { rewardId: record.rewardId }),
      expectedPoints: record.points, note: record.note };
    return { record: pick(record, ['id', 'name', 'category', 'at']), payload, title: type === 'redemption.approve' ? '已批准兑换' : '已直接兑换',
      summary: record.name + ' · -' + record.points + ' 分' + (record.note ? ' · ' + brief(record.note) : '') };
  }
  if (type === 'redemption.request' || type === 'redemption.cancel') {
    const record = type === 'redemption.cancel' ? recordOf(state.requests, action.requestId) :
      state.requests.find(item => item.rewardId === action.rewardId && item.status === 'pending');
    if (!record) throw new Error('Missing committed assistant request');
    return { record: pick(record, ['id', 'name', 'points', 'status', 'updatedAt']), payload: type === 'redemption.cancel' ? { requestId: record.id } : { rewardId: record.rewardId },
      title: type === 'redemption.cancel' ? '已取消申请' : '已提交兑换申请',
      summary: record.name + ' · ' + record.points + ' 分 · ' + (type === 'redemption.cancel' ? '已取消申请' : '等待家长确认') + '（本次未扣分）' };
  }
  return null;
}
function configurationReceipt(action, state, before) {
  const type = action.type, save = {
    'pointItem.save': ['pointItems', 'item', 'item-', '已保存常用行为'],
    'reward.save': ['rewards', 'reward', 'reward-', '已保存礼品'],
    'task.save': ['tasks', 'task', 'task-', '已保存提醒']
  }[type];
  if (save) {
    const [list, field, prefix, title] = save, record = recordOf(state[list], action[field].id || prefix + action.id);
    const payload = { [field]: field === 'task' ? pick(record, ['id', 'type', 'title', 'date', 'time', 'note', 'remindDays']) : record };
    const summary = field === 'task' ? record.date + ' ' + (record.time || '全天') + ' · ' + record.title + (record.note ? ' · ' + brief(record.note) : '') :
      record.name + ' · ' + (field === 'item' ? '每次 ' : '') + record.points + ' 分' + (record.enabled ? '' : ' · 停用') + (record.reason ? ' · ' + brief(record.reason) : '');
    return { ...(field === 'task' ? { record: pick(record, ['done', 'ackAt', 'snoozeUntil']) } : {}), payload, title, summary };
  }
  if (['task.toggle', 'task.ack', 'task.snooze'].includes(type)) {
    const record = recordOf(state.tasks, action.taskId);
    const status = type === 'task.toggle' ? record.done ? '已完成' : '已恢复未完成' : type === 'task.ack' ? '已确认提醒' : '十分钟后提醒';
    return { record: pick(record, ['id', 'title', 'date', 'time', 'done', 'ackAt', 'snoozeUntil']), payload: { taskId: record.id, ...(type === 'task.snooze' ? { minutes: 10 } : {}) },
      title: '已更新提醒', summary: record.title + ' · ' + status };
  }
  if (type === 'pointItem.delete') {
    const record = recordOf(before.pointItems, action.itemId);
    return { record: pick(record, ['id', 'name', 'points', 'enabled']), payload: { itemId: record.id }, title: '已删除常用行为', summary: record.name + ' · 历史积分保留' };
  }
  if (type === 'settings.update') {
    const reward = state.rewards.find(item => item.id === state.settings.preferredReward);
    const payload = { settings: state.settings, ...(S.own(action, 'childName') ? { childName: state.childName } : {}) };
    return { payload, title: '已保存设置', summary: '月末最后 ' + state.settings.monthEndDays + ' 天 · ' +
      (reward ? '心愿礼品：' + reward.name : '未设置心愿礼品') + (S.own(action, 'childName') ? ' · 孩子名字：' + state.childName : '') };
  }
  throw new Error('Unsupported committed assistant action');
}
function committedCard(original, action, state, before, revision) {
  const { record, payload, title, summary } = ledgerReceipt(action, state) || configurationReceipt(action, state, before);
  return { ...pick(original, ['mode', 'source', 'label']), kind: 'action', title, summary, action: { type: action.type, payload },
    receipt: { actionId: action.id, ...(revision === undefined ? {} : { revision }), ...(record ? { record } : {}) } };
}
function receiptRecovery(state) {
  let points, redemptions, requests;
  return (result, actions) => {
    if (!result || !actions.some(item => item.status === 'committed')) return result;
    const entries = new Map(actions.map(item => [item.index, item])), rows = result.kind === 'steps' ? result.steps : [result];
    let changed = false;
    const recovered = rows.map((row, index) => {
      const entry = entries.get(index);
      if (!entry || entry.status !== 'committed' || row.receipt) return row;
      changed = true;
      let card;
      if (entry.type === 'points.add') {
        points ||= new Map(state.points.map(item => [item.id, item]));
        const record = points.get('points-' + entry.actionId);
        if (record) card = committedCard(row, { id: entry.actionId, type: entry.type,
          saveAsTemplate: record.itemId === 'item-' + entry.actionId }, { points: [record] });
      } else if (entry.type === 'reward.redeem' || entry.type === 'redemption.approve') {
        redemptions ||= new Map(state.redemptions.map(item => [item.id, item]));
        const record = redemptions.get('redeem-' + entry.actionId);
        if (record && entry.type === 'reward.redeem') card = committedCard(row, { id: entry.actionId, type: entry.type }, { redemptions: [record] });
        if (record && entry.type === 'redemption.approve') {
          requests ||= new Map(state.requests.filter(item => item.redemptionId).map(item => [item.redemptionId, item]));
          const request = requests.get(record.id);
          if (request) card = committedCard(row, { id: entry.actionId, type: entry.type, requestId: request.id }, { redemptions: [record] });
        }
      }
      if (card) return { ...card, receipt: { ...card.receipt, recovered: true } };
      // Mutable rules/reminders/settings have no historical value to recover.
      // Keep their original user message, but do not label proposal values as facts.
      return { ...pick(row, ['mode', 'source', 'label']), kind: 'action', title: '历史操作已办理',
        summary: '这条旧记录没有保存实际确认内容，请到对应页面核对。', action: { type: entry.type, payload: {} },
        receipt: { actionId: entry.actionId, unavailable: true } };
    });
    return !changed ? result : result.kind === 'steps' ? { ...result, steps: recovered } : recovered[0];
  };
}

function contextOf(value) {
  if (value === undefined) return 'general';
  if (typeof value === 'string' && value.length <= 80) return value;
  if (!plain(value) || Object.keys(value).some(key => !['view', 'form', 'targetId'].includes(key))) {
    S.fail(400, 'VALIDATION_ERROR', '助手情境无效');
  }
  const context = {};
  for (const key of ['view', 'form', 'targetId']) {
    if (!S.own(value, key)) continue;
    if (typeof value[key] !== 'string' || value[key].length > (key === 'targetId' ? 200 : 80) ||
        (key === 'targetId' && value[key] && !S.ID.test(value[key]))) S.fail(400, 'VALIDATION_ERROR', '助手情境无效');
    context[key] = value[key];
  }
  return context;
}
function turnInput(body) {
  if (Object.keys(body).some(key => !['generation', 'turnId', 'text', 'context'].includes(key)) ||
      typeof body.generation !== 'string' || !S.TOKEN.test(body.generation) ||
      typeof body.turnId !== 'string' || !S.UUID.test(body.turnId) ||
      typeof body.text !== 'string' || !body.text.trim() || body.text.length > 1200) {
    S.fail(400, 'VALIDATION_ERROR', '请输入不超过1200字的消息，并使用当前会话');
  }
  const text = body.text.trim(), context = contextOf(body.context);
  return { text, context, turnId: body.turnId.toLowerCase(), digest: S.digest(S.canonical({ text, context })) };
}
function outputText(result) {
  if (result.kind === 'steps') return result.steps.map(outputText).join('\n');
  return [result.title, result.answer || result.question || result.summary || result.reason].filter(value => typeof value === 'string' && value).join('：') || '请核对下方内容';
}
function resultActions(result) {
  const rows = result.kind === 'steps' ? result.steps : [result], actions = [];
  rows.forEach((row, index) => {
    const type = row.kind === 'action' ? row.action && row.action.type : row.kind === 'form' && row.form === 'pointItem' ? 'pointItem.save' : null;
    if (type) {
      if (!ACTION_TYPES.has(type)) throw new Error('Unsupported assistant action');
      actions.push({ index, actionId: crypto.randomUUID(), type, status: 'pending' });
    }
  });
  return actions;
}
function boundedResult(value, maximum = MAX_RESULT_BYTES) {
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded) > maximum) throw new Error('Assistant result is too large');
  const result = JSON.parse(encoded), kinds = ['action', 'form', 'answer', 'clarify', 'route'];
  if (!plain(result) || !(kinds.includes(result.kind) || (result.kind === 'steps' && Array.isArray(result.steps) &&
      result.steps.length >= 1 && result.steps.length <= 8 && result.steps.every(row => plain(row) && kinds.includes(row.kind))))) {
    throw new Error('Invalid assistant result');
  }
  return result;
}
function messagesOf(turns) {
  const messages = [];
  for (const turn of turns) {
    messages.push({ role: 'user', text: turn.text, turnId: turn.turn_id, ...(turn.failed_at ? { failed: true, retryable: true } : {}) });
    if (turn.result) {
      const committed = turn.actions.filter(item => item.status === 'committed').map(item => item.index);
      messages.push({ role: 'assistant', text: outputText(turn.result), result: turn.result, turnId: turn.turn_id,
        ...(committed.length ? committed.length === turn.actions.length ? { committed: true } : { committedIndexes: committed } : {}) });
    }
  }
  return messages;
}
function contextTerms(text) {
  const terms = (text.toLowerCase().match(/[a-z0-9]{2,}|[\u3400-\u9fff]{2,}/g) || []).flatMap(word =>
    /^[a-z0-9]+$/.test(word) ? [word] : Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)));
  return [...new Set(terms)].slice(-24);
}
function contextMessages(turns) {
  let remaining = 24000;
  return messagesOf([...new Map(turns.map(turn => [turn.turn_id, turn])).values()].sort((a,b) => b.sequence-a.sequence).filter(turn => {
    const size = JSON.stringify(turn.result).length + turn.text.length;
    if (size > remaining) return false;
    remaining -= size; return true;
  }).reverse());
}
function pageCursor(value) {
  if (value === undefined) return null;
  try {
    if (typeof value !== 'string' || value.length > 160 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid cursor');
    const page = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!plain(page) || typeof page.generation !== 'string' || !S.TOKEN.test(page.generation) ||
        !Number.isSafeInteger(page.before) || page.before < 1) throw new Error('Invalid cursor');
    return page;
  } catch (_) { S.fail(400, 'VALIDATION_ERROR', '会话分页标识无效'); }
}

function createAssistantChats({ store, run, assistant, at, rate }) {
  const scope = (family, who) => [family.id, who.user.id];
  async function getChat(client, family, who) {
    const ids = scope(family, who);
    let chat = (await client.query('SELECT * FROM saas_assistant_chats WHERE family_id=$1 AND user_id=$2', ids)).rows[0];
    if (!chat) {
      chat = (await client.query(`INSERT INTO saas_assistant_chats(family_id,user_id,generation,created_at,updated_at)
        VALUES($1,$2,$3,$4,$4) RETURNING *`, [...ids, S.token(), at()])).rows[0];
    }
    return chat;
  }
  async function snapshot(client, family, who, chat, page = null) {
    const turns = (await client.query(`SELECT * FROM saas_assistant_turns WHERE family_id=$1 AND user_id=$2 AND generation=$3
      AND (completed_at IS NOT NULL OR failed_at IS NOT NULL) AND sequence<$4 ORDER BY sequence DESC LIMIT $5`,
      [...scope(family, who), chat.generation, page ? page.before : Number.MAX_SAFE_INTEGER, VISIBLE_TURNS + 1])).rows;
    const hasMore = turns.length > VISIBLE_TURNS, visible = turns.slice(0, VISIBLE_TURNS).reverse();
    const nextCursor = hasMore ? Buffer.from(JSON.stringify({ generation: chat.generation, before: visible[0].sequence })).toString('base64url') : null;
    const recover = receiptRecovery(family.state);
    const body = { generation: chat.generation, messages: messagesOf(visible.map(turn => ({ ...turn, result: recover(turn.result, turn.actions) }))), hasMore, nextCursor };
    if (chat.draft && chat.draft.actions.some(item => item.status === 'pending')) {
      body.draft = { ...chat.draft, result: recover(chat.draft.result, chat.draft.actions),
        ...(chat.draft.sourceRevision !== family.revision || chat.draft.familyDay !== familyDay(at()) ? { stale: true } : {}) };
    }
    if (chat.pending_turn_id && +chat.pending_expires_at > +at()) {
      body.pending = { turnId: chat.pending_turn_id };
      if (!page) {
        const pending = (await client.query(`SELECT text FROM saas_assistant_turns
          WHERE family_id=$1 AND user_id=$2 AND generation=$3 AND turn_id=$4`, [...scope(family, who), chat.generation, chat.pending_turn_id])).rows[0];
        if (pending) body.messages.push({ role: 'user', text: pending.text, turnId: chat.pending_turn_id, pending: true });
      }
    }
    const last = visible.at(-1);
    if (!page && !body.pending && last && last.failed_at) {
      body.retryTurn = { generation: chat.generation, turnId: last.turn_id, text: last.text, context: last.context };
    }
    return body;
  }
  async function changed(client, family, who, chat, code = 'ASSISTANT_CHAT_CHANGED') {
    return failure(409, code, code === 'ASSISTANT_STATE_CHANGED' ? '家庭记录已更新，请重新核对' : '会话已更新，请使用当前会话', await snapshot(client, family, who, chat));
  }
  async function read(ctx, body) {
    return run(ctx, async (client, who, family) => {
      if (Object.keys(body).some(key => !['generation','cursor'].includes(key)) || (body.generation !== undefined &&
          (typeof body.generation !== 'string' || !S.TOKEN.test(body.generation)))) return failure(400, 'VALIDATION_ERROR', '请使用有效会话标识');
      const page = pageCursor(body.cursor);
      await rate(client, who, family, 'assistant-read', 120);
      const chat = await getChat(client, family, who);
      if (chat.pending_turn_id && +chat.pending_expires_at <= +at()) await failPending(client, family, who, chat, 'ASSISTANT_INTERRUPTED');
      if ((body.generation !== undefined && body.generation !== chat.generation) || (page && page.generation !== chat.generation)) {
        return changed(client, family, who, chat);
      }
      return response(await snapshot(client, family, who, chat, page));
    });
  }
  async function clear(ctx, body) {
    return run(ctx, async (client, who, family) => {
      await rate(client, who, family, 'assistant-clear', 20);
      if (Object.keys(body).some(key => key !== 'generation') || typeof body.generation !== 'string' || !S.TOKEN.test(body.generation)) {
        return failure(400, 'VALIDATION_ERROR', '请使用当前会话');
      }
      const chat = await getChat(client, family, who);
      if (chat.generation !== body.generation) return changed(client, family, who, chat);
      await client.query('DELETE FROM saas_assistant_turns WHERE family_id=$1 AND user_id=$2', scope(family, who));
      const updated = (await client.query(`UPDATE saas_assistant_chats SET generation=$3,sequence=0,draft=NULL,context_result=NULL,
        pending_turn_id=NULL,pending_expires_at=NULL,updated_at=$4 WHERE family_id=$1 AND user_id=$2 RETURNING *`, [...scope(family, who), S.token(), at()])).rows[0];
      return response(await snapshot(client, family, who, updated));
    });
  }
  async function acquireLease(client, family, who) {
    await client.query('DELETE FROM saas_assistant_leases WHERE family_id=$1 AND expires_at<=$2', [family.id, at()]);
    const active = (await client.query('SELECT expires_at FROM saas_assistant_leases WHERE family_id=$1 ORDER BY expires_at', [family.id])).rows;
    if (active.length >= 2) {
      const error = new S.HttpError(429, 'RATE_LIMITED', '助手正在处理其他消息，请稍后再试');
      error.retryAfter = Math.max(1, Math.ceil((+active[0].expires_at - +at()) / 1000)); throw error;
    }
    const leaseId = crypto.randomUUID();
    await client.query('INSERT INTO saas_assistant_leases(id,family_id,user_id,session_hash,expires_at) VALUES($1,$2,$3,$4,$5)',
      [leaseId, family.id, who.user.id, who.session.token_hash, new Date(+at() + 30000)]);
    return leaseId;
  }
  async function failPending(client, family, who, chat, code) {
    if (!chat.pending_turn_id) return;
    await client.query(`UPDATE saas_assistant_turns SET failed_at=$5,failure_code=$6 WHERE family_id=$1 AND user_id=$2 AND generation=$3
      AND turn_id=$4 AND completed_at IS NULL`, [...scope(family, who), chat.generation, chat.pending_turn_id, at(), code]);
    await client.query(`UPDATE saas_assistant_chats SET pending_turn_id=NULL,pending_expires_at=NULL
      WHERE family_id=$1 AND user_id=$2 AND generation=$3`, [...scope(family, who), chat.generation]);
    chat.pending_turn_id = null; chat.pending_expires_at = null;
  }
  async function loadContext(client, family, who, chat, text) {
    const ids = [...scope(family, who), chat.generation];
    const recent = (await client.query(`SELECT * FROM saas_assistant_turns WHERE family_id=$1 AND user_id=$2 AND generation=$3
      AND completed_at IS NOT NULL ORDER BY sequence DESC LIMIT 8`, ids)).rows;
    const terms = contextTerms(text), cutoff = recent.length ? recent.at(-1).sequence : Number.MAX_SAFE_INTEGER;
    const older = [];
    if (terms.length) {
      const score = terms.map((_,index) => "CASE WHEN instr(lower(text || COALESCE(result,'')),$" + (index+5) + ')>0 THEN 1 ELSE 0 END').join('+');
      older.push(...(await client.query(`SELECT * FROM (SELECT *,(${score}) AS relevance FROM saas_assistant_turns
        WHERE family_id=$1 AND user_id=$2 AND generation=$3 AND completed_at IS NOT NULL AND sequence<$4)
        WHERE relevance>0 ORDER BY relevance DESC,sequence DESC LIMIT 4`, [...ids,cutoff,...terms])).rows);
    }
    if (chat.context_result) {
      older.push(...(await client.query(`SELECT * FROM saas_assistant_turns WHERE family_id=$1 AND user_id=$2 AND generation=$3
        AND turn_id=$4 AND completed_at IS NOT NULL`, [...ids,chat.context_result.turnId])).rows);
    }
    return [...recent,...older];
  }
  async function begin(client, who, family, body, input) {
    const chat = await getChat(client, family, who);
    if (chat.generation !== body.generation) return { reply: await changed(client, family, who, chat) };
    const prior = (await client.query(`SELECT * FROM saas_assistant_turns WHERE family_id=$1 AND user_id=$2 AND generation=$3 AND turn_id=$4`,
      [...scope(family, who), chat.generation, input.turnId])).rows[0];
    if (prior && prior.input_digest !== input.digest) return { reply: failure(400, 'ASSISTANT_TURN_REUSED', '这条消息标识已使用，请重新发送') };
    if (prior && prior.result) return { reply: response(await snapshot(client, family, who, chat)) };
    if (chat.pending_turn_id && +chat.pending_expires_at > +at()) {
      const reply = failure(409, 'ASSISTANT_CHAT_BUSY', '上一条消息还在处理中，请稍后重试', await snapshot(client, family, who, chat));
      reply.body.retryAfter = 1; reply.headers = { 'Retry-After': '1' }; return { reply };
    }
    await failPending(client, family, who, chat, 'ASSISTANT_INTERRUPTED');
    await rate(client, who, family, 'assistant', 12);
    if (!Number.isSafeInteger(chat.sequence + 1)) return { reply: failure(409, 'ASSISTANT_CHAT_LIMIT', '请清空会话后重新开始') };
    const leaseId = await acquireLease(client, family, who), sequence = chat.sequence + 1, sampled = at();
    await client.query(`INSERT INTO saas_assistant_turns(family_id,user_id,generation,turn_id,sequence,input_digest,text,source_revision,family_day,created_at,context)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(family_id,user_id,generation,turn_id) DO UPDATE SET sequence=excluded.sequence,
        source_revision=excluded.source_revision,family_day=excluded.family_day,failed_at=NULL,failure_code=NULL`,
      [...scope(family, who), chat.generation, input.turnId, sequence, input.digest, input.text, family.revision, familyDay(sampled), sampled, JSON.stringify(input.context)]);
    await client.query(`UPDATE saas_assistant_chats SET sequence=$3,pending_turn_id=$4,pending_expires_at=$5,updated_at=$6 WHERE family_id=$1 AND user_id=$2`,
      [...scope(family, who), sequence, input.turnId, new Date(+sampled + 30000), sampled]);
    const turns = await loadContext(client, family, who, chat, input.text);
    const state = JSON.parse(JSON.stringify(family.state)); delete state.childAvatar;
    const recover = receiptRecovery(state);
    return { leaseId, sequence, generation: chat.generation, revision: family.revision, day: familyDay(sampled), state,
      options: { messages: contextMessages(turns.map(turn => ({ ...turn, result: recover(turn.result, turn.actions) }))),
        draft: chat.context_result && recover(chat.context_result.result, chat.context_result.actions), draftStatus: chat.context_result && {
          actions: chat.context_result.actions, sourceRevision: chat.context_result.sourceRevision, familyDay: chat.context_result.familyDay }, context: input.context } };
  }
  async function generate(input, started) {
    let timer;
    try {
      if (typeof assistant.chat !== 'function') throw new Error('Conversation adapter unavailable');
      const deadline = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Assistant deadline')), 15000); });
      return boundedResult(await Promise.race([assistant.chat(input.text, started.state, at(), started.options), deadline]));
    } finally { clearTimeout(timer); }
  }
  async function finish(client, who, family, input, started, output) {
    const chat = await getChat(client, family, who);
    if (chat.generation !== started.generation || chat.sequence !== started.sequence || chat.pending_turn_id !== input.turnId) {
      return changed(client, family, who, chat);
    }
    if (!output || family.revision !== started.revision || familyDay(at()) !== started.day) {
      await failPending(client, family, who, chat, output ? 'ASSISTANT_STATE_CHANGED' : 'ASSISTANT_UNAVAILABLE');
      if (output) return changed(client, family, who, chat, 'ASSISTANT_STATE_CHANGED');
      return failure(503, 'ASSISTANT_UNAVAILABLE', '暂时无法处理这句话，请重试', await snapshot(client, family, who, chat));
    }
    const actions = resultActions(output), context = { generation: chat.generation, turnId: input.turnId, result: output,
      actions, sourceRevision: family.revision, familyDay: started.day };
    const drafting = actions.length > 0;
    const rows = output.kind === 'steps' ? output.steps : [output];
    const cancelling = rows.some(row => row.kind === 'answer' && row.cancelDraft === true);
    const draft = cancelling ? null : drafting ? context : chat.draft;
    const contextResult = cancelling ? null : drafting ? context : chat.context_result ||
      (output.kind === 'clarify' ? context : null);
    await client.query(`UPDATE saas_assistant_turns SET result=$5,actions=$6,completed_at=$7
      WHERE family_id=$1 AND user_id=$2 AND generation=$3 AND turn_id=$4`, [...scope(family, who), chat.generation, input.turnId, output, actions, at()]);
    const updated = (await client.query(`UPDATE saas_assistant_chats SET draft=$3,context_result=$4,pending_turn_id=NULL,pending_expires_at=NULL,updated_at=$5
      WHERE family_id=$1 AND user_id=$2 RETURNING *`, [...scope(family, who), draft, contextResult, at()])).rows[0];
    return response(await snapshot(client, family, who, updated));
  }
  async function turn(ctx, body) {
    let input, started;
    const initial = await run(ctx, async (client, who, family) => {
      input = turnInput(body); started = await begin(client, who, family, body, input);
      return started.reply || response({});
    });
    if (initial.status !== 200 || !started || started.reply) return initial;
    let output = null;
    try {
      try { output = await generate(input, started); resultActions(output); }
      catch (_) { output = null; }
      // Re-authorize after model IO, before reading or returning any family data.
      return await run(ctx, (client, who, family) => finish(client, who, family, input, started, output));
    } finally { await store.database.query('DELETE FROM saas_assistant_leases WHERE id=$1', [started.leaseId]); }
  }
  async function authorize(client, who, family, body, { replay = false } = {}) {
    if (body.assistantDraft === undefined) return null;
    const ref = body.assistantDraft;
    if (!plain(ref) || Object.keys(ref).some(key => !['generation', 'turnId'].includes(key)) ||
        typeof ref.generation !== 'string' || !S.TOKEN.test(ref.generation) || typeof ref.turnId !== 'string' || !S.UUID.test(ref.turnId)) {
      return { error: failure(400, 'VALIDATION_ERROR', '助手草稿标识无效') };
    }
    const chat = await getChat(client, family, who), turnId = ref.turnId.toLowerCase();
    const fail = async () => ({ error: failure(409, 'ASSISTANT_DRAFT_STALE', '家庭记录或草稿已更新，请回助手重新核对', await snapshot(client, family, who, chat)) });
    if (chat.generation !== ref.generation) return fail();
    const turn = (await client.query(`SELECT actions FROM saas_assistant_turns
      WHERE family_id=$1 AND user_id=$2 AND generation=$3 AND turn_id=$4`, [...scope(family, who), ref.generation, turnId])).rows[0];
    const entry = turn && turn.actions.find(item => item.actionId === body.action.id && item.type === body.action.type);
    if (!entry) return fail();
    if (replay && entry.status === 'committed') return { chat, turnId, entry };
    if (!chat.draft || chat.draft.turnId !== turnId || entry.status !== 'pending' ||
        chat.draft.sourceRevision !== family.revision || body.revision !== family.revision || chat.draft.familyDay !== familyDay(at())) return fail();
    return { chat, turnId, entry, action: body.action, before: family.state };
  }
  async function prepareResume(client, who, family, body, { replay = false, revision } = {}) {
    if (body.assistantResume === undefined) return null;
    const ref = body.assistantResume;
    if (!plain(ref) || Object.keys(ref).some(key => !['generation', 'turnId', 'actionId', 'type'].includes(key)) ||
        typeof ref.generation !== 'string' || !S.TOKEN.test(ref.generation) || typeof ref.turnId !== 'string' || !S.UUID.test(ref.turnId) ||
        typeof ref.actionId !== 'string' || !S.UUID.test(ref.actionId) || !ACTION_TYPES.has(ref.type)) {
      return { error: failure(400, 'VALIDATION_ERROR', '助手续接标识无效') };
    }
    const chat = await getChat(client, family, who), turnId = ref.turnId.toLowerCase(), day = familyDay(at());
    const fail = async () => ({ error: failure(409, 'ASSISTANT_DRAFT_STALE', '家庭记录或草稿已更新，请回助手重新核对', await snapshot(client, family, who, chat)) });
    const draft = chat.draft, entry = draft && draft.actions.find(item => item.actionId === ref.actionId.toLowerCase() && item.type === ref.type);
    if (body.action.type !== 'parent.setup' || family.role !== 'owner' || chat.generation !== ref.generation ||
        !draft || draft.turnId !== turnId || !entry || entry.status !== 'pending' || draft.familyDay !== day || draft.sourceRevision !== family.revision) return fail();
    if (replay) {
      // A setup receipt fingerprints the setup action. This saved marker also
      // binds its original draft; replay cannot attach that receipt to a new one.
      const saved = draft.setupResume;
      if (!family.parent.configured || family.revision !== revision || !saved || saved.setupActionId !== body.action.id ||
          saved.actionId !== entry.actionId || saved.revision !== revision) return fail();
    } else if (family.parent.configured || body.revision !== family.revision) return fail();
    return { chat, turnId, entry, setupActionId: body.action.id, familyDay: day, ...(replay ? { sourceRevision: revision } : {}) };
  }
  async function resume(client, who, family, binding, revision) {
    const { chat, turnId } = binding;
    const current = { ...chat.draft, sourceRevision: revision,
      setupResume: { setupActionId: binding.setupActionId, actionId: binding.entry.actionId, revision } };
    await client.query(`UPDATE saas_assistant_chats SET draft=$3,context_result=$4,updated_at=$5 WHERE family_id=$1 AND user_id=$2`,
      [...scope(family, who), current, chat.context_result && chat.context_result.turnId === turnId ? current : chat.context_result, at()]);
    return { sourceRevision: revision, familyDay: binding.familyDay };
  }
  async function committed(client, who, family, binding, revision) {
    if (!binding) return;
    const { chat, turnId } = binding;
    const actions = chat.draft.actions.map(item => item.actionId === binding.entry.actionId ? { ...item, status: 'committed' } : item);
    const original = receiptRecovery(family.state)(chat.draft.result, chat.draft.actions);
    const rows = original.kind === 'steps' ? original.steps : [original];
    const updatedRows = rows.map((row, index) => index === binding.entry.index ? committedCard(row, binding.action, family.state, binding.before, revision) : row);
    const result = original.kind === 'steps' ? { ...original, steps: updatedRows,
      summary: actions.some(item => item.status === 'pending') ? '已办理的项目按实际保存结果显示；其余候选仍需逐项确认。' : '全部项目已办理。' } : updatedRows[0];
    const updatedResult = boundedResult(resolveFollowup(result, family.state, at(), {
      committedIndexes: actions.filter(item => item.status === 'committed').map(item => item.index)
    }), MAX_RESULT_BYTES + actions.filter(item => item.status === 'committed').length * MAX_RECEIPT_BYTES);
    const current = { ...chat.draft, result: updatedResult, actions, sourceRevision: revision };
    await client.query(`UPDATE saas_assistant_turns SET actions=$5,result=$6 WHERE family_id=$1 AND user_id=$2 AND generation=$3 AND turn_id=$4`,
      [...scope(family, who), chat.generation, turnId, actions, updatedResult]);
    await client.query(`UPDATE saas_assistant_chats SET draft=$3,context_result=$4,updated_at=$5 WHERE family_id=$1 AND user_id=$2`,
      [...scope(family, who), actions.some(item => item.status === 'pending') ? current : null,
        chat.context_result && chat.context_result.turnId === turnId ? current : chat.context_result, at()]);
  }
  return { read, clear, turn, authorize, committed, prepareResume, resume };
}
module.exports = { createAssistantChats };
