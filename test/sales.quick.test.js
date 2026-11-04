import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError, startApp } from './helpers.js';
import * as sales from '../src/modules/sales/service.js';
import * as eta from '../src/modules/eta/service.js';
import { trialBalance, accountBalance } from '../src/ledger.js';
import { createApp } from '../src/server.js';

const DAY = 24 * 3600 * 1000;
const line = (unitPrice, qty = 1) => [{ description: 'Goods', qty, unitPrice }];
const count = (ctx, t) => ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
const listen = (ctx, name) => { const seen = []; ctx.registry.hooks[name] = [...(ctx.registry.hooks[name] ?? []), { module: 'test', fn: (_c, p) => seen.push(p) }]; return seen; };

test('quick sale without discount behaves as before: payload, receipt and totals', () => {
  const { ctx, as } = setup();
  const seen = listen(ctx, 'sale.created');
  const r = sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'TEA-250', qty: 2 }] });
  assert.deepEqual(r.sale, { id: r.sale.id, subtotal: 9000, vat: 1260, total: 10260 });
  assert.equal(r.receipt.status, 'submitted'); // the demo starts with the (mock) ETA online
  assert.deepEqual(Object.keys(seen[0]).sort(), ['entryId', 'items', 'receipt', 'sale', 'userId']);
  assert.ok(trialBalance(ctx.db).balanced);
});

test('discount: percent or fixed, revenue and VAT are posted net, role limit enforced', () => {
  const { ctx, as } = setup();
  const pct = sales.quickSale(ctx, as('manager'), { items: [{ sku: 'OIL-1L', qty: 10 }], discount: { type: 'percent', value: 10 } }); // 89000 gross
  assert.equal(pct.sale.discount, 8900);
  assert.equal(pct.sale.subtotal, 80100);
  assert.equal(pct.sale.vat, Math.round(80100 * 0.14));
  assert.equal(accountBalance(ctx.db, '4000').net, -80100);
  const fixed = sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'TEA-250', qty: 2 }], discount: { type: 'fixed', value: 500 } });
  assert.equal(fixed.sale.subtotal, 8500);
  const row = ctx.db.prepare('SELECT discount_type, discount_amount FROM sales WHERE id = ?').get(fixed.sale.id);
  assert.deepEqual({ ...row }, { discount_type: 'fixed', discount_amount: 500 });
  // the clerk limit is 50.00 EGP (5000 piastres)
  const err = expectError(() => sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'OIL-1L', qty: 10 }], discount: { type: 'percent', value: 10 } }), 'DISCOUNT_LIMIT');
  assert.equal(err.extra.limit, 5000);
  expectError(() => sales.quickSale(ctx, as('accountant'), { items: [{ sku: 'TEA-250', qty: 1 }], discount: { type: 'fixed', value: 100 } }), 'FORBIDDEN');
  expectError(() => sales.quickSale(ctx, as('manager'), { items: [{ sku: 'TEA-250', qty: 1 }], discount: { type: 'fixed', value: 4500 } }), 'DISCOUNT_TOO_LARGE');
  expectError(() => sales.quickSale(ctx, as('manager'), { items: [{ sku: 'TEA-250', qty: 1 }], discount: { type: 'percent', value: 120 } }), 'BAD_INPUT');
  expectError(() => sales.quickSale(ctx, as('manager'), { items: [{ sku: 'TEA-250', qty: 1 }], discount: { type: 'weird', value: 5 } }), 'BAD_INPUT');
  assert.ok(trialBalance(ctx.db).balanced);
});

