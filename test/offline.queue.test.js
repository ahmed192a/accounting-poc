import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, memoryStorage, queueKind, backoffMs, QueueError } from '../public/offline-queue.js';

const mkRes = (status, body = {}, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => JSON.stringify(body) });
function harness(handler, opts = {}) {
  const calls = [];
  let t = 1000, n = 0, identity = 'demo:3';
  const fetch = async (path, init) => { calls.push({ path, method: init.method, headers: init.headers, body: JSON.parse(init.body) }); return handler(path, init, calls); };
  const q = createQueue({ storage: opts.storage ?? memoryStorage(), fetch, now: () => (t += 10), uuid: () => `uuid-${++n}`, getHeaders: () => ({ 'x-user-id': '3' }), getIdentity: () => identity, ...opts });
  return { q, calls, setIdentity: (i) => { identity = i; } };
}
const sale = (sku = 'TEA') => ({ method: 'POST', path: '/api/sales/quick', body: { items: [{ sku, qty: 1 }] }, label: `Sale ${sku}` });

test('queueKind: only sales, invoices, bills and customers creation are queueable', () => {
  assert.equal(queueKind('POST', '/api/sales/quick'), 'sale');
  assert.equal(queueKind('post', '/api/invoices'), 'invoice');
  assert.equal(queueKind('POST', '/api/bills?x=1'), 'bill');
  assert.equal(queueKind('POST', '/api/customers'), 'customer');
  assert.equal(queueKind('POST', '/api/invoices/5/void'), null);
  assert.equal(queueKind('GET', '/api/invoices'), null);
  assert.equal(queueKind('PATCH', '/api/customers'), null);
});

test('enqueue validates, stamps a key and keeps creation order', async () => {
  const { q } = harness(async () => mkRes(201));
  const a = await q.enqueue(sale('A')); const b = await q.enqueue(sale('B'));
  assert.equal(a.key, 'uuid-1'); assert.equal(b.key, 'uuid-2');
  assert.deepEqual((await q.list()).map((i) => i.label), ['Sale A', 'Sale B']);
  assert.deepEqual(await q.counts(), { pending: 2, failed: 0, total: 2 });
  await assert.rejects(q.enqueue({ method: 'POST', path: '/api/invoices/1/void', body: {} }), (e) => e.code === 'NOT_QUEUEABLE');
  await assert.rejects(q.enqueue({ method: 'POST', path: '/api/customers', body: [1] }), (e) => e instanceof QueueError && e.code === 'BAD_BODY');
});

test('sync replays in order with Idempotency-Key and auth headers, then empties the queue', async () => {
  const { q, calls } = harness(async () => mkRes(201, { ok: true }));
  await q.enqueue(sale('A')); await q.enqueue(sale('B')); await q.enqueue(sale('C'));
  const r = await q.sync();
  assert.deepEqual(calls.map((c) => c.body.items[0].sku), ['A', 'B', 'C']);
  assert.deepEqual(calls.map((c) => c.headers['idempotency-key']), ['uuid-1', 'uuid-2', 'uuid-3']);
  assert.equal(calls[0].headers['x-user-id'], '3');
  assert.equal(r.synced.length, 3); assert.equal(r.remaining, 0); assert.equal(r.stopped, null);
  assert.equal((await q.list()).length, 0);
});

test('network error stops the run, keeps everything pending, and the retry reuses the same key (no double post)', async () => {
  let online = false;
  const { q, calls } = harness(async () => { if (!online) throw new TypeError('fetch failed'); return mkRes(201); });
  await q.enqueue(sale('A')); await q.enqueue(sale('B'));
  const r1 = await q.sync();
  assert.equal(r1.stopped, 'network'); assert.equal(r1.remaining, 2); assert.equal(calls.length, 1); // stopped at the first item
  online = true;
  const r2 = await q.sync();
  assert.equal(r2.synced.length, 2);
  assert.equal(calls[1].headers['idempotency-key'], 'uuid-1'); // retried with the original key
});

test('lost response: server may have executed; a replayed answer counts as synced', async () => {
  const { q } = harness(async () => mkRes(201, { id: 1 }, { 'idempotency-replayed': 'true' }));
  await q.enqueue(sale());
  const r = await q.sync();
  assert.equal(r.synced[0].replayed, true);
});

test('business conflict (4xx) marks the item failed with the server reason and continues with the next item', async () => {
  const { q, calls } = harness(async (p, init) => (JSON.parse(init.body).items[0].sku === 'BAD' ? mkRes(422, { error: { code: 'OUT_OF_STOCK', message: 'Not enough stock' } }) : mkRes(201)));
  await q.enqueue(sale('A')); await q.enqueue(sale('BAD')); await q.enqueue(sale('C'));
  const r = await q.sync();
  assert.equal(calls.length, 3);
  assert.equal(r.synced.length, 2); assert.equal(r.failed.length, 1);
  const [failed] = await q.list();
  assert.equal(failed.status, 'failed'); assert.equal(failed.error.code, 'OUT_OF_STOCK'); assert.equal(failed.error.message, 'Not enough stock');
  assert.deepEqual(await q.counts(), { pending: 0, failed: 1, total: 1 });
});

test('failed items are not resent until retried; retry re-sends with the same key', async () => {
  let fail = true;
  const { q, calls } = harness(async () => (fail ? mkRes(400, { error: { code: 'BAD_INPUT', message: 'nope' } }) : mkRes(201)));
  const it = await q.enqueue(sale());
  await q.sync(); await q.sync();
  assert.equal(calls.length, 1);
  fail = false;
  await q.retry(it.id);
  const r = await q.sync();
  assert.equal(r.synced.length, 1); assert.equal(calls[1].headers['idempotency-key'], it.key);
});

