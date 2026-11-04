import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError, startApp } from './helpers.js';
import * as sales from '../src/modules/sales/service.js';
import { trialBalance, accountBalance, reverseEntry } from '../src/ledger.js';
import { createApp } from '../src/server.js';

const line = (unitPrice, qty = 1, description = 'Goods') => [{ description, qty, unitPrice }];
const bal = (ctx, code) => accountBalance(ctx.db, code).net;
const status = (ctx, id) => ({ ...ctx.db.prepare('SELECT status, paid, amount_paid, amount_credited FROM invoices WHERE id = ?').get(id) });
const events = (ctx, name) => { const seen = []; ctx.registry.hooks[name] = [...(ctx.registry.hooks[name] ?? []), { module: 'test', fn: (_c, p) => seen.push(p) }]; return seen; };

test('invoice lifecycle: draft has no number or ledger entry until issued, then numbers follow the sequence', () => {
  const { ctx, as } = setup();
  const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n;
  const d = sales.createInvoice(ctx, as('clerk'), { customer: 'Walk-in', lines: line(10000), draft: true });
  assert.deepEqual([d.status, d.number, d.entryId], ['draft', null, null]);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, before);
  sales.updateDraft(ctx, as('clerk'), d.id, { lines: line(20000) });
  expectError(() => sales.payInvoice(ctx, as('clerk'), d.id), 'INVOICE_NOT_OPEN');
  const seen = events(ctx, 'invoice.created');
  const issued = sales.issueInvoice(ctx, as('clerk'), d.id);
  assert.equal(issued.total, 22800);
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['entryId', 'invoice', 'userId']); // payload unchanged
  assert.deepEqual(Object.keys(seen[0].invoice).sort(), ['customer', 'id', 'issueDate', 'lines', 'number', 'subtotal', 'total', 'vat']);
  expectError(() => sales.issueInvoice(ctx, as('clerk'), d.id), 'INVOICE_NOT_DRAFT');
  expectError(() => sales.updateDraft(ctx, as('clerk'), d.id, { lines: line(1) }), 'INVOICE_NOT_DRAFT');
  assert.equal(bal(ctx, '1200'), 22800);
});

test('number sequence is configurable, never goes backwards and never repeats', () => {
  const { ctx, as } = setup();
  expectError(() => sales.updateSettings(ctx, as('clerk'), { sequences: { invoice: { prefix: 'X-' } } }), 'FORBIDDEN');
  const s = sales.updateSettings(ctx, as('manager'), { sequences: { invoice: { prefix: 'EG/', padding: 6, next: 500 } }, businessName: 'Nile Foods' });
  assert.equal(s.businessName, 'Nile Foods');
  const a = sales.createInvoice(ctx, as('clerk'), { customer: 'A', lines: line(100) });
  const b = sales.createInvoice(ctx, as('clerk'), { customer: 'B', lines: line(100) });
  assert.equal(a.number, 'EG/000500');
  assert.equal(b.number, 'EG/000501');
  expectError(() => sales.updateSettings(ctx, as('manager'), { sequences: { invoice: { next: 10 } } }), 'SEQUENCE_BACKWARDS');
  expectError(() => sales.updateSettings(ctx, as('manager'), { sequences: { invoice: { prefix: '<b>' } } }), 'BAD_INPUT');
  expectError(() => sales.updateSettings(ctx, as('manager'), { sequences: { nope: { next: 1 } } }), 'BAD_INPUT');
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'sales.settings_changed'").get());
});

