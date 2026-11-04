import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectError } from './helpers.js';
import { bank, b, journalOn, createInvoice, createBill } from './banking.fixtures.js';
import { postEntry } from '../src/ledger.js';
import { setPeriodLock } from '../src/ledger.js';

const invoice = (ctx, as, customer, price = 10000) =>
  createInvoice(ctx, as('clerk'), { customer, lines: [{ description: 'Service', qty: 1, unitPrice: price }] }); // total = price * 1.14

test('matching: invoice suggestion has confidence and reasons (amount, reference, customer)', () => {
  const { ctx, as, load, lines } = bank();
  const inv = invoice(ctx, as, 'Nile Trading Co');
  const other = invoice(ctx, as, 'Delta Foods');
  load([['2026-02-10', `Transfer from Nile Trading ${inv.number}`, 'X1', (inv.total / 100).toFixed(2)]]);
  const s = b.lineSuggestions(ctx, as('accountant'), lines()[0].id).suggestions;
  assert.equal(s[0].kind, 'invoice');
  assert.equal(s[0].refId, inv.id);
  assert.ok(s[0].confidence >= 90, `confidence ${s[0].confidence}`);
  assert.ok(s[0].reasons.some((r) => r.includes(inv.number)));
  assert.ok(s[0].reasons.some((r) => r.includes('Nile Trading')));
  const second = s.find((x) => x.refId === other.id);
  assert.ok(second.confidence < s[0].confidence, 'same amount but no reference or name: ranked lower');
});

test('matching: accepting an invoice posts Dr bank / Cr receivable, links it, and signals the invoice owner', () => {
  const { ctx, as, accountant, load, lines } = bank();
  const inv = invoice(ctx, as, 'Nile Trading');
  load([['2026-02-10', 'Nile Trading payment', 'p1', (inv.total / 100).toFixed(2)]]);
  const seen = [];
  const real = ctx.registry;
  ctx.registry = { ...real, hooks: { ...real.hooks, 'banking.invoice_settled': [{ module: 't', fn: (_c, p) => seen.push(p) }] } };
  const m = b.acceptMatch(ctx, accountant, lines()[0].id, { kind: 'invoice', refId: inv.id });
  ctx.registry = real;
  assert.equal(m.status, 'accepted');
  assert.equal(seen[0].id, inv.id);
  const j = journalOn(ctx, '1010');
  assert.equal(j.length, 1);
  assert.equal(j[0].debit, inv.total);
  assert.equal(lines('reconciled').length, 1);
  assert.equal(lines('unreconciled').length, 0);
  // the invoice no longer appears as a candidate for another identical line
  load([['2026-02-11', 'Nile Trading payment again', 'p2', (inv.total / 100).toFixed(2)]]);
  const again = b.lineSuggestions(ctx, accountant, lines('unreconciled')[0].id).suggestions;
  assert.ok(!again.some((x) => x.kind === 'invoice'));
  expectError(() => b.acceptMatch(ctx, accountant, lines('unreconciled')[0].id, { kind: 'invoice', refId: inv.id }), 'ALREADY_SETTLED');
});

test('matching: amount mismatch cannot be accepted as an invoice settlement', () => {
  const { ctx, accountant, load, lines, as } = bank();
  const inv = invoice(ctx, as, 'Nile Trading');
  load([['2026-02-10', 'Short payment', 'p', '10.00']]);
  expectError(() => b.acceptMatch(ctx, accountant, lines()[0].id, { kind: 'invoice', refId: inv.id }), 'AMOUNT_MISMATCH');
  assert.equal(journalOn(ctx, '1010').length, 0);
});

test('matching: approved bills match outgoing lines; pending bills do not', () => {
  const { ctx, as, accountant, load, lines } = bank();
  const bill = createBill(ctx, as('clerk'), { supplier: 'Cairo Paper', amount: 45000, category: 'purchases' });
  assert.equal(bill.status, 'approved');
  const pending = createBill(ctx, as('clerk'), { supplier: 'Big Supplier', amount: 150000, category: 'purchases' });
  assert.equal(pending.status, 'pending_approval');
  load([['2026-02-12', `Cairo Paper BILL-${bill.id}`, 'o1', '-450.00'], ['2026-02-12', 'Big Supplier', 'o2', '-1500.00']]);
  const [big, cairo] = [lines().find((l) => l.description === 'Big Supplier'), lines().find((l) => l.description.startsWith('Cairo'))];
  const s = b.lineSuggestions(ctx, accountant, cairo.id).suggestions[0];
  assert.deepEqual([s.kind, s.refId], ['bill', bill.id]);
  assert.ok(s.confidence >= 90);
  assert.equal(b.lineSuggestions(ctx, accountant, big.id).suggestions.length, 0);
  expectError(() => b.acceptMatch(ctx, accountant, big.id, { kind: 'bill', refId: pending.id }), 'NOT_APPROVED');
  b.acceptMatch(ctx, accountant, cairo.id, { kind: 'bill', refId: bill.id });
  const j = journalOn(ctx, '1010');
  assert.equal(j[0].credit, 45000);
  assert.ok(journalOn(ctx, '2000').some((x) => x.debit === 45000));
});

