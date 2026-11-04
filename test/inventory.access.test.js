import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError, startApp } from './helpers.js';
import { createApp } from '../src/server.js';
import { setPeriodLock } from '../src/ledger.js';
import * as inv from '../src/modules/inventory/service.js';

const receive = (ctx, user, sku, qty, unitCost) => inv.receiveStock(ctx, user, { supplier: 'S', sku, qty, unitCost });

test('inventory permissions: clerk and auditor cannot receive, adjust, transfer, count or manage', () => {
  const { ctx, as } = setup();
  receive(ctx, as('owner'), 'TEA-250', 5, 1000);
  for (const who of ['clerk', 'auditor']) {
    expectError(() => receive(ctx, as(who), 'TEA-250', 1, 100), 'FORBIDDEN');
    expectError(() => inv.adjustStock(ctx, as(who), { sku: 'TEA-250', qty: -1, reason: 'x' }), 'FORBIDDEN');
    expectError(() => inv.transferStock(ctx, as(who), { sku: 'TEA-250', qty: 1, fromWarehouseId: 1, toWarehouseId: 1 }), 'FORBIDDEN');
    expectError(() => inv.createCount(ctx, as(who), {}), 'FORBIDDEN');
    expectError(() => inv.setItemSettings(ctx, as(who), 'TEA-250', { barcode: '123456' }), 'FORBIDDEN');
    expectError(() => inv.putSettings(ctx, as(who), { allowNegative: false }), 'FORBIDDEN');
    expectError(() => inv.createWarehouse(ctx, as(who), { code: 'x', name: 'x' }), 'FORBIDDEN');
  }
  expectError(() => inv.adjustStock(ctx, as('admin'), { sku: 'TEA-250', qty: -1, reason: 'x' }), 'FORBIDDEN');
  expectError(() => inv.listStock(ctx, as('admin')), 'FORBIDDEN');
});

test('inventory permissions: costs are a separate atom; clerk sees quantities but never cost or value', () => {
  const { ctx, as } = setup();
  receive(ctx, as('owner'), 'TEA-250', 5, 1000);
  const row = inv.listStock(ctx, as('clerk')).items[0];
  assert.equal(row.qty, 5);
  assert.ok(!('avgCost' in row) && !('value' in row));
  assert.equal(inv.listMovements(ctx, as('clerk'))[0].value, null);
  assert.equal(inv.widgets(ctx, as('clerk')).inventory.value, undefined);
  expectError(() => inv.valuation(ctx, as('clerk')), 'FORBIDDEN');
  assert.equal(inv.listStock(ctx, as('manager')).items[0].value, 5000);
  assert.equal(inv.widgets(ctx, as('accountant')).inventory.value, 5000);
});

test('inventory permissions: manager adjustments are capped by the role limit, the owner is not', () => {
  const { ctx, as } = setup();
  receive(ctx, as('owner'), 'OIL-1L', 10, 600000); // 60,000 EGP of oil
  expectError(() => inv.adjustStock(ctx, as('manager'), { sku: 'OIL-1L', qty: -10, reason: 'Fire' }), 'OVER_LIMIT');
  inv.adjustStock(ctx, as('manager'), { sku: 'OIL-1L', qty: -2, reason: 'Leaked' }); // 12,000 EGP is fine
  inv.adjustStock(ctx, as('owner'), { sku: 'OIL-1L', qty: -8, reason: 'Fire' });
  assert.equal(inv.costState(ctx.db, 'OIL-1L').q, 0);
});

test('inventory validation: unknown items, bad numbers, missing supplier and bad dates are rejected with clear codes', () => {
  const { ctx, as } = setup();
  const o = as('owner');
  expectError(() => receive(ctx, o, 'NOPE', 1, 100), 'UNKNOWN_ITEM');
  expectError(() => receive(ctx, o, 'TEA-250', 0, 100), 'BAD_INPUT');
  expectError(() => receive(ctx, o, 'TEA-250', 1.5, 100), 'BAD_INPUT');
  expectError(() => receive(ctx, o, 'TEA-250', 1, 0), 'BAD_INPUT');
  expectError(() => inv.receiveStock(ctx, o, { sku: 'TEA-250', qty: 1, unitCost: 100 }), 'BAD_INPUT');
  expectError(() => inv.receiveStock(ctx, o, { supplier: 'S', lines: [] }), 'BAD_INPUT');
  expectError(() => inv.receiveStock(ctx, o, { supplier: 'S', sku: 'TEA-250', qty: 1, unitCost: 100, date: '01/02/2026' }), 'BAD_DATE');
  expectError(() => inv.receiveStock(ctx, o, { supplier: 'S', sku: 'TEA-250', qty: 1, unitCost: 100, warehouseId: 99 }), 'NO_WAREHOUSE');
  expectError(() => inv.adjustStock(ctx, o, { sku: 'TEA-250', qty: -1, reason: 'x' }), 'NOT_TRACKED');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM inventory_movements').get().n, 0);
});

