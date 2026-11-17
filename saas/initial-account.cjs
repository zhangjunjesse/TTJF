'use strict';
const crypto = require('node:crypto');
const S = require('./security.cjs');

const DEFAULT_ACCOUNT_EMAIL = '391504704@qq.com';

function accountConfig(email, password) {
  let normalizedEmail;
  try { normalizedEmail = S.email(email || DEFAULT_ACCOUNT_EMAIL); }
  catch (_) { throw new Error('INITIAL_ACCOUNT_EMAIL must be a valid single email address.'); }
  try { S.password(password); }
  catch (_) { throw new Error('INITIAL_ACCOUNT_PASSWORD must contain 10 to 128 characters.'); }
  return { email: normalizedEmail, password };
}

function initialAccountFromEnv(env = {}) {
  if (env.INITIAL_ACCOUNT_PASSWORD === undefined && env.INITIAL_ACCOUNT_EMAIL === undefined) return null;
  return accountConfig(env.INITIAL_ACCOUNT_EMAIL, env.INITIAL_ACCOUNT_PASSWORD);
}

async function ensureInitialAccount(store, config, now = () => new Date()) {
  if (config == null) return { created: false };
  const account = accountConfig(config.email, config.password);
  return store.transaction(async client => {
    const existing = await client.query('SELECT id FROM saas_users WHERE email=$1', [account.email]);
    // This is first-time provisioning only. Existing credentials, verification
    // and family relationships remain owned by the account lifecycle.
    if (existing.rowCount) return { created: false };
    const sampled = new Date(now());
    if (!Number.isFinite(+sampled)) throw new Error('Initial account clock must return a valid date.');
    const hash = await S.hashPassword(account.password);
    await client.query('INSERT INTO saas_users(id,email,password_hash,verified_at,created_at) VALUES($1,$2,$3,$4,$4)',
      [crypto.randomUUID(), account.email, hash, sampled]);
    return { created: true };
  });
}

module.exports = { DEFAULT_ACCOUNT_EMAIL, initialAccountFromEnv, ensureInitialAccount };
