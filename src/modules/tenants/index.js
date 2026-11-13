import { AppError } from '../../errors.js';
import { requirePerm } from '../../permissions.js';

// Operator API for multi-tenancy (one SQLite file per tenant; see docs/tenancy.md).
// The operator is a user of the DEFAULT tenant holding tenants.manage: a request that resolved to any other tenant is refused,
// so a company's own admin can never list, create or export other companies. Tenancy is enabled by TENANTS_DIR (or the
// `tenants` option of createApp); without it these routes answer 409 TENANCY_DISABLED and the app is single-tenant as before.
const manager = (ctx) => {
  if (!ctx.tenants) throw new AppError(409, 'TENANCY_DISABLED', 'Multi-tenancy is not enabled on this server (set TENANTS_DIR)');
  return ctx.tenants;
};
const operator = (ctx, user, perm) => {
  const m = manager(ctx);
  requirePerm(user, perm);
  if (!ctx.tenant?.isDefault) throw new AppError(403, 'OPERATOR_ONLY', 'Only the operator (default tenant) can manage tenants');
  return m;
};

const OK = 200;
export default {
  name: 'tenants',
  permissions: {
    'tenants.view': 'List the companies (tenants) hosted on this server',
    'tenants.manage': 'Create, suspend and resume tenants (operator of the default tenant only)',
    'tenants.export': 'Export or back up the complete data of another tenant (operator only, owner by default)',
  },
  roleGrants: { admin: ['tenants.view', 'tenants.manage'] },
  exportTables: [],
  routes: [
    {
      method: 'GET', path: '/api/tenant', meta: { summary: 'Which company am I signed in to (and is multi-tenancy on)' },
      handler: (ctx) => ({ enabled: !!ctx.tenants, tenant: ctx.tenant ?? { id: 1, slug: 'default', name: 'Default company', isDefault: true } }),
    },
    {
      method: 'GET', path: '/api/tenants', meta: { summary: 'List tenants (operator)', permission: 'tenants.view' },
      handler: (ctx, u) => { const m = operator(ctx, u, 'tenants.view'); return { tenants: m.list() }; },
    },
    {
      method: 'POST', path: '/api/tenants', meta: { summary: 'Provision a tenant: fresh database, migrations, reference seeds (demo data only with demo: true) and an owner', permission: 'tenants.manage' },
      handler: (ctx, u, { body }) => operator(ctx, u, 'tenants.manage').create(u, body),
    },
    {
      method: 'GET', path: '/api/tenants/:slug', meta: { summary: 'One tenant with usage facts (operator)', permission: 'tenants.view' },
      handler: (ctx, u, { params }) => { const m = operator(ctx, u, 'tenants.view'); return { ...m.get(params.slug), stats: m.stats(params.slug) }; },
    },
    {
      method: 'POST', path: '/api/tenants/:slug/suspend', meta: { summary: 'Suspend a tenant: nobody can sign in or use its API', permission: 'tenants.manage', status: OK },
      handler: (ctx, u, { params }) => operator(ctx, u, 'tenants.manage').setStatus(u, params.slug, 'suspended'),
    },
    {
      method: 'POST', path: '/api/tenants/:slug/resume', meta: { summary: 'Resume a suspended tenant', permission: 'tenants.manage', status: OK },
      handler: (ctx, u, { params }) => operator(ctx, u, 'tenants.manage').setStatus(u, params.slug, 'active'),
    },
    {
      method: 'GET', path: '/api/tenants/:slug/export', meta: { summary: 'Export all data of one tenant as JSON (operator, audited in both databases)', permission: 'tenants.export' },
      handler: (ctx, u, { params }) => operator(ctx, u, 'tenants.export').exportTenant(u, params.slug),
    },
    {
      method: 'POST', path: '/api/tenants/:slug/backup', meta: { summary: 'Write a consistent copy of the tenant database file to TENANTS_DIR/backups', permission: 'tenants.export', status: OK },
      handler: (ctx, u, { params }) => operator(ctx, u, 'tenants.export').backup(u, params.slug),
    },
  ],
};
