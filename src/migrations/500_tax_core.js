// Tax and compliance schema. Everything that talks to a tax authority is a MOCK (see docs/tax.md).
export const id = '500_tax_core';

export function up(db) {
  db.exec(`
-- E-invoice documents. The content columns (payload, prev_hash, hash, seq, uuid, ...) are immutable: a
-- trigger refuses to change them, so the hash chain can only be broken by someone bypassing the database.
-- Workflow columns (status, attempts, reject_*, ...) do change.
CREATE TABLE tax_documents (
  id INTEGER PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('invoice','credit_note','debit_note')),
  source_type TEXT,
  source_id INTEGER,
  number TEXT NOT NULL,
  uuid TEXT NOT NULL UNIQUE,
  adapter TEXT NOT NULL,
  payload TEXT NOT NULL,
  source TEXT NOT NULL,            -- neutral source (customer, lines) used to reissue a rejected document
  qr TEXT NOT NULL,
  total INTEGER NOT NULL,
  vat INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  ref_document_id INTEGER REFERENCES tax_documents(id),
  replaces_id INTEGER REFERENCES tax_documents(id),
  status TEXT NOT NULL CHECK (status IN ('queued','submitted','valid','rejected','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  submission_id TEXT,
  reject_code TEXT,
  reject_reason TEXT,
  fix_hint TEXT,
  superseded INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  submitted_at INTEGER,
  validated_at INTEGER,
  cancelled_at INTEGER,
  cancel_reason TEXT,
  retain_until TEXT NOT NULL
);
CREATE INDEX tax_documents_status ON tax_documents(status);
CREATE TRIGGER tax_documents_immutable BEFORE UPDATE OF seq, kind, number, uuid, adapter, payload, qr, total, vat, prev_hash, hash, created_at ON tax_documents
  BEGIN SELECT RAISE(ABORT, 'tax document content is immutable'); END;
CREATE TRIGGER tax_documents_no_delete BEFORE DELETE ON tax_documents
  BEGIN SELECT RAISE(ABORT, 'tax documents are kept for the retention period'); END;

-- Item code mapping keyed by sku (the sales items table is owned by sales).
CREATE TABLE tax_item_codes (
  sku TEXT PRIMARY KEY,
  code_type TEXT NOT NULL CHECK (code_type IN ('GS1','EGS')),
  code TEXT NOT NULL,
  updated_by INTEGER,
  updated_at INTEGER NOT NULL
);

-- Buyer tax ids by customer name (invoices only carry the customer name).
CREATE TABLE tax_parties (
  name TEXT PRIMARY KEY,
  tax_id TEXT NOT NULL,
  updated_by INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE tax_vat_rates (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  rate_bp INTEGER NOT NULL CHECK (rate_bp >= 0 AND rate_bp <= 10000),
  verified INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE tax_bill_tax (
  id INTEGER PRIMARY KEY,
  bill_id INTEGER NOT NULL UNIQUE REFERENCES bills(id),
  rate_code TEXT NOT NULL REFERENCES tax_vat_rates(code),
  vat INTEGER NOT NULL CHECK (vat >= 0),
  supplier_tax_id TEXT,
  invoice_ref TEXT,
  entry_id INTEGER REFERENCES journal_entries(id),
  created_by INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE tax_wizard_steps (
  step TEXT PRIMARY KEY,
  done_at INTEGER NOT NULL,
  note TEXT,
  done_by INTEGER
);

-- Encrypted at rest (AES-256-GCM). Never selected by any route.
CREATE TABLE tax_secrets (
  name TEXT PRIMARY KEY,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  updated_by INTEGER,
  updated_at INTEGER NOT NULL
);
`);
}
