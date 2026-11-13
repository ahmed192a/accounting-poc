import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSeededContext, createDemoContext } from '../src/server.js';
import { initContext } from '../src/modules.js';
import { createTenantManager } from '../src/tenants.js';

const n = (ctx, table) => ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test('reference seeds only: chart of accounts, settings, owner placeholder, default approval rule; no demo data', () => {
  const ctx = createSeededContext();
  assert.ok(n(ctx, 'accounts') >= 9, 'chart of accounts exists');
  assert.equal(ctx.db.prepare("SELECT name FROM roles WHERE name = 'owner'").get().name, 'owner');
  assert.equal(n(ctx, 'users'), 1, 'the owner placeholder only');
  assert.equal(ctx.db.prepare('SELECT r.name FROM users u JOIN roles r ON r.id = u.role_id').get().name, 'owner');
  assert.ok(ctx.db.prepare("SELECT 1 FROM settings WHERE key = 'vat_rate_bp'").get());
  assert.equal(n(ctx, 'approvals_rules'), 1);
  assert.equal(n(ctx, 'items'), 0);
  assert.equal(n(ctx, 'sales_customers'), 0);
  assert.equal(n(ctx, 'purchases_suppliers'), 0);
  assert.equal(n(ctx, 'journal_entries'), 0, 'no opening balance');
  assert.equal(n(ctx, 'entities_rates'), 0);
  assert.equal(n(ctx, 'auth_credentials'), 0, 'no demo credentials');
  assert.deepEqual(ctx.db.prepare('SELECT name FROM bank_accounts').all().map((r) => r.name), ['Cash drawer']);
});

test('demo opt-in adds the sample data on top of the same reference data', () => {
  const ctx = createDemoContext();
  assert.equal(n(ctx, 'users'), 6);
  assert.equal(ctx.db.prepare('SELECT name FROM users WHERE id = 1').get().name, 'Mona (owner)');
  assert.equal(n(ctx, 'items'), 4);
  assert.equal(n(ctx, 'sales_customers'), 3);
  assert.equal(n(ctx, 'purchases_suppliers'), 2);
  assert.equal(n(ctx, 'journal_entries'), 1);
  assert.equal(n(ctx, 'bank_accounts'), 3);
  assert.equal(n(ctx, 'auth_credentials'), 6);
});

test('demo data can be added later to a reference-only database, once, and is never doubled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'poc-seeds-'));
  const path = join(dir, 'a.db');
  try {
    let ctx = createSeededContext(path);
    assert.equal(n(ctx, 'items'), 0);
    ctx.db.close();
    ctx = createSeededContext(path, undefined, { demo: true });
    assert.equal(n(ctx, 'items'), 4);
    ctx.db.close();
    ctx = createSeededContext(path, undefined, { demo: true });   // again: nothing duplicated, no UNIQUE crash
    assert.equal(n(ctx, 'items'), 4);
    assert.equal(n(ctx, 'users'), 6);
    ctx.db.close();
    ctx = createSeededContext(path);                               // reopened without the flag: nothing removed
    assert.equal(n(ctx, 'items'), 4);
    ctx.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a database seeded before the split keeps its demo data and is not re-seeded', () => {
  const ctx = createDemoContext();
  // Simulate the old bookkeeping: combined module seeds recorded, no split marker, no ":demo" rows.
  ctx.db.prepare("DELETE FROM module_seeds WHERE module = 'seeds:split' OR module LIKE '%:demo'").run();
  initContext(ctx, ctx.registry, { demo: true });
  assert.equal(n(ctx, 'users'), 6);
  assert.equal(n(ctx, 'items'), 4);
  assert.equal(n(ctx, 'journal_entries'), 1);
});

test('tenant provisioning: reference only by default, demo data only with demo: true', () => {
  const root = createDemoContext();
  const m = createTenantManager(root, {});
  const op = { id: 1 };
  m.create(op, { slug: 'plain', name: 'Plain Co', ownerEmail: 'o@plain.test', ownerPassword: 'Tenant-Strong-Pass-2026-x' });   // secret-scan:ignore test fixture
  m.create(op, { slug: 'showy', name: 'Showy Co', ownerEmail: 'o@showy.test', ownerPassword: 'Tenant-Strong-Pass-2026-x', demo: true }); // secret-scan:ignore test fixture
  assert.equal(m.with('plain', (c) => n(c, 'items')), 0);
  assert.equal(m.with('plain', (c) => n(c, 'users')), 1);
  assert.ok(m.with('plain', (c) => n(c, 'accounts')) >= 9);
  assert.equal(m.with('showy', (c) => n(c, 'items')), 4);
  assert.equal(m.with('showy', (c) => n(c, 'users')), 6);
});
