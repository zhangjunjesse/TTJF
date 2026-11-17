'use strict';
const S = require('./security.cjs');

function createLifecycle({ store, auth, now }) {
  const at = () => new Date(now());
  const ok = () => ({ status: 200, body: { ok: true } });
  async function password(who, value) {
    if (typeof value !== 'string' || value.length > 128 || !await S.checkPassword(value, who.user.password_hash)) {
      S.fail(403, 'PASSWORD_INVALID', '当前密码不正确');
    }
  }
  async function rename(ctx, familyId, body) {
    const name = S.text(body.name, '家庭名称', 80);
    await auth.limit(ctx, 'family-rename', 30);
    return store.transaction(async client => {
      const who = await auth.identity(client, ctx, { verified: true });
      const family = await store.family(client, who, familyId, { owner: true });
      await client.query('UPDATE saas_families SET name=$2,updated_at=$3 WHERE id=$1', [family.id, name, at()]);
      return { status: 200, body: { family: { id: family.id, name, role: family.role } } };
    });
  }
  async function leave(ctx, familyId) {
    await auth.limit(ctx, 'family-leave', 30);
    return store.transaction(async client => {
      const who = await auth.identity(client, ctx, { verified: true, userLock: true });
      const family = await store.family(client, who, familyId);
      if (family.role === 'owner') { S.fail(409, 'OWNER_MUST_TRANSFER', '请先移交家庭所有权'); }
      await client.query('DELETE FROM saas_memberships WHERE family_id=$1 AND user_id=$2', [family.id, who.user.id]);
      await client.query(`UPDATE saas_invitations SET revoked_at=$3 WHERE family_id=$1 AND email=$2
        AND consumed_at IS NULL AND revoked_at IS NULL`, [family.id, who.user.email, at()]);
      return ok();
    });
  }
  async function transfer(ctx, familyId, body) {
    if (typeof body.userId !== 'string' || !S.UUID.test(body.userId)) { S.fail(400, 'TRANSFER_TARGET_INVALID', '请选择本家庭已验证的家长'); }
    const targetId = body.userId.toLowerCase();
    if (typeof familyId !== 'string' || !S.UUID.test(familyId)) { S.fail(400, 'FAMILY_REQUIRED', '请选择家庭'); }
    await auth.limit(ctx, 'family-transfer', 20);
    // Establish that both memberships authorize this operation before taking a
    // lock on the supplied target user. Release the actor-only preflight locks
    // before the ordered multi-user transaction, then recheck everything there.
    await store.transaction(async client => {
      const who = await auth.identity(client, ctx, { verified: true });
      const member = (await client.query('SELECT role FROM saas_memberships WHERE family_id=$1 AND user_id=$2', [familyId, who.user.id])).rows[0];
      if (!member) { S.fail(403, 'FAMILY_FORBIDDEN', '无权访问此家庭'); }
      if (member.role !== 'owner') { S.fail(403, 'OWNER_REQUIRED', '仅家庭所有者可执行此操作'); }
      const target = await client.query(`SELECT 1 FROM saas_memberships m JOIN saas_users u ON u.id=m.user_id
        WHERE m.family_id=$1 AND m.user_id=$2 AND m.role='parent' AND u.verified_at IS NOT NULL`, [familyId, targetId]);
      if (!target.rowCount) { S.fail(400, 'TRANSFER_TARGET_INVALID', '请选择本家庭已验证的家长'); }
    });
    return store.transaction(async client => {
      const who = await auth.identity(client, ctx, { verified: true, userLock: true, relatedUserIds: [targetId] });
      const family = await store.family(client, who, familyId, { owner: true });
      await password(who, body.currentPassword);
      const target = (await client.query(`SELECT m.role,u.verified_at FROM saas_memberships m JOIN saas_users u ON u.id=m.user_id
        WHERE m.family_id=$1 AND m.user_id=$2 FOR UPDATE OF m`, [family.id, targetId])).rows[0];
      if (!target || target.role !== 'parent' || !target.verified_at || targetId === who.user.id) {
        S.fail(400, 'TRANSFER_TARGET_INVALID', '请选择本家庭已验证的家长');
      }
      // Satisfy the immediate unique-owner index; the deferred lower-bound
      // constraint verifies there is still one owner when this transaction ends.
      await client.query("UPDATE saas_memberships SET role='parent' WHERE family_id=$1 AND user_id=$2", [family.id, who.user.id]);
      await client.query("UPDATE saas_memberships SET role='owner' WHERE family_id=$1 AND user_id=$2", [family.id, targetId]);
      await client.query('UPDATE saas_families SET updated_at=$2 WHERE id=$1', [family.id, at()]);
      return { status: 200, body: { family: { id: family.id, name: family.name, role: 'parent' } } };
    });
  }
  async function removeFamily(ctx, familyId, body) {
    await auth.limit(ctx, 'family-delete', 20);
    return store.transaction(async client => {
      const who = await auth.identity(client, ctx, { verified: true, userLock: true });
      const family = await store.family(client, who, familyId, { owner: true });
      if (typeof body.name !== 'string' || body.name !== family.name) { S.fail(400, 'CONFIRMATION_MISMATCH', '家庭名称不匹配'); }
      await password(who, body.currentPassword);
      await client.query('DELETE FROM saas_families WHERE id=$1', [family.id]);
      return ok();
    });
  }
  async function removeAccount(ctx, body) {
    await auth.limit(ctx, 'account-delete', 20);
    return store.transaction(async client => {
      // Verified and unverified authenticated accounts can delete themselves.
      // Every owner transfer/accept/create first locks this user, so this set of
      // memberships cannot grow while we lock all its families in stable order.
      const who = await auth.identity(client, ctx, { userLock: true });
      if (typeof body.email !== 'string' || body.email.trim().toLowerCase() !== who.user.email) {
        S.fail(400, 'CONFIRMATION_MISMATCH', '邮箱不匹配');
      }
      await password(who, body.currentPassword);
      const ids = (await client.query('SELECT family_id FROM saas_memberships WHERE user_id=$1 ORDER BY family_id', [who.user.id])).rows.map(r => r.family_id);
      if (ids.length) { await client.query('SELECT id FROM saas_families WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]); }
      const owned = await client.query("SELECT 1 FROM saas_memberships WHERE user_id=$1 AND role='owner' LIMIT 1", [who.user.id]);
      if (owned.rowCount) { S.fail(409, 'ACCOUNT_OWNS_FAMILIES', '请先移交或删除自己拥有的家庭'); }
      // Email-bound incoming invitations and inviter FK updates can overlap for
      // two mutually invited accounts. Lock their union by ID before either UPDATE.
      await client.query('SELECT id FROM saas_invitations WHERE email=$1 OR invited_by=$2 ORDER BY id FOR UPDATE', [who.user.email, who.user.id]);
      await client.query(`UPDATE saas_invitations SET revoked_at=$2 WHERE email=$1 AND consumed_at IS NULL AND revoked_at IS NULL`, [who.user.email, at()]);
      // Issued invitations belong to the family and survive with inviter=NULL.
      // Sessions/tokens/memberships/challenges/grants cascade; ledger stays.
      // In-flight provider leases retain only the family until completion/TTL.
      await client.query('DELETE FROM saas_users WHERE id=$1', [who.user.id]);
      return { ...ok(), headers: { 'Set-Cookie': auth.clearCookie() } };
    });
  }
  return { rename, leave, transfer, removeFamily, removeAccount };
}
module.exports = { createLifecycle };
