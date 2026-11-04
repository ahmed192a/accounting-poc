import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError, startApp } from './helpers.js';
import { createApp } from '../src/server.js';
import * as tax from '../src/modules/tax/service.js';
import * as etaSvc from '../src/modules/eta/service.js';
import { readSecret } from '../src/modules/tax/secrets.js';
import { gs1CheckDigitOk } from '../src/modules/tax/codes.js';

const SECRET = 'super-secret-client-value-123';

test('secrets: stored encrypted, round-trip server-side, never returned, never audited', () => {
  const { ctx, as } = setup();
  tax.setSecret(ctx, as('manager'), 'eta_client_secret', SECRET);
  const raw = ctx.db.prepare('SELECT * FROM tax_secrets').get();
  assert.ok(!JSON.stringify(raw).includes(SECRET));
  assert.equal(readSecret(ctx.db, 'eta_client_secret'), SECRET);
  const listed = tax.listSecrets(ctx, as('manager'));
  assert.ok(!JSON.stringify(listed).includes(SECRET));
  assert.equal(listed.find((s) => s.name === 'eta_client_secret').set, true);
  assert.equal(listed.find((s) => s.name === 'eta_client_id').set, false);
  for (const view of [tax.getSettings(ctx, as('manager')), tax.dashboard(ctx, as('manager')), tax.wizardView(ctx, as('manager'))]) assert.ok(!JSON.stringify(view).includes(SECRET));
  assert.ok(!JSON.stringify(ctx.db.prepare('SELECT * FROM audit_log').all()).includes(SECRET));
  // the shared export list must not include the secrets table
  assert.ok(!ctx.registry.exportTables.includes('tax_secrets'));
});

test('secrets: encryption is authenticated (tampered ciphertext fails) and permission-gated', () => {
  const { ctx, as } = setup();
  tax.setSecret(ctx, as('manager'), 'eta_client_id', 'abc');
  ctx.db.prepare("UPDATE tax_secrets SET ciphertext = 'AAAA' WHERE name = 'eta_client_id'").run();
  assert.throws(() => readSecret(ctx.db, 'eta_client_id'));
  expectError(() => tax.setSecret(ctx, as('accountant'), 'eta_client_id', 'x'), 'FORBIDDEN');
  expectError(() => tax.listSecrets(ctx, as('auditor')), 'FORBIDDEN');
  expectError(() => tax.setSecret(ctx, as('manager'), 'unknown_name', 'x'), 'BAD_INPUT');
  expectError(() => tax.setSecret(ctx, as('manager'), 'eta_client_id', '  '), 'BAD_INPUT');
});

test('secrets are not returned over HTTP either', async () => {
  const { ctx } = setup();
  const { server, call } = await startApp(createApp, ctx);
  try {
    const put = await call('PUT', '/api/tax/secrets/eta_client_secret', 2, { value: SECRET });
    assert.equal(put.status, 200);
    for (const path of ['/api/tax/secrets', '/api/tax/settings', '/api/tax/dashboard', '/api/tax/wizard', '/api/tax/export', '/api/export']) {
      const r = await call('GET', path, path === '/api/export' ? 6 : 2);
      assert.equal(r.status, 200, path);
      assert.ok(!JSON.stringify(r.body).includes(SECRET), path);
    }
    assert.equal((await call('GET', '/api/tax/secrets', 3)).status, 403);
    assert.equal((await call('GET', '/api/tax/dashboard', 3)).status, 403);
    assert.equal((await call('POST', '/api/tax/sync', 5)).status, 403);
    const doc = await call('GET', '/api/tax/documents/12345', 2);
    assert.equal(doc.status, 404);
  } finally { server.close(); }
});

