import * as s from './service.js';

// Financial reports: statements, aging, sales analysis, VAT summary, general ledger, dashboards, saved filters.
// Read-only over the ledger. Basic access reuses reports.view (declared by the ledger module).
const R = (name, path, handler, summary, permission) => ({ method: 'GET', path, handler, meta: { summary, permission } });

export default {
  name: 'reports',
  permissions: {
    'reports.export': 'Export reports as CSV or print-friendly HTML',
    'reports.advanced': 'Advanced reports: cash flow, aging, general ledger, drill-down to entries, shared filters',
  },
  roleGrants: {
    manager: ['reports.export', 'reports.advanced'],
    accountant: ['reports.export', 'reports.advanced'],
    auditor: ['reports.export', 'reports.advanced'],
  },
  exportTables: ['reports_saved_filters'],
  routes: [
    R('catalogue', '/api/report-catalogue', (ctx, u) => s.catalogue(ctx, u), 'List the reports the caller may run', 'reports.view'),
    R('run', '/api/reports/:name', (ctx, u, r) => s.runReport(ctx, u, r.params.name, r.query),
      'Run a report: name is trial-balance, profit-loss, balance-sheet, cash-flow, ar-aging, ap-aging, sales-by-item, sales-by-customer, sales-by-day, vat-summary, general-ledger, account-transactions or dashboard; ?format=json|csv|html&from&to&compare=previous|year|custom&entityId', 'reports.view (+reports.advanced for advanced reports, +reports.export for csv/html)'),
    R('kpis', '/api/report-kpis', (ctx, u, r) => s.kpiReport(ctx, u, r.query), 'KPI widgets: gross margin, DSO approximation, current ratio', 'reports.view'),
    R('entry', '/api/report-entries/:id', (ctx, u, r) => s.entryDetail(ctx, u, r.params.id), 'Drill-down: one journal entry with its lines', 'reports.advanced'),
    R('filters', '/api/report-filters', (ctx, u, r) => s.listFilters(ctx, u, r.query), 'Saved report filters (own and shared)', 'reports.view'),
    { method: 'POST', path: '/api/report-filters', handler: (ctx, u, r) => s.saveFilter(ctx, u, r.body), meta: { summary: 'Save a report filter', permission: 'reports.view' } },
    { method: 'DELETE', path: '/api/report-filters/:id', handler: (ctx, u, r) => s.deleteFilter(ctx, u, r.params.id), meta: { summary: 'Delete an own saved filter', permission: 'reports.view' } },
  ],
  widgets: s.widgets,
};
