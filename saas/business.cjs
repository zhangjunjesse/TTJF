'use strict';
const crypto = require('node:crypto');
const M = require('../model.js');
const S = require('./security.cjs');
const { createAssistantChats } = require('./assistant-chat.cjs');
// Private, immutable by callers: these are the existing daily business actions.
const PUBLIC = new Set(['task.toggle', 'task.ack', 'task.snooze', 'redemption.request', 'redemption.cancel',
  'pet.configure', 'pet.care', 'pet.scene', 'farm.start', 'farm.plant', 'farm.harvest', 'farm.exchange', 'farm.place', 'farm.animalCare']);

function createBusiness({ store, auth, now, assistant }) {
  const at = () => new Date(now());
  const publicParent = family => ({ configured: family.parent.configured, method: family.parent.method });
  function snapshot(family) {
    const sampled = at();
    return { revision: family.revision, state: family.state, parent: publicParent(family), serverNow: sampled.toISOString(), familyDay: M.dateKey(sampled, 'Asia/Shanghai') };
  }
  function result(body, status = 200) { return { status, body }; }
  function error(status, code, message, extra) { return result({ error: message, code, ...extra }, status); }
  function actionResult(family, body, resumed) {
    const output = snapshot(family);
    if (resumed) output.assistantResume = { ...body.assistantResume, turnId: body.assistantResume.turnId.toLowerCase(),
      sourceRevision: resumed.sourceRevision, familyDay: resumed.familyDay };
    return result(output);
  }
  function conflict(family, action) {
    return action && action.type === 'parent.setup' && family.parent.configured ?
      error(409, 'PARENT_ALREADY_CONFIGURED', '家长验证已设置', snapshot(family)) : result(snapshot(family), 409);
  }
  function setupRequired(family) {
    return error(403, 'PARENT_SETUP_REQUIRED', '请先设置家长验证', { revision: family.revision, parent: publicParent(family) });
  }
  async function run(ctx, fn) {
    return store.transaction(async client => {
      const who = await auth.identity(client, ctx, { verified: true });
      const family = await store.family(client, who, ctx.familyId);
      let response;
      try { response = await fn(client, who, family); }
      catch (e) {
        // Expected validation failures commit attempt counters. Database/model
        // corruption remains an exception and rolls back the whole transaction.
        if (!(e instanceof S.HttpError)) { throw e; }
        response = error(e.status, e.code, e.message);
        if (e.retryAfter) { response.body.retryAfter = e.retryAfter; response.headers = { 'Retry-After': String(e.retryAfter) }; }
      }
      response.body = { ...response.body, familyId: family.id, userId: who.user.id };
      return response;
    });
  }
  async function rate(client, who, family, kind, maximum) {
    for (const [key, max] of [[kind + ':family:' + family.id, maximum * 3], [kind + ':family:' + family.id + ':user:' + who.user.id, maximum]]) {
      const checked = await store.rate(key, max, 60000, at(), client);
      if (!checked.allowed) { rateError(checked.until); }
    }
  }
  function rateError(until) {
    const e = new S.HttpError(429, 'RATE_LIMITED', '尝试次数较多，请稍后再试');
    e.retryAfter = Math.max(1, Math.ceil((+until - +at()) / 1000)); throw e;
  }
  async function failuresAllowed(client, family) {
    const row = (await client.query('SELECT count,expires_at FROM saas_rate_limits WHERE scope=$1', [S.digest('parent-failures:' + family.id)])).rows[0];
    if (row && +row.expires_at > +at() && row.count >= 5) { rateError(row.expires_at); }
  }
  async function failure(client, family) { await store.rate('parent-failures:' + family.id, 5, 300000, at(), client); }
  function configValues(action, family) {
    if (!['pin', 'math'].includes(action.method)) { S.fail(400, 'VALIDATION_ERROR', '家长核验方式无效'); }
    if (action.type === 'parent.setup') {
      if (Object.keys(action).some(k => !['id', 'type', 'method', 'pin', 'confirmPin'].includes(k))) { S.fail(400, 'VALIDATION_ERROR', '首次设置包含无效字段'); }
      if (action.method === 'pin') {
        if (typeof action.pin !== 'string' || !/^\d{6}$/.test(action.pin)) { S.fail(400, 'VALIDATION_ERROR', 'PIN须为6位数字'); }
        if (action.confirmPin !== action.pin) { S.fail(400, 'VALIDATION_ERROR', 'PIN确认不一致'); }
      } else if (S.own(action, 'pin') || S.own(action, 'confirmPin')) { S.fail(400, 'VALIDATION_ERROR', '算术方式无需PIN'); }
    } else {
      if (S.own(action, 'pin') && (typeof action.pin !== 'string' || !/^\d{6,12}$/.test(action.pin))) { S.fail(400, 'VALIDATION_ERROR', '家长密码须为6至12位数字'); }
      if (S.own(action, 'confirmPin') && (!S.own(action, 'pin') || action.confirmPin !== action.pin)) { S.fail(400, 'VALIDATION_ERROR', 'PIN确认不一致'); }
      if (action.method === 'pin' && !S.own(action, 'pin') && !family.parent.hash) { S.fail(400, 'VALIDATION_ERROR', '请设置新PIN'); }
    }
  }
  function applyModel(family, action) {
    try { return M.apply(family.state, action, at(), 'Asia/Shanghai'); }
    catch (e) { S.fail(400, 'VALIDATION_ERROR', e.message); }
  }
  async function state(ctx) { return run(ctx, async (_c, _u, family) => result(snapshot(family))); }
  async function meta(ctx) {
    return run(ctx, async (_c, _u, family) => {
      const status = assistant.status();
      if (!status || !['local', 'connected'].includes(status.mode) || typeof status.label !== 'string') { return error(503, 'ASSISTANT_UNAVAILABLE', '助手暂不可用'); }
      const sampled = at();
      return result({ revision: family.revision, parent: publicParent(family), assistant: { mode: status.mode, label: status.label, ...(status.formOnly === true ? {formOnly:true} : {}) }, now: sampled.toISOString(), familyDay: M.dateKey(sampled, 'Asia/Shanghai') });
    });
  }
  async function challenge(ctx, body) {
    return run(ctx, async (client, who, family) => {
      await rate(client, who, family, 'challenge', 20);
      await failuresAllowed(client, family);
      S.command(body);
      const binding = await chats.authorize(client, who, family, body);
      if (binding && binding.error) { return binding.error; }
      if (body.revision !== family.revision) { return conflict(family, body.action); }
      if (!family.parent.configured) { return setupRequired(family); }
      if (body.action.type === 'parent.setup') { return conflict(family, body.action); }
      if (PUBLIC.has(body.action.type)) { return error(400, 'VALIDATION_ERROR', '此日常操作无需家长验证'); }
      if (family.state.appliedActions.includes(body.action.id)) { return error(400, 'ACTION_ID_REUSED', '此操作已提交，请使用相同内容直接重试'); }
      if (body.action.type === 'parent.configure') { configValues(body.action, family); }
      else { applyModel(family, body.action); }
      const raw = S.token(), method = family.parent.method, expiresAt = new Date(+at() + 120000);
      const receipt = await S.makeReceipt(body.action);
      const response = { challengeId: raw, method, expiresAt: expiresAt.toISOString() };
      let answerHash = null;
      if (method === 'math') {
        const left = crypto.randomInt(11, 100), right = crypto.randomInt(11, 100);
        response.question = left + ' + ' + right + ' = ?';
        answerHash = S.digest(raw + ':' + (left + right));
      }
      await client.query('DELETE FROM saas_parent_challenges WHERE family_id=$1 AND expires_at<=$2', [family.id, at()]);
      await client.query('DELETE FROM saas_parent_grants WHERE family_id=$1 AND expires_at<=$2', [family.id, at()]);
      await client.query(`INSERT INTO saas_parent_challenges(token_hash,family_id,user_id,session_hash,revision,action_receipt,method,answer_hash,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [S.digest(raw), family.id, who.user.id, who.session.token_hash, family.revision, receipt, method, answerHash, expiresAt]);
      return result(response);
    });
  }
  async function verify(ctx, body) {
    return run(ctx, async (client, who, family) => {
      await rate(client, who, family, 'verify', 30);
      await failuresAllowed(client, family);
      const hash = typeof body.challengeId === 'string' && S.TOKEN.test(body.challengeId) ? S.digest(body.challengeId) : '';
      const entry = (await client.query(`SELECT * FROM saas_parent_challenges WHERE token_hash=$1 AND family_id=$2 AND user_id=$3 AND session_hash=$4`,
        [hash, family.id, who.user.id, who.session.token_hash])).rows[0];
      if (!entry || +entry.expires_at <= +at()) {
        if (entry) { await client.query('DELETE FROM saas_parent_challenges WHERE token_hash=$1', [hash]); }
        return error(410, 'CHALLENGE_EXPIRED', '验证请求已失效，请重新确认操作');
      }
      if (Number(entry.revision) !== family.revision) {
        await client.query('DELETE FROM saas_parent_challenges WHERE token_hash=$1', [hash]);
        return result(snapshot(family), 409);
      }
      const answer = ['string', 'number'].includes(typeof body.answer) ? String(body.answer).trim() : '';
      let valid = false;
      if (entry.method === 'pin' && /^\d{6,12}$/.test(answer)) {
        valid = S.equal(await S.slowHash(answer, family.parent.salt, family.parent.n || 16384), family.parent.hash);
      } else if (entry.method === 'math') { valid = S.equal(S.digest(body.challengeId + ':' + answer), entry.answer_hash); }
      if (!valid) {
        await failure(client, family);
        if (entry.attempts >= 2) { await client.query('DELETE FROM saas_parent_challenges WHERE token_hash=$1', [hash]); }
        else { await client.query('UPDATE saas_parent_challenges SET attempts=attempts+1 WHERE token_hash=$1', [hash]); }
        return error(403, 'VERIFICATION_FAILED', '验证未通过，请重试');
      }
      await client.query('DELETE FROM saas_parent_challenges WHERE token_hash=$1', [hash]);
      const grant = S.token(), expiresAt = new Date(+at() + 60000);
      await client.query(`INSERT INTO saas_parent_grants(token_hash,family_id,user_id,session_hash,revision,action_receipt,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [S.digest(grant), family.id, who.user.id, who.session.token_hash, family.revision, entry.action_receipt, expiresAt]);
      return result({ grant, expiresAt: expiresAt.toISOString() });
    });
  }
  async function action(ctx, body) {
    return run(ctx, async (client, who, family) => {
      await rate(client, who, family, 'action', 60);
      S.command(body);
      const settingUp = body.action.type === 'parent.setup';
      if (settingUp && family.role !== 'owner') { return error(403, 'OWNER_REQUIRED', '仅家庭所有者可首次设置家长验证'); }
      // Membership/session authorization above precedes every receipt read.
      const prior = (await client.query('SELECT receipt,revision FROM saas_action_receipts WHERE family_id=$1 AND action_id=$2', [family.id, body.action.id])).rows[0];
      const binding = await chats.authorize(client, who, family, body, { replay: !!prior });
      if (binding && binding.error) { return binding.error; }
      if (prior || family.state.appliedActions.includes(body.action.id)) {
        if (prior && prior.receipt.algorithm === 'scrypt') { await failuresAllowed(client, family); }
        if (!prior || !await S.matchesReceipt(prior.receipt, body.action)) {
          if (prior && prior.receipt.algorithm === 'scrypt') { await failure(client, family); }
          return error(400, 'ACTION_ID_REUSED', '此操作标识已使用，不能更改内容后重试');
        }
      }
      const resuming = await chats.prepareResume(client, who, family, body, { replay: !!prior, revision: prior && Number(prior.revision) });
      if (resuming && resuming.error) return { ...resuming.error, body: { ...snapshot(family), ...resuming.error.body } };
      if (prior) return actionResult(family, body, resuming);
      if (body.revision !== family.revision) { return conflict(family, body.action); }
      if (settingUp && family.parent.configured) { return conflict(family, body.action); }
      let grantHash;
      if (!settingUp && !PUBLIC.has(body.action.type)) {
        if (!family.parent.configured) { return setupRequired(family); }
        if (!body.grant) { return error(403, 'PARENT_REQUIRED', '此操作需要家长验证'); }
        grantHash = typeof body.grant === 'string' && S.TOKEN.test(body.grant) ? S.digest(body.grant) : '';
        const grant = (await client.query(`SELECT * FROM saas_parent_grants WHERE token_hash=$1 AND family_id=$2 AND user_id=$3 AND session_hash=$4`,
          [grantHash, family.id, who.user.id, who.session.token_hash])).rows[0];
        if (grant && +grant.expires_at <= +at()) {
          await client.query('DELETE FROM saas_parent_grants WHERE token_hash=$1', [grantHash]);
          return error(410, 'GRANT_EXPIRED', '本次授权已过期，请重新验证');
        }
        if (grant && grant.action_receipt.algorithm === 'scrypt') { await failuresAllowed(client, family); }
        if (!grant || Number(grant.revision) !== body.revision || !await S.matchesReceipt(grant.action_receipt, body.action)) {
          if (grant && grant.action_receipt.algorithm === 'scrypt') { await failure(client, family); }
          return error(403, 'GRANT_INVALID', '本次授权与操作不匹配，请重新验证');
        }
      }
      let state, parent = family.parent;
      if (settingUp || body.action.type === 'parent.configure') {
        configValues(body.action, family);
        if (S.own(body.action, 'pin')) {
          const hashed = await S.hashPassword(body.action.pin);
          parent = { configured: true, method: body.action.method, n: hashed.n, salt: hashed.salt, hash: hashed.digest };
        } else { parent = settingUp ? { configured: true, method: 'math' } : { ...parent, method: body.action.method }; }
        state = M.normalize(family.state);
        state.appliedActions.push(body.action.id);
      } else { state = applyModel(family, body.action); }
      if (!Number.isSafeInteger(family.revision + 1)) { return error(500, 'REVISION_LIMIT', '版本号已达到上限'); }
      const revision = family.revision + 1, receipt = await S.makeReceipt(body.action);
      await client.query('UPDATE saas_families SET state=$2,parent=$3,revision=$4,updated_at=$5 WHERE id=$1', [family.id, state, parent, revision, at()]);
      await client.query('INSERT INTO saas_action_receipts(family_id,action_id,receipt,revision,created_at) VALUES($1,$2,$3,$4,$5)', [family.id, body.action.id, receipt, revision, at()]);
      if (grantHash) { await client.query('DELETE FROM saas_parent_grants WHERE token_hash=$1', [grantHash]); }
      const updatedFamily = { ...family, state, parent, revision };
      await chats.committed(client, who, updatedFamily, binding, revision);
      const resumed = resuming && await chats.resume(client, who, updatedFamily, resuming, revision);
      return actionResult(updatedFamily, body, resumed);
    });
  }
  async function interpret(ctx, body) {
    let inputState, leaseId;
    const initial = await run(ctx, async (client, who, family) => {
      await rate(client, who, family, 'assistant', 12);
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 1200) { return error(400, 'VALIDATION_ERROR', '请输入不超过1200字的指令'); }
      const context = body.context === undefined ? 'general' : body.context, targetId = body.targetId === undefined ? '' : body.targetId;
      if (!['general', 'points', 'pointItems', 'pointItemCreate'].includes(context) || typeof targetId !== 'string' || (targetId && !S.ID.test(targetId)) ||
          (context === 'pointItemCreate' && targetId !== '')) { return error(400, 'VALIDATION_ERROR', '助手情境或目标标识无效'); }
      await client.query('DELETE FROM saas_assistant_leases WHERE family_id=$1 AND expires_at<=$2', [family.id, at()]);
      const active = (await client.query('SELECT expires_at FROM saas_assistant_leases WHERE family_id=$1 ORDER BY expires_at', [family.id])).rows;
      if (active.length >= 2) { rateError(active[0].expires_at); }
      leaseId = crypto.randomUUID();
      await client.query('INSERT INTO saas_assistant_leases(id,family_id,user_id,session_hash,expires_at) VALUES($1,$2,$3,$4,$5)',
        [leaseId, family.id, who.user.id, who.session.token_hash, new Date(+at() + 30000)]);
      inputState = JSON.parse(JSON.stringify(family.state));
      delete inputState.childAvatar;
      return result({});
    });
    if (initial.status !== 200) { return initial; }
    let output, timer;
    try {
      const deadline = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('assistant deadline')), 15000); });
      const interpreted = assistant.interpret(body.text.trim(), inputState, at(), { context: body.context || 'general', targetId: body.targetId || '' });
      output = result(await Promise.race([interpreted, deadline]));
    } catch (_) { output = error(503, 'ASSISTANT_UNAVAILABLE', '暂时无法理解这句话，请重试或手动填写'); }
    finally {
      clearTimeout(timer);
      await store.database.query('DELETE FROM saas_assistant_leases WHERE id=$1', [leaseId]);
    }
    // Never return delayed family-derived AI data to a revoked session/member.
    return run(ctx, async () => output);
  }
  const chats = createAssistantChats({ store, run, assistant, at, rate });
  return { state, meta, challenge, verify, action, interpret, chatRead: chats.read, chatTurn: chats.turn, chatClear: chats.clear };
}
module.exports = { createBusiness };
