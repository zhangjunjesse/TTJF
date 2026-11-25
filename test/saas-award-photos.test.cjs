'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const H = require('../saas/testing.cjs');
const M = require('../model.js');
const S = require('../saas/security.cjs');
const { createDatabase } = require('../saas/sqlite.cjs');
const { createStore } = require('../saas/store.cjs');
const { MAX_PHOTO_BYTES, PHOTO_TTL_MS, decodeJpeg, dataUrl } = require('../saas/award-photos.cjs');
const { backupDatabase, restoreDatabase } = require('../tools/saas-db.cjs');

const JPEG = fs.readFileSync(path.join(__dirname, '..', 'assets', 'capybara.jpg'));
const PHOTO = dataUrl(JPEG);
const rows = database => database.query('SELECT id,action_id,uploaded_by FROM saas_award_photos ORDER BY id');
const read = (f, user, photoId, server = f.server) => H.request(server, 'POST', '/api/award-photos/read', { photoId }, user);
async function upload(f, user, value = PHOTO) {
  const result = await H.request(f.server, 'POST', '/api/award-photos', { dataUrl: value }, user);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.match(result.body.photoId, S.UUID);
  assert.equal(result.body.familyId, user.familyId); assert.equal(result.body.userId, user.userId);
  return result.body.photoId;
}
async function award(f, user, id, photoIds, revision = 2) {
  const action = { ...H.credit(id), photoIds }, grant = await H.grant(f, user, action, revision);
  const result = await H.request(f.server, 'POST', '/api/action', { revision, action, grant }, user);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return { action, result };
}
function paddedJpeg(size) {
  assert.ok(size >= JPEG.length + 4);
  let remaining = size - JPEG.length;
  const parts = [JPEG.subarray(0, 2)];
  while (remaining) {
    let bytes = Math.min(65537, remaining);
    if (remaining > bytes && remaining - bytes < 4) bytes -= 4 - (remaining - bytes);
    assert.ok(bytes >= 4);
    const comment = Buffer.alloc(bytes);
    comment[0] = 0xff; comment[1] = 0xfe; comment.writeUInt16BE(bytes - 2, 2);
    parts.push(comment); remaining -= bytes;
  }
  parts.push(JPEG.subarray(2));
  return Buffer.concat(parts);
}

test('photo uploads use authenticated family wrappers and only their route accepts the bounded larger JPEG body', async t => {
  const f = await H.fixture(t, { maintenanceIntervalMs: 0 });
  const owner = await H.family(f, await H.register(f, 'photos-upload@example.test'));
  const member = await H.invite(f, owner, await H.register(f, 'photos-upload-parent@example.test'));
  const unverified = { ...await H.register(f, 'photos-unverified@example.test', false), familyId: owner.familyId };
  assert.equal((await H.request(f.server, 'POST', '/api/award-photos', { dataUrl: PHOTO })).status, 401);
  assert.equal((await H.request(f.server, 'POST', '/api/award-photos', { dataUrl: PHOTO }, owner, { noCsrf: true })).status, 403);
  assert.equal((await H.request(f.server, 'POST', '/api/award-photos', { dataUrl: PHOTO }, owner, { origin: 'https://elsewhere.test' })).status, 403);
  assert.equal((await H.request(f.server, 'POST', '/api/award-photos', { dataUrl: PHOTO }, unverified)).body.code, 'EMAIL_UNVERIFIED');
  assert.equal((await H.request(f.server, 'GET', '/api/award-photos', undefined, owner)).status, 405);
  const largest = dataUrl(paddedJpeg(MAX_PHOTO_BYTES)), id = await upload(f, owner, largest);
  assert.equal(decodeJpeg(largest).length, MAX_PHOTO_BYTES);
  assert.equal((await f.database.query('SELECT length(data) AS bytes FROM saas_award_photos WHERE id=$1', [id])).rows[0].bytes, MAX_PHOTO_BYTES);
  const state = (await H.request(f.server, 'GET', '/api/state', undefined, owner)).body;
  assert.equal(state.revision, 1); assert.deepEqual(state.state.points, []); assert.ok(!JSON.stringify(state).includes('base64'));
  for (const user of [owner, member]) {
    const staged = await read(f, user, id);
    assert.equal(staged.status, 404); assert.equal(staged.body.dataUrl, undefined);
  }
  for (const route of ['/api/action', '/api/parent/challenge', '/api/award-photos/read']) {
    const result = await H.request(f.server, 'POST', route, { dataUrl: largest }, owner);
    assert.equal(result.status, 413, route); assert.equal(result.body.code, 'BODY_TOO_LARGE');
  }
  const tooLarge = await H.request(f.server, 'POST', '/api/award-photos', { dataUrl: dataUrl(paddedJpeg(MAX_PHOTO_BYTES + 1)) }, owner);
  assert.equal(tooLarge.status, 413); assert.equal(tooLarge.body.code, 'PHOTO_TOO_LARGE');
  const parserLimit = await H.request(f.server, 'POST', '/api/award-photos', { dataUrl: 'x'.repeat(1100000) }, owner);
  assert.equal(parserLimit.status, 413); assert.equal(parserLimit.body.code, 'BODY_TOO_LARGE');
  const bad = [PHOTO.replace('image/jpeg', 'image/png'), 'data:image/jpeg;base64,AAAA', 'data:image/jpeg;base64,/9j/2Q==',
    'data:image/jpeg;base64,' + Buffer.from('<svg></svg>').toString('base64'), PHOTO + '\n', PHOTO.slice(0, -8)];
  for (const value of bad) {
    f.clock.value += 61000;
    const rejected = await H.request(f.server, 'POST', '/api/award-photos', { dataUrl: value }, owner);
    assert.equal(rejected.status, 400, value.slice(0, 40)); assert.equal(rejected.body.code, 'PHOTO_INVALID');
  }
  assert.equal((await rows(f.database)).rowCount, 1, 'rejected uploads do not create rows');
});

