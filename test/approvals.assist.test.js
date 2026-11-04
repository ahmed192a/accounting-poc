import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError, startApp } from './helpers.js';
import { createApp } from '../src/server.js';
import * as a from '../src/modules/assist/service.js';
import { extractHeuristic, parseAmount, normalizeDigits } from '../src/modules/assist/extractor.js';
import { registerProvider } from '../src/modules/assist/providers.js';
import * as p from '../src/modules/purchases/service.js';
import { accountBalance, setPeriodLock } from '../src/ledger.js';

const EN = `Nile Stationery Co.
Tax Invoice
Date: 14/03/2026
Paper A4        120.00
Pens             30.00
Subtotal        150.00
VAT 14%          21.00
Total           171.00 EGP`;
const AR = `مكتبة النيل
فاتورة ضريبية
التاريخ: ١٤/٠٣/٢٠٢٦
الإجمالي قبل الضريبة: ١٥٠٫٠٠
ضريبة القيمة المضافة ١٤٪: ٢١٫٠٠
الإجمالي: ١٧١٫٠٠ جنيه`;
const ELEC = `North Cairo Electricity Company
Date: 2026-02-05
Total due: 1,234.50 EGP
VAT: 150.90`;

test('extractor: English receipt', () => {
  const { fields, confidence, reasons } = extractHeuristic(EN);
  assert.deepEqual(fields, { supplier: 'Nile Stationery Co.', date: '2026-03-14', total: 17100, vat: 2100, currency: 'EGP', category: 'purchases' });
  assert.ok(confidence.total >= 0.9 && confidence.vat >= 0.8);
  assert.match(reasons.total, /total/i);
  assert.ok(Object.keys(fields).every((k) => k in confidence && k in reasons)); // every field explains itself
});

test('extractor: Arabic receipt with Arabic-Indic digits', () => {
  const { fields, reasons } = extractHeuristic(AR);
  assert.equal(fields.supplier, 'مكتبة النيل');
  assert.equal(fields.date, '2026-03-14');
  assert.equal(fields.total, 17100); // the pre-VAT line is not picked
  assert.equal(fields.vat, 2100);
  assert.equal(fields.currency, 'EGP');
  assert.match(reasons.total, /./);
});

test('extractor: utilities category guess, thousands separator, labelled date', () => {
  const { fields, confidence } = extractHeuristic(ELEC);
  assert.equal(fields.total, 123450);
  assert.equal(fields.vat, 15090);
  assert.equal(fields.category, 'utilities');
  assert.equal(fields.date, '2026-02-05');
  assert.ok(confidence.category < 0.9); // a keyword guess is never shown as certain
  assert.equal(extractHeuristic('شركة الكهرباء\nالمجموع: ٩٩٫٥٠').fields.category, 'utilities');
});

test('extractor: missing data yields low confidence and honest reasons, never invented values', () => {
  const r = extractHeuristic('hello there');
  assert.equal(r.fields.date, null);
  assert.equal(r.fields.total, null);
  assert.equal(r.confidence.date, 0);
  assert.match(r.reasons.total, /No amounts/);
  const amb = extractHeuristic('Shop\n03/04/2026\nTotal 10.00');
  assert.equal(amb.fields.date, '2026-04-03');
  assert.ok(amb.confidence.date <= 0.6);
  assert.equal(extractHeuristic('Shop\nUSD 5.00\nTotal 5.00').fields.currency, 'USD');
});

test('amount parsing is exact integer piastres', () => {
  assert.equal(parseAmount('1,234.50'), 123450);
  assert.equal(parseAmount('1.234,50'), 123450);
  assert.equal(parseAmount('1,234'), 123400);
  assert.equal(parseAmount('0.07'), 7);
  assert.equal(parseAmount('12.5'), 1250);
  assert.equal(parseAmount('1234'), 123400);
  assert.equal(normalizeDigits('١٢٣٫٤٥'), '123.45');
});

