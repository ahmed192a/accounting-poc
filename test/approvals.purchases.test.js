import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError } from './helpers.js';
import * as p from '../src/modules/purchases/service.js';
import * as sup from '../src/modules/purchases/suppliers.js';
import * as po from '../src/modules/purchases/orders.js';
import * as pay from '../src/modules/purchases/payments.js';
import * as rep from '../src/modules/purchases/reports.js';
import * as att from '../src/modules/purchases/attachments.js';
import * as rec from '../src/modules/purchases/recurring.js';
import { accountBalance, isoDate } from '../src/ledger.js';

const EGP = 100, DAY = 86400000;
const approved = (ctx, as, egp, extra = {}) => {
  const b = p.createBill(ctx, as('clerk'), { supplier: 'Delta Trading', amount: egp * EGP, category: 'purchases', ...extra });
  if (b.status === 'pending_approval') p.approveBill(ctx, as('manager'), b.id);
  return b.id;
};
const status = (ctx, id) => ctx.db.prepare('SELECT status, paid FROM bills WHERE id = ?').get(id);

test('suppliers: CRUD, tax id, terms, duplicates and permissions', () => {
  const { ctx, as } = setup();
  const s = sup.createSupplier(ctx, as('accountant'), { name: 'Cairo Paper', taxId: '123-456-789', paymentTermsDays: 45, email: 'a@b.eg' });
  expectError(() => sup.createSupplier(ctx, as('clerk'), { name: 'X' }), 'FORBIDDEN');
  expectError(() => sup.createSupplier(ctx, as('accountant'), { name: 'cairo paper' }), 'DUPLICATE_SUPPLIER');
  expectError(() => sup.createSupplier(ctx, as('accountant'), { name: 'Y', taxId: '!!' }), 'BAD_TAX_ID');
  expectError(() => sup.createSupplier(ctx, as('accountant'), { name: 'Y', paymentTermsDays: -1 }), 'BAD_INPUT');
  sup.updateSupplier(ctx, as('accountant'), s.id, { paymentTermsDays: 60 });
  assert.equal(sup.getSupplier(ctx, as('auditor'), s.id).payment_terms_days, 60);
  expectError(() => sup.updateSupplier(ctx, as('auditor'), s.id, { name: 'Z' }), 'FORBIDDEN');
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'supplier.created'").get());
});

test('bill status flow: draft -> submit -> approved -> partially_paid -> paid; due date from terms', () => {
  const { ctx, as } = setup();
  const d = p.createBill(ctx, as('clerk'), { supplier: 'Delta Trading', amount: 4000 * EGP, category: 'purchases', draft: true });
  assert.equal(d.status, 'draft');
  assert.equal(accountBalance(ctx.db, '2000').net, 0);
  expectError(() => p.submitBill(ctx, as('manager'), d.id), 'FORBIDDEN');
  assert.equal(p.submitBill(ctx, as('clerk'), d.id).status, 'pending_approval');
  expectError(() => p.submitBill(ctx, as('clerk'), d.id), 'NOT_DRAFT');
  p.approveBill(ctx, as('manager'), d.id);
  const bill = ctx.db.prepare('SELECT * FROM bills WHERE id = ?').get(d.id);
  assert.equal(bill.due_date, isoDate(ctx.now() + 30 * DAY)); // Delta Trading: 30 days
  pay.paySupplier(ctx, as('accountant'), { supplier: 'Delta Trading', amount: 1000 * EGP });
  assert.equal(status(ctx, d.id).status, 'partially_paid');
  pay.paySupplier(ctx, as('accountant'), { supplier: 'Delta Trading', amount: 3000 * EGP });
  assert.equal(status(ctx, d.id).status, 'paid');
});

test('small assist-free bills still auto-approve and post (original behaviour)', () => {
  const { ctx, as } = setup();
  const b = p.createBill(ctx, as('clerk'), { supplier: 'Cleaner', amount: 500 * EGP, category: 'utilities' });
  assert.equal(b.status, 'approved');
  assert.ok(b.entryId);
  assert.equal(accountBalance(ctx.db, '5200').net, 500 * EGP);
});

test('bill VAT posts to 1400 and the entry balances', () => {
  const { ctx, as } = setup();
  const id = approved(ctx, as, 2280, { vat: 280 * EGP });
  assert.equal(accountBalance(ctx.db, '1400').net, 280 * EGP);
  assert.equal(accountBalance(ctx.db, '5000').net, 2000 * EGP);
  assert.equal(accountBalance(ctx.db, '2000').net, -2280 * EGP);
  expectError(() => p.createBill(ctx, as('clerk'), { supplier: 'S', amount: 100, vat: 100, category: 'rent' }), 'BAD_INPUT');
  assert.ok(id);
});

