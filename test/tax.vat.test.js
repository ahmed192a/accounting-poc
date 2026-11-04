import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError } from './helpers.js';
import * as tax from '../src/modules/tax/service.js';
import * as sales from '../src/modules/sales/service.js';
import * as purchases from '../src/modules/purchases/service.js';
import { accountBalance, setPeriodLock, trialBalance } from '../src/ledger.js';

const P = { from: '2000-01-01', to: '2999-12-31' };
const bigBill = (ctx, as) => purchases.createBill(ctx, as('clerk'), { supplier: 'Delta Supplies', amount: 300000, category: 'purchases' }); // pending approval

test('VAT return maths: output VAT from 2100, input VAT from 1400, net payable', () => {
  const { ctx, as } = setup();
  const i = sales.createInvoice(ctx, as('clerk'), { customer: 'A', lines: [{ description: 'Rice 1kg', qty: 10, unitPrice: 3200 }] });
  const q = sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'TEA-250', qty: 2 }] });
  const b = bigBill(ctx, as);
  tax.recordBillVat(ctx, as('accountant'), b.id, { vat: 36842, supplierTaxId: '555666777', invoiceRef: 'S-1' });
  purchases.approveBill(ctx, as('manager'), b.id);
  const r = tax.vatReturn(ctx, as('accountant'), P);
  assert.equal(r.outputVat, i.vat + q.sale.vat);
  assert.equal(r.inputVat, 36842);
  assert.equal(r.netPayable, i.vat + q.sale.vat - 36842);
  assert.equal(r.taxableSales, i.subtotal + q.sale.subtotal);
  assert.equal(r.unverified, true);
  assert.match(r.notice, /UNVERIFIED/);
  assert.equal(trialBalance(ctx.db).balanced, true);
});

test('VAT return respects the period and shows a refund when input exceeds output', () => {
  const { ctx, as } = setup();
  const b = bigBill(ctx, as);
  tax.recordBillVat(ctx, as('accountant'), b.id, { vat: 30000 });
  purchases.approveBill(ctx, as('manager'), b.id);
  const r = tax.vatReturn(ctx, as('accountant'), P);
  assert.equal(r.netPayable, -30000);
  assert.equal(r.refund, true);
  assert.equal(tax.vatReturn(ctx, as('accountant'), { from: '1999-01-01', to: '1999-12-31' }).inputVat, 0);
  expectError(() => tax.vatReturn(ctx, as('accountant'), { from: '2025-02-01', to: '2025-01-01' }), 'BAD_DATE');
  expectError(() => tax.vatReturn(ctx, as('accountant'), { from: 'x', to: 'y' }), 'BAD_DATE');
});

test('bill.approved posts input VAT only when VAT info exists', () => {
  const { ctx, as } = setup();
  const a = bigBill(ctx, as), b = bigBill(ctx, as);
  tax.recordBillVat(ctx, as('accountant'), a.id, { vat: 36842 });
  assert.equal(accountBalance(ctx.db, '1400').net, 0); // pending bill: nothing posted yet
  purchases.approveBill(ctx, as('manager'), a.id);
  assert.equal(accountBalance(ctx.db, '1400').net, 36842);
  assert.equal(accountBalance(ctx.db, '5000').net, 300000 - 36842); // reclassified out of the expense
  purchases.approveBill(ctx, as('manager'), b.id); // no VAT info recorded
  assert.equal(accountBalance(ctx.db, '1400').net, 36842);
  assert.equal(tax.vatReturn(ctx, as('accountant'), P).billsWithoutVatInfo.length, 1);
});

test('VAT recorded on an already approved (auto-approved) bill posts immediately', () => {
  const { ctx, as } = setup();
  const b = purchases.createBill(ctx, as('clerk'), { supplier: 'Small', amount: 11400, category: 'utilities' });
  assert.equal(b.status, 'approved');
  const r = tax.recordBillVat(ctx, as('accountant'), b.id, { vat: 1400 });
  assert.equal(r.posted, true);
  assert.equal(accountBalance(ctx.db, '1400').net, 1400);
  assert.equal(accountBalance(ctx.db, '5200').net, 10000);
  expectError(() => tax.recordBillVat(ctx, as('accountant'), b.id, { vat: 1400 }), 'ALREADY_RECORDED');
});

