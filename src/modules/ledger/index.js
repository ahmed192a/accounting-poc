import * as s from './service.js';
import { seed } from './seed.js';

// Journal entries, reversal, period lock, reports. The posting engine itself is src/ledger.js.
export default {
  name: 'ledger',
  permissions: {
    'banking.view': 'See cash and bank balances',
    'ledger.view': 'Read the journal and trial balance',
    'ledger.post': 'Post manual journal entries',
    'ledger.reverse': 'Reverse journal entries',
    'period.lock': 'Set or lift the period lock',
    'reports.view': 'See financial reports',
  },
  roleGrants: {
    manager: ['banking.view', 'reports.view', 'period.lock'],
    accountant: ['banking.view', 'ledger.view', 'ledger.post', 'ledger.reverse', 'reports.view'],
    auditor: ['ledger.view', 'reports.view'],
  },
  routes: [
    { method: 'GET', path: '/api/entries', handler: (ctx, u) => s.entries(ctx, u), meta: { summary: 'Recent journal entries', permission: 'ledger.view' } },
    { method: 'POST', path: '/api/entries', handler: (ctx, u, r) => s.manualEntry(ctx, u, r.body), meta: { summary: 'Post a manual journal entry', permission: 'ledger.post' } },
    { method: 'POST', path: '/api/entries/:id/reverse', handler: (ctx, u, r) => s.reverse(ctx, u, Number(r.params.id), r.body.reason), meta: { summary: 'Reverse an entry (reason required)', permission: 'ledger.reverse' } },
    { method: 'POST', path: '/api/period-lock', handler: (ctx, u, r) => s.lockPeriod(ctx, u, r.body), meta: { summary: 'Set or lift the period lock (reason required)', permission: 'period.lock' } },
    { method: 'GET', path: '/api/reports', handler: (ctx, u) => s.reports(ctx, u), meta: { summary: 'Trial balance and profit and loss', permission: 'reports.view' } },
  ],
  widgets: s.widgets,
  seed,
};
