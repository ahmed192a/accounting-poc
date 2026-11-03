import { DatabaseSync } from 'node:sqlite';

// Money is stored as integer piastres (1 EGP = 100). Never floats.
const SCHEMA = `
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense'))
);

CREATE TABLE journal_entries (
  id INTEGER PRIMARY KEY,
  entity_id INTEGER NOT NULL DEFAULT 1,           -- multi-entity ready from day one
  entry_date TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_id INTEGER,
  reverses_id INTEGER REFERENCES journal_entries(id),
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  reason TEXT
);

CREATE TABLE journal_lines (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  debit INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
  currency TEXT NOT NULL DEFAULT 'EGP',           -- multi-currency ready from day one
  CHECK (NOT (debit > 0 AND credit > 0))
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  record_type TEXT,
  record_id INTEGER,
  old_value TEXT,
  new_value TEXT,
  reason TEXT
);

-- The ledger and the audit log can only ever be appended to. Enforced in the database,
-- not just in application code.
CREATE TRIGGER je_no_update BEFORE UPDATE ON journal_entries BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER je_no_delete BEFORE DELETE ON journal_entries BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER jl_no_update BEFORE UPDATE ON journal_lines BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER jl_no_delete BEFORE DELETE ON journal_lines BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER al_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER al_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE period_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  through_date TEXT,
  mode TEXT CHECK (mode IN ('soft','hard'))
);
INSERT INTO period_lock (id, through_date, mode) VALUES (1, NULL, NULL);

CREATE TABLE roles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  permissions TEXT NOT NULL,      -- JSON array of permission atoms
  limits TEXT NOT NULL DEFAULT '{}', -- JSON object: permission -> max amount in piastres
  builtin INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id)
);

CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  price INTEGER NOT NULL,         -- VAT-exclusive, piastres
  eta_code TEXT                   -- GS1/EGS item code; NULL means the ETA would reject it
);

CREATE TABLE invoices (
  id INTEGER PRIMARY KEY,
  number TEXT,
  customer TEXT NOT NULL,
  lines TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  vat INTEGER NOT NULL,
  total INTEGER NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  paid INTEGER NOT NULL DEFAULT 0,
  entry_id INTEGER REFERENCES journal_entries(id),
  created_by INTEGER NOT NULL
);

CREATE TABLE bills (
  id INTEGER PRIMARY KEY,
  supplier TEXT NOT NULL,
  amount INTEGER NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_approval','approved')),
  created_by INTEGER NOT NULL,
  approved_by INTEGER,
  entry_id INTEGER REFERENCES journal_entries(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE sales (
  id INTEGER PRIMARY KEY,
  items TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  vat INTEGER NOT NULL,
  total INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  entry_id INTEGER REFERENCES journal_entries(id)
);

CREATE TABLE receipts (
  id INTEGER PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','submitted','rejected')),
  uuid TEXT,
  reject_reason TEXT,
  created_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  submitted_at INTEGER
);
`;

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export function createContext(db) {
  const ctx = { db, offsetMs: 0, now: () => Date.now() + ctx.offsetMs };
  return ctx;
}
