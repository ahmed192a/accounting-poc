// Inventory: warehouses, units of measure, per-item stock settings (the sales module owns `items`; we extend
// through our own table keyed by sku) and an APPEND-ONLY stock movement table.
// Core tables (accounts, settings) are NOT touched here: accounts 1300/5300 are ensured by the seed and, for
// databases seeded before this module existed, lazily before the first posting (see ensureAccounts in service.js).
export const id = '200_inventory';

export function up(db) {
  db.exec(`
CREATE TABLE inventory_warehouses (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
INSERT INTO inventory_warehouses (code, name, name_ar, is_default) VALUES ('MAIN', 'Main warehouse', 'المخزن الرئيسي', 1);

CREATE TABLE inventory_units (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_ar TEXT NOT NULL
);
INSERT INTO inventory_units (code, name, name_ar) VALUES
  ('pcs', 'Piece', 'قطعة'), ('kg', 'Kilogram', 'كيلوجرام'), ('g', 'Gram', 'جرام'),
  ('l', 'Litre', 'لتر'), ('box', 'Box', 'علبة'), ('dozen', 'Dozen', 'دستة');

-- Per-item stock settings. track = 0 means "not a stock item" (services, loose goods): sales do not move stock.
CREATE TABLE inventory_item_settings (
  sku TEXT PRIMARY KEY,
  track INTEGER NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'pcs' REFERENCES inventory_units(code),
  barcode TEXT,
  reorder_level INTEGER NOT NULL DEFAULT 0,   -- low-stock alert when on hand <= this (0 = no alert)
  reorder_qty INTEGER NOT NULL DEFAULT 0,     -- suggested order quantity
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX inventory_item_barcode ON inventory_item_settings(barcode) WHERE barcode IS NOT NULL;

-- Append-only stock ledger. qty is signed (units, in the item's unit); value is the signed cost value in piastres
-- that moved the inventory asset (transfers net to zero). unit_cost is derived for display; value is the truth.
CREATE TABLE inventory_movements (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL,
  warehouse_id INTEGER NOT NULL REFERENCES inventory_warehouses(id),
  kind TEXT NOT NULL CHECK (kind IN ('purchase','sale','adjustment','transfer','return','count')),
  qty INTEGER NOT NULL CHECK (qty <> 0),
  unit_cost INTEGER NOT NULL DEFAULT 0,
  value INTEGER NOT NULL DEFAULT 0,
  flags TEXT NOT NULL DEFAULT '',             -- comma list: negative, cost_unknown
  ref_type TEXT,                              -- sale, invoice, receipt, count, transfer, ...
  ref_id INTEGER,
  entry_id INTEGER REFERENCES journal_entries(id),
  supplier TEXT,
  reason TEXT,
  created_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX inventory_movements_sku ON inventory_movements(sku, warehouse_id);
CREATE INDEX inventory_movements_ref ON inventory_movements(ref_type, ref_id);
CREATE TRIGGER inventory_movements_no_update BEFORE UPDATE ON inventory_movements
  BEGIN SELECT RAISE(ABORT, 'inventory_movements is append-only: post a correcting movement instead'); END;
CREATE TRIGGER inventory_movements_no_delete BEFORE DELETE ON inventory_movements
  BEGIN SELECT RAISE(ABORT, 'inventory_movements is append-only: post a correcting movement instead'); END;

-- Stock on hand per item and warehouse, derived from the movements (no cached counter that could drift).
DROP VIEW IF EXISTS inventory_stock_on_hand;
CREATE VIEW inventory_stock_on_hand AS
  SELECT sku, warehouse_id, SUM(qty) AS qty, SUM(value) AS value FROM inventory_movements GROUP BY sku, warehouse_id;

CREATE TABLE inventory_counts (
  id INTEGER PRIMARY KEY,
  warehouse_id INTEGER NOT NULL REFERENCES inventory_warehouses(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','posted','cancelled')),
  note TEXT,
  entry_id INTEGER,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  posted_by INTEGER,
  posted_at INTEGER
);
CREATE TABLE inventory_count_lines (
  count_id INTEGER NOT NULL REFERENCES inventory_counts(id),
  sku TEXT NOT NULL,
  expected_qty INTEGER NOT NULL,              -- snapshot when the sheet was created
  counted_qty INTEGER,                        -- NULL = not counted yet (skipped when posting)
  variance_qty INTEGER,                       -- filled when posted: counted minus on-hand at posting time
  PRIMARY KEY (count_id, sku)
);
`);
}
