import { randomBytes } from 'node:crypto';
import { AppError } from '../../errors.js';
import { tx, audit } from '../../ledger.js';
import { emit } from '../../hooks.js';
import { loadUser, requirePerm, requireAny, ALL_PERMISSIONS } from '../../permissions.js';
import { cfg } from './config.js';
import { sha256Hex, randomToken, hashPassword, verifyPassword, dummyVerify, encryptSecret, decryptSecret, safeEqual } from './crypto.js';
import { assertPassword } from './policy.js';
import { newSecret, base32Decode, verifyTotp, otpauthUri } from './totp.js';
import { createSession, revokeUserSessions, revokeSession, sessionId } from './sessions.js';

// ---------- helpers ----------
export const DEMO_PASSWORD = 'Demo-Pass-2026'; // demo mode ONLY (AUTH_REQUIRED not set); never seeded in required mode
export const DEMO_EMAIL = (role) => `${role}@demo.test`;

export function normEmail(e) {
  const s = String(e ?? '').trim().toLowerCase();
  if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new AppError(400, 'BAD_INPUT', 'A valid e-mail address is required');
  return s;
}

const cred = (ctx, userId) => ctx.db.prepare('SELECT * FROM auth_credentials WHERE user_id = ?').get(userId);
const credByEmail = (ctx, email) => ctx.db.prepare('SELECT * FROM auth_credentials WHERE email = ?').get(email);
const mkUser = (u) => ({ id: u.id, name: u.name, role: u.role });

function ensureCred(ctx, userId) {
  if (!cred(ctx, userId)) ctx.db.prepare('INSERT INTO auth_credentials (user_id, created_at) VALUES (?, ?)').run(userId, ctx.now());
  return cred(ctx, userId);
}

const userRow = (ctx, id) => ctx.db.prepare('SELECT u.id, u.name, r.name AS role, r.permissions FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?').get(id);

// ---------- login / logout ----------
export function login(ctx, input = {}, meta = {}) {
  const c = cfg(ctx), now = ctx.now();
  const email = String(input.email ?? '').trim().toLowerCase();
  const password = String(input.password ?? '');
  if (!email || !password || password.length > 1024) throw new AppError(400, 'BAD_INPUT', 'E-mail and password are required');
  const row = credByEmail(ctx, email);
  if (!row || !row.password_hash) { dummyVerify(password); throw new AppError(401, 'INVALID_CREDENTIALS', 'Wrong e-mail or password'); }
  if (row.locked_until && row.locked_until > now) {
    throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts; try again later', { retryAfter: Math.ceil((row.locked_until - now) / 1000) });
  }
  if (!verifyPassword(password, row.password_hash)) return failLogin(ctx, row, 'password');
  if (!row.active) throw new AppError(403, 'ACCOUNT_DISABLED', 'This account is deactivated');

  if (row.mfa_enabled) {
    const code = String(input.code ?? '').trim(), backup = String(input.backupCode ?? '').trim();
    if (!code && !backup) throw new AppError(401, 'MFA_REQUIRED', 'Enter the code from your authenticator app');
    const okMfa = backup ? useBackupCode(ctx, row.user_id, backup) : checkTotp(ctx, row, code);
    if (!okMfa) return failLogin(ctx, row, 'mfa');
  }
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE auth_credentials SET failed_count = 0, locked_until = NULL, last_login_at = ? WHERE user_id = ?').run(now, row.user_id);
    audit(ctx, { userId: row.user_id, action: 'auth.login', type: 'user', id: row.user_id, newValue: { ip: meta.ip ?? null, mfa: !!row.mfa_enabled } });
  });
  const session = createSession(ctx, row.user_id, meta);
  return { session, user: mkUser(userRow(ctx, row.user_id)), mustChangePassword: !!row.must_change, mfaEnabled: !!row.mfa_enabled };
}