test('intake -> review queue -> accept creates a bill that still needs approval (never auto-approved)', () => {
  const { ctx, as } = setup();
  const it = a.submitIntake(ctx, as('clerk'), { text: EN });
  assert.equal(it.mock, true);
  expectError(() => a.submitIntake(ctx, as('auditor'), { text: EN }), 'FORBIDDEN');
  expectError(() => a.submitIntake(ctx, as('clerk'), { text: '  ' }), 'BAD_INPUT');
  const r = a.acceptItem(ctx, as('clerk'), it.id, { edits: { date: '2099-01-01' } });
  // 171 EGP is far below the 1,000 EGP auto-approve threshold, yet it must wait for a human
  assert.equal(r.billStatus, 'pending_approval');
  const bill = ctx.db.prepare('SELECT * FROM bills WHERE id = ?').get(r.billId);
  assert.equal(bill.source, 'assist');
  assert.equal(bill.entry_id, null);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM journal_entries WHERE source_type = 'bill'").get().n, 0);
  assert.equal(p.approveBill(ctx, as('manager'), r.billId).status, 'approved');
  expectError(() => a.acceptItem(ctx, as('clerk'), it.id), 'NOT_PENDING');
});

test('accept needs assist.review and purchases.create; own-items visibility', () => {
  const { ctx, as } = setup();
  const it = a.submitIntake(ctx, as('accountant'), { text: EN });
  expectError(() => a.acceptItem(ctx, as('accountant'), it.id), 'FORBIDDEN');
  expectError(() => a.acceptItem(ctx, as('manager'), it.id), 'FORBIDDEN');
  assert.equal(a.listItems(ctx, as('accountant')).length, 1);
  assert.equal(a.listItems(ctx, as('clerk')).length, 1); // reviewers see everything
  a.submitIntake(ctx, as('clerk'), { text: ELEC });
  assert.equal(a.listItems(ctx, as('accountant')).length, 1); // but a plain user only their own
  expectError(() => a.getItem(ctx, as('auditor'), it.id), 'FORBIDDEN');
  expectError(() => a.accuracyStats(ctx, as('accountant')), 'FORBIDDEN');
});

test('locked period: suggestions are refused for soft and hard locks, nothing is created', () => {
  const { ctx, as } = setup();
  const it = a.submitIntake(ctx, as('clerk'), { text: EN }); // dated 2026-03-14
  for (const mode of ['soft', 'hard']) {
    setPeriodLock(ctx, 1, '2026-03-31', mode, 'month end');
    expectError(() => a.acceptItem(ctx, as('clerk'), it.id), 'PERIOD_LOCKED');
  }
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM bills').get().n, 0);
  assert.equal(a.listItems(ctx, as('clerk'), { status: 'pending' }).length, 1);
  // editing the date to an open day works
  assert.ok(a.acceptItem(ctx, as('clerk'), it.id, { edits: { date: '2026-04-02' } }).billId);
});

test('edits are validated; non-EGP currency is refused honestly', () => {
  const { ctx, as } = setup();
  const it = a.submitIntake(ctx, as('clerk'), { text: EN });
  expectError(() => a.acceptItem(ctx, as('clerk'), it.id, { edits: { total: 12.5 } }), 'BAD_INPUT');
  expectError(() => a.acceptItem(ctx, as('clerk'), it.id, { edits: { vat: 99999999 } }), 'BAD_INPUT');
  expectError(() => a.acceptItem(ctx, as('clerk'), it.id, { edits: { category: 'yachts' } }), 'BAD_INPUT');
  expectError(() => a.acceptItem(ctx, as('clerk'), it.id, { edits: { date: '2026-02-30' } }), 'BAD_DATE');
  expectError(() => a.acceptItem(ctx, as('clerk'), it.id, { edits: { currency: 'USD' } }), 'CURRENCY_UNSUPPORTED');
  const none = a.submitIntake(ctx, as('clerk'), { text: 'hello' });
  expectError(() => a.acceptItem(ctx, as('clerk'), none.id), 'BAD_DATE'); // no date was found, so the reviewer must supply one
  assert.equal(ctx.db.prepare('SELECT status FROM assist_items WHERE id = ?').get(it.id).status, 'pending');
});

