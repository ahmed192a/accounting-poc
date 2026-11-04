import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectError } from './helpers.js';
import { bank, b, MAP, csv } from './banking.fixtures.js';

test('banking: seeded accounts are linked to ledger accounts 1000, 1010, 1020', () => {
  const { ctx, as } = bank();
  const accts = b.listAccounts(ctx, as('manager'));
  assert.deepEqual(accts.map((a) => [a.type, a.ledgerCode]).sort(), [['bank', '1010'], ['cash', '1000'], ['wallet', '1020']]);
  assert.ok(ctx.db.prepare("SELECT 1 FROM accounts WHERE code = '1010'").get());
  assert.ok(ctx.db.prepare("SELECT 1 FROM accounts WHERE code = '1020'").get());
});

test('banking: a second bank account gets its own sub-account so balances stay exact', () => {
  const { ctx, accountant } = bank();
  const a = b.createAccount(ctx, accountant, { name: 'CIB savings', type: 'bank' });
  assert.equal(a.ledgerCode, '1010-2');
  const row = ctx.db.prepare("SELECT type FROM accounts WHERE code = '1010-2'").get();
  assert.equal(row.type, 'asset');
  expectError(() => b.createAccount(ctx, accountant, { name: 'X', type: 'bank', ledgerCode: '1010' }), 'LEDGER_ACCOUNT_IN_USE');
  expectError(() => b.createAccount(ctx, accountant, { name: 'X', type: 'bank', ledgerCode: '4000' }), 'BAD_INPUT');
  expectError(() => b.createAccount(ctx, accountant, { name: 'X', type: 'crypto' }), 'BAD_INPUT');
});

test('banking: preview stages rows, commit activates them, nothing is visible before commit', () => {
  const { ctx, acct, accountant, lines } = bank();
  const text = '﻿Date,Description,Reference,Amount\r\n2026-02-01,"Transfer, Acme Ltd",R1,"1,500.00"\r\n2026-02-02,Fee,R2,-25\r\n';
  const p = b.createImport(ctx, accountant, { accountId: acct.id, csv: text, mapping: MAP, filename: 'feb.csv' });
  assert.equal(p.status, 'preview');
  assert.equal(p.goodRows, 2);
  assert.equal(p.lines[0].description, 'Transfer, Acme Ltd');
  assert.equal(p.lines[0].amount, 150000);
  assert.equal(lines().length, 0, 'staged rows are not statement lines yet');
  const c = b.commitImport(ctx, accountant, p.id);
  assert.equal(c.status, 'committed');
  assert.equal(lines().length, 2);
  expectError(() => b.commitImport(ctx, accountant, p.id), 'BAD_STATE');
});

test('banking: Arabic-Indic digits in dates and amounts import correctly', () => {
  const { ctx, acct, accountant, load, lines } = bank();
  const text = 'التاريخ,البيان,المبلغ\n٠١/٠٣/٢٠٢٦,إيداع نقدي,"١٬٢٥٠٫٧٥"\n';
  const p = b.createImport(ctx, accountant, { accountId: acct.id, csv: text, mapping: { dateCol: 'التاريخ', dateFormat: 'DD/MM/YYYY', descriptionCol: 'البيان', amountCol: 'المبلغ' } });
  b.commitImport(ctx, accountant, p.id);
  const l = lines()[0];
  assert.deepEqual([l.date, l.amount, l.description], ['2026-03-01', 125075, 'إيداع نقدي']);
  void load;
});

test('banking: re-importing the same file adds nothing (dedupe by row hash)', () => {
  const { ctx, acct, accountant, load, lines } = bank();
  const rows = [['2026-02-01', 'Coffee', 'A', '-5'], ['2026-02-01', 'Coffee', 'A', '-5'], ['2026-02-02', 'Rent', 'B', '-100']];
  load(rows);
  assert.equal(lines().length, 3, 'two identical rows in ONE file are both kept');
  const again = b.createImport(ctx, accountant, { accountId: acct.id, csv: csv(rows), mapping: MAP });
  assert.equal(again.duplicateRows, 3);
  assert.equal(again.goodRows, 0);
  expectError(() => b.commitImport(ctx, accountant, again.id), 'NOTHING_TO_COMMIT');
  assert.equal(lines().length, 3);
  // an overlapping file adds only the new row
  const overlap = b.createImport(ctx, accountant, { accountId: acct.id, csv: csv([...rows, ['2026-02-03', 'New', 'C', '9']]), mapping: MAP });
  assert.equal(overlap.goodRows, 1);
  b.commitImport(ctx, accountant, overlap.id);
  assert.equal(lines().length, 4);
});

