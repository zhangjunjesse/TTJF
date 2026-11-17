'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function loopback(host) { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host); }
function createMailer(options = {}) {
  const env = options.env || process.env;
  const environment = options.environment || env.NODE_ENV || 'development';
  const production = environment === 'production';
  const publicOrigin = options.publicOrigin;
  const from = options.mailFrom || env.MAIL_FROM;
  if (options.mailer) {
    if (production) { throw new Error('Production requires configured SMTP; injected/test mailers are not allowed'); }
    if (typeof options.mailer.sendMail !== 'function') { throw new Error('mailer must provide sendMail(message)'); }
    return { send: message => options.mailer.sendMail({ from: from || 'local-test@example.invalid', ...message }), close() {} };
  }
  const smtpUrl = options.smtpUrl || env.SMTP_URL;
  const smtpHost = env.SMTP_HOST;
  if (smtpUrl || smtpHost) {
    if (!from || /[\r\n]/.test(from)) { throw new Error('SMTP requires MAIL_FROM'); }
    const nodemailer = require('nodemailer');
    let settings;
    if (smtpUrl) {
      const parsed = new URL(smtpUrl);
      if (!['smtp:', 'smtps:'].includes(parsed.protocol)) { throw new Error('SMTP_URL must use smtp or smtps'); }
      settings = { host: parsed.hostname, port: Number(parsed.port || (parsed.protocol === 'smtps:' ? 465 : 587)),
        secure: parsed.protocol === 'smtps:', auth: parsed.username ? {
          user: decodeURIComponent(parsed.username), pass: decodeURIComponent(parsed.password) } : undefined };
    } else {
      const port = Number(env.SMTP_PORT || 587);
      settings = { host: smtpHost, port, secure: port === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS || '' } : undefined };
    }
    if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) { throw new Error('Invalid SMTP_PORT'); }
    settings.requireTLS = production && !settings.secure;
    settings.connectionTimeout = 10000;
    settings.socketTimeout = 15000;
    const transporter = nodemailer.createTransport(settings);
    return { send: message => transporter.sendMail({ from, ...message }), close: () => transporter.close() };
  }
  const directory = options.devMailDir || env.DEV_MAIL_DIR;
  if (directory && environment === 'development' && publicOrigin && loopback(new URL(publicOrigin).hostname)) {
    const absolute = path.resolve(directory);
    return {
      async send(message) {
        await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
        const file = path.join(absolute, crypto.randomUUID() + '.json');
        await fs.writeFile(file, JSON.stringify({ channel: 'development-only; not delivered externally', from: 'local-development@example.invalid',
          ...message }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      }, close() {}
    };
  }
  throw new Error(production ? 'Production requires SMTP and MAIL_FROM' :
    'Configure SMTP, inject a test mailer, or explicitly set DEV_MAIL_DIR with development loopback PUBLIC_ORIGIN');
}
function emailMessage(email, purpose, rawToken, publicOrigin) {
  const labels = { verify: '验证邮箱', reset: '重置密码', invite: '加入家庭' };
  return { to: email, subject: '小小向前 · ' + labels[purpose],
    text: labels[purpose] + '：\n' + publicOrigin + '/#' + purpose + '=' + rawToken +
      '\n\n请在页面中确认操作。链接只能使用一次；如果这不是你的操作，可以忽略。' };
}
module.exports = { createMailer, emailMessage, loopback };
