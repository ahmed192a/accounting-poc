// Authentication tables. Own range 400-499. Credentials live beside the core `users` table
// (a user without a row here has no password: that is the demo, header-identity world).
export const id = '400_auth_core';

export function up(db) {
  db.exec(`
CREATE TABLE auth_credentials (
  user_id INTEGER PRIMARY KEY,
  email TEXT UNIQUE,
  password_hash TEXT,                      -- scrypt$N$r$p$salt$hash, NULL until a password is set
  active INTEGER NOT NULL DEFAULT 1,
  demo INTEGER NOT NULL DEFAULT 0,         -- 1 = seeded demo credential (never created when AUTH_REQUIRED=1)
  must_change INTEGER NOT NULL DEFAULT 0,  -- temporary password: only /api/auth/* works until changed
  password_changed_at INTEGER,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_failed_at INTEGER,
  locked_until INTEGER,
  last_login_at INTEGER,
  mfa_secret TEXT,                         -- encrypted (AES-256-GCM), base32 secret once enrolled
  mfa_pending_secret TEXT,                 -- encrypted, until the first code is verified
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  mfa_last_counter INTEGER NOT NULL DEFAULT 0,  -- replay protection: a TOTP step is accepted once
  invite_hash TEXT,
  invite_expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE auth_backup_codes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  code_hash TEXT NOT NULL,
  used_at INTEGER
);
CREATE INDEX auth_backup_codes_user ON auth_backup_codes (user_id);

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,                     -- sha256 of the cookie token: a DB leak yields no usable cookie
  user_id INTEGER NOT NULL,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  rotated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,             -- idle expiry, pushed forward on use
  absolute_expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  replaced INTEGER NOT NULL DEFAULT 0,      -- 1 = superseded by a rotation; only valid for the short grace period
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX auth_sessions_user ON auth_sessions (user_id);

CREATE TABLE auth_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
}
