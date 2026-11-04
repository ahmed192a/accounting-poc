import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError } from './helpers.js';
import { openDb, createContext } from '../src/db.js';
import { postEntry } from '../src/ledger.js';
import { createInvoice, payInvoice, quickSale } from '../src/modules/sales/service.js';
import { createBill } from '../src/modules/purchases/service.js';
import { runReport, parseParams } from '../src/modules/reports/service.js';
import { BUILDERS } from '../src/modules/reports/builders.js';

const find = (rep, key) => rep.rows.find((r) => r.key === key);

function business() {
  const { ctx, as } = setup();
  const clerk = as('clerk');
  postEntry(ctx, { userId: 1, date: '2026-01-01', memo: 'capital', lines: [{ account: '1000', debit: 5000000 }, { account: '3000', credit: 5000000 }], sourceType: 'manual' });
  const inv1 = createInvoice(ctx, clerk, { customer: 'Nile Traders', date: '2026-01-10', dueDate: '2026-01-25', lines: [{ description: 'Widget', qty: 2, unitPrice: 100000 }] });
  createInvoice(ctx, clerk, { customer: 'Cairo, "Best" Co', date: '2026-02-10', dueDate: '2026-03-10', lines: [{ description: 'Widget', qty: 1, unitPrice: 100000 }, { description: 'Gadget', qty: 3, unitPrice: 20000 }] });
  payInvoice(ctx, clerk, inv1.id);
  createBill(ctx, as('clerk'), { supplier: 'Delta Supply', amount: 30000, category: 'rent' });
  return { ctx, as, inv1 };
}

test('every report runs on a fresh seeded ledger with a title in both languages', () => {
  const { ctx, as } = setup();
  for (const b of BUILDERS) {
    const rep = runReport(ctx, as('owner'), b.name, {});
    assert.ok(rep.title.en && rep.title.ar, b.name);
    assert.ok(Array.isArray(rep.rows) && Array.isArray(rep.columns));
    for (const c of rep.checks) assert.ok(c.ok, `${b.name} ${c.id}`);
  }
});

test('empty ledger: no accounts and no entries still yields valid, zeroed reports', () => {
  const ctx = createContext(openDb(':memory:')); // migrated, never seeded: no accounts, no entries
  for (const b of BUILDERS) {
    const rep = b.build(ctx, parseParams(ctx, b, { from: '2026-01-01', to: '2026-12-31', account: undefined }));
    assert.ok(Array.isArray(rep.rows), b.name);
  }
  const tb = BUILDERS.find((b) => b.name === 'trial-balance').build(ctx, { to: '2026-01-01', entityId: null });
  assert.equal(tb.summary.totalDebit, 0);
  assert.ok(tb.summary.balanced);
});

test('empty period and unknown entity give zeros, not errors', () => {
  const { ctx, as } = setup();
  const pl = runReport(ctx, as('owner'), 'profit-loss', { from: '2000-01-01', to: '2000-12-31' });
  assert.equal(pl.summary.netProfit, 0);
  assert.equal(pl.summary.grossMarginPct, null);
  const bs = runReport(ctx, as('owner'), 'balance-sheet', { to: '2026-12-31', entityId: '999' });
  assert.equal(bs.summary.assets, 0);
  assert.ok(bs.summary.balanced);
  const day = runReport(ctx, as('owner'), 'sales-by-day', { from: '2000-01-01', to: '2000-01-31' });
  assert.equal(day.rows.length, 1); // just the total row
});

