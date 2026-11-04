import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError } from './helpers.js';
import * as inv from '../src/modules/inventory/service.js';
import * as sales from '../src/modules/sales/service.js';
import * as ledger from '../src/ledger.js';
import { accountBalance, trialBalance, tx } from '../src/ledger.js';
import { emit } from '../src/hooks.js';

const count = (ctx, table) => ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const receive = (ctx, user, sku, qty, unitCost, extra = {}) => inv.receiveStock(ctx, user, { supplier: 'Delta Foods', sku, qty, unitCost, ...extra });
const state = (ctx, sku) => inv.costState(ctx.db, sku);

test('inventory: receiving stock posts Dr 1300 / Cr 2000 in one entry, tracks the item and audits', () => {
  const { ctx, as } = setup();
  const before = accountBalance(ctx.db, '2000').net;
  const r = receive(ctx, as('accountant'), 'TEA-250', 10, 3000);
  assert.equal(r.total, 30000);
  assert.equal(accountBalance(ctx.db, '1300').net, 30000);
  assert.equal(accountBalance(ctx.db, '2000').net, before - 30000);
  const lines = ctx.db.prepare('SELECT a.code, l.debit, l.credit FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE entry_id = ? ORDER BY l.id').all(r.entryId);
  assert.deepEqual(lines.map((l) => [l.code, l.debit, l.credit]), [['1300', 30000, 0], ['2000', 0, 30000]]);
  assert.equal(ctx.db.prepare('SELECT track FROM inventory_item_settings WHERE sku = ?').get('TEA-250').track, 1);
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'inventory.received' AND user_id = 4").get());
  const m = ctx.db.prepare('SELECT * FROM inventory_movements WHERE id = ?').get(r.movements[0]);
  assert.deepEqual([m.kind, m.qty, m.unit_cost, m.value, m.supplier], ['purchase', 10, 3000, 30000, 'Delta Foods']);
});

test('inventory: weighted-average cost over several receipts and sales reconciles to ledger 1300 to the piastre', () => {
  const { ctx, as } = setup();
  const own = as('owner'), clerk = as('clerk');
  receive(ctx, own, 'RICE-1K', 10, 1000);              // 10 @ 10.00
  receive(ctx, own, 'RICE-1K', 10, 2000);              // 10 @ 20.00 -> avg 15.00
  assert.deepEqual([state(ctx, 'RICE-1K').q, state(ctx, 'RICE-1K').v], [20, 30000]);
  const s1 = sales.quickSale(ctx, clerk, { items: [{ sku: 'RICE-1K', qty: 5 }] }); // cost 5 x 1500 = 7500
  assert.equal(ctx.db.prepare("SELECT value FROM inventory_movements WHERE kind = 'sale' AND ref_id = ?").get(s1.sale.id).value, -7500);
  assert.deepEqual([state(ctx, 'RICE-1K').q, state(ctx, 'RICE-1K').v], [15, 22500]);
  receive(ctx, own, 'RICE-1K', 5, 3000);               // +15000 -> 20 units, 37500, avg 18.75
  assert.deepEqual([state(ctx, 'RICE-1K').q, state(ctx, 'RICE-1K').v], [20, 37500]);
  sales.quickSale(ctx, clerk, { items: [{ sku: 'RICE-1K', qty: 3 }] }); // 37500*3/20 = 5625
  assert.deepEqual([state(ctx, 'RICE-1K').q, state(ctx, 'RICE-1K').v], [17, 31875]);
  sales.quickSale(ctx, clerk, { items: [{ sku: 'RICE-1K', qty: 7 }] }); // 31875*7/17 = 13125 exactly
  assert.equal(state(ctx, 'RICE-1K').v, 18750);
  sales.quickSale(ctx, clerk, { items: [{ sku: 'RICE-1K', qty: 10 }] }); // the last units take all remaining value: no rounding residue
  assert.deepEqual([state(ctx, 'RICE-1K').q, state(ctx, 'RICE-1K').v], [0, 0]);
  assert.equal(accountBalance(ctx.db, '1300').net, 0);
  assert.equal(accountBalance(ctx.db, '5300').net, 45000); // total purchases 45000 all expensed as COGS
  const val = inv.valuation(ctx, as('accountant'));
  assert.equal(val.reconciled, true);
  assert.ok(trialBalance(ctx.db).balanced);
});