test('partial payments: oldest-first allocation across invoices, statuses and invoice.paid only when fully paid', () => {
  const { ctx, as } = setup();
  const c = sales.listCustomers(ctx, as('clerk'))[0];
  const i1 = sales.createInvoice(ctx, as('clerk'), { customerId: c.id, date: '2026-01-01', dueDate: '2026-01-10', lines: line(10000) }); // 11400
  const i2 = sales.createInvoice(ctx, as('clerk'), { customerId: c.id, date: '2026-01-02', dueDate: '2026-01-20', lines: line(20000) }); // 22800
  const paid = events(ctx, 'invoice.paid');
  const p = sales.recordPayment(ctx, as('clerk'), { customerId: c.id, amount: 15000, reference: 'CHQ-1' });
  assert.deepEqual(p.allocations.map((a) => [a.invoiceId, a.amount, a.status]), [[i1.id, 11400, 'paid'], [i2.id, 3600, 'partially_paid']]);
  assert.equal(paid.length, 1);
  assert.deepEqual(paid[0], { id: i1.id, total: 11400, entryId: p.entryId, userId: 3 });
  assert.deepEqual(status(ctx, i2.id), { status: 'partially_paid', paid: 0, amount_paid: 3600, amount_credited: 0 });
  assert.equal(bal(ctx, '1200'), 34200 - 15000);
  assert.equal(bal(ctx, '1000'), 1000000 + 15000);
  const rest = sales.payInvoice(ctx, as('clerk'), i2.id); // pays the remaining balance only
  assert.equal(ctx.db.prepare('SELECT amount FROM sales_payments WHERE id = ?').get(rest.paymentId).amount, 22800 - 3600);
  assert.deepEqual(status(ctx, i2.id), { status: 'paid', paid: 1, amount_paid: 22800, amount_credited: 0 });
  assert.equal(paid.length, 2);
  expectError(() => sales.payInvoice(ctx, as('clerk'), i2.id), 'ALREADY_PAID');
  assert.equal(bal(ctx, '1200'), 0);
  assert.ok(trialBalance(ctx.db).balanced);
});

test('explicit allocations are validated: totals, balances, duplicates and one customer per payment', () => {
  const { ctx, as } = setup();
  const [a, b] = sales.listCustomers(ctx, as('clerk'));
  const ia = sales.createInvoice(ctx, as('clerk'), { customerId: a.id, lines: line(10000) });
  const ib = sales.createInvoice(ctx, as('clerk'), { customerId: b.id, lines: line(10000) });
  const jBefore = ctx.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n;
  expectError(() => sales.recordPayment(ctx, as('clerk'), { amount: 5000, allocations: [{ invoiceId: ia.id, amount: 4000 }] }), 'ALLOCATION_MISMATCH');
  expectError(() => sales.recordPayment(ctx, as('clerk'), { amount: 99999, allocations: [{ invoiceId: ia.id, amount: 99999 }] }), 'ALLOCATION_EXCEEDS_BALANCE');
  expectError(() => sales.recordPayment(ctx, as('clerk'), { amount: 100, allocations: [{ invoiceId: ia.id, amount: 50 }, { invoiceId: ia.id, amount: 50 }] }), 'BAD_INPUT');
  expectError(() => sales.recordPayment(ctx, as('clerk'), { amount: 200, allocations: [{ invoiceId: ia.id, amount: 100 }, { invoiceId: ib.id, amount: 100 }] }), 'CUSTOMER_MISMATCH');
  expectError(() => sales.recordPayment(ctx, as('clerk'), { amount: 100, customerId: b.id, allocations: [{ invoiceId: ia.id, amount: 100 }] }), 'CUSTOMER_MISMATCH');
  expectError(() => sales.recordPayment(ctx, as('clerk'), { customerId: a.id, amount: 99999999 }), 'OVERPAYMENT');
  expectError(() => sales.recordPayment(ctx, as('clerk'), { amount: 0, customerId: a.id }), 'BAD_INPUT');
  expectError(() => sales.recordPayment(ctx, as('clerk'), { amount: 100 }), 'BAD_INPUT');
  expectError(() => sales.recordPayment(ctx, as('clerk'), { amount: 100, method: 'barter', customerId: a.id }), 'BAD_INPUT');
  expectError(() => sales.recordPayment(ctx, as('auditor'), { amount: 100, customerId: a.id }), 'FORBIDDEN');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, jBefore, 'every refusal left the ledger untouched');
});

