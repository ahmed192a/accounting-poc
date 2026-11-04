// LIVE ETA adapter bookkeeping (UNVERIFIED against the real service; see docs/eta-live.md). Holds no secrets.
export const id = '520_tax_live';

export function up(db) {
  db.exec(`
-- One row per document that went through the live adapter: the authority's long id and share link, and the last problem seen.
CREATE TABLE tax_live_docs (
  document_id INTEGER PRIMARY KEY REFERENCES tax_documents(id),
  long_id TEXT,
  share_url TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_http_status INTEGER,
  last_error TEXT,
  cancel_confirmed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
-- Request outcomes for support. Never contains tokens, secrets or document bodies.
CREATE TABLE tax_live_log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  op TEXT NOT NULL,
  document_id INTEGER,
  outcome TEXT NOT NULL,
  code TEXT,
  detail TEXT
);
CREATE INDEX tax_live_log_at ON tax_live_log(at);
`);
}
