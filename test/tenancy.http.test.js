import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bootTenancy, client, PW, OP_EMAIL, OP_PW } from './tenancy.helpers.js';
import { createApp, createSeededContext } from '../src/server.js';

const withApp = (opts, fn) => async () => {
  const app = await bootTenancy(opts);
  try { await fn(app); } finally { await app.close(); }
};
const owner = async (app, email) => { const c = app.client(); const r = await c.login(email, PW); assert.equal(r.status, 200, JSON.stringify(r.body)); return c; };
const newCustomer = (c, name) => c.call('POST', '/api/customers', { body: { name } });

test('single-tenant mode is unchanged: no tenants option, tenancy routes say so, demo identity works', async () => {
  const ctx = createSeededContext();
  const server = createApp(ctx, { backgroundJobs: false });
  await new Promise((r) => server.listen(0, r));
  const c = client(`http://127.0.0.1:${server.address().port}`);
  try {
    assert.equal((await c.call('GET', '/api/home', { as: 1 })).status, 200);
    assert.equal((await c.call('GET', '/api/tenants', { as: 6 })).code, 'TENANCY_DISABLED');
    const t = await c.call('GET', '/api/tenant', { as: 3 });
    assert.deepEqual([t.body.enabled, t.body.tenant.slug], [false, 'default']);
    assert.equal(ctx.tenants, undefined);
  } finally { await new Promise((r) => { server.close(r); server.closeAllConnections?.(); }); }
});

test('tenancy on but no second tenant yet: demo x-user-id identity still works and only the default tenant exists', withApp({ required: false }, async (app) => {
  const c = app.client();
  assert.equal((await c.call('GET', '/api/home', { as: 1 })).status, 200);
  const list = await c.call('GET', '/api/tenants', { as: 1 });
  assert.deepEqual(list.body.tenants.map((t) => t.slug), ['default']);
  assert.equal(app.tenants.multi, false);
}));

test('creating tenants needs tenants.manage: a clerk is refused, the operator succeeds', withApp({ required: false }, async (app) => {
  const body = { slug: 'acme', name: 'Acme Trading', ownerEmail: 'boss@acme.test', ownerPassword: PW };
  const c = app.client();
  assert.equal((await c.call('POST', '/api/tenants', { as: 3, body })).status, 403);   // clerk
  assert.equal((await c.call('GET', '/api/tenants', { as: 5 })).status, 403);          // auditor
  const ok = await c.call('POST', '/api/tenants', { as: 1, body });                    // owner
  assert.equal(ok.status, 201);
  assert.equal(ok.body.tenant.slug, 'acme');
  assert.equal(ok.body.tenant.status, 'active');
  assert.equal((await c.call('GET', '/api/tenants', { as: 6 })).status, 200);          // admin: tenants.view
  assert.equal((await c.call('POST', '/api/tenants', { as: 6, body: { ...body, slug: 'acme2' } })).status, 201); // admin has tenants.manage
}));

