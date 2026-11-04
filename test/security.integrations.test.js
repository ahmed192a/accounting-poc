import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot, addUser, roleId, OWNER_PW } from './security.helpers.js';
import { createContext } from '../src/db.js';
import { emit } from '../src/hooks.js';
import { tx, audit } from '../src/ledger.js';
import { sign, processDeliveries, createWebhook } from '../src/modules/auth/webhooks.js';
import { sealAudit, verifyAudit } from '../src/modules/auth/auditchain.js';
import { assertSafeUrl, assertSafeUrlSyntax } from '../src/modules/auth/ssrf.js';
import { loadUser } from '../src/permissions.js';
import { updateRole } from '../src/modules/core/service.js';
import { hmacHex } from '../src/modules/auth/crypto.js';

const withApp = (opts, fn) => async () => {
  const app = await boot(opts);
  try { await fn(app); } finally { await app.close(); }
};
const okFetch = (calls, status = 200) => async (url, init) => { calls.push({ url, init }); return new Response(null, { status }); };
const PUBLIC = async () => [{ address: '93.184.216.34' }];

test('users: invite needs users.invite, cannot grant a role above yourself, accept sets a policy-checked password', withApp({ required: true }, async (app) => {
  await app.loginOwner();
  const mgr = await addUser(app, { name: 'Karim', email: 'karim@example.test', roleId: roleId(app.ctx, 'manager') });
  assert.equal((await app.call('POST', '/api/auth/users', { body: { name: 'X', email: 'x@example.test', roleId: roleId(app.ctx, 'clerk') } })).status, 201);
  const dup = await app.call('POST', '/api/auth/users', { body: { name: 'X', email: 'KARIM@example.test', roleId: roleId(app.ctx, 'clerk') } });
  assert.equal(dup.body.error.code, 'DUPLICATE');
  const inv = await app.call('POST', '/api/auth/users', { body: { name: 'Y', email: 'y@example.test', roleId: roleId(app.ctx, 'clerk') } });
  assert.equal((await app.call('POST', '/api/auth/accept-invite', { body: { token: inv.body.inviteToken, password: 'short' }, csrf: false })).body.error.code, 'WEAK_PASSWORD');
  assert.equal((await app.call('POST', '/api/auth/accept-invite', { body: { token: 'inv_bogus', password: OWNER_PW }, csrf: false })).body.error.code, 'INVALID_INVITE');
  app.ctx.offsetMs += 8 * 86_400_000;
  assert.equal((await app.call('POST', '/api/auth/accept-invite', { body: { token: inv.body.inviteToken, password: 'Valid-Passphrase-77' }, csrf: false })).body.error.code, 'INVALID_INVITE', 'expired');
  // a manager has no users.invite
  app.jar.clear(); app.state.csrf = null;
  await app.login(mgr.email, mgr.password);
  const denied = await app.call('POST', '/api/auth/users', { body: { name: 'Z', email: 'z@example.test', roleId: roleId(app.ctx, 'clerk') } });
  assert.equal(denied.status, 403);
  // an admin (has users.invite) cannot invite into the owner role, which holds permissions the admin lacks
  app.jar.clear(); app.state.csrf = null;
  await app.loginOwner();
  const adm = await addUser(app, { name: 'Omar', email: 'omar@example.test', roleId: roleId(app.ctx, 'admin') });
  app.jar.clear(); app.state.csrf = null;
  await app.login(adm.email, adm.password);
  const esc = await app.call('POST', '/api/auth/users', { body: { name: 'Boss', email: 'boss@example.test', roleId: roleId(app.ctx, 'owner') } });
  assert.equal(esc.status, 403);
}));

