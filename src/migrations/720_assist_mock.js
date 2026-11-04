// Assist (MOCK AI): intake queue with suggestions, and learned supplier -> category rules.
export const id = '720_assist_mock';

export function up(db) {
  db.exec(`
    CREATE TABLE assist_items (
      id INTEGER PRIMARY KEY,
      raw_text TEXT NOT NULL,
      provider TEXT NOT NULL,
      suggestion TEXT NOT NULL,       -- JSON { supplier, date, total, vat, currency, category }
      confidence TEXT NOT NULL,       -- JSON field -> 0..1
      reasons TEXT NOT NULL,          -- JSON field -> plain-language reason
      status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','undone')),
      outcome TEXT CHECK (outcome IN ('unchanged','edited')),   -- set when accepted
      final_fields TEXT,              -- JSON of what was actually used for the bill
      bill_id INTEGER,
      reject_reason TEXT,
      undo_reason TEXT,
      created_by INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      reviewed_by INTEGER,
      reviewed_at INTEGER
    );
    CREATE TABLE assist_rules (
      id INTEGER PRIMARY KEY,
      supplier_key TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      hits INTEGER NOT NULL DEFAULT 1,
      updated_by INTEGER,
      updated_at INTEGER NOT NULL
    );
  `);
}
