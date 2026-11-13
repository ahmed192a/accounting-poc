import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, BUSY_TIMEOUT_MS } from '../src/db.js';

const pragma = (db, name) => Object.values(db.prepare(`PRAGMA ${name}`).get())[0];

test('openDb: a file database uses write-ahead logging and a busy timeout; they persist across reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'poc-wal-'));
  try {
    const path = join(dir, 'a.db');
    let db = openDb(path);
    assert.equal(pragma(db, 'journal_mode'), 'wal');
    assert.equal(pragma(db, 'busy_timeout'), BUSY_TIMEOUT_MS);
    assert.ok(BUSY_TIMEOUT_MS >= 1000);
    db.close();
    db = openDb(path, { busyTimeoutMs: 1234 });
    assert.equal(pragma(db, 'journal_mode'), 'wal');
    assert.equal(pragma(db, 'busy_timeout'), 1234);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('openDb: an in-memory database still opens (WAL does not apply) and gets the busy timeout', () => {
  const db = openDb();
  assert.equal(pragma(db, 'journal_mode'), 'memory');
  assert.equal(pragma(db, 'busy_timeout'), BUSY_TIMEOUT_MS);
  db.close();
});

test('openDb: a blocked second writer waits for the busy timeout before failing, and fails at once with none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'poc-busy-'));
  try {
    const path = join(dir, 'b.db');
    const a = openDb(path), waits = openDb(path, { busyTimeoutMs: 300 }), instant = openDb(path, { busyTimeoutMs: 0 });
    a.exec('BEGIN IMMEDIATE');
    let t = Date.now();
    assert.throws(() => instant.exec('BEGIN IMMEDIATE'), /locked|busy/i);
    assert.ok(Date.now() - t < 100, 'no timeout: immediate failure');
    t = Date.now();
    assert.throws(() => waits.exec('BEGIN IMMEDIATE'), /locked|busy/i);
    assert.ok(Date.now() - t >= 250, 'timeout: it waited before giving up');
    a.exec('ROLLBACK');
    waits.exec('BEGIN IMMEDIATE'); waits.exec('ROLLBACK'); // free again
    a.close(); waits.close(); instant.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