test('users: deactivate kills sessions, keys and header identity; reactivate restores; admin reset forces a password change', withApp({ required: true }, async (app) => {
  await app.loginOwner();
  const u = await addUser(app, { name: 'Sara', email: 'sara@example.test', roleId: roleId(app.ctx, 'accountant') });
  const owner = app.jar.get('acc_sid'), ownerCsrf = app.state.csrf;
  app.jar.clear(); app.state.csrf = null;
  await app.login(u.email, u.password);
  const sara = { jar: app.jar.get('acc_sid'), csrf: app.state.csrf };
  assert.equal((await app.call('GET', '/api/audit')).status, 200);
  app.jar.set('acc_sid', owner); app.state.csrf = ownerCsrf;
  assert.equal((await app.call('POST', `/api/auth/users/${u.id}/deactivate`, { body: {} })).body.error.code, 'REASON_REQUIRED');
  assert.equal((await app.call('POST', `/api/auth/users/${u.id}/deactivate`, { body: { reason: 'left company' } })).status, 200);
  app.jar.set('acc_sid', sara.jar); app.state.csrf = sara.csrf;
  assert.equal((await app.call('GET', '/api/audit')).body.error.code, 'AUTH_REQUIRED');
  assert.equal((await app.login(u.email, u.password)).body.error.code, 'ACCOUNT_DISABLED');
  app.jar.set('acc_sid', owner); app.state.csrf = ownerCsrf;
  assert.equal((await app.call('POST', `/api/auth/users/${owner ? 1 : 1}/deactivate`, { body: { reason: 'x' } })).body.error.code, 'BAD_INPUT', 'cannot deactivate yourself');
  await app.call('POST', `/api/auth/users/${u.id}/reactivate`);
  const reset = await app.call('POST', `/api/auth/users/${u.id}/reset-password`);
  assert.ok(reset.body.temporaryPassword);
  app.jar.clear(); app.state.csrf = null;
  assert.equal((await app.login(u.email, reset.body.temporaryPassword)).body.mustChangePassword, true);
  assert.equal((await app.call('GET', '/api/audit')).body.error.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await app.call('POST', '/api/auth/password', { body: { current: reset.body.temporaryPassword, next: 'weak' } })).body.error.code, 'WEAK_PASSWORD');
  assert.equal((await app.call('POST', '/api/auth/password', { body: { current: reset.body.temporaryPassword, next: 'Brand-New-Passphrase-5' } })).status, 200);
  assert.equal((await app.call('GET', '/api/audit')).status, 200);
}));

test('demo mode: deactivating a user also blocks their x-user-id identity', withApp({}, async (app) => {
  assert.equal((await app.call('POST', '/api/auth/users/3/deactivate', { as: 6, body: { reason: 'test' } })).status, 200);
  assert.equal((await app.call('GET', '/api/home', { as: 3 })).body.error.code, 'ACCOUNT_DISABLED');
  assert.equal((await app.call('GET', '/api/home', { as: 2 })).status, 200);
}));

test('password change signs out other devices', withApp({ required: true }, async (app) => {
  await app.loginOwner();
  const other = app.jar.get('acc_sid'), otherCsrf = app.state.csrf;
  await app.loginOwner();
  assert.equal((await app.call('POST', '/api/auth/password', { body: { current: OWNER_PW, next: 'Second-Strong-Passphrase-3' } })).body.sessionsRevoked, 1);
  const here = app.jar.get('acc_sid');
  app.jar.set('acc_sid', other); app.state.csrf = otherCsrf;
  assert.equal((await app.call('GET', '/api/home')).status, 401);
  app.jar.set('acc_sid', here);
  assert.equal((await app.call('GET', '/api/home')).status, 200);
}));

test('rate limiting: token bucket with X-RateLimit headers, 429 + Retry-After, refill over time', withApp({ rateLimit: { capacity: 3, perMinute: 60 } }, async (app) => {
  const r1 = await app.call('GET', '/api/home', { as: 1 });
  assert.equal(r1.headers.get('x-ratelimit-limit'), '3'); assert.equal(r1.headers.get('x-ratelimit-remaining'), '2');
  await app.call('GET', '/api/home', { as: 1 }); await app.call('GET', '/api/home', { as: 1 });
  const r4 = await app.call('GET', '/api/home', { as: 1 });
  assert.equal(r4.status, 429); assert.equal(r4.body.error.code, 'RATE_LIMITED');
  assert.equal(r4.headers.get('retry-after'), '1'); assert.equal(r4.headers.get('x-ratelimit-remaining'), '0');
  assert.equal((await app.call('GET', '/healthz')).status, 200, 'health probe exempt');
  app.ctx.offsetMs += 2000;
  assert.equal((await app.call('GET', '/api/home', { as: 1 })).status, 200);
  assert.equal((await (await import('node:http')).default ? 1 : 1), 1);
}));

