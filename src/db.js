import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

// Money is stored as integer piastres (1 EGP = 100). Never floats.
// The schema lives in src/migrations/NNN_name.js (see docs/ARCHITECTURE.md for the numbering ranges).

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const MIGRATION_FILE = /^(\d{3})_[a-z0-9_]+\.js$/;

/**
 * Discover migrations in a folder: every NNN_name.js exporting `id` (equal to the file name without
 * .js) and `up(db)`. Returned in filename order. Throws on a bad name, a mismatched id or a
 * duplicate number, so two agents picking the same number fail loudly instead of silently.
 */
export async function loadMigrations(dir = MIGRATIONS_DIR) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  const seen = new Map();
  const out = [];
  for (const file of files) {
    const m = MIGRATION_FILE.exec(file);
    if (!m) throw new Error(`Migration file "${file}" must be named NNN_name.js (three digits, lowercase name)`);
    if (seen.has(m[1])) throw new Error(`Migrations ${seen.get(m[1])} and ${file} use the same number ${m[1]}`);
    seen.set(m[1], file);
    const mod = await import(pathToFileURL(join(dir, file)).href);
    const id = file.slice(0, -3);
    if (mod.id !== id) throw new Error(`Migration ${file} must export id = '${id}' (got ${JSON.stringify(mod.id)})`);
    if (typeof mod.up !== 'function') throw new Error(`Migration ${file} must export function up(db)`);
    out.push({ id, up: mod.up });
  }
  return out;
}

const DEFAULT_MIGRATIONS = await loadMigrations();

/**
 * Apply every migration not yet recorded in schema_migrations, in filename order, each in its own
 * transaction. Running it again is a no-op. Returns the ids applied by this call.
 */
export function runMigrations(db, migrations = DEFAULT_MIGRATIONS) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const done = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
  // A database created before migrations existed already has the core schema: adopt it, do not recreate it.
  if (done.size === 0 && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'accounts'").get()) {
    db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('001_core', Date.now());
    done.add('001_core');
  }
  const applied = [];
  for (const m of [...migrations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (done.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(m.id, Date.now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${m.id} failed: ${e.message}`, { cause: e });
    }
    applied.push(m.id);
  }
  return applied;
}

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  runMigrations(db);
  return db;
}

export function createContext(db, registry = null) {
  const ctx = { db, registry, offsetMs: 0, now: () => Date.now() + ctx.offsetMs };
  return ctx;
}

export const setting = (db, key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
