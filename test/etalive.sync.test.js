import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError, startApp } from './helpers.js';
import { createApp } from '../src/server.js';
import * as tax from '../src/modules/tax/service.js';
import * as sales from '../src/modules/sales/service.js';
import * as live from '../src/modules/tax/adapters/eta_live_sync.js';
import { runtime, clearTokenCache } from '../src/modules/tax/adapters/eta_client.js';
import { registerSigner } from '../src/modules/tax/adapters/eta_sign.js';
import { startFakeEta } from './etalive.fake.js';
import { HAVE_OPENSSL, makeIdentity } from './etalive.fixtures.js';

const HOUR = 3600 * 1000;
const skip = !HAVE_OPENSSL && 'openssl CLI not available';
const realSleep = runtime.sleep;
const fakes = [];
after(() => { runtime.sleep = realSleep; return Promise.all(fakes.map((f) => f.close())); });
const identity = HAVE_OPENSSL ? makeIdentity('rsa') : null;

const inv = (ctx, as, over = {}) => sales.createInvoice(ctx, as('clerk'), {
  customer: 'Acme Foods', lines: [{ description: 'Black tea 250g', qty: 2, unitPrice: 4500 }, { description: 'Rice 1kg', qty: 1, unitPrice: 3200 }], ...over,
});
const docs = (ctx, as) => tax.listDocuments(ctx, as('accountant'));
const row = (ctx, id) => ctx.db.prepare('SELECT * FROM tax_documents WHERE id = ?').get(id);

/** A tenant context wired to a fresh fake ETA server, live adapter active, no real waiting. */
async function liveSetup({ config = {}, signer = true } = {}) {
  clearTokenCache();
  const fake = await startFakeEta(); fakes.push(fake);
  const { ctx, as } = setup();
  const sleeps = [];
  runtime.sleep = async (ms) => { sleeps.push(ms); };
  tax.setSecret(ctx, as('manager'), 'eta_client_id', fake.clientId);
  tax.setSecret(ctx, as('manager'), 'eta_client_secret', fake.clientSecret);
  if (signer) {
    tax.setSecret(ctx, as('manager'), 'eta_signing_key_pem', identity.keyPem);
    tax.setSecret(ctx, as('manager'), 'eta_signing_cert_pem', identity.certPem);
  }
  live.updateLiveConfig(ctx, as('manager'), { idUrl: fake.idUrl, apiUrl: fake.apiUrl, backoffMs: 10, maxRetries: 3, ...config });
  tax.updateSettings(ctx, as('manager'), { adapter: 'eta_live' });
  return { fake, ctx, as, sleeps, acc: as('accountant') };
}

test('live: an invoice is queued (no network in the transaction), sync submits it signed, a second sync validates it', { skip }, async () => {
  const { fake, ctx, as, acc } = await liveSetup();
  const r = inv(ctx, as);
  const [d] = docs(ctx, as);
  assert.equal(d.adapter, 'eta_live');
  assert.equal(d.status, 'queued');
  assert.equal(fake.st.requests.length, 0);
  assert.equal(tax.getDocument(ctx, as('accountant'), d.id).payload.totalAmount, r.total / 100);

  const s1 = await live.liveSync(ctx, acc);
  assert.equal(s1.submitted, 1); assert.equal(s1.error, null);
  assert.equal(row(ctx, d.id).status, 'submitted');
  assert.equal(row(ctx, d.id).submission_id, 'SUB-1');
  const sent = fake.st.submissions[0].docs[0];
  assert.equal(sent.uuid, d.uuid); assert.equal(sent.documentTypeVersion, '1.0'); assert.equal(sent.signatures[0].signatureType, 'I');
  assert.ok(!('format' in sent));
  const req = fake.st.requests.find((q) => q.path === '/api/v1.0/documentsubmissions');
  assert.match(req.headers.authorization, /^Bearer tok-1$/);

  fake.st.docs.get(d.uuid).status = 'Valid';
  const s2 = await live.liveSync(ctx, acc);
  assert.equal(s2.valid, 1);
  assert.equal(row(ctx, d.id).status, 'valid');
  const info = live.liveDocument(ctx, acc, d.id);
  assert.equal(info.long_id, `LONG-${d.uuid.slice(0, 8)}`);
  assert.equal(info.share_url, `https://invoicing.eta.gov.eg/documents/${d.uuid}/share/${info.long_id}`);
  assert.equal(tax.verifyChain(ctx, acc).ok, true);
  const actions = ctx.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'tax.%' ORDER BY id").all().map((a) => a.action);
  assert.ok(actions.includes('tax.document_submitted') && actions.includes('tax.document_valid') && actions.includes('tax.live_sync'));
});

