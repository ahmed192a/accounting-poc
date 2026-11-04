import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createSign, createPrivateKey, X509Certificate } from 'node:crypto';
import { canonicalString, buildCms, certParts, registerSigner, resolveSigner, signerIds } from '../src/modules/tax/adapters/eta_sign.js';
import etaLive from '../src/modules/tax/adapters/eta_live.js';
import { setup, expectError } from './helpers.js';
import * as tax from '../src/modules/tax/service.js';
import { HAVE_OPENSSL, makeIdentity } from './etalive.fixtures.js';

const opts = { skip: !HAVE_OPENSSL && 'openssl CLI not available' };

test('canonicalString: upper-case names, quoted values, array names repeated, signatures dropped, order kept', () => {
  const s = canonicalString({ issuer: { id: '1', name: 'A' }, lines: [{ q: 1 }, { q: 2 }], total: 5.5, signatures: [{ value: 'x' }], empty: null });
  assert.equal(s, '"ISSUER""ID""1""NAME""A""LINES""LINES""Q""1""LINES""Q""2""TOTAL""5.5""EMPTY""null"');
  assert.ok(!s.includes('SIGNATURES'));
  assert.equal(canonicalString({ b: 1, a: 2 }), '"B""1""A""2"'); // not sorted
});

test('buildDocument (live): decimal pounds, document type, no signature or version yet, pure', () => {
  const n = {
    kind: 'credit_note', number: 'CN-0001', uuid: 'u-1', issuedAt: '2026-01-02T03:04:05.678Z',
    seller: { taxId: '100200300', name: 'S', address: 'Cairo' }, buyer: { name: 'B', taxId: null },
    lines: [{ sku: 'X', description: 'Tea', qty: 2, unitPrice: 4500, net: 9000, vat: 1260, code: 'EG-1', codeType: 'EGS' }],
    totals: { net: 9000, vat: 1260, total: 10260 }, vatRateBp: 1400, vatRateCode: 'standard', refUuid: 'orig',
  };
  const a = etaLive.buildDocument(n), b = etaLive.buildDocument(n);
  assert.deepEqual(a, b);
  assert.equal(a.documentType, 'C');
  assert.equal(a.dateTimeIssued, '2026-01-02T03:04:05Z');
  assert.equal(a.totalAmount, 102.6);
  assert.equal(a.invoiceLines[0].unitValue.amountEGP, 45);
  assert.equal(a.invoiceLines[0].taxableItems[0].rate, 14);
  assert.deepEqual(a.references, ['orig']);
  assert.equal(a.receiver.type, 'P');
  assert.ok(!('signatures' in a) && !('documentTypeVersion' in a));
});

