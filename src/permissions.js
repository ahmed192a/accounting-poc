import { AppError } from './errors.js';

// Permission atoms. Roles are just bundles of these, so owners can clone and edit roles
// instead of being stuck with fixed ones. Sensitive areas (payroll, banking) are separate atoms.
export const PERMISSIONS = {
  'sales.view': 'See invoices and sales',
  'sales.create': 'Create invoices, quick sales and record payments',
  'purchases.view': 'See bills',
  'purchases.create': 'Create bills (amount-limited)',
  'purchases.approve': 'Approve bills (amount-limited)',
  'banking.view': 'See cash and bank balances',
  'payroll.view': 'See payroll data',
  'ledger.view': 'Read the journal and trial balance',
  'ledger.post': 'Post manual journal entries',
  'ledger.reverse': 'Reverse journal entries',
  'period.lock': 'Set or lift the period lock',
  'reports.view': 'See financial reports',
  'audit.view': 'Search the audit log',
  'users.manage': 'Assign roles to users',
  'roles.manage': 'Create and edit roles',
  'eta.manage': 'Manage ETA connection and queue',
  'export.all': 'Export all data, including the audit log',
};
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS);

const EGP = 100;
export const BUILTIN_ROLES = [
  { name: 'owner', permissions: ALL_PERMISSIONS, limits: {} },
  {
    name: 'manager',
    // Approves but does not create bills, so the manager holds no separation-of-duties conflict.
    permissions: ['sales.view', 'sales.create', 'purchases.view', 'purchases.approve', 'banking.view', 'reports.view', 'period.lock', 'audit.view', 'eta.manage'],
    limits: { 'purchases.approve': 20000 * EGP },
  },
  {
    name: 'clerk',
    permissions: ['sales.view', 'sales.create', 'purchases.view', 'purchases.create'],
    limits: { 'purchases.create': 5000 * EGP },
  },
  {
    name: 'accountant',
    permissions: ['sales.view', 'purchases.view', 'banking.view', 'ledger.view', 'ledger.post', 'ledger.reverse', 'reports.view', 'audit.view'],
    limits: {},
  },
  {
    name: 'auditor',
    permissions: ['sales.view', 'purchases.view', 'ledger.view', 'reports.view', 'audit.view'],
    limits: {},
  },
  {
    name: 'admin',
    permissions: ['users.manage', 'roles.manage', 'eta.manage', 'export.all'],
    limits: {},
  },
];

// Segregation-of-duties pairs: one person should not hold both.
export const SOD_PAIRS = [
  [['purchases.create', 'purchases.approve'], 'Can create and approve the same bill'],
  [['ledger.post', 'period.lock'], 'Can post entries and also move the lock that protects them'],
  [['users.manage', 'purchases.approve'], 'Can grant themselves approval rights'],
];

export function sodConflicts(permissions) {
  const set = new Set(permissions);
  return SOD_PAIRS.filter(([pair]) => pair.every((p) => set.has(p))).map(([pair, reason]) => ({ pair, reason }));
}

export function loadUser(ctx, id) {
  const row = ctx.db
    .prepare('SELECT u.id, u.name, u.role_id, r.name AS role, r.permissions, r.limits FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?')
    .get(id);
  if (!row) throw new AppError(401, 'UNKNOWN_USER', 'Unknown user');
  return {
    id: row.id, name: row.name, roleId: row.role_id, role: row.role,
    permissions: new Set(JSON.parse(row.permissions)),
    limits: JSON.parse(row.limits),
  };
}

export function requirePerm(user, perm) {
  if (!user.permissions.has(perm)) {
    throw new AppError(403, 'FORBIDDEN', `Role "${user.role}" does not have permission ${perm}`);
  }
}

export function requireAny(user, perms) {
  if (!perms.some((p) => user.permissions.has(p))) {
    throw new AppError(403, 'FORBIDDEN', `Role "${user.role}" needs one of: ${perms.join(', ')}`);
  }
}

// Amount limit for a permission, in piastres. No limit configured = unlimited.
export function limitFor(user, perm) {
  const l = user.limits[perm];
  return l == null ? Infinity : l;
}
