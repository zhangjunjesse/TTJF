'use strict';
const crypto = require('node:crypto');
const M = require('../model.js');
const S = require('./security.cjs');
const { emailMessage } = require('./mail.cjs');

function createFamilies({ store, auth, mail, now, publicOrigin }) {
  const at = () => new Date(now());
  const familyView = family => ({ id: family.id, name: family.name, role: family.role });
  async function create(ctx, body) {
    const name = S.text(body.name, '家庭名称', 80), childName = S.text(body.childName, '孩子称呼', 40);
    if (typeof body.requestId !== 'string' || !S.ID.test(body.requestId)) { S.fail(400, 'VALIDATION_ERROR', '请提供创建请求标识'); }
    await auth.limit(ctx, 'create-family', 30);
    return store.transaction(async client => {
      const who = await auth.identity(client, ctx, { verified: true });
      const digest = S.digest(S.canonical({ name, childName }));
      const prior = (await client.query('SELECT * FROM saas_family_requests WHERE user_id=$1 AND request_id=$2', [who.user.id, body.requestId])).rows[0];
      if (prior) {
        const family = await store.family(client, who, prior.family_id);
        if (!S.equal(prior.digest, digest)) { S.fail(400, 'REQUEST_ID_REUSED', '此请求标识已使用'); }
        return { status: 200, body: { family: familyView(family) } };
      }
      const id = crypto.randomUUID(), sampled = at();
      const state = M.createEmptyFamily({ childName }, sampled);
      await client.query(`INSERT INTO saas_families(id,name,state,owner_user_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)`, [id, name, state, who.user.id, sampled]);
      await client.query("INSERT INTO saas_memberships(family_id,user_id,role,created_at) VALUES($1,$2,'owner',$3)", [id, who.user.id, sampled]);
      await client.query('INSERT INTO saas_family_requests(user_id,request_id,digest,family_id) VALUES($1,$2,$3,$4)', [who.user.id, body.requestId, digest, id]);
      return { status: 200, body: { family: { id, name, role: 'owner' } } };
    });
  }
  async function members(ctx, familyId) {
    return store.transaction(async client => {
      const who = await auth.identity(client, ctx, { verified: true });
      await store.family(client, who, familyId);
      const members = (await client.query(`SELECT m.user_id AS "userId", u.email, m.role FROM saas_memberships m
        JOIN saas_users u ON u.id=m.user_id WHERE m.family_id=$1 ORDER BY m.role,m.created_at`, [familyId])).rows;
      return { status: 200, body: { members } };
    });
  }
  async function invitations(ctx, familyId) {
    return store.transaction(async client => {
      const who = await auth.identity(client, ctx, { verified: true });
      await store.family(client, who, familyId, { owner: true });
      const rows = (await client.query('SELECT id,email,expires_at,consumed_at,revoked_at FROM saas_invitations WHERE family_id=$1 ORDER BY created_at DESC', [familyId])).rows;
      return { status: 200, body: { invitations: rows.map(row => ({ id: row.id, email: row.email,
        expiresAt: row.expires_at.toISOString(), status: row.consumed_at ? 'accepted' : row.revoked_at ? 'revoked' : +row.expires_at <= +at() ? 'expired' : 'pending' })) } };
    });
  }
  async function invite(ctx, familyId, body) {
    const email = S.email(body.email);
    await auth.limit(ctx, 'invite', 30);
    const raw = S.token();
    const result = await store.transaction(async client => {
      const who = await auth.identity(client, ctx, { verified: true });
      await store.family(client, who, familyId, { owner: true });
      const existing = await client.query(`SELECT 1 FROM saas_memberships m JOIN saas_users u ON u.id=m.user_id WHERE m.family_id=$1 AND u.email=$2`, [familyId, email]);
      if (existing.rowCount) { S.fail(400, 'ALREADY_MEMBER', '此邮箱已是家庭成员'); }
      const sampled = at(), expiresAt = new Date(+sampled + 7 * 86400000), id = crypto.randomUUID();
      await client.query('UPDATE saas_invitations SET revoked_at=$3 WHERE family_id=$1 AND email=$2 AND consumed_at IS NULL AND revoked_at IS NULL', [familyId, email, sampled]);
      await client.query(`INSERT INTO saas_invitations(id,family_id,email,token_hash,invited_by,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [id, familyId, email, S.digest(raw), who.user.id, sampled, expiresAt]);
      return { status: 200, body: { invitation: { id, email, expiresAt: expiresAt.toISOString() } } };
    });
    try { await mail.send(emailMessage(email, 'invite', raw, publicOrigin)); }
    catch (_) {
      await store.database.query('UPDATE saas_invitations SET revoked_at=$2 WHERE id=$1 AND consumed_at IS NULL', [result.body.invitation.id, at()]);
      S.fail(503, 'MAIL_UNAVAILABLE', '邀请邮件暂未发出，请稍后重试');
    }
    // A slow SMTP call must not return family information after removal/logout.
    return store.transaction(async client => {
      const who = await auth.identity(client, ctx, { verified: true });
      await store.family(client, who, familyId, { owner: true });
      return result;
    });
  }
  async function revoke(ctx, familyId, invitationId) {
    return store.transaction(async client => {
      const who = await auth.identity(client, ctx, { verified: true });
      await store.family(client, who, familyId, { owner: true });
      if (!S.UUID.test(invitationId)) { S.fail(404, 'INVITATION_INVALID', '未找到邀请'); }
      const result = await client.query('UPDATE saas_invitations SET revoked_at=COALESCE(revoked_at,$3) WHERE id=$1 AND family_id=$2 AND consumed_at IS NULL', [invitationId, familyId, at()]);
      if (!result.rowCount) { S.fail(404, 'INVITATION_INVALID', '邀请不存在或已使用'); }
      return { status: 200, body: { ok: true } };
    });
  }
  async function accept(ctx, body) {
    await auth.limit(ctx, 'accept-invite', 30);
    if (typeof body.token !== 'string' || !S.TOKEN.test(body.token)) { S.fail(400, 'INVITATION_INVALID', '邀请无效或已使用'); }
    return store.transaction(async client => {
      const who = await auth.identity(client, ctx, { verified: true });
      const hash = S.digest(body.token);
      const entry = (await client.query('SELECT * FROM saas_invitations WHERE token_hash=$1', [hash])).rows[0];
      if (!entry || entry.revoked_at || entry.consumed_at || +entry.expires_at <= +at() || entry.email !== who.user.email) {
        S.fail(400, 'INVITATION_INVALID', '邀请无效或已使用');
      }
      const family = (await client.query('SELECT id,name FROM saas_families WHERE id=$1', [entry.family_id])).rows[0];
      if (!family) { S.fail(400, 'INVITATION_INVALID', '邀请无效或已使用'); }
      const existing = await client.query('SELECT 1 FROM saas_memberships WHERE family_id=$1 AND user_id=$2', [family.id, who.user.id]);
      if (existing.rowCount) { S.fail(400, 'ALREADY_MEMBER', '你已是家庭成员'); }
      await client.query("INSERT INTO saas_memberships(family_id,user_id,role,created_at) VALUES($1,$2,'parent',$3)", [family.id, who.user.id, at()]);
      await client.query('UPDATE saas_invitations SET consumed_at=$2 WHERE token_hash=$1', [hash, at()]);
      return { status: 200, body: { family: { ...family, role: 'parent' } } };
    });
  }
  async function remove(ctx, familyId, userId) {
    return store.transaction(async client => {
      const who = await auth.identity(client, ctx, { verified: true });
      await store.family(client, who, familyId, { owner: true });
      if (!S.UUID.test(userId) || userId === who.user.id) { S.fail(400, 'OWNER_PROTECTED', '不能移除家庭所有者'); }
      const result = await client.query("DELETE FROM saas_memberships WHERE family_id=$1 AND user_id=$2 AND role='parent' RETURNING user_id", [familyId, userId]);
      if (!result.rowCount) { S.fail(404, 'MEMBER_NOT_FOUND', '未找到可移除的成员'); }
      await client.query(`UPDATE saas_invitations SET revoked_at=$3 WHERE family_id=$1
        AND email=(SELECT email FROM saas_users WHERE id=$2) AND consumed_at IS NULL AND revoked_at IS NULL`, [familyId, userId, at()]);
      return { status: 200, body: { ok: true } };
    });
  }
  return { create, members, invitations, invite, revoke, accept, remove };
}
module.exports = { createFamilies };
