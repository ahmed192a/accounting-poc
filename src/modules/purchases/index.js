import * as s from './service.js';
import { seed } from './seed.js';

const EGP = 100;

// Bills, amount limits, approval with separation of duties.
export default {
  name: 'purchases',
  permissions: {
    'purchases.view': 'See bills',
    'purchases.create': 'Create bills (amount-limited)',
    'purchases.approve': 'Approve bills (amount-limited)',
  },
  // The manager approves but does not create bills, so it holds no separation-of-duties conflict.
  roleGrants: {
    manager: ['purchases.view', 'purchases.approve'],
    clerk: ['purchases.view', 'purchases.create'],
    accountant: ['purchases.view'],
    auditor: ['purchases.view'],
  },
  roleLimits: {
    manager: { 'purchases.approve': 20000 * EGP },
    clerk: { 'purchases.create': 5000 * EGP },
  },
  routes: [
    { method: 'GET', path: '/api/bills', handler: (ctx, u) => s.listBills(ctx, u), meta: { summary: 'List bills', permission: 'purchases.view' } },
    { method: 'POST', path: '/api/bills', handler: (ctx, u, r) => s.createBill(ctx, u, r.body), meta: { summary: 'Create a bill (auto-approved under the threshold)', permission: 'purchases.create' } },
    { method: 'POST', path: '/api/bills/:id/approve', handler: (ctx, u, r) => s.approveBill(ctx, u, Number(r.params.id)), meta: { summary: 'Approve a pending bill', permission: 'purchases.approve' } },
  ],
  widgets: s.widgets,
  seed,
};
