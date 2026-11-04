import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError } from './helpers.js';
import { postEntry, setPeriodLock, trialBalance, accountBalance, profitAndLoss } from '../src/ledger.js';
import * as ent from '../src/modules/entities/service.js';
import * as closing from '../src/modules/ledger/closing.js';

const year2025 = (ctx) => {
  postEntry(ctx, { userId: 4, date: '2025-03-01', lines: [{ account: '1000', debit: 900000 }, { account: '4000', credit: 900000 }] });
  postEntry(ctx, { userId: 4, date: '2025-04-01', lines: [{ account: '5100', debit: 250000 }, { account: '1000', credit: 250000 }] });
};
const opts = { entityId: 1, to: '2025-12-31' };

test('closing: revenue and expenses move to 3000 as an ordinary balanced entry dated year end', () => {
  const { ctx, as } = setup();
  year2025(ctx);
  const before3000 = accountBalance(ctx.db, '3000').net;
  const r = closing.closeYear(ctx, as('manager'), { fiscalYear: 2025 });
  assert.deepEqual([r.periodStart, r.periodEnd, r.netProfit], ['2025-01-01', '2025-12-31', 650000]);
  const pl = profitAndLoss(ctx.db, opts);
  assert.equal(pl.totalRevenue, 0);
  assert.equal(pl.totalExpenses, 0);
  assert.equal(accountBalance(ctx.db, '3000').net, before3000 - 650000);
  const e = ctx.db.prepare('SELECT entry_date, source_type FROM journal_entries WHERE id = ?').get(r.entryId);
  assert.deepEqual([e.entry_date, e.source_type], ['2025-12-31', 'year_close']);
  assert.ok(trialBalance(ctx.db).balanced);
  assert.equal(JSON.parse(ctx.db.prepare("SELECT new_value FROM audit_log WHERE action = 'year.closed'").get().new_value).netProfit, 650000);
});

test('closing: the closing entry is reversible, the year can then be closed again, and the books balance throughout', () => {
  const { ctx, as } = setup();
  year2025(ctx);
  const r = closing.closeYear(ctx, as('owner'), { fiscalYear: 2025 });
  expectError(() => closing.closeYear(ctx, as('owner'), { fiscalYear: 2025 }), 'ALREADY_CLOSED');
  expectError(() => closing.reverseClosing(ctx, as('owner'), r.id, ' '), 'REASON_REQUIRED');
  closing.reverseClosing(ctx, as('owner'), r.id, 'Late invoice to book');
  assert.equal(closing.listClosings(ctx, as('auditor'), 1)[0].reversed, true);
  assert.equal(accountBalance(ctx.db, '4000').net, -900000, 'P&L is back');
  assert.ok(trialBalance(ctx.db).balanced);
  // nothing double counted when closing again: the first closing and its reversal are ignored
  postEntry(ctx, { userId: 4, date: '2025-11-01', lines: [{ account: '5200', debit: 50000 }, { account: '1000', credit: 50000 }] });
  const again = closing.closeYear(ctx, as('owner'), { fiscalYear: 2025 });
  assert.equal(again.netProfit, 600000);
  assert.equal(profitAndLoss(ctx.db, opts).netProfit, 0);
  expectError(() => closing.reverseClosing(ctx, as('owner'), r.id, 'second reversal'), 'ALREADY_REVERSED');
});

test('closing: permission, timing and empty-year guards', () => {
  const { ctx, as } = setup();
  year2025(ctx);
  expectError(() => closing.closeYear(ctx, as('accountant'), { fiscalYear: 2025 }), 'FORBIDDEN');
  expectError(() => closing.closeYear(ctx, as('clerk'), { fiscalYear: 2025 }), 'FORBIDDEN');
  expectError(() => closing.closeYear(ctx, as('manager'), { fiscalYear: 2999 }), 'YEAR_NOT_ENDED');
  expectError(() => closing.closeYear(ctx, as('manager'), { fiscalYear: 2020 }), 'NOTHING_TO_CLOSE');
  expectError(() => closing.closeYear(ctx, as('manager'), { fiscalYear: 'abc' }), 'BAD_INPUT');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM entities_closings').get().n, 0);
});

test('closing: a hard period lock refuses it and leaves no closing row behind (atomic)', () => {
  const { ctx, as } = setup();
  year2025(ctx);
  setPeriodLock(ctx, 2, '2025-12-31', 'hard', 'Audit');
  const entries = ctx.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n;
  expectError(() => closing.closeYear(ctx, as('manager'), { fiscalYear: 2025 }), 'PERIOD_LOCKED');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, entries);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM entities_closings').get().n, 0);
});

test('closing: a loss debits 3000, a non-calendar fiscal year uses its own dates, and entities close independently', () => {
  const { ctx, as } = setup();
  const b = ent.createEntity(ctx, as('owner'), { code: 'B', name: 'Branch B', fiscalYearStartMonth: 7 }).id;
  postEntry(ctx, { userId: 4, entityId: b, date: '2025-02-01', lines: [{ account: '5100', debit: 80000 }, { account: '1000', credit: 80000 }] });   // FY2025 (Jul 2024 - Jun 2025)
  postEntry(ctx, { userId: 4, entityId: b, date: '2025-08-01', lines: [{ account: '1000', debit: 99000 }, { account: '4000', credit: 99000 }] });  // FY2026
  const r = closing.closeYear(ctx, as('owner'), { entityId: b, fiscalYear: 2025 });
  assert.deepEqual([r.periodStart, r.periodEnd, r.netProfit], ['2024-07-01', '2025-06-30', -80000]);
  assert.equal(accountBalance(ctx.db, '3000', { entityId: b }).net, 80000);
  assert.equal(accountBalance(ctx.db, '4000', { entityId: b }).net, -99000, 'the next fiscal year is untouched');
  assert.equal(accountBalance(ctx.db, '5100', { entityId: 1 }).net, 0);
  assert.ok(trialBalance(ctx.db, { entityId: b }).balanced);
  ent.setEntityUsers(ctx, as('owner'), b, [1]);
  expectError(() => closing.closeYear(ctx, as('manager'), { entityId: b, fiscalYear: 2026 }), 'ENTITY_FORBIDDEN');
  expectError(() => ent.setFiscal(ctx, as('owner'), b, { startMonth: 1 }), 'FISCAL_LOCKED');
});
