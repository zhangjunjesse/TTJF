'use strict';
const net = require('node:net');

function normalizeIp(value) {
  if (typeof value !== 'string' || value.includes('%') || !net.isIP(value)) { return null; }
  if (net.isIP(value) === 4) { return value; }
  const canonical = new URL('http://[' + value + ']/').hostname.slice(1, -1).toLowerCase();
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  return canonical;
}
function createClientAddress(value) {
  const entries = value === undefined || value === '' ? [] : typeof value === 'string' ? value.split(',').map(item => item.trim()) : value;
  if (!Array.isArray(entries) || entries.some(item => !normalizeIp(item))) {
    throw new Error('SAAS_TRUSTED_PROXIES must list exact IPv4/IPv6 proxy addresses, not wildcards or CIDRs');
  }
  const trusted = new Set(entries.map(normalizeIp));
  return function clientAddress(request) {
    const direct = normalizeIp(request.socket && request.socket.remoteAddress) || 'unknown';
    if (!trusted.has(direct)) { return direct; }
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded !== 'string' || !forwarded || forwarded.length > 2048) { return direct; }
    let headerCount = 0;
    for (let i = 0; i < (request.rawHeaders || []).length; i += 2) {
      if (String(request.rawHeaders[i]).toLowerCase() === 'x-forwarded-for') { headerCount++; }
    }
    if (headerCount > 1) { return direct; }
    const chain = forwarded.split(',');
    if (chain.length > 32) { return direct; }
    const addresses = chain.map(item => normalizeIp(item.trim()));
    if (addresses.some(ip => !ip)) { return direct; }
    // Socket is trusted; walk toward the client and stop at the first untrusted
    // hop. Any attacker-supplied prefix to its left is irrelevant.
    for (let i = addresses.length - 1; i >= 0; i--) {
      if (!trusted.has(addresses[i])) { return addresses[i]; }
    }
    return direct;
  };
}
module.exports = { createClientAddress, normalizeIp };