test('token: fetched once and cached across calls, refreshed after expiry on the demo clock, and after a 401', { skip }, async () => {
  const { fake, ctx, as, acc } = await liveSetup();
  fake.st.tokenTtl = 100;
  inv(ctx, as); inv(ctx, as);
  await live.liveSync(ctx, acc); // submit
  assert.equal(fake.count('/connect/token'), 1);
  await live.liveSync(ctx, acc); // poll both, still the same token
  assert.equal(fake.count('/connect/token'), 1);
  ctx.offsetMs += 200 * 1000; // past the (ttl - 30 s) refresh point
  await live.liveSync(ctx, acc);
  assert.equal(fake.count('/connect/token'), 2);
  fake.st.validTokens.clear(); // the server revokes it: one 401 then a fresh token, no failure
  await live.liveSync(ctx, acc);
  assert.equal(fake.count('/connect/token'), 3);
});

test('token request body is a client_credentials form with the scope; wrong credentials fail without leaking them', { skip }, async () => {
  const { fake, ctx, as, acc } = await liveSetup();
  inv(ctx, as);
  await live.liveSync(ctx, acc);
  const t = fake.st.requests.find((q) => q.path === '/connect/token');
  const f = new URLSearchParams(t.raw);
  assert.equal(f.get('grant_type'), 'client_credentials'); assert.equal(f.get('scope'), 'InvoicingAPI');
  assert.match(t.headers['content-type'], /x-www-form-urlencoded/);

  clearTokenCache();
  tax.setSecret(ctx, as('manager'), 'eta_client_secret', 'WRONG-secret-value-555');
  const out = await live.liveSync(ctx, acc);
  assert.equal(out.error.code, 'ETA_AUTH_FAILED');
  assert.ok(!JSON.stringify(out).includes('WRONG-secret-value-555'));
  assert.ok(!JSON.stringify(ctx.db.prepare('SELECT * FROM tax_live_log').all()).includes('WRONG-secret-value-555'));
});

test('rejection at submission: document becomes rejected with ETA code, reason and fix hint; reissue then succeeds', { skip }, async () => {
  const { fake, ctx, as, acc } = await liveSetup();
  inv(ctx, as);
  const [d] = docs(ctx, as);
  fake.st.rejectInternalIds.add(d.number);
  const out = await live.liveSync(ctx, acc);
  assert.equal(out.rejected, 1);
  const r = row(ctx, d.id);
  assert.equal(r.status, 'rejected'); assert.equal(r.reject_code, 'BadItemCode');
  assert.match(r.reject_reason, /Item code is not registered/); assert.match(r.fix_hint, /reissue/i);
  fake.st.rejectInternalIds.clear();
  const re = tax.reissueDocument(ctx, acc, d.id); // sync part: new document queued
  assert.equal(re.status, 'queued');
  await live.liveSync(ctx, acc);
  assert.equal(row(ctx, re.id).status, 'submitted');
  assert.equal(tax.verifyChain(ctx, acc).ok, true);
});

test('invalid at status poll: validation steps become the rejection reason; receiver rejection and authority cancel are mapped', { skip }, async () => {
  const { fake, ctx, as, acc } = await liveSetup();
  inv(ctx, as); inv(ctx, as); inv(ctx, as);
  await live.liveSync(ctx, acc);
  const [c, b, a] = docs(ctx, as);
  fake.st.docs.get(a.uuid).status = 'Invalid';
  fake.st.docs.get(a.uuid).errors = [{ step: 'ItemCodeCheck', code: 'E101', message: 'code unknown' }];
  fake.st.docs.get(b.uuid).status = 'Rejected';
  fake.st.docs.get(c.uuid).status = 'Cancelled';
  const out = await live.liveSync(ctx, acc);
  assert.equal(out.rejected, 2);
  assert.equal(row(ctx, a.id).reject_code, 'E101'); assert.match(row(ctx, a.id).reject_reason, /ItemCodeCheck: code unknown/);
  assert.equal(row(ctx, b.id).reject_code, 'RECEIVER_REJECTED');
  assert.equal(row(ctx, c.id).status, 'cancelled');
});