function failLogin(ctx, row, why) {
  const c = cfg(ctx), now = ctx.now();
  const count = row.failed_count + 1;
  let lockedUntil = null;
  if (count >= c.lockThreshold) lockedUntil = now + Math.min(c.lockBaseMs * 2 ** (count - c.lockThreshold), c.lockMaxMs);
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE auth_credentials SET failed_count = ?, last_failed_at = ?, locked_until = ? WHERE user_id = ?').run(count, now, lockedUntil, row.user_id);
    audit(ctx, { userId: row.user_id, action: lockedUntil ? 'auth.locked' : 'auth.login_failed', type: 'user', id: row.user_id, newValue: { reason: why, failures: count, lockedUntil } });
    if (lockedUntil) emit(ctx, 'auth.lockout', { userId: row.user_id, until: lockedUntil, failures: count });
  });
  if (lockedUntil) throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts; try again later', { retryAfter: Math.ceil((lockedUntil - now) / 1000) });
  throw new AppError(401, why === 'mfa' ? 'INVALID_MFA_CODE' : 'INVALID_CREDENTIALS', why === 'mfa' ? 'Wrong code' : 'Wrong e-mail or password');
}

export function logout(ctx, token) {
  if (token) revokeSession(ctx, sessionId(token));
  return { ok: true };
}

// ---------- password ----------
export function changePassword(ctx, user, { current, next }, sessionRow) {
  const row = cred(ctx, user.id);
  if (!row?.password_hash) throw new AppError(400, 'NO_PASSWORD', 'This account has no password (demo identity)');
  if (!verifyPassword(String(current ?? ''), row.password_hash)) throw new AppError(401, 'INVALID_CREDENTIALS', 'Current password is wrong');
  const who = { email: row.email, name: user.name };
  assertPassword(next, who);
  if (verifyPassword(String(next), row.password_hash)) throw new AppError(400, 'WEAK_PASSWORD', 'The new password must differ from the current one', { problems: ['differ from the current password'] });
  return tx(ctx.db, () => {
    ctx.db.prepare('UPDATE auth_credentials SET password_hash = ?, must_change = 0, password_changed_at = ? WHERE user_id = ?').run(hashPassword(next), ctx.now(), user.id);
    const revoked = revokeUserSessions(ctx, user.id, sessionRow?.id ?? null); // other devices are signed out
    audit(ctx, { userId: user.id, action: 'auth.password_changed', type: 'user', id: user.id, newValue: { sessionsRevoked: revoked } });
    return { ok: true, sessionsRevoked: revoked };
  });
}

// ---------- MFA (TOTP) ----------
function checkTotp(ctx, row, code) {
  const secret = decryptSecret(ctx, row.mfa_secret);
  const hit = verifyTotp(base32Decode(secret), code, ctx.now(), { window: 1, afterCounter: row.mfa_last_counter });
  if (hit == null) return false;
  ctx.db.prepare('UPDATE auth_credentials SET mfa_last_counter = ? WHERE user_id = ?').run(hit, row.user_id);
  return true;
}

const normBackup = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function useBackupCode(ctx, userId, code) {
  const h = sha256Hex(normBackup(code));
  const r = ctx.db.prepare('SELECT id FROM auth_backup_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').get(userId, h);
  if (!r) return false;
  ctx.db.prepare('UPDATE auth_backup_codes SET used_at = ? WHERE id = ?').run(ctx.now(), r.id);
  audit(ctx, { userId, action: 'auth.backup_code_used', type: 'user', id: userId });
  return true;
}

function newBackupCodes(ctx, userId) {
  ctx.db.prepare('DELETE FROM auth_backup_codes WHERE user_id = ?').run(userId);
  const ins = ctx.db.prepare('INSERT INTO auth_backup_codes (user_id, code_hash) VALUES (?, ?)');
  const codes = [];
  for (let i = 0; i < 10; i++) {
    const raw = randomBytes(8).toString('hex').slice(0, 10); // 40 bits, one use
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
    ins.run(userId, sha256Hex(normBackup(raw)));
  }
  return codes;
}

export function mfaEnroll(ctx, user) {
  const row = cred(ctx, user.id);
  if (!row?.password_hash) throw new AppError(400, 'NO_PASSWORD', 'Sign in with a password account to enroll MFA');
  if (row.mfa_enabled) throw new AppError(409, 'MFA_ALREADY_ENABLED', 'MFA is already enabled; disable it first to re-enroll');
  const secret = newSecret();
  ctx.db.prepare('UPDATE auth_credentials SET mfa_pending_secret = ? WHERE user_id = ?').run(encryptSecret(ctx, secret), user.id);
  audit(ctx, { userId: user.id, action: 'auth.mfa_enroll_started', type: 'user', id: user.id });
  return { secret, otpauthUri: otpauthUri({ secret, account: row.email ?? user.name, issuer: cfg(ctx).issuer }), digits: 6, period: 30, algorithm: 'SHA1' };
}

