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
      const who = await auth.identity(client, ctx, { verified: true });
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
    return store.transaction(async client => {
      const who = await auth.identity(client, ctx, { verified: true });
      const family = await store.family(client, who, familyId, { owner: true });
      const target = (await client.query(`SELECT m.role,u.verified_at FROM saas_memberships m JOIN saas_users u ON u.id=m.user_id
        WHERE m.family_id=$1 AND m.user_id=$2`, [family.id, targetId])).rows[0];
      if (!target || target.role !== 'parent' || !target.verified_at || targetId === who.user.id) {
        S.fail(400, 'TRANSFER_TARGET_INVALID', '请选择本家庭已验证的家长');
      }
      await password(who, body.currentPassword);
      // Satisfy the immediate unique-owner index; the deferred lower-bound
      // constraint verifies there is still one owner when this transaction ends.
      await client.query("UPDATE saas_memberships SET role='parent' WHERE family_id=$1 AND user_id=$2", [family.id, who.user.id]);
      await client.query("UPDATE saas_memberships SET role='owner' WHERE family_id=$1 AND user_id=$2", [family.id, targetId]);
      await client.query('UPDATE saas_families SET owner_user_id=$2,updated_at=$3 WHERE id=$1', [family.id, targetId, at()]);
      return { status: 200, body: { family: { id: family.id, name: family.name, role: 'parent' } } };
    });
  }
  async function removeFamily(ctx, familyId, body) {
    await auth.limit(ctx, 'family-delete', 20);
    return store.transaction(async client => {
      const who = await auth.identity(client, ctx, { verified: true });
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
      // The database transaction serializes identity, ownership checks and
      // deletion with every membership change in this application process.
      const who = await auth.identity(client, ctx);
      if (typeof body.email !== 'string' || body.email.trim().toLowerCase() !== who.user.email) {
        S.fail(400, 'CONFIRMATION_MISMATCH', '邮箱不匹配');
      }
      await password(who, body.currentPassword);
      const owned = await client.query("SELECT 1 FROM saas_memberships WHERE user_id=$1 AND role='owner' LIMIT 1", [who.user.id]);
      if (owned.rowCount) { S.fail(409, 'ACCOUNT_OWNS_FAMILIES', '请先移交或删除自己拥有的家庭'); }
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
