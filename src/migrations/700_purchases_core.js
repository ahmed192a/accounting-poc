// Purchases: suppliers, purchase orders, bill lines/attachments, supplier payments, recurring bills.
// The original `bills` table has a CHECK that only allows two statuses, so it is rebuilt (data kept)
// with the full status flow: draft -> pending_approval -> approved -> partially_paid -> paid,
// plus rejected and void. `approved` still means "approved and posted to the ledger, nothing paid yet".
export const id = '700_purchases_core';

export function up(db) {
  // Databases adopted from before migrations (or stripped-down test fixtures) may lack the original table.
  db.exec(`CREATE TABLE IF NOT EXISTS bills (
    id INTEGER PRIMARY KEY, supplier TEXT NOT NULL, amount INTEGER NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL,
    created_by INTEGER NOT NULL, approved_by INTEGER, entry_id INTEGER, created_at INTEGER NOT NULL)`);
  db.exec(`
    CREATE TABLE purchases_suppliers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name_ar TEXT,
      tax_id TEXT,
      payment_terms_days INTEGER NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0 AND payment_terms_days <= 365),
      email TEXT,
      phone TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      auto_created INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE purchases_orders (
      id INTEGER PRIMARY KEY,
      number TEXT NOT NULL UNIQUE,
      supplier_id INTEGER NOT NULL REFERENCES purchases_suppliers(id),
      order_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open','partially_billed','billed','cancelled')),
      received_any INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_by INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE purchases_order_lines (
      id INTEGER PRIMARY KEY,
      po_id INTEGER NOT NULL REFERENCES purchases_orders(id),
      description TEXT NOT NULL,
      qty INTEGER NOT NULL CHECK (qty > 0),
      unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
      received_qty INTEGER NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
      billed_qty INTEGER NOT NULL DEFAULT 0 CHECK (billed_qty >= 0)
    );

    CREATE TABLE bills_new (
      id INTEGER PRIMARY KEY,
      supplier TEXT NOT NULL,
      amount INTEGER NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft','pending_approval','approved','partially_paid','paid','rejected','void')),
      created_by INTEGER NOT NULL,
      approved_by INTEGER,
      entry_id INTEGER REFERENCES journal_entries(id),
      created_at INTEGER NOT NULL,
      supplier_id INTEGER REFERENCES purchases_suppliers(id),
      po_id INTEGER REFERENCES purchases_orders(id),
      number TEXT,
      vat INTEGER NOT NULL DEFAULT 0 CHECK (vat >= 0),
      bill_date TEXT,
      due_date TEXT,
      paid INTEGER NOT NULL DEFAULT 0 CHECK (paid >= 0),
      source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','assist','recurring','po')),
      source_ref TEXT,
      match_status TEXT NOT NULL DEFAULT 'none' CHECK (match_status IN ('none','matched','override')),
      match_note TEXT,
      reject_reason TEXT,
      void_reason TEXT,
      void_entry_id INTEGER REFERENCES journal_entries(id)
    );
    INSERT INTO bills_new (id, supplier, amount, category, status, created_by, approved_by, entry_id, created_at)
      SELECT id, supplier, amount, category, status, created_by, approved_by, entry_id, created_at FROM bills;
    -- Drop first, then rename the new table into place: renaming the old one away would make SQLite
    -- rewrite foreign keys that other modules' tables may have to bills(id).
    DROP TABLE bills;
    ALTER TABLE bills_new RENAME TO bills;
    CREATE INDEX purchases_bills_supplier ON bills(supplier_id, status);

    CREATE TABLE purchases_bill_lines (
      id INTEGER PRIMARY KEY,
      bill_id INTEGER NOT NULL REFERENCES bills(id),
      po_line_id INTEGER REFERENCES purchases_order_lines(id),
      description TEXT NOT NULL,
      qty INTEGER NOT NULL CHECK (qty > 0),
      unit_price INTEGER NOT NULL CHECK (unit_price >= 0)
    );

    CREATE TABLE purchases_attachments (
      id INTEGER PRIMARY KEY,
      bill_id INTEGER NOT NULL REFERENCES bills(id),
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      data BLOB NOT NULL,
      uploaded_by INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    -- Export view: the same rows with the bytes as hex text, so the JSON export stays complete and valid.
    DROP VIEW IF EXISTS purchases_attachments_export;
    CREATE VIEW purchases_attachments_export AS
      SELECT id, bill_id, filename, mime, size, sha256, hex(data) AS data_hex, uploaded_by, created_at FROM purchases_attachments;

    CREATE TABLE purchases_payments (
      id INTEGER PRIMARY KEY,
      supplier_id INTEGER NOT NULL REFERENCES purchases_suppliers(id),
      amount INTEGER NOT NULL CHECK (amount > 0),
      method TEXT NOT NULL CHECK (method IN ('cash','bank','wallet')),
      paid_date TEXT NOT NULL,
      reference TEXT,
      status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
      entry_id INTEGER REFERENCES journal_entries(id),
      void_entry_id INTEGER REFERENCES journal_entries(id),
      void_reason TEXT,
      created_by INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE purchases_payment_allocations (
      id INTEGER PRIMARY KEY,
      payment_id INTEGER NOT NULL REFERENCES purchases_payments(id),
      bill_id INTEGER NOT NULL REFERENCES bills(id),
      amount INTEGER NOT NULL CHECK (amount > 0)
    );

    CREATE TABLE purchases_recurring (
      id INTEGER PRIMARY KEY,
      supplier_id INTEGER NOT NULL REFERENCES purchases_suppliers(id),
      description TEXT,
      amount INTEGER NOT NULL CHECK (amount > 0),
      vat INTEGER NOT NULL DEFAULT 0,
      category TEXT NOT NULL,
      frequency TEXT NOT NULL CHECK (frequency IN ('weekly','monthly')),
      anchor_day INTEGER NOT NULL,
      next_date TEXT NOT NULL,
      end_date TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      runs INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- Backfill: every existing bill gets a supplier row.
    INSERT OR IGNORE INTO purchases_suppliers (name, auto_created, created_at) SELECT DISTINCT supplier, 1, 0 FROM bills;
    UPDATE bills SET supplier_id = (SELECT id FROM purchases_suppliers s WHERE s.name = bills.supplier COLLATE NOCASE),
                     bill_date = date(created_at / 1000, 'unixepoch'),
                     due_date = date(created_at / 1000, 'unixepoch');
  `);
}
