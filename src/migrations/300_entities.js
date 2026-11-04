// Multi-entity, multi-currency and chart-of-accounts management.
// journal_entries.entity_id and journal_lines.currency already exist (001_core): this adds the entities
// table they point at, the foreign-amount columns on journal lines, rates, and account hierarchy.
// ALTER TABLE ADD COLUMN is not an UPDATE, so the append-only triggers stay untouched; defaults keep
// every existing row valid (entity 1, currency = the entity's own currency, no foreign amount).
export const id = '300_entities';

export function up(db) {
  db.exec(`
    -- A company or a branch. currency = the entity's functional currency: its journal debit/credit are in
    -- the minor units of that currency (EGP piastres for the default entity).
    CREATE TABLE entities (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      name_ar TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'company' CHECK (kind IN ('company','branch')),
      parent_id INTEGER REFERENCES entities(id),
      currency TEXT NOT NULL DEFAULT 'EGP' REFERENCES entities_currencies(code),
      fiscal_year_start_month INTEGER NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 0
    );

    -- An entity with no rows here is open to every user; once it has rows only those users (and holders of entities.manage) get in.
    CREATE TABLE entities_users (
      entity_id INTEGER NOT NULL REFERENCES entities(id),
      user_id INTEGER NOT NULL,
      PRIMARY KEY (entity_id, user_id)
    );

    -- Exchange rates. rate_micro = EGP per 1 whole unit of the currency, times 1,000,000 (integer, never a float).
    -- History is kept: a correction is a new row, the latest id for a date wins.
    CREATE TABLE entities_rates (
      id INTEGER PRIMARY KEY,
      currency TEXT NOT NULL REFERENCES entities_currencies(code),
      rate_date TEXT NOT NULL,
      rate_micro INTEGER NOT NULL CHECK (rate_micro > 0),
      source TEXT NOT NULL DEFAULT 'manual',
      created_by INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX entities_rates_lookup ON entities_rates (currency, rate_date, id);


    -- Intercompany transaction: two mirrored entries (one per entity) joined by this group row.
    CREATE TABLE entities_ic_groups (
      id INTEGER PRIMARY KEY,
      from_entity_id INTEGER NOT NULL REFERENCES entities(id),
      to_entity_id INTEGER NOT NULL REFERENCES entities(id),
      amount_from INTEGER NOT NULL,
      amount_to INTEGER NOT NULL,
      entry_date TEXT NOT NULL,
      memo TEXT NOT NULL DEFAULT '',
      from_entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
      to_entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
      created_by INTEGER,
      created_at INTEGER NOT NULL
    );

    -- Year-end closing entries (the entry itself is in the journal and is reversible like any other).
    CREATE TABLE entities_closings (
      id INTEGER PRIMARY KEY,
      entity_id INTEGER NOT NULL REFERENCES entities(id),
      fiscal_year INTEGER NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
      net_profit INTEGER NOT NULL,
      created_by INTEGER,
      created_at INTEGER NOT NULL
    );

    -- Created last on purpose: tables are dropped in creation order by the legacy-database test.
    CREATE TABLE entities_currencies (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_ar TEXT NOT NULL,
      minor_units INTEGER NOT NULL DEFAULT 2 CHECK (minor_units BETWEEN 0 AND 4),
      active INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO entities_currencies (code, name, name_ar, minor_units) VALUES
      ('EGP', 'Egyptian pound', 'الجنيه المصري', 2),
      ('USD', 'US dollar', 'الدولار الأمريكي', 2),
      ('EUR', 'Euro', 'اليورو', 2),
      ('SAR', 'Saudi riyal', 'الريال السعودي', 2),
      ('GBP', 'Pound sterling', 'الجنيه الإسترليني', 2),
      ('AED', 'UAE dirham', 'الدرهم الإماراتي', 2);
    INSERT INTO entities (id, code, name, name_ar, kind, currency) VALUES (1, 'MAIN', 'Main company', 'الشركة الرئيسية', 'company', 'EGP');

  `);

  // Guarded so the migration also applies to the stripped-down stand-in databases the migration tests build.
  const addColumn = (t, c, def) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
  const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  if (has('journal_lines')) {
    addColumn('journal_lines', 'fx_amount', 'INTEGER'); // foreign minor units (NULL = no foreign amount)
    addColumn('journal_lines', 'fx_rate', 'INTEGER');   // foreign -> entity currency, times 1,000,000
  }
  if (has('journal_entries')) db.exec('CREATE INDEX IF NOT EXISTS journal_entries_entity ON journal_entries (entity_id, entry_date)');
  if (has('accounts')) {
    addColumn('accounts', 'parent_id', 'INTEGER REFERENCES accounts(id)');
    addColumn('accounts', 'active', 'INTEGER NOT NULL DEFAULT 1');
  }
}
