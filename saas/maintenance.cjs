'use strict';
// Only these short-lived records are eligible. Family aggregates, action
// receipts, family requests and import audits intentionally have no entry.
const TABLES = Object.freeze([
  ['sessions', 'saas_sessions', 'token_hash', 'revoked_at IS NOT NULL OR expires_at <= $1'],
  ['emailTokens', 'saas_email_tokens', 'token_hash', 'consumed_at IS NOT NULL OR expires_at <= $1'],
  ['invitations', 'saas_invitations', 'id', 'consumed_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at <= $1'],
  ['challenges', 'saas_parent_challenges', 'token_hash', 'attempts >= 3 OR expires_at <= $1'],
  ['grants', 'saas_parent_grants', 'token_hash', 'expires_at <= $1'],
  ['rateLimits', 'saas_rate_limits', 'scope', 'expires_at <= $1'],
  ['assistantLeases', 'saas_assistant_leases', 'id', 'expires_at <= $1'],
  ['awardPhotos', 'saas_award_photos', 'rowid', 'action_id IS NULL AND (expires_at <= $1 OR uploaded_by IS NULL)'],
  ['awardPhotoDiscards', 'saas_award_photo_discards', 'rowid', 'expires_at <= $1']
]);
function maintenanceConfig(options = {}) {
  const intervalMs = Number(options.maintenanceIntervalMs === undefined ? process.env.SAAS_CLEANUP_INTERVAL_MS || 300000 : options.maintenanceIntervalMs);
  const batchSize = Number(options.maintenanceBatchSize === undefined ? process.env.SAAS_CLEANUP_BATCH_SIZE || 200 : options.maintenanceBatchSize);
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 86400000 || (intervalMs > 0 && intervalMs < 1000)) {
    throw new Error('SAAS_CLEANUP_INTERVAL_MS must be 0 (manual) or 1000..86400000');
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) { throw new Error('Maintenance batchSize must be 1..1000'); }
  return { intervalMs, batchSize };
}
function createMaintenance({ store, now, reportError, intervalMs, batchSize }) {
  let closed = false, running = null, timer = null;
  function cleanupExpired(options = {}) {
    if (closed) { return Promise.reject(new Error('SaaS maintenance is closed')); }
    const limit = options.batchSize === undefined ? batchSize : options.batchSize;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) { return Promise.reject(new Error('Maintenance batchSize must be 1..1000')); }
    if (running) { return running; }
    running = store.transaction(async client => {
      // The shared database queue serializes cleanup with request transactions.
      const sampled = new Date(now()), deleted = {};
      for (const [label, table, key, predicate] of TABLES) {
        const result = await client.query(`DELETE FROM ${table} WHERE ${key} IN (
          SELECT ${key} FROM ${table} WHERE ${predicate} ORDER BY ${key} LIMIT $2
        )`, [sampled, limit]);
        deleted[label] = result.rowCount;
      }
      return { skipped: false, at: sampled.toISOString(), batchSize: limit, deleted };
    }).finally(() => { running = null; });
    return running;
  }
  if (intervalMs) {
    timer = setInterval(() => { cleanupExpired().catch(() => { reportError('MAINTENANCE_FAILED'); }); }, intervalMs);
    timer.unref();
  }
  let closing;
  function close() {
    if (!closing) {
      closed = true;
      if (timer) { clearInterval(timer); timer = null; }
      closing = (async () => { if (running) { await running; } })();
    }
    return closing;
  }
  return Object.freeze({ cleanupExpired, close, status: () => ({ closed, running: !!running, timerActive: !!timer, intervalMs, batchSize }) });
}
module.exports = { createMaintenance, maintenanceConfig };
