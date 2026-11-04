import { AppError } from './errors.js';

// ---------------------------------------------------------------------------------------------
// Permission registry. Atoms are NOT listed here: every module declares its own atoms and grants
// them to built-in roles (see docs/ARCHITECTURE.md). The module loader fills these live objects.
// Roles are just bundles of atoms, so owners can clone and edit roles instead of being stuck with
// fixed ones. Sensitive areas (payroll, banking) are separate atoms.
// ---------------------------------------------------------------------------------------------
export const PERMISSIONS = {};      // atom -> description (live, filled by registerPermissions)
export const ALL_PERMISSIONS = [];  // atom names in registration order (live)
const ATOM_OWNER = new Map();       // atom -> module name that declared it

const ATOM = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

// The built-in role skeletons. Their atoms and limits arrive from modules' roleGrants / roleLimits.
// `owner` always holds every registered atom.
export const BUILTIN_ROLES = ['owner', 'manager', 'clerk', 'accountant', 'auditor', 'admin']
  .map((name) => ({ name, permissions: [], limits: {} }));
const builtin = (name) => {
  const r = BUILTIN_ROLES.find((x) => x.name === name);
  if (!r) throw new Error(`Unknown built-in role "${name}" (built-in roles: ${BUILTIN_ROLES.map((x) => x.name).join(', ')})`);
  return r;
};

/** Register atoms declared by a module. Idempotent for the same module; a clash between modules throws. */
export function registerPermissions(moduleName, atoms = {}) {
  for (const [atom, description] of Object.entries(atoms)) {
    if (!ATOM.test(atom)) throw new Error(`Module ${moduleName}: permission "${atom}" must look like "area.action"`);
    const owner = ATOM_OWNER.get(atom);
    if (owner && owner !== moduleName) throw new Error(`Permission "${atom}" is declared by both "${owner}" and "${moduleName}"`);
    if (!owner) {
      ATOM_OWNER.set(atom, moduleName);
      ALL_PERMISSIONS.push(atom);
      builtin('owner').permissions.push(atom);
    }
    PERMISSIONS[atom] = description;
  }
}

/** Grant registered atoms to a built-in role (roleGrants). Idempotent. */
export function grantBuiltin(moduleName, roleName, atoms = []) {
  const role = builtin(roleName);
  for (const a of atoms) {
    if (!ATOM_OWNER.has(a)) throw new Error(`Module ${moduleName}: cannot grant unknown permission "${a}" to ${roleName}`);
    if (!role.permissions.includes(a)) role.permissions.push(a);
  }
}

/** Amount limits (piastres) for a built-in role (roleLimits). */
export function limitBuiltin(moduleName, roleName, limits = {}) {
  const role = builtin(roleName);
  for (const [atom, max] of Object.entries(limits)) {
    if (!ATOM_OWNER.has(atom)) throw new Error(`Module ${moduleName}: limit on unknown permission "${atom}"`);
    role.limits[atom] = max;
  }
}

/**
 * Bring the built-in roles in the database up to date with the registry. Runs on every startup.
 * Add-only for the built-in roles it owns: missing roles are created, newly registered atoms and
 * limits are added, nothing is removed or overwritten, and custom roles (builtin = 0) are never touched.
 */
export function syncBuiltinRoles(ctx) {
  const { db } = ctx;
  const created = [], updated = [];
  for (const r of BUILTIN_ROLES) {
    const row = db.prepare('SELECT id, permissions, limits, builtin FROM roles WHERE name = ?').get(r.name);
    if (!row) {
      db.prepare('INSERT INTO roles (name, permissions, limits, builtin) VALUES (?,?,?,1)').run(r.name, JSON.stringify(r.permissions), JSON.stringify(r.limits));
      created.push(r.name);
      continue;
    }
    if (!row.builtin) continue; // a custom role that happens to share the name: leave it alone
    const have = JSON.parse(row.permissions);
    const limits = JSON.parse(row.limits);
    const addPerms = r.permissions.filter((p) => !have.includes(p));
    const addLimits = Object.keys(r.limits).filter((k) => !(k in limits));
    if (!addPerms.length && !addLimits.length) continue;
    for (const k of addLimits) limits[k] = r.limits[k];
    db.prepare('UPDATE roles SET permissions = ?, limits = ? WHERE id = ?').run(JSON.stringify([...have, ...addPerms]), JSON.stringify(limits), row.id);
    updated.push(r.name);
  }
  return { created, updated };
}

// Segregation-of-duties pairs: one person should not hold both.
export const SOD_PAIRS = [
  [['purchases.create', 'purchases.approve'], 'Can create and approve the same bill'],
  [['ledger.post', 'period.lock'], 'Can post entries and also move the lock that protects them'],
  [['users.manage', 'purchases.approve'], 'Can grant themselves approval rights'],
  [['apikeys.manage', 'ledger.post'], 'Can mint an API key that posts entries with their own authority'],
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
  // A deactivated account is refused on every identity path (header, session, API key). No credentials row = active.
  if (ctx.db.prepare('SELECT 1 FROM auth_credentials WHERE user_id = ? AND active = 0').get(id)) throw new AppError(401, 'ACCOUNT_DISABLED', 'This account is deactivated');
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
