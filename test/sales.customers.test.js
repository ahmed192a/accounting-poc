import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError } from './helpers.js';
import * as sales from '../src/modules/sales/service.js';
import { trialBalance } from '../src/ledger.js';

const DAY = 24 * 3600 * 1000;
const line = (unitPrice, qty = 1) => [{ description: 'Goods', qty, unitPrice }];
const audited = (ctx, action) => ctx.db.prepare('SELECT * FROM audit_log WHERE action = ?').all(action);

test('customers: create, update, deactivate and delete with validation and audit', () => {
  const { ctx, as } = setup();
  const c = sales.createCustomer(ctx, as('clerk'), { name: ' Blue Shop ', phone: '010 1234 5678', taxId: '123-456', address: 'Cairo', creditLimit: 100000, notes: 'VIP' });
  assert.equal(c.name, 'Blue Shop');
  assert.equal(c.creditLimit, 100000);
  assert.equal(audited(ctx, 'customer.created').length, 1);
  expectError(() => sales.createCustomer(ctx, as('clerk'), { name: 'blue shop' }), 'DUPLICATE_CUSTOMER');
  expectError(() => sales.createCustomer(ctx, as('clerk'), { name: '' }), 'BAD_INPUT');
  expectError(() => sales.createCustomer(ctx, as('clerk'), { name: 'X', phone: 'call me!' }), 'BAD_PHONE');
  expectError(() => sales.createCustomer(ctx, as('clerk'), { name: 'X', creditLimit: -5 }), 'BAD_INPUT');
  const u = sales.updateCustomer(ctx, as('manager'), c.id, { phone: '+20 100 000 0000', creditLimit: 0 });
  assert.equal(u.phone, '+20 100 000 0000');
  assert.equal(u.creditLimit, 0);
  assert.equal(audited(ctx, 'customer.updated').length, 1);
  expectError(() => sales.updateCustomer(ctx, as('manager'), c.id, {}), 'BAD_INPUT');
  sales.updateCustomer(ctx, as('manager'), c.id, { active: false });
  assert.ok(!sales.listCustomers(ctx, as('clerk')).some((x) => x.id === c.id));
  assert.ok(sales.listCustomers(ctx, as('clerk'), { all: 1 }).some((x) => x.id === c.id));
  assert.equal(sales.deleteCustomer(ctx, as('manager'), c.id).deleted, true);
  expectError(() => sales.getCustomer(ctx, as('clerk'), c.id), 'NOT_FOUND');
});

test('customers: a customer with documents cannot be deleted, only deactivated', () => {
  const { ctx, as } = setup();
  const c = sales.listCustomers(ctx, as('clerk'))[0];
  sales.createInvoice(ctx, as('clerk'), { customerId: c.id, lines: line(1000) });
  expectError(() => sales.deleteCustomer(ctx, as('manager'), c.id), 'CUSTOMER_IN_USE');
});

test('customers: permission denials', () => {
  const { ctx, as } = setup();
  expectError(() => sales.createCustomer(ctx, as('auditor'), { name: 'Nope' }), 'FORBIDDEN');
  expectError(() => sales.createCustomer(ctx, as('accountant'), { name: 'Nope' }), 'FORBIDDEN');
  expectError(() => sales.listCustomers(ctx, as('admin')), 'FORBIDDEN');
  expectError(() => sales.aging(ctx, as('admin')), 'FORBIDDEN');
  assert.ok(sales.listCustomers(ctx, as('auditor')).length >= 3, 'auditor can read');
});

