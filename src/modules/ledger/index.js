import * as s from './service.js';
import { entityIdOf, getFiscal } from '../entities/service.js';
import { seed } from './seed.js';
import * as closing from './closing.js';

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
    'ledger.close': 'Post and reverse year-end closing entries',
  },
  roleGrants: {
    manager: ['banking.view', 'reports.view', 'period.lock', 'ledger.close'],
    accountant: ['banking.view', 'ledger.view', 'ledger.post', 'ledger.reverse', 'reports.view'],
    auditor: ['ledger.view', 'reports.view'],
  },
  routes: [
    { method: 'GET', path: '/api/entries', handler: (ctx, u, r) => s.entries(ctx, u, r.query), meta: { summary: 'Recent journal entries', permission: 'ledger.view' } },
    { method: 'POST', path: '/api/entries', handler: (ctx, u, r) => s.manualEntry(ctx, u, r.body), meta: { summary: 'Post a manual journal entry', permission: 'ledger.post' } },
    { method: 'POST', path: '/api/entries/:id/reverse', handler: (ctx, u, r) => s.reverse(ctx, u, Number(r.params.id), r.body.reason), meta: { summary: 'Reverse an entry (reason required)', permission: 'ledger.reverse' } },
    { method: 'POST', path: '/api/period-lock', handler: (ctx, u, r) => s.lockPeriod(ctx, u, r.body), meta: { summary: 'Set or lift the period lock (reason required)', permission: 'period.lock' } },
    { method: 'GET', path: '/api/reports', handler: (ctx, u, r) => s.reports(ctx, u, r.query), meta: { summary: 'Trial balance and profit and loss', permission: 'reports.view' } },
    { method: 'GET', path: '/api/ledger/fiscal', handler: (ctx, u, r) => getFiscal(ctx, u, entityIdOf(r.query)), meta: { summary: 'Fiscal year settings of an entity', permission: 'ledger.view' } },
    { method: 'GET', path: '/api/ledger/closings', handler: (ctx, u, r) => closing.listClosings(ctx, u, entityIdOf(r.query)), meta: { summary: 'Year-end closings of an entity', permission: 'ledger.view' } },
    { method: 'POST', path: '/api/ledger/close-year', handler: (ctx, u, r) => closing.closeYear(ctx, u, { ...r.body, entityId: entityIdOf(r.body) }), meta: { summary: 'Post the year-end closing entry to retained earnings 3000', permission: 'ledger.close' } },
    { method: 'POST', path: '/api/ledger/closings/:id/reverse', handler: (ctx, u, r) => closing.reverseClosing(ctx, u, Number(r.params.id), r.body.reason, r.body), meta: { summary: 'Reverse a closing entry (reopens the year)', permission: 'ledger.close' } },
  ],
  widgets: s.widgets,
  seed,
};
