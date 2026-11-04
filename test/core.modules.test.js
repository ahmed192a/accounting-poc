import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, createSeededContext } from '../src/server.js';
import { loadModules, MODULES_DIR, defaultRegistry } from '../src/modules.js';
import { PERMISSIONS, BUILTIN_ROLES, loadUser } from '../src/permissions.js';
import { tempModules, startApp } from './helpers.js';

const FAKE = `
export default {
  name: 'fake',
  permissions: { 'fake.read': 'Read the fake thing', 'fake.write': 'Write the fake thing' },
  roleGrants: { clerk: ['fake.read'], manager: ['fake.read', 'fake.write'] },
  routes: [
    { method: 'GET', path: '/api/fake/hello', public: true, handler: () => ({ hello: 'world' }), meta: { summary: 'Public hello' } },
    { method: 'GET', path: '/api/fake/:id', handler: (ctx, user, { params, query }) => {
        if (!user.permissions.has('fake.read')) throw Object.assign(new Error('no'), { status: 403, code: 'FORBIDDEN' });
        return { id: params.id, q: query.q ?? null, who: user.name, seeded: ctx.db.prepare("SELECT value FROM settings WHERE key = 'fake_seed'").get()?.value };
      } },
    { method: 'POST', path: '/api/fake', handler: (ctx, user, { body }) => ({ got: body }) },
  ],
  widgets: (ctx, user) => (user.permissions.has('fake.read') ? { fakeWidget: { n: 42 } } : {}),
  seed: (ctx) => { ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('fake_seed', 'yes')").run(); },
};
`;

test('module loader: the five built-in modules load, core first, with their contributions merged', () => {
  const names = defaultRegistry.modules.map((m) => m.name);
  assert.equal(names[0], 'core');
  for (const n of ['core', 'eta', 'ledger', 'purchases', 'sales']) assert.ok(names.includes(n), n); // others may be added by feature agents
  assert.deepEqual(names.slice(1), [...names.slice(1)].sort(), 'alphabetical after core')
  assert.ok(defaultRegistry.routes.some((r) => r.method === 'POST' && r.path === '/api/sales/quick' && r.module === 'sales'));
  assert.ok(defaultRegistry.routes.every((r) => typeof r.handler === 'function'));
  assert.ok('purchases.approve' in defaultRegistry.permissions);
});

test('module loader: a fake module in a temp dir contributes a route, a permission, a role grant, a widget and a seed', async () => {
  const dir = tempModules({ 'fake/index.js': FAKE });
  const registry = await loadModules([MODULES_DIR, dir]);
  assert.ok(registry.modules.some((m) => m.name === 'fake'));
  assert.deepEqual(registry.permissions['fake.read'], 'Read the fake thing');

  const ctx = createSeededContext(':memory:', registry);
  // permission registry
  assert.equal(PERMISSIONS['fake.read'], 'Read the fake thing');
  // role grants merged into the built-in roles (database and in-memory definitions)
  const clerk = loadUser(ctx, 3), manager = loadUser(ctx, 2), auditor = loadUser(ctx, 5), owner = loadUser(ctx, 1);
  assert.ok(clerk.permissions.has('fake.read') && !clerk.permissions.has('fake.write'));
  assert.ok(manager.permissions.has('fake.write'));
  assert.ok(!auditor.permissions.has('fake.read'));
  assert.ok(owner.permissions.has('fake.read') && owner.permissions.has('fake.write'), 'owner holds every atom');
  assert.ok(BUILTIN_ROLES.find((r) => r.name === 'clerk').permissions.includes('fake.read'));

  const { server, call } = await startApp(createApp, ctx);
  try {
    // route (public and authenticated, with params and query)
    assert.deepEqual((await call('GET', '/api/fake/hello')).body, { hello: 'world' });
    const r = await call('GET', '/api/fake/7?q=abc', 3);
    assert.equal(r.status, 200);
    assert.equal(r.body.id, '7');
    assert.equal(r.body.q, 'abc');
    assert.equal(r.body.who, 'Sara (clerk)');
    assert.equal(r.body.seeded, 'yes', 'the module seed ran');
    assert.equal((await call('GET', '/api/fake/7', 1)).status, 200);
    assert.equal((await call('GET', '/api/fake/7')).status, 401, 'non-public routes still need an identity');
    assert.deepEqual((await call('POST', '/api/fake', 3, { a: 1 })).body, { got: { a: 1 } });
    // widget merged into /api/home next to the built-in ones
    const home = (await call('GET', '/api/home', 3)).body;
    assert.deepEqual(home.widgets.fakeWidget, { n: 42 });
    assert.ok(home.widgets.myWork, 'built-in widgets are still there');
    assert.equal((await call('GET', '/api/home', 5)).body.widgets.fakeWidget, undefined, 'widget follows the permission');
    assert.ok((await call('GET', '/api/home', 1)).body.permissions.includes('fake.write'));
  } finally { server.close(); }
});

test('module loader: seeds run once per database, core seed first', async () => {
  const order = [];
  const dir = tempModules({ 'aaa/index.js': `export default { name: 'aaa', seed: () => { globalThis.__seedOrder.push('aaa'); } };` });
  globalThis.__seedOrder = order;
  const registry = await loadModules([MODULES_DIR, dir]);
  const ctx = createSeededContext(':memory:', registry);
  assert.deepEqual(order, ['aaa']);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 6, 'core seeded before/independently of aaa');
  assert.equal(registry.modules[0].name, 'core');
  const seeded = ctx.db.prepare('SELECT module FROM module_seeds').all().map((r) => r.module);
  for (const n of ['aaa', 'core', 'eta', 'ledger', 'purchases', 'sales']) assert.ok(seeded.includes(n), `${n} seeded`);
});

test('module loader: contract violations fail loudly at load time', async () => {
  const bad = async (files, re) => assert.rejects(loadModules([MODULES_DIR, tempModules(files)]), re);
  await bad({ 'x/index.js': `export default { name: 'y' };` }, /must match/);
  await bad({ 'x/index.js': `export default { name: 'x', routes: [{ method: 'GET', path: '/api/items', handler() {} }] };` }, /declared by both/);
  await bad({ 'x/index.js': `export default { name: 'x', routes: [{ method: 'FETCH', path: '/a', handler() {} }] };` }, /method/);
  await bad({ 'x/index.js': `export default { name: 'x', routes: [{ method: 'GET', path: 'a', handler() {} }] };` }, /path/);
  await bad({ 'x/index.js': `export default { name: 'x', routes: [{ method: 'GET', path: '/a' }] };` }, /handler/);
  await bad({ 'x/index.js': `export default { name: 'x', permissions: { 'sales.view': 'dup' } };` }, /more than one module/);
  await bad({ 'x/readme.txt': 'no index' }, /no index\.js/);
  // a widget key clash is detected when the home page is built
  const dir = tempModules({ 'x/index.js': `export default { name: 'x', widgets: () => ({ cash: 1 }) };` });
  const registry = await loadModules([MODULES_DIR, dir]);
  const ctx = createSeededContext(':memory:', registry);
  assert.throws(() => registry.buildWidgets(ctx, loadUser(ctx, 1)), /more than one module/);
});

test('module loader: unknown role in roleGrants is rejected when the registry is applied', async () => {
  const dir = tempModules({ 'x/index.js': `export default { name: 'x', permissions: { 'x.go': 'Go' }, roleGrants: { nobody: ['x.go'] } };` });
  const registry = await loadModules([MODULES_DIR, dir]);
  assert.throws(() => createSeededContext(':memory:', registry), /Unknown built-in role "nobody"/);
});