test('credit note: reverses revenue and VAT, linked to the invoice, partial allowed', () => {
  const { ctx, as } = setup();
  const inv = sales.createInvoice(ctx, as('clerk'), { customer: 'Cafe Nile', lines: line(4500, 10) }); // 45000 + 6300 = 51300
  const seen = events(ctx, 'credit_note.created');
  const cn = sales.createCreditNote(ctx, as('manager'), inv.id, { lines: line(4500, 4, 'Returned tea'), reason: 'Damaged' }); // net 18000, vat 2520
  assert.deepEqual([cn.subtotal, cn.vat, cn.total], [18000, 2520, 20520]);
  assert.match(cn.number, /^CN-\d{4}$/);
  assert.equal(bal(ctx, '4000'), -(45000 - 18000));
  assert.equal(bal(ctx, '2100'), -(6300 - 2520));
  assert.equal(bal(ctx, '1200'), 51300 - 20520);
  assert.equal(cn.invoiceStatus, 'issued');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].creditNote.invoiceId, inv.id);
  assert.equal(seen[0].voided, false);
  const detail = sales.getInvoice(ctx, as('auditor'), inv.id);
  assert.equal(detail.creditNotes.length, 1);
  assert.equal(detail.balance, 51300 - 20520);
  assert.equal(sales.getCreditNote(ctx, as('auditor'), cn.id).lines[0].description, 'Returned tea');
  assert.ok(trialBalance(ctx.db).balanced);
});

test('credit notes can never exceed the invoiced amount and the last one takes the exact VAT remainder', () => {
  const { ctx, as } = setup();
  const inv = sales.createInvoice(ctx, as('clerk'), { customer: 'Odd Cents', lines: line(3333, 3) }); // net 9999, vat 1400 (1399.86), total 11399
  assert.equal(inv.vat, 1400);
  const m = as('manager');
  const c1 = sales.createCreditNote(ctx, m, inv.id, { amount: 3333, reason: 'one' });
  const c2 = sales.createCreditNote(ctx, m, inv.id, { amount: 3333, reason: 'two' });
  const err = expectError(() => sales.createCreditNote(ctx, m, inv.id, { amount: 3334, reason: 'too much' }), 'CREDIT_EXCEEDS_INVOICE');
  assert.equal(err.extra.creditable, 3333);
  const c3 = sales.createCreditNote(ctx, m, inv.id, { amount: 3333, reason: 'last' });
  assert.equal(c1.vat + c2.vat + c3.vat, 1400, 'VAT credited adds up to the invoice VAT exactly');
  assert.equal(c1.total + c2.total + c3.total, inv.total);
  assert.equal(bal(ctx, '4000'), 0);
  assert.equal(bal(ctx, '2100'), 0);
  assert.equal(bal(ctx, '1200'), 0);
  assert.equal(status(ctx, inv.id).status, 'void');
  expectError(() => sales.createCreditNote(ctx, m, inv.id, { amount: 1, reason: 'again' }), 'INVOICE_NOT_CREDITABLE');
  assert.ok(trialBalance(ctx.db).balanced);
});

test('credit note validation and permission: reason, amount, drafts, role and approval limit', () => {
  const { ctx, as } = setup();
  const inv = sales.createInvoice(ctx, as('clerk'), { customer: 'V', lines: line(10000) });
  expectError(() => sales.createCreditNote(ctx, as('clerk'), inv.id, { amount: 100, reason: 'x' }), 'FORBIDDEN');
  expectError(() => sales.createCreditNote(ctx, as('auditor'), inv.id, { amount: 100, reason: 'x' }), 'FORBIDDEN');
  expectError(() => sales.createCreditNote(ctx, as('manager'), inv.id, { amount: 100 }), 'BAD_INPUT');
  expectError(() => sales.createCreditNote(ctx, as('manager'), inv.id, { amount: 0, reason: 'x' }), 'BAD_INPUT');
  expectError(() => sales.createCreditNote(ctx, as('manager'), 9999, { amount: 5, reason: 'x' }), 'NOT_FOUND');
  const draft = sales.createInvoice(ctx, as('clerk'), { customer: 'D', lines: line(100), draft: true });
  expectError(() => sales.createCreditNote(ctx, as('manager'), draft.id, { amount: 5, reason: 'x' }), 'INVOICE_NOT_CREDITABLE');
  const limited = { ...as('accountant'), limits: { 'sales.credit': 1000 } };
  expectError(() => sales.createCreditNote(ctx, limited, inv.id, { amount: 5000, reason: 'big' }), 'CREDIT_LIMIT');
  assert.ok(sales.createCreditNote(ctx, as('accountant'), inv.id, { amount: 500, reason: 'ok' }).id);
});

