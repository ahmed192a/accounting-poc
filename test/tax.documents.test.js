import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError } from './helpers.js';
import * as tax from '../src/modules/tax/service.js';
import * as sales from '../src/modules/sales/service.js';
import * as etaSvc from '../src/modules/eta/service.js';
import { decodeTlv } from '../src/modules/tax/adapters/zatca_mock.js';
import { GENESIS } from '../src/modules/tax/util.js';

const HOUR = 3600 * 1000;
const inv = (ctx, as, over = {}) => sales.createInvoice(ctx, as('clerk'), {
  customer: 'Acme Foods', lines: [{ description: 'Black tea 250g', qty: 2, unitPrice: 4500 }, { description: 'Rice 1kg', qty: 1, unitPrice: 3200 }], ...over,
});
const docs = (ctx, as) => tax.listDocuments(ctx, as('accountant'));

test('an invoice creates a chained e-invoice document with ids, item codes, tax totals, uuid and QR', () => {
  const { ctx, as } = setup();
  const r = inv(ctx, as);
  const [d] = docs(ctx, as);
  assert.equal(d.number, r.number);
  assert.equal(d.status, 'submitted'); // online: accepted by the mock, validation comes on the next sync
  assert.equal(d.prev_hash, GENESIS);
  assert.match(d.uuid, /^[0-9a-f-]{36}$/);
  const full = tax.getDocument(ctx, as('accountant'), d.id);
  assert.equal(full.payload.mock, true);
  assert.equal(full.payload.issuer.id, '100200300');
  assert.equal(full.payload.invoiceLines[0].itemCode, 'EGS-EG-100200-TEA250');
  assert.equal(full.payload.taxTotals[0].amount, r.vat);
  assert.equal(full.payload.invoiceLines.reduce((s, l) => s + l.taxableItems[0].amount, 0), r.vat); // line VAT sums exactly
  assert.equal(full.payload.totalAmount, r.total);
  assert.ok(d.qr.startsWith('ETA-MOCK|'));
  assert.ok(d.retain_until > '2030-01-01'); // 5-year retention flag
});

test('hash chain: each document links to the previous and verification passes', () => {
  const { ctx, as } = setup();
  inv(ctx, as); inv(ctx, as, { customer: 'Beta' });
  const [b, a] = docs(ctx, as);
  assert.equal(b.prev_hash, a.hash);
  assert.deepEqual(tax.verifyChain(ctx, as('auditor')), { ok: true, checked: 2, head: b.hash });
});

test('tamper detection: editing a stored document, or removing one, is detected', () => {
  const { ctx, as } = setup();
  inv(ctx, as); inv(ctx, as); inv(ctx, as);
  // The database itself refuses to edit or delete documents...
  assert.throws(() => ctx.db.prepare("UPDATE tax_documents SET total = 1 WHERE seq = 2").run(), /immutable/);
  assert.throws(() => ctx.db.prepare('DELETE FROM tax_documents WHERE seq = 2').run(), /retention/);
  // ...so tamper by bypassing the triggers, as an attacker with file access would.
  ctx.db.exec('DROP TRIGGER tax_documents_immutable');
  const row = ctx.db.prepare('SELECT payload FROM tax_documents WHERE seq = 2').get();
  ctx.db.prepare('UPDATE tax_documents SET payload = ? WHERE seq = 2').run(row.payload.replace('"totalAmount":', '"totalAmount":1'));
  const bad = tax.verifyChain(ctx, as('auditor'));
  assert.equal(bad.ok, false);
  assert.equal(bad.brokenAtSeq, 2);
  assert.match(bad.reason, /altered/);

  const { ctx: c2, as: as2 } = setup();
  inv(c2, as2); inv(c2, as2); inv(c2, as2);
  c2.db.exec('DROP TRIGGER tax_documents_no_delete');
  c2.db.prepare('DELETE FROM tax_documents WHERE seq = 2').run();
  const gap = tax.verifyChain(c2, as2('auditor'));
  assert.equal(gap.ok, false);
  assert.match(gap.reason, /gap/);
});

test('state machine: queued -> submitted -> valid; invalid moves are refused', () => {
  const { ctx, as } = setup();
  etaSvc.etaSetOnline(ctx, as('manager'), false);
  inv(ctx, as);
  const [d] = docs(ctx, as);
  assert.equal(d.status, 'queued');
  assert.equal(d.attempts, 1);
  etaSvc.etaSetOnline(ctx, as('manager'), true);
  const r = tax.syncDocuments(ctx, as('accountant'));
  assert.equal(r.submitted, 1);
  assert.equal(tax.getDocument(ctx, as('accountant'), d.id).status, 'valid'); // polled in the same sync
  expectError(() => tax.retryDocument(ctx, as('accountant'), d.id), 'BAD_TRANSITION'); // valid cannot be retried
  tax.cancelDocument(ctx, as('accountant'), d.id, 'wrong customer');
  expectError(() => tax.cancelDocument(ctx, as('accountant'), d.id, 'again'), 'BAD_TRANSITION');
  assert.equal(tax.getDocument(ctx, as('accountant'), d.id).status, 'cancelled');
});