test('wizard: ordered checklist state machine from not_started to live', () => {
  const { ctx, as } = setup();
  const m = as('manager');
  assert.equal(tax.wizardView(ctx, m).state, 'not_started');
  expectError(() => tax.completeStep(ctx, m, 'go_live'), 'STEP_BLOCKED');
  expectError(() => tax.completeStep(ctx, m, 'secrets'), 'STEP_BLOCKED');
  expectError(() => tax.completeStep(ctx, m, 'tax_number', { registrationNumber: '12' }), 'BAD_INPUT');
  tax.completeStep(ctx, m, 'tax_number', { registrationNumber: '123456789' });
  assert.equal(tax.getSettings(ctx, m).registrationNumber, '123456789');
  expectError(() => tax.completeStep(ctx, m, 'erp_registered', {}), 'BAD_INPUT');
  tax.completeStep(ctx, m, 'erp_registered', { confirm: true });
  expectError(() => tax.completeStep(ctx, m, 'secrets'), 'SECRETS_MISSING');
  tax.setSecret(ctx, m, 'eta_client_id', 'id'); tax.setSecret(ctx, m, 'eta_client_secret', 's');
  tax.completeStep(ctx, m, 'secrets');
  etaSvc.etaSetOnline(ctx, m, false);
  expectError(() => tax.completeStep(ctx, m, 'sandbox_test'), 'SANDBOX_FAILED');
  etaSvc.etaSetOnline(ctx, m, true);
  assert.equal(tax.completeStep(ctx, m, 'sandbox_test').state, 'ready');
  assert.equal(tax.getSettings(ctx, m).goLive, false);
  const v = tax.completeStep(ctx, m, 'go_live');
  assert.equal(v.state, 'live');
  assert.equal(tax.getSettings(ctx, m).goLive, true);
  assert.equal(tax.dashboard(ctx, m).wizardState, 'live');
  expectError(() => tax.resetWizard(ctx, m, ''), 'REASON_REQUIRED');
  assert.equal(tax.resetWizard(ctx, m, 'start again').state, 'not_started');
  expectError(() => tax.completeStep(ctx, as('accountant'), 'tax_number', { registrationNumber: '123456789' }), 'FORBIDDEN');
});

test('item codes: format validation (GS1 check digit, EGS pattern) and mapping by sku', () => {
  const { ctx, as } = setup();
  assert.equal(gs1CheckDigitOk('4006381333932'), false);
  assert.equal(gs1CheckDigitOk('4006381333931'), true); // a published GTIN-13 example
  assert.equal(tax.setItemCode(ctx, as('manager'), 'SPICE-LOOSE', '4006381333931').type, 'GS1');
  assert.equal(tax.setItemCode(ctx, as('manager'), 'TEA-250', 'EG-100200-TEA9').type, 'EGS');
  for (const bad of ['4006381333932', 'hello', '', 'EG-1-X']) expectError(() => tax.setItemCode(ctx, as('manager'), 'OIL-1L', bad), 'BAD_CODE');
  expectError(() => tax.setItemCode(ctx, as('manager'), 'NOPE', 'EG-100200-X'), 'UNKNOWN_ITEM');
  const list = tax.listItemCodes(ctx, as('auditor'));
  assert.equal(list.missing, 0);
  assert.equal(list.items.find((i) => i.sku === 'TEA-250').code, 'EG-100200-TEA9'); // own mapping wins over the sales code
  expectError(() => tax.setItemCode(ctx, as('auditor'), 'OIL-1L', 'EG-100200-OIL'), 'FORBIDDEN');
});

test('items without codes are flagged; bulk CSV import is all-or-nothing and reports every bad row', () => {
  const { ctx, as } = setup();
  assert.equal(tax.listItemCodes(ctx, as('auditor')).missing, 1);
  assert.equal(tax.dashboard(ctx, as('auditor')).itemsWithoutCodes, 1);
  const bad = expectError(() => tax.importItemCodes(ctx, as('manager'), 'sku,code\nSPICE-LOOSE,EG-100200-SP\nTEA-250,junk\nGHOST,EG-100200-G'), 'IMPORT_INVALID');
  assert.equal(bad.extra.errors.length, 2);
  assert.equal(tax.listItemCodes(ctx, as('auditor')).missing, 1); // nothing imported
  const ok = tax.importItemCodes(ctx, as('manager'), 'sku,code\r\nSPICE-LOOSE,"EG-100200-SP"\r\nRICE-1K,4006381333931\r\n');
  assert.equal(ok.imported, 2);
  assert.equal(tax.listItemCodes(ctx, as('auditor')).missing, 0);
  expectError(() => tax.importItemCodes(ctx, as('manager'), ''), 'BAD_INPUT');
});

test('settings are validated, audited and swap the active adapter', () => {
  const { ctx, as } = setup();
  expectError(() => tax.updateSettings(ctx, as('manager'), {}), 'BAD_INPUT');
  expectError(() => tax.updateSettings(ctx, as('manager'), { cancelWindowHours: -1 }), 'BAD_INPUT');
  expectError(() => tax.updateSettings(ctx, as('manager'), { unknown: 1 }), 'BAD_INPUT');
  expectError(() => tax.updateSettings(ctx, as('manager'), { retentionYears: 5, regNumberPattern: '(' }), 'BAD_INPUT');
  assert.equal(tax.getSettings(ctx, as('manager')).retentionYears, 5); // a failed update changes nothing
  const s = tax.updateSettings(ctx, as('admin'), { retentionYears: 7, adapter: 'zatca_mock' });
  assert.equal(s.adapter, 'zatca_mock');
  assert.equal(s.mock, true);
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'tax.settings'").get());
});
