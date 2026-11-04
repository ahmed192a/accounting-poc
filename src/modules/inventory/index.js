import * as s from './service.js';
import { seed } from './seed.js';

const EGP = 100;

// Inventory: warehouses, units, barcodes, reorder levels, append-only stock movements, weighted-average costing,
// COGS on sale/invoice, stocktake, valuation that reconciles to ledger account 1300. See docs/inventory.md.
export default {
  name: 'inventory',
  permissions: {
    'inventory.view': 'See stock levels, movements and low-stock alerts',
    'inventory.costs': 'See unit costs, stock values and the valuation report',
    'inventory.receive': 'Receive stock from suppliers (posts to inventory and accounts payable)',
    'inventory.adjust': 'Adjust, transfer, return and count stock (posts shrinkage and gains)',
    'inventory.manage': 'Manage warehouses, units, barcodes, reorder levels and inventory settings',
  },
  roleGrants: {
    manager: ['inventory.view', 'inventory.costs', 'inventory.receive', 'inventory.adjust', 'inventory.manage'],
    accountant: ['inventory.view', 'inventory.costs', 'inventory.receive', 'inventory.adjust'],
    clerk: ['inventory.view'],
    auditor: ['inventory.view', 'inventory.costs'],
  },
  // A manager may adjust or receive up to 50,000 EGP of stock value per document; larger needs the owner or accountant.
  roleLimits: { manager: { 'inventory.adjust': 50000 * EGP, 'inventory.receive': 200000 * EGP } },
  exportTables: ['inventory_warehouses', 'inventory_units', 'inventory_item_settings', 'inventory_movements', 'inventory_counts', 'inventory_count_lines'],
  hooks: s.hooks,
  routes: [
    { method: 'GET', path: '/api/inventory/stock', handler: (c, u, r) => s.listStock(c, u, r.query), meta: { summary: 'Stock on hand per item and warehouse (costs only with inventory.costs)', permission: 'inventory.view' } },
    { method: 'GET', path: '/api/inventory/stock/:sku', handler: (c, u, r) => s.stockDetail(c, u, r.params.sku), meta: { summary: 'One stock item with its recent movements', permission: 'inventory.view' } },
    { method: 'GET', path: '/api/inventory/movements', handler: (c, u, r) => s.listMovements(c, u, r.query), meta: { summary: 'Stock movements (append-only), filter by sku, kind, warehouse', permission: 'inventory.view' } },
    { method: 'GET', path: '/api/inventory/barcode/:code', handler: (c, u, r) => s.lookupBarcode(c, u, r.params.code), meta: { summary: 'Find an item and its stock by barcode', permission: 'inventory.view' } },
    { method: 'GET', path: '/api/inventory/low-stock', handler: (c, u) => s.lowStock(c, u), meta: { summary: 'Items at or below their reorder level, or negative', permission: 'inventory.view' } },
    { method: 'GET', path: '/api/inventory/warnings', handler: (c, u) => s.warnings(c, u), meta: { summary: 'Negative stock and movements with unknown cost', permission: 'inventory.view' } },
    { method: 'GET', path: '/api/inventory/valuation', handler: (c, u) => s.valuation(c, u), meta: { summary: 'Valuation (qty, average cost, value) reconciled to ledger account 1300', permission: 'inventory.costs' } },
    { method: 'POST', path: '/api/inventory/receive', handler: (c, u, r) => s.receiveStock(c, u, r.body), meta: { summary: 'Receive stock from a supplier: Dr 1300 / Cr 2000', permission: 'inventory.receive' } },
    { method: 'POST', path: '/api/inventory/adjust', handler: (c, u, r) => s.adjustStock(c, u, r.body), meta: { summary: 'Adjust stock with a required reason (shrinkage posts to 5300)', permission: 'inventory.adjust' } },
    { method: 'POST', path: '/api/inventory/return', handler: (c, u, r) => s.returnStock(c, u, r.body), meta: { summary: 'Customer return (in) or return to supplier (out)', permission: 'inventory.adjust' } },
    { method: 'POST', path: '/api/inventory/transfer', handler: (c, u, r) => s.transferStock(c, u, r.body), meta: { summary: 'Transfer stock between warehouses (no ledger effect)', permission: 'inventory.adjust' } },
    { method: 'GET', path: '/api/inventory/counts', handler: (c, u) => s.listCounts(c, u), meta: { summary: 'Stocktake sheets', permission: 'inventory.view' } },
    { method: 'POST', path: '/api/inventory/counts', handler: (c, u, r) => s.createCount(c, u, r.body), meta: { summary: 'Start a stocktake count sheet for a warehouse', permission: 'inventory.adjust' } },
    { method: 'GET', path: '/api/inventory/counts/:id', handler: (c, u, r) => s.getCount(c, u, Number(r.params.id)), meta: { summary: 'One count sheet with lines', permission: 'inventory.view' } },
    { method: 'PUT', path: '/api/inventory/counts/:id', handler: (c, u, r) => s.saveCountLines(c, u, Number(r.params.id), r.body), meta: { summary: 'Enter counted quantities', permission: 'inventory.adjust' } },
    { method: 'POST', path: '/api/inventory/counts/:id/post', handler: (c, u, r) => s.postCount(c, u, Number(r.params.id), r.body), meta: { summary: 'Post the count variances as adjustments', permission: 'inventory.adjust' } },
    { method: 'POST', path: '/api/inventory/counts/:id/cancel', handler: (c, u, r) => s.cancelCount(c, u, Number(r.params.id), r.body), meta: { summary: 'Cancel an open count sheet (reason required)', permission: 'inventory.adjust' } },
    { method: 'GET', path: '/api/inventory/items', handler: (c, u) => s.listItemSettings(c, u), meta: { summary: 'All catalogue items with their stock settings', permission: 'inventory.view' } },
    { method: 'PUT', path: '/api/inventory/items/:sku', handler: (c, u, r) => s.setItemSettings(c, u, r.params.sku, r.body), meta: { summary: 'Set tracking, unit, barcode and reorder levels for an item', permission: 'inventory.manage' } },
    { method: 'GET', path: '/api/inventory/warehouses', handler: (c, u) => s.listWarehouses(c, u), meta: { summary: 'Warehouses', permission: 'inventory.view' } },
    { method: 'POST', path: '/api/inventory/warehouses', handler: (c, u, r) => s.createWarehouse(c, u, r.body), meta: { summary: 'Create a warehouse', permission: 'inventory.manage' } },
    { method: 'PATCH', path: '/api/inventory/warehouses/:id', handler: (c, u, r) => s.updateWarehouse(c, u, Number(r.params.id), r.body), meta: { summary: 'Rename, set default or deactivate a warehouse', permission: 'inventory.manage' } },
    { method: 'GET', path: '/api/inventory/units', handler: (c, u) => s.listUnits(c, u), meta: { summary: 'Units of measure', permission: 'inventory.view' } },
    { method: 'POST', path: '/api/inventory/units', handler: (c, u, r) => s.createUnit(c, u, r.body), meta: { summary: 'Add a unit of measure', permission: 'inventory.manage' } },
    { method: 'GET', path: '/api/inventory/settings', handler: (c, u) => s.getSettings(c, u), meta: { summary: 'Inventory settings (allow negative stock)', permission: 'inventory.view' } },
    { method: 'PUT', path: '/api/inventory/settings', handler: (c, u, r) => s.putSettings(c, u, r.body), meta: { summary: 'Change inventory settings', permission: 'inventory.manage' } },
  ],
  widgets: s.widgets,
  seed,
};
