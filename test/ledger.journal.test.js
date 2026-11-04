import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError } from './helpers.js';
import { postEntry, reverseEntry, setPeriodLock, trialBalance, accountBalance, isoDate } from '../src/ledger.js';

test('unbalanced and malformed entries are rejected', () => {
  const { ctx } = setup();
  expectError(() => postEntry(ctx, { userId: 1, lines: [{ account: '1000', debit: 100 }, { account: '4000', credit: 90 }] }), 'UNBALANCED');
  expectError(() => postEntry(ctx, { userId: 1, lines: [{ account: '1000', debit: 100 }] }), 'BAD_ENTRY');
  expectError(() => postEntry(ctx, { userId: 1, lines: [{ account: '1000', debit: 1.5 }, { account: '4000', credit: 1.5 }] }), 'BAD_LINE');
  expectError(() => postEntry(ctx, { userId: 1, lines: [{ account: '9999', debit: 100 }, { account: '4000', credit: 100 }] }), 'UNKNOWN_ACCOUNT');
});

test('a failed post leaves nothing behind (atomic)', () => {
  const { ctx } = setup();
  const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n;
  expectError(() => postEntry(ctx, { userId: 1, lines: [{ account: '1000', debit: 100 }, { account: '9999', credit: 100 }] }), 'UNKNOWN_ACCOUNT');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, before);
});

test('the database itself refuses to edit or delete the journal and the audit log', () => {
  const { ctx } = setup();
  for (const sql of [
    'UPDATE journal_entries SET memo = \'x\'',
    'DELETE FROM journal_entries',
    'UPDATE journal_lines SET debit = 1',
    'DELETE FROM journal_lines',
    'UPDATE audit_log SET action = \'x\'',
    'DELETE FROM audit_log',
  ]) {
    assert.throws(() => ctx.db.exec(sql), /append-only/, sql);
  }
});

test('reversal nets the entry to zero, records a reason, and cannot be repeated', () => {
  const { ctx } = setup();
  const e = postEntry(ctx, { userId: 4, memo: 'Mistake', lines: [{ account: '5100', debit: 5000 }, { account: '1000', credit: 5000 }] });
  const cashBefore = accountBalance(ctx.db, '1000').net;
  const rev = reverseEntry(ctx, 4, e.id, 'Posted to the wrong account');
  assert.equal(accountBalance(ctx.db, '1000').net, cashBefore + 5000);
  assert.equal(accountBalance(ctx.db, '5100').net, 0);
  assert.equal(ctx.db.prepare('SELECT reverses_id, reason FROM journal_entries WHERE id = ?').get(rev.id).reverses_id, e.id);
  expectError(() => reverseEntry(ctx, 4, e.id, 'again'), 'ALREADY_REVERSED');
  expectError(() => reverseEntry(ctx, 4, rev.id, 'undo the undo'), 'CANNOT_REVERSE_REVERSAL');
  expectError(() => reverseEntry(ctx, 4, e.id, ''), 'REASON_REQUIRED');
  assert.ok(trialBalance(ctx.db).balanced);
});

test('hard lock blocks posting into the locked period', () => {
  const { ctx } = setup();
  const today = isoDate(ctx.now());
  setPeriodLock(ctx, 2, today, 'hard', 'Month closed');
  expectError(() => postEntry(ctx, { userId: 4, lines: [{ account: '5100', debit: 100 }, { account: '1000', credit: 100 }] }), 'PERIOD_LOCKED');
  // a date after the lock is fine
  const next = isoDate(ctx.now() + 2 * 86400000);
  assert.ok(postEntry(ctx, { userId: 4, date: next, lines: [{ account: '5100', debit: 100 }, { account: '1000', credit: 100 }] }).id);
});

test('soft lock warns first, then needs a confirmation and a reason', () => {
  const { ctx } = setup();
  setPeriodLock(ctx, 2, isoDate(ctx.now()), 'soft', 'Review period');
  const entry = { userId: 4, lines: [{ account: '5100', debit: 100 }, { account: '1000', credit: 100 }] };
  expectError(() => postEntry(ctx, entry), 'SOFT_LOCK_WARNING');
  expectError(() => postEntry(ctx, { ...entry, confirmSoftLock: true }), 'REASON_REQUIRED');
  assert.ok(postEntry(ctx, { ...entry, confirmSoftLock: true, reason: 'Late supplier invoice' }).id);
});

test('period lock changes need a reason and are audited', () => {
  const { ctx } = setup();
  expectError(() => setPeriodLock(ctx, 2, '2026-01-31', 'hard', ''), 'REASON_REQUIRED');
  setPeriodLock(ctx, 2, '2026-01-31', 'hard', 'Year end');
  setPeriodLock(ctx, 2, null, 'none', 'Reopen for audit adjustment');
  const rows = ctx.db.prepare("SELECT reason FROM audit_log WHERE action = 'period.lock' ORDER BY id").all();
  assert.deepEqual(rows.map((r) => r.reason), ['Year end', 'Reopen for audit adjustment']);
});

test('every posted entry is in the audit log with who, when and what', () => {
  const { ctx } = setup();
  const e = postEntry(ctx, { userId: 4, memo: 'Rent', lines: [{ account: '5100', debit: 7000 }, { account: '1000', credit: 7000 }] });
  const row = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'entry.posted' AND record_id = ?").get(e.id);
  assert.equal(row.user_id, 4);
  assert.ok(row.ts > 0);
  assert.equal(JSON.parse(row.new_value).memo, 'Rent');
});