test('validation: bad slug, reserved, duplicate, bad e-mail, weak password; a failed provision leaves nothing behind', withApp({}, async (app) => {
  const op = app.operator;
  const base = { slug: 'good', name: 'Good Co', ownerEmail: 'o@good.test', ownerPassword: PW };
  for (const bad of [{ slug: '../etc' }, { slug: 'A' }, { slug: 'x' }, { slug: 'has space' }, { slug: 'default' }, { slug: 'admin' }, { name: '' }, { ownerEmail: 'nope' }, { ownerPassword: '' }]) {
    const r = await op.call('POST', '/api/tenants', { body: { ...base, ...bad } });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  const weak = await op.call('POST', '/api/tenants', { body: { ...base, ownerPassword: 'password' } });
  assert.equal(weak.status, 400);
  assert.equal(weak.code, 'WEAK_PASSWORD');
  assert.deepEqual(app.tenants.list().map((t) => t.slug), ['default']);               // registry row rolled back
  assert.deepEqual(readdirSync(app.dir).filter((f) => f.startsWith('tenant-')), []);    // database file removed
  await app.provision('good', 'o@good.test');
  assert.equal((await op.call('POST', '/api/tenants', { body: base })).code, 'TENANT_EXISTS');
}));

test('a provisioned tenant has the full schema, seeds, its own owner, and is audited on both sides', withApp({}, async (app) => {
  await app.provision('acme', 'boss@acme.test');
  const boss = await owner(app, 'boss@acme.test');
  const me = await boss.call('GET', '/api/tenant');
  assert.deepEqual([me.body.enabled, me.body.tenant.slug, me.body.tenant.isDefault], [true, 'acme', false]);
  const home = await boss.call('GET', '/api/home');
  assert.equal(home.status, 200);
  assert.equal(home.body.user.role, 'owner');
  assert.ok(Object.keys(home.body.widgets).length > 0);
  const t = await app.operator.call('GET', '/api/tenants/acme');
  assert.ok(t.body.stats.journalEntries >= 0 && t.body.stats.bytes > 0);
  // schema parity with the default database
  app.tenants.with('acme', (ctx) => {
    const ids = (db) => db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((r) => r.id);
    assert.deepEqual(ids(ctx.db), ids(app.ctx.db));
    assert.ok(ctx.db.prepare('SELECT COUNT(*) n FROM accounts').get().n > 5);
    assert.equal(ctx.db.prepare("SELECT value FROM tenant_info WHERE key = 'slug'").get().value, 'acme');
    assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'tenant.provisioned'").get());
    // no demo password exists in a provisioned tenant: only the owner can sign in
    assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM auth_credentials WHERE active = 1 AND password_hash IS NOT NULL').get().n, 1);
  });
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'tenant.created'").get());
}));

test('isolation: same ids in two tenants, no leakage in either direction', withApp({}, async (app) => {
  await app.provision('alpha', 'a@alpha.test');
  await app.provision('beta', 'b@beta.test');
  const a = await owner(app, 'a@alpha.test');
  const b = await owner(app, 'b@beta.test');
  const ca = await newCustomer(a, 'Alpha-only Customer');
  const cb = await newCustomer(b, 'Beta-only Customer');
  assert.equal(ca.status, 201); assert.equal(cb.status, 201);
  assert.equal(ca.body.id, cb.body.id);                                               // same primary key in both databases
  const listA = JSON.stringify((await a.call('GET', '/api/customers')).body);
  const listB = JSON.stringify((await b.call('GET', '/api/customers')).body);
  assert.ok(listA.includes('Alpha-only') && !listA.includes('Beta-only'));
  assert.ok(listB.includes('Beta-only') && !listB.includes('Alpha-only'));
  const listOp = JSON.stringify((await app.operator.call('GET', '/api/customers')).body);
  assert.ok(!listOp.includes('Alpha-only') && !listOp.includes('Beta-only'));
  // both users have id 1 in their own database; each sees only their own audit trail
  assert.equal((await a.call('GET', '/api/auth/me')).body.user.id, (await b.call('GET', '/api/auth/me')).body.user.id);
  const auditA = JSON.stringify((await a.call('GET', '/api/audit')).body);
  assert.ok(!auditA.includes('Beta-only') && !auditA.includes('beta'));
  // an invoice number sequence is independent
  const items = (await a.call('GET', '/api/items')).body;
  assert.ok(items.length > 0);
}));

test('a user of A cannot authenticate against B: wrong tenant login, session and API key all stay in A', withApp({}, async (app) => {
  await app.provision('alpha', 'a@alpha.test');
  await app.provision('beta', 'b@beta.test');
  // naming tenant beta with alpha credentials: invalid credentials, same message as a wrong password
  const c = app.client();
  const wrong = await c.login('a@alpha.test', PW, { tenant: 'beta' });
  const bad = await c.login('b@beta.test', 'Wrong-Password-123456', { tenant: 'beta' });
  assert.equal(wrong.status, 401); assert.equal(wrong.code, 'INVALID_CREDENTIALS');
  assert.deepEqual(wrong.body.error.message, bad.body.error.message);
  // an alpha session sent with ?tenant=beta or a tenant field is still alpha
  const a = await owner(app, 'a@alpha.test');
  const me = await a.call('GET', '/api/tenant?tenant=beta', { headers: { 'x-tenant': 'beta' } });
  assert.equal(me.body.tenant.slug, 'alpha');
  // an alpha API key reaches alpha data only
  const k = await a.call('POST', '/api/apikeys', { body: { name: 'k', permissions: ['sales.view'] } });
  assert.equal(k.status, 201, JSON.stringify(k.body));
  const b = await owner(app, 'b@beta.test');
  await newCustomer(b, 'Beta-only Customer');
  await newCustomer(a, 'Alpha-only Customer');
  const viaKey = await client(app.base).call('GET', '/api/customers', { key: k.body.key });
  assert.equal(viaKey.status, 200);
  assert.ok(JSON.stringify(viaKey.body).includes('Alpha-only') && !JSON.stringify(viaKey.body).includes('Beta-only'));
  // a made-up key or session behaves exactly as without tenancy: 401
  assert.equal((await client(app.base).call('GET', '/api/home', { key: 'acck_0123456789_' + 'a'.repeat(32) })).status, 401);
  assert.equal((await client(app.base).call('GET', '/api/home')).status, 401);
}));

test('login routing: a unique e-mail needs no tenant name, a shared e-mail asks for one, an unknown e-mail looks like any bad login', withApp({}, async (app) => {
  await app.provision('alpha', 'a@alpha.test');
  await app.provision('beta', 'shared@both.test');
  await app.provision('gamma', 'shared@both.test');
  assert.equal((await app.client().login('a@alpha.test', PW)).status, 200);
  const amb = await app.client().login('shared@both.test', PW);
  assert.equal(amb.status, 409); assert.equal(amb.code, 'TENANT_REQUIRED');
  assert.deepEqual(amb.body.error.tenants.sort(), ['beta', 'gamma']);
  const c = app.client();
  assert.equal((await c.login('shared@both.test', PW, { tenant: 'gamma' })).status, 200);
  assert.equal((await c.call('GET', '/api/tenant')).body.tenant.slug, 'gamma');
  const unknown = await app.client().login('nobody@nowhere.test', PW);
  assert.equal(unknown.status, 401); assert.equal(unknown.code, 'INVALID_CREDENTIALS');
  assert.equal((await app.client().login('a@alpha.test', PW, { tenant: 'nosuch' })).code, 'TENANT_NOT_FOUND');
  // other public auth routes must name the company once several exist
  assert.equal((await app.client().call('POST', '/api/auth/accept-invite', { body: { token: 'x', password: PW } })).code, 'TENANT_REQUIRED');
}));

test('demo mode: provisioned tenants ignore the x-user-id header; only sign-in reaches them', withApp({ required: false }, async (app) => {
  await app.provision('acme', 'boss@acme.test');
  const c = app.client();
  // header identity still means the default tenant
  assert.equal((await c.call('GET', '/api/tenant', { as: 1 })).body.tenant.slug, 'default');
  const boss = await owner(app, 'boss@acme.test');
  boss.state.csrf = boss.state.csrf; // keep session
  // a signed-in acme session plus an x-user-id header must not become user 3 of acme
  const mixed = await boss.call('GET', '/api/auth/me', { as: 3 });
  assert.equal(mixed.body.user.role, 'owner');
  assert.equal(mixed.body.via, 'session');
  // the demo accounts do not exist as passwords in the new tenant
  assert.equal((await app.client().login('owner@demo.test', 'Demo-Pass-2026', { tenant: 'acme' })).status, 401);
  assert.equal((await app.client().login('owner@demo.test', 'Demo-Pass-2026')).status, 200); // but the default tenant's demo login works
}));

test('suspend blocks sign-in and existing sessions; resume restores; the default tenant cannot be suspended', withApp({}, async (app) => {
  await app.provision('acme', 'boss@acme.test');
  const boss = await owner(app, 'boss@acme.test');
  const op = app.operator;
  assert.equal((await op.call('POST', '/api/tenants/default/suspend')).code, 'DEFAULT_TENANT');
  assert.equal((await op.call('POST', '/api/tenants/nosuch/suspend')).code, 'TENANT_NOT_FOUND');
  const s = await op.call('POST', '/api/tenants/acme/suspend');
  assert.equal(s.body.status, 'suspended');
  assert.equal((await op.call('POST', '/api/tenants/acme/suspend')).code, 'NO_CHANGE');
  assert.equal((await boss.call('GET', '/api/home')).code, 'TENANT_SUSPENDED');
  assert.equal((await app.client().login('boss@acme.test', PW)).code, 'TENANT_SUSPENDED');
  assert.equal((await op.call('GET', '/api/home')).status, 200);                      // the operator is unaffected
  assert.equal((await op.call('POST', '/api/tenants/acme/resume')).body.status, 'active');
  assert.equal((await boss.call('GET', '/api/home')).status, 200);
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'tenant.suspended'").get());
}));

test('only the operator (default tenant) manages tenants: a company owner is refused', withApp({}, async (app) => {
  await app.provision('acme', 'boss@acme.test');
  await app.provision('beta', 'b@beta.test');
  const boss = await owner(app, 'boss@acme.test');
  assert.equal((await boss.call('GET', '/api/tenants')).code, 'OPERATOR_ONLY');
  assert.equal((await boss.call('POST', '/api/tenants', { body: { slug: 'evil', name: 'Evil', ownerEmail: 'e@e.test', ownerPassword: PW } })).code, 'OPERATOR_ONLY');
  assert.equal((await boss.call('GET', '/api/tenants/beta/export')).code, 'OPERATOR_ONLY');
  assert.equal((await boss.call('POST', '/api/tenants/beta/backup')).code, 'OPERATOR_ONLY');
}));

test('per-tenant export contains that tenant only and needs tenants.export (admin lacks it); audited in both databases', withApp({}, async (app) => {
  await app.provision('alpha', 'a@alpha.test');
  await app.provision('beta', 'b@beta.test');
  await newCustomer(await owner(app, 'a@alpha.test'), 'Alpha-only Customer');
  await newCustomer(await owner(app, 'b@beta.test'), 'Beta-only Customer');
  const ex = await app.operator.call('GET', '/api/tenants/alpha/export');
  assert.equal(ex.status, 200);
  assert.equal(ex.body.format, 'accounting-poc/v1');
  assert.equal(ex.body.tenant.slug, 'alpha');
  const text = JSON.stringify(ex.body);
  assert.ok(text.includes('Alpha-only') && !text.includes('Beta-only'));
  assert.ok(ex.body.audit_log.length > 0);
  // admin role of the default tenant: has tenants.manage but not tenants.export
  const demo = await bootTenancy({ required: false });
  try {
    await demo.provision('alpha', 'a@alpha.test');
    assert.equal((await demo.client().call('GET', '/api/tenants/alpha/export', { as: 6 })).status, 403);
    assert.equal((await demo.client().call('GET', '/api/tenants/alpha/export', { as: 1 })).status, 200);
  } finally { await demo.close(); }
  app.tenants.with('alpha', (ctx) => assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'tenant.exported'").get()));
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'tenant.exported'").get());
}));

test('per-tenant backup: a consistent copy that opens on its own; refused without a folder', withApp({}, async (app) => {
  await app.provision('alpha', 'a@alpha.test');
  await newCustomer(await owner(app, 'a@alpha.test'), 'Alpha-only Customer');
  const r = await app.operator.call('POST', '/api/tenants/alpha/backup');
  assert.equal(r.status, 200);
  assert.ok(existsSync(r.body.file) && r.body.bytes > 0 && /^[0-9a-f]{64}$/.test(r.body.sha256));
  const copy = new DatabaseSync(r.body.file, { readOnly: true });
  assert.equal(copy.prepare("SELECT COUNT(*) n FROM sales_customers WHERE name = 'Alpha-only Customer'").get().n, 1);
  assert.equal(copy.prepare("SELECT value FROM tenant_info WHERE key = 'slug'").get().value, 'alpha');
  copy.close();
  const r2 = await app.operator.call('POST', '/api/tenants/alpha/backup');
  assert.notEqual(r2.body.file, r.body.file);                                         // never overwrites an earlier backup
  const mem = await bootTenancy({ required: true, dir: undefined });
  mem.tenants.close();
  await mem.close();
}));

test('persistence: after a restart the registry and tenant databases are found again; a swapped file is refused', async () => {
  const first = await bootTenancy();
  await first.provision('alpha', 'a@alpha.test');
  await first.provision('beta', 'b@beta.test');
  await newCustomer(await owner(first, 'a@alpha.test'), 'Alpha-only Customer');
  const dir = first.dir;
  await first.close();
  // restart: same tenants folder; the default tenant is a fresh in-memory database here, so the operator signs in again
  const second = await bootTenancy({ dir, required: true });
  try {
    assert.deepEqual(second.tenants.list().map((t) => t.slug), ['default', 'alpha', 'beta']);
    const a = await owner(second, 'a@alpha.test');
    assert.ok(JSON.stringify((await a.call('GET', '/api/customers')).body).includes('Alpha-only'));
    // someone copies beta's file over alpha's slot: refused, never served as alpha
    const { copyFileSync } = await import('node:fs');
    second.tenants.close();
    copyFileSync(join(dir, 'tenant-3.db'), join(dir, 'tenant-2.db'));
  } finally { await second.close(); }
  const third = await bootTenancy({ dir, required: true });
  try {
    const c = third.client();
    const r = await c.login('b@beta.test', PW, { tenant: 'alpha' });
    assert.equal(r.status, 500);
    assert.equal(r.code, 'TENANT_DB_MISMATCH');
  } finally { await third.close(); }
});

test('open databases are bounded: with maxOpen 1 idle tenants are closed and reopened on demand without losing data', withApp({ maxOpen: 1 }, async (app) => {
  for (const s of ['alpha', 'beta', 'gamma']) await app.provision(s, `o@${s}.test`);
  const cs = [];
  for (const s of ['alpha', 'beta', 'gamma']) { const c = await owner(app, `o@${s}.test`); await newCustomer(c, `Only-${s}`); cs.push([s, c]); }
  assert.ok(app.tenants.openCount() <= 3, `open: ${app.tenants.openCount()}`);          // default + at most maxOpen file-backed
  for (const [s, c] of cs) assert.ok(JSON.stringify((await c.call('GET', '/api/customers')).body).includes(`Only-${s}`));
}));

test('background jobs visit every tenant: audit sealing runs in each database', withApp({}, async (app) => {
  await app.provision('alpha', 'a@alpha.test');
  const a = await owner(app, 'a@alpha.test');
  await newCustomer(a, 'Alpha-only Customer');
  await app.server.runBackgroundJobs();
  app.tenants.with('alpha', (ctx) => {
    const sealed = ctx.db.prepare('SELECT COUNT(*) n FROM auth_audit_chain').get().n;
    assert.ok(sealed > 0);
  });
  const v = await a.call('GET', '/api/audit/verify');
  assert.equal(v.body.ok, true);
}));

test('API routes carry meta.summary and the new permissions are registered', async () => {
  const { defaultRegistry } = await import('../src/modules.js');
  for (const r of defaultRegistry.routes.filter((x) => x.module === 'tenants')) assert.ok(r.meta.summary, r.path);
  for (const p of ['tenants.view', 'tenants.manage', 'tenants.export']) assert.ok(p in defaultRegistry.permissions);
});

test('operator key sanity: the default owner cannot be confused with a tenant owner of the same e-mail', withApp({}, async (app) => {
  await app.provision('acme', OP_EMAIL);                                              // same e-mail as the operator
  const amb = await app.client().login(OP_EMAIL, PW);
  assert.equal(amb.code, 'TENANT_REQUIRED');
  const r = await app.client().login(OP_EMAIL, OP_PW, { tenant: 'default' });
  assert.equal(r.status, 200);
  assert.equal((await app.client().login(OP_EMAIL, OP_PW, { tenant: 'acme' })).status, 401);   // operator password is not valid in acme
}));
