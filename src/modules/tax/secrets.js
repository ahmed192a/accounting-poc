import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { AppError } from '../../errors.js';
import { audit, tx } from '../../ledger.js';
import { requirePerm } from '../../permissions.js';

// Credentials for the (MOCK) tax authority, encrypted at rest with AES-256-GCM under a key derived from the
// server secret TAX_SECRET_KEY. They are never logged, never returned after saving, never put in audit rows.
// Without TAX_SECRET_KEY a fixed development key is used and a warning is logged: NOT safe for production.
// eta_signing_key_pem / eta_signing_cert_pem / eta_signing_pin feed the PEM signer of the LIVE ETA adapter (see docs/eta-live.md).
export const SECRET_NAMES = ['eta_client_id', 'eta_client_secret', 'eta_signing_pin', 'eta_signing_key_pem', 'eta_signing_cert_pem'];
const MAX_LEN = { eta_signing_key_pem: 20000, eta_signing_cert_pem: 20000 };
export const REQUIRED_SECRETS = ['eta_client_id', 'eta_client_secret'];

let warned = false;
function key() {
  let raw = process.env.TAX_SECRET_KEY;
  if (!raw) {
    if (!warned) { warned = true; console.warn('[tax] TAX_SECRET_KEY is not set: using an insecure development key. Set it before storing real credentials.'); }
    raw = 'insecure-development-key-do-not-use';
  }
  return scryptSync(raw, 'accounting-poc-tax-secrets', 32);
}

export function encrypt(plain) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ciphertext: ct.toString('base64') };
}

export function decrypt({ iv, tag, ciphertext }) {
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ciphertext, 'base64')), d.final()]).toString('utf8');
}

/** Server-side use only (adapters). There is deliberately no route that returns this. */
export function readSecret(db, name) {
  const row = db.prepare('SELECT iv, tag, ciphertext FROM tax_secrets WHERE name = ?').get(name);
  return row ? decrypt(row) : null;
}

export function setSecret(ctx, user, name, value) {
  requirePerm(user, 'tax.configure');
  if (!SECRET_NAMES.includes(name)) throw new AppError(400, 'BAD_INPUT', `Unknown secret "${name}" (known: ${SECRET_NAMES.join(', ')})`);
  if (typeof value !== 'string' || !value.trim() || value.length > (MAX_LEN[name] ?? 500)) throw new AppError(400, 'BAD_INPUT', `Secret value must be a non-empty string of at most ${MAX_LEN[name] ?? 500} characters`);
  const e = encrypt(value);
  tx(ctx.db, () => {
    ctx.db.prepare('INSERT INTO tax_secrets (name, iv, tag, ciphertext, updated_by, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET iv=excluded.iv, tag=excluded.tag, ciphertext=excluded.ciphertext, updated_by=excluded.updated_by, updated_at=excluded.updated_at')
      .run(name, e.iv, e.tag, e.ciphertext, user.id, ctx.now());
    audit(ctx, { userId: user.id, action: 'tax.secret_set', type: 'tax_secret', newValue: { name } }); // the value is never audited
  });
  return { name, set: true };
}

export function listSecrets(ctx, user) {
  requirePerm(user, 'tax.configure');
  const have = new Map(ctx.db.prepare('SELECT name, updated_at FROM tax_secrets').all().map((r) => [r.name, r.updated_at]));
  return SECRET_NAMES.map((name) => ({ name, set: have.has(name), updatedAt: have.get(name) ?? null, required: REQUIRED_SECRETS.includes(name) }));
}

export const hasRequiredSecrets = (db) => REQUIRED_SECRETS.every((n) => db.prepare('SELECT 1 FROM tax_secrets WHERE name = ?').get(n));
