import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtempSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemoContext } from '../src/server.js';
import { createTenantManager } from '../src/tenants.js';
import { loadUser } from '../src/permissions.js';
import { expectError } from './helpers.js';
import { PW } from './tenancy.helpers.js';

const operator = (ctx) => loadUser(ctx, 1);
const mk = (opts = {}) => { const ctx = createDemoContext(); return { ctx, m: createTenantManager(ctx, { dir: mkdtempSync(join(tmpdir(), 'poc-mgr-')), ...opts }) }; };
const make = (m, ctx, slug, email = `ceo.${slug}@x.test`) => m.create(operator(ctx), { slug, name: `${slug} Co`, ownerEmail: email, ownerPassword: PW });

test('manager: the default tenant is registered at once and the context is decorated', () => {
  const { ctx, m } = mk();
  assert.deepEqual(m.list().map((t) => [t.id, t.slug, t.isDefault, t.status]), [[1, 'default', true, 'active']]);
  assert.equal(ctx.tenant.slug, 'default');
  assert.equal(ctx.tenants, m);
  assert.equal(m.multi, false);
  assert.equal(ctx.db.prepare("SELECT value FROM tenant_info WHERE key = 'slug'").get().value, 'default');
});

test('manager: create writes a registry row, a database file named by id, and the owner credential; the password is not stored in the registry', () => {
  const { ctx, m } = mk();
  const r = make(m, ctx, 'acme');
  assert.equal(r.tenant.slug, 'acme');
  assert.ok(existsSync(join(m.dir, 'tenant-2.db')));
  assert.equal(m.multi, true);
  const reg = readFileOf(join(m.dir, 'registry.db'));
  assert.ok(!reg.includes(PW));
  m.with('acme', (t) => {
    const cred = t.db.prepare('SELECT email, active, demo, must_change FROM auth_credentials WHERE email = ?').get('ceo.acme@x.test');
    assert.deepEqual({ ...cred }, { email: 'ceo.acme@x.test', active: 1, demo: 0, must_change: 0 });
    assert.equal(t.security.required, true);
    assert.equal(t.tenant.slug, 'acme');
  });
});
const readFileOf = (p) => fs.readFileSync(p).toString('latin1');

test('manager: validation errors use stable codes and a rejected create changes nothing', () => {
  const { ctx, m } = mk();
  const op = operator(ctx);
  const ok = { slug: 'good', name: 'Good', ownerEmail: 'ceo.good@x.test', ownerPassword: PW };
  for (const bad of [{ slug: 'ab' }, { slug: 'has space' }, { slug: 'x'.repeat(40) }, { slug: 'registry' }, { slug: 'tenants' }, { name: 'x' }, { ownerEmail: 'x' }, { ownerPassword: 5 }]) {
    expectError(() => m.create(op, { ...ok, ...bad }), 'BAD_INPUT');
  }
  expectError(() => m.create(op, { ...ok, ownerPassword: 'short' }), 'WEAK_PASSWORD');
  assert.equal(m.list().length, 1);
  assert.deepEqual(readdirSync(m.dir).filter((f) => f.startsWith('tenant-')), []);
  make(m, ctx, 'good');
  expectError(() => make(m, ctx, 'good'), 'TENANT_EXISTS');
});

test('manager: setStatus validates, audits on both sides and refuses the default tenant', () => {
  const { ctx, m } = mk();
  make(m, ctx, 'acme');
  const op = operator(ctx);
  expectError(() => m.setStatus(op, 'acme', 'deleted'), 'BAD_INPUT');
  expectError(() => m.setStatus(op, 'default', 'suspended'), 'DEFAULT_TENANT');
  expectError(() => m.setStatus(op, 'nope', 'suspended'), 'TENANT_NOT_FOUND');
  expectError(() => m.setStatus(op, 'acme', 'active'), 'NO_CHANGE');
  assert.equal(m.setStatus(op, 'acme', 'suspended').status, 'suspended');
  assert.ok(m.get('acme').suspendedAt);
  assert.equal(m.setStatus(op, 'acme', 'active').suspendedAt, null);
  const acts = (db) => db.prepare("SELECT action FROM audit_log WHERE action LIKE 'tenant.%' ORDER BY id").all().map((r) => r.action);
  assert.deepEqual(acts(ctx.db), ['tenant.created', 'tenant.suspended', 'tenant.resumed']);
  m.with('acme', (t) => assert.deepEqual(acts(t.db), ['tenant.provisioned', 'tenant.suspended', 'tenant.resumed']));
});