test('3-way match: exact bill matches, variances need an override reason, qty tracked', () => {
  const { ctx, as } = setup();
  const order = po.createPurchaseOrder(ctx, as('clerk'), { supplier: 'Delta Trading', lines: [{ description: 'Paper', qty: 10, unitPrice: 200 * EGP }] });
  const line = po.getPurchaseOrder(ctx, as('clerk'), order.id).lines[0];
  const base = { supplier: 'Delta Trading', poId: order.id, category: 'purchases' };
  // price variance
  const e = (() => { try { p.createBill(ctx, as('clerk'), { ...base, lines: [{ description: 'Paper', qty: 4, unitPrice: 250 * EGP, poLineId: line.id }] }); } catch (x) { return x; } })();
  assert.equal(e.code, 'MATCH_VARIANCE');
  assert.equal(e.extra.variances[0].kind, 'price');
  // matched partial bill
  const b1 = p.createBill(ctx, as('clerk'), { ...base, lines: [{ description: 'Paper', qty: 4, unitPrice: 200 * EGP, poLineId: line.id }] });
  assert.equal(p.getBill(ctx, as('clerk'), b1.id).match_status, 'matched');
  assert.equal(po.getPurchaseOrder(ctx, as('clerk'), order.id).status, 'partially_billed');
  // over-billing the ordered quantity
  expectError(() => p.createBill(ctx, as('clerk'), { ...base, lines: [{ description: 'Paper', qty: 7, unitPrice: 200 * EGP, poLineId: line.id }] }), 'MATCH_VARIANCE');
  const b2 = p.createBill(ctx, as('clerk'), { ...base, lines: [{ description: 'Paper', qty: 7, unitPrice: 200 * EGP, poLineId: line.id }], matchOverrideReason: 'Supplier sent extra' });
  assert.equal(p.getBill(ctx, as('clerk'), b2.id).match_status, 'override');
  // wrong supplier
  expectError(() => p.createBill(ctx, as('clerk'), { supplier: 'Nile Office Supplies', poId: order.id, category: 'purchases', lines: [{ description: 'x', qty: 1, unitPrice: 1, poLineId: line.id }] }), 'PO_SUPPLIER_MISMATCH');
});

test('3-way match: receipts cap billing, rejecting a bill frees the PO quantity', () => {
  const { ctx, as } = setup();
  const order = po.createPurchaseOrder(ctx, as('clerk'), { supplier: 'Delta Trading', lines: [{ description: 'Chairs', qty: 10, unitPrice: 300 * EGP }] });
  const line = po.getPurchaseOrder(ctx, as('clerk'), order.id).lines[0];
  po.receivePurchaseOrder(ctx, as('clerk'), order.id, { lines: [{ lineId: line.id, qty: 5 }] });
  expectError(() => po.receivePurchaseOrder(ctx, as('clerk'), order.id, { lines: [{ lineId: line.id, qty: 6 }] }), 'OVER_RECEIPT');
  const mk = (qty) => ({ supplier: 'Delta Trading', poId: order.id, category: 'purchases', lines: [{ description: 'Chairs', qty, unitPrice: 300 * EGP, poLineId: line.id }] });
  expectError(() => p.createBill(ctx, as('clerk'), mk(6)), 'MATCH_VARIANCE'); // only 5 received
  const b = p.createBill(ctx, as('clerk'), mk(5));
  assert.equal(b.status, 'pending_approval'); // 1,500 EGP
  p.rejectBill(ctx, as('manager'), b.id, { reason: 'Damaged' });
  assert.equal(po.getPurchaseOrder(ctx, as('clerk'), order.id).lines[0].billed_qty, 0);
  assert.equal(po.getPurchaseOrder(ctx, as('clerk'), order.id).status, 'open');
  expectError(() => po.cancelPurchaseOrder(ctx, as('clerk'), order.id, ''), 'BAD_INPUT');
  po.cancelPurchaseOrder(ctx, as('clerk'), order.id, 'No longer needed');
  expectError(() => p.createBill(ctx, as('clerk'), mk(1)), 'PO_CANCELLED');
});

