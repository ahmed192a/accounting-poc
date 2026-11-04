import { AppError } from '../../errors.js';
import { tx, audit } from '../../ledger.js';
import { PERMISSIONS, ALL_PERMISSIONS, requirePerm, requireAny, sodConflicts } from '../../permissions.js';
import { setting } from '../../db.js';
import { authRequired } from '../auth/config.js';

// ---------- Users and roles ----------
// With AUTH_REQUIRED=1 the demo user list is not public: it would hand out the names of real accounts.
const allUsers = (ctx) =>
  ctx.db.prepare('SELECT u.id, u.name, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.id').all();

export const demoUsers = (ctx) => (authRequired(ctx) ? [] : allUsers(ctx));

export function listRoles(ctx, user) {
  requireAny(user, ['roles.manage', 'users.manage']);
  return ctx.db.prepare('SELECT * FROM roles ORDER BY id').all().map((r) => {
    const permissions = JSON.parse(r.permissions);
    return { id: r.id, name: r.name, builtin: !!r.builtin, permissions, limits: JSON.parse(r.limits), sodWarnings: sodConflicts(permissions) };
  });
}

export function createRole(ctx, user, input) {
  requirePerm(user, 'roles.manage');
  const { db } = ctx;
  if (!input.name || !String(input.name).trim()) throw new AppError(400, 'BAD_INPUT', 'Role name is required');
  if (!Array.isArray(input.permissions) || input.permissions.some((p) => !ALL_PERMISSIONS.includes(p))) {
    throw new AppError(400, 'BAD_INPUT', 'Unknown permission in list');
  }
  if (db.prepare('SELECT 1 FROM roles WHERE name = ?').get(input.name)) throw new AppError(409, 'DUPLICATE', 'A role with this name exists');
  const limits = input.limits ?? {};
  return tx(db, () => {
    const res = db.prepare('INSERT INTO roles (name, permissions, limits, builtin) VALUES (?,?,?,0)').run(input.name, JSON.stringify(input.permissions), JSON.stringify(limits));
    const id = Number(res.lastInsertRowid);
    audit(ctx, { userId: user.id, action: 'role.created', type: 'role', id, newValue: { name: input.name, permissions: input.permissions, limits } });
    return { id, sodWarnings: sodConflicts(input.permissions) };
  });
}

// Edit a CUSTOM role. Built-in roles are never edited (clone one instead). Nobody can put a permission into a role
// that they do not hold themselves, so a roles.manage holder cannot grant themselves more through a role edit.
export function updateRole(ctx, user, roleId, input = {}) {
  requirePerm(user, 'roles.manage');
  const { db } = ctx;
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
  if (!role) throw new AppError(404, 'NOT_FOUND', 'Role not found');
  if (role.builtin) throw new AppError(403, 'BUILTIN_ROLE', 'Built-in roles cannot be edited; create a custom role instead');
  const oldPerms = JSON.parse(role.permissions), oldLimits = JSON.parse(role.limits);
  const permissions = input.permissions ?? oldPerms;
  if (!Array.isArray(permissions) || permissions.some((p) => !ALL_PERMISSIONS.includes(p))) throw new AppError(400, 'BAD_INPUT', 'Unknown permission in list');
  const added = permissions.filter((p) => !oldPerms.includes(p) && !user.permissions.has(p));
  if (added.length) throw new AppError(403, 'FORBIDDEN', `You cannot grant permissions you do not hold: ${added.slice(0, 5).join(', ')}`);
  const limits = input.limits ?? oldLimits;
  if (typeof limits !== 'object' || limits === null || Object.values(limits).some((v) => !Number.isInteger(v) || v < 0)) throw new AppError(400, 'BAD_INPUT', 'Limits must be whole piastre amounts');
  const name = input.name == null ? role.name : String(input.name).trim();
  if (!name) throw new AppError(400, 'BAD_INPUT', 'Role name is required');
  if (name !== role.name && db.prepare('SELECT 1 FROM roles WHERE name = ?').get(name)) throw new AppError(409, 'DUPLICATE', 'A role with this name exists');
  return tx(db, () => {
    db.prepare('UPDATE roles SET name = ?, permissions = ?, limits = ? WHERE id = ?').run(name, JSON.stringify(permissions), JSON.stringify(limits), roleId);
    audit(ctx, { userId: user.id, action: 'role.updated', type: 'role', id: roleId, oldValue: { name: role.name, permissions: oldPerms, limits: oldLimits }, newValue: { name, permissions, limits } });
    return { id: roleId, name, sodWarnings: sodConflicts(permissions) };
  });
}

