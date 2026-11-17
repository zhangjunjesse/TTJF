'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function fail(status, code, message) { throw new HttpError(status, code, message); }
function token() { return crypto.randomBytes(32).toString('base64url'); }
function digest(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') { return false; }
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function canonical(value, depth = 0) {
  if (depth > 40) { fail(400, 'VALIDATION_ERROR', '操作内容嵌套过深'); }
  if (value === null || typeof value !== 'object') { return JSON.stringify(value); }
  if (Array.isArray(value)) { return '[' + value.map(v => canonical(v, depth + 1)).join(',') + ']'; }
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k], depth + 1)).join(',') + '}';
}
async function slowHash(value, salt, n = 32768) {
  if (![16384, 32768].includes(n)) { throw new Error('Unsupported scrypt work factor'); }
  return (await scrypt(value, salt, 32, { N: n, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex');
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { algorithm: 'scrypt', n: 32768, salt, digest: await slowHash(password, salt) };
}
async function checkPassword(password, record) {
  return !!record && record.algorithm === 'scrypt' && typeof record.salt === 'string' &&
    equal(await slowHash(password, record.salt, record.n || 16384), record.digest);
}
function password(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) {
    fail(400, 'VALIDATION_ERROR', '密码须为10至128个字符');
  }
  return value;
}
function email(value) {
  if (typeof value !== 'string') { fail(400, 'VALIDATION_ERROR', '请输入有效邮箱'); }
  const result = value.trim().toLowerCase();
  const parts = result.split('@');
  const local = parts[0], domain = parts[1];
  // Accept one unquoted mailbox, never a Nodemailer address-list/header syntax.
  // This also ensures an email-bound invitation has exactly one recipient.
  if (result.length > 254 || parts.length !== 2 || !local || local.length > 64 ||
      !/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..') ||
      !domain || !domain.includes('.') || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    fail(400, 'VALIDATION_ERROR', '请输入有效邮箱');
  }
  return result;
}
function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    fail(400, 'VALIDATION_ERROR', label + '须为1至' + max + '个字符');
  }
  return value.trim();
}
function command(payload) {
  if (!Number.isSafeInteger(payload.revision) || payload.revision < 1 || !payload.action ||
      typeof payload.action !== 'object' || Array.isArray(payload.action) ||
      typeof payload.action.id !== 'string' || !ID.test(payload.action.id) || typeof payload.action.type !== 'string') {
    fail(400, 'VALIDATION_ERROR', '请提供有效版本号和操作标识');
  }
  canonical(payload.action);
}
async function makeReceipt(action) {
  // Challenge/grant fingerprints must also be slow when the action carries a PIN.
  if (['parent.setup', 'parent.configure'].includes(action.type)) { return hashPassword(canonical(action)); }
  return { algorithm: 'sha256', digest: digest(canonical(action)) };
}
async function matchesReceipt(receipt, action) {
  if (!receipt) { return false; }
  return receipt.algorithm === 'scrypt' ? checkPassword(canonical(action), receipt) :
    receipt.algorithm === 'sha256' && equal(receipt.digest, digest(canonical(action)));
}
function csrf(rawToken) { return crypto.createHmac('sha256', rawToken).update('ttjf-csrf-v1').digest('base64url'); }
module.exports = { ID, UUID, TOKEN, own, HttpError, fail, token, digest, equal, canonical, slowHash,
  hashPassword, checkPassword, password, email, text, command, makeReceipt, matchesReceipt, csrf };