test('offline: the invoice still posts, the document waits, retry and sync submit it', () => {
  const { ctx, as } = setup();
  etaSvc.etaSetOnline(ctx, as('manager'), false);
  const r = inv(ctx, as);
  assert.ok(r.id);
  const [d] = docs(ctx, as);
  assert.equal(tax.retryDocument(ctx, as('accountant'), d.id).status, 'queued'); // still offline
  etaSvc.etaSetOnline(ctx, as('manager'), true);
  assert.equal(tax.retryDocument(ctx, as('accountant'), d.id).status, 'valid');
});

test('rejection carries a reason and fix hint; fixing the code and reissuing chains a new valid document', () => {
  const { ctx, as } = setup();
  inv(ctx, as, { lines: [{ description: 'Loose spices (no item code yet)', qty: 1, unitPrice: 2500 }] });
  tax.syncDocuments(ctx, as('accountant'));
  const [d] = docs(ctx, as);
  assert.equal(d.status, 'rejected');
  assert.equal(d.reject_code, 'ITEM_CODE_MISSING');
  assert.match(d.fix_hint, /Map the items/);
  assert.equal(tax.dashboard(ctx, as('manager')).rejected, 1);

  tax.setItemCode(ctx, as('manager'), 'SPICE-LOOSE', 'EG-100200-SPICE1');
  const re = tax.reissueDocument(ctx, as('accountant'), d.id);
  assert.equal(re.replaces, d.id);
  tax.syncDocuments(ctx, as('accountant'));
  assert.equal(tax.getDocument(ctx, as('accountant'), re.id).status, 'valid');
  const old = tax.getDocument(ctx, as('accountant'), d.id);
  assert.equal(old.superseded, true);
  assert.equal(tax.dashboard(ctx, as('manager')).rejected, 0); // superseded rejections no longer count
  assert.equal(tax.verifyChain(ctx, as('auditor')).ok, true);
  expectError(() => tax.reissueDocument(ctx, as('accountant'), d.id), 'ALREADY_REISSUED');
});

test('cancellation window follows the demo clock and the configured hours', () => {
  const { ctx, as } = setup();
  inv(ctx, as);
  tax.syncDocuments(ctx, as('accountant'));
  const [d] = docs(ctx, as);
  assert.equal(d.canCancel, true);
  ctx.offsetMs += 71 * HOUR;
  assert.equal(docs(ctx, as)[0].canCancel, true);
  ctx.offsetMs += 2 * HOUR; // 73 h after validation: window (72 h default) closed
  assert.equal(docs(ctx, as)[0].canCancel, false);
  expectError(() => tax.cancelDocument(ctx, as('accountant'), d.id, 'too late'), 'CANCEL_WINDOW_CLOSED');
  tax.updateSettings(ctx, as('manager'), { cancelWindowHours: 200 }); // configurable
  assert.equal(tax.cancelDocument(ctx, as('accountant'), d.id, 'ok now').status, 'cancelled');
  expectError(() => tax.cancelDocument(ctx, as('accountant'), d.id, ' '), 'REASON_REQUIRED');
});

test('credit note: full reversal by default, over-crediting refused, defensive hook payloads work', () => {
  const { ctx, as } = setup();
  const r = inv(ctx, as);
  const [d] = docs(ctx, as);
  const n = tax.createNote(ctx, as('accountant'), { documentId: d.id, kind: 'credit_note', reason: 'returned goods' });
  const note = tax.getDocument(ctx, as('accountant'), n.id);
  assert.equal(note.kind, 'credit_note');
  assert.equal(note.total, r.total);
  assert.equal(note.ref_document_id, d.id);
  assert.equal(note.payload.documentType, 'C');
  assert.deepEqual(note.payload.references, [d.uuid]);
  expectError(() => tax.createNote(ctx, as('accountant'), { documentId: d.id, kind: 'credit_note', reason: 'again' }), 'OVER_CREDIT');
  const dn = tax.createNote(ctx, as('accountant'), { documentId: d.id, kind: 'debit_note', reason: 'freight', lines: [{ description: 'Freight', qty: 1, unitPrice: 1000 }] });
  assert.match(dn.number, /^DN-/);
  // hook shaped like a probable sales payload; nonsense payloads are ignored, not fatal
  assert.equal(tax.onCreditNoteCreated(ctx, { nothing: true }), null);
  const id = tax.onCreditNoteCreated(ctx, { creditNote: { id: 9, invoiceId: r.id, lines: [{ description: 'Rice 1kg', qty: 1, unitPrice: 3200 }] }, userId: 1 });
  assert.equal(tax.getDocument(ctx, as('auditor'), id).kind, 'credit_note');
});