test('inventory: a receipt into a hard-locked period posts nothing, movements stay append-only', () => {
  const { ctx, as } = setup();
  receive(ctx, as('owner'), 'TEA-250', 1, 100);
  assert.throws(() => ctx.db.prepare('UPDATE inventory_movements SET qty = 9').run(), /append-only/);
  assert.throws(() => ctx.db.prepare('DELETE FROM inventory_movements').run(), /append-only/);
  setPeriodLock(ctx, 1, '2099-12-31', 'hard', 'year end');
  const counts = () => [ctx.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, ctx.db.prepare('SELECT COUNT(*) AS n FROM inventory_movements').get().n];
  const before = counts();
  expectError(() => inv.receiveStock(ctx, as('owner'), { supplier: 'S', sku: 'RICE-1K', qty: 1, unitCost: 100 }), 'PERIOD_LOCKED');
  assert.deepEqual(counts(), before);
  assert.equal(ctx.db.prepare("SELECT 1 FROM inventory_item_settings WHERE sku = 'RICE-1K'").get(), undefined); // tracking switch rolled back too
});

test('inventory: barcode lookup, uniqueness and validation', () => {
  const { ctx, as } = setup();
  receive(ctx, as('owner'), 'TEA-250', 5, 1000);
  inv.setItemSettings(ctx, as('manager'), 'TEA-250', { barcode: '6221234567890', reorderLevel: 3, reorderQty: 20, unit: 'box' });
  const hit = inv.lookupBarcode(ctx, as('clerk'), '6221234567890');
  assert.deepEqual([hit.sku, hit.qty, hit.price, hit.unit], ['TEA-250', 5, 4500, 'box']);
  expectError(() => inv.lookupBarcode(ctx, as('clerk'), '000'), 'BARCODE_NOT_FOUND');
  expectError(() => inv.setItemSettings(ctx, as('manager'), 'RICE-1K', { barcode: '6221234567890' }), 'DUPLICATE_BARCODE');
  expectError(() => inv.setItemSettings(ctx, as('manager'), 'RICE-1K', { barcode: 'a b' }), 'BAD_BARCODE');
  expectError(() => inv.setItemSettings(ctx, as('manager'), 'RICE-1K', { unit: 'parsec' }), 'UNKNOWN_UNIT');
  expectError(() => inv.setItemSettings(ctx, as('manager'), 'RICE-1K', { reorderLevel: -1 }), 'BAD_INPUT');
  inv.setItemSettings(ctx, as('manager'), 'TEA-250', { barcode: null });
  expectError(() => inv.lookupBarcode(ctx, as('clerk'), '6221234567890'), 'BARCODE_NOT_FOUND');
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'inventory.item_settings'").get());
});

test('inventory: low-stock list and widget use reorder levels; out-of-stock and negative are included', () => {
  const { ctx, as } = setup();
  receive(ctx, as('owner'), 'TEA-250', 5, 1000);
  receive(ctx, as('owner'), 'RICE-1K', 50, 1000);
  inv.setItemSettings(ctx, as('manager'), 'TEA-250', { reorderLevel: 5, reorderQty: 24 });
  inv.setItemSettings(ctx, as('manager'), 'RICE-1K', { reorderLevel: 10 });
  assert.deepEqual(inv.lowStock(ctx, as('clerk')).map((r) => [r.sku, r.qty, r.reorder_qty]), [['TEA-250', 5, 24]]);
  inv.adjustStock(ctx, as('manager'), { sku: 'RICE-1K', qty: -45, reason: 'Water damage' });
  const w = inv.widgets(ctx, as('clerk')).inventory;
  assert.equal(w.lowCount, 2);
  assert.equal(w.low[0].qty, 5);
  assert.deepEqual(inv.widgets(ctx, { permissions: new Set(), limits: {} }), {});
});