export function setUserRole(ctx, user, userId, roleId) {
  requirePerm(user, 'users.manage');
  const { db } = ctx;
  const target = db.prepare('SELECT u.id, u.name, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?').get(userId);
  if (!target) throw new AppError(404, 'NOT_FOUND', 'User not found');
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
  if (!role) throw new AppError(404, 'NOT_FOUND', 'Role not found');
  return tx(db, () => {
    db.prepare('UPDATE users SET role_id = ? WHERE id = ?').run(roleId, userId);
    audit(ctx, { userId: user.id, action: 'user.role_changed', type: 'user', id: userId, oldValue: { role: target.role }, newValue: { role: role.name } });
    return { id: userId, role: role.name, sodWarnings: sodConflicts(JSON.parse(role.permissions)) };
  });
}

// ---------- Audit search ----------
export function auditSearch(ctx, user, { q, userId } = {}) {
  requirePerm(user, 'audit.view');
  const rows = ctx.db
    .prepare(`SELECT a.id, a.ts, a.user_id, COALESCE(u.name, 'system') AS user_name, a.action, a.record_type, a.record_id,
                a.old_value, a.new_value, a.reason
              FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 500`)
    .all();
  const needle = (q ?? '').toLowerCase();
  return rows
    .filter((r) => !userId || String(r.user_id) === String(userId))
    .filter((r) => !needle || [r.action, r.user_name, r.record_type, r.new_value, r.reason].some((v) => v && String(v).toLowerCase().includes(needle)))
    .slice(0, 100);
}

// ---------- Export ----------
// Core tables plus every table a module lists in its `exportTables`.
const CORE_TABLES = ['accounts', 'journal_entries', 'journal_lines', 'audit_log', 'invoices', 'bills', 'sales', 'receipts', 'users', 'roles', 'items', 'settings', 'period_lock'];

export function exportAll(ctx, user) {
  requirePerm(user, 'export.all');
  const tables = [...new Set([...CORE_TABLES, ...(ctx.registry?.exportTables ?? [])])];
  const out = { exportedAt: new Date(ctx.now()).toISOString(), format: 'accounting-poc/v1' };
  for (const t of tables) out[t] = ctx.db.prepare(`SELECT * FROM ${t}`).all();
  audit(ctx, { userId: user.id, action: 'data.exported' });
  return out;
}

// ---------- Home: widgets come from permissions (and from each module), not from hard-coded role names ----------
export function home(ctx, user) {
  return {
    user: { id: user.id, name: user.name, role: user.role },
    permissions: [...user.permissions],
    limits: user.limits,
    vatRateBp: Number(setting(ctx.db, 'vat_rate_bp')),
    widgets: ctx.registry.buildWidgets(ctx, user),
  };
}

// Core's own home widgets.
export function widgets(ctx, user) {
  const { db } = ctx;
  const has = (p) => user.permissions.has(p);
  const w = {};
  // Cross-module by nature (invoices from sales, bills from purchases), so core owns it.
  if (has('sales.create')) {
    w.myWork = {
      invoices: db.prepare('SELECT id, number, customer, total, paid FROM invoices WHERE created_by = ? ORDER BY id DESC LIMIT 5').all(user.id),
      bills: db.prepare('SELECT id, supplier, amount, status FROM bills WHERE created_by = ? ORDER BY id DESC LIMIT 5').all(user.id),
    };
  }
  if (has('audit.view')) w.audit = auditSearch(ctx, user).slice(0, 10);
  if (has('users.manage') || has('roles.manage')) {
    w.admin = { users: allUsers(ctx), roles: listRoles(ctx, user), permissions: PERMISSIONS };
  }
  return w;
}