test('429 with Retry-After is honoured, then succeeds; plain 503 uses exponential backoff', { skip }, async () => {
  const { fake, ctx, as, acc, sleeps } = await liveSetup();
  inv(ctx, as);
  fake.st.script.push({ match: (q) => q.path.endsWith('/documentsubmissions'), status: 429, headers: { 'retry-after': '2' }, body: { error: 'slow down' } });
  fake.st.script.push({ match: (q) => q.path.endsWith('/documentsubmissions'), status: 503, body: {} });
  fake.st.script.push({ match: (q) => q.path.endsWith('/documentsubmissions'), status: 503, body: {} });
  const out = await live.liveSync(ctx, acc);
  assert.equal(out.submitted, 1);
  assert.deepEqual(sleeps, [2000, 20, 40]); // Retry-After wins on attempt 0, then backoff * 2^attempt
});

test('rate limit that never clears: documents stay queued, last error recorded, nothing is lost', { skip }, async () => {
  const { fake, ctx, as, acc, sleeps } = await liveSetup({ config: { maxRetries: 2 } });
  inv(ctx, as);
  for (let i = 0; i < 5; i++) fake.st.script.push({ match: (q) => q.path.endsWith('/documentsubmissions'), status: 429, headers: { 'retry-after': '1' }, body: {} });
  const out = await live.liveSync(ctx, acc);
  assert.equal(out.error.code, 'TAX_UNREACHABLE'); assert.equal(out.stillQueued, 1);
  assert.equal(sleeps.length, 2);
  const [d] = docs(ctx, as);
  assert.equal(d.status, 'queued');
  assert.match(live.liveDocument(ctx, acc, d.id).last_error, /rate limit/);
  assert.equal(live.liveDocument(ctx, acc, d.id).last_http_status, 429);
  fake.st.script.length = 0;
  assert.equal((await live.liveSync(ctx, acc)).submitted, 1); // recovers on the next sync
});

test('network down: stays queued; a lost response is recovered because a duplicate submission is treated as already submitted', { skip }, async () => {
  const { fake, ctx, as, acc } = await liveSetup({ config: { maxRetries: 1 } });
  inv(ctx, as);
  const [d] = docs(ctx, as);
  await fake.close(); fakes.splice(fakes.indexOf(fake), 1);
  const down = await live.liveSync(ctx, acc);
  assert.equal(down.error.code, 'TAX_UNREACHABLE');
  assert.equal(row(ctx, d.id).status, 'queued');
  // a new server that already knows the document (response of the first attempt was lost)
  const fake2 = await startFakeEta(); fakes.push(fake2);
  live.updateLiveConfig(ctx, as('manager'), { idUrl: fake2.idUrl, apiUrl: fake2.apiUrl });
  fake2.st.duplicateInternalIds.add(d.number);
  fake2.st.docs.set(d.uuid, { status: 'Valid', longId: 'LONG-X', errors: [], internalId: d.number });
  const out = await live.liveSync(ctx, acc);
  assert.equal(out.submitted, 1);
  assert.equal(row(ctx, d.id).status, 'submitted');
  assert.equal((await live.liveSync(ctx, acc)).valid, 1);
});

test('batching: documents go out in batches of the configured size with mixed accept/reject results', { skip }, async () => {
  const { fake, ctx, as, acc } = await liveSetup({ config: { batchSize: 2 } });
  inv(ctx, as); inv(ctx, as); inv(ctx, as);
  const all = docs(ctx, as);
  fake.st.rejectInternalIds.add(all[1].number);
  const out = await live.liveSync(ctx, acc);
  assert.equal(fake.count('/api/v1.0/documentsubmissions'), 2);
  assert.deepEqual(fake.st.submissions.map((s) => s.docs.length), [2, 1]);
  assert.equal(out.submitted, 2); assert.equal(out.rejected, 1);
  assert.equal(row(ctx, all[1].id).status, 'rejected');
});

test('a batch refused as a whole is retried document by document', { skip }, async () => {
  const { fake, ctx, as, acc } = await liveSetup({ config: { batchSize: 5 } });
  inv(ctx, as); inv(ctx, as);
  fake.st.script.push({ match: (q) => q.path.endsWith('/documentsubmissions'), status: 400, body: { error: { code: 'BadStructure', message: 'nope' } } });
  const out = await live.liveSync(ctx, acc);
  assert.equal(out.submitted, 2);
  assert.deepEqual(fake.st.submissions.map((s) => s.docs.length), [1, 1]);
});

