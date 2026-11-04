import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, runMigrations, loadMigrations, MIGRATIONS_DIR } from '../src/db.js';

const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);

function tempMigrations(files) {
  const dir = mkdtempSync(join(tmpdir(), 'poc-mig-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}
const mig = (id, sql) => `export const id = '${id}'; export function up(db) { db.exec(${JSON.stringify(sql)}); }`;

test('migrations: all real migrations apply in filename order and are recorded', async () => {
  const list = await loadMigrations(MIGRATIONS_DIR);
  assert.deepEqual(list.map((m) => m.id), [...list.map((m) => m.id)].sort());
  assert.equal(list[0].id, '001_core');
  const db = new DatabaseSync(':memory:');
  assert.deepEqual(runMigrations(db), list.map((m) => m.id));
  assert.deepEqual(db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((r) => r.id), list.map((m) => m.id));
  assert.ok(tables(db).includes('journal_entries'));
});

test('migrations: running twice is a no-op', () => {
  const db = new DatabaseSync(':memory:');
  const first = runMigrations(db);
  assert.ok(first.length >= 1);
  const stamp = db.prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id').all();
  assert.deepEqual(runMigrations(db), []);
  assert.deepEqual(db.prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id').all(), stamp);
});

test('migrations: reopening a database file applies only what is new and keeps data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'poc-db-'));
  const path = join(dir, 'x.db');
  try {
    const db1 = openDb(path);
    db1.prepare("INSERT INTO settings (key, value) VALUES ('k', 'v')").run();
    db1.close();
    const db2 = openDb(path);
    assert.equal(db2.prepare("SELECT value FROM settings WHERE key = 'k'").get().value, 'v');
    assert.deepEqual(runMigrations(db2), []);
    // a migration added later (say by the banking agent, range 100-199) is applied on the next start
    const extra = tempMigrations({ '100_banking_probe.js': mig('100_banking_probe', 'CREATE TABLE banking_probe (id INTEGER PRIMARY KEY)') });
    const all = [...(await loadMigrations(MIGRATIONS_DIR)), ...(await loadMigrations(extra))];
    assert.deepEqual(runMigrations(db2, all), ['100_banking_probe']);
    assert.deepEqual(runMigrations(db2, all), []);
    assert.ok(tables(db2).includes('banking_probe'));
    db2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migrations: applied in filename order regardless of how they are listed; a failing one rolls back and is not recorded', async () => {
  const dir = tempMigrations({
    '010_b.js': mig('010_b', 'CREATE TABLE b (id INTEGER)'),
    '005_a.js': mig('005_a', 'CREATE TABLE a (id INTEGER)'),
    '020_bad.js': mig('020_bad', 'CREATE TABLE half (id INTEGER); THIS IS NOT SQL'),
  });
  const list = await loadMigrations(dir);
  assert.deepEqual(list.map((m) => m.id), ['005_a', '010_b', '020_bad']);
  const db = new DatabaseSync(':memory:');
  assert.throws(() => runMigrations(db, [...list].reverse()), /020_bad/);
  assert.deepEqual(db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((r) => r.id), ['005_a', '010_b']);
  assert.ok(!tables(db).includes('half'), 'the failed migration left nothing behind');
});

test('migrations: bad file names, mismatched ids and duplicate numbers are rejected', async () => {
  await assert.rejects(loadMigrations(tempMigrations({ 'oops.js': '' })), /NNN_name\.js/);
  await assert.rejects(loadMigrations(tempMigrations({ '010_x.js': mig('010_y', 'SELECT 1') })), /must export id/);
  await assert.rejects(loadMigrations(tempMigrations({ '010_x.js': 'export const id = "010_x";' })), /function up/);
  await assert.rejects(loadMigrations(tempMigrations({ '010_x.js': mig('010_x', 'SELECT 1'), '010_y.js': mig('010_y', 'SELECT 1') })), /same number/);
});

test('migrations: a database that predates the migration table is adopted, not recreated', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE accounts (id INTEGER PRIMARY KEY)'); // stand-in for a pre-migration database
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const applied = runMigrations(db);
  assert.ok(!applied.includes('001_core'));
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = '001_core'").get());
});

test('migrations: the append-only triggers survive the move into 001_core', () => {
  const db = openDb();
  db.prepare("INSERT INTO journal_entries (entry_date, created_at) VALUES ('2026-01-01', 0)").run();
  assert.throws(() => db.prepare("UPDATE journal_entries SET memo = 'x'").run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM journal_entries').run(), /append-only/);
  db.prepare("INSERT INTO audit_log (ts, action) VALUES (0, 'a')").run();
  assert.throws(() => db.prepare('DELETE FROM audit_log').run(), /append-only/);
});