export function mfaConfirm(ctx, user, code) {
  const row = cred(ctx, user.id);
  if (!row?.mfa_pending_secret) throw new AppError(400, 'NO_ENROLLMENT', 'Start enrollment first');
  const secret = decryptSecret(ctx, row.mfa_pending_secret);
  const hit = verifyTotp(base32Decode(secret), code, ctx.now(), { window: 1 });
  if (hit == null) throw new AppError(400, 'INVALID_MFA_CODE', 'Wrong code; check the clock on your phone');
  return tx(ctx.db, () => {
    ctx.db.prepare('UPDATE auth_credentials SET mfa_secret = ?, mfa_pending_secret = NULL, mfa_enabled = 1, mfa_last_counter = ? WHERE user_id = ?').run(encryptSecret(ctx, secret), hit, user.id);
    const backupCodes = newBackupCodes(ctx, user.id);
    audit(ctx, { userId: user.id, action: 'auth.mfa_enabled', type: 'user', id: user.id });
    return { enabled: true, backupCodes };
  });
}

function reauth(ctx, user, { password, code, backupCode }) {
  const row = cred(ctx, user.id);
  if (!row?.password_hash || !verifyPassword(String(password ?? ''), row.password_hash)) throw new AppError(401, 'INVALID_CREDENTIALS', 'Password is wrong');
  if (row.mfa_enabled) {
    const ok = backupCode ? useBackupCode(ctx, user.id, backupCode) : checkTotp(ctx, row, String(code ?? ''));
    if (!ok) throw new AppError(401, 'INVALID_MFA_CODE', 'Wrong code');
  }
}

export function mfaDisable(ctx, user, input) {
  reauth(ctx, user, input);
  return tx(ctx.db, () => {
    ctx.db.prepare('UPDATE auth_credentials SET mfa_secret = NULL, mfa_pending_secret = NULL, mfa_enabled = 0, mfa_last_counter = 0 WHERE user_id = ?').run(user.id);
    ctx.db.prepare('DELETE FROM auth_backup_codes WHERE user_id = ?').run(user.id);
    audit(ctx, { userId: user.id, action: 'auth.mfa_disabled', type: 'user', id: user.id });
    return { enabled: false };
  });
}

export function mfaNewBackupCodes(ctx, user, input) {
  const row = cred(ctx, user.id);
  if (!row?.mfa_enabled) throw new AppError(400, 'MFA_NOT_ENABLED', 'MFA is not enabled');
  reauth(ctx, user, input);
  return tx(ctx.db, () => {
    const backupCodes = newBackupCodes(ctx, user.id);
    audit(ctx, { userId: user.id, action: 'auth.backup_codes_regenerated', type: 'user', id: user.id });
    return { backupCodes };
  });
}

// ---------- who am I ----------
export function me(ctx, user, via, sessionRow) {
  const row = cred(ctx, user.id);
  return {
    user: { id: user.id, name: user.name, role: user.role, email: row?.email ?? null },
    via, authRequired: !!cfg(ctx).required,
    csrfToken: sessionRow?.csrf ?? null,
    mfaEnabled: !!row?.mfa_enabled,
    mustChangePassword: !!row?.must_change,
    hasPassword: !!row?.password_hash,
    sessionExpiresAt: sessionRow?.expires_at ?? null,
  };
}

export function status(ctx) {
  const c = cfg(ctx);
  return { authRequired: !!c.required, setupNeeded: !!c.required && setupNeeded(ctx), demoCredentials: !c.required && !!ctx.db.prepare('SELECT 1 FROM auth_credentials WHERE demo = 1 AND password_hash IS NOT NULL').get() };
}