test('inventory: warehouses have a default, a new default replaces it, and non-empty or default ones cannot be deactivated', () => {
  const { ctx, as } = setup();
  const list = inv.listWarehouses(ctx, as('clerk'));
  assert.deepEqual(list.map((w) => [w.code, w.is_default]), [['MAIN', 1]]);
  const b = inv.createWarehouse(ctx, as('manager'), { code: 'back', name: 'Back store', name_ar: 'المخزن الخلفي' });
  expectError(() => inv.createWarehouse(ctx, as('manager'), { code: 'BACK', name: 'Dup' }), 'DUPLICATE');
  expectError(() => inv.updateWarehouse(ctx, as('manager'), 1, { active: false }), 'DEFAULT_WAREHOUSE');
  receive(ctx, as('owner'), 'TEA-250', 2, 100);
  inv.updateWarehouse(ctx, as('manager'), b.id, { isDefault: true });
  assert.deepEqual(inv.listWarehouses(ctx, as('clerk')).filter((w) => w.is_default).map((w) => w.code), ['BACK']);
  expectError(() => inv.updateWarehouse(ctx, as('manager'), 1, { active: false }), 'WAREHOUSE_NOT_EMPTY');
  inv.transferStock(ctx, as('manager'), { sku: 'TEA-250', qty: 2, fromWarehouseId: 1, toWarehouseId: b.id });
  inv.updateWarehouse(ctx, as('manager'), 1, { active: false });
  expectError(() => inv.receiveStock(ctx, as('owner'), { supplier: 'S', sku: 'TEA-250', qty: 1, unitCost: 100, warehouseId: 1 }), 'WAREHOUSE_INACTIVE');
});

test('inventory: units can be added once and the allow_negative setting round-trips with an audit row', () => {
  const { ctx, as } = setup();
  assert.equal(inv.getSettings(ctx, as('clerk')).allowNegative, true);
  inv.createUnit(ctx, as('manager'), { code: 'Carton', name: 'Carton', name_ar: 'كرتونة' });
  expectError(() => inv.createUnit(ctx, as('manager'), { code: 'carton', name: 'x' }), 'DUPLICATE');
  assert.ok(inv.listUnits(ctx, as('clerk')).some((u) => u.code === 'carton'));
  inv.putSettings(ctx, as('manager'), { allowNegative: false });
  assert.equal(inv.getSettings(ctx, as('clerk')).allowNegative, false);
  expectError(() => inv.putSettings(ctx, as('manager'), { allowNegative: 'no' }), 'BAD_INPUT');
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'inventory.settings'").get());
});

test('inventory: mulDiv rounds half away from zero and survives values beyond 2^53', () => {
  assert.equal(inv.mulDiv(10, 1, 4), 3);
  assert.equal(inv.mulDiv(-10, 1, 4), -3);
  assert.equal(inv.mulDiv(9, 1, 4), 2);
  assert.equal(inv.mulDiv(900000000000000, 900000000, 900000001) > 0, true);
});

test('inventory http: routes enforce permissions and the receive -> sale -> valuation flow works end to end', async () => {
  const { ctx } = setup();
  const { server, call } = await startApp(createApp, ctx);
  try {
    assert.equal((await call('GET', '/api/inventory/stock')).status, 401);
    const denied = await call('POST', '/api/inventory/receive', 3, { supplier: 'S', sku: 'TEA-250', qty: 1, unitCost: 100 });
    assert.equal(denied.status, 403);
    const ok = await call('POST', '/api/inventory/receive', 4, { supplier: 'Delta', sku: 'TEA-250', qty: 10, unitCost: 3000 });
    assert.equal(ok.status, 201);
    const sale = await call('POST', '/api/sales/quick', 3, { items: [{ sku: 'TEA-250', qty: 4 }] });
    assert.equal(sale.status, 201);
    const stock = await call('GET', '/api/inventory/stock', 3);
    assert.equal(stock.body.items[0].qty, 6);
    assert.equal(stock.body.items[0].value, undefined);
    assert.equal((await call('GET', '/api/inventory/valuation', 3)).status, 403);
    const val = await call('GET', '/api/inventory/valuation', 2);
    assert.deepEqual([val.body.total, val.body.ledgerBalance, val.body.reconciled], [18000, 18000, true]);
    const bad = await call('POST', '/api/inventory/adjust', 2, { sku: 'TEA-250', qty: -1 });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'BAD_INPUT');
    const home = await call('GET', '/api/home', 3);
    assert.equal(home.body.widgets.inventory.tracked, 1);
    assert.equal((await call('GET', '/api/inventory/barcode/zzz', 3)).status, 404);
  } finally { server.close(); }
});

test('inventory: overview bundles the UI data and leaves out valuation for roles without costs', () => {
  const { ctx, as } = setup();
  receive(ctx, as('owner'), 'TEA-250', 5, 1000);
  const c = inv.overview(ctx, as('clerk')), m = inv.overview(ctx, as('manager'));
  assert.equal(c.valuation, null);
  assert.equal(m.valuation.reconciled, true);
  assert.equal(c.stock.items.length, 1);
  expectError(() => inv.overview(ctx, as('admin')), 'FORBIDDEN');
});