test('cancel: ETA is asked first, then the document is cancelled locally with audit; ETA refusal leaves it untouched; window respected', { skip }, async () => {
  const { fake, ctx, as, acc } = await liveSetup();
  inv(ctx, as); inv(ctx, as);
  await live.liveSync(ctx, acc);
  const [b, a] = docs(ctx, as);
  const local = (id, reason) => () => tax.cancelDocument(ctx, acc, id, reason);
  const done = await live.liveCancel(ctx, acc, a.id, 'wrong customer', local(a.id, 'wrong customer'));
  assert.equal(done.status, 'cancelled');
  assert.deepEqual(fake.st.stateCalls, [{ uuid: a.uuid, status: 'cancelled', reason: 'wrong customer' }]);
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'tax.document_cancelled'").get());

  fake.st.stateStatus = 400;
  await assert.rejects(() => live.liveCancel(ctx, acc, b.id, 'try', local(b.id, 'try')), { code: 'ETA_STATE_REFUSED' });
  assert.equal(row(ctx, b.id).status, 'submitted');

  fake.st.stateStatus = 200; fake.st.stateCalls.length = 0;
  ctx.offsetMs += 73 * HOUR;
  await assert.rejects(() => live.liveCancel(ctx, acc, b.id, 'late', local(b.id, 'late')), { code: 'CANCEL_WINDOW_CLOSED' });
  assert.equal(fake.st.stateCalls.length, 0); // no call is made once the window is closed
  await assert.rejects(() => live.liveCancel(ctx, acc, b.id, ' ', local(b.id, ' ')), { code: 'REASON_REQUIRED' });
});

test('the in-process sync cancel path cannot cancel at ETA behind our back', { skip }, async () => {
  const { ctx, as, acc } = await liveSetup();
  inv(ctx, as);
  await live.liveSync(ctx, acc);
  const [d] = docs(ctx, as);
  expectError(() => tax.cancelDocument(ctx, acc, d.id, 'sneaky'), 'LIVE_ASYNC_REQUIRED');
  assert.equal(row(ctx, d.id).status, 'submitted');
});

test('reject a received document: PUT state rejected with reason; input validated; authority refusal surfaces', { skip }, async () => {
  const { fake, ctx, acc } = await liveSetup();
  const uuid = 'ABCDEF12-3456-7890-ABCD-EF1234567890';
  const r = await live.liveReject(ctx, acc, { uuid, reason: 'Wrong amount' });
  assert.equal(r.status, 'rejected');
  assert.deepEqual(fake.st.stateCalls, [{ uuid, status: 'rejected', reason: 'Wrong amount' }]);
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'tax.live_reject' AND reason = 'Wrong amount'").get());
  await assert.rejects(() => live.liveReject(ctx, acc, { uuid: '../x', reason: 'r' }), { code: 'BAD_INPUT' });
  await assert.rejects(() => live.liveReject(ctx, acc, { uuid, reason: '' }), { code: 'REASON_REQUIRED' });
  fake.st.stateStatus = 400;
  await assert.rejects(() => live.liveReject(ctx, acc, { uuid, reason: 'again' }), { code: 'ETA_STATE_REFUSED' });
});

test('configuration: https required except loopback, validated, audited, permission-gated; changing the target resets the test flag', { skip }, async () => {
  const { fake, ctx, as } = await liveSetup();
  const mgr = as('manager');
  expectError(() => live.updateLiveConfig(ctx, mgr, { apiUrl: 'http://eta.example.com/api' }), 'BAD_INPUT');
  expectError(() => live.updateLiveConfig(ctx, mgr, { apiUrl: 'ftp://x' }), 'BAD_INPUT');
  expectError(() => live.updateLiveConfig(ctx, mgr, { apiUrl: 'https://user:pw@eta.example.com' }), 'BAD_INPUT');
  expectError(() => live.updateLiveConfig(ctx, mgr, { batchSize: 0 }), 'BAD_INPUT');
  expectError(() => live.updateLiveConfig(ctx, mgr, { nonsense: 1 }), 'BAD_INPUT');
  expectError(() => live.updateLiveConfig(ctx, mgr, {}), 'BAD_INPUT');
  expectError(() => live.updateLiveConfig(ctx, as('accountant'), { batchSize: 3 }), 'FORBIDDEN');
  expectError(() => live.getLiveConfig(ctx, as('clerk')), 'FORBIDDEN');
  const c = live.updateLiveConfig(ctx, mgr, { apiUrl: 'https://api.preprod.invoicing.eta.gov.eg/api/v1.0/', onBehalfOf: '123456789' });
  assert.equal(c.apiUrl, 'https://api.preprod.invoicing.eta.gov.eg/api/v1.0');
  assert.equal(c.unverified, true);
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'tax.live_config'").get());
  await live.liveTest(ctx, mgr).catch(() => {});
  live.updateLiveConfig(ctx, mgr, { apiUrl: fake.apiUrl });
  assert.equal(live.getLiveConfig(ctx, mgr).lastTestOkAt, null);
});