test('P&L, balance sheet with current-period profit, and cash flow on a small business', () => {
  const { ctx, as } = business();
  const pl = runReport(ctx, as('accountant'), 'profit-loss', { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(pl.summary.revenue, 200000 + 160000);
  assert.equal(pl.summary.expenses, 30000);
  assert.equal(pl.summary.netProfit, 330000);
  const bs = runReport(ctx, as('accountant'), 'balance-sheet', { to: '2026-12-31' });
  assert.equal(bs.summary.currentPeriodProfit, 330000);
  assert.ok(bs.summary.balanced);
  assert.equal(find(bs, 'current-profit').amount, 330000);
  const cf = runReport(ctx, as('accountant'), 'cash-flow', { from: '2026-01-01', to: '2026-12-31' });
  assert.ok(cf.checks[0].ok);
  const pay = find(cf, 's:payment');
  assert.equal(pay.inflow, 228000); // invoice 1 incl. VAT paid
  assert.equal(find(cf, 's:manual').inflow, 5000000);
});

test('comparison periods: previous, same period last year and custom line rows up by key', () => {
  const { ctx, as } = business();
  const u = as('owner');
  const prev = runReport(ctx, u, 'profit-loss', { from: '2026-02-01', to: '2026-02-28', compare: 'previous' });
  assert.deepEqual(prev.params.compare, { mode: 'previous', from: '2026-01-04', to: '2026-01-31' });
  const rev = find(prev, 't:rev');
  assert.equal(rev.amount, 160000);
  assert.equal(rev.amountPrev, 200000);
  assert.equal(rev.amountChange, -40000);
  assert.ok(prev.columns.some((c) => c.key === 'amountChange'));
  const yoy = runReport(ctx, u, 'profit-loss', { from: '2027-01-01', to: '2027-03-31', compare: 'year' });
  assert.equal(yoy.params.compare.from, '2026-01-01');
  assert.equal(find(yoy, 't:rev').amount, 0);
  assert.equal(find(yoy, 't:rev').amountPrev, 360000);
  const custom = runReport(ctx, u, 'trial-balance', { to: '2026-02-28', compare: 'custom', compareFrom: '2026-01-01', compareTo: '2026-01-31' });
  assert.ok(find(custom, '1200').debitBalanceChange > 0 || find(custom, '1200').creditBalanceChange !== undefined);
  expectError(() => runReport(ctx, u, 'profit-loss', { compare: 'custom' }), 'BAD_DATE');
  expectError(() => runReport(ctx, u, 'profit-loss', { compare: 'sometimes' }), 'BAD_INPUT');
});

test('AR aging buckets by days past due and reconciles to account 1200; paid invoices drop out', () => {
  const { ctx, as } = business();
  const ar = runReport(ctx, as('manager'), 'ar-aging', { to: '2026-05-01' }); // payment is dated later (demo clock)
  const cairo = ar.rows.find((r) => r.name.startsWith('Cairo'));
  assert.equal(cairo.d31_60, 182400); // 52 days past due, incl. 14% VAT
  assert.equal(ar.rows.find((r) => r.name === 'Nile Traders').d90p, 228000);
  assert.ok(ar.checks[0].ok);
  const early = runReport(ctx, as('manager'), 'ar-aging', { to: '2026-01-20' });
  assert.equal(early.rows.find((r) => r.name === 'Nile Traders').current, 228000);
  assert.ok(!early.rows.some((r) => r.name.startsWith('Cairo')), 'not yet issued');
  const late = runReport(ctx, as('manager'), 'ar-aging', { to: '2026-12-31' });
  assert.ok(!late.rows.some((r) => r.name === 'Nile Traders'), 'paid invoice is not outstanding');
  assert.equal(late.rows.find((r) => r.name.startsWith('Cairo')).d90p, 182400);
  assert.ok(late.checks[0].ok);
});

test('AP aging, sales by item/customer, and VAT summary on a small business', () => {
  const { ctx, as } = business();
  const u = as('owner');
  quickSale(ctx, as('clerk'), { items: [{ sku: ctx.db.prepare('SELECT sku FROM items LIMIT 1').get().sku, qty: 2 }] });
  const ap = runReport(ctx, u, 'ap-aging', {});
  assert.equal(find(ap, 'Delta Supply').total, 30000);
  assert.ok(ap.checks[0].ok);
  const items = runReport(ctx, u, 'sales-by-item', { from: '2026-01-01', to: '2099-12-31' });
  const widget = find(items, 'Widget');
  assert.equal(widget.qty, 3);
  assert.equal(widget.amount, 300000);
  const cust = runReport(ctx, u, 'sales-by-customer', { from: '2026-01-01', to: '2099-12-31' });
  assert.equal(find(cust, 'Nile Traders').subtotal, 200000);
  assert.ok(cust.rows.some((r) => r.name.startsWith('Walk-in')));
  const vat = runReport(ctx, u, 'vat-summary', { from: '2026-01-01', to: '2026-03-31', period: 'month' });
  assert.equal(vat.rows.length, 4); // Jan Feb Mar + total
  assert.equal(vat.rows[0].outputVat, 28000);
  assert.equal(vat.rows[0].taxableSales, 200000);
  assert.equal(vat.summary.inputVatAccountPresent, false);
});

test('general ledger drill-down: running balance, paging, entry detail, account transactions filters', () => {
  const { ctx, as } = business();
  const u = as('auditor');
  const gl = runReport(ctx, u, 'general-ledger', { account: '1200', from: '2026-01-01', to: '2026-12-31', limit: 2 });
  assert.equal(gl.summary.hasMore, true);
  assert.equal(gl.rows.filter((r) => r.kind === 'line').length, 2);
  const page2 = runReport(ctx, u, 'general-ledger', { account: '1200', from: '2026-01-01', to: '2026-12-31', limit: 2, offset: 2 });
  assert.equal(page2.rows.at(-1).kind, 'total');
  assert.equal(page2.rows[0].balance, gl.rows.at(-1).balance + (page2.rows[0].debit - page2.rows[0].credit));
  const entryId = gl.rows.find((r) => r.kind === 'line').entryId;
  const tx = runReport(ctx, u, 'account-transactions', { account: '4000', q: 'Invoice for Nile', from: '2026-01-01', to: '2026-12-31' });
  assert.equal(tx.rows.filter((r) => r.kind === 'line').length, 1);
  assert.equal(tx.rows[0].counter, '1200 2100');
  const big = runReport(ctx, u, 'account-transactions', { account: '1200', min: '250000', from: '2026-01-01', to: '2026-12-31' });
  assert.ok(big.rows.filter((r) => r.kind === 'line').every((r) => r.debit + r.credit >= 250000));
  assert.ok(entryId > 0);
  expectError(() => runReport(ctx, u, 'general-ledger', { account: '9999' }), 'UNKNOWN_ACCOUNT');
});

test('validation: bad dates, range, format, limit and unknown report', () => {
  const { ctx, as } = setup();
  const u = as('owner');
  expectError(() => runReport(ctx, u, 'profit-loss', { from: '2026-13-01' }), 'BAD_DATE');
  expectError(() => runReport(ctx, u, 'profit-loss', { from: '2026-05-02', to: '2026-05-01' }), 'BAD_RANGE');
  expectError(() => runReport(ctx, u, 'profit-loss', { format: 'pdf' }), 'BAD_FORMAT');
  expectError(() => runReport(ctx, u, 'nope', {}), 'UNKNOWN_REPORT');
  expectError(() => runReport(ctx, u, 'general-ledger', { limit: '0' }), 'BAD_INPUT');
  expectError(() => runReport(ctx, u, 'vat-summary', { period: 'week' }), 'BAD_INPUT');
  expectError(() => runReport(ctx, u, 'trial-balance', { entityId: 'x' }), 'BAD_INPUT');
});
