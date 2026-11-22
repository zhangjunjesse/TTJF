'use strict';
const crypto = require('node:crypto');
const M = require('../model.js');
const S = require('./security.cjs');
const { resolveFollowup, isDraftCancellation } = require('../assistant-tools.cjs');

const VISIBLE_TURNS = 30;
const MAX_RESULT_BYTES = 20000;
const ACTION_TYPES = new Set(['points.add', 'pointItem.save', 'pointItem.delete', 'task.save', 'task.toggle', 'task.ack', 'task.snooze',
  'reward.save', 'reward.redeem', 'redemption.request', 'redemption.cancel', 'redemption.approve', 'settings.update']);
const response = (body, status = 200) => ({ status, body });
const failure = (status, code, error, extra) => response({ code, error, ...extra }, status);
const plain = value => !!value && Object.getPrototypeOf(value) === Object.prototype;
const familyDay = sampled => M.dateKey(sampled, 'Asia/Shanghai');

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
function boundedResult(value) {
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded) > MAX_RESULT_BYTES) throw new Error('Assistant result is too large');
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
      messages.push({ role: 'assistant', text: outputText(turn.result), result: turn.result, turnId: turn.turn_id,
        ...(turn.actions.length && turn.actions.every(item => item.status === 'committed') ? { committed: true } : {}) });
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
    const body = { generation: chat.generation, messages: messagesOf(visible), hasMore, nextCursor };
    if (chat.draft && chat.draft.actions.some(item => item.status === 'pending')) {
      body.draft = { ...chat.draft, ...(chat.draft.sourceRevision !== family.revision || chat.draft.familyDay !== familyDay(at()) ? { stale: true } : {}) };
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
      [...scope(family, who), chat.generation, input.turnId, sequence, input.digest, input.text, family.revision, familyDay(sampled), sampled, input.context]);
    await client.query(`UPDATE saas_assistant_chats SET sequence=$3,pending_turn_id=$4,pending_expires_at=$5,updated_at=$6 WHERE family_id=$1 AND user_id=$2`,
      [...scope(family, who), sequence, input.turnId, new Date(+sampled + 30000), sampled]);
    const turns = await loadContext(client, family, who, chat, input.text);
    const state = JSON.parse(JSON.stringify(family.state)); delete state.childAvatar;
    return { leaseId, sequence, generation: chat.generation, revision: family.revision, day: familyDay(sampled), state,
      options: { messages: contextMessages(turns),
        draft: chat.context_result && chat.context_result.result, draftStatus: chat.context_result && {
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
    const cancelling = output.cancelDraft === true && isDraftCancellation(input.text);
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
    return { chat, turnId, entry };
  }
  async function committed(client, who, family, binding, revision) {
    if (!binding) return;
    const { chat, turnId } = binding;
    const actions = chat.draft.actions.map(item => item.actionId === binding.entry.actionId ? { ...item, status: 'committed' } : item);
    const updatedResult = boundedResult(resolveFollowup(chat.draft.result, family.state, at(), {
      committedIndexes: actions.filter(item => item.status === 'committed').map(item => item.index)
    }));
    const current = { ...chat.draft, result: updatedResult, actions, sourceRevision: revision };
    await client.query(`UPDATE saas_assistant_turns SET actions=$5,result=$6 WHERE family_id=$1 AND user_id=$2 AND generation=$3 AND turn_id=$4`,
      [...scope(family, who), chat.generation, turnId, actions, updatedResult]);
    await client.query(`UPDATE saas_assistant_chats SET draft=$3,context_result=$4,updated_at=$5 WHERE family_id=$1 AND user_id=$2`,
      [...scope(family, who), actions.some(item => item.status === 'pending') ? current : null,
        chat.context_result && chat.context_result.turnId === turnId ? current : chat.context_result, at()]);
  }
  return { read, clear, turn, authorize, committed };
}
module.exports = { createAssistantChats };