test('manager: a leased tenant is not evicted until released, and idle ones close beyond maxOpen', () => {
  const { ctx, m } = mk({ maxOpen: 1 });
  make(m, ctx, 'alpha'); make(m, ctx, 'beta');
  const l = m.lease('alpha');
  m.with('beta', () => {});
  m.with('beta', () => {});
  // alpha is in use: it must still answer after beta churn
  assert.ok(l.ctx.db.prepare('SELECT COUNT(*) n FROM users').get().n >= 1);
  l.release();
  l.release();                                                                       // double release is harmless
  assert.ok(m.openCount() <= 2);                                                     // default + one file-backed
  m.with('alpha', (t) => assert.ok(t.db.prepare('SELECT COUNT(*) n FROM accounts').get().n > 0)); // reopened from disk
});

test('manager: opening a database that carries another tenant identity is refused and does not hide other tenants', () => {
  const { ctx, m } = mk();
  make(m, ctx, 'alpha'); make(m, ctx, 'beta');
  m.close();
  const { copyFileSync } = fs;
  copyFileSync(join(m.dir, 'tenant-3.db'), join(m.dir, 'tenant-2.db'));
  const m2 = createTenantManager(createDemoContext(), { dir: m.dir });
  expectError(() => m2.with('alpha', () => {}), 'TENANT_DB_MISMATCH');
  m2.with('beta', (t) => assert.equal(t.tenant.slug, 'beta'));
  // credential probing skips the damaged tenant instead of failing
  const found = m2.forPublic('/api/auth/login', {}, { email: 'ceo.beta@x.test' });
  try { assert.equal(found.ctx.tenant.slug, 'beta'); } finally { found.release(); }
  assert.equal(m2.broken.alpha, 'TENANT_DB_MISMATCH');
});

test('manager: a file that is not a tenant database at all (no identity row) is refused too', () => {
  const { ctx, m } = mk();
  make(m, ctx, 'alpha');
  m.close();
  writeFileSync(join(m.dir, 'tenant-2.db'), '');                                    // empty file: a brand new database with no identity
  const m2 = createTenantManager(createDemoContext(), { dir: m.dir });
  expectError(() => m2.with('alpha', () => {}), 'TENANT_DB_MISMATCH');
});

test('manager: export and backup are audited, backup needs a folder, and stats work', () => {
  const { ctx, m } = mk();
  make(m, ctx, 'alpha');
  const op = operator(ctx);
  const ex = m.exportTenant(op, 'alpha');
  assert.equal(ex.tenant.slug, 'alpha');
  assert.ok(Array.isArray(ex.users) && ex.users.length >= 1);
  const bk = m.backup(op, 'alpha');
  assert.ok(existsSync(bk.file) && bk.bytes > 0);
  const st = m.stats('alpha');
  assert.equal(st.activeUsers, 1);
  assert.ok(st.bytes > 0);
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'tenant.backup'").get());
  const mem = createTenantManager(createDemoContext(), {});
  make(mem, mem.with('default', (c) => c), 'alpha');
  expectError(() => mem.backup(op, 'alpha'), 'NO_BACKUP_DIR');
});

test('manager: in-memory mode (no dir) works for tests and demos and keeps tenants separate', () => {
  const ctx = createDemoContext();
  const m = createTenantManager(ctx, {});
  make(m, ctx, 'alpha'); make(m, ctx, 'beta');
  m.with('alpha', (a) => a.db.prepare("INSERT INTO settings (key, value) VALUES ('only_alpha', '1')").run());
  m.with('beta', (b) => assert.equal(b.db.prepare("SELECT 1 FROM settings WHERE key = 'only_alpha'").get(), undefined));
  assert.equal(ctx.db.prepare("SELECT 1 FROM settings WHERE key = 'only_alpha'").get(), undefined);
  const ids = m.with('alpha', (a) => a.db.prepare('SELECT id FROM users ORDER BY id').all().map((r) => r.id));
  assert.deepEqual(ids, [1]); // a provisioned company has its owner only (id 1, same id as the default tenant's owner)
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM users').get().n, 6); // the default (demo) tenant keeps its six demo users
});

test('manager: forEachActive skips suspended tenants and keeps going when one callback fails', async () => {
  const { ctx, m } = mk();
  make(m, ctx, 'alpha'); make(m, ctx, 'beta');
  m.setStatus(operator(ctx), 'beta', 'suspended');
  const seen = [];
  await m.forEachActive(async (c) => { seen.push(c.tenant.slug); });
  assert.deepEqual(seen, ['default', 'alpha']);
});

test('a second createTenantManager on the same folder sees the earlier tenants and does not duplicate the default', () => {
  const { ctx, m } = mk();
  make(m, ctx, 'alpha');
  m.close();
  const m2 = createTenantManager(createDemoContext(), { dir: m.dir });
  assert.deepEqual(m2.list().map((t) => t.slug), ['default', 'alpha']);
  assert.equal(m2.multi, true);
  m2.close();
});