test('refund of a quick sale posts a reversal, marks the sale and emits sale.refunded', () => {
  const { ctx, as } = setup();
  const sale = sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'RICE-1K', qty: 3 }] });
  const cashBefore = accountBalance(ctx.db, '1000').net;
  const seen = listen(ctx, 'sale.refunded');
  expectError(() => sales.refundSale(ctx, as('clerk'), sale.sale.id, { reason: 'x' }), 'FORBIDDEN');
  expectError(() => sales.refundSale(ctx, as('manager'), sale.sale.id, {}), 'BAD_INPUT');
  const r = sales.refundSale(ctx, as('manager'), sale.sale.id, { reason: 'Customer returned rice' });
  assert.equal(r.total, sale.sale.total);
  assert.equal(accountBalance(ctx.db, '1000').net, cashBefore - sale.sale.total);
  assert.equal(accountBalance(ctx.db, '4000').net, 0);
  assert.equal(accountBalance(ctx.db, '2100').net, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sale.id, sale.sale.id);
  assert.equal(seen[0].reason, 'Customer returned rice');
  assert.equal(seen[0].entryId, r.refundEntryId);
  assert.deepEqual(seen[0].items, [{ sku: 'RICE-1K', qty: 3, price: 3200 }]);
  assert.equal(seen[0].receipt.status, 'submitted');
  const row = sales.listSales(ctx, as('auditor')).find((s) => s.id === sale.sale.id);
  assert.equal(row.refunded, true);
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'sale.refunded' AND reason = 'Customer returned rice'").get());
  expectError(() => sales.refundSale(ctx, as('manager'), sale.sale.id, { reason: 'twice' }), 'ALREADY_REFUNDED');
  expectError(() => sales.refundSale(ctx, as('manager'), 9999, { reason: 'x' }), 'NOT_FOUND');
  assert.ok(trialBalance(ctx.db).balanced);
});

test('refund is atomic: a failing sale.refunded hook, or a hard period lock, leaves nothing half-done', () => {
  const { ctx, as } = setup();
  const sale = sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'RICE-1K', qty: 1 }] });
  const snapshot = () => [count(ctx, 'journal_entries'), count(ctx, 'journal_lines'), ctx.db.prepare('SELECT refunded FROM sales WHERE id = ?').get(sale.sale.id).refunded];
  const before = snapshot();
  ctx.registry.hooks['sale.refunded'] = [{ module: 'boom', fn: () => { throw new Error('stock module down'); } }];
  assert.throws(() => sales.refundSale(ctx, as('manager'), sale.sale.id, { reason: 'x' }), /stock module down/);
  assert.deepEqual(snapshot(), before);
  delete ctx.registry.hooks['sale.refunded'];
  const today = new Date(ctx.now()).toISOString().slice(0, 10);
  ctx.db.prepare("UPDATE period_lock SET through_date = ?, mode = 'hard' WHERE id = 1").run(today);
  expectError(() => sales.refundSale(ctx, as('manager'), sale.sale.id, { reason: 'x' }), 'PERIOD_LOCKED');
  assert.deepEqual(snapshot(), before);
  assert.ok(trialBalance(ctx.db).balanced);
});

test('parked sales: hold, list, checkout (rechecking discount rights) and discard', () => {
  const { ctx, as } = setup();
  const p = sales.parkSale(ctx, as('clerk'), { label: 'Lady in red', items: [{ sku: 'TEA-250', qty: 2 }] });
  assert.equal(sales.listParked(ctx, as('clerk')).length, 1);
  assert.equal(count(ctx, 'sales'), 0, 'parking posts nothing');
  const done = sales.checkoutParked(ctx, as('clerk'), p.id);
  assert.equal(done.sale.total, 10260);
  assert.equal(sales.listParked(ctx, as('clerk')).length, 0);
  assert.equal(ctx.db.prepare('SELECT sale_id FROM sales_parked WHERE id = ?').get(p.id).sale_id, done.sale.id);
  expectError(() => sales.checkoutParked(ctx, as('clerk'), p.id), 'NOT_HELD');
  const big = sales.parkSale(ctx, as('manager'), { items: [{ sku: 'OIL-1L', qty: 10 }], discount: { type: 'percent', value: 20 } });
  expectError(() => sales.checkoutParked(ctx, as('clerk'), big.id), 'DISCOUNT_LIMIT');
  assert.equal(sales.listParked(ctx, as('clerk')).length, 1, 'a refused checkout keeps the cart held');
  sales.discardParked(ctx, as('clerk'), big.id);
  assert.equal(sales.listParked(ctx, as('clerk')).length, 0);
  expectError(() => sales.parkSale(ctx, as('clerk'), { items: [] }), 'BAD_INPUT');
  expectError(() => sales.parkSale(ctx, as('clerk'), { items: [{ sku: 'NOPE', qty: 1 }] }), 'UNKNOWN_ITEM');
  expectError(() => sales.parkSale(ctx, as('auditor'), { items: [{ sku: 'TEA-250', qty: 1 }] }), 'FORBIDDEN');
});