test('atomic: if the tax hook fails the invoice and its ledger entry roll back', () => {
  const { ctx, as } = setup();
  ctx.db.prepare("UPDATE settings SET value = 'nope_adapter' WHERE key = 'tax_adapter'").run();
  const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n;
  expectError(() => inv(ctx, as), 'UNKNOWN_ADAPTER');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, before);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM tax_documents').get().n, 0);
});

test('adapter swap: ZATCA mock builds its own format and a TLV base64 QR; old documents keep their adapter', () => {
  const { ctx, as } = setup();
  inv(ctx, as);
  tax.updateSettings(ctx, as('manager'), { adapter: 'zatca_mock', registrationNumber: '300000000000003' });
  const r = inv(ctx, as);
  const [z, e] = docs(ctx, as);
  assert.equal(e.adapter, 'eta_mock');
  assert.equal(z.adapter, 'zatca_mock');
  const f = tax.getDocument(ctx, as('auditor'), z.id);
  assert.equal(f.payload.format, 'ZATCA-MOCK-UNVERIFIED-1');
  const tlv = decodeTlv(z.qr);
  assert.equal(tlv[1], 'Demo Trading Co. (demo data)');
  assert.equal(tlv[2], '300000000000003');
  assert.equal(tlv[4], `${Math.trunc(r.total / 100)}.${String(r.total % 100).padStart(2, '0')}`);
  assert.equal(tlv[5], `${Math.trunc(r.vat / 100)}.${String(r.vat % 100).padStart(2, '0')}`);
  tax.syncDocuments(ctx, as('accountant'));
  assert.deepEqual(docs(ctx, as).map((d) => d.status), ['valid', 'valid']); // each polled through its own adapter
  expectError(() => tax.updateSettings(ctx, as('manager'), { adapter: 'real_eta' }), 'UNKNOWN_ADAPTER');
});

test('ZATCA mock rejects a 9-digit seller number with a fix hint; buyer id is required above the threshold', () => {
  const { ctx, as } = setup();
  tax.updateSettings(ctx, as('manager'), { adapter: 'zatca_mock' });
  inv(ctx, as);
  tax.syncDocuments(ctx, as('accountant'));
  assert.equal(docs(ctx, as)[0].reject_code, 'SELLER_VAT_FORMAT_ZATCA');
  tax.updateSettings(ctx, as('manager'), { adapter: 'eta_mock' });
  sales.createInvoice(ctx, as('clerk'), { customer: 'Big Buyer', lines: [{ description: 'Black tea 250g', qty: 2000, unitPrice: 4500 }] });
  tax.syncDocuments(ctx, as('accountant'));
  assert.equal(docs(ctx, as)[0].reject_code, 'BUYER_TAX_ID_REQUIRED');
  tax.setParty(ctx, as('manager'), 'Big Buyer', '123456789');
  const re = tax.reissueDocument(ctx, as('accountant'), docs(ctx, as)[0].id);
  tax.syncDocuments(ctx, as('accountant'));
  assert.equal(tax.getDocument(ctx, as('auditor'), re.id).status, 'valid');
});

test('dashboard counts queued, due soon, overdue, rejected and last sync (documents plus e-receipts)', () => {
  const { ctx, as } = setup();
  etaSvc.etaSetOnline(ctx, as('manager'), false);
  inv(ctx, as);
  sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'TEA-250', qty: 1 }] }); // a queued e-receipt
  let d = tax.dashboard(ctx, as('auditor'));
  assert.equal(d.queued, 2); assert.equal(d.dueSoon, 0); assert.equal(d.overdue, 0); assert.equal(d.lastSync, null);
  ctx.offsetMs += 21 * HOUR;
  assert.equal(tax.dashboard(ctx, as('auditor')).dueSoon, 2);
  ctx.offsetMs += 4 * HOUR;
  d = tax.dashboard(ctx, as('auditor'));
  assert.equal(d.overdue, 2);
  tax.syncDocuments(ctx, as('accountant'));
  assert.ok(tax.dashboard(ctx, as('auditor')).lastSync);
});

test('export lists submitted documents with the chain status; permissions are enforced', () => {
  const { ctx, as } = setup();
  inv(ctx, as);
  const ex = tax.exportDocuments(ctx, as('auditor'));
  assert.equal(ex.documents.length, 1);
  assert.equal(ex.chain.ok, true);
  assert.equal(ex.mock, true);
  expectError(() => tax.dashboard(ctx, as('clerk')), 'FORBIDDEN');
  expectError(() => tax.syncDocuments(ctx, as('auditor')), 'FORBIDDEN');
  expectError(() => tax.cancelDocument(ctx, as('auditor'), 1, 'x'), 'FORBIDDEN');
  expectError(() => tax.updateSettings(ctx, as('accountant'), { retentionYears: 7 }), 'FORBIDDEN');
  expectError(() => tax.getDocument(ctx, as('manager'), 999), 'NOT_FOUND');
});
