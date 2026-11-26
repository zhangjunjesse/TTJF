'use strict';
const crypto = require('node:crypto');
const S = require('./security.cjs');

const MAX_PHOTO_BYTES = 768 * 1024;
const MAX_UPLOAD_JSON_BYTES = Math.ceil(MAX_PHOTO_BYTES / 3) * 4 + 4096;
const PHOTO_TTL_MS = 24 * 60 * 60 * 1000;
const PREFIX = 'data:image/jpeg;base64,';

function invalidPhoto() { S.fail(400, 'PHOTO_INVALID', '请选择有效的JPEG照片'); }
// Check JPEG structure and dimensions without loading an unbounded image into
// an image decoder. The browser has already resized and re-encoded the photo.
function validateJpeg(data) {
  if (data.length < 16 || data[0] !== 0xff || data[1] !== 0xd8) invalidPhoto();
  let offset = 2, framed = false, scanned = false;
  while (offset < data.length) {
    if (data[offset++] !== 0xff) invalidPhoto();
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === 0xd9) {
      if (!framed || !scanned || offset !== data.length) invalidPhoto();
      return;
    }
    if (marker === undefined || marker === 0 || marker === 0xd8 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > data.length) invalidPhoto();
    const length = data.readUInt16BE(offset), end = offset + length;
    if (length < 2 || end > data.length) invalidPhoto();
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (framed || ![0xc0, 0xc1, 0xc2].includes(marker) || length < 8 || data[offset + 2] !== 8) invalidPhoto();
      const height = data.readUInt16BE(offset + 3), width = data.readUInt16BE(offset + 5), components = data[offset + 7];
      if (!height || !width || height > 4096 || width > 4096 || ![1, 3, 4].includes(components) || length !== 8 + 3 * components) invalidPhoto();
      framed = true;
    }
    if (marker === 0xda) {
      const components = data[offset + 2];
      if (!framed || !components || components > 4 || length !== 6 + 2 * components || end >= data.length) invalidPhoto();
      scanned = true;
      offset = end;
      // Skip entropy data, stuffed FF bytes and restart markers. A later scan
      // or the final EOI is processed by the outer marker loop.
      while (offset < data.length) {
        if (data[offset] !== 0xff) { offset++; continue; }
        let next = offset + 1;
        while (data[next] === 0xff) next++;
        if (data[next] === 0 || (data[next] >= 0xd0 && data[next] <= 0xd7)) { offset = next + 1; continue; }
        break;
      }
    } else offset = end;
  }
  invalidPhoto();
}
function decodeJpeg(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PREFIX)) invalidPhoto();
  const encoded = dataUrl.slice(PREFIX.length);
  if (encoded.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4) S.fail(413, 'PHOTO_TOO_LARGE', '每张照片压缩后须小于768KB');
  if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) invalidPhoto();
  const data = Buffer.from(encoded, 'base64');
  if (data.length > MAX_PHOTO_BYTES) S.fail(413, 'PHOTO_TOO_LARGE', '每张照片压缩后须小于768KB');
  if (data.toString('base64') !== encoded) invalidPhoto();
  validateJpeg(data);
  return data;
}
function dataUrl(data) { return PREFIX + Buffer.from(data).toString('base64'); }