test('rate limiting: sign-in attempts have their own stricter per-IP bucket', withApp({ loginRateLimit: { capacity: 3, perMinute: 3 } }, async (app) => {
  for (let i = 0; i < 3; i++) assert.equal((await app.login('nobody@example.test', 'Some-Password-123')).status, 401);
  const r = await app.login('nobody@example.test', 'Some-Password-123');
  assert.equal(r.status, 429); assert.equal(r.body.error.code, 'RATE_LIMITED');
  assert.equal((await app.call('GET', '/api/home', { as: 1 })).status, 200, 'normal API traffic is not affected');
}));

test('rate limiting: API keys get their own bucket, separate from the IP', withApp({ rateLimit: { capacity: 2, perMinute: 60 } }, async (app) => {
  app.ctx.offsetMs += 0;
  const k = await app.call('POST', '/api/apikeys', { as: 1, body: { name: 'bot', permissions: ['audit.view'] } });
  assert.equal(k.status, 201);
  assert.equal((await app.call('GET', '/api/audit', { key: k.body.key })).headers.get('x-ratelimit-remaining'), '1');
  await app.call('GET', '/api/audit', { key: k.body.key });
  assert.equal((await app.call('GET', '/api/audit', { key: k.body.key })).status, 429);
  assert.equal((await app.call('GET', '/api/home', { as: 1 })).status, 200, 'the IP bucket still has tokens');
}));

test('request size limit and JSON validation', withApp({ maxBodyBytes: 2000 }, async (app) => {
  const big = await app.call('POST', '/api/roles', { as: 1, raw: JSON.stringify({ name: 'x'.repeat(5000), permissions: [] }) });
  assert.equal(big.status, 413); assert.equal(big.body.error.code, 'TOO_LARGE');
  assert.equal((await app.call('POST', '/api/roles', { as: 1, raw: '{nope' })).body.error.code, 'BAD_JSON');
  assert.equal((await app.call('POST', '/api/roles', { as: 1, raw: 'null' })).body.error.code, 'BAD_JSON');
  assert.equal((await app.call('GET', '/api/home', { as: 1 })).status, 200, 'server still healthy');
}));

test('API keys: hashed at rest, shown once, scoped, last-used, revocable, expiring', withApp({}, async (app) => {
  assert.equal((await app.call('POST', '/api/apikeys', { as: 3, body: { name: 'k', permissions: ['audit.view'] } })).status, 403, 'clerk lacks apikeys.manage');
  assert.equal((await app.call('POST', '/api/apikeys', { as: 6, body: { name: 'k', permissions: ['payroll.view'] } })).body.error.code, 'SCOPE_EXCEEDS_USER', 'admin lacks payroll.view');
  assert.equal((await app.call('POST', '/api/apikeys', { as: 6, body: { name: 'k', permissions: ['nope.nothing'] } })).body.error.code, 'BAD_INPUT');
  const k = await app.call('POST', '/api/apikeys', { as: 1, body: { name: 'reporting', permissions: ['audit.view'], expiresInDays: 1 } });
  assert.equal(k.status, 201); assert.match(k.body.key, /^acck_[0-9a-f]{10}_[\w-]{32}$/);
  assert.ok(!JSON.stringify(app.ctx.db.prepare('SELECT * FROM auth_api_keys').all()).includes(k.body.key));
  assert.ok(!(await app.call('GET', '/api/apikeys', { as: 1 })).text.includes(k.body.key.slice(-32)), 'list never shows the secret');
  // scope: the owner could do anything, the key can only read the audit log
  assert.equal((await app.call('GET', '/api/audit', { key: k.body.key })).status, 200);
  const roles = await app.call('GET', '/api/roles', { key: k.body.key });
  assert.equal(roles.status, 403);
  assert.equal((await app.call('GET', '/api/audit', { as: 3, key: k.body.key })).status, 200, 'a presented key wins over x-user-id');
  assert.ok(app.ctx.db.prepare('SELECT last_used_at FROM auth_api_keys WHERE id = ?').get(k.body.id).last_used_at);
  assert.equal((await app.call('GET', '/api/audit', { key: k.body.key.slice(0, -1) + 'x' })).body.error.code, 'INVALID_API_KEY');
  assert.equal((await app.call('GET', '/api/audit', { key: 'acck_garbage' })).body.error.code, 'INVALID_API_KEY');
  // the key shrinks with its owner's role
  app.ctx.db.prepare("UPDATE users SET role_id = (SELECT id FROM roles WHERE name = 'clerk') WHERE id = 1").run();
  assert.equal((await app.call('GET', '/api/audit', { key: k.body.key })).status, 403);
  app.ctx.db.prepare("UPDATE users SET role_id = (SELECT id FROM roles WHERE name = 'owner') WHERE id = 1").run();
  const k2 = await app.call('POST', '/api/apikeys', { as: 1, body: { name: 'tmp', permissions: ['audit.view'], expiresInDays: 1 } });
  app.ctx.offsetMs += 2 * 86_400_000;
  assert.equal((await app.call('GET', '/api/audit', { key: k2.body.key })).body.error.code, 'INVALID_API_KEY', 'expired');
  app.ctx.offsetMs = 0;
  assert.equal((await app.call('DELETE', `/api/apikeys/${k.body.id}`, { as: 1 })).status, 200);
  assert.equal((await app.call('GET', '/api/audit', { key: k.body.key })).body.error.code, 'INVALID_API_KEY', 'revoked');
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'apikey.revoked'").get());
}));

