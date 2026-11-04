import { randomBytes } from 'node:crypto';
import { AppError } from '../../errors.js';
import { tx, audit } from '../../ledger.js';
import { emit } from '../../hooks.js';
import { loadUser, requirePerm, ALL_PERMISSIONS } from '../../permissions.js';
import { sha256Hex, randomToken, safeEqual } from './crypto.js';

// API keys: "acck_<10 hex prefix>_<32 char secret>". Only sha256(key) is stored; the key is shown once.
// A key acts as its owner but is limited to its scopes: effective permissions = owner's role permissions AND key scopes,
// so changing or shrinking the owner's role shrinks the key too.
const FORMAT = /^acck_([0-9a-f]{10})_([A-Za-z0-9_-]{32})$/;
const TOUCH_EVERY_MS = 60_000;

export function createApiKey(ctx, actor, { name, permissions, expiresInDays } = {}) {
  requirePerm(actor, 'apikeys.manage');
  const n = String(name ?? '').trim();
  if (!n || n.length > 80) throw new AppError(400, 'BAD_INPUT', 'Key name is required (max 80 characters)');
  if (!Array.isArray(permissions) || !permissions.length) throw new AppError(400, 'BAD_INPUT', 'Give the key at least one permission scope');
  const scopes = [...new Set(permissions)];
  const unknown = scopes.filter((p) => !ALL_PERMISSIONS.includes(p));
  if (unknown.length) throw new AppError(400, 'BAD_INPUT', `Unknown permission: ${unknown[0]}`);
  const beyond = scopes.filter((p) => !actor.permissions.has(p));
  if (beyond.length) throw new AppError(403, 'SCOPE_EXCEEDS_USER', `A key cannot hold permissions you do not have: ${beyond.join(', ')}`);
  let expiresAt = null;
  if (expiresInDays != null) {
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 3650) throw new AppError(400, 'BAD_INPUT', 'expiresInDays must be 1 to 3650');
    expiresAt = ctx.now() + expiresInDays * 86_400_000;
  }
  const prefix = randomBytes(5).toString('hex');
  const key = `acck_${prefix}_${randomToken(24)}`;
  return tx(ctx.db, () => {
    const id = Number(ctx.db.prepare(`INSERT INTO auth_api_keys (name, prefix, key_hash, user_id, permissions, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(n, prefix, sha256Hex(key), actor.id, JSON.stringify(scopes), actor.id, ctx.now(), expiresAt).lastInsertRowid);
    audit(ctx, { userId: actor.id, action: 'apikey.created', type: 'apikey', id, newValue: { name: n, scopes, expiresAt } });
    emit(ctx, 'auth.apikey_created', { id, name: n, userId: actor.id });
    return { id, name: n, key, prefix, permissions: scopes, expiresAt, note: 'Copy the key now: it is not shown again.' };
  });
}

export function listApiKeys(ctx, actor) {
  requirePerm(actor, 'apikeys.manage');
  return ctx.db.prepare(`SELECT k.id, k.name, k.prefix, k.user_id, u.name AS user_name, k.permissions, k.created_at, k.expires_at, k.last_used_at, k.revoked_at
                         FROM auth_api_keys k JOIN users u ON u.id = k.user_id ORDER BY k.id DESC`).all()
    .map((k) => ({ id: k.id, name: k.name, prefix: `acck_${k.prefix}_…`, userId: k.user_id, userName: k.user_name, permissions: JSON.parse(k.permissions),
      createdAt: k.created_at, expiresAt: k.expires_at, lastUsedAt: k.last_used_at, revokedAt: k.revoked_at, active: !k.revoked_at && !(k.expires_at && k.expires_at <= ctx.now()) }));
}

export function revokeApiKey(ctx, actor, id) {
  requirePerm(actor, 'apikeys.manage');
  const k = ctx.db.prepare('SELECT id, name, revoked_at FROM auth_api_keys WHERE id = ?').get(id);
  if (!k) throw new AppError(404, 'NOT_FOUND', 'API key not found');
  if (k.revoked_at) throw new AppError(409, 'ALREADY_REVOKED', 'Key is already revoked');
  return tx(ctx.db, () => {
    ctx.db.prepare('UPDATE auth_api_keys SET revoked_at = ?, revoked_by = ? WHERE id = ?').run(ctx.now(), actor.id, id);
    audit(ctx, { userId: actor.id, action: 'apikey.revoked', type: 'apikey', id, oldValue: { name: k.name } });
    return { id, revoked: true };
  });
}

/** Authenticate a presented key. Returns { user, key } with user.permissions already narrowed to the key's scopes. */
export function verifyApiKey(ctx, raw, ip = null) {
  const bad = () => new AppError(401, 'INVALID_API_KEY', 'API key is invalid, expired or revoked');
  const m = FORMAT.exec(String(raw ?? ''));
  if (!m) throw bad();
  const k = ctx.db.prepare('SELECT * FROM auth_api_keys WHERE prefix = ?').get(m[1]);
  if (!k || !safeEqual(k.key_hash, sha256Hex(raw)) || k.revoked_at || (k.expires_at && k.expires_at <= ctx.now())) throw bad();
  let owner;
  try { owner = loadUser(ctx, k.user_id); } catch { throw bad(); } // deactivated owner = dead key
  const scopes = new Set(JSON.parse(k.permissions));
  const user = { ...owner, permissions: new Set([...owner.permissions].filter((p) => scopes.has(p))), apiKeyId: k.id };
  if (!k.last_used_at || ctx.now() - k.last_used_at >= TOUCH_EVERY_MS) {
    ctx.db.prepare('UPDATE auth_api_keys SET last_used_at = ?, last_used_ip = ? WHERE id = ?').run(ctx.now(), ip, k.id);
  }
  return { user, key: { id: k.id, name: k.name } };
}
