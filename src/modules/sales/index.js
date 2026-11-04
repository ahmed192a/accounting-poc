import * as s from './service.js';
import { seed } from './seed.js';

// Items, quick sale, invoices.
export default {
  name: 'sales',
  permissions: {
    'sales.view': 'See invoices and sales',
    'sales.create': 'Create invoices, quick sales and record payments',
  },
  roleGrants: {
    manager: ['sales.view', 'sales.create'],
    clerk: ['sales.view', 'sales.create'],
    accountant: ['sales.view'],
    auditor: ['sales.view'],
  },
  routes: [
    { method: 'GET', path: '/api/items', handler: (ctx, u) => s.listItems(ctx, u), meta: { summary: 'Item catalogue', permission: 'sales.view' } },
    { method: 'POST', path: '/api/sales/quick', handler: (ctx, u, r) => s.quickSale(ctx, u, r.body), meta: { summary: 'Quick sale: posts to the ledger and queues an e-receipt', permission: 'sales.create' } },
    { method: 'GET', path: '/api/invoices', handler: (ctx, u) => s.listInvoices(ctx, u), meta: { summary: 'List invoices', permission: 'sales.view' } },
    { method: 'POST', path: '/api/invoices', handler: (ctx, u, r) => s.createInvoice(ctx, u, r.body), meta: { summary: 'Create an invoice', permission: 'sales.create' } },
    { method: 'POST', path: '/api/invoices/:id/pay', handler: (ctx, u, r) => s.payInvoice(ctx, u, Number(r.params.id)), meta: { summary: 'Record payment of an invoice', permission: 'sales.create' } },
  ],
  widgets: s.widgets,
  seed,
};