test('inventory: a sale posts COGS at average cost in the same transaction as the sale entry', () => {
  const { ctx, as } = setup();
  receive(ctx, as('owner'), 'TEA-250', 4, 2500);
  const r = sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'TEA-250', qty: 2 }] });
  const cogs = ctx.db.prepare("SELECT id FROM journal_entries WHERE source_type = 'inventory_cogs' AND source_id = ?").get(r.sale.id);
  assert.ok(cogs);
  const lines = ctx.db.prepare('SELECT a.code, l.debit, l.credit FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE entry_id = ? ORDER BY l.id').all(cogs.id);
  assert.deepEqual(lines.map((l) => [l.code, l.debit, l.credit]), [['5300', 5000, 0], ['1300', 0, 5000]]);
  assert.equal(inv.listStock(ctx, as('owner')).items.find((i) => i.sku === 'TEA-250').qty, 2);
});

test('inventory: items that are not stock items are ignored by the sale hook', () => {
  const { ctx, as } = setup();
  const entries = count(ctx, 'journal_entries');
  sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'SPICE-LOOSE', qty: 3 }] });
  assert.equal(count(ctx, 'journal_entries'), entries + 1); // only the sale itself
  assert.equal(count(ctx, 'inventory_movements'), 0);
});

test('inventory: negative stock is allowed by default, flagged, and costed at the last known cost', () => {
  const { ctx, as } = setup();
  receive(ctx, as('owner'), 'OIL-1L', 2, 5000);
  const r = sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'OIL-1L', qty: 5 }] }); // 2 at average + 3 short at last cost 5000
  const m = ctx.db.prepare("SELECT * FROM inventory_movements WHERE kind = 'sale' AND ref_id = ?").get(r.sale.id);
  assert.equal(m.flags, 'negative');
  assert.equal(m.value, -25000);
  assert.equal(state(ctx, 'OIL-1L').q, -3);
  const w = inv.warnings(ctx, as('clerk'));
  assert.deepEqual(w.negative.map((x) => [x.sku, x.qty]), [['OIL-1L', -3]]);
  assert.equal(inv.widgets(ctx, as('clerk')).inventory.negativeCount, 1);
  // A later receipt restores a positive balance and the value stays consistent with the ledger.
  receive(ctx, as('owner'), 'OIL-1L', 10, 6000);
  assert.equal(state(ctx, 'OIL-1L').q, 7);
  assert.equal(inv.valuation(ctx, as('owner')).reconciled, true);
});

test('inventory: unknown cost is flagged, not hidden: no cost known means zero COGS and a cost_unknown flag', () => {
  const { ctx, as } = setup();
  inv.setItemSettings(ctx, as('manager'), 'RICE-1K', { track: true });
  const entries = count(ctx, 'journal_entries');
  const r = sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'RICE-1K', qty: 2 }] });
  const m = ctx.db.prepare("SELECT * FROM inventory_movements WHERE ref_id = ?").get(r.sale.id);
  assert.equal(m.flags, 'cost_unknown,negative');
  assert.equal(m.value, 0);
  assert.equal(count(ctx, 'journal_entries'), entries + 1); // no zero-value COGS entry
  assert.equal(inv.warnings(ctx, as('auditor')).flagged.length, 1);
});