test('payments: partial, allocated oldest-due-first, explicit allocation, overpayment refused', () => {
  const { ctx, as } = setup();
  const a = approved(ctx, as, 2000), b = approved(ctx, as, 3000);
  expectError(() => pay.paySupplier(ctx, as('clerk'), { supplier: 'Delta Trading', amount: 100 }), 'FORBIDDEN');
  const r1 = pay.paySupplier(ctx, as('accountant'), { supplier: 'Delta Trading', amount: 2500 * EGP });
  assert.deepEqual(r1.allocations.map((x) => [x.billId, x.amount]), [[a, 2000 * EGP], [b, 500 * EGP]]);
  assert.equal(status(ctx, a).status, 'paid');
  assert.equal(status(ctx, b).status, 'partially_paid');
  expectError(() => pay.paySupplier(ctx, as('accountant'), { supplier: 'Delta Trading', amount: 3000 * EGP }), 'OVERPAYMENT');
  expectError(() => pay.paySupplier(ctx, as('accountant'), { supplier: 'Delta Trading', amount: 100, allocations: [{ billId: a, amount: 100 }] }), 'NOT_PAYABLE'); // a is already settled
  expectError(() => pay.paySupplier(ctx, as('accountant'), { supplier: 'Delta Trading', amount: 100, allocations: [{ billId: b, amount: 50 }] }), 'ALLOCATION_MISMATCH');
  pay.paySupplier(ctx, as('accountant'), { supplier: 'Delta Trading', amount: 2500 * EGP, allocations: [{ billId: b, amount: 2500 * EGP }] });
  assert.equal(status(ctx, b).status, 'paid');
  assert.equal(accountBalance(ctx.db, '2000').net, 0);
  assert.equal(accountBalance(ctx.db, '1000').net, 1000000 - 5000 * EGP);
});

test('payments: atomic on failure, method availability, limit, void by reversal', () => {
  const { ctx, as } = setup();
  const a = approved(ctx, as, 2000);
  const before = ctx.db.prepare('SELECT COUNT(*) n FROM journal_entries').get().n;
  expectError(() => pay.paySupplier(ctx, as('accountant'), { supplier: 'Delta Trading', amount: 100, allocations: [{ billId: a, amount: 100 }, { billId: 9999, amount: 1 }] }), 'ALLOCATION_MISMATCH');
  expectError(() => pay.paySupplier(ctx, as('accountant'), { supplier: 'Delta Trading', amount: 101, allocations: [{ billId: a, amount: 100 }, { billId: 9999, amount: 1 }] }), 'NOT_FOUND');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM journal_entries').get().n, before);
  assert.equal(status(ctx, a).paid, 0);
  expectError(() => pay.paySupplier(ctx, as('accountant'), { supplier: 'Delta Trading', amount: 100, method: 'cheque' }), 'BAD_INPUT');
  expectError(() => pay.paySupplier(ctx, as('manager'), { supplier: 'Delta Trading', amount: 30000 * EGP }), 'OVER_LIMIT');
  const r = pay.paySupplier(ctx, as('accountant'), { supplier: 'Delta Trading', amount: 2000 * EGP });
  expectError(() => p.voidBill(ctx, as('manager'), a, { reason: 'x' }), 'HAS_PAYMENTS');
  pay.voidPayment(ctx, as('accountant'), r.id, { reason: 'Bounced' });
  assert.equal(status(ctx, a).status, 'approved');
  assert.equal(accountBalance(ctx.db, '2000').net, -2000 * EGP);
  expectError(() => pay.voidPayment(ctx, as('accountant'), r.id, { reason: 'again' }), 'ALREADY_VOID');
});

test('void: pending bill cancels its approval; posted bill is reversed', () => {
  const { ctx, as } = setup();
  const pend = p.createBill(ctx, as('clerk'), { supplier: 'S', amount: 3000 * EGP, category: 'rent' });
  expectError(() => p.voidBill(ctx, as('manager'), pend.id, {}), 'BAD_INPUT');
  p.voidBill(ctx, as('manager'), pend.id, { reason: 'Duplicate' });
  assert.equal(ctx.db.prepare("SELECT status FROM approvals_requests WHERE doc_id = ?").get(pend.id).status, 'cancelled');
  const posted = approved(ctx, as, 2000);
  const v = p.voidBill(ctx, as('owner'), posted, { reason: 'Mistake' });
  assert.ok(v.reversalEntryId);
  assert.equal(accountBalance(ctx.db, '2000').net, 0);
  expectError(() => p.voidBill(ctx, as('owner'), posted, { reason: 'again' }), 'ALREADY_CLOSED');
});

