import { sha256Hex, randomToken } from './crypto.js';
import { cfg } from './config.js';

// Server-side sessions. The cookie holds a random token; the database holds only its sha256.
// Idle expiry slides forward on use, absolute expiry never moves, and the id is rotated periodically and at login.
const TOUCH_EVERY_MS = 60_000;

export function createSession(ctx, userId, { ip = null, userAgent = null, csrf = null } = {}) {
  const c = cfg(ctx), now = ctx.now();
  const token = randomToken(32);
  const csrfToken = csrf ?? randomToken(24);
  ctx.db.prepare('DELETE FROM auth_sessions WHERE absolute_expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)').run(now - 86_400_000, now - 86_400_000);
  ctx.db.prepare(`INSERT INTO auth_sessions (id, user_id, csrf, created_at, last_seen_at, rotated_at, expires_at, absolute_expires_at, ip, user_agent)
                  VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(sha256Hex(token), userId, csrfToken, now, now, now, now + c.sessionIdleMs, now + c.sessionAbsoluteMs, ip, String(userAgent ?? '').slice(0, 200));
  return { token, csrf: csrfToken, expiresAt: Math.min(now + c.sessionIdleMs, now + c.sessionAbsoluteMs), maxAgeSec: Math.floor(c.sessionIdleMs / 1000) };
}

/** Re-issue the session id (new token, same csrf and lifetime). The old id survives a short grace period. */
export function rotateSession(ctx, row) {
  const c = cfg(ctx), now = ctx.now();
  const token = randomToken(32);
  const expiresAt = Math.min(now + c.sessionIdleMs, row.absolute_expires_at);
  ctx.db.prepare(`INSERT INTO auth_sessions (id, user_id, csrf, created_at, last_seen_at, rotated_at, expires_at, absolute_expires_at, ip, user_agent)
                  VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(sha256Hex(token), row.user_id, row.csrf, row.created_at, now, now, expiresAt, row.absolute_expires_at, row.ip, row.user_agent);
  ctx.db.prepare('UPDATE auth_sessions SET replaced = 1, expires_at = ? WHERE id = ?').run(Math.min(row.expires_at, now + c.rotationGraceMs), row.id);
  return { token, expiresAt, maxAgeSec: Math.floor((expiresAt - now) / 1000) };
}

/** Look up a cookie token. Returns { row, rotated: {token,...}|null } or null when missing, expired or revoked. */
export function resolveSession(ctx, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const c = cfg(ctx), now = ctx.now();
  const row = ctx.db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(sha256Hex(token));
  if (!row || row.revoked_at || row.expires_at <= now || row.absolute_expires_at <= now) return null;
  if (row.replaced) return { row, rotated: null }; // grace-period use of a superseded id: no touch, no rotation
  if (now - row.rotated_at >= c.rotateEveryMs) return { row, rotated: rotateSession(ctx, row) };
  if (now - row.last_seen_at >= TOUCH_EVERY_MS) {
    ctx.db.prepare('UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .run(now, Math.min(now + c.sessionIdleMs, row.absolute_expires_at), row.id);
  }
  return { row, rotated: null };
}

export const revokeSession = (ctx, id) => ctx.db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(ctx.now(), id);

export function revokeUserSessions(ctx, userId, exceptId = null) {
  return Number(ctx.db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?').run(ctx.now(), userId, exceptId).changes);
}

/** Session token -> table id. */
export const sessionId = (token) => sha256Hex(token);