test('photo ownership, grant fingerprints and idempotent award commit are atomic across real HTTP and SQLite', async t => {
  const f = await H.fixture(t, { maintenanceIntervalMs: 0 }), second = await f.start();
  const owner = await H.family(f, await H.register(f, 'photos-atomic@example.test'));
  const parent = await H.invite(f, owner, await H.register(f, 'photos-atomic-parent@example.test'));
  const other = await H.family(f, owner, '其他家庭');
  await H.setup(f, owner, 'math');
  const ids = [await upload(f, owner), await upload(f, owner), await upload(f, owner)];
  const parentId = await upload(f, parent), foreign = await upload(f, other);
  for (const photoIds of [[parentId], [foreign], [crypto.randomUUID()], [ids[0], ids[0].toUpperCase()], [...ids, parentId]]) {
    const denied = await H.request(f.server, 'POST', '/api/parent/challenge', { revision: 2, action: { ...H.credit(crypto.randomUUID()), photoIds } }, owner);
    assert.equal(denied.status, 400, JSON.stringify(denied.body));
  }
  const action = { ...H.credit('photos-atomic-award'), photoIds: [ids[2], ids[0], ids[1]] };
  const grant = await H.grant(f, owner, action), command = { revision: 2, action, grant };
  for (const photoIds of [[ids[0]], [...action.photoIds].reverse()]) {
    const changed = await H.request(f.server, 'POST', '/api/action', { ...command, action: { ...action, photoIds } }, owner);
    assert.equal(changed.status, 403); assert.equal(changed.body.code, 'GRANT_INVALID');
  }
  await f.database.exec(`CREATE TRIGGER fail_photo_commit BEFORE UPDATE OF action_id ON saas_award_photos
    WHEN NEW.id='${ids[0]}' BEGIN SELECT RAISE(ABORT,'injected photo failure'); END`);
  const failed = await H.request(f.server, 'POST', '/api/action', command, owner);
  assert.equal(failed.status, 503);
  assert.equal((await rows(f.database)).rows.filter(row => row.action_id).length, 0);
  const before = (await H.request(f.server, 'GET', '/api/state', undefined, owner)).body;
  assert.equal(before.revision, 2); assert.deepEqual(before.state.points, []);
  assert.equal((await f.database.query('SELECT 1 FROM saas_action_receipts WHERE action_id=$1', [action.id])).rowCount, 0);
  assert.equal((await f.database.query('SELECT 1 FROM saas_parent_grants WHERE token_hash=$1', [S.digest(grant)])).rowCount, 1);
  assert.equal((await read(f, owner, ids[2])).status, 404);
  await f.database.exec('DROP TRIGGER fail_photo_commit');
  const results = await Promise.all([f.server, second].map(server => H.request(server, 'POST', '/api/action', command, owner)));
  for (const result of results) { assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.revision, 3); }
  const saved = results[0].body.state;
  assert.equal(saved.points.length, 1); assert.deepEqual(saved.points[0].photoIds, action.photoIds);
  assert.equal((await rows(f.database)).rows.filter(row => row.action_id === action.id).length, 3);
  assert.ok(!JSON.stringify(saved).includes('base64'));
  const replay = await H.request(f.server, 'POST', '/api/action', { revision: 1, action }, owner);
  assert.equal(replay.status, 200); assert.deepEqual(replay.body.state, saved);
  const altered = await H.request(f.server, 'POST', '/api/action', { revision: 3, action: { ...action, photoIds: [] } }, owner);
  assert.equal(altered.status, 400); assert.equal(altered.body.code, 'ACTION_ID_REUSED');
  const reused = await H.request(f.server, 'POST', '/api/parent/challenge', { revision: 3, action: { ...H.credit('photo-reuse'), photoIds: [ids[0]] } }, owner);
  assert.equal(reused.status, 400);
  for (const user of [owner, parent]) {
    const history = await read(f, user, ids[0]);
    assert.equal(history.status, 200); assert.equal(history.body.dataUrl, PHOTO);
    assert.equal(history.body.familyId, user.familyId); assert.equal(history.body.userId, user.userId);
    assert.equal(history.headers['cache-control'], 'no-store');
  }
  const crossFamily = await read(f, other, ids[0]);
  assert.equal(crossFamily.status, 404); assert.equal(crossFamily.body.dataUrl, undefined);
  assert.equal((await H.request(f.server, 'DELETE', '/api/families/' + owner.familyId + '/members/' + parent.userId, {}, owner)).status, 200);
  const revoked = await read(f, parent, ids[0]);
  assert.equal(revoked.status, 403); assert.equal(revoked.body.dataUrl, undefined);
});