test('banking: malformed rows are reported with row numbers; commit needs skipErrors', () => {
  const { ctx, acct, accountant, lines } = bank();
  const text = csv([['2026-02-01', 'ok', 'a', '10'], ['2026-13-40', 'bad date', 'b', '5'], ['2026-02-03', 'bad amount', 'c', 'x1']]);
  const p = b.createImport(ctx, accountant, { accountId: acct.id, csv: text, mapping: MAP });
  assert.equal(p.errorRows, 2);
  assert.deepEqual(p.errors.map((e) => e.row), [3, 4]);
  const err = expectError(() => b.commitImport(ctx, accountant, p.id), 'HAS_ERRORS');
  assert.match(err.message, /2 row/);
  assert.equal(lines().length, 0);
  b.commitImport(ctx, accountant, p.id, { skipErrors: true });
  assert.equal(lines().length, 1);
});

test('banking: bad mappings and oversized input are refused', () => {
  const { ctx, acct, accountant } = bank();
  expectError(() => b.createImport(ctx, accountant, { accountId: acct.id, csv: csv([['2026-01-01', 'x', 'y', '1']]), mapping: { dateCol: 'Nope', amountCol: 'Amount' } }), 'BAD_MAPPING');
  expectError(() => b.createImport(ctx, accountant, { accountId: acct.id, csv: csv([['2026-01-01', 'x', 'y', '1']]) }), 'BAD_MAPPING');
  expectError(() => b.createImport(ctx, accountant, { accountId: acct.id, csv: '   ', mapping: MAP }), 'BAD_INPUT');
  expectError(() => b.createImport(ctx, accountant, { accountId: 999, csv: 'a', mapping: MAP }), 'NOT_FOUND');
  expectError(() => b.createImport(ctx, accountant, { accountId: acct.id, csv: 'x'.repeat(1_000_000), mapping: MAP }), 'TOO_LARGE');
});

test('banking: rollback marks lines void (never deletes), is audited, and the file can be re-imported', () => {
  const { ctx, acct, accountant, load, lines } = bank();
  const rows = [['2026-02-01', 'A', 'r1', '10'], ['2026-02-02', 'B', 'r2', '20']];
  const batch = load(rows);
  expectError(() => b.rollbackImport(ctx, accountant, batch.id, {}), 'BAD_INPUT');
  const rb = b.rollbackImport(ctx, accountant, batch.id, { reason: 'Wrong account' });
  assert.equal(rb.status, 'rolled_back');
  assert.equal(lines().length, 0);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM bank_lines WHERE status = 'void'").get().n, 2, 'rows still exist, marked void');
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'banking.import_rolled_back' AND reason = 'Wrong account'").get());
  expectError(() => b.rollbackImport(ctx, accountant, batch.id, { reason: 'again' }), 'BAD_STATE');
  const again = b.createImport(ctx, accountant, { accountId: acct.id, csv: csv(rows), mapping: MAP });
  assert.equal(again.goodRows, 2, 'void rows do not block a re-import');
});

test('banking: rollback is refused (and changes nothing) while a line of the batch is reconciled', () => {
  const { ctx, as, accountant, load, lines } = bank();
  const batch = load([['2026-02-01', 'Bank fee', 'f', '-30'], ['2026-02-02', 'Other', 'o', '-40']]);
  const fee = lines().find((l) => l.description === 'Bank fee');
  b.createEntryFromLine(ctx, accountant, fee.id, { accountCode: '5200' });
  expectError(() => b.rollbackImport(ctx, accountant, batch.id, { reason: 'oops' }), 'ROLLBACK_BLOCKED');
  assert.equal(lines().length, 2, 'atomic: nothing was voided');
  assert.equal(b.getImport(ctx, as('owner'), batch.id).status, 'committed');
});

test('banking: a failing hook during commit rolls the whole commit back', () => {
  const { ctx, acct, accountant, lines } = bank();
  const p = b.createImport(ctx, accountant, { accountId: acct.id, csv: csv([['2026-02-01', 'A', 'r', '10']]), mapping: MAP });
  const real = ctx.registry;
  ctx.registry = { ...real, hooks: { ...real.hooks, 'banking.imported': [{ module: 'test', fn() { throw new Error('boom'); } }] } };
  assert.throws(() => b.commitImport(ctx, accountant, p.id), /boom/);
  ctx.registry = real;
  assert.equal(lines().length, 0);
  assert.equal(b.getImport(ctx, accountant, p.id).status, 'preview', 'batch is still a preview');
  assert.equal(b.commitImport(ctx, accountant, p.id).status, 'committed');
});

test('banking: opening balance is derived from a running-balance column when unambiguous', () => {
  const { ctx, acct, accountant } = bank();
  const text = 'Date,Description,Amount,Balance\n2026-03-01,Dep,1000.00,6000.00\n2026-03-02,Fee,-10.00,5990.00\n';
  const p = b.createImport(ctx, accountant, { accountId: acct.id, csv: text, mapping: { dateCol: 'Date', descriptionCol: 'Description', amountCol: 'Amount', balanceCol: 'Balance' } });
  b.commitImport(ctx, accountant, p.id);
  const a = b.listAccounts(ctx, accountant).find((x) => x.id === acct.id);
  assert.equal(a.openingBalance, 500000);
});