for (const kind of ['rsa', 'ec']) {
  test(`CMS (${kind}): independent verification with openssl, content attached`, opts, async () => {
    const { keyPem, certPem } = makeIdentity(kind);
    const key = createPrivateKey(keyPem), cert = new X509Certificate(certPem);
    const content = canonicalString({ a: 'x', lines: [{ n: 1 }] });
    const b64 = await buildCms({ content, certDer: cert.raw, keyType: kind, now: Date.UTC(2026, 0, 2, 3, 4, 5), signRaw: async (b) => createSign('sha256').update(b).sign(key) });
    const dir = mkdtempSync(join(tmpdir(), 'cms-'));
    try {
      writeFileSync(join(dir, 's.der'), Buffer.from(b64, 'base64'));
      const r = spawnSync('openssl', ['cms', '-verify', '-inform', 'DER', '-in', join(dir, 's.der'), '-noverify', '-binary', '-out', join(dir, 'out.txt')], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const parsed = spawnSync('openssl', ['cms', '-cmsout', '-inform', 'DER', '-in', join(dir, 's.der'), '-print'], { encoding: 'utf8' }).stdout;
      assert.match(parsed, /signingTime/i);
      assert.match(parsed, /id-smime-aa-signingCertificateV2|signingCertificateV2/i);
      assert.match(parsed, /sha256/i);
      assert.equal(spawnSync('cat', [join(dir, 'out.txt')], { encoding: 'utf8' }).stdout, content);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('CMS: detached form verifies against the separate content; tampered content fails', opts, async () => {
  const { keyPem, certPem } = makeIdentity('rsa');
  const key = createPrivateKey(keyPem), cert = new X509Certificate(certPem);
  const content = 'hello';
  const b64 = await buildCms({ content, certDer: cert.raw, detached: true, now: 1_800_000_000_000, signRaw: async (b) => createSign('sha256').update(b).sign(key) });
  const dir = mkdtempSync(join(tmpdir(), 'cms-'));
  try {
    writeFileSync(join(dir, 's.der'), Buffer.from(b64, 'base64')); writeFileSync(join(dir, 'c.txt'), content); writeFileSync(join(dir, 'bad.txt'), 'hellp');
    const v = (f) => spawnSync('openssl', ['cms', '-verify', '-inform', 'DER', '-in', join(dir, 's.der'), '-content', join(dir, f), '-noverify', '-binary', '-out', '/dev/null'], { encoding: 'utf8' }).status;
    assert.equal(v('c.txt'), 0);
    assert.notEqual(v('bad.txt'), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('certParts extracts the issuer name and serial from a certificate', opts, () => {
  const { certPem } = makeIdentity('rsa');
  const cert = new X509Certificate(certPem);
  const p = certParts(cert.raw);
  assert.equal(p.serial[0], 0x02);
  assert.equal(p.issuer[0], 0x30);
  assert.ok(p.issuer.includes(Buffer.from('TEST ONLY etalive')));
  assert.equal(createHash('sha256').update(cert.raw).digest('hex'), cert.fingerprint256.replaceAll(':', '').toLowerCase());
});

test('signers: pluggable registry; the PEM signer refuses missing, mismatched or unreadable material without echoing it', opts, async () => {
  const { ctx, as } = setup();
  registerSigner('test_hsm', async () => ({ id: 'test_hsm', sign: async ({ canonical }) => `HSM:${canonical}` }));
  assert.ok(signerIds().includes('pem') && signerIds().includes('test_hsm'));
  assert.equal((await (await resolveSigner(ctx, 'test_hsm')).sign({ canonical: 'abc' })), 'HSM:abc');
  await assert.rejects(() => resolveSigner(ctx, 'nope'), { code: 'SIGNER_NOT_CONFIGURED' });
  await assert.rejects(() => resolveSigner(ctx, 'pem'), { code: 'SIGNER_NOT_CONFIGURED' }); // nothing stored yet
  const a = makeIdentity('rsa'), b = makeIdentity('rsa');
  tax.setSecret(ctx, as('manager'), 'eta_signing_key_pem', a.keyPem);
  tax.setSecret(ctx, as('manager'), 'eta_signing_cert_pem', b.certPem);
  await assert.rejects(() => resolveSigner(ctx, 'pem'), (e) => e.code === 'SIGNER_NOT_CONFIGURED' && /does not match/.test(e.message) && !e.message.includes('PRIVATE'));
  tax.setSecret(ctx, as('manager'), 'eta_signing_key_pem', 'not a pem at all');
  await assert.rejects(() => resolveSigner(ctx, 'pem'), (e) => e.code === 'SIGNER_NOT_CONFIGURED' && !e.message.includes('not a pem'));
  tax.setSecret(ctx, as('manager'), 'eta_signing_key_pem', a.keyPem);
  tax.setSecret(ctx, as('manager'), 'eta_signing_cert_pem', a.certPem);
  const signer = await resolveSigner(ctx, 'pem');
  const out = await signer.sign({ canonical: 'x', now: ctx.now() });
  assert.match(out, /^[A-Za-z0-9+/=]+$/);
  expectError(() => tax.setSecret(ctx, as('manager'), 'eta_signing_key_pem', 'x'.repeat(20001)), 'BAD_INPUT');
});