test('inventory: with allow_negative off an oversell is refused and the whole sale rolls back', () => {
  const { ctx, as } = setup();
  receive(ctx, as('owner'), 'TEA-250', 2, 2500);
  inv.putSettings(ctx, as('manager'), { allowNegative: false });
  const [sa, je, mv] = [count(ctx, 'sales'), count(ctx, 'journal_entries'), count(ctx, 'inventory_movements')];
  expectError(() => sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'TEA-250', qty: 3 }] }), 'INSUFFICIENT_STOCK');
  assert.deepEqual([count(ctx, 'sales'), count(ctx, 'journal_entries'), count(ctx, 'inventory_movements')], [sa, je, mv]);
  sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'TEA-250', qty: 2 }] }); // exactly what is there is fine
  assert.equal(state(ctx, 'TEA-250').q, 0);
});

test('inventory: if a later hook fails, the COGS entry and stock movement are rolled back with the sale', () => {
  const { ctx, as } = setup();
  receive(ctx, as('owner'), 'TEA-250', 5, 2000);
  ctx.registry.hooks['sale.created'].push({ module: 'zz-failing', fn: () => { throw new Error('boom'); } });
  const [sa, je, mv, au] = [count(ctx, 'sales'), count(ctx, 'journal_entries'), count(ctx, 'inventory_movements'), count(ctx, 'audit_log')];
  assert.throws(() => sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'TEA-250', qty: 1 }] }), /boom/);
  assert.deepEqual([count(ctx, 'sales'), count(ctx, 'journal_entries'), count(ctx, 'inventory_movements'), count(ctx, 'audit_log')], [sa, je, mv, au]);
  assert.equal(state(ctx, 'TEA-250').q, 5);
});

test('inventory: invoice.created relieves stock only for lines that carry a sku, and only once', () => {
  const { ctx, as } = setup();
  receive(ctx, as('owner'), 'OIL-1L', 10, 7000);
  const payload = { invoice: { id: 77, number: 'INV-0077', customer: 'X', issueDate: '2026-03-01', subtotal: 0, vat: 0, total: 0,
    lines: [{ description: 'Oil', qty: 4, unitPrice: 8900, sku: 'OIL-1L' }, { description: 'Delivery', qty: 1, unitPrice: 5000 }] }, entryId: 1, userId: 3 };
  tx(ctx.db, () => { emit(ctx, 'invoice.created', payload); emit(ctx, 'invoice.created', payload); });
  assert.equal(state(ctx, 'OIL-1L').q, 6);
  const e = ctx.db.prepare("SELECT entry_date, memo FROM journal_entries WHERE source_type = 'inventory_cogs'").all();
  assert.equal(e.length, 1);
  assert.equal(e[0].entry_date, '2026-03-01');
  assert.equal(accountBalance(ctx.db, '5300').net, 28000);
  // a real invoice without sku lines touches nothing
  const mv = count(ctx, 'inventory_movements');
  sales.createInvoice(ctx, as('clerk'), { customer: 'Y', lines: [{ description: 'Service', qty: 1, unitPrice: 10000 }] });
  assert.equal(count(ctx, 'inventory_movements'), mv);
});

test('inventory: adjustment needs a reason; shrinkage posts Dr 5300 / Cr 1300 at average cost', () => {
  const { ctx, as } = setup();
  receive(ctx, as('owner'), 'TEA-250', 10, 3000);
  expectError(() => inv.adjustStock(ctx, as('accountant'), { sku: 'TEA-250', qty: -2 }), 'BAD_INPUT');
  expectError(() => inv.adjustStock(ctx, as('accountant'), { sku: 'TEA-250', qty: -2, reason: '  ' }), 'BAD_INPUT');
  expectError(() => inv.adjustStock(ctx, as('accountant'), { sku: 'TEA-250', qty: 0, reason: 'x' }), 'BAD_INPUT');
  const r = inv.adjustStock(ctx, as('manager'), { sku: 'TEA-250', qty: -2, reason: 'Damaged in storage' });
  assert.equal(r.value, -6000);
  assert.equal(accountBalance(ctx.db, '5300').net, 6000);
  assert.equal(accountBalance(ctx.db, '1300').net, 24000);
  const a = ctx.db.prepare("SELECT reason, new_value FROM audit_log WHERE action = 'inventory.adjusted'").get();
  assert.equal(a.reason, 'Damaged in storage');
});