test('connection test: token + signer probe; success is remembered and unlocks the wizard sandbox step; failure clears it', { skip }, async () => {
  const { fake, ctx, as } = await liveSetup();
  const mgr = as('manager');
  for (const s of ['tax_number', 'erp_registered', 'secrets']) tax.completeStep(ctx, mgr, s, s === 'tax_number' ? { registrationNumber: '123456789' } : s === 'erp_registered' ? { confirm: true } : {});
  expectError(() => tax.completeStep(ctx, mgr, 'sandbox_test'), 'SANDBOX_FAILED'); // not tested yet
  const t = await live.liveTest(ctx, mgr);
  assert.deepEqual(t, { ok: true, token: true, signer: 'pem' });
  assert.equal(tax.completeStep(ctx, mgr, 'sandbox_test').steps.find((s) => s.step === 'sandbox_test').done, true);
  tax.setSecret(ctx, mgr, 'eta_client_secret', 'changed-so-auth-fails');
  clearTokenCache();
  await assert.rejects(() => live.liveTest(ctx, mgr), { code: 'ETA_AUTH_FAILED' });
  assert.equal(live.getLiveConfig(ctx, mgr).lastTestOkAt, null);
  assert.equal(fake.count('/connect/token'), 2);
});

test('not configured: live documents stay queued and /api/tax/sync still completes the rest with a clear message', { skip }, async () => {
  clearTokenCache();
  const { ctx, as } = setup();
  tax.updateSettings(ctx, as('manager'), { adapter: 'eta_live' });
  inv(ctx, as);
  const acc = as('accountant');
  await assert.rejects(() => live.liveSync(ctx, acc), { code: 'LIVE_NOT_CONFIGURED' });
  const { server, call } = await startApp(createApp, ctx);
  try {
    const r = await call('POST', '/api/tax/sync', 4);
    assert.equal(r.status, 201);
    assert.equal(r.body.live.error.code, 'LIVE_NOT_CONFIGURED');
    assert.equal(docs(ctx, as)[0].status, 'queued');
  } finally { server.close(); }
});

test('signer problems: SIGNER_NOT_CONFIGURED is raised and the document is untouched', { skip }, async () => {
  const { ctx, as, acc } = await liveSetup({ signer: false });
  inv(ctx, as);
  await assert.rejects(() => live.liveSync(ctx, acc), { code: 'SIGNER_NOT_CONFIGURED' });
  assert.equal(docs(ctx, as)[0].status, 'queued');
});

test('a pluggable signer (HSM style) is used and its CMS value is what goes on the wire', { skip }, async () => {
  const { fake, ctx, as, acc } = await liveSetup({ signer: false, config: { signer: 'unit_hsm' } });
  const seen = [];
  registerSigner('unit_hsm', async () => ({ id: 'unit_hsm', sign: async ({ canonical }) => { seen.push(canonical); return 'SIGNED-BY-HSM'; } }));
  inv(ctx, as);
  await live.liveSync(ctx, acc);
  assert.equal(fake.st.submissions[0].docs[0].signatures[0].value, 'SIGNED-BY-HSM');
  assert.match(seen[0], /^"ISSUER""ADDRESS"/);
  assert.ok(!seen[0].includes('SIGNATURES'));
});

test('concurrent syncs: the second returns busy instead of double-submitting', { skip }, async () => {
  const { fake, ctx, as, acc } = await liveSetup();
  inv(ctx, as);
  const [a, b] = await Promise.all([live.liveSync(ctx, acc), live.liveSync(ctx, acc)]);
  assert.equal([a, b].filter((x) => x.busy).length, 1);
  assert.equal(fake.st.submissions.length, 1);
});

