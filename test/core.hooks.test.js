import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoContext } from '../src/server.js';
import { loadModules, MODULES_DIR } from '../src/modules.js';
import { loadUser } from '../src/permissions.js';
import * as sales from '../src/modules/sales/service.js';
import * as purchases from '../src/modules/purchases/service.js';
import { tempModules, expectError } from './helpers.js';

const SPY = `
export const seen = globalThis.__hookSeen ??= [];
export default {
  name: 'spy',
  hooks: {
    'sale.created': (ctx, p) => { seen.push(['sale.created', p.sale.total, p.items.length, p.entryId]); },
    'invoice.created': (ctx, p) => { seen.push(['invoice.created', p.invoice.number, p.invoice.total]); },
    'invoice.paid': (ctx, p) => { seen.push(['invoice.paid', p.id]); },
    'bill.created': (ctx, p) => { seen.push(['bill.created', p.bill.amount, p.status]); },
    'bill.approved': (ctx, p) => { seen.push(['bill.approved', p.bill.amount, p.auto]); },
    'entry.posted': (ctx, p) => { seen.push(['entry.posted', p.sourceType]); },
  },
};
`;
const FAILING = `
export default { name: 'boom', hooks: { 'sale.created': () => { throw Object.assign(new Error('hook failed'), { code: 'HOOK_FAILED' }); } } };
`;

test('hooks: modules receive sale, invoice and bill events with their payloads', async () => {
  globalThis.__hookSeen = [];
  const registry = await loadModules([MODULES_DIR, tempModules({ 'spy/index.js': SPY })]);
  const ctx = createDemoContext(':memory:', registry);
  const clerk = loadUser(ctx, 3), manager = loadUser(ctx, 2);
  globalThis.__hookSeen.length = 0;

  const sale = sales.quickSale(ctx, clerk, { items: [{ sku: 'TEA-250', qty: 2 }] });
  const inv = sales.createInvoice(ctx, clerk, { customer: 'A', lines: [{ description: 'x', qty: 1, unitPrice: 1000 }] });
  sales.payInvoice(ctx, clerk, inv.id);
  purchases.createBill(ctx, clerk, { supplier: 'S', amount: 50000, category: 'utilities' }); // auto-approved
  const big = purchases.createBill(ctx, clerk, { supplier: 'L', amount: 400000, category: 'rent' }); // pending
  purchases.approveBill(ctx, manager, big.id);

  const seen = globalThis.__hookSeen;
  const names = seen.map((s) => s[0]);
  assert.deepEqual(seen.find((s) => s[0] === 'sale.created'), ['sale.created', sale.sale.total, 1, sale.entryId]);
  assert.ok(names.includes('invoice.created') && names.includes('invoice.paid'));
  assert.deepEqual(seen.filter((s) => s[0] === 'bill.created').map((s) => s[2]), ['approved', 'pending_approval']);
  assert.deepEqual(seen.filter((s) => s[0] === 'bill.approved').map((s) => s[2]), [true, false]);
  assert.ok(names.filter((n) => n === 'entry.posted').length >= 5, 'every posted entry emits entry.posted');
});

test('hooks: a hook that throws rolls the whole operation back (atomic)', async () => {
  const registry = await loadModules([MODULES_DIR, tempModules({ 'boom/index.js': FAILING })]);
  const ctx = createDemoContext(':memory:', registry);
  const clerk = loadUser(ctx, 3);
  const count = (t) => ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  const before = [count('sales'), count('journal_entries'), count('receipts')];
  expectError(() => sales.quickSale(ctx, clerk, { items: [{ sku: 'TEA-250', qty: 1 }] }), 'HOOK_FAILED');
  assert.deepEqual([count('sales'), count('journal_entries'), count('receipts')], before);
});

test('hooks: an unknown event name or a non-function hook is refused at load', async () => {
  await assert.rejects(loadModules([MODULES_DIR, tempModules({ 'bad/index.js': "export default { name: 'bad', hooks: { 'nope.event': () => {} } };" })]), /unknown hook event/);
  await assert.rejects(loadModules([MODULES_DIR, tempModules({ 'bad2/index.js': "export default { name: 'bad2', hooks: { 'sale.created': 5 } };" })]), /must be a function/);
});