test('staged storage and expiry are bounded, while committed photos survive uploader deletion until family deletion', async t => {
  const f = await H.fixture(t, { maintenanceIntervalMs: 0 });
  const owner = await H.family(f, await H.register(f, 'photos-retention@example.test'));
  const parent = await H.invite(f, owner, await H.register(f, 'photos-retention-parent@example.test'));
  await H.setup(f, owner, 'math');
  const committed = await upload(f, parent), orphan = await upload(f, parent);
  await award(f, parent, 'parent-photo', [committed]);
  const pending = [];
  for (let i = 0; i < 12; i++) pending.push(await upload(f, owner));
  f.clock.value += 61000;
  const capped = await H.request(f.server, 'POST', '/api/award-photos', { dataUrl: PHOTO }, owner);
  assert.equal(capped.status, 429); assert.equal(capped.body.code, 'PHOTO_UPLOAD_LIMIT');
  const action = { ...H.credit('photo-expires-before-commit'), photoIds: [pending[0]] };
  const authorization = await H.grant(f, owner, action, 3);
  await f.database.query('UPDATE saas_award_photos SET expires_at=$2 WHERE id=$1', [pending[0], new Date(f.clock.value)]);
  const expired = await H.request(f.server, 'POST', '/api/action', { revision: 3, action, grant: authorization }, owner);
  assert.equal(expired.status, 400); assert.equal(expired.body.code, 'PHOTO_UNAVAILABLE');
  assert.equal((await H.request(f.server, 'GET', '/api/state', undefined, owner)).body.revision, 3);
  assert.equal((await H.request(f.server, 'POST', '/api/auth/delete-account', { email: parent.email, currentPassword: H.PASSWORD }, parent)).status, 200);
  const deletedUploader = (await f.database.query('SELECT uploaded_by FROM saas_award_photos WHERE id=$1', [committed])).rows[0];
  assert.equal(deletedUploader.uploaded_by, null);
  assert.equal((await read(f, owner, committed)).body.dataUrl, PHOTO);
  assert.equal((await read(f, parent, committed)).status, 401);
  const first = await f.server.ops.cleanupExpired({ batchSize: 1 });
  assert.equal(first.deleted.awardPhotos, 1);
  const second = await f.server.ops.cleanupExpired({ batchSize: 1 });
  assert.equal(second.deleted.awardPhotos, 1);
  assert.equal((await f.database.query('SELECT 1 FROM saas_award_photos WHERE id=$1', [orphan])).rowCount, 0);
  f.clock.value += PHOTO_TTL_MS + 1;
  for (let i = 0; i < 6; i++) await f.server.ops.cleanupExpired({ batchSize: 2 });
  assert.deepEqual((await rows(f.database)).rows.map(row => row.id), [committed]);
  assert.equal((await read(f, owner, committed)).body.dataUrl, PHOTO, 'committed photos have no staging TTL');
  const removed = await H.request(f.server, 'DELETE', '/api/families/' + owner.familyId, { name: '测试家庭', currentPassword: H.PASSWORD }, owner);
  assert.equal(removed.status, 200); assert.equal((await rows(f.database)).rowCount, 0);
  assert.equal((await f.database.query('PRAGMA foreign_key_check')).rowCount, 0);
});