test('permissions: sync, cancel, reject need tax.submit; test and config need tax.configure; log needs tax.view', { skip }, async () => {
  const { ctx, as } = await liveSetup();
  await assert.rejects(() => live.liveSync(ctx, as('auditor')), { code: 'FORBIDDEN' });
  await assert.rejects(() => live.liveSync(ctx, as('clerk')), { code: 'FORBIDDEN' });
  await assert.rejects(() => live.liveCancel(ctx, as('auditor'), 1, 'x', () => {}), { code: 'FORBIDDEN' });
  await assert.rejects(() => live.liveReject(ctx, as('auditor'), { uuid: 'abcdefgh', reason: 'x' }), { code: 'FORBIDDEN' });
  await assert.rejects(() => live.liveTest(ctx, as('accountant')), { code: 'FORBIDDEN' });
  assert.ok(Array.isArray(live.liveLog(ctx, as('auditor'))));
  expectError(() => live.liveLog(ctx, as('clerk')), 'FORBIDDEN');
});

test('secrets never appear in audit rows, the live log, settings, responses, exports or error text', { skip }, async () => {
  const { fake, ctx, as, acc } = await liveSetup();
  inv(ctx, as);
  const logs = []; const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => logs.push(a.join(' '));
  let sync, ex;
  try {
    sync = await live.liveSync(ctx, acc);
    clearTokenCache(); fake.st.script.push({ match: (q) => q.path === '/connect/token', status: 400, body: { error: `bad ${fake.clientSecret}` } });
    const failed = await live.liveSync(ctx, acc);
    sync = [sync, failed];
    ex = tax.exportDocuments(ctx, acc);
  } finally { Object.assign(console, orig); }
  const needles = [fake.clientSecret, 'PRIVATE KEY', identity.certPem.split('\n')[1]];
  const haystack = JSON.stringify([
    ctx.db.prepare('SELECT * FROM audit_log').all(), ctx.db.prepare('SELECT * FROM tax_live_log').all(), ctx.db.prepare('SELECT * FROM tax_live_docs').all(),
    ctx.db.prepare('SELECT * FROM settings').all(), live.getLiveConfig(ctx, as('manager')), tax.getSettings(ctx, as('manager')), tax.listSecrets(ctx, as('manager')),
    sync, ex, logs, ctx.db.prepare('SELECT * FROM tax_documents').all(),
  ]);
  for (const n of needles) assert.ok(!haystack.includes(n), `leaked: ${n.slice(0, 12)}`);
  assert.ok(!ctx.registry.exportTables.includes('tax_secrets'));
});

test('HTTP: sync/test/config/log routes work end to end and are summarised for OpenAPI', { skip }, async () => {
  const { fake, ctx, as } = await liveSetup();
  inv(ctx, as);
  const { server, call } = await startApp(createApp, ctx);
  try {
    assert.equal((await call('GET', '/api/tax/live/config', 3)).status, 403); // clerk
    assert.equal((await call('POST', '/api/tax/live/test', 4)).status, 403);  // accountant lacks tax.configure
    const t = await call('POST', '/api/tax/live/test', 2);
    assert.equal(t.status, 201); assert.equal(t.body.ok, true);
    const s = await call('POST', '/api/tax/sync', 4);
    assert.equal(s.body.live.submitted, 1);
    const [d] = docs(ctx, as);
    fake.st.docs.get(d.uuid).status = 'Valid';
    assert.equal((await call('POST', '/api/tax/live/sync', 4)).body.valid, 1);
    const one = await call('GET', `/api/tax/live/documents/${d.id}`, 5);
    assert.match(one.body.share_url, /\/share\/LONG-/);
    const c = await call('POST', `/api/tax/documents/${d.id}/cancel`, 4, { reason: 'duplicate' });
    assert.equal(c.body.status, 'cancelled');
    assert.equal(fake.st.stateCalls.length, 1);
    const log = await call('GET', '/api/tax/live/log', 5);
    assert.ok(log.body.some((l) => l.op === 'submit' && l.outcome === 'ok'));
    assert.equal((await call('PUT', '/api/tax/live/config', 2, { batchSize: 5 })).body.batchSize, 5);
    assert.equal((await call('GET', '/api/tax/adapters', 5)).body.find((a) => a.id === 'eta_live').live, true);
  } finally { server.close(); }
});

test('mock adapters are unaffected: the default flow still validates synchronously and makes no network call', async () => {
  const { ctx, as } = setup();
  inv(ctx, as);
  assert.equal(docs(ctx, as)[0].adapter, 'eta_mock');
  tax.syncDocuments(ctx, as('accountant'));
  assert.equal(docs(ctx, as)[0].status, 'valid');
  assert.equal((await live.liveSync(ctx, as('accountant'))).polled, 0); // nothing live: returns without needing configuration
});