test('items catalogue CRUD: sku is immutable, inactive items cannot be sold, sold items cannot be deleted', () => {
  const { ctx, as } = setup();
  expectError(() => sales.createItem(ctx, as('clerk'), { sku: 'NEW-1', name: 'New', price: 100 }), 'FORBIDDEN');
  const it = sales.createItem(ctx, as('manager'), { sku: 'NEW-1', name: 'New item', name_ar: 'صنف جديد', price: 1500 });
  assert.deepEqual([it.sku, it.price, it.active, it.eta_code], ['NEW-1', 1500, true, null]);
  expectError(() => sales.createItem(ctx, as('manager'), { sku: 'NEW-1', name: 'Dup', price: 1 }), 'DUPLICATE_SKU');
  expectError(() => sales.createItem(ctx, as('manager'), { sku: 'bad sku!', name: 'x', price: 1 }), 'BAD_INPUT');
  expectError(() => sales.createItem(ctx, as('manager'), { sku: 'FREE', name: 'x', price: 0 }), 'BAD_INPUT');
  const up = sales.updateItem(ctx, as('manager'), 'NEW-1', { price: 1800, eta_code: 'EGS-1' });
  assert.deepEqual([up.price, up.eta_code], [1800, 'EGS-1']);
  expectError(() => sales.updateItem(ctx, as('manager'), 'NEW-1', { sku: 'OTHER' }), 'SKU_IMMUTABLE');
  sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'NEW-1', qty: 1 }] });
  expectError(() => sales.deleteItem(ctx, as('manager'), 'NEW-1'), 'ITEM_IN_USE');
  sales.updateItem(ctx, as('manager'), 'NEW-1', { active: false });
  expectError(() => sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'NEW-1', qty: 1 }] }), 'ITEM_INACTIVE');
  assert.ok(!sales.listItems(ctx, as('clerk')).some((i) => i.sku === 'NEW-1'));
  assert.ok(sales.listItems(ctx, as('manager'), { all: 1 }).some((i) => i.sku === 'NEW-1'));
  expectError(() => sales.listItems(ctx, as('clerk'), { all: 1 }), 'FORBIDDEN');
  const spare = sales.createItem(ctx, as('manager'), { sku: 'SPARE', name: 'Spare', price: 5 });
  assert.equal(sales.deleteItem(ctx, as('manager'), spare.sku).deleted, true);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE ?').get('item.%').n, 5);
});

test('quotes: create, validity, accept, convert to invoice once, expired and declined quotes refuse conversion', () => {
  const { ctx, as } = setup();
  const c = sales.listCustomers(ctx, as('clerk')).find((x) => x.name === 'Cafe Nile');
  expectError(() => sales.createQuote(ctx, as('auditor'), { customerId: c.id, lines: line(1000) }), 'FORBIDDEN');
  expectError(() => sales.createQuote(ctx, as('clerk'), { customerId: c.id, lines: line(1000), date: '2026-05-10', validUntil: '2026-05-01' }), 'BAD_DATE');
  const q = sales.createQuote(ctx, as('clerk'), { customerId: c.id, lines: line(10000, 2) });
  assert.match(q.number, /^QUO-\d{4}$/);
  assert.equal(q.total, 22800);
  assert.equal(q.status, 'open');
  assert.equal(sales.updateQuote(ctx, as('clerk'), q.id, { lines: line(10000, 3) }).total, 34200);
  sales.setQuoteStatus(ctx, as('clerk'), q.id, 'accepted');
  const conv = sales.convertQuote(ctx, as('clerk'), q.id, {});
  assert.equal(conv.invoice.total, 34200);
  assert.equal(conv.invoice.status, 'issued');
  assert.equal(ctx.db.prepare('SELECT quote_id, customer_id FROM invoices WHERE id = ?').get(conv.invoice.id).quote_id, q.id);
  assert.equal(sales.getQuote(ctx, as('auditor'), q.id).status, 'converted');
  expectError(() => sales.convertQuote(ctx, as('clerk'), q.id, {}), 'ALREADY_CONVERTED');
  expectError(() => sales.updateQuote(ctx, as('clerk'), q.id, { lines: line(1) }), 'QUOTE_NOT_OPEN');

  const old = sales.createQuote(ctx, as('clerk'), { customer: 'Late Buyer', lines: line(1000) , validUntil: new Date(ctx.now() + 5 * DAY).toISOString().slice(0, 10) });
  ctx.offsetMs += 10 * DAY;
  assert.equal(sales.getQuote(ctx, as('clerk'), old.id).status, 'expired');
  const invoicesBefore = count(ctx, 'invoices');
  expectError(() => sales.convertQuote(ctx, as('clerk'), old.id, {}), 'QUOTE_EXPIRED');
  assert.equal(count(ctx, 'invoices'), invoicesBefore);
  const no = sales.createQuote(ctx, as('clerk'), { customer: 'Nope', lines: line(1000) });
  sales.setQuoteStatus(ctx, as('clerk'), no.id, 'declined');
  expectError(() => sales.convertQuote(ctx, as('clerk'), no.id, {}), 'QUOTE_DECLINED');
  assert.ok(trialBalance(ctx.db).balanced);
});