test('aging buckets follow days past due on the demo clock', () => {
  const { ctx, as } = setup();
  const clerk = as('clerk');
  const day0 = new Date(ctx.now()).toISOString().slice(0, 10);
  const dueIn = (n) => new Date(Date.parse(day0) + n * DAY).toISOString().slice(0, 10);
  const mk = (customer, price, dueDay) => sales.createInvoice(ctx, clerk, { customer, date: day0, dueDate: dueIn(dueDay), lines: line(price) });
  // The demo clock is moved 100 days ahead; due days are relative to day0.
  const a = mk('Cafe Nile', 10000, 110);      // not yet due: current
  const b = mk('Cafe Nile', 20000, 80);       // 20 days late
  const c = mk('Delta Traders', 30000, 55);   // 45 days late
  const d = mk('Delta Traders', 40000, 10);   // 90 days late
  assert.equal(sales.aging(ctx, as('accountant')).totals.current, a.total + b.total + c.total + d.total, 'nothing is late today');
  ctx.offsetMs += 100 * DAY;
  const ag = sales.aging(ctx, as('accountant'));
  assert.equal(ag.asOf, new Date(ctx.now()).toISOString().slice(0, 10));
  assert.deepEqual([ag.totals.current, ag.totals.d1_30, ag.totals.d31_60, ag.totals.d61_plus], [a.total, b.total, c.total, d.total]);
  assert.equal(ag.totals.total, a.total + b.total + c.total + d.total);
  assert.equal(ag.rows.find((r) => r.customer === 'Delta Traders').invoices.find((i) => i.id === d.id).daysPastDue, 90);
});

test('aging: exact bucket boundaries (0, 1, 30, 31, 60, 61 days)', () => {
  const { ctx, as } = setup();
  const clerk = as('clerk');
  const mk = (issue, due, price) => sales.createInvoice(ctx, clerk, { customer: 'Cafe Nile', date: issue, dueDate: due, lines: line(price) });
  const asOf = '2026-06-30';
  const dueFor = (daysLate) => new Date(Date.parse(asOf) - daysLate * DAY).toISOString().slice(0, 10);
  const issue = '2026-01-01';
  const inv = {};
  for (const [k, late] of Object.entries({ d0: 0, d1: 1, d30: 30, d31: 31, d60: 60, d61: 61 })) inv[k] = mk(issue, dueFor(late), 1000);
  const ag = sales.aging(ctx, as('manager'), { asOf });
  const row = ag.rows.find((r) => r.customer === 'Cafe Nile');
  assert.equal(row.current, inv.d0.total);
  assert.equal(row.d1_30, inv.d1.total + inv.d30.total);
  assert.equal(row.d31_60, inv.d31.total + inv.d60.total);
  assert.equal(row.d61_plus, inv.d61.total);
  expectError(() => sales.aging(ctx, as('manager'), { asOf: 'yesterday' }), 'BAD_DATE');
});

test('aging counts only the open balance after partial payments and credit notes', () => {
  const { ctx, as } = setup();
  const inv = sales.createInvoice(ctx, as('clerk'), { customer: 'Cafe Nile', date: '2026-01-01', dueDate: '2026-01-10', lines: line(10000) }); // total 11400
  sales.recordPayment(ctx, as('clerk'), { allocations: [{ invoiceId: inv.id, amount: 4000 }], amount: 4000 });
  sales.createCreditNote(ctx, as('manager'), inv.id, { amount: 1000, reason: 'damaged' }); // 1000 + 140 vat
  const ag = sales.aging(ctx, as('manager'), { asOf: '2026-03-01' });
  assert.equal(ag.totals.d31_60, 11400 - 4000 - 1140); // 50 days late
});

test('statement: running balance across invoice, credit note and payment; opening balance with from', () => {
  const { ctx, as } = setup();
  const c = sales.listCustomers(ctx, as('clerk')).find((x) => x.name === 'Cafe Nile');
  const inv = sales.createInvoice(ctx, as('clerk'), { customerId: c.id, date: '2026-02-01', lines: line(10000) }); // 11400
  sales.createCreditNote(ctx, as('manager'), inv.id, { amount: 5000, reason: 'return' }); // 5700
  sales.recordPayment(ctx, as('clerk'), { customerId: c.id, amount: 1700 });
  const st = sales.statement(ctx, as('accountant'), c.id);
  assert.deepEqual(st.lines.map((l) => l.type), ['invoice', 'credit_note', 'payment']);
  assert.equal(st.closingBalance, 11400 - 5700 - 1700);
  assert.equal(st.lines.at(-1).balance, st.closingBalance);
  assert.equal(st.customer.balance, st.closingBalance);
  const later = sales.statement(ctx, as('accountant'), c.id, { from: '2999-01-01' });
  assert.equal(later.lines.length, 0);
  assert.equal(later.openingBalance, st.closingBalance);
  expectError(() => sales.statement(ctx, as('accountant'), c.id, { from: 'x' }), 'BAD_DATE');
});

