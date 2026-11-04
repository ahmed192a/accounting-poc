import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Loads public/sw.js in a vm with an in-memory Cache API and a scripted network.
function loadSw({ network }) {
  const stores = new Map();
  const mkCache = (name) => { if (!stores.has(name)) stores.set(name, new Map()); const m = stores.get(name); return {
    match: async (k) => { const v = m.get(typeof k === 'string' ? k : k.url); return v ? v.clone() : undefined; },
    put: async (k, v) => { m.set(typeof k === 'string' ? k : k.url, v); }, add: async () => {}, delete: async (k) => m.delete(typeof k === 'string' ? k : k.url), keys: async () => [...m.keys()].map((url) => ({ url })),
  }; };
  const caches = { open: async (n) => mkCache(n), keys: async () => [...stores.keys()], delete: async (n) => stores.delete(n) };
  const listeners = {}; const posted = [];
  const self = { __SW_TEST__: true, location: { origin: 'http://x' }, addEventListener: (n, f) => { listeners[n] = f; }, skipWaiting() {}, clients: { claim() {}, matchAll: async () => [{ postMessage: (m) => posted.push(m) }] } };
  vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, URL, caches, fetch: (req) => network(req), Response, Promise, console });
  return { self, listeners, caches, stores, posted };
}
const req = (path, { method = 'GET', user } = {}) => ({ url: 'http://x' + path, method, mode: 'cors', headers: { get: (k) => (k.toLowerCase() === 'x-user-id' ? user ?? null : null) } });
async function dispatch(listeners, request) {
  let p; const waits = [];
  listeners.fetch({ request, respondWith: (x) => { p = x; }, waitUntil: (x) => waits.push(x) });
  const res = p ? await p : null;
  await Promise.all(waits);
  return res;
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

test('sw: cache keys are per demo user and the allow-list is exact', () => {
  const { self } = loadSw({ network: async () => json({}) });
  const sw = self.__sw;
  assert.notEqual(sw.apiKey(req('/api/home', { user: '1' })), sw.apiKey(req('/api/home', { user: '3' })));
  assert.ok(sw.isApiGet(new URL('http://x/api/home')) && sw.isApiGet(new URL('http://x/api/items')));
  for (const p of ['/api/auth/me', '/api/admin/users', '/api/journal', '/api/home/x', '/api/export']) assert.equal(sw.isApiGet(new URL('http://x' + p)), false, p);
  assert.equal(sw.isApiGet(new URL('http://evil/api/home')), false);
});

test('sw: stale-while-revalidate serves the cached copy offline and refreshes it when online', async () => {
  let online = true, version = 1;
  const { listeners, posted } = loadSw({ network: async () => { if (!online) throw new TypeError('offline'); return json({ v: version }); } });
  const r = req('/api/home', { user: '3' });
  assert.deepEqual(await (await dispatch(listeners, r)).json(), { v: 1 }); // first: network, now cached
  online = false;
  assert.deepEqual(await (await dispatch(listeners, r)).json(), { v: 1 }); // offline: from cache
  online = true; version = 2;
  assert.deepEqual(await (await dispatch(listeners, r)).json(), { v: 1 }); // stale answer now ...
  assert.deepEqual(await (await dispatch(listeners, r)).json(), { v: 2 }); // ... fresh next time
  assert.ok(posted.some((m) => m.type === 'acct-api-updated' && m.path === '/api/home'), 'clients are told newer data exists');
});

test('sw: nothing cached and offline fails like before (no fake data), per-user caches do not mix', async () => {
  let online = true;
  const { listeners } = loadSw({ network: async (rq) => { if (!online) throw new TypeError('offline'); return json({ who: rq.headers.get('x-user-id') }); } });
  await dispatch(listeners, req('/api/home', { user: '3' }));
  online = false;
  await assert.rejects(dispatch(listeners, req('/api/home', { user: '4' })), TypeError);
  assert.deepEqual(await (await dispatch(listeners, req('/api/home', { user: '3' }))).json(), { who: '3' });
});

test('sw: a successful write empties the API cache; a failed write does not', async () => {
  let status = 201;
  const { listeners, stores } = loadSw({ network: async (rq) => (rq.method === 'POST' ? json({}, status) : json({ ok: 1 })) });
  await dispatch(listeners, req('/api/home', { user: '3' }));
  assert.equal(stores.get('acct-api-v1').size, 1);
  status = 422; await dispatch(listeners, req('/api/invoices', { method: 'POST', user: '3' }));
  assert.equal(stores.get('acct-api-v1').size, 1);
  status = 201; await dispatch(listeners, req('/api/sales/quick', { method: 'POST', user: '3' }));
  assert.equal(stores.has('acct-api-v1'), false);
});

test('sw: a 401 on revalidation drops the cached copy (signed out)', async () => {
  let status = 200;
  const { listeners, stores } = loadSw({ network: async () => json({ a: 1 }, status) });
  const r = req('/api/home', { user: '3' });
  await dispatch(listeners, r);
  status = 401; await dispatch(listeners, r);
  assert.equal(stores.get('acct-api-v1').size, 0);
});

test('sw: the clear-cache message empties the API cache', async () => {
  const { listeners, stores } = loadSw({ network: async () => json({}) });
  await dispatch(listeners, req('/api/items', { user: '3' }));
  const waits = []; listeners.message({ data: { type: 'acct-clear-api' }, waitUntil: (p) => waits.push(p) }); await Promise.all(waits);
  assert.equal(stores.has('acct-api-v1'), false);
});
