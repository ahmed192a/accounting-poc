import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../public/simple/logic.js';
import { GLOSSARY, STRINGS } from '../public/simple/glossary.js';

const items = [
  { sku: 'OIL1', name: 'Oil 1L', name_ar: 'زيت', price: 9000 },
  { sku: 'TEA', name: 'Tea', name_ar: 'شاي', price: 2550 },
];

test('simple: cart stepper adds, steps down and removes at zero', () => {
  let c = L.addOne([], 'OIL1'); c = L.addOne(c, 'OIL1'); c = L.addOne(c, 'TEA');
  assert.deepEqual(c, [{ sku: 'OIL1', qty: 2 }, { sku: 'TEA', qty: 1 }]);
  c = L.addOne(c, 'OIL1', -1); assert.equal(c[0].qty, 1);
  c = L.addOne(c, 'OIL1', -1); assert.deepEqual(c, [{ sku: 'TEA', qty: 1 }]);
  assert.deepEqual(L.addOne(c, 'TEA', -5), [], 'never negative');
  assert.equal(L.setQty([], 'X', 'abc').length, 0);
});

test('simple: totals are integer piastres and unknown skus are dropped', () => {
  const ls = L.cartLines([{ sku: 'OIL1', qty: 3 }, { sku: 'TEA', qty: 2 }, { sku: 'GONE', qty: 1 }], items);
  assert.equal(ls.length, 2);
  assert.equal(L.cartSubtotal(ls), 3 * 9000 + 2 * 2550);
  assert.equal(L.estimateVat(32100, 1400), 4494);
  assert.ok(Number.isInteger(L.estimateVat(333, 1400)));
  assert.deepEqual(L.quickItems(ls), [{ sku: 'OIL1', qty: 3 }, { sku: 'TEA', qty: 2 }]);
  assert.equal(L.invoiceLines(ls)[0].unitPrice, 9000);
});

test('simple: item search matches English, Arabic and sku; codes match sku exactly', () => {
  assert.equal(L.filterItems(items, 'tea').length, 1);
  assert.equal(L.filterItems(items, 'زيت').length, 1);
  assert.equal(L.filterItems(items, 'oil1').length, 1);
  assert.equal(L.filterItems(items, '').length, 2);
  assert.equal(L.matchCode(items, ' tea ').sku, 'TEA');
  assert.equal(L.matchCode(items, 'TE'), null);
});

test('simple: owed is sorted by days late, then amount; days late is the oldest overdue invoice', () => {
  const rows = [
    { customerId: 1, customer: 'Mona', total: 900, invoices: [{ id: 3, dueDate: '2026-11-01', daysPastDue: 7, balance: 900 }] },
    { customerId: 2, customer: 'Ahmed', total: 2300, invoices: [{ id: 2, dueDate: '2026-10-20', daysPastDue: 19, balance: 1000 }, { id: 1, dueDate: '2026-10-27', daysPastDue: 12, balance: 1300 }] },
    { customerId: null, customer: 'Nile', total: 5100, invoices: [{ id: 4, dueDate: '2026-12-01', daysPastDue: 0, balance: 5100 }] },
  ];
  const r = L.rankOwed(rows);
  assert.deepEqual(r.map((x) => x.name), ['Ahmed', 'Mona', 'Nile']);
  assert.equal(r[0].daysLate, 19);
  assert.deepEqual(r[0].invoices.map((i) => i.id), [2, 1], 'oldest due first');
});

test('simple: partial payment goes to the oldest invoice first and cannot exceed the debt', () => {
  const inv = [{ id: 2, balance: 1000 }, { id: 1, balance: 1300 }];
  assert.deepEqual(L.planAllocations(inv, 400), { allocations: [{ invoiceId: 2, amount: 400 }], left: 0 });
  assert.deepEqual(L.planAllocations(inv, 1500), { allocations: [{ invoiceId: 2, amount: 1000 }, { invoiceId: 1, amount: 500 }], left: 0 });
  assert.equal(L.planAllocations(inv, 5000).left, 2700);
  for (const bad of [0, -5, 1.5, NaN]) assert.throws(() => L.planAllocations(inv, bad), RangeError);
});

test('simple: sold today counts quick sales plus invoices issued today, not void or drafts', () => {
  const inv = [
    { issue_date: '2026-11-13', total: 1000, status: 'issued' }, { issue_date: '2026-11-13', total: 500, status: 'paid' },
    { issue_date: '2026-11-13', total: 700, status: 'void' }, { issue_date: '2026-11-13', total: 300, status: 'draft' },
    { issue_date: '2026-11-12', total: 900, status: 'issued' }, { issue_date: '2026-11-13', total: 800, status: 'issued', entry_reversed: 1 },
  ];
  assert.deepEqual(L.soldToday({ total: 2000, count: 2 }, inv, '2026-11-13'), { total: 3500, count: 4 });
  assert.equal(L.isoToday(Date.parse('2026-11-13T23:00:00Z')), '2026-11-13');
});

test('simple: receipt text and WhatsApp link', () => {
  const lines = L.cartLines([{ sku: 'OIL1', qty: 2 }], items);
  const text = L.receiptText({ business: 'Shop', number: 'INV-1', date: '2026-11-13', lines, subtotal: 18000, vat: 2520, total: 20520, method: 'credit', customer: 'Ahmed', labels: STRINGS.en, fmt: (p) => `E${p}`, lang: 'en' });
  assert.match(text, /Oil 1L x2/); assert.match(text, /Total: E20520/); assert.match(text, /On credit/); assert.match(text, /Ahmed/);
  const ar = L.receiptText({ lines, subtotal: 18000, vat: 0, total: 18000, method: 'cash', labels: STRINGS.ar, fmt: (p) => String(p), lang: 'ar' });
  assert.match(ar, /زيت/); assert.ok(!ar.includes('undefined'));
  assert.equal(L.whatsappLink('hi there', '+20 100 123 4567'), 'https://wa.me/201001234567?text=hi%20there');
  assert.equal(L.whatsappLink('x', ''), 'https://wa.me/?text=x');
  assert.equal(L.waDigits('01012345678'), '201012345678');
  assert.equal(L.waDigits('0020 100 555 0101'), '201005550101');
});

test('simple: glossary has both languages for every term, and both UI string tables have the same keys', () => {
  const keys = new Set();
  for (const g of GLOSSARY) {
    assert.ok(g.en && g.ar && g.ledger && g.hint.en && g.hint.ar, g.key);
    assert.ok(!keys.has(g.key), `duplicate ${g.key}`); keys.add(g.key);
  }
  assert.deepEqual(Object.keys(STRINGS.en).sort(), Object.keys(STRINGS.ar).sort());
});
