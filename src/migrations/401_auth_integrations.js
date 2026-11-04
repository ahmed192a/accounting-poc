// API keys and outbound webhooks.
export const id = '401_auth_integrations';

export function up(db) {
  db.exec(`
CREATE TABLE auth_api_keys (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL UNIQUE,             -- public lookup part of the key
  key_hash TEXT NOT NULL,                  -- sha256 of the whole key; the key itself is shown once
  user_id INTEGER NOT NULL,
  permissions TEXT NOT NULL,               -- JSON array of scopes (atoms), always capped by the owner's role
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  last_used_ip TEXT,
  revoked_at INTEGER,
  revoked_by INTEGER
);

CREATE TABLE auth_webhooks (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  secret_enc TEXT NOT NULL,                -- signing secret, encrypted at rest
  events TEXT NOT NULL,                    -- JSON array of event names, or ["*"]
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE auth_webhook_deliveries (
  id INTEGER PRIMARY KEY,
  webhook_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','delivered','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_status INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX auth_webhook_deliveries_due ON auth_webhook_deliveries (status, next_attempt_at);
`);
}