test('void: unpaid invoice is cancelled by a full credit note; paid ones are refused; drafts just close', () => {
  const { ctx, as } = setup();
  const inv = sales.createInvoice(ctx, as('clerk'), { customer: 'V', lines: line(10000) });
  expectError(() => sales.voidInvoice(ctx, as('clerk'), inv.id, { reason: 'oops' }), 'FORBIDDEN');
  expectError(() => sales.voidInvoice(ctx, as('manager'), inv.id, {}), 'BAD_INPUT');
  const v = sales.voidInvoice(ctx, as('manager'), inv.id, { reason: 'Entered twice' });
  assert.equal(v.status, 'void');
  assert.equal(status(ctx, inv.id).paid, 1, 'a void invoice is closed');
  assert.equal(bal(ctx, '1200'), 0);
  expectError(() => sales.voidInvoice(ctx, as('manager'), inv.id, { reason: 'again' }), 'ALREADY_VOID');
  expectError(() => sales.payInvoice(ctx, as('clerk'), inv.id), 'INVOICE_NOT_OPEN');
  const part = sales.createInvoice(ctx, as('clerk'), { customer: 'P', lines: line(10000) });
  sales.recordPayment(ctx, as('clerk'), { amount: 100, allocations: [{ invoiceId: part.id, amount: 100 }] });
  expectError(() => sales.voidInvoice(ctx, as('manager'), part.id, { reason: 'x' }), 'INVOICE_HAS_PAYMENTS');
  const draft = sales.createInvoice(ctx, as('clerk'), { customer: 'D', lines: line(100), draft: true });
  assert.equal(sales.voidInvoice(ctx, as('clerk'), draft.id, { reason: 'not needed' }).status, 'void');
  assert.ok(trialBalance(ctx.db).balanced);
});

test('a credit note can only be undone through a ledger reversal, which re-opens the invoice', () => {
  const { ctx, as } = setup();
  const inv = sales.createInvoice(ctx, as('clerk'), { customer: 'R', lines: line(10000) });
  const cn = sales.createCreditNote(ctx, as('manager'), inv.id, { amount: 10000, reason: 'return' });
  assert.equal(status(ctx, inv.id).status, 'void');
  assert.throws(() => ctx.db.prepare('UPDATE journal_lines SET debit = 1').run(), /append-only/);
  reverseEntry(ctx, 4, cn.entryId, 'Credit note issued in error');
  assert.equal(ctx.db.prepare('SELECT status FROM sales_credit_notes WHERE id = ?').get(cn.id).status, 'reversed');
  assert.equal(status(ctx, inv.id).status, 'issued');
  assert.equal(bal(ctx, '1200'), 11400);
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'credit_note.reversed'").get());
  // and the invoice can be credited again afterwards
  assert.ok(sales.createCreditNote(ctx, as('manager'), inv.id, { amount: 10000, reason: 'again' }).id);
  assert.ok(trialBalance(ctx.db).balanced);
});

test('reversing a payment in the ledger re-opens the invoice; reversing an invoice with payments is refused atomically', () => {
  const { ctx, as } = setup();
  const inv = sales.createInvoice(ctx, as('clerk'), { customer: 'R', lines: line(10000) });
  const pay = sales.payInvoice(ctx, as('clerk'), inv.id);
  const jBefore = ctx.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n;
  expectError(() => reverseEntry(ctx, 4, inv.entryId, 'wrong'), 'INVOICE_HAS_ACTIVITY');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, jBefore, 'the reversal was rolled back');
  reverseEntry(ctx, 4, pay.entryId, 'Cheque bounced');
  assert.equal(status(ctx, inv.id).status, 'issued');
  assert.equal(ctx.db.prepare('SELECT status FROM sales_payments WHERE id = ?').get(pay.paymentId).status, 'reversed');
  reverseEntry(ctx, 4, inv.entryId, 'Invoice entered in error');
  assert.equal(status(ctx, inv.id).status, 'void');
  assert.ok(trialBalance(ctx.db).balanced);
});

