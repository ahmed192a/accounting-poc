import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, createDemoContext } from '../src/server.js';
import { startApp } from './helpers.js';
import { canonicalJson, purgeExpired, IDEMPOTENCY_TTL_MS } from '../src/idempotency.js';

const post = (base, path, uid, body, key) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-user-id': String(uid), ...(key ? { 'idempotency-key': key } : {}) },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, replayed: r.headers.get('idempotency-replayed'), body: await r.json() }));

const sale = { items: [{ sku: 'TEA', qty: 1 }] };
const count = (ctx) => ctx.db.prepare('SELECT COUNT(*) n FROM sales').get().n;
async function firstSku(call) { const r = await call('GET', '/api/items', 3); return r.body[0].sku; }
const boot = async () => {
  const ctx = createDemoContext();
  const app = await startApp(createApp, ctx, { backgroundJobs: false });
  const sku = await firstSku(app.call);
  return { ctx, ...app, body: { items: [{ sku, qty: 1 }] } };
};

test('idempotency: same key and body is executed once and the original response is returned', async () => {
  const { ctx, server, base, body } = await boot();
  try {
    const before = count(ctx);
    const a = await post(base, '/api/sales/quick', 3, body, 'key-aaaa-0001');
    const b = await post(base, '/api/sales/quick', 3, body, 'key-aaaa-0001');
    assert.equal(a.status, 201); assert.equal(b.status, 201);
    assert.equal(a.replayed, null); assert.equal(b.replayed, 'true');
    assert.deepEqual(b.body, a.body);
    assert.equal(count(ctx), before + 1);
  } finally { server.close(); }
});

test('idempotency: no header means no deduplication (behaviour unchanged)', async () => {
  const { ctx, server, base, body } = await boot();
  try {
    const before = count(ctx);
    await post(base, '/api/sales/quick', 3, body); await post(base, '/api/sales/quick', 3, body);
    assert.equal(count(ctx), before + 2);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='idempotency_keys'").get().n, 0);
  } finally { server.close(); }
});

test('idempotency: same key with a different body is 422 and does not execute', async () => {
  const { ctx, server, base, body } = await boot();
  try {
    await post(base, '/api/sales/quick', 3, body, 'key-bbbb-0002');
    const n = count(ctx);
    const r = await post(base, '/api/sales/quick', 3, { items: [{ ...body.items[0], qty: 2 }] }, 'key-bbbb-0002');
    assert.equal(r.status, 422); assert.equal(r.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(count(ctx), n);
  } finally { server.close(); }
});

test('idempotency: key order inside the body does not matter', () => {
  assert.equal(canonicalJson({ a: 1, b: [{ y: 1, x: 2 }] }), canonicalJson({ b: [{ x: 2, y: 1 }], a: 1 }));
});

test('idempotency: keys are scoped per user (another user with the same key executes separately)', async () => {
  const { ctx, server, base, body } = await boot();
  try {
    const n = count(ctx);
    const a = await post(base, '/api/sales/quick', 3, body, 'key-cccc-0003');
    const b = await post(base, '/api/sales/quick', 1, body, 'key-cccc-0003');
    assert.equal(a.replayed, null); assert.equal(b.replayed, null);
    assert.equal(count(ctx), n + 2);
  } finally { server.close(); }
});

test('idempotency: a failed request is not stored, so a corrected retry with the same key works', async () => {
  const { ctx, server, base, body } = await boot();
  try {
    const bad = await post(base, '/api/sales/quick', 3, { items: [{ sku: 'NOPE-NOPE', qty: 1 }] }, 'key-dddd-0004');
    assert.ok(bad.status >= 400 && bad.status < 500);
    const n = count(ctx);
    const ok = await post(base, '/api/sales/quick', 3, body, 'key-dddd-0004');
    assert.equal(ok.status, 201);
    assert.equal(count(ctx), n + 1);
  } finally { server.close(); }
});

test('idempotency: a malformed key is rejected with 400', async () => {
  const { server, base, body } = await boot();
  try {
    for (const k of ['short', 'has space in it!!', 'x'.repeat(129)]) {
      const r = await post(base, '/api/sales/quick', 3, body, k);
      assert.equal(r.status, 400); assert.equal(r.body.error.code, 'BAD_IDEMPOTENCY_KEY');
    }
  } finally { server.close(); }
});

test('idempotency: permission denial is not cached and not replayed as success', async () => {
  const { server, base, body } = await boot();
  try {
    const a = await post(base, '/api/sales/quick', 5, body, 'key-eeee-0005'); // auditor cannot sell
    assert.equal(a.status, 403);
    const b = await post(base, '/api/sales/quick', 5, body, 'key-eeee-0005');
    assert.equal(b.status, 403); assert.equal(b.replayed, null);
  } finally { server.close(); }
});

test('idempotency: concurrent duplicates yield one execution (the other gets 409 or the replay)', async () => {
  const { ctx, server, base, body } = await boot();
  try {
    const n = count(ctx);
    const rs = await Promise.all([1, 2, 3].map(() => post(base, '/api/sales/quick', 3, body, 'key-ffff-0006')));
    assert.equal(count(ctx), n + 1);
    for (const r of rs) assert.ok([201, 409].includes(r.status));
  } finally { server.close(); }
});

test('idempotency: records expire after 24h and are purged; an expired key executes again', async () => {
  const { ctx, server, base, body } = await boot();
  try {
    await post(base, '/api/sales/quick', 3, body, 'key-gggg-0007');
    const row = ctx.db.prepare('SELECT * FROM idempotency_keys').get();
    assert.equal(row.expires_at - row.created_at, IDEMPOTENCY_TTL_MS);
    assert.match(row.response_hash, /^[0-9a-f]{64}$/);
    const n = count(ctx);
    ctx.offsetMs = (ctx.offsetMs ?? 0) + IDEMPOTENCY_TTL_MS + 1000; // demo clock moves on
    const again = await post(base, '/api/sales/quick', 3, body, 'key-gggg-0007');
    assert.equal(again.replayed, null);
    assert.equal(count(ctx), n + 1);
    ctx.offsetMs += 2 * IDEMPOTENCY_TTL_MS;
    assert.ok(purgeExpired(ctx) >= 1);
  } finally { server.close(); }
});

test('idempotency: customer creation replay returns the same customer id and creates one row', async () => {
  const { ctx, server, base } = await boot();
  try {
    const n = ctx.db.prepare('SELECT COUNT(*) n FROM sales_customers').get().n;
    const body = { name: 'Offline Cafe', phone: '01000000000' };
    const a = await post(base, '/api/customers', 1, body, 'key-hhhh-0008');
    const b = await post(base, '/api/customers', 1, body, 'key-hhhh-0008');
    assert.equal(a.status, 201); assert.equal(b.replayed, 'true');
    assert.deepEqual(b.body, a.body);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM sales_customers').get().n, n + 1);
  } finally { server.close(); }
});

test('idempotency: unauthenticated-style public routes and GETs ignore the header', async () => {
  const { server, base } = await boot();
  try {
    const r = await fetch(base + '/api/items', { headers: { 'x-user-id': '3', 'idempotency-key': 'bad key!' } });
    assert.equal(r.status, 200); // GET: header ignored, even if malformed
  } finally { server.close(); }
});