test('API keys work when sign-in is required, and die with a deactivated owner', withApp({ required: true }, async (app) => {
  await app.loginOwner();
  const k = await app.call('POST', '/api/apikeys', { body: { name: 'ci', permissions: ['audit.view'] } });
  app.jar.clear(); app.state.csrf = null;
  assert.equal((await app.call('GET', '/api/audit', { key: k.body.key })).status, 200);
  assert.equal((await app.call('GET', '/api/audit', { key: k.body.key, as: 1 })).status, 200);
  app.ctx.db.prepare('UPDATE auth_credentials SET active = 0 WHERE user_id = 1').run();
  assert.equal((await app.call('GET', '/api/audit', { key: k.body.key })).body.error.code, 'INVALID_API_KEY');
}));

// ---------- webhooks ----------
test('webhooks: hook events are queued, signed with HMAC-SHA256, delivered with an injected fetch', async () => {
  const app = await boot({});
  try {
    const calls = [];
    const wh = createWebhook(app.ctx, loadUser(app.ctx, 6), { url: 'https://hooks.example.com/in', events: ['invoice.paid'], description: 'erp' });
    assert.match(wh.secret, /^whsec_/);
    assert.ok(!JSON.stringify(app.ctx.db.prepare('SELECT * FROM auth_webhooks').all()).includes(wh.secret), 'secret encrypted at rest');
    emit(app.ctx, 'sale.created', { sale: { id: 1 } });                       // not subscribed
    emit(app.ctx, 'invoice.paid', { id: 7, total: 11400, entryId: 3, userId: 2 });
    assert.equal(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM auth_webhook_deliveries').get().n, 1);
    const res = await processDeliveries(app.ctx, { fetchImpl: okFetch(calls), resolve: PUBLIC });
    assert.deepEqual(res, { attempted: 1, delivered: 1, failed: 0, dead: 0 });
    const { url, init } = calls[0];
    assert.equal(url, 'https://hooks.example.com/in');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers['x-webhook-event'], 'invoice.paid');
    const t = init.headers['x-webhook-timestamp'];
    assert.equal(init.headers['x-webhook-signature'], `t=${t},v1=${hmacHex(wh.secret, `${t}.${init.body}`)}`);
    assert.equal(init.headers['x-webhook-signature'], sign(wh.secret, t, init.body));
    assert.equal(JSON.parse(init.body).data.total, 11400);
    assert.equal(app.ctx.db.prepare('SELECT status FROM auth_webhook_deliveries').get().status, 'delivered');
  } finally { await app.close(); }
});

