// Tamper-evidence for audit_log: one HMAC-chained row per audit row, in our own table
// (audit_log itself is owned by the ledger and stays untouched).
export const id = '402_audit_chain';

export function up(db) {
  db.exec(`
CREATE TABLE auth_audit_chain (
  audit_id INTEGER PRIMARY KEY,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  sealed_at INTEGER NOT NULL
);
`);
}