test('atomicity: a refused bill (over the creator limit) leaves the item pending', () => {
  const { ctx, as } = setup();
  const it = a.submitIntake(ctx, as('clerk'), { text: 'Big Co\nDate: 2026-05-01\nTotal: 90,000.00' });
  expectError(() => a.acceptItem(ctx, as('clerk'), it.id), 'OVER_LIMIT');
  assert.equal(ctx.db.prepare('SELECT status FROM assist_items WHERE id = ?').get(it.id).status, 'pending');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM bills').get().n, 0);
});

test('reject needs a reason; rejected items cannot be accepted', () => {
  const { ctx, as } = setup();
  const it = a.submitIntake(ctx, as('clerk'), { text: EN });
  expectError(() => a.rejectItem(ctx, as('clerk'), it.id, {}), 'BAD_INPUT');
  a.rejectItem(ctx, as('clerk'), it.id, { reason: 'Not ours' });
  expectError(() => a.acceptItem(ctx, as('clerk'), it.id), 'NOT_PENDING');
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'assist.rejected'").get());
});

test('undo: pending bill is cancelled, posted bill is reversed, paid bill blocks undo', () => {
  const { ctx, as } = setup();
  const i1 = a.submitIntake(ctx, as('clerk'), { text: EN });
  const r1 = a.acceptItem(ctx, as('clerk'), i1.id, { edits: { date: '2026-06-01' } });
  expectError(() => a.undoItem(ctx, as('clerk'), i1.id, {}), 'BAD_INPUT');
  assert.equal(a.undoItem(ctx, as('clerk'), i1.id, { reason: 'Wrong doc' }).status, 'undone');
  assert.equal(ctx.db.prepare('SELECT status FROM bills WHERE id = ?').get(r1.billId).status, 'void');
  expectError(() => a.undoItem(ctx, as('clerk'), i1.id, { reason: 'again' }), 'NOT_ACCEPTED');

  const i2 = a.submitIntake(ctx, as('clerk'), { text: EN });
  const r2 = a.acceptItem(ctx, as('clerk'), i2.id, { edits: { date: '2026-06-01' } });
  p.approveBill(ctx, as('manager'), r2.billId);
  assert.equal(accountBalance(ctx.db, '2000').net, -17100);
  const u = a.undoItem(ctx, as('clerk'), i2.id, { reason: 'Mistake' });
  assert.ok(u.reversalEntryId);
  assert.equal(accountBalance(ctx.db, '2000').net, 0); // journal untouched, a reversal netted it out

  const i3 = a.submitIntake(ctx, as('clerk'), { text: EN });
  const r3 = a.acceptItem(ctx, as('clerk'), i3.id, { edits: { date: '2026-06-01' } });
  p.approveBill(ctx, as('manager'), r3.billId);
  ctx.db.prepare("UPDATE bills SET paid = 100, status = 'partially_paid' WHERE id = ?").run(r3.billId);
  expectError(() => a.undoItem(ctx, as('clerk'), i3.id, { reason: 'x' }), 'HAS_PAYMENTS');
  assert.equal(ctx.db.prepare('SELECT status FROM assist_items WHERE id = ?').get(i3.id).status, 'accepted'); // rolled back
});

test('learning: a corrected category becomes a supplier rule used by the next suggestion', () => {
  const { ctx, as } = setup();
  const i1 = a.submitIntake(ctx, as('clerk'), { text: EN });
  assert.equal(i1.suggestion.category, 'purchases');
  a.acceptItem(ctx, as('clerk'), i1.id, { edits: { category: 'rent', date: '2026-06-01' } });
  const rules = a.listRules(ctx, as('clerk'));
  assert.equal(rules.length, 1);
  const i2 = a.submitIntake(ctx, as('clerk'), { text: EN.replace('14/03/2026', '15/03/2026') });
  assert.equal(i2.suggestion.category, 'rent');
  assert.ok(i2.confidence.category >= 0.9);
  assert.match(i2.reasons.category, /corrected/);
  // accepting unchanged teaches nothing new; deleting forgets
  a.acceptItem(ctx, as('clerk'), i2.id, { edits: { date: '2026-06-02' } });
  assert.equal(a.listRules(ctx, as('clerk'))[0].hits, 1);
  a.deleteRule(ctx, as('clerk'), rules[0].id);
  assert.equal(a.submitIntake(ctx, as('clerk'), { text: EN }).suggestion.category, 'purchases');
});