// ---------- user management ----------
export function listUsers(ctx, actor) {
  requireAny(actor, ['users.manage', 'users.invite', 'security.view']);
  const now = ctx.now();
  return ctx.db.prepare(`SELECT u.id, u.name, r.name AS role, r.id AS role_id, c.email, c.active, c.mfa_enabled, c.must_change, c.locked_until, c.failed_count,
                                c.last_login_at, c.invite_expires_at, (c.password_hash IS NOT NULL) AS has_password, (c.invite_hash IS NOT NULL) AS invited
                         FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN auth_credentials c ON c.user_id = u.id ORDER BY u.id`).all()
    .map((x) => ({
      id: x.id, name: x.name, role: x.role, roleId: x.role_id, email: x.email ?? null, active: x.active == null ? true : !!x.active,
      mfaEnabled: !!x.mfa_enabled, mustChange: !!x.must_change, locked: !!(x.locked_until && x.locked_until > now), lockedUntil: x.locked_until ?? null,
      hasPassword: !!x.has_password, invitePending: !!x.invited && (x.invite_expires_at ?? 0) > now, lastLoginAt: x.last_login_at ?? null,
    }));
}

export function inviteUser(ctx, actor, { name, email, roleId }) {
  requirePerm(actor, 'users.invite');
  const n = String(name ?? '').trim();
  if (!n || n.length > 100) throw new AppError(400, 'BAD_INPUT', 'Name is required (max 100 characters)');
  const mail = normEmail(email);
  const role = ctx.db.prepare('SELECT id, name, permissions FROM roles WHERE id = ?').get(roleId);
  if (!role) throw new AppError(404, 'NOT_FOUND', 'Role not found');
  const missing = JSON.parse(role.permissions).filter((p) => !actor.permissions.has(p));
  if (missing.length) throw new AppError(403, 'FORBIDDEN', `You cannot invite someone into a role with permissions you do not hold: ${missing.slice(0, 5).join(', ')}`);
  if (credByEmail(ctx, mail)) throw new AppError(409, 'DUPLICATE', 'A user with this e-mail exists');
  const token = `inv_${randomToken(24)}`;
  const expires = ctx.now() + cfg(ctx).inviteTtlMs;
  return tx(ctx.db, () => {
    const id = Number(ctx.db.prepare('INSERT INTO users (name, role_id) VALUES (?, ?)').run(n, role.id).lastInsertRowid);
    ctx.db.prepare('INSERT INTO auth_credentials (user_id, email, invite_hash, invite_expires_at, created_at) VALUES (?,?,?,?,?)').run(id, mail, sha256Hex(token), expires, ctx.now());
    audit(ctx, { userId: actor.id, action: 'user.invited', type: 'user', id, newValue: { name: n, email: mail, role: role.name } });
    emit(ctx, 'auth.user_invited', { userId: id, email: mail, role: role.name, invitedBy: actor.id });
    // No mail server in this build: the admin hands the token over (shown once, valid for the invite TTL).
    return { id, email: mail, role: role.name, inviteToken: token, inviteExpiresAt: expires };
  });
}

export function acceptInvite(ctx, { token, password }) {
  const row = ctx.db.prepare('SELECT * FROM auth_credentials WHERE invite_hash = ?').get(sha256Hex(String(token ?? '')));
  if (!row || (row.invite_expires_at ?? 0) <= ctx.now()) throw new AppError(400, 'INVALID_INVITE', 'This invitation is invalid or has expired');
  const u = userRow(ctx, row.user_id);
  assertPassword(password, { email: row.email, name: u.name });
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE auth_credentials SET password_hash = ?, invite_hash = NULL, invite_expires_at = NULL, active = 1, password_changed_at = ? WHERE user_id = ?').run(hashPassword(password), ctx.now(), row.user_id);
    audit(ctx, { userId: row.user_id, action: 'user.invite_accepted', type: 'user', id: row.user_id });
  });
  return { ok: true, email: row.email };
}

function target(ctx, id) {
  const u = userRow(ctx, id);
  if (!u) throw new AppError(404, 'NOT_FOUND', 'User not found');
  return u;
}

export function setActive(ctx, actor, id, active, reason) {
  requirePerm(actor, 'users.manage');
  const u = target(ctx, id);
  if (!active && actor.id === id) throw new AppError(400, 'BAD_INPUT', 'You cannot deactivate yourself');
  if (!active && (!reason || !String(reason).trim())) throw new AppError(400, 'REASON_REQUIRED', 'Deactivating a user needs a reason');
  return tx(ctx.db, () => {
    ensureCred(ctx, id);
    ctx.db.prepare('UPDATE auth_credentials SET active = ?, failed_count = 0, locked_until = NULL WHERE user_id = ?').run(active ? 1 : 0, id);
    let revoked = 0;
    if (!active) {
      revoked = revokeUserSessions(ctx, id);
      ctx.db.prepare('UPDATE auth_api_keys SET revoked_at = ?, revoked_by = ? WHERE user_id = ? AND revoked_at IS NULL').run(ctx.now(), actor.id, id);
    }
    audit(ctx, { userId: actor.id, action: active ? 'user.reactivated' : 'user.deactivated', type: 'user', id, oldValue: { name: u.name }, newValue: { active, sessionsRevoked: revoked }, reason: reason ?? null });
    if (!active) emit(ctx, 'auth.user_deactivated', { userId: id, by: actor.id });
    return { id, active: !!active };
  });
}