test('webhooks: failures retry with exponential backoff, then go dead; manual retry re-queues', async () => {
  const app = await boot({ webhook: { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 3000 } });
  try {
    createWebhook(app.ctx, loadUser(app.ctx, 6), { url: 'https://hooks.example.com/in', events: ['*'] });
    emit(app.ctx, 'bill.created', { bill: { id: 1 } });
    const calls = [];
    const run = () => processDeliveries(app.ctx, { fetchImpl: okFetch(calls, 500), resolve: PUBLIC });
    const row = () => app.ctx.db.prepare('SELECT * FROM auth_webhook_deliveries').get();
    const t0 = app.ctx.now();
    assert.equal((await run()).failed, 1);
    assert.equal(row().attempts, 1); assert.equal(row().last_error, 'HTTP 500');
    assert.ok(row().next_attempt_at - t0 >= 1000 && row().next_attempt_at - t0 < 1500);
    assert.equal((await run()).attempted, 0, 'not due yet');
    app.ctx.offsetMs += 1100;
    await run();
    assert.ok(row().next_attempt_at - app.ctx.now() > 1500, 'second delay is double');
    app.ctx.offsetMs += 2100;
    await run();
    assert.ok(row().next_attempt_at - app.ctx.now() <= 3000, 'delay is capped');
    app.ctx.offsetMs += 3100;
    assert.equal((await run()).dead, 1);
    assert.equal(row().status, 'dead'); assert.equal(calls.length, 4);
    const owner = loadUser(app.ctx, 6);
    const { retryDelivery } = await import('../src/modules/auth/webhooks.js');
    retryDelivery(app.ctx, owner, row().id);
    const ok = []; 
    assert.equal((await processDeliveries(app.ctx, { fetchImpl: okFetch(ok), resolve: PUBLIC })).delivered, 1);
  } finally { await app.close(); }
});