test('edit changes the body, issues a new key and resets the failure', async () => {
  let n = 0;
  const { q, calls } = harness(async (p, init) => (JSON.parse(init.body).items[0].qty > 1 ? mkRes(422, { error: { code: 'X', message: 'too many' } }) : (n++, mkRes(201))));
  const it = await q.enqueue({ ...sale(), body: { items: [{ sku: 'TEA', qty: 5 }] } });
  await q.sync();
  const edited = await q.edit(it.id, { items: [{ sku: 'TEA', qty: 1 }] });
  assert.notEqual(edited.key, it.key); assert.equal(edited.status, 'pending'); assert.equal(edited.error, null);
  await q.sync();
  assert.equal(n, 1); assert.equal(calls.at(-1).body.items[0].qty, 1);
  await assert.rejects(q.edit(999, {}), (e) => e.code === 'NOT_FOUND');
});

test('discard removes an item; retry of a pending item is refused', async () => {
  const { q } = harness(async () => mkRes(201));
  const a = await q.enqueue(sale('A')); const b = await q.enqueue(sale('B'));
  await q.discard(a.id);
  assert.deepEqual((await q.list()).map((i) => i.id), [b.id]);
  await assert.rejects(q.retry(b.id), (e) => e.code === 'NOT_FAILED');
  await assert.rejects(q.discard(a.id), (e) => e.code === 'NOT_FOUND');
});

test('5xx, 429 and 401 stop the run and keep items pending; 429 honours Retry-After', async () => {
  for (const [status, stopped, hdr] of [[503, 'retryable', {}], [429, 'retryable', { 'retry-after': '7' }], [401, 'auth', {}]]) {
    const { q, calls } = harness(async () => mkRes(status, { error: { code: 'E', message: 'm' } }, hdr));
    await q.enqueue(sale('A')); await q.enqueue(sale('B'));
    const r = await q.sync();
    assert.equal(r.stopped, stopped); assert.equal(r.remaining, 2); assert.equal(calls.length, 1);
    if (status === 429) assert.equal(r.retryAfterMs, 7000);
    assert.equal((await q.counts()).failed, 0);
  }
});

test('IDEMPOTENCY_IN_PROGRESS (409) is retryable, other 409s are conflicts', async () => {
  const a = harness(async () => mkRes(409, { error: { code: 'IDEMPOTENCY_IN_PROGRESS', message: 'wait' } }));
  await a.q.enqueue(sale()); assert.equal((await a.q.sync()).stopped, 'retryable');
  const b = harness(async () => mkRes(409, { error: { code: 'DUPLICATE', message: 'exists' } }));
  await b.q.enqueue(sale()); assert.equal((await b.q.sync()).failed.length, 1);
});

test('concurrent sync calls share one run (one request per item)', async () => {
  const { q, calls } = harness(async () => { await new Promise((r) => setTimeout(r, 5)); return mkRes(201); });
  await q.enqueue(sale('A')); await q.enqueue(sale('B'));
  const [r1, r2] = await Promise.all([q.sync(), q.sync()]);
  assert.equal(r1, r2); assert.equal(calls.length, 2);
});

test('items replay only for the identity that queued them', async () => {
  const h = harness(async () => mkRes(201));
  await h.q.enqueue(sale('A'));
  h.setIdentity('demo:4');
  assert.equal((await h.q.list()).length, 0);
  assert.equal((await h.q.sync()).synced.length, 0); assert.equal(h.calls.length, 0);
  await assert.rejects(h.q.discard(1), (e) => e.code === 'NOT_FOUND');
  h.setIdentity('demo:3');
  assert.equal((await h.q.sync()).synced.length, 1);
});

test('a pending item left in a crashed state is resent safely with its key; queue-full is enforced', async () => {
  const storage = memoryStorage();
  const h = harness(async () => mkRes(201), { storage, maxItems: 2 });
  await h.q.enqueue(sale('A')); await h.q.enqueue(sale('B'));
  await assert.rejects(h.q.enqueue(sale('C')), (e) => e.code === 'QUEUE_FULL');
  const rows = await storage.getAll(); rows[0].attempts = 3; await storage.update(rows[0]); // simulate a reload mid-send
  const h2 = createQueue({ storage, fetch: async (p, init) => { h.calls.push({ key: init.headers['idempotency-key'] }); return mkRes(201); }, getIdentity: () => 'demo:3' });
  await h2.sync();
  assert.deepEqual(h.calls.map((c) => c.key), ['uuid-1', 'uuid-2']);
});

test('onChange fires on enqueue, sync progress and discard; listener errors are swallowed', async () => {
  let n = 0;
  const { q } = harness(async () => mkRes(201), { onChange: () => { n++; throw new Error('ui bug'); } });
  const it = await q.enqueue(sale()); assert.equal(n, 1);
  await q.sync(); assert.ok(n >= 3);
  const it2 = await q.enqueue(sale()); const before = n; await q.discard(it2.id); assert.equal(n, before + 1); assert.ok(it);
});

test('backoffMs grows exponentially and is capped', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(backoffMs), [2000, 2000, 4000, 8000, 16000]);
  assert.equal(backoffMs(50), 60000);
});

test('createQueue requires storage and fetch', () => {
  assert.throws(() => createQueue({}), /storage/);
});