test('matching: unreconciled ledger entries are suggested; accept links without posting', () => {
  const { ctx, as, accountant, load, lines } = bank();
  postEntry(ctx, { userId: 4, date: '2026-02-05', memo: 'Deposit from owner', lines: [{ account: '1010', debit: 80000 }, { account: '3000', credit: 80000 }] });
  postEntry(ctx, { userId: 4, date: '2026-02-05', memo: 'Another deposit', lines: [{ account: '1010', debit: 70000 }, { account: '3000', credit: 70000 }] });
  load([['2026-02-06', 'Deposit owner', 'd', '800.00']]);
  const s = b.lineSuggestions(ctx, accountant, lines()[0].id).suggestions;
  assert.equal(s.length, 1);
  assert.equal(s[0].kind, 'ledger');
  assert.ok(s[0].reasons.join(' ').includes('Shared words'));
  const before = journalOn(ctx, '1010').length;
  b.acceptMatch(ctx, accountant, lines()[0].id, { kind: 'ledger', refId: s[0].refId });
  assert.equal(journalOn(ctx, '1010').length, before, 'nothing new posted');
  void as;
});

test('matching: reject hides a suggestion; unreconcile is audited and reversible', () => {
  const { ctx, as, accountant, load, lines } = bank();
  postEntry(ctx, { userId: 4, date: '2026-02-05', memo: 'Deposit', lines: [{ account: '1010', debit: 5000 }, { account: '3000', credit: 5000 }] });
  load([['2026-02-05', 'Deposit', 'd', '50.00']]);
  const id = lines()[0].id;
  const s = b.lineSuggestions(ctx, accountant, id).suggestions[0];
  b.rejectMatch(ctx, accountant, id, { kind: 'ledger', refId: s.refId });
  assert.equal(b.lineSuggestions(ctx, accountant, id).suggestions.length, 0);
  // manual reconcile needs a reason
  expectError(() => b.manualReconcile(ctx, accountant, id, { journalLineId: s.refId }), 'BAD_INPUT');
  b.manualReconcile(ctx, accountant, id, { journalLineId: s.refId, reason: 'Checked against the paying-in slip' });
  assert.equal(lines('reconciled').length, 1);
  expectError(() => b.unreconcile(ctx, accountant, id, {}), 'BAD_INPUT');
  b.unreconcile(ctx, accountant, id, { reason: 'Wrong slip' });
  assert.equal(lines('unreconciled').length, 1);
  const log = ctx.db.prepare("SELECT action, reason FROM audit_log WHERE record_type = 'bank_line' ORDER BY id").all().map((r) => r.action);
  assert.ok(['banking.suggestion_rejected', 'banking.reconciled', 'banking.unreconciled'].every((a) => log.includes(a)));
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM bank_matches').get().n, 2, 'history rows kept: rejected + undone');
  // it can be reconciled again
  b.manualReconcile(ctx, accountant, id, { journalLineId: s.refId, reason: 'Slip found' });
  assert.equal(lines('reconciled').length, 1);
  void as;
});

test('matching: unreconciling a settlement reverses its entry (never deletes) and the invoice becomes available again', () => {
  const { ctx, as, accountant, load, lines } = bank();
  const inv = invoice(ctx, as, 'Nile Trading');
  load([['2026-02-10', 'Nile Trading', 'p', (inv.total / 100).toFixed(2)]]);
  const id = lines()[0].id;
  const m = b.acceptMatch(ctx, accountant, id, { kind: 'invoice', refId: inv.id });
  const entriesBefore = ctx.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n;
  const events = [];
  const real = ctx.registry;
  ctx.registry = { ...real, hooks: { ...real.hooks, 'banking.settlement_reversed': [{ module: 't', fn: (_c, p) => events.push(p) }] } };
  const r = b.unreconcile(ctx, accountant, id, { reason: 'Customer bounced' });
  ctx.registry = real;
  assert.ok(r.reversalEntryId);
  assert.equal(events.length, 1);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, entriesBefore + 1);
  assert.equal(ctx.db.prepare('SELECT reverses_id FROM journal_entries WHERE id = ?').get(r.reversalEntryId).reverses_id, m.entryId);
  assert.equal(b.lineSuggestions(ctx, accountant, id).suggestions[0].refId, inv.id);
  // the reversed pair does not clutter the unreconciled ledger list
  assert.equal(b.unreconciledLedger(ctx.db, '1010').length, 0);
});