export function adminResetPassword(ctx, actor, id) {
  requirePerm(actor, 'users.manage');
  const u = target(ctx, id);
  if (!credHasEmail(ctx, id)) throw new AppError(400, 'NO_EMAIL', 'Give the user an e-mail first (invite them)');
  const temp = `Tmp-${randomToken(12)}-9a`;
  return tx(ctx.db, () => {
    ctx.db.prepare('UPDATE auth_credentials SET password_hash = ?, must_change = 1, failed_count = 0, locked_until = NULL, invite_hash = NULL WHERE user_id = ?').run(hashPassword(temp), id);
    const revoked = revokeUserSessions(ctx, id);
    audit(ctx, { userId: actor.id, action: 'user.password_reset', type: 'user', id, newValue: { name: u.name, sessionsRevoked: revoked } });
    emit(ctx, 'auth.password_reset', { userId: id, by: actor.id });
    return { id, temporaryPassword: temp, mustChange: true };
  });
}
const credHasEmail = (ctx, id) => !!cred(ctx, id)?.email;

export function adminResetMfa(ctx, actor, id) {
  requirePerm(actor, 'users.manage');
  target(ctx, id);
  return tx(ctx.db, () => {
    ensureCred(ctx, id);
    ctx.db.prepare('UPDATE auth_credentials SET mfa_secret = NULL, mfa_pending_secret = NULL, mfa_enabled = 0, mfa_last_counter = 0 WHERE user_id = ?').run(id);
    ctx.db.prepare('DELETE FROM auth_backup_codes WHERE user_id = ?').run(id);
    const revoked = revokeUserSessions(ctx, id);
    audit(ctx, { userId: actor.id, action: 'user.mfa_reset', type: 'user', id, newValue: { sessionsRevoked: revoked } });
    return { id, mfaEnabled: false };
  });
}

export function unlockUser(ctx, actor, id) {
  requirePerm(actor, 'users.manage');
  target(ctx, id);
  return tx(ctx.db, () => {
    ensureCred(ctx, id);
    ctx.db.prepare('UPDATE auth_credentials SET failed_count = 0, locked_until = NULL WHERE user_id = ?').run(id);
    audit(ctx, { userId: actor.id, action: 'user.unlocked', type: 'user', id });
    return { id, locked: false };
  });
}

export function logoutEverywhere(ctx, user) {
  const n = revokeUserSessions(ctx, user.id);
  audit(ctx, { userId: user.id, action: 'auth.logout_all', type: 'user', id: user.id, newValue: { sessionsRevoked: n } });
  return { sessionsRevoked: n };
}

// ---------- demo seed and first-run setup ----------
let demoHash;
/** Demo credentials: ONLY created when AUTH_REQUIRED is not '1'. One shared password, documented in docs/security.md. */
export function seedDemoCredentials(ctx) {
  const c = cfg(ctx);
  const users = ctx.db.prepare('SELECT u.id, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.id').all();
  const ins = ctx.db.prepare('INSERT OR IGNORE INTO auth_credentials (user_id, email, password_hash, active, demo, created_at) VALUES (?,?,?,?,1,?)');
  if (c.required) { // required mode: placeholders for the demo people exist but cannot sign in
    for (const u of users) ins.run(u.id, null, null, 0, ctx.now());
    return;
  }
  demoHash ??= hashPassword(DEMO_PASSWORD); // hashed once per process: six scrypt runs per test database would be slow
  for (const u of users) ins.run(u.id, DEMO_EMAIL(u.role), demoHash, 1, ctx.now());
}

function hasWorkingAdmin(ctx) {
  const rows = ctx.db.prepare(`SELECT r.permissions FROM auth_credentials c JOIN users u ON u.id = c.user_id JOIN roles r ON r.id = u.role_id
                               WHERE c.active = 1 AND c.password_hash IS NOT NULL AND c.demo = 0`).all();
  return rows.some((r) => JSON.parse(r.permissions).includes('users.manage'));
}
export const setupNeeded = (ctx) => !hasWorkingAdmin(ctx);