test('accuracy stats are honest: counts, sample size and a small-sample caution', () => {
  const { ctx, as } = setup();
  assert.match(a.accuracyStats(ctx, as('clerk')).caution, /Nothing reviewed/);
  const mk = () => a.submitIntake(ctx, as('clerk'), { text: ELEC });
  a.acceptItem(ctx, as('clerk'), mk().id);                                   // unchanged
  a.acceptItem(ctx, as('clerk'), mk().id, { edits: { vat: 100 } });          // edited
  a.rejectItem(ctx, as('clerk'), mk().id, { reason: 'bad' });                // rejected
  const undo = mk(); a.acceptItem(ctx, as('clerk'), undo.id); a.undoItem(ctx, as('clerk'), undo.id, { reason: 'x' });
  mk();                                                                       // pending
  const s = a.accuracyStats(ctx, as('clerk'));
  assert.deepEqual([s.sampleSize, s.acceptedUnchanged, s.acceptedEdited, s.rejected, s.undone, s.pending], [3, 1, 1, 1, 1, 1]);
  assert.equal(s.acceptedUnchangedPct, 33.3);
  assert.deepEqual(s.fieldEdits, { vat: 1 });
  assert.match(s.caution, /Only 3 reviewed/);
  assert.equal(s.mock, true);
});

test('provider interface: a registered provider is used, bad provider is refused', () => {
  const { ctx, as } = setup();
  registerProvider({ name: 'test-fixed', mock: true, extract: () => ({ fields: { supplier: 'Fixed', date: '2026-07-01', total: 5000, vat: 0, currency: 'EGP', category: 'rent' }, confidence: { supplier: 1, date: 1, total: 1, vat: 1, currency: 1, category: 1 }, reasons: {} }) });
  const it = a.submitIntake(ctx, as('clerk'), { text: 'x', provider: 'test-fixed' });
  assert.equal(it.suggestion.supplier, 'Fixed');
  expectError(() => a.submitIntake(ctx, as('clerk'), { text: 'x', provider: 'nope' }), 'UNKNOWN_PROVIDER');
});

test('HTTP: bill and assist routes work end to end and enforce permissions', async () => {
  const { ctx } = setup();
  const { server, call } = await startApp(createApp, ctx);
  try {
    const it = await call('POST', '/api/assist/items', 3, { text: EN });
    assert.equal(it.status, 201);
    assert.equal((await call('POST', '/api/assist/items', 5, { text: EN })).status, 403);
    const acc = await call('POST', `/api/assist/items/${it.body.id}/accept`, 3, { edits: { date: '2026-08-01' } });
    assert.equal(acc.body.billStatus, 'pending_approval');
    const ap = await call('POST', `/api/bills/${acc.body.billId}/approve`, 2);
    assert.equal(ap.body.status, 'approved');
    assert.equal((await call('GET', '/api/assist/stats', 3)).body.sampleSize, 1);
    assert.equal((await call('GET', '/api/suppliers', 5)).status, 200);
    assert.equal((await call('POST', '/api/suppliers', 3, { name: 'Z' })).status, 403);
    assert.equal((await call('GET', '/api/purchases/ap-aging', 5)).status, 200);
    assert.equal((await call('GET', '/api/notifications', 3)).status, 200);
    assert.equal((await call('GET', '/api/approval-rules', 3)).body.length, 1);
    assert.equal((await call('POST', '/api/approvals/escalations/run', 2)).status, 403);
    const home = await call('GET', '/api/home', 3);
    assert.ok(home.body.widgets.assist && home.body.widgets.approvalsInbox);
  } finally { server.close(); }
});
