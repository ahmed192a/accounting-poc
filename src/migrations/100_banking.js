// Banking: bank/cash/wallet accounts, CSV import batches, statement lines, bank rules, matches, sign-offs.
// Money = integer piastres. Statement lines are never deleted: rollback marks them 'void'.
export const id = '100_banking';

export function up(db) {
  db.exec(`
CREATE TABLE bank_accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('bank','cash','wallet')),
  ledger_code TEXT NOT NULL,
  account_number TEXT,
  currency TEXT NOT NULL DEFAULT 'EGP',
  opening_balance INTEGER NOT NULL DEFAULT 0,   -- statement opening balance, piastres
  mapping TEXT,                                  -- JSON: saved CSV column mapping
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX bank_accounts_ledger ON bank_accounts(ledger_code) WHERE active = 1;

CREATE TABLE bank_batches (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
  filename TEXT,
  status TEXT NOT NULL CHECK (status IN ('preview','committed','rolled_back')),
  mapping TEXT NOT NULL,
  total_rows INTEGER NOT NULL DEFAULT 0,
  good_rows INTEGER NOT NULL DEFAULT 0,
  duplicate_rows INTEGER NOT NULL DEFAULT 0,
  error_rows INTEGER NOT NULL DEFAULT 0,
  errors TEXT NOT NULL DEFAULT '[]',             -- JSON [{row, line, message}]
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  committed_by INTEGER,
  committed_at INTEGER,
  rolled_back_by INTEGER,
  rolled_back_at INTEGER,
  rollback_reason TEXT
);

CREATE TABLE bank_lines (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES bank_batches(id),
  account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
  row_no INTEGER NOT NULL,
  txn_date TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL,                       -- signed piastres: positive = money in
  balance INTEGER,                               -- running balance from the statement, if any
  row_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged','duplicate','active','void')),
  method TEXT,                                   -- payment-method tag
  recon_state TEXT NOT NULL DEFAULT 'unreconciled' CHECK (recon_state IN ('unreconciled','reconciled'))
);
CREATE UNIQUE INDEX bank_lines_hash ON bank_lines(account_id, row_hash) WHERE status = 'active';
CREATE INDEX bank_lines_acct ON bank_lines(account_id, status, txn_date);
CREATE INDEX bank_lines_batch ON bank_lines(batch_id);

CREATE TABLE bank_rules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,         -- lower runs first
  match_type TEXT NOT NULL CHECK (match_type IN ('contains','regex')),
  pattern TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'any' CHECK (direction IN ('in','out','any')),
  min_amount INTEGER,                            -- absolute piastres
  max_amount INTEGER,
  account_code TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  method TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE bank_matches (
  id INTEGER PRIMARY KEY,
  line_id INTEGER NOT NULL REFERENCES bank_lines(id),
  kind TEXT NOT NULL CHECK (kind IN ('invoice','bill','ledger','entry','manual','rule')),
  ref_id INTEGER,                                -- invoice id, bill id, journal line id ...
  entry_id INTEGER,                              -- journal entry created by this match (invoice, bill, entry kinds)
  ledger_line_id INTEGER,                        -- the journal line on the bank's ledger account this match accounts for
  status TEXT NOT NULL CHECK (status IN ('accepted','rejected','undone')),
  confidence INTEGER,
  reasons TEXT,                                  -- JSON array of human-readable reasons
  note TEXT,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  undone_by INTEGER,
  undone_at INTEGER,
  undo_reason TEXT
);
CREATE UNIQUE INDEX bank_matches_line ON bank_matches(line_id) WHERE status = 'accepted';
CREATE UNIQUE INDEX bank_matches_ledger ON bank_matches(ledger_line_id) WHERE status = 'accepted' AND ledger_line_id IS NOT NULL;
CREATE UNIQUE INDEX bank_matches_doc ON bank_matches(kind, ref_id) WHERE status = 'accepted' AND kind IN ('invoice','bill');
CREATE INDEX bank_matches_rej ON bank_matches(line_id, kind, ref_id) WHERE status = 'rejected';

CREATE TABLE bank_signoffs (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
  as_of TEXT NOT NULL,
  statement_balance INTEGER NOT NULL,
  ledger_balance INTEGER NOT NULL,
  difference INTEGER NOT NULL,
  unreconciled_count INTEGER NOT NULL,
  note TEXT,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`);
}
