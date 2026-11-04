import { createHmac, randomBytes } from 'node:crypto';

// TOTP (RFC 6238) on top of HOTP (RFC 4226), written by hand with node:crypto only.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(randomBytes(20)); // 160 bits, the RFC 4226 recommendation

/** HOTP value for a counter. `key` is a Buffer. */
export function hotp(key, counter, { digits = 6, algo = 'sha1' } = {}) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac(algo, key).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const counterAt = (ms, step = 30) => Math.floor(ms / 1000 / step);
export const totp = (key, ms, { step = 30, ...o } = {}) => hotp(key, counterAt(ms, step), o);

/**
 * Check a code against steps around `ms` (window = how many steps of clock skew to tolerate each way).
 * Returns the matched counter or null. Steps at or below `afterCounter` are refused (one-time use).
 */
export function verifyTotp(key, code, ms, { window = 1, step = 30, digits = 6, algo = 'sha1', afterCounter = -1 } = {}) {
  const given = String(code ?? '').replace(/\s/g, '');
  if (!/^\d+$/.test(given) || given.length !== digits) return null;
  const now = counterAt(ms, step);
  let hit = null;
  for (let c = now - window; c <= now + window; c++) { // no early exit: constant work
    if (c > afterCounter && hotp(key, c, { digits, algo }) === given && hit === null) hit = c;
  }
  return hit;
}

export function otpauthUri({ secret, account, issuer = 'Accounting', digits = 6, step = 30 }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${digits}&period=${step}`;
}
