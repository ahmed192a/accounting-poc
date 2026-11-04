import * as s from './service.js';

// Mock ETA (Egyptian Tax Authority) e-receipt adapter, offline queue and routes.
export default {
  name: 'eta',
  permissions: { 'eta.manage': 'Manage ETA connection and queue' },
  roleGrants: { manager: ['eta.manage'], admin: ['eta.manage'] },
  routes: [
    { method: 'GET', path: '/api/eta/queue', handler: (ctx, u) => s.etaQueue(ctx, u), meta: { summary: 'E-receipt queue', permission: 'sales.view' } },
    { method: 'POST', path: '/api/eta/sync', handler: (ctx, u) => s.etaSync(ctx, u), meta: { summary: 'Submit queued receipts now', permission: 'eta.manage' } },
    { method: 'POST', path: '/api/eta/online', handler: (ctx, u, r) => s.etaSetOnline(ctx, u, r.body.online), meta: { summary: 'Set the (mock) ETA connection on or off', permission: 'eta.manage' } },
  ],
  widgets: s.widgets,
  seed(ctx) {
    ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('eta_online', '1')").run();
  },
};