test('quote conversion honours the credit limit atomically (quote stays open when refused)', () => {
  const { ctx, as } = setup();
  const c = sales.createCustomer(ctx, as('clerk'), { name: 'Tight Budget', creditLimit: 5000 });
  const q = sales.createQuote(ctx, as('clerk'), { customerId: c.id, lines: line(10000) });
  expectError(() => sales.convertQuote(ctx, as('clerk'), q.id, {}), 'CREDIT_LIMIT_EXCEEDED');
  assert.equal(sales.getQuote(ctx, as('clerk'), q.id).status, 'open');
  assert.equal(count(ctx, 'invoices'), 0);
  const conv = sales.convertQuote(ctx, as('manager'), q.id, { creditOverride: { reason: 'Approved by owner' } });
  assert.equal(conv.invoice.status, 'issued');
});

test('widgets: receivables use open balances, refunded sales leave today\'s total', () => {
  const { ctx, as } = setup();
  const inv = sales.createInvoice(ctx, as('clerk'), { customer: 'W', lines: line(10000) });
  sales.recordPayment(ctx, as('clerk'), { amount: 1400, allocations: [{ invoiceId: inv.id, amount: 1400 }] });
  const sale = sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'TEA-250', qty: 1 }] });
  let w = sales.widgets(ctx, as('owner'));
  assert.equal(w.receivables.total, 10000);
  assert.equal(w.todaySales.total, sale.sale.total);
  sales.refundSale(ctx, as('manager'), sale.sale.id, { reason: 'test' });
  w = sales.widgets(ctx, as('owner'));
  assert.equal(w.todaySales.total, 0);
  assert.equal(sales.widgets(ctx, as('clerk')).receivables, undefined);
});

test('http: refund, parked sale and customer routes enforce permissions', async () => {
  const { ctx } = setup();
  const { server, call } = await startApp(createApp, ctx);
  try {
    const sale = await call('POST', '/api/sales/quick', 3, { items: [{ sku: 'TEA-250', qty: 1 }], discount: { type: 'fixed', value: 100 } });
    assert.equal(sale.status, 201);
    assert.equal((await call('POST', `/api/sales/${sale.body.sale.id}/refund`, 3, { reason: 'x' })).status, 403);
    assert.equal((await call('POST', `/api/sales/${sale.body.sale.id}/refund`, 2, { reason: 'x' })).status, 201);
    const parked = await call('POST', '/api/sales/parked', 3, { items: [{ sku: 'RICE-1K', qty: 1 }] });
    assert.equal(parked.status, 201);
    assert.equal((await call('POST', `/api/sales/parked/${parked.body.id}/checkout`, 3)).status, 201);
    assert.equal((await call('POST', '/api/customers', 5, { name: 'Z' })).status, 403);
    assert.equal((await call('POST', '/api/customers', 3, { name: 'Z', creditLimit: 'lots' })).status, 400);
    const rem = await call('GET', '/api/customers/1/reminder?lang=ar', 3);
    assert.equal(rem.status, 409);
    assert.equal(rem.body.error.code, 'NOTHING_OVERDUE');
    assert.equal((await call('GET', '/api/sales/settings', 5)).status, 200);
    assert.equal((await call('PUT', '/api/sales/settings', 3, { businessName: 'x' })).status, 403);
  } finally { server.close(); }
});

test('eta queue still works: an offline discounted sale is queued, then synced', () => {
  const { ctx, as } = setup();
  eta.etaSetOnline(ctx, as('owner'), false);
  const r = sales.quickSale(ctx, as('manager'), { items: [{ sku: 'TEA-250', qty: 2 }], discount: { type: 'fixed', value: 500 } });
  assert.equal(r.receipt.status, 'queued');
  eta.etaSetOnline(ctx, as('owner'), true);
  eta.etaSync(ctx, as('clerk'));
  assert.equal(ctx.db.prepare('SELECT status FROM receipts WHERE sale_id = ?').get(r.sale.id).status, 'submitted');
});
