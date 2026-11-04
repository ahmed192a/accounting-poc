// Reports: read-path indexes on the ledger (indexes only, no ledger rows touched) and saved report filters.
export const id = '600_reports';

export function up(db) {
  db.exec(`
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_date ON journal_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_journal_entries_source ON journal_entries(source_type, source_id);

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