function createAwardPhotos({ run, at, rate }) {
  async function upload(ctx, body) {
    return run(ctx, async (client, who, family) => {
      await rate(client, who, family, 'award-photo-request', 72);
      if (Object.keys(body).some(key => !['dataUrl', 'photoId'].includes(key)) ||
          (S.own(body, 'photoId') && (typeof body.photoId !== 'string' || !S.UUID.test(body.photoId)))) invalidPhoto();
      const photoId = S.own(body, 'photoId') ? body.photoId.toLowerCase() : crypto.randomUUID(), sampled = at();
      const discarded = (await client.query(`SELECT 1 FROM saas_award_photo_discards
        WHERE family_id=$1 AND id=$2 AND uploaded_by=$3 AND expires_at>$4`, [family.id, photoId, who.user.id, sampled])).rows[0];
      if (discarded) S.fail(410, 'PHOTO_DISCARDED', '照片已移除，请重新选择');
      const data = decodeJpeg(body.dataUrl);
      const prior = (await client.query('SELECT uploaded_by,data,action_id,expires_at FROM saas_award_photos WHERE family_id=$1 AND id=$2', [family.id, photoId])).rows[0];
      if (prior) {
        if (prior.uploaded_by?.toLowerCase() !== who.user.id.toLowerCase() || prior.action_id !== null || !data.equals(Buffer.from(prior.data))) {
          S.fail(409, 'PHOTO_ID_REUSED', '照片编号已使用，请重新选择');
        }
        if (+prior.expires_at <= +sampled) S.fail(410, 'PHOTO_UNAVAILABLE', '照片已过期，请重新选择');
        return { status: 200, body: { photoId } };
      }
      // Replaying a lost upload response does not consume a new staging slot or
      // the existing new-upload allowance. The request rate above still bounds it.
      await rate(client, who, family, 'award-photo-upload', 12);
      await client.query('DELETE FROM saas_award_photos WHERE family_id=$1 AND action_id IS NULL AND (expires_at<=$2 OR uploaded_by IS NULL)', [family.id, sampled]);
      const pending = (await client.query(`SELECT count(*) AS total,
        count(CASE WHEN uploaded_by=$2 THEN 1 END) AS own FROM saas_award_photos WHERE family_id=$1 AND action_id IS NULL`, [family.id, who.user.id])).rows[0];
      if (pending.own >= 12 || pending.total >= 36) S.fail(429, 'PHOTO_UPLOAD_LIMIT', '待提交照片较多，请先完成加分或稍后重试');
      await client.query(`INSERT INTO saas_award_photos(family_id,id,uploaded_by,data,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6)`, [family.id, photoId, who.user.id, data, sampled, new Date(+sampled + PHOTO_TTL_MS)]);
      return { status: 200, body: { photoId } };
    });
  }
  async function discard(ctx, body) {
    return run(ctx, async (client, who, family) => {
      if (Object.keys(body).some(key => key !== 'photoIds') || !Array.isArray(body.photoIds) || body.photoIds.length > 12 ||
          body.photoIds.some(id => typeof id !== 'string' || !S.UUID.test(id))) invalidPhoto();
      const sampled = at(), entries = [];
      for (const id of new Set(body.photoIds.map(id => id.toLowerCase()))) {
        const photo = (await client.query('SELECT uploaded_by,action_id FROM saas_award_photos WHERE family_id=$1 AND id=$2', [family.id, id])).rows[0];
        if (photo && (photo.action_id !== null || photo.uploaded_by?.toLowerCase() !== who.user.id.toLowerCase())) continue;
        const marker = (await client.query(`SELECT expires_at FROM saas_award_photo_discards
          WHERE family_id=$1 AND id=$2 AND uploaded_by=$3`, [family.id, id, who.user.id])).rows[0];
        entries.push({ id, newMarker: !marker || +marker.expires_at <= +sampled });
      }
      // Charge only new markers, including unknown IDs needed to cancel a late
      // upload. Validate the whole batch and its limits before deleting anything.
      for (const entry of entries) if (entry.newMarker) await rate(client, who, family, 'award-photo-discard', 60);
      for (const entry of entries) {
        if (entry.newMarker) {
          await client.query(`INSERT INTO saas_award_photo_discards(family_id,id,uploaded_by,expires_at) VALUES($1,$2,$3,$4)
            ON CONFLICT(family_id,id,uploaded_by) DO UPDATE SET expires_at=excluded.expires_at`,
          [family.id, entry.id, who.user.id, new Date(+sampled + PHOTO_TTL_MS)]);
        }
        await client.query('DELETE FROM saas_award_photos WHERE family_id=$1 AND id=$2 AND uploaded_by=$3 AND action_id IS NULL', [family.id, entry.id, who.user.id]);
      }
      return { status: 200, body: { ok: true } };
    });
  }
  async function read(ctx, body) {
    return run(ctx, async (client, _who, family) => {
      if (Object.keys(body).some(key => key !== 'photoId') || typeof body.photoId !== 'string' || !S.UUID.test(body.photoId)) invalidPhoto();
      const row = (await client.query('SELECT data,action_id FROM saas_award_photos WHERE family_id=$1 AND id=$2 AND action_id IS NOT NULL', [family.id, body.photoId])).rows[0];
      const record = row && family.state.points.find(point => point.id === 'points-' + row.action_id);
      if (!record || !Array.isArray(record.photoIds) || !record.photoIds.some(id => id.toLowerCase() === body.photoId.toLowerCase())) {
        S.fail(404, 'PHOTO_NOT_FOUND', '照片不存在或尚未提交');
      }
      return { status: 200, body: { dataUrl: dataUrl(row.data) } };
    });
  }
  async function assertAttachable(client, who, family, ids) {
    for (const id of ids) {
      const row = (await client.query(`SELECT 1 FROM saas_award_photos
        WHERE family_id=$1 AND id=$2 AND uploaded_by=$3 AND action_id IS NULL AND expires_at>$4`, [family.id, id, who.user.id, at()])).rows[0];
      if (!row) S.fail(400, 'PHOTO_UNAVAILABLE', '照片已过期或不可用于本次加分，请重新选择');
    }
  }
  async function commit(client, who, family, action, ids) {
    for (const id of ids) {
      const changed = await client.query(`UPDATE saas_award_photos SET action_id=$4,committed_at=$5
        WHERE family_id=$1 AND id=$2 AND uploaded_by=$3 AND action_id IS NULL`, [family.id, id, who.user.id, action.id, at()]);
      if (changed.rowCount !== 1) throw new Error('Award photo changed inside the action transaction');
    }
  }
  return { upload, discard, read, assertAttachable, commit };
}
module.exports = { MAX_PHOTO_BYTES, MAX_UPLOAD_JSON_BYTES, PHOTO_TTL_MS, decodeJpeg, dataUrl, createAwardPhotos };
