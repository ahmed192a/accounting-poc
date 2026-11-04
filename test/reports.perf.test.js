import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { rng, pad } from './reports.helpers.js';
import { runReport } from '../src/modules/reports/service.js';
import { BUILDERS } from '../src/modules/reports/builders.js';

// 20,000 generated entries (plus invoices, sales and bills so the document reports have data), inserted
// directly in one transaction (the append-only triggers only block UPDATE and DELETE).
function generate(ctx, n) {
  const { db } = ctx;
  const r = rng(2026);
  const acc = Object.fromEntries(db.prepare('SELECT code, id FROM accounts').all().map((a) => [a.code, a.id]));
  const insE = db.prepare('INSERT INTO journal_entries (entry_date, memo, source_type, source_id, created_by, created_at, entity_id) VALUES (?,?,?,?,1,0,?)');
  const insL = db.prepare('INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES (?,?,?,?)');
  const insI = db.prepare('INSERT INTO invoices (number, customer, lines, subtotal, vat, total, issue_date, due_date, paid, entry_id, created_by) VALUES (?,?,?,?,?,?,?,?,0,?,1)');
  const insB = db.prepare("INSERT INTO bills (supplier, amount, category, status, created_by, entry_id, created_at) VALUES (?,?,'rent','approved',1,?,0)");
  db.exec('BEGIN');
  for (let i = 0; i < n; i++) {
    const m = 1 + Math.floor(r() * 24), y = 2025 + Math.floor((m - 1) / 12);
    const date = `${y}-${pad(((m - 1) % 12) + 1)}-${pad(1 + Math.floor(r() * 28))}`;
    const amt = 100 + Math.floor(r() * 900000);
    const kind = i % 4;
    const ent = 1 + (i % 3 === 0 ? 1 : 0);
    const e = (type, sid) => Number(insE.run(date, `generated ${i}`, type, sid, ent).lastInsertRowid);
    if (kind === 0) { // invoice
      const vat = Math.round(amt * 0.14);
      const id = e('invoice', null);
      insL.run(id, acc['1200'], amt + vat, 0); insL.run(id, acc['4000'], 0, amt); insL.run(id, acc['2100'], 0, vat);
      insI.run(`INV-G${i}`, `Customer ${i % 150}`, JSON.stringify([{ description: `Item ${i % 40}`, qty: 1, unitPrice: amt }]), amt, vat, amt + vat, date, date, id);
    } else if (kind === 1) { // bill
      const id = e('bill', null);
      insL.run(id, acc['5100'], amt, 0); insL.run(id, acc['2000'], 0, amt);
      insB.run(`Supplier ${i % 60}`, amt, id);
    } else if (kind === 2) { // payment / sale in cash
      const id = e('sale', null);
      insL.run(id, acc['1000'], amt, 0); insL.run(id, acc['4000'], 0, amt);
    } else { // expense paid in cash
      const id = e('manual', null);
      insL.run(id, acc['5200'], amt, 0); insL.run(id, acc['1000'], 0, amt);
    }
  }
  db.exec('COMMIT');
}

test('performance: every report finishes in under 2 seconds on 20,000 entries', () => {
  const { ctx, as } = setup();
  generate(ctx, 20000);
  assert.ok(ctx.db.prepare('SELECT COUNT(*) n FROM journal_entries').get().n >= 20000);
  for (const idx of ['idx_journal_lines_account', 'idx_journal_entries_date']) {
    assert.ok(ctx.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(idx), idx);
  }
  const u = as('owner');
  const slow = [];
  const cases = [
    ...BUILDERS.map((b) => [b.name, b.name === 'general-ledger' || b.name === 'account-transactions' ? { account: '1000' } : {}]),
    ['general-ledger', {}], ['account-transactions', {}], ['profit-loss', { compare: 'previous' }], ['trial-balance', { entityId: '1' }],
    ['ar-aging', { to: '2026-12-31' }], ['dashboard', {}], ['vat-summary', { period: 'quarter', from: '2025-01-01', to: '2026-12-31' }],
    ['cash-flow', { format: 'csv', from: '2025-01-01', to: '2026-12-31' }], ['general-ledger', { account: '4000', limit: '10000', format: 'html' }],
  ];
  for (const [name, q] of cases) {
    const query = { from: '2025-01-01', to: '2026-12-31', ...q };
    const t0 = performance.now();
    const rep = runReport(ctx, u, name, query);
    const ms = performance.now() - t0;
    if (ms >= 2000) slow.push(`${name} ${JSON.stringify(q)} ${ms.toFixed(0)}ms`);
    assert.ok(rep);
    console.log(`  ${name.padEnd(20)} ${JSON.stringify(q).padEnd(40)} ${ms.toFixed(0)} ms`);
  }
  assert.deepEqual(slow, []);
  assert.ok(runReport(ctx, u, 'trial-balance', { to: '2026-12-31' }).checks[0].ok);
  assert.ok(runReport(ctx, u, 'balance-sheet', { to: '2026-12-31' }).checks[0].ok);
});
