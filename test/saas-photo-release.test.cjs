'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const H = require('../saas/testing.cjs');
const S = require('../saas/security.cjs');
const { dataUrl, PHOTO_TTL_MS } = require('../saas/award-photos.cjs');

const JPEG = fs.readFileSync(path.join(__dirname, '..', 'assets', 'capybara.jpg'));
const PHOTO = dataUrl(JPEG);
const discard = (f, user, photoIds, options) => H.request(f.server, 'POST', '/api/award-photos/discard', { photoIds }, user, options);
const stage = (f, user, photoId, value = PHOTO, server = f.server) => H.request(server, 'POST', '/api/award-photos',
  { dataUrl: value, ...(photoId === undefined ? {} : { photoId }) }, user);
async function upload(f, user, photoId) {
  const response = await stage(f, user, photoId);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.match(response.body.photoId, S.UUID);
  return response.body.photoId;
}
async function pending(f, user) {
  return (await f.database.query(`SELECT id,uploaded_by FROM saas_award_photos
    WHERE family_id=$1 AND action_id IS NULL ORDER BY id`, [user.familyId])).rows;
}
async function markers(f) {
  return (await f.database.query('SELECT family_id,id,uploaded_by,expires_at FROM saas_award_photo_discards ORDER BY id')).rows;
}
async function enable(f, user) {
  const response = await H.request(f.server, 'POST', '/api/parent/device', { enabled: true, credential: H.PIN }, user);
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

test('discard validates the whole list and releases only the authenticated uploader pending photos', async t => {
  const f = await H.fixture(t, { maintenanceIntervalMs: 0 });
  const owner = await H.family(f, await H.register(f, 'release-owner@example.test'));
  const member = await H.invite(f, owner, await H.register(f, 'release-member@example.test'));
  const other = await H.family(f, owner, '另一个家庭');
  const outsider = { ...await H.register(f, 'release-outsider@example.test'), familyId: owner.familyId };
  await H.setup(f, owner, 'math');
  const committed = await upload(f, owner), own = await upload(f, owner);
  const memberPhoto = await upload(f, member), otherPhoto = await upload(f, other);
  const action = { ...H.credit('release-committed'), photoIds: [committed] };
  const grant = await H.grant(f, owner, action);
  assert.equal((await H.request(f.server, 'POST', '/api/action', { revision: 2, action, grant }, owner)).status, 200);
  const before = (await H.request(f.server, 'GET', '/api/state', undefined, owner)).body;
  for (const [actor, options, status] of [[null, {}, 401], [owner, { noCsrf: true }, 403], [owner, { noOrigin: true }, 403],
    [owner, { origin: 'https://elsewhere.test' }, 403], [outsider, {}, 403], [{ ...owner, familyId: undefined }, {}, 400]]) {
    const denied = await discard(f, actor, [own], options);
    assert.equal(denied.status, status, JSON.stringify(denied.body));
  }
  assert.equal((await H.request(f.server, 'GET', '/api/award-photos/discard', undefined, owner)).status, 405);
  await f.database.query('UPDATE saas_users SET verified_at=NULL WHERE id=$1', [owner.userId]);
  assert.equal((await discard(f, owner, [own])).body.code, 'EMAIL_UNVERIFIED');
  await f.database.query('UPDATE saas_users SET verified_at=$2 WHERE id=$1', [owner.userId, new Date(f.clock.value)]);
  for (const body of [{}, { photoIds: own }, { photoIds: [own, 'invalid'] }, { photoIds: [own], familyId: other.familyId },
    { photoIds: Array.from({ length: 13 }, () => crypto.randomUUID()) }]) {
    const rejected = await H.request(f.server, 'POST', '/api/award-photos/discard', body, owner);
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal((await pending(f, owner)).length, 2, 'invalid requests cannot partially release valid IDs');
    assert.equal((await markers(f)).length, 0, 'invalid requests cannot leave cancellation markers');
  }
  assert.equal((await discard(f, other, [own])).status, 200);
  assert.equal((await pending(f, owner)).length, 2, 'a family switch cannot release another family upload');
  const unknown = crypto.randomUUID();
  const released = await discard(f, owner, [own.toUpperCase(), own, memberPhoto, otherPhoto, committed, unknown]);
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.deepEqual(released.body, { ok: true, familyId: owner.familyId, userId: owner.userId });
  assert.equal((await discard(f, owner, [own, memberPhoto, committed, unknown])).status, 200);
  assert.deepEqual((await pending(f, owner)).map(row => row.id), [memberPhoto]);
  assert.deepEqual((await pending(f, other)).map(row => row.id), [otherPhoto]);
  const history = await H.request(f.server, 'POST', '/api/award-photos/read', { photoId: committed }, member);
  assert.equal(history.status, 200); assert.equal(history.body.dataUrl, PHOTO);
  assert.deepEqual((await H.request(f.server, 'GET', '/api/state', undefined, owner)).body, before);
  const ownMarkers = (await markers(f)).filter(row => row.family_id === owner.familyId);
  assert.deepEqual(ownMarkers.map(row => row.id).sort(), [own, unknown, otherPhoto].sort(), 'same-family foreign and committed IDs do not get caller markers');
  assert.equal((await H.request(f.server, 'DELETE', '/api/families/' + owner.familyId + '/members/' + member.userId, {}, owner)).status, 200);
  assert.equal((await discard(f, member, [memberPhoto])).body.code, 'FAMILY_FORBIDDEN');
  assert.deepEqual((await pending(f, owner)).map(row => row.id), [memberPhoto]);
});

test('discard restores real SQL uploader and family quotas immediately', async t => {
  const f = await H.fixture(t, { maintenanceIntervalMs: 0 });
  const owner = await H.family(f, await H.register(f, 'release-quota-owner@example.test'));
  const members = [];
  for (let i = 0; i < 3; i++) members.push(await H.invite(f, owner, await H.register(f, 'release-quota-' + i + '@example.test')));
  const ids = [];
  for (const actor of [owner, ...members.slice(0, 2)]) {
    f.clock.value += 61000;
    for (let i = 0; i < 12; i++) ids.push(await upload(f, actor));
  }
  f.clock.value += 61000;
  const ownCap = await stage(f, owner);
  assert.equal(ownCap.status, 429); assert.equal(ownCap.body.code, 'PHOTO_UPLOAD_LIMIT');
  const familyCap = await stage(f, members[2]);
  assert.equal(familyCap.status, 429); assert.equal(familyCap.body.code, 'PHOTO_UPLOAD_LIMIT');
  assert.equal((await pending(f, owner)).length, 36);
  assert.equal((await discard(f, owner, ids.slice(0, 3))).status, 200);
  assert.equal((await pending(f, owner)).length, 33);
  for (let i = 0; i < 3; i++) await upload(f, owner);
  assert.equal((await pending(f, owner)).length, 36);
  assert.equal((await pending(f, owner)).filter(row => row.uploaded_by === owner.userId).length, 12);
  assert.equal((await discard(f, members[0], ids.slice(12, 15))).status, 200);
  for (let i = 0; i < 3; i++) await upload(f, members[2]);
  assert.equal((await pending(f, owner)).length, 36);
  assert.equal((await pending(f, owner)).filter(row => row.uploaded_by === members[2].userId).length, 3);
  assert.equal((await f.database.query('SELECT count(*) AS n FROM saas_award_photos WHERE id IN ($1,$2,$3)', ids.slice(0, 3))).rows[0].n, 0);
});

test('client photo IDs recover lost upload responses without occupying more quota or overwriting images', async t => {
  const f = await H.fixture(t, { maintenanceIntervalMs: 0 }), second = await f.start();
  const owner = await H.family(f, await H.register(f, 'release-retry-owner@example.test'));
  const member = await H.invite(f, owner, await H.register(f, 'release-retry-member@example.test'));
  const photoId = crypto.randomUUID(), original = await stage(f, owner, photoId.toUpperCase());
  assert.equal(original.status, 200, JSON.stringify(original.body)); assert.equal(original.body.photoId, photoId);
  const before = (await f.database.query('SELECT data,created_at,expires_at FROM saas_award_photos WHERE id=$1', [photoId])).rows[0];
  for (let i = 0; i < 11; i++) await upload(f, owner);
  for (const server of [f.server, second]) {
    const replay = await stage(f, owner, photoId, PHOTO, server);
    assert.equal(replay.status, 200, JSON.stringify(replay.body)); assert.equal(replay.body.photoId, photoId);
  }
  assert.equal((await pending(f, owner)).length, 12, 'response-lost retries bypass full storage and new-upload rate caps');
  const changedJpeg = Buffer.concat([JPEG.subarray(0, 2), Buffer.from([0xff, 0xfe, 0x00, 0x03, 0x78]), JPEG.subarray(2)]);
  for (const [actor, value] of [[owner, dataUrl(changedJpeg)], [member, PHOTO]]) {
    const reused = await stage(f, actor, photoId, value);
    assert.equal(reused.status, 409); assert.equal(reused.body.code, 'PHOTO_ID_REUSED');
  }
  assert.deepEqual((await f.database.query('SELECT data,created_at,expires_at FROM saas_award_photos WHERE id=$1', [photoId])).rows[0], before);
  const concurrentId = crypto.randomUUID();
  f.clock.value += 61000;
  await discard(f, owner, [photoId]);
  const concurrent = await Promise.all([f.server, second].map(server => stage(f, owner, concurrentId, PHOTO, server)));
  assert.ok(concurrent.every(response => response.status === 200));
  assert.equal((await pending(f, owner)).length, 12);
  assert.equal((await f.database.query('SELECT count(*) AS n FROM saas_award_photos WHERE id=$1', [concurrentId])).rows[0].n, 1);
  const tombstoned = await stage(f, owner, photoId);
  assert.equal(tombstoned.status, 410); assert.equal(tombstoned.body.code, 'PHOTO_DISCARDED');
});

test('new cancellation markers are rate bounded while idempotent discard retries stay available', async t => {
  const f = await H.fixture(t, { maintenanceIntervalMs: 0 });
  const owner = await H.family(f, await H.register(f, 'release-marker-limit@example.test'));
  const photoId = await upload(f, owner), ids = Array.from({ length: 60 }, () => crypto.randomUUID());
  for (let i = 0; i < ids.length; i += 12) assert.equal((await discard(f, owner, ids.slice(i, i + 12))).status, 200);
  const before = await markers(f);
  assert.equal(before.length, 60);
  f.clock.value += 1000;
  assert.equal((await discard(f, owner, ids.slice(0, 12))).status, 200);
  assert.deepEqual(await markers(f), before, 'retrying an acknowledged discard does not extend marker retention');
  const denied = await discard(f, owner, [photoId, crypto.randomUUID()]);
  assert.equal(denied.status, 429); assert.equal(denied.body.code, 'RATE_LIMITED');
  assert.ok(+denied.headers['retry-after'] > 0);
  assert.equal((await markers(f)).length, 60);
  assert.deepEqual((await pending(f, owner)).map(row => row.id), [photoId], 'a rejected batch never partially releases photos');
  f.clock.value += 60000;
  assert.equal((await discard(f, owner, [photoId])).status, 200);
  assert.equal((await pending(f, owner)).length, 0); assert.equal((await markers(f)).length, 61);
});

test('upload retries have a bounded request allowance while new uploads retain the original rate limit', async t => {
  const f = await H.fixture(t, { maintenanceIntervalMs: 0 });
  const owner = await H.family(f, await H.register(f, 'release-upload-rates@example.test'));
  const kept = await upload(f, owner);
  for (let i = 1; i < 12; i++) {
    const photoId = await upload(f, owner);
    assert.equal((await discard(f, owner, [photoId])).status, 200);
  }
  const newUpload = await stage(f, owner);
  assert.equal(newUpload.status, 429); assert.equal(newUpload.body.code, 'RATE_LIMITED');
  assert.deepEqual((await pending(f, owner)).map(row => row.id), [kept], 'free slots do not bypass the new-upload rate limit');
  for (let i = 13; i < 72; i++) assert.equal((await stage(f, owner, kept)).status, 200);
  const replay = await stage(f, owner, kept);
  assert.equal(replay.status, 429); assert.equal(replay.body.code, 'RATE_LIMITED');
  assert.deepEqual((await pending(f, owner)).map(row => row.id), [kept]);
});

test('cancellation cleanup uses row identity across families and membership removal drops only its own markers', async t => {
  const f = await H.fixture(t, { maintenanceIntervalMs: 0 });
  const owner = await H.family(f, await H.register(f, 'release-marker-scope@example.test'));
  const other = await H.family(f, owner, '另一个家庭');
  const member = await H.invite(f, owner, await H.register(f, 'release-marker-parent@example.test'));
  const id = crypto.randomUUID();
  for (const actor of [owner, other, member]) assert.equal((await discard(f, actor, [id])).status, 200);
  await f.database.query('UPDATE saas_award_photo_discards SET expires_at=$3 WHERE family_id=$1 AND uploaded_by=$2', [other.familyId, other.userId, new Date(f.clock.value - 1)]);
  const cleaned = await f.server.ops.cleanupExpired({ batchSize: 1 });
  assert.equal(cleaned.deleted.awardPhotoDiscards, 1);
  assert.equal((await markers(f)).length, 2, 'an expired family row cannot delete another row with the same photo ID');
  assert.ok((await markers(f)).every(row => row.family_id === owner.familyId));
  assert.equal((await H.request(f.server, 'DELETE', '/api/families/' + owner.familyId + '/members/' + member.userId, {}, owner)).status, 200);
  const kept = await markers(f);
  assert.equal(kept.length, 1); assert.equal(kept[0].uploaded_by, owner.userId);
  assert.equal((await H.request(f.server, 'DELETE', '/api/families/' + owner.familyId, { name: '测试家庭', currentPassword: H.PASSWORD }, owner)).status, 200);
  assert.equal((await markers(f)).length, 0);
  assert.equal((await f.database.query('PRAGMA foreign_key_check')).rowCount, 0);
});

test('discard arriving before a delayed upload or late retry prevents cancelled photos from reappearing', async t => {
  const f = await H.fixture(t, { maintenanceIntervalMs: 0 });
  const owner = await H.family(f, await H.register(f, 'release-late-owner@example.test'));
  const member = await H.invite(f, owner, await H.register(f, 'release-late-member@example.test'));
  const photoId = crypto.randomUUID(), body = JSON.stringify({ photoId, dataUrl: PHOTO });
  let request;
  const late = new Promise((resolve, reject) => {
    request = http.request({ host: '127.0.0.1', port: f.server.address().port, path: '/api/award-photos', method: 'POST', agent: false,
      headers: { Cookie: owner.cookie, Origin: H.ORIGIN, 'X-CSRF-Token': owner.csrfToken, 'X-Family-ID': owner.familyId,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    request.on('error', reject); request.setTimeout(10000, () => request.destroy(new Error('delayed upload timed out')));
  });
  t.after(() => request.destroy());
  request.write(body.slice(0, -1));
  assert.equal((await discard(f, owner, [photoId])).status, 200);
  request.end(body.slice(-1));
  const finished = await late;
  assert.equal(finished.status, 410, JSON.stringify(finished.body)); assert.equal(finished.body.code, 'PHOTO_DISCARDED');
  for (let i = 0; i < 2; i++) {
    const retry = await stage(f, owner, photoId);
    assert.equal(retry.status, 410); assert.equal(retry.body.code, 'PHOTO_DISCARDED');
    assert.equal((await discard(f, owner, [photoId])).status, 200);
  }
  assert.equal((await pending(f, owner)).length, 0);
  assert.equal((await markers(f)).length, 1);
  const marker = (await markers(f))[0];
  assert.equal(marker.uploaded_by, owner.userId); assert.equal(+marker.expires_at, f.clock.value + PHOTO_TTL_MS);
  const memberUpload = await stage(f, member, photoId);
  assert.equal(memberUpload.status, 200, 'a caller cancellation cannot reserve another uploader photo ID');
  const next = await upload(f, owner);
  assert.notEqual(next, photoId);
  const untouched = await f.server.ops.cleanupExpired({ batchSize: 1 });
  assert.equal(untouched.deleted.awardPhotoDiscards, 0);
  f.clock.value += PHOTO_TTL_MS + 1;
  const expired = await f.server.ops.cleanupExpired({ batchSize: 1 });
  assert.equal(expired.deleted.awardPhotoDiscards, 1); assert.equal((await markers(f)).length, 0);
});

test('discard and photo awards roll back together on SQL failure and preserve explicit grants on trusted devices', async t => {
  const f = await H.fixture(t, { maintenanceIntervalMs: 0 });
  const owner = await H.family(f, await H.register(f, 'release-atomic-owner@example.test'));
  const member = await H.invite(f, owner, await H.register(f, 'release-atomic-member@example.test'));
  await H.setup(f, owner); await enable(f, owner);
  const first = await upload(f, owner), second = await upload(f, owner), memberPhoto = await upload(f, member);
  await f.database.exec(`CREATE TRIGGER fail_photo_release BEFORE DELETE ON saas_award_photos
    WHEN OLD.id='${second}' BEGIN SELECT RAISE(ABORT,'injected discard failure'); END`);
  const failure = await discard(f, owner, [first, second]);
  assert.equal(failure.status, 503); assert.equal((await pending(f, owner)).length, 3); assert.equal((await markers(f)).length, 0);
  await f.database.exec('DROP TRIGGER fail_photo_release');
  const action = { ...H.credit('release-device-award'), photoIds: [first, second] };
  const grant = await H.grant(f, owner, action);
  const wrongGrant = await H.request(f.server, 'POST', '/api/action', { revision: 2, action: { ...action, photoIds: [first] }, grant }, owner);
  assert.equal(wrongGrant.status, 403); assert.equal(wrongGrant.body.code, 'GRANT_INVALID');
  const foreign = await H.request(f.server, 'POST', '/api/action', { revision: 2, action: { ...H.credit('release-foreign'), photoIds: [memberPhoto] } }, owner);
  assert.equal(foreign.status, 400); assert.equal(foreign.body.code, 'PHOTO_UNAVAILABLE');
  await f.database.exec(`CREATE TRIGGER fail_device_photo_commit BEFORE UPDATE OF action_id ON saas_award_photos
    WHEN NEW.id='${second}' BEGIN SELECT RAISE(ABORT,'injected photo commit failure'); END`);
  const failedAward = await H.request(f.server, 'POST', '/api/action', { revision: 2, action, grant }, owner);
  assert.equal(failedAward.status, 503);
  assert.equal((await f.database.query('SELECT count(*) AS n FROM saas_award_photos WHERE action_id IS NOT NULL')).rows[0].n, 0);
  assert.equal((await f.database.query('SELECT count(*) AS n FROM saas_action_receipts WHERE action_id=$1', [action.id])).rows[0].n, 0);
  assert.equal((await f.database.query('SELECT count(*) AS n FROM saas_parent_grants WHERE token_hash=$1', [S.digest(grant)])).rows[0].n, 1);
  assert.equal((await H.request(f.server, 'GET', '/api/state', undefined, owner)).body.revision, 2);
  await f.database.exec('DROP TRIGGER fail_device_photo_commit');
  const saved = await H.request(f.server, 'POST', '/api/action', { revision: 2, action, grant }, owner);
  assert.equal(saved.status, 200); assert.deepEqual(saved.body.state.points[0].photoIds, [first, second]);
  assert.equal((await discard(f, owner, [first, second])).status, 200);
  assert.equal((await markers(f)).length, 0, 'committed photos never get cancellation markers');
  const replay = await H.request(f.server, 'POST', '/api/action', { revision: 1, action }, owner);
  assert.equal(replay.status, 200); assert.equal(replay.body.state.points.length, 1);
  assert.equal((await stage(f, owner, first)).body.code, 'PHOTO_ID_REUSED');
  const withoutGrant = { ...H.credit('release-device-no-grant'), photoIds: [await upload(f, owner)] };
  const direct = await H.request(f.server, 'POST', '/api/action', { revision: 3, action: withoutGrant }, owner);
  assert.equal(direct.status, 200); assert.equal(direct.body.state.points.length, 2);
  assert.equal((await H.request(f.server, 'POST', '/api/parent/device', { enabled: false }, owner)).status, 200);
  const blocked = { ...H.credit('release-device-revoked'), photoIds: [await upload(f, owner)] };
  const denied = await H.request(f.server, 'POST', '/api/action', { revision: 4, action: blocked }, owner);
  assert.equal(denied.body.code, 'PARENT_REQUIRED');
  const staleGrant = await H.grant(f, owner, blocked, 4);
  assert.equal((await discard(f, owner, blocked.photoIds)).status, 200, 'discard needs membership and CSRF rather than a parent grant');
  const removedBeforeAward = await H.request(f.server, 'POST', '/api/action', { revision: 4, action: blocked, grant: staleGrant }, owner);
  assert.equal(removedBeforeAward.body.code, 'PHOTO_UNAVAILABLE');
  assert.equal((await f.database.query('SELECT count(*) AS n FROM saas_parent_grants WHERE token_hash=$1', [S.digest(staleGrant)])).rows[0].n, 1);
  assert.equal((await H.request(f.server, 'GET', '/api/state', undefined, owner)).body.revision, 4);
  assert.equal((await f.database.query('PRAGMA foreign_key_check')).rowCount, 0);
});