test('print: bilingual, RTL aware, QR placeholder, print stylesheet and escaped user text', () => {
  const { ctx, as } = setup();
  const evil = '<script>alert(1)</script>"&\'';
  const c = sales.createCustomer(ctx, as('manager'), { name: 'Evil <img src=x onerror=alert(1)>', address: evil });
  sales.updateSettings(ctx, as('manager'), { businessName: '<b>Shop</b>' });
  const inv = sales.createInvoice(ctx, as('clerk'), { customerId: c.id, notes: evil, lines: [{ description: evil, qty: 2, unitPrice: 1000 }] });
  const en = sales.printInvoice(ctx, as('auditor'), inv.id, {});
  assert.equal(en.contentType, 'text/html; charset=utf-8');
  assert.match(en.html, /<html lang="en" dir="ltr">/);
  assert.match(en.html, /Tax invoice/);
  assert.match(en.html, /فاتورة ضريبية/);
  assert.match(en.html, /QR placeholder/);
  assert.match(en.html, /Not a valid e-invoice code \(MOCK\)/);
  assert.match(en.html, /@media print/);
  assert.ok(!en.html.includes('<script'), 'no script element in the page');
  assert.ok(!en.html.includes('<img'), 'customer name was escaped');
  assert.ok(!en.html.includes('<b>Shop</b>'));
  assert.ok(en.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&amp;&#39;'));
  assert.match(en.html, /default-src 'none'/);
  const ar = sales.printInvoice(ctx, as('auditor'), inv.id, { lang: 'ar' });
  assert.match(ar.html, /<html lang="ar" dir="rtl">/);
  const draft = sales.createInvoice(ctx, as('clerk'), { customer: 'D', lines: line(100), draft: true });
  assert.match(sales.printInvoice(ctx, as('auditor'), draft.id).html, /DRAFT/);
  expectError(() => sales.printInvoice(ctx, as('admin'), inv.id), 'FORBIDDEN');
});

test('http: print, payments and credit notes over the API with permission denials', async () => {
  const { ctx } = setup();
  const { server, call } = await startApp(createApp, ctx);
  try {
    const inv = await call('POST', '/api/invoices', 3, { customer: 'Http Co', lines: line(10000) });
    assert.equal(inv.status, 201);
    const pr = await call('GET', `/api/invoices/${inv.body.id}/print`, 5);
    assert.equal(pr.status, 200);
    assert.match(pr.body.html, /Http Co/);
    assert.equal((await call('GET', `/api/invoices/${inv.body.id}/print`, 6)).status, 403);
    assert.equal((await call('POST', `/api/invoices/${inv.body.id}/credit-notes`, 3, { amount: 100, reason: 'x' })).status, 403);
    const cn = await call('POST', `/api/invoices/${inv.body.id}/credit-notes`, 2, { amount: 100, reason: 'x' });
    assert.equal(cn.status, 201);
    const bad = await call('POST', `/api/invoices/${inv.body.id}/credit-notes`, 2, { amount: 99999999, reason: 'x' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'CREDIT_EXCEEDS_INVOICE');
    const pay = await call('POST', '/api/payments', 3, { amount: 1000, allocations: [{ invoiceId: inv.body.id, amount: 1000 }] });
    assert.equal(pay.status, 201);
    const list = await call('GET', '/api/invoices?status=partially_paid', 5);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].balance, 11400 - 100 - 14 - 1000);
    const aging = await call('GET', '/api/customers/aging', 5);
    assert.equal(aging.status, 200);
    assert.equal((await call('GET', '/api/customers/aging', 6)).status, 403);
    assert.equal((await call('GET', '/api/customers/1', 5)).body.name, 'Cafe Nile'); // :id route does not swallow "aging"
  } finally { server.close(); }
});
