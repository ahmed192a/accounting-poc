import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors.js';
import { loadUser } from '../../permissions.js';
import { cfg } from './config.js';
import { safeEqual } from './crypto.js';
import { resolveSession } from './sessions.js';
import { verifyApiKey } from './apikeys.js';

// HTTP-level security helpers used by src/server.js: headers, cookies, request identity, CSRF.
export const SESSION_COOKIE = 'acc_sid';
export const CSRF_COOKIE = 'acc_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// script-src has no 'unsafe-inline': the UI uses only external module scripts. style-src keeps 'unsafe-inline'
// because the UI modules set style="" attributes; styles cannot run code, scripts can.
export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

export function securityHeaders({ secure = false } = {}) {
  return {
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    ...(secure ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

export const newRequestId = (incoming) => (typeof incoming === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID());

export function clientIp(req, c) {
  if (c.trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

export function isSecureRequest(req, c) {
  if (c.cookieSecure != null) return c.cookieSecure;
  return !!req.socket?.encrypted || (c.trustProxy && req.headers['x-forwarded-proto'] === 'https');
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export function serializeCookie(name, value, { maxAgeSec, httpOnly = true, secure = false, sameSite = 'Lax', path = '/' } = {}) {
  return [`${name}=${value}`, `Path=${path}`, `SameSite=${sameSite}`, ...(httpOnly ? ['HttpOnly'] : []), ...(secure ? ['Secure'] : []),
    ...(maxAgeSec != null ? [`Max-Age=${maxAgeSec}`] : [])].join('; ');
}

/** The per-request helper handed to route handlers as `http`. Cookies it sets are added to the response. */
export function makeHttp(req, ctx, extra = {}) {
  const c = cfg(ctx);
  const cookies = [];
  const secure = isSecureRequest(req, c);
  return {
    ip: clientIp(req, c), userAgent: req.headers['user-agent'] ?? null, headers: req.headers, requestId: extra.requestId,
    via: null, session: null, apiKey: null,
    cookies, // Set-Cookie header values, read by the server
    setSession(token, maxAgeSec, csrf) {
      cookies.push(serializeCookie(SESSION_COOKIE, token, { maxAgeSec, secure }));
      cookies.push(serializeCookie(CSRF_COOKIE, csrf, { maxAgeSec, secure, httpOnly: false })); // readable copy for the double-submit header
    },
    clearSession() {
      cookies.push(serializeCookie(SESSION_COOKIE, '', { maxAgeSec: 0, secure }));
      cookies.push(serializeCookie(CSRF_COOKIE, '', { maxAgeSec: 0, secure, httpOnly: false }));
    },
    sessionToken: parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null,
    ...extra.fields,
  };
}

function originMatches(req, c) {
  const origin = req.headers.origin;
  if (origin == null) return true; // not a browser cross-site request (curl, server to server)
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  const want = (c.trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
  return host === want;
}

export function checkOrigin(req, ctx) {
  if (!originMatches(req, cfg(ctx))) throw new AppError(403, 'CSRF_FAILED', 'Cross-site request refused');
}

/**
 * Work out who is calling. Order:
 *   1. API key (Authorization: Bearer acck_..., or x-api-key): always honoured, never needs CSRF.
 *   2. Demo header identity x-user-id: ONLY when AUTH_REQUIRED is not '1' (unchanged demo behaviour).
 *   3. Session cookie, with CSRF double-submit check on unsafe methods.
 * With AUTH_REQUIRED=1 and none of 1 or 3: 401 AUTH_REQUIRED (the x-user-id header is ignored on purpose).
 * Returns { user, via, session } and may call http.setSession for a rotated cookie.
 */
export function authenticate(ctx, req, http, route) {
  const c = cfg(ctx);
  const auth = String(req.headers.authorization ?? '');
  const bearer = /^Bearer\s+(acck_\S+)$/i.exec(auth);
  const presentedKey = bearer?.[1] ?? req.headers['x-api-key'];
  if (presentedKey) {
    const { user, key } = verifyApiKey(ctx, String(presentedKey), http.ip);
    return { user, via: 'apikey', session: null, apiKey: key };
  }
  if (!c.required && req.headers['x-user-id'] !== undefined) {
    return { user: loadUser(ctx, Number(req.headers['x-user-id'])), via: 'header', session: null };
  }
  if (http.sessionToken) {
    const found = resolveSession(ctx, http.sessionToken);
    if (found) {
      if (!SAFE_METHODS.has(req.method)) {
        checkOrigin(req, ctx);
        if (!safeEqual(String(req.headers['x-csrf-token'] ?? ''), found.row.csrf)) throw new AppError(403, 'CSRF_FAILED', 'Missing or wrong x-csrf-token');
      }
      let user;
      try { user = loadUser(ctx, found.row.user_id); } catch (e) {
        if (c.required) { http.clearSession(); throw new AppError(401, 'AUTH_REQUIRED', 'Sign in required', { reason: e.code === 'ACCOUNT_DISABLED' ? 'account_disabled' : 'unknown_user' }); }
        throw e;
      }
      if (found.rotated) http.setSession(found.rotated.token, found.rotated.maxAgeSec, found.row.csrf);
      const mustChange = ctx.db.prepare('SELECT must_change FROM auth_credentials WHERE user_id = ?').get(user.id)?.must_change;
      if (mustChange && !route.path.startsWith('/api/auth/')) throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your temporary password first');
      return { user, via: 'session', session: found.row };
    }
    http.clearSession();
    if (c.required) throw new AppError(401, 'AUTH_REQUIRED', 'Your session has expired; sign in again', { reason: 'session_expired' });
  }
  if (c.required) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in required');
  return { user: loadUser(ctx, Number(req.headers['x-user-id'])), via: 'header', session: null }; // demo: same UNKNOWN_USER error as before
}
