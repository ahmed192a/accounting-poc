import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as s from './service.js';
import { seed, demoSeed } from './seed.js';

const UI_MODULES_DIR = fileURLToPath(new URL('../../../public/modules/', import.meta.url));

// Core: home, demo users, users and roles, audit search, export, UI module list.
export default {
  name: 'core',
  permissions: {
    'payroll.view': 'See payroll data',
    'audit.view': 'Search the audit log',
    'users.manage': 'Assign roles to users',
    'roles.manage': 'Create and edit roles',
    'export.all': 'Export all data, including the audit log',
  },
  roleGrants: {
    manager: ['audit.view'],
    accountant: ['audit.view'],
    auditor: ['audit.view'],
    admin: ['users.manage', 'roles.manage', 'export.all'],
  },
  exportTables: [],
  routes: [
    { method: 'GET', path: '/healthz', public: true, handler: () => ({ ok: true }), meta: { summary: 'Health check' } },
    { method: 'GET', path: '/api/demo-users', public: true, handler: (ctx) => s.demoUsers(ctx), meta: { summary: 'List demo users (user switcher)' } },
    {
      method: 'GET', path: '/api/ui-modules', public: true, meta: { summary: 'File names in public/modules, imported by the UI shell' },
      handler: () => (existsSync(UI_MODULES_DIR) ? readdirSync(UI_MODULES_DIR).filter((f) => f.endsWith('.js')).sort() : []),
    },
    { method: 'GET', path: '/api/home', handler: (ctx, u) => s.home(ctx, u), meta: { summary: 'Role-specific home: user, permissions, widgets' } },
    { method: 'GET', path: '/api/audit', handler: (ctx, u, r) => s.auditSearch(ctx, u, r.query), meta: { summary: 'Search the audit log', permission: 'audit.view' } },
    { method: 'GET', path: '/api/roles', handler: (ctx, u) => s.listRoles(ctx, u), meta: { summary: 'List roles', permission: 'roles.manage' } },
    { method: 'POST', path: '/api/roles', handler: (ctx, u, r) => s.createRole(ctx, u, r.body), meta: { summary: 'Create a custom role', permission: 'roles.manage' } },
    { method: 'PATCH', path: '/api/roles/:id', handler: (ctx, u, r) => s.updateRole(ctx, u, Number(r.params.id), r.body), meta: { summary: 'Edit a custom role (permissions, limits, name)', permission: 'roles.manage' } },
    { method: 'PATCH', path: '/api/users/:id', handler: (ctx, u, r) => s.setUserRole(ctx, u, Number(r.params.id), r.body.roleId), meta: { summary: 'Assign a role to a user', permission: 'users.manage' } },
    { method: 'GET', path: '/api/export', handler: (ctx, u) => s.exportAll(ctx, u), meta: { summary: 'Export everything, including the audit log', permission: 'export.all' } },
    // Demo only: move the clock forward to see the 24-hour e-receipt deadline in action.
    {
      method: 'POST', path: '/api/dev/advance-clock', meta: { summary: 'Demo: advance the server clock' },
      handler: (ctx, u, r) => { ctx.offsetMs += Number(r.body.hours ?? 0) * 3600 * 1000; return { now: new Date(ctx.now()).toISOString() }; },
    },
  ],
  widgets: s.widgets,
  seed,
  demoSeed,
};
