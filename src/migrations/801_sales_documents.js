// Sales documents: payments with allocations, credit notes, quotes, parked (held) sales.
export const id = '801_sales_documents';

const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);

export function up(db) {
  db.exec(`
CREATE TABLE sales_payments (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER,
  customer TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL,                       -- cash | bank | wallet
  pay_date TEXT NOT NULL,
  reference TEXT,
  entry_id INTEGER REFERENCES journal_entries(id),
  status TEXT NOT NULL DEFAULT 'posted',      -- posted | reversed (only through a ledger reversal)
  created_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE sales_payment_allocations (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES sales_payments(id),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  amount INTEGER NOT NULL CHECK (amount > 0)
);
CREATE INDEX sales_alloc_invoice ON sales_payment_allocations (invoice_id);

CREATE TABLE sales_credit_notes (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  customer_id INTEGER,
  customer TEXT NOT NULL,
  lines TEXT NOT NULL,
  subtotal INTEGER NOT NULL CHECK (subtotal > 0),
  vat INTEGER NOT NULL CHECK (vat >= 0),
  total INTEGER NOT NULL,
  reason TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  voids_invoice INTEGER NOT NULL DEFAULT 0,
  entry_id INTEGER REFERENCES journal_entries(id),
  status TEXT NOT NULL DEFAULT 'issued',     -- issued | reversed (only through a ledger reversal)
  created_by INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE sales_quotes (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER,
  customer TEXT NOT NULL,
  lines TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  vat INTEGER NOT NULL,
  total INTEGER NOT NULL,
  issue_date TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',       -- open | accepted | declined | converted (expired is derived)
  invoice_id INTEGER,
  notes TEXT,
  created_by INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE sales_parked (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  items TEXT NOT NULL,
  discount TEXT,
  status TEXT NOT NULL DEFAULT 'held',       -- held | sold | discarded
  sale_id INTEGER,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`);

  // Legacy invoices paid before payments were tracked: give them a payment row so statements are complete.
  if (!hasTable(db, 'invoices') || !hasTable(db, 'journal_entries')) return;
  if (db.prepare('SELECT 1 FROM sales_payments LIMIT 1').get()) return;
  db.exec(`
INSERT INTO sales_payments (customer_id, customer, amount, method, pay_date, entry_id, created_by, created_at)
  SELECT NULL, i.customer, i.total, 'cash',
         COALESCE((SELECT e.entry_date FROM journal_entries e WHERE e.source_type = 'payment' AND e.source_id = i.id LIMIT 1), i.issue_date),
         (SELECT e.id FROM journal_entries e WHERE e.source_type = 'payment' AND e.source_id = i.id LIMIT 1),
         i.created_by, 0
  FROM invoices i WHERE i.paid = 1;
INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount)
  SELECT p.id, i.id, i.total FROM invoices i
  JOIN sales_payments p ON p.entry_id = (SELECT e.id FROM journal_entries e WHERE e.source_type = 'payment' AND e.source_id = i.id LIMIT 1)
  WHERE i.paid = 1;
`);
}
