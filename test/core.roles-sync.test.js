import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSeededContext } from '../src/server.js';
import { loadModules, MODULES_DIR, initContext } from '../src/modules.js';
import { syncBuiltinRoles, loadUser, BUILTIN_ROLES } from '../src/permissions.js';
import { createRole } from '../src/modules/core/service.js';
import { tempModules } from './helpers.js';

const roleRow = (ctx, name) => {
  const r = ctx.db.prepare('SELECT * FROM roles WHERE name = ?').get(name);
  return { ...r, permissions: JSON.parse(r.permissions), limits: JSON.parse(r.limits) };
};

test('built-in roles are created from module grants, with the original permission sets and limits', () => {
  const ctx = createSeededContext();
  const set = (n) => [...roleRow(ctx, n).permissions].sort();
  assert.deepEqual(set('clerk'), ['purchases.create', 'purchases.view', 'sales.create', 'sales.view']);
  assert.deepEqual(set('admin'), ['eta.manage', 'export.all', 'roles.manage', 'users.manage']);
  assert.deepEqual(set('auditor'), ['audit.view', 'ledger.view', 'purchases.view', 'reports.view', 'sales.view']);
  assert.deepEqual(roleRow(ctx, 'clerk').limits, { 'purchases.create': 500000 });
  assert.deepEqual(roleRow(ctx, 'manager').limits, { 'purchases.approve': 2000000 });
  assert.equal(roleRow(ctx, 'owner').permissions.length, 17);
  assert.ok(ctx.db.prepare('SELECT builtin FROM roles').all().every((r) => r.builtin === 1));
});

test('role re-sync: a persistent database gets newly added atoms for built-in roles only, idempotently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'poc-sync-'));
  const path = join(dir, 'app.db');
  try {
    // 1. first start, old code: no "reports2" module yet. A custom role exists.
    let ctx = createSeededContext(path);
    createRole(ctx, loadUser(ctx, 6), { name: 'Cashier', permissions: ['sales.view'] });
    assert.ok(!roleRow(ctx, 'manager').permissions.includes('reports2.view'));
    const customBefore = roleRow(ctx, 'Cashier');
    const usersBefore = ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const auditBefore = ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
    ctx.db.close();

    // 2. restart with a new module that adds an atom and grants it to manager and auditor (and a limit to manager)
    const extra = tempModules({
      'reports2/index.js': `export default {
        name: 'reports2',
        permissions: { 'reports2.view': 'See report pack 2', 'reports2.export': 'Export report pack 2' },
        roleGrants: { manager: ['reports2.view'], auditor: ['reports2.view', 'reports2.export'] },
        roleLimits: { manager: { 'reports2.export': 5000 } },
      };`,
    });
    const registry = await loadModules([MODULES_DIR, extra]);
    ctx = createSeededContext(path, registry);
    assert.ok(roleRow(ctx, 'manager').permissions.includes('reports2.view'));
    assert.ok(!roleRow(ctx, 'manager').permissions.includes('reports2.export'));
    assert.deepEqual(roleRow(ctx, 'auditor').permissions.filter((p) => p.startsWith('reports2')).sort(), ['reports2.export', 'reports2.view']);
    assert.equal(roleRow(ctx, 'manager').limits['reports2.export'], 5000);
    assert.equal(roleRow(ctx, 'manager').limits['purchases.approve'], 2000000, 'existing limits kept');
    assert.ok(roleRow(ctx, 'owner').permissions.includes('reports2.export'), 'owner gets every atom');
    assert.ok(!roleRow(ctx, 'clerk').permissions.some((p) => p.startsWith('reports2')), 'roles that were not granted stay as they were');
    assert.ok(!roleRow(ctx, 'admin').permissions.some((p) => p.startsWith('reports2')));
    // a user holding the role sees the new atom immediately
    assert.ok(loadUser(ctx, 2).permissions.has('reports2.view'));
    // custom role untouched
    assert.deepEqual(roleRow(ctx, 'Cashier'), customBefore);
    // the database was not re-seeded
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, usersBefore);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, auditBefore);

    // 3. idempotent: syncing again changes nothing
    const snapshot = JSON.stringify(ctx.db.prepare('SELECT * FROM roles ORDER BY id').all());
    assert.deepEqual(syncBuiltinRoles(ctx), { created: [], updated: [] });
    initContext(ctx, registry);
    assert.equal(JSON.stringify(ctx.db.prepare('SELECT * FROM roles ORDER BY id').all()), snapshot);
    ctx.db.close();

    // 4. one more restart: still nothing to do
    ctx = createSeededContext(path, registry);
    assert.equal(JSON.stringify(ctx.db.prepare('SELECT * FROM roles ORDER BY id').all()), snapshot);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, usersBefore);
    ctx.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('role re-sync: a custom role with a built-in name is never overwritten; a missing built-in role is recreated', () => {
  const ctx = createSeededContext();
  ctx.db.prepare("UPDATE roles SET builtin = 0, permissions = '[\"sales.view\"]' WHERE name = 'auditor'").run();
  ctx.db.prepare("DELETE FROM users WHERE role_id = (SELECT id FROM roles WHERE name = 'clerk')").run();
  ctx.db.prepare("DELETE FROM roles WHERE name = 'clerk'").run();
  const res = syncBuiltinRoles(ctx);
  assert.deepEqual(res.created, ['clerk']);
  assert.deepEqual(roleRow(ctx, 'auditor').permissions, ['sales.view']);
  assert.equal(roleRow(ctx, 'clerk').builtin, 1);
  assert.deepEqual(roleRow(ctx, 'clerk').permissions.sort(), BUILTIN_ROLES.find((r) => r.name === 'clerk').permissions.slice().sort());
});

test('persistent database from before migrations/modules existed is adopted without re-seeding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'poc-legacy-'));
  const path = join(dir, 'legacy.db');
  try {
    const first = createSeededContext(path);
    first.db.exec('DROP TABLE module_seeds; DROP TABLE schema_migrations'); // what the old code left behind
    first.db.close();
    const ctx = createSeededContext(path); // must not crash on UNIQUE constraints
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 6);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 4);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, 1);
    ctx.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