test('inventory: a positive adjustment is a gain (Dr 1300 / Cr 5300) at the average cost unless a cost is given', () => {
  const { ctx, as } = setup();
  receive(ctx, as('owner'), 'TEA-250', 10, 3000);
  const g = inv.adjustStock(ctx, as('accountant'), { sku: 'TEA-250', qty: 2, reason: 'Found in back room' });
  assert.equal(g.value, 6000);
  assert.equal(accountBalance(ctx.db, '5300').net, -6000);
  const g2 = inv.adjustStock(ctx, as('accountant'), { sku: 'TEA-250', qty: 1, unitCost: 4000, reason: 'Sample' });
  assert.equal(g2.value, 4000);
  assert.equal(inv.valuation(ctx, as('owner')).reconciled, true);
});

test('inventory: transfer moves stock between warehouses at average cost with no ledger effect', () => {
  const { ctx, as } = setup();
  receive(ctx, as('owner'), 'RICE-1K', 10, 1500);
  const wh = inv.createWarehouse(ctx, as('manager'), { code: 'shop2', name: 'Second shop' });
  const je = count(ctx, 'journal_entries');
  inv.transferStock(ctx, as('manager'), { sku: 'RICE-1K', qty: 4, fromWarehouseId: 1, toWarehouseId: wh.id });
  assert.equal(count(ctx, 'journal_entries'), je);
  const row = inv.listStock(ctx, as('owner')).items.find((i) => i.sku === 'RICE-1K');
  assert.equal(row.qty, 10);
  assert.deepEqual(row.warehouses.map((w) => [w.warehouseId, w.qty]).sort(), [[1, 6], [wh.id, 4]]);
  assert.equal(row.value, 15000);
  assert.equal(inv.listStock(ctx, as('owner'), { warehouse: String(wh.id) }).items.find((i) => i.sku === 'RICE-1K').qty, 4);
  expectError(() => inv.transferStock(ctx, as('manager'), { sku: 'RICE-1K', qty: 1, fromWarehouseId: 1, toWarehouseId: 1 }), 'SAME_WAREHOUSE');
  inv.putSettings(ctx, as('owner'), { allowNegative: false });
  expectError(() => inv.transferStock(ctx, as('manager'), { sku: 'RICE-1K', qty: 5, fromWarehouseId: wh.id, toWarehouseId: 1 }), 'INSUFFICIENT_STOCK');
});

test('inventory: stocktake turns counted variances into adjustments and posts one entry; a sheet posts once', () => {
  const { ctx, as } = setup();
  receive(ctx, as('owner'), 'TEA-250', 10, 3000);
  receive(ctx, as('owner'), 'RICE-1K', 10, 1000);
  receive(ctx, as('owner'), 'OIL-1L', 5, 7000);
  const sheet = inv.createCount(ctx, as('accountant'), { note: 'Monthly' });
  assert.equal(sheet.lines.length, 3);
  inv.saveCountLines(ctx, as('accountant'), sheet.id, { lines: [{ sku: 'TEA-250', countedQty: 8 }, { sku: 'RICE-1K', countedQty: 12 }, { sku: 'OIL-1L', countedQty: 5 }] });
  const r = inv.postCount(ctx, as('accountant'), sheet.id);
  assert.deepEqual([r.loss, r.gain, r.adjusted], [6000, 2000, 2]);
  assert.equal(state(ctx, 'TEA-250').q, 8);
  assert.equal(state(ctx, 'RICE-1K').q, 12);
  assert.equal(accountBalance(ctx.db, '5300').net, 4000); // 6000 loss - 2000 gain
  assert.equal(inv.getCount(ctx, as('owner'), sheet.id).status, 'posted');
  assert.deepEqual(inv.getCount(ctx, as('owner'), sheet.id).lines.map((l) => l.variance_qty), [0, 2, -2]);
  expectError(() => inv.postCount(ctx, as('accountant'), sheet.id), 'COUNT_CLOSED');
  assert.equal(inv.valuation(ctx, as('owner')).reconciled, true);
});