test('whole SQLite backup restores photo bytes and idempotent receipts, but discards unfinished uploads', async t => {
  const f = await H.fixture(t, { maintenanceIntervalMs: 0 });
  const owner = await H.family(f, await H.register(f, 'photos-backup@example.test'));
  await H.setup(f, owner, 'math');
  const photoId = await upload(f, owner), stagedId = await upload(f, owner);
  assert.equal((await H.request(f.server, 'POST', '/api/parent/device', { enabled: true, credential: H.PASSWORD }, owner)).status, 200);
  await f.database.query('INSERT INTO saas_award_photo_discards(family_id,id,uploaded_by,expires_at) VALUES($1,$2,$3,$4)',
    [owner.familyId, crypto.randomUUID(), owner.userId, new Date(f.clock.value + PHOTO_TTL_MS)]);
  const { action, result } = await award(f, owner, 'backed-up-photo', [photoId]);
  const directory = path.dirname(f.databasePath), source = path.join(directory, 'photos-backup.sqlite'), output = path.join(directory, 'photos-restored.sqlite');
  await backupDatabase({ databasePath: f.databasePath, output: source });
  const sourceBytes = fs.readFileSync(source);
  await f.server.closeSaas();
  await restoreDatabase({ source, output, appStopped: true });
  assert.deepEqual(fs.readFileSync(source), sourceBytes);
  const database = await createDatabase({ databasePath: output, mustExist: true });
  try {
    assert.equal((await database.query('SELECT 1 FROM saas_award_photos WHERE id=$1', [stagedId])).rowCount, 0);
    for (const table of ['saas_award_photo_discards', 'saas_parent_devices', 'saas_sessions']) assert.equal((await database.query('SELECT count(*) AS n FROM ' + table)).rows[0].n, 0, table);
    const server = await f.start({ database });
    assert.equal((await read(f, owner, photoId, server)).status, 401);
    const fresh = { ...await H.login(f, owner.email, H.PASSWORD, server), familyId: owner.familyId };
    assert.equal((await read(f, fresh, photoId, server)).body.dataUrl, PHOTO);
    const replay = await H.request(server, 'POST', '/api/action', { revision: 1, action }, fresh);
    assert.equal(replay.status, 200); assert.deepEqual(replay.body.state, result.body.state); assert.equal(replay.body.revision, 3);
    await server.closeSaas();
  } finally { await database.close(); }
});