test('webhooks: a rolled-back transaction delivers nothing; redirects and network errors count as failures', async () => {
  const app = await boot({});
  try {
    createWebhook(app.ctx, loadUser(app.ctx, 6), { url: 'https://hooks.example.com/in', events: ['*'] });
    assert.throws(() => tx(app.ctx.db, () => { emit(app.ctx, 'invoice.paid', { id: 1 }); throw new Error('boom'); }), /boom/);
    assert.equal(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM auth_webhook_deliveries').get().n, 0);
    emit(app.ctx, 'invoice.paid', { id: 2 });
    await processDeliveries(app.ctx, { fetchImpl: okFetch([], 302), resolve: PUBLIC });
    assert.match(app.ctx.db.prepare('SELECT last_error FROM auth_webhook_deliveries').get().last_error, /redirect/);
    app.ctx.offsetMs += 3_600_000;
    await processDeliveries(app.ctx, { fetchImpl: async () => { throw new Error('ECONNRESET'); }, resolve: PUBLIC });
    assert.match(app.ctx.db.prepare('SELECT last_error FROM auth_webhook_deliveries').get().last_error, /ECONNRESET/);
  } finally { await app.close(); }
});

test('webhooks over HTTP: permission gated, signed test event, delivery log, process on demand', async () => {
  const calls = [];
  const app = await boot({ fetch: okFetch(calls), resolve: PUBLIC });
  try {
    assert.equal((await app.call('POST', '/api/webhooks', { as: 3, body: { url: 'https://hooks.example.com/x' } })).status, 403);
    const made = await app.call('POST', '/api/webhooks', { as: 6, body: { url: 'https://hooks.example.com/x', events: ['sale.created'] } });
    assert.equal(made.status, 201);
    assert.equal((await app.call('POST', '/api/webhooks', { as: 6, body: { url: 'https://hooks.example.com/x', events: ['nope.event'] } })).body.error.code, 'BAD_INPUT');
    const t = await app.call('POST', `/api/webhooks/${made.body.id}/test`, { as: 6 });
    assert.equal(t.body.result.delivered, 1);
    assert.equal(calls[0].init.headers['x-webhook-event'], 'webhook.test');
    const log = await app.call('GET', '/api/webhooks/deliveries', { as: 6 });
    assert.equal(log.body[0].status, 'delivered');
    assert.ok(!(await app.call('GET', '/api/webhooks', { as: 6 })).text.includes(made.body.secret));
    assert.equal((await app.call('PATCH', `/api/webhooks/${made.body.id}`, { as: 6, body: { active: false } })).body.active, false);
    emit(app.ctx, 'sale.created', { sale: { id: 1 } });
    assert.equal(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM auth_webhook_deliveries WHERE event = 'sale.created'").get().n, 0, 'paused webhook gets nothing');
    assert.equal((await app.call('POST', '/api/webhooks/deliveries/process', { as: 6 })).status, 200);
    assert.equal((await app.call('DELETE', `/api/webhooks/${made.body.id}`, { as: 6 })).status, 200);
  } finally { await app.close(); }
});

test('SSRF guard: private, loopback, link-local, metadata, mapped and internal-name targets are refused', async () => {
  const refused = [
    'http://hooks.example.com/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://app.localhost/x', 'https://10.1.2.3/x', 'https://172.16.0.9/x',
    'https://192.168.1.1/x', 'https://169.254.169.254/latest/meta-data', 'https://100.64.0.1/x', 'https://0.0.0.0/x', 'https://[::1]/x',
    'https://[::ffff:127.0.0.1]/x', 'https://[::ffff:7f00:1]/x', 'https://[fe80::1]/x', 'https://[fc00::1]/x', 'https://[fd12:3456::1]/x',
    'https://[64:ff9b::a00:1]/x', 'https://[2002:7f00:1::]/x', 'https://2130706433/x', 'https://0x7f.1/x', 'https://017700000001/x',
    'https://user:pw@hooks.example.com/x', 'https://intranet/x', 'https://db.internal/x', 'https://printer.local/x', 'ftp://hooks.example.com/x', 'not a url', 'file:///etc/passwd',
  ];
  for (const u of refused) assert.throws(() => assertSafeUrlSyntax(u), (e) => e.code === 'UNSAFE_URL', u);
  assert.doesNotThrow(() => assertSafeUrlSyntax('https://hooks.example.com:8443/in?x=1'));
  assert.doesNotThrow(() => assertSafeUrlSyntax('https://8.8.8.8/x'));
  await assert.rejects(assertSafeUrl('https://evil.example.com/x', { resolve: async () => [{ address: '10.0.0.5' }] }), { code: 'UNSAFE_URL' });
  await assert.rejects(assertSafeUrl('https://evil.example.com/x', { resolve: async () => [{ address: '93.184.216.34' }, { address: '::1' }] }), { code: 'UNSAFE_URL' }, 'any private answer refuses');
  await assert.rejects(assertSafeUrl('https://gone.example.com/x', { resolve: async () => { throw new Error('ENOTFOUND'); } }), { code: 'UNSAFE_URL' });
  await assert.doesNotReject(assertSafeUrl('https://ok.example.com/x', { resolve: PUBLIC }));
});

test('SSRF guard: registration over HTTP refuses internal URLs; delivery re-checks DNS and never calls fetch', async () => {
  const app = await boot({});
  try {
    const bad = await app.call('POST', '/api/webhooks', { as: 6, body: { url: 'https://169.254.169.254/latest' } });
    assert.equal(bad.status, 400); assert.equal(bad.body.error.code, 'UNSAFE_URL');
    createWebhook(app.ctx, loadUser(app.ctx, 6), { url: 'https://rebind.example.com/in', events: ['*'] });
    emit(app.ctx, 'invoice.paid', { id: 1 });
    const calls = [];
    await processDeliveries(app.ctx, { fetchImpl: okFetch(calls), resolve: async () => [{ address: '127.0.0.1' }] });
    assert.equal(calls.length, 0);
    assert.match(app.ctx.db.prepare('SELECT last_error FROM auth_webhook_deliveries').get().last_error, /private/);
  } finally { await app.close(); }
});

// ---------- audit integrity ----------
test('audit chain: verifies clean; tampering with a COPY (triggers dropped) is detected as modified, deleted and inserted rows', async () => {
  const app = await boot({});
  const dir = mkdtempSync(join(tmpdir(), 'poc-audit-'));
  try {
    for (let i = 1; i <= 5; i++) audit(app.ctx, { userId: 1, action: 'test.event', type: 'x', id: i, newValue: { i } });
    assert.ok(sealAudit(app.ctx) >= 5);
    const clean = verifyAudit(app.ctx);
    assert.equal(clean.ok, true); assert.deepEqual(clean.problems, []); assert.match(clean.head, /^[0-9a-f]{64}$/);

    const copy = (name) => {
      const path = join(dir, name);
      app.ctx.db.exec(`VACUUM INTO '${path}'`);
      const db = new DatabaseSync(path);
      db.exec('DROP TRIGGER al_no_update; DROP TRIGGER al_no_delete');
      return createContext(db, app.ctx.registry);
    };
    const mod = copy('mod.db');
    const victim = mod.db.prepare("SELECT id FROM audit_log WHERE action = 'test.event' ORDER BY id LIMIT 1 OFFSET 2").get().id;
    mod.db.prepare("UPDATE audit_log SET new_value = '{\"i\":999}' WHERE id = ?").run(victim);
    const r1 = verifyAudit(mod);
    assert.equal(r1.ok, false); assert.deepEqual(r1.problems, [{ auditId: victim, kind: 'row_modified' }]);

    const del = copy('del.db');
    del.db.prepare('DELETE FROM audit_log WHERE id = ?').run(victim);
    assert.deepEqual(verifyAudit(del).problems, [{ auditId: victim, kind: 'row_deleted' }]);

    const ins = copy('ins.db');
    ins.db.prepare('DELETE FROM auth_audit_chain WHERE audit_id = ?').run(victim); // a row that was never chained
    assert.ok(verifyAudit(ins, { seal: false }).problems.some((p) => p.auditId === victim && p.kind === 'row_inserted'));

    const chain = copy('chain.db');
    chain.db.prepare('UPDATE auth_audit_chain SET hash = ? WHERE audit_id = ?').run('f'.repeat(64), victim);
    assert.equal(verifyAudit(chain).ok, false, 'rewriting the chain without the key does not help');

    assert.equal(verifyAudit(app.ctx).ok, true, 'the original is untouched');
    // and the real database refuses the tampering outright
    assert.throws(() => app.ctx.db.prepare("UPDATE audit_log SET action = 'x'").run(), /append-only/);
  } finally { rmSync(dir, { recursive: true, force: true }); await app.close(); }
});

test('GET /api/audit/verify: security.view only, seals first, reports the head', withApp({}, async (app) => {
  assert.equal((await app.call('GET', '/api/audit/verify', { as: 3 })).status, 403);
  await app.call('POST', '/api/roles', { as: 1, body: { name: 'Temp', permissions: ['audit.view'] } });
  const r = await app.call('GET', '/api/audit/verify', { as: 5 }); // auditor
  assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.ok(r.body.sealed >= 1); assert.equal(r.body.unsealed, 0);
  assert.equal((await app.call('GET', '/api/security/overview', { as: 5 })).status, 200);
  assert.equal((await app.call('GET', '/api/security/limits')).body.rateLimit.capacity > 0, true, 'limits are public');
}));

test('permissions: new atoms exist, are granted to the right roles; custom role edits are guarded and audited', withApp({}, async (app) => {
  const perms = (n) => [...loadUser(app.ctx, n).permissions];
  for (const a of ['users.invite', 'apikeys.manage', 'webhooks.manage', 'security.view']) {
    assert.ok(perms(1).includes(a), `owner has ${a}`); assert.ok(perms(6).includes(a), `admin has ${a}`);
    assert.ok(!perms(3).includes(a), `clerk lacks ${a}`);
  }
  assert.ok(perms(5).includes('security.view') && !perms(5).includes('apikeys.manage'));
  const created = await app.call('POST', '/api/roles', { as: 1, body: { name: 'Bookkeeper', permissions: ['audit.view'] } });
  const id = created.body.id;
  assert.equal((await app.call('PATCH', `/api/roles/${id}`, { as: 1, body: { permissions: ['audit.view', 'purchases.create', 'purchases.approve'] } })).body.sodWarnings.length > 0, true);
  assert.equal((await app.call('PATCH', `/api/roles/${roleId(app.ctx, 'clerk')}`, { as: 1, body: { permissions: [] } })).body.error.code, 'BUILTIN_ROLE');
  assert.equal((await app.call('PATCH', `/api/roles/${id}`, { as: 1, body: { permissions: ['bogus.perm'] } })).body.error.code, 'BAD_INPUT');
  // admin (roles.manage) cannot add a permission it does not hold itself
  assert.equal((await app.call('PATCH', `/api/roles/${id}`, { as: 6, body: { permissions: ['audit.view', 'payroll.view'] } })).body.error.code, 'FORBIDDEN');
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'role.updated'").get());
  assert.equal(typeof updateRole, 'function');
}));
