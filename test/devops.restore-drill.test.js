import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runDrill, restoreAndFingerprint, compare } from '../scripts/restore-drill.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'poc-drill-test-'));

test('restore drill: a tenant backup restores into a fresh database with the same audit chain head and ledger totals', () => {
  const work = tmp();
  try {
    const r = runDrill({ work });
    assert.deepEqual(r.checks.filter((c) => !c.ok), []);
    assert.equal(r.ok, true);
    assert.equal(r.restored.audit.head, r.source.audit.head);
    assert.equal(r.restored.ledger.totalDebit, r.source.ledger.totalDebit);
    assert.equal(r.restored.ledger.totalDebit, r.restored.ledger.totalCredit);
    assert.ok(r.restored.ledger.lines >= 50 && r.restored.audit.sealed > 25);
    assert.notEqual(r.backup.restoredTo, r.backup.file, 'restored into a different file');
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('restore drill: it fails when a restored audit row was altered or a ledger line was changed (the drill can detect damage)', () => {
  const work = tmp();
  try {
    const r = runDrill({ work });
    const damaged = (sql) => {
      const copy = join(work, `damaged-${Math.random().toString(36).slice(2)}.db`);
      copyFileSync(r.backup.file, copy);
      const raw = new DatabaseSync(copy);
      raw.exec('DROP TRIGGER al_no_update; DROP TRIGGER jl_no_update;'); // an attacker with file access is not stopped by triggers
      raw.exec(sql);
      raw.close();
      return restoreAndFingerprint(copy, join(work, `r-${Math.random().toString(36).slice(2)}`)).fp;
    };
    const auditTampered = compare(damaged("UPDATE audit_log SET action = 'x' WHERE id = 3"), r.source);
    assert.equal(auditTampered.find((c) => c.name.startsWith('audit hash chain')).ok, false);
    const ledgerTampered = compare(damaged('UPDATE journal_lines SET debit = debit + 1 WHERE id = 1'), r.source);
    assert.equal(ledgerTampered.find((c) => c.name.startsWith('ledger is balanced')).ok, false);
    assert.equal(ledgerTampered.find((c) => c.name.startsWith('ledger total')).ok, false);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('restore drill: restoring never overwrites an existing file', () => {
  const work = tmp();
  try {
    const r = runDrill({ work });
    assert.throws(() => restoreAndFingerprint(r.backup.file, join(work, 'restore')), /Refusing to restore over/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
