// Sales core schema: customers, numbering sequences and additive columns on the core invoices,
// sales and items tables. Everything is additive: old rows keep working.
export const id = '800_sales_core';

const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const hasCol = (db, t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c);

// Idempotent and tolerant: re-running on a database that already has the column (or lacks the table) is a no-op.
function addColumns(db, table, defs) {
  if (!hasTable(db, table)) return;
  for (const def of defs) {
    const col = def.split(' ')[0];
    if (!hasCol(db, table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`);
  }
}

export function up(db) {
  db.exec(`
CREATE TABLE sales_customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  tax_id TEXT,
  address TEXT,
  credit_limit INTEGER NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),  -- piastres; 0 = no limit
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE UNIQUE INDEX sales_customers_active_name ON sales_customers (lower(name)) WHERE active = 1;

CREATE TABLE sales_sequences (
  name TEXT PRIMARY KEY,            -- invoice | quote | credit_note
  prefix TEXT NOT NULL,
  padding INTEGER NOT NULL,
  next_no INTEGER NOT NULL
);
INSERT INTO sales_sequences (name, prefix, padding, next_no) VALUES ('invoice', 'INV-', 4, 1), ('quote', 'QUO-', 4, 1), ('credit_note', 'CN-', 4, 1);

`);

  addColumns(db, 'invoices', [
    'customer_id INTEGER',
    "status TEXT NOT NULL DEFAULT 'issued'",   // draft issued partially_paid paid void
    'amount_paid INTEGER NOT NULL DEFAULT 0',
    'amount_credited INTEGER NOT NULL DEFAULT 0',
    'notes TEXT',
    'quote_id INTEGER',
    'entry_reversed INTEGER NOT NULL DEFAULT 0',
    'credit_override_reason TEXT',
  ]);
  if (hasTable(db, 'invoices')) {
    db.exec("UPDATE invoices SET status = 'paid', amount_paid = total WHERE paid = 1 AND status = 'issued'");
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS sales_invoice_number ON invoices (number) WHERE number IS NOT NULL');
    // legacy numbers were INV-<id>: continue after the highest id so a number is never reused
    db.exec("UPDATE sales_sequences SET next_no = (SELECT COALESCE(MAX(id), 0) + 1 FROM invoices) WHERE name = 'invoice'");
  }
  addColumns(db, 'items', ['active INTEGER NOT NULL DEFAULT 1']);
  addColumns(db, 'sales', [
    'discount_type TEXT', 'discount_value INTEGER', 'discount_amount INTEGER NOT NULL DEFAULT 0',
    'refunded INTEGER NOT NULL DEFAULT 0', 'refund_entry_id INTEGER', 'refund_reason TEXT', 'refunded_at INTEGER', 'refunded_by INTEGER',
  ]);
}
