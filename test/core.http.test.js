import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, createDemoContext } from '../src/server.js';

async function start() {
  const server = createApp(createDemoContext());
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, userId, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(userId ? { 'x-user-id': String(userId) } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { server, call, base };
}

test('HTTP: serves the app, lists demo users, enforces identity and permissions', async () => {
  const { server, call, base } = await start();
  try {
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);

    const users = await call('GET', '/api/demo-users');
    assert.equal(users.status, 200);
    assert.equal(users.body.length, 6);

    assert.equal((await call('GET', '/api/home')).status, 401);
    assert.equal((await call('GET', '/api/reports', 3)).status, 403); // clerk
    assert.equal((await call('GET', '/api/reports', 1)).status, 200); // owner
    assert.equal((await call('GET', '/api/nope', 1)).status, 404);
  } finally {
    server.close();
  }
});

test('HTTP: sale -> receipt queue -> reversal flow returns structured errors', async () => {
  const { server, call } = await start();
  try {
    await call('POST', '/api/eta/online', 2, { online: false });
    const sale = await call('POST', '/api/sales/quick', 3, { items: [{ sku: 'TEA-250', qty: 2 }] });
    assert.equal(sale.status, 201);
    assert.equal(sale.body.receipt.status, 'queued');

    const bad = await call('POST', '/api/sales/quick', 3, { items: [{ sku: 'TEA-250', qty: -1 }] });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'BAD_INPUT');

    const entryId = sale.body.entryId;
    const noReason = await call('POST', `/api/entries/${entryId}/reverse`, 4, { reason: '' });
    assert.equal(noReason.body.error.code, 'REASON_REQUIRED');
    const ok = await call('POST', `/api/entries/${entryId}/reverse`, 4, { reason: 'Customer returned goods' });
    assert.equal(ok.status, 201);
    const again = await call('POST', `/api/entries/${entryId}/reverse`, 4, { reason: 'again' });
    assert.equal(again.status, 409);

    await call('POST', '/api/eta/online', 2, { online: true });
    const sync = await call('POST', '/api/eta/sync', 3);
    assert.equal(sync.body.submitted, 1);

    const home = await call('GET', '/api/home', 3);
    assert.ok(home.body.widgets.eta.counts.submitted >= 1);
    assert.equal(home.body.widgets.cash, undefined);
  } finally {
    server.close();
  }
});
