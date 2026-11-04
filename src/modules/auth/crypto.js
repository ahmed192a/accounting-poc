import { randomBytes, createHash, createHmac, timingSafeEqual, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';

// All primitives come from node:crypto. No third-party code.
export const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');
export const hmacHex = (key, data, algo = 'sha256') => createHmac(algo, key).update(data).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Constant-time string comparison (length differences are not secret here). */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

// ---------- passwords: scrypt ----------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const scryptOpts = (N, r, p) => ({ N, r, p, maxmem: 128 * N * r + 1024 * 1024 });

export function hashPassword(password, params = SCRYPT) {
  const salt = randomBytes(16);
  const dk = scryptSync(String(password).normalize('NFKC'), salt, params.keylen, scryptOpts(params.N, params.r, params.p));
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), dk.toString('base64')].join('$');
}

export function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const want = Buffer.from(hash, 'base64');
  const got = scryptSync(String(password).normalize('NFKC'), Buffer.from(salt, 'base64'), want.length, scryptOpts(+N, +r, +p));
  return timingSafeEqual(got, want);
}

let dummy;
/** Burn the same time as a real check, so unknown e-mails cannot be told apart by response time. */
export function dummyVerify(password) {
  dummy ??= hashPassword('dummy-password-for-timing');
  verifyPassword(password, dummy);
  return false;
}

// ---------- secrets at rest: AES-256-GCM ----------
// Key: env AUTH_ENCRYPTION_KEY (any string, hashed) if set, otherwise a random key kept in auth_secrets.
// The second option only protects against partial leaks (an export of one table); set the env var in production.
export function secretKey(ctx, name = 'encryption_key', envName = 'AUTH_ENCRYPTION_KEY') {
  const env = process.env[envName];
  if (env) return createHash('sha256').update(`${name}:${env}`).digest();
  const row = ctx.db.prepare('SELECT value FROM auth_secrets WHERE name = ?').get(name);
  if (row) return Buffer.from(row.value, 'base64');
  const key = randomBytes(32);
  ctx.db.prepare('INSERT INTO auth_secrets (name, value) VALUES (?, ?)').run(name, key.toString('base64'));
  return key;
}

export function encryptSecret(ctx, plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', secretKey(ctx), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export function decryptSecret(ctx, blob) {
  const [v, iv, tag, enc] = String(blob).split('.');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = createDecipheriv('aes-256-gcm', secretKey(ctx), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}