test('matching: only one statement line can claim a ledger line', () => {
  const { ctx, accountant, load, lines } = bank();
  postEntry(ctx, { userId: 4, date: '2026-02-05', memo: 'Deposit', lines: [{ account: '1010', debit: 5000 }, { account: '3000', credit: 5000 }] });
  load([['2026-02-05', 'Deposit', 'a', '50.00'], ['2026-02-05', 'Deposit', 'b', '50.00']]);
  const [l1, l2] = lines();
  const ref = b.lineSuggestions(ctx, accountant, l1.id).suggestions[0].refId;
  b.acceptMatch(ctx, accountant, l1.id, { kind: 'ledger', refId: ref });
  expectError(() => b.acceptMatch(ctx, accountant, l2.id, { kind: 'ledger', refId: ref }), 'NOT_AVAILABLE');
  expectError(() => b.acceptMatch(ctx, accountant, l1.id, { kind: 'ledger', refId: ref }), 'ALREADY_RECONCILED');
});

test('create entry: fee line posts through the ledger, balances, and reconciles the line', () => {
  const { ctx, accountant, load, lines } = bank();
  load([['2026-02-28', 'Monthly account fee', 'fee', '-35.00'], ['2026-02-28', 'Interest credit', 'int', '12.34']]);
  const fee = lines().find((l) => l.amount === -3500), interest = lines().find((l) => l.amount === 1234);
  const e1 = b.createEntryFromLine(ctx, accountant, fee.id, { accountCode: '5200', memo: 'Bank fees' });
  b.createEntryFromLine(ctx, accountant, interest.id, { accountCode: '4000' });
  const j = journalOn(ctx, '1010');
  assert.deepEqual(j.map((x) => [x.debit, x.credit]), [[0, 3500], [1234, 0]]);
  assert.equal(ctx.db.prepare('SELECT source_type FROM journal_entries WHERE id = ?').get(e1.entryId).source_type, 'bank_line');
  assert.equal(lines('reconciled').length, 2);
  expectError(() => b.createEntryFromLine(ctx, accountant, fee.id, { accountCode: '5200' }), 'ALREADY_RECONCILED');
  assert.equal(ctx.db.prepare('SELECT SUM(debit) - SUM(credit) AS d FROM journal_lines').get().d, 0);
});

test('create entry: hard period lock refuses and leaves no entry, match or reconciled flag behind', () => {
  const { ctx, as, accountant, load, lines } = bank();
  load([['2026-01-15', 'Old fee', 'f', '-20.00']]);
  setPeriodLock(ctx, as('manager').id, '2026-01-31', 'hard', 'January closed');
  const id = lines()[0].id;
  const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n;
  expectError(() => b.createEntryFromLine(ctx, accountant, id, { accountCode: '5200' }), 'PERIOD_LOCKED');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, before);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM bank_matches').get().n, 0);
  assert.equal(lines('unreconciled').length, 1);
  // a dated-after-the-lock entry is allowed
  b.createEntryFromLine(ctx, accountant, id, { accountCode: '5200', date: '2026-02-01' });
  assert.equal(lines('reconciled').length, 1);
});

test('create entry: soft lock needs confirmation and a reason; invoice accept respects the lock too', () => {
  const { ctx, as, accountant, load, lines } = bank();
  const inv = invoice(ctx, as, 'Nile');
  load([['2026-01-15', 'Nile', 'f', (inv.total / 100).toFixed(2)], ['2026-01-16', 'Fee', 'g', '-5']]);
  setPeriodLock(ctx, as('manager').id, '2026-01-31', 'soft', 'Soft close');
  const [fee, pay] = [lines().find((l) => l.amount < 0), lines().find((l) => l.amount > 0)];
  expectError(() => b.createEntryFromLine(ctx, accountant, fee.id, { accountCode: '5200' }), 'SOFT_LOCK_WARNING');
  expectError(() => b.createEntryFromLine(ctx, accountant, fee.id, { accountCode: '5200', confirmSoftLock: true }), 'REASON_REQUIRED');
  b.createEntryFromLine(ctx, accountant, fee.id, { accountCode: '5200', confirmSoftLock: true, reason: 'Late statement' });
  setPeriodLock(ctx, as('manager').id, '2026-01-31', 'hard', 'Hard close');
  expectError(() => b.acceptMatch(ctx, accountant, pay.id, { kind: 'invoice', refId: inv.id }), 'PERIOD_LOCKED');
  assert.equal(lines('reconciled').length, 1);
});