test('bill VAT validation: whole piastres, below the amount, zero rate means zero VAT, known rate', () => {
  const { ctx, as } = setup();
  const b = bigBill(ctx, as);
  for (const vat of [-1, 1.5, 300000, '5']) expectError(() => tax.recordBillVat(ctx, as('accountant'), b.id, { vat }), 'BAD_INPUT');
  expectError(() => tax.recordBillVat(ctx, as('accountant'), b.id, { vat: 100, rateCode: 'zero' }), 'BAD_INPUT');
  expectError(() => tax.recordBillVat(ctx, as('accountant'), b.id, { vat: 100, rateCode: 'nope' }), 'BAD_INPUT');
  expectError(() => tax.recordBillVat(ctx, as('accountant'), 9999, { vat: 100 }), 'NOT_FOUND');
  expectError(() => tax.recordBillVat(ctx, as('accountant'), b.id, { vat: 100, supplierTaxId: '!' }), 'BAD_INPUT');
  assert.equal(tax.recordBillVat(ctx, as('accountant'), b.id, { vat: 0, rateCode: 'exempt' }).posted, false);
});

test('atomic: a locked period makes the approval (and its VAT posting) roll back together', () => {
  const { ctx, as } = setup();
  const b = bigBill(ctx, as);
  tax.recordBillVat(ctx, as('accountant'), b.id, { vat: 36842 });
  setPeriodLock(ctx, 1, '2999-12-31', 'hard', 'test lock');
  expectError(() => purchases.approveBill(ctx, as('manager'), b.id), 'PERIOD_LOCKED');
  assert.equal(ctx.db.prepare('SELECT status FROM bills WHERE id = ?').get(b.id).status, 'pending_approval');
  assert.equal(ctx.db.prepare('SELECT entry_id FROM tax_bill_tax WHERE bill_id = ?').get(b.id).entry_id, null);
});

test('rates: standard flagged UNVERIFIED, zero and exempt fixed at 0, changes audited', () => {
  const { ctx, as } = setup();
  const rates = tax.listRates(ctx, as('auditor'));
  assert.deepEqual(rates.map((r) => r.code), ['exempt', 'standard', 'zero']);
  assert.equal(rates.find((r) => r.code === 'standard').unverified, true);
  assert.equal(rates.find((r) => r.code === 'standard').rateBp, 1400);
  expectError(() => tax.setRate(ctx, as('manager'), 'zero', { rateBp: 500 }), 'BAD_INPUT');
  const r = tax.setRate(ctx, as('manager'), 'standard', { rateBp: 1300, verified: true });
  assert.equal(r.unverified, false);
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'tax.vat_rate'").get());
  expectError(() => tax.setRate(ctx, as('accountant'), 'standard', { rateBp: 1 }), 'FORBIDDEN');
});

test('turnover tax estimate uses configurable bands and always carries the estimate notice', () => {
  const { ctx, as } = setup();
  sales.createInvoice(ctx, as('clerk'), { customer: 'A', lines: [{ description: 'Rice 1kg', qty: 100, unitPrice: 10000 }] }); // 10,000 EGP turnover
  const e = tax.turnoverEstimate(ctx, as('accountant'), P);
  assert.equal(e.turnover, 1000000);
  assert.equal(e.estimate, true);
  assert.match(e.notice, /ESTIMATE ONLY/);
  assert.match(e.notice, /UNVERIFIED/);
  assert.equal(e.estimatedTax, 4000); // first placeholder band: 0.40%
  tax.setTurnoverBands(ctx, as('manager'), [{ upTo: 500000, rateBp: 100 }, { upTo: null, rateBp: 200, fixed: 1000 }]);
  assert.equal(tax.turnoverEstimate(ctx, as('accountant'), P).estimatedTax, 1000 + 20000);
  expectError(() => tax.setTurnoverBands(ctx, as('manager'), [{ upTo: 5, rateBp: 1 }, { upTo: 3, rateBp: 1 }]), 'BAD_INPUT');
  expectError(() => tax.setTurnoverBands(ctx, as('manager'), [{ upTo: null, rateBp: 1 }, { upTo: 3, rateBp: 1 }]), 'BAD_INPUT');
});

test('withholding tax is a placeholder: zero until configured', () => {
  const { ctx, as } = setup();
  assert.equal(tax.withholding(ctx, as('auditor')).placeholder, true);
  assert.equal(tax.withholdingFor(ctx.db, 'services', 100000).amount, 0);
  tax.setWithholding(ctx, as('manager'), { services: 500 });
  assert.equal(tax.withholdingFor(ctx.db, 'services', 100000).amount, 5000);
  expectError(() => tax.setWithholding(ctx, as('manager'), { services: 20000 }), 'BAD_INPUT');
});

test('VAT permissions: only tax.vat_return can prepare returns or record bill VAT', () => {
  const { ctx, as } = setup();
  const b = bigBill(ctx, as);
  expectError(() => tax.vatReturn(ctx, as('auditor'), P), 'FORBIDDEN');
  expectError(() => tax.recordBillVat(ctx, as('auditor'), b.id, { vat: 100 }), 'FORBIDDEN');
  expectError(() => tax.turnoverEstimate(ctx, as('admin'), P), 'FORBIDDEN');
  assert.ok(tax.vatReturn(ctx, as('manager'), P));
});