test('supported older SQLite snapshots upgrade only their restored copy and keep real family ledger values', async t => {
  const f = await H.fixture(t, { maintenanceIntervalMs: 0 }), directory = path.dirname(f.databasePath);
  await f.server.closeSaas();
  for (const version of [1, 2, 3, 4]) {
    const source = path.join(directory, 'old-v' + version + '.sqlite'), output = path.join(directory, 'restored-v' + version + '.sqlite');
    const raw = new DatabaseSync(source), userId = crypto.randomUUID(), familyId = crypto.randomUUID();
    for (const migration of ['001-initial.sql', '002-lifecycle.sql', '003-assistant-chat.sql', '004-parent-devices.sql'].slice(0, version)) {
      raw.exec(fs.readFileSync(path.join(__dirname, '..', 'saas', 'migrations', migration), 'utf8'));
    }
    const at = new Date(f.clock.value).toISOString(), state = M.apply(M.createEmptyFamily({ childName: '旧账本' }, at), H.credit('before-photo-feature', 9), at);
    raw.exec('BEGIN');
    raw.prepare('INSERT INTO saas_users(id,email,password_hash,verified_at,created_at) VALUES(?,?,?,?,?)').run(userId, 'old-v' + version + '@example.test', '{}', at, at);
    raw.prepare('INSERT INTO saas_families(id,name,state,owner_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(familyId, '旧家庭', JSON.stringify(state), userId, at, at);
    raw.prepare("INSERT INTO saas_memberships(family_id,user_id,role,created_at) VALUES(?,?,'owner',?)").run(familyId, userId, at);
    const sessionHash = S.digest('old-v' + version + '-session');
    raw.prepare('INSERT INTO saas_sessions(token_hash,user_id,csrf_hash,created_at,expires_at) VALUES(?,?,?,?,?)')
      .run(sessionHash, userId, S.digest('old-csrf'), at, new Date(f.clock.value + 3600000).toISOString());
    if (version === 4) raw.prepare('INSERT INTO saas_parent_devices(session_hash,family_id,user_id,created_at) VALUES(?,?,?,?)').run(sessionHash, familyId, userId, at);
    raw.exec('COMMIT'); raw.close();
    const bytes = fs.readFileSync(source);
    await restoreDatabase({ source, output, appStopped: true });
    assert.deepEqual(fs.readFileSync(source), bytes, 'old source v' + version + ' stays byte-identical');
    const restored = await createStore({ databasePath: output, migrate: false });
    try {
      assert.deepEqual((await restored.database.query('SELECT version FROM saas_schema_migrations ORDER BY version')).rows.map(row => row.version), [1, 2, 3, 4, 5]);
      assert.deepEqual((await restored.database.query('SELECT state FROM saas_families WHERE id=$1', [familyId])).rows[0].state, state);
      assert.equal((await rows(restored.database)).rowCount, 0);
      for (const table of ['saas_sessions', 'saas_parent_devices', 'saas_award_photo_discards']) assert.equal((await restored.database.query('SELECT count(*) AS n FROM ' + table)).rows[0].n, 0, table);
    } finally { await restored.close(); }
  }
});

test('edited assistant award keeps photos across first PIN resume and binds them to the final authorized receipt', async t => {
  const f = await H.fixture(t, { maintenanceIntervalMs: 0, assistantService: {
    status: () => ({ mode: 'local', label: '测试助手' }), interpret: async () => ({ kind: 'clarify', question: '请补充' }),
    chat: async () => ({ kind: 'action', title: '确认加分', summary: '阅读', action: { type: 'points.add', payload: { name: '阅读', points: 5, reason: '' } } })
  } });
  const owner = await H.family(f, await H.register(f, 'photos-assistant@example.test'));
  const initial = await H.request(f.server, 'POST', '/api/assistant/chat/read', {}, owner);
  const turn = await H.request(f.server, 'POST', '/api/assistant/chat/turn', { generation: initial.body.generation, turnId: crypto.randomUUID(), text: '阅读加5分' }, owner);
  assert.equal(turn.status, 200, JSON.stringify(turn.body));
  const draft = turn.body.draft, entry = draft.actions[0], photoId = await upload(f, owner), otherId = await upload(f, owner);
  const action = { id: entry.actionId, type: entry.type, ...draft.result.action.payload, photoIds: [photoId] };
  const assistantDraft = { generation: draft.generation, turnId: draft.turnId };
  const first = await H.request(f.server, 'POST', '/api/action', { revision: 1, action, assistantDraft }, owner);
  assert.equal(first.body.code, 'PARENT_SETUP_REQUIRED');
  const setup = { revision: 1, action: { id: crypto.randomUUID(), type: 'parent.setup', method: 'pin', pin: H.PIN, confirmPin: H.PIN },
    assistantResume: { ...assistantDraft, actionId: action.id, type: action.type } };
  for (let i = 0; i < 2; i++) {
    const resumed = await H.request(f.server, 'POST', '/api/action', setup, owner);
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body)); assert.equal(resumed.body.assistantResume.sourceRevision, 2);
  }
  const body = { revision: 2, action, assistantDraft };
  const challenge = await H.request(f.server, 'POST', '/api/parent/challenge', body, owner);
  assert.equal(challenge.status, 200, JSON.stringify(challenge.body));
  const verified = await H.request(f.server, 'POST', '/api/parent/verify', { challengeId: challenge.body.challengeId, answer: H.PIN }, owner);
  assert.equal(verified.status, 200);
  const changed = await H.request(f.server, 'POST', '/api/action', { ...body, action: { ...action, photoIds: [otherId] }, grant: verified.body.grant }, owner);
  assert.equal(changed.body.code, 'GRANT_INVALID');
  const committed = await H.request(f.server, 'POST', '/api/action', { ...body, grant: verified.body.grant }, owner);
  assert.equal(committed.status, 200, JSON.stringify(committed.body)); assert.deepEqual(committed.body.state.points[0].photoIds, [photoId]);
  const history = await H.request(f.server, 'POST', '/api/assistant/chat/read', {}, owner);
  assert.deepEqual(history.body.messages.at(-1).result.action.payload.photoIds, [photoId]);
  assert.equal((await read(f, owner, photoId)).body.dataUrl, PHOTO); assert.equal((await read(f, owner, otherId)).status, 404);
  const replay = await H.request(f.server, 'POST', '/api/action', body, owner);
  assert.equal(replay.status, 200); assert.equal(replay.body.state.points.length, 1);
});