test('supplier statement has a running balance and AP aging buckets by due date', () => {
  const { ctx, as } = setup();
  const sid = ctx.db.prepare("SELECT id FROM purchases_suppliers WHERE name = 'Delta Trading'").get().id;
  const t = (n) => isoDate(ctx.now() + n * DAY);
  const old = approved(ctx, as, 2000, { billDate: t(-100), dueDate: t(-70) });
  approved(ctx, as, 3000, { billDate: t(-10), dueDate: t(-5) });
  approved(ctx, as, 1500, { billDate: t(0), dueDate: t(20) });
  pay.paySupplier(ctx, as('accountant'), { supplier: 'Delta Trading', amount: 500 * EGP, allocations: [{ billId: old, amount: 500 * EGP }], paidDate: t(-1) });
  const st = rep.supplierStatement(ctx, as('accountant'), sid, {});
  assert.deepEqual(st.rows.map((r) => r.type), ['bill', 'bill', 'payment', 'bill']);
  assert.equal(st.closing, (2000 + 3000 + 1500 - 500) * EGP);
  assert.equal(st.closing, -accountBalance(ctx.db, '2000').net);
  assert.equal(rep.supplierStatement(ctx, as('accountant'), sid, { from: t(-20) }).opening, 2000 * EGP);
  const ag = rep.apAging(ctx, as('auditor'), {});
  assert.equal(ag.totals.d61_90, 1500 * EGP);
  assert.equal(ag.totals.d1_30, 3000 * EGP);
  assert.equal(ag.totals.current, 1500 * EGP);
  assert.equal(ag.totals.total, 6000 * EGP);
  expectError(() => rep.apAging(ctx, as('auditor'), { asOf: '2026-13-40' }), 'BAD_DATE');
});

test('attachments: stored as blobs, size limit, MIME allow-list, content sniffing, export view', () => {
  const { ctx, as } = setup();
  const id = approved(ctx, as, 2000);
  const pdf = Buffer.from('%PDF-1.4 test').toString('base64');
  const a = att.addAttachment(ctx, as('clerk'), id, { filename: '../../evil/inv 1.pdf', mime: 'application/pdf', contentBase64: pdf });
  const got = att.getAttachment(ctx, as('auditor'), id, a.id);
  assert.equal(got.filename, 'inv 1.pdf');
  assert.equal(Buffer.from(got.contentBase64, 'base64').toString(), '%PDF-1.4 test');
  assert.equal(got.sha256, a.sha256);
  expectError(() => att.addAttachment(ctx, as('clerk'), id, { filename: 'a.exe', mime: 'application/x-msdownload', contentBase64: pdf }), 'MIME_NOT_ALLOWED');
  expectError(() => att.addAttachment(ctx, as('clerk'), id, { filename: 'a.pdf', mime: 'application/pdf', contentBase64: Buffer.from('MZ not a pdf').toString('base64') }), 'CONTENT_MISMATCH');
  expectError(() => att.addAttachment(ctx, as('clerk'), id, { filename: 'a.txt', mime: 'text/plain', contentBase64: Buffer.alloc(600 * 1024, 65).toString('base64') }), 'FILE_TOO_LARGE');
  expectError(() => att.addAttachment(ctx, as('clerk'), id, { filename: 'a.txt', mime: 'text/plain', contentBase64: '***' }), 'BAD_INPUT');
  expectError(() => att.addAttachment(ctx, as('auditor'), id, { filename: 'a.pdf', mime: 'application/pdf', contentBase64: pdf }), 'FORBIDDEN');
  const row = ctx.db.prepare('SELECT data_hex FROM purchases_attachments_export').get();
  assert.equal(row.data_hex, Buffer.from('%PDF-1.4 test').toString('hex').toUpperCase());
});

test('recurring bills: generated on demand, catch-up, month-end clamp, goes through approval', () => {
  const { ctx, as } = setup();
  const start = isoDate(ctx.now() - 70 * DAY);
  rec.createRecurring(ctx, as('clerk'), { supplier: 'Landlord Co', amount: 4000 * EGP, category: 'rent', frequency: 'monthly', startDate: start });
  expectError(() => rec.runRecurring(ctx, as('auditor')), 'FORBIDDEN');
  const out = rec.runRecurring(ctx, as('clerk'));
  assert.ok(out.created.length >= 3);
  assert.ok(out.created.every((c) => c.status === 'pending_approval')); // 4,000 EGP is above the auto-approve threshold
  assert.equal(rec.runRecurring(ctx, as('clerk')).created.length, 0); // idempotent
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM bills WHERE source = 'recurring'").get().n, out.created.length);
  const rows = rec.listRecurring(ctx, as('clerk'));
  rec.stopRecurring(ctx, as('clerk'), rows[0].id);
  assert.equal(rec.listRecurring(ctx, as('clerk'))[0].active, 0);
  expectError(() => rec.createRecurring(ctx, as('clerk'), { supplier: 'x', amount: 1, category: 'rent', frequency: 'daily', startDate: start }), 'BAD_INPUT');
});

test('permission denials across purchases routes', () => {
  const { ctx, as } = setup();
  expectError(() => p.listBills(ctx, as('admin')), 'FORBIDDEN');
  expectError(() => po.createPurchaseOrder(ctx, as('auditor'), { supplier: 'x', lines: [{ description: 'a', qty: 1, unitPrice: 1 }] }), 'FORBIDDEN');
  expectError(() => rep.apAging(ctx, as('admin'), {}), 'FORBIDDEN');
  expectError(() => p.voidBill(ctx, as('clerk'), 1, { reason: 'x' }), 'FORBIDDEN');
});
