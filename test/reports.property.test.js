import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { randomEntries, rng } from './reports.helpers.js';
import { runReport } from '../src/modules/reports/service.js';

const SEEDS = [11, 22, 33, 44, 55];
const total = (rep, key) => rep.rows.find((r) => r.key === key);

test('property: random balanced entries -> trial balance balances and balance sheet balances on any date', () => {
  for (const seed of SEEDS) {
    const { ctx, as } = setup();
    const u = as('owner');
    randomEntries(ctx, seed, 120);
    const r = rng(seed);
    for (let i = 0; i < 6; i++) {
      const to = `${2025 + Math.floor(r() * 2)}-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`;
      const tb = runReport(ctx, u, 'trial-balance', { to });
      assert.equal(tb.summary.totalDebit, tb.summary.totalCredit, `seed ${seed} ${to}`);
      assert.ok(tb.checks[0].ok);
      const row = total(tb, 'total');
      assert.equal(row.debitBalance, row.creditBalance);
      const bs = runReport(ctx, u, 'balance-sheet', { to });
      assert.equal(bs.summary.difference, 0, `seed ${seed} ${to}`);
      assert.equal(bs.summary.assets, bs.summary.liabilities + bs.summary.equity);
      assert.equal(total(bs, 't:check').amount, 0);
    }
  }
});

test('property: P&L ties to an independent SQL sum of revenue and expense lines', () => {
  for (const seed of SEEDS) {
    const { ctx, as } = setup();
    randomEntries(ctx, seed, 120);
    const q = (type, from, to) => ctx.db.prepare(`SELECT COALESCE(SUM(l.credit - l.debit),0) AS v FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.id=l.account_id WHERE a.type=? AND e.entry_date>=? AND e.entry_date<=?`).get(type, from, to).v;
    const from = '2025-03-01', to = '2026-02-28';
    const pl = runReport(ctx, as('accountant'), 'profit-loss', { from, to });
    assert.equal(pl.summary.revenue, q('revenue', from, to));
    assert.equal(pl.summary.cogs + pl.summary.expenses, -q('expense', from, to));
    assert.equal(pl.summary.netProfit, q('revenue', from, to) + q('expense', from, to));
    assert.equal(total(pl, 't:net').amount, pl.summary.netProfit);
    // sales by day total equals revenue, vat total equals ledger 2100
    const days = runReport(ctx, as('owner'), 'sales-by-day', { from, to });
    assert.equal(total(days, 'total').amount, pl.summary.revenue);
    const vat = runReport(ctx, as('owner'), 'vat-summary', { from, to, period: 'quarter' });
    const v2100 = ctx.db.prepare(`SELECT COALESCE(SUM(l.credit-l.debit),0) v FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.id=l.account_id WHERE a.code='2100' AND e.entry_date>=? AND e.entry_date<=?`).get(from, to).v;
    assert.equal(vat.summary.outputVat, v2100);
    assert.equal(vat.summary.netVat, v2100);
  }
});

test('property: general ledger running balance, cash flow and aging tie to the ledger', () => {
  const { ctx, as } = setup();
  const u = as('owner');
  randomEntries(ctx, 77, 150);
  for (const code of ['1000', '1200', '4000']) {
    const gl = runReport(ctx, u, 'general-ledger', { account: code, from: '2025-01-01', to: '2026-12-31', limit: 10000 });
    const lines = gl.rows.filter((x) => x.kind === 'line');
    const tb = runReport(ctx, u, 'trial-balance', { to: '2026-12-31' }).rows.find((x) => x.key === code);
    assert.equal(gl.summary.closing, tb.debit - tb.credit);
    let run = gl.summary.opening;
    for (const l of lines) { run += l.debit - l.credit; assert.equal(l.balance, run); }
    assert.equal(run, gl.summary.closing);
  }
  assert.ok(runReport(ctx, u, 'cash-flow', { from: '2025-06-01', to: '2026-03-31' }).checks[0].ok);
  assert.ok(runReport(ctx, u, 'ar-aging', { to: '2026-03-31' }).checks[0].ok);
  assert.ok(runReport(ctx, u, 'ap-aging', { to: '2026-03-31' }).checks[0].ok);
});