test('reminder: wa.me link with Arabic or English text, normalised phone, nothing sent', () => {
  const { ctx, as } = setup();
  const c = sales.listCustomers(ctx, as('clerk')).find((x) => x.name === 'Cafe Nile'); // phone 01012345678
  sales.createInvoice(ctx, as('clerk'), { customerId: c.id, date: '2026-01-01', dueDate: '2026-01-15', lines: line(10000) });
  const en = sales.reminder(ctx, as('clerk'), c.id, { lang: 'en' });
  assert.equal(en.phone, '201012345678');
  assert.ok(en.link.startsWith('https://wa.me/201012345678?text='));
  assert.equal(decodeURIComponent(en.link.split('?text=')[1]), en.message);
  assert.match(en.message, /Hello Cafe Nile/);
  assert.match(en.message, /114\.00/);
  assert.equal(en.sent, false);
  const ar = sales.reminder(ctx, as('clerk'), c.id, { lang: 'ar' });
  assert.match(ar.message, /تذكير/);
  assert.ok(ar.link.includes(encodeURIComponent('تذكير')));
  assert.equal(sales.waNumber('+20 100 555 0101'), '201005550101');
  assert.equal(sales.waNumber('0020 100 555 0101'), '201005550101');
  expectError(() => sales.waNumber('12'), 'BAD_PHONE');
  const none = sales.createCustomer(ctx, as('clerk'), { name: 'No Phone Ltd' });
  expectError(() => sales.reminder(ctx, as('clerk'), none.id), 'NO_PHONE');
  const delta = sales.listCustomers(ctx, as('clerk')).find((x) => x.name === 'Delta Traders');
  expectError(() => sales.reminder(ctx, as('clerk'), delta.id), 'NOTHING_OVERDUE');
});

test('credit limit blocks invoice creation; sales.credit overrides with a reason and it is audited', () => {
  const { ctx, as } = setup();
  const c = sales.createCustomer(ctx, as('clerk'), { name: 'Small Kiosk', creditLimit: 20000 });
  sales.createInvoice(ctx, as('clerk'), { customerId: c.id, lines: line(10000) }); // 11400 used
  const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n;
  const err = expectError(() => sales.createInvoice(ctx, as('clerk'), { customerId: c.id, lines: line(10000) }), 'CREDIT_LIMIT_EXCEEDED');
  assert.equal(err.extra.limit, 20000);
  assert.equal(err.extra.exposure, 22800);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n, before, 'nothing was created');
  // the clerk has no sales.credit: asking for an override is refused
  expectError(() => sales.createInvoice(ctx, as('clerk'), { customerId: c.id, lines: line(10000), creditOverride: { reason: 'regular buyer' } }), 'FORBIDDEN');
  expectError(() => sales.createInvoice(ctx, as('manager'), { customerId: c.id, lines: line(10000), creditOverride: {} }), 'BAD_INPUT');
  const ok = sales.createInvoice(ctx, as('manager'), { customerId: c.id, lines: line(10000), creditOverride: { reason: 'Paid on time for 3 years' } });
  assert.equal(ok.status, 'issued');
  const a = audited(ctx, 'invoice.credit_override');
  assert.equal(a.length, 1);
  assert.equal(a[0].reason, 'Paid on time for 3 years');
  assert.ok(trialBalance(ctx.db).balanced);
});

test('credit limit counts open balances only: paying frees headroom; drafts are checked when issued', () => {
  const { ctx, as } = setup();
  const c = sales.createCustomer(ctx, as('clerk'), { name: 'Limit Co', creditLimit: 12000 });
  const first = sales.createInvoice(ctx, as('clerk'), { customerId: c.id, lines: line(10000) });
  const draft = sales.createInvoice(ctx, as('clerk'), { customerId: c.id, lines: line(10000), draft: true });
  assert.equal(draft.status, 'draft');
  expectError(() => sales.issueInvoice(ctx, as('clerk'), draft.id), 'CREDIT_LIMIT_EXCEEDED');
  sales.payInvoice(ctx, as('clerk'), first.id);
  const issued = sales.issueInvoice(ctx, as('clerk'), draft.id);
  assert.equal(issued.status, 'issued');
  assert.match(issued.number, /^INV-\d{4}$/);
});
