import { readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tx } from './ledger.js';
import { registerPermissions, grantBuiltin, limitBuiltin, syncBuiltinRoles } from './permissions.js';

// Backend module loader. Every folder src/modules/<name>/ with an index.js is a module; see
// docs/ARCHITECTURE.md for the contract. Nothing here needs editing to add a feature.
export const MODULES_DIR = fileURLToPath(new URL('./modules/', import.meta.url));

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const TABLE = /^[a-z_][a-z0-9_]*$/;

export function compileRoute(module, r) {
  const where = `Module ${module}: route ${r?.method} ${r?.path}`;
  if (!r || !METHODS.has(r.method)) throw new Error(`${where} needs method GET, POST, PUT, PATCH or DELETE`);
  if (typeof r.path !== 'string' || !r.path.startsWith('/')) throw new Error(`${where} needs a path starting with "/"`);
  if (typeof r.handler !== 'function') throw new Error(`${where} needs a handler function`);
  const names = [];
  const re = new RegExp('^' + r.path.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)')) + '$');
  return { module, method: r.method, path: r.path, re, names, handler: r.handler, isPublic: !!r.public, meta: r.meta ?? {} };
}

/**
 * Discover and validate the modules in a folder and merge their contributions. Pure: it touches
 * no global state (initContext applies the result). `core` always goes first, the rest alphabetically.
 * `dirs` is one folder or an array of folders (tests add a temp folder holding a fake module).
 */
export async function loadModules(dirs = MODULES_DIR) {
  const found = [];
  for (const dir of [].concat(dirs)) {
    for (const n of readdirSync(dir)) {
      if (!n.startsWith('.') && !n.startsWith('_') && statSync(join(dir, n)).isDirectory()) found.push({ folder: n, dir });
    }
  }
  found.sort((a, b) => (a.folder === 'core' ? -1 : b.folder === 'core' ? 1 : a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));

  const registry = {
    modules: [], routes: [], permissions: {}, roleGrants: [], roleLimits: [], exportTables: [],
    seeds: [], widgetFns: [],
    buildWidgets(ctx, user) {
      const out = {};
      for (const { module, fn } of this.widgetFns) {
        for (const [k, v] of Object.entries(fn(ctx, user) ?? {})) {
          if (k in out) throw new Error(`Widget key "${k}" is produced by more than one module (again by "${module}")`);
          out[k] = v;
        }
      }
      return out;
    },
  };
  const seenRoutes = new Map();

  for (const { folder, dir } of found) {
    const file = join(dir, folder, 'index.js');
    if (!existsSync(file)) throw new Error(`Module folder "${folder}" has no index.js`);
    const mod = (await import(pathToFileURL(file).href)).default;
    if (!mod || typeof mod !== 'object') throw new Error(`Module "${folder}": index.js must default-export an object`);
    if (mod.name !== folder) throw new Error(`Module folder "${folder}" declares name ${JSON.stringify(mod.name)}; they must match`);
    registry.modules.push(mod);

    for (const [atom, description] of Object.entries(mod.permissions ?? {})) {
      if (atom in registry.permissions) throw new Error(`Permission "${atom}" is declared by more than one module`);
      if (typeof description !== 'string') throw new Error(`Module ${folder}: permission "${atom}" needs a description string`);
      registry.permissions[atom] = description;
    }
    for (const [role, atoms] of Object.entries(mod.roleGrants ?? {})) registry.roleGrants.push({ module: folder, role, atoms });
    for (const [role, limits] of Object.entries(mod.roleLimits ?? {})) registry.roleLimits.push({ module: folder, role, limits });
    for (const t of mod.exportTables ?? []) {
      if (!TABLE.test(t)) throw new Error(`Module ${folder}: exportTables entry "${t}" is not a plain table name`);
      registry.exportTables.push(t);
    }
    for (const r of mod.routes ?? []) {
      const c = compileRoute(folder, r);
      const key = `${c.method} ${c.path}`;
      if (seenRoutes.has(key)) throw new Error(`Route ${key} is declared by both "${seenRoutes.get(key)}" and "${folder}"`);
      seenRoutes.set(key, folder);
      registry.routes.push(c);
    }
    if (mod.widgets) registry.widgetFns.push({ module: folder, fn: mod.widgets });
    if (mod.seed) registry.seeds.push({ module: folder, seed: mod.seed });
  }
  return registry;
}

export const defaultRegistry = await loadModules();

/**
 * Wire a registry into a context: register permissions and role grants (global, idempotent), sync the
 * built-in roles in the database (every startup), then run each module's seed once per database,
 * core first.
 */
export function initContext(ctx, registry = defaultRegistry) {
  ctx.registry = registry;
  for (const m of registry.modules) registerPermissions(m.name, m.permissions);
  for (const g of registry.roleGrants) grantBuiltin(g.module, g.role, g.atoms);
  for (const l of registry.roleLimits) limitBuiltin(l.module, l.role, l.limits);
  syncBuiltinRoles(ctx);

  const { db } = ctx;
  const done = new Set(db.prepare('SELECT module FROM module_seeds').all().map((r) => r.module));
  const mark = db.prepare('INSERT INTO module_seeds (module, applied_at) VALUES (?, ?)');
  // A database seeded before module_seeds existed already has its demo data: record, do not re-seed.
  if (done.size === 0 && db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    for (const { module } of registry.seeds) mark.run(module, ctx.now());
    return ctx;
  }
  for (const { module, seed } of registry.seeds) {
    if (done.has(module)) continue;
    tx(db, () => {
      seed(ctx);
      mark.run(module, ctx.now());
    });
  }
  return ctx;
}