test('inventory: uncounted lines are skipped, an empty count is refused, cancel needs a reason', () => {
  const { ctx, as } = setup();
  receive(ctx, as('owner'), 'TEA-250', 10, 3000);
  const sheet = inv.createCount(ctx, as('manager'), {});
  expectError(() => inv.postCount(ctx, as('manager'), sheet.id), 'NOTHING_COUNTED');
  expectError(() => inv.saveCountLines(ctx, as('manager'), sheet.id, { lines: [{ sku: 'RICE-1K', countedQty: 1 }] }), 'NOT_ON_SHEET');
  expectError(() => inv.saveCountLines(ctx, as('manager'), sheet.id, { lines: [{ sku: 'TEA-250', countedQty: -1 }] }), 'BAD_INPUT');
  expectError(() => inv.cancelCount(ctx, as('manager'), sheet.id, {}), 'BAD_INPUT');
  inv.cancelCount(ctx, as('manager'), sheet.id, { reason: 'Wrong day' });
  expectError(() => inv.saveCountLines(ctx, as('manager'), sheet.id, { lines: [{ sku: 'TEA-250', countedQty: 1 }] }), 'COUNT_CLOSED');
});

test('inventory: returns bring goods back from a customer or go back to the supplier', () => {
  const { ctx, as } = setup();
  receive(ctx, as('owner'), 'TEA-250', 10, 3000);
  inv.returnStock(ctx, as('manager'), { sku: 'TEA-250', qty: 2, direction: 'in', reason: 'Customer changed mind' });
  assert.equal(state(ctx, 'TEA-250').q, 12);
  const ap = accountBalance(ctx.db, '2000').net;
  const r = inv.returnStock(ctx, as('manager'), { sku: 'TEA-250', qty: 4, direction: 'out', reason: 'Stale', supplier: 'Delta Foods' });
  assert.equal(r.value, -12000);
  assert.equal(accountBalance(ctx.db, '2000').net, ap + 12000); // payable reduced
  assert.equal(inv.valuation(ctx, as('owner')).reconciled, true);
  expectError(() => inv.returnStock(ctx, as('manager'), { sku: 'TEA-250', qty: 1, direction: 'sideways', reason: 'x' }), 'BAD_INPUT');
});

test('inventory: valuation lists qty, average cost and value per item and shows a difference to ledger 1300', () => {
  const { ctx, as } = setup();
  receive(ctx, as('owner'), 'TEA-250', 3, 1000);
  receive(ctx, as('owner'), 'TEA-250', 3, 1500);
  let v = inv.valuation(ctx, as('auditor'));
  assert.deepEqual(v.items.map((i) => [i.sku, i.qty, i.avgCost, i.value]), [['TEA-250', 6, 1250, 7500]]);
  assert.deepEqual([v.total, v.ledgerBalance, v.difference, v.reconciled], [7500, 7500, 0, true]);
  // someone posts straight to 1300 with a manual journal: the report must show the gap, not hide it
  const { postEntry } = ledger;
  postEntry(ctx, { userId: 1, memo: 'Manual stock write-up', lines: [{ account: '1300', debit: 900 }, { account: '3000', credit: 900 }] });
  v = inv.valuation(ctx, as('owner'));
  assert.deepEqual([v.difference, v.reconciled, v.ledgerOther, v.ledgerFromInventory], [900, false, 900, 7500]);
});
