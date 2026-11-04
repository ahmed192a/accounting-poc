// Reports: read-path indexes on the ledger (indexes only, no ledger rows touched) and saved report filters.
export const id = '600_reports';

const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

export function up(db) {
  // A pre-migration stand-in database (see core.migrations tests) may lack the ledger tables: skip the indexes then.
  if (hasTable(db, 'journal_lines') && hasTable(db, 'journal_entries')) {
    db.exec(`
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_date ON journal_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_journal_entries_source ON journal_entries(source_type, source_id);`);
  }
  db.exec(`

CREATE TABLE reports_saved_filters (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  report TEXT NOT NULL,
  name TEXT NOT NULL,
  params TEXT NOT NULL,                 -- JSON object of whitelisted report parameters
  shared INTEGER NOT NULL DEFAULT 0,    -- 1 = visible to every user who can see reports
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, report, name)
);
`);
}