function setOwnerCredentials(ctx, { email, password, name }) {
  const owner = ctx.db.prepare("SELECT u.id, u.name FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'owner' ORDER BY u.id LIMIT 1").get();
  if (!owner) throw new AppError(500, 'NO_OWNER', 'No owner user exists');
  const mail = normEmail(email);
  const finalName = String(name ?? '').trim() || owner.name;
  assertPassword(password, { email: mail, name: finalName });
  const other = credByEmail(ctx, mail);
  if (other && other.user_id !== owner.id) throw new AppError(409, 'DUPLICATE', 'That e-mail belongs to another user');
  tx(ctx.db, () => {
    ensureCred(ctx, owner.id);
    ctx.db.prepare(`UPDATE auth_credentials SET email = ?, password_hash = ?, active = 1, demo = 0, must_change = 0, failed_count = 0, locked_until = NULL,
                    mfa_enabled = 0, mfa_secret = NULL, mfa_pending_secret = NULL, password_changed_at = ? WHERE user_id = ?`).run(mail, hashPassword(password), ctx.now(), owner.id);
    if (finalName !== owner.name) ctx.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(finalName, owner.id);
    ctx.db.prepare('DELETE FROM auth_secrets WHERE name = ?').run('setup_token_hash');
    audit(ctx, { userId: owner.id, action: 'auth.owner_setup', type: 'user', id: owner.id, newValue: { email: mail } });
  });
  return owner.id;
}

/**
 * Required mode, at startup: disable any demo credential left from a demo-mode database, then, if no working admin
 * exists, either take INITIAL_OWNER_PASSWORD from the environment or print a one-time setup token to the log.
 */
export function ensureFirstRun(ctx, { log = console.log, env = process.env } = {}) {
  if (!cfg(ctx).required) return { setup: false };
  const demo = ctx.db.prepare('UPDATE auth_credentials SET active = 0, password_hash = NULL, mfa_enabled = 0, mfa_secret = NULL WHERE demo = 1 AND (password_hash IS NOT NULL OR active = 1)').run();
  if (demo.changes) {
    tx(ctx.db, () => {
      ctx.db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE revoked_at IS NULL AND user_id IN (SELECT user_id FROM auth_credentials WHERE demo = 1)').run(ctx.now());
      audit(ctx, { action: 'auth.demo_credentials_disabled', newValue: { users: Number(demo.changes) } });
    });
    log(`[auth] AUTH_REQUIRED=1: ${demo.changes} demo credential(s) from an earlier demo-mode run were disabled.`);
  }
  if (!setupNeeded(ctx)) return { setup: false };
  if (env.INITIAL_OWNER_PASSWORD) {
    const id = setOwnerCredentials(ctx, { email: env.INITIAL_OWNER_EMAIL || 'owner@accounting.local', password: env.INITIAL_OWNER_PASSWORD, name: env.INITIAL_OWNER_NAME });
    log(`[auth] First-run owner created from INITIAL_OWNER_PASSWORD (user ${id}). Remove that variable from the environment now.`);
    return { setup: false, ownerId: id };
  }
  const token = `setup_${randomToken(18)}`;
  ctx.db.prepare('INSERT INTO auth_secrets (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run('setup_token_hash', sha256Hex(token));
  log(`[auth] FIRST-RUN SETUP TOKEN (one time, valid until restart): ${token}`);
  log('[auth] Open the app and use "First-time setup", or POST /api/auth/setup { token, email, password, name }.');
  return { setup: true, token };
}

export function completeSetup(ctx, { token, email, password, name }) {
  const row = ctx.db.prepare("SELECT value FROM auth_secrets WHERE name = 'setup_token_hash'").get();
  if (!cfg(ctx).required || !row || !setupNeeded(ctx) || !safeEqual(row.value, sha256Hex(String(token ?? '')))) {
    throw new AppError(403, 'INVALID_SETUP_TOKEN', 'Setup token is invalid or setup is already complete');
  }
  const id = setOwnerCredentials(ctx, { email, password, name });
  return { ok: true, userId: id };
}

export { ALL_PERMISSIONS, loadUser };
