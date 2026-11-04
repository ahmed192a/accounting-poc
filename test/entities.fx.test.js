import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError } from './helpers.js';
import { postEntry, reverseEntry, trialBalance, accountBalance } from '../src/ledger.js';
import { convertMinor, convertAmount, parseRate, formatRate } from '../src/modules/entities/fxcore.js';
import * as fx from '../src/modules/entities/fx.js';
import { createEntity } from '../src/modules/entities/service.js';

const rate = (ctx, as, currency, date, r) => fx.setRate(ctx, as('accountant'), { currency, date, rate: r });
const usdBank = (amount, side = 'debit') => ({ account: '1000', currency: 'USD', fxAmount: amount, side });

test('fx: conversion rounds once, half away from zero, with integer maths only', () => {
  const usd = { rate: 48500000, minor: 2 }, egp = { rate: 1000000, minor: 2 };
  assert.equal(convertMinor(10000, usd, egp), 485000);         // USD 100.00 -> EGP 4850.00
  assert.equal(convertMinor(1, usd, egp), 49);                  // 48.5 piastres -> 49 (half up)
  assert.equal(convertMinor(-1, usd, egp), -49);                // symmetric for negatives
  assert.equal(convertMinor(1, { rate: 48123456, minor: 2 }, egp), 48); // 48.12 -> 48
  assert.equal(convertMinor(48500, egp, usd), 1000);            // and back: EGP 485.00 -> USD 10.00
  assert.equal(parseRate('48.5'), 48500000);
  assert.equal(formatRate(48500000), '48.5');
  assert.throws(() => parseRate('-1'), /Rate/);
  assert.throws(() => parseRate('1.1234567'), /Rate/);
});

test('fx: manual rates by date, latest on or before the date wins, missing rate is an error', () => {
  const { ctx, as } = setup();
  rate(ctx, as, 'USD', '2026-01-01', '48');
  rate(ctx, as, 'USD', '2026-02-01', '50');
  assert.equal(convertAmount(ctx.db, 100, 'USD', 'EGP', '2026-01-15'), 4800);
  assert.equal(convertAmount(ctx.db, 100, 'USD', 'EGP', '2026-03-01'), 5000);
  expectError(() => convertAmount(ctx.db, 100, 'USD', 'EGP', '2025-12-31'), 'NO_RATE');
  expectError(() => convertAmount(ctx.db, 100, 'XXX', 'EGP', '2026-01-01'), 'UNKNOWN_CURRENCY');
  // a correction is a new row; history stays
  rate(ctx, as, 'USD', '2026-02-01', '51');
  assert.equal(convertAmount(ctx.db, 100, 'USD', 'EGP', '2026-02-01'), 5100);
  assert.equal(fx.listRates(ctx, as('auditor'), { currency: 'USD' }).filter((r) => r.date === '2026-02-01').length, 2);
});

test('fx: rate and currency management is permission-gated and audited', () => {
  const { ctx, as } = setup();
  expectError(() => fx.setRate(ctx, as('clerk'), { currency: 'USD', date: '2026-01-01', rate: '48' }), 'FORBIDDEN');
  expectError(() => fx.addCurrency(ctx, as('manager'), { code: 'KWD', name: 'Kuwaiti dinar', minorUnits: 3 }), 'FORBIDDEN');
  expectError(() => fx.setRate(ctx, as('accountant'), { currency: 'USD', date: '01/01/2026', rate: '48' }), 'BAD_DATE');
  expectError(() => fx.setRate(ctx, as('accountant'), { currency: 'EGP', date: '2026-01-01', rate: '1' }), 'BAD_INPUT');
  fx.addCurrency(ctx, as('accountant'), { code: 'kwd', name: 'Kuwaiti dinar', nameAr: 'الدينار الكويتي', minorUnits: 3 });
  expectError(() => fx.addCurrency(ctx, as('accountant'), { code: 'KWD', name: 'again' }), 'DUPLICATE');
  rate(ctx, as, 'KWD', '2026-01-01', '158.5');
  const actions = ctx.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'fx.%' OR action LIKE 'currency.%'").all().map((r) => r.action);
  assert.deepEqual(actions, ['currency.added', 'fx.rate_set']);
  // three-decimal currency converts with its own minor units: KWD 1.000 (1000 fils) = EGP 158.50
  assert.equal(convertAmount(ctx.db, 1000, 'KWD', 'EGP', '2026-01-01'), 15850);
});

test('fx: the mock provider is deterministic and labelled mock', () => {
  const { ctx, as } = setup();
  const a = fx.mockProvider.fetchRates(['USD', 'EUR'], '2026-03-01');
  const b = fx.mockProvider.fetchRates(['USD', 'EUR'], '2026-03-01');
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, fx.mockProvider.fetchRates(['USD', 'EUR'], '2026-03-02'));
  const res = fx.fetchRates(ctx, as('accountant'), { provider: 'mock', date: '2026-03-01', currencies: ['USD', 'EUR'] });
  assert.equal(res.mock, true);
  assert.equal(res.saved.length, 2);
  assert.equal(ctx.db.prepare("SELECT source FROM entities_rates WHERE rate_date = '2026-03-01' AND currency = 'USD'").get().source, 'mock');
  expectError(() => fx.fetchRates(ctx, as('accountant'), { provider: 'nope', date: '2026-03-01' }), 'UNKNOWN_PROVIDER');
  expectError(() => fx.fetchRates(ctx, as('clerk'), { date: '2026-03-01' }), 'FORBIDDEN');
});

test('fx: a foreign line stores the foreign amount and rate; base debit/credit stay in EGP', () => {
  const { ctx, as } = setup();
  rate(ctx, as, 'USD', '2026-01-10', '48.5');
  const e = postEntry(ctx, { userId: 4, date: '2026-01-10', lines: [usdBank(10000), { account: '3000', credit: 485000 }] });
  const l = ctx.db.prepare("SELECT l.* FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? AND a.code = '1000'").get(e.id);
  assert.deepEqual([l.debit, l.currency, l.fx_amount, l.fx_rate], [485000, 'USD', 10000, 48500000]);
  // an explicit base amount is accepted too (the user's own rate), and plain EGP lines keep working
  assert.ok(postEntry(ctx, { userId: 4, date: '2026-01-10', lines: [{ account: '1000', debit: 100, currency: 'USD', fxAmount: 2, rate: 50000000 }, { account: '3000', credit: 100 }] }).id);
  expectError(() => postEntry(ctx, { userId: 4, date: '2026-01-10', lines: [usdBank(10000), { account: '3000', credit: 485001 }] }), 'UNBALANCED');
  expectError(() => postEntry(ctx, { userId: 4, date: '2025-01-01', lines: [usdBank(100), { account: '3000', credit: 4850 }] }), 'NO_RATE');
  expectError(() => postEntry(ctx, { userId: 4, lines: [{ account: '1000', currency: 'USD', fxAmount: 0, side: 'debit' }, { account: '3000', credit: 1 }] }), 'BAD_FX');
  expectError(() => postEntry(ctx, { userId: 4, lines: [{ account: '1000', currency: 'ZZZ', fxAmount: 5, side: 'debit', rate: 1000000 }, { account: '3000', credit: 5 }] }), 'UNKNOWN_CURRENCY');
  assert.ok(trialBalance(ctx.db).balanced);
});

test('fx: rounding differences are refused unless allowRounding, then absorbed and audited', () => {
  const { ctx, as } = setup();
  rate(ctx, as, 'USD', '2026-01-10', '1.5');
  const lines = [
    { account: '5100', currency: 'USD', fxAmount: 1, side: 'debit' },   // 1.5 -> 2
    { account: '5200', currency: 'USD', fxAmount: 1, side: 'debit' },   // 1.5 -> 2
    { account: '1000', currency: 'USD', fxAmount: 2, side: 'credit' },  // 3.0 -> 3
  ];
  expectError(() => postEntry(ctx, { userId: 4, date: '2026-01-10', lines }), 'UNBALANCED');
  const e = postEntry(ctx, { userId: 4, date: '2026-01-10', lines, allowRounding: true });
  assert.equal(accountBalance(ctx.db, '1000').net, 1000000 - 4);
  const audited = JSON.parse(ctx.db.prepare("SELECT new_value FROM audit_log WHERE action = 'entry.posted' AND record_id = ?").get(e.id).new_value);
  assert.equal(audited.roundingAdjust, 1);
  // a difference larger than one unit per derived line is never swallowed
  expectError(() => postEntry(ctx, { userId: 4, date: '2026-01-10', allowRounding: true, lines: [{ account: '5100', currency: 'USD', fxAmount: 1, side: 'debit' }, { account: '1000', credit: 50 }] }), 'UNBALANCED');
  assert.ok(trialBalance(ctx.db).balanced);
});

test('fx revaluation: gain to 4900, loss to 5900, idempotent, reversible, trial balance stays balanced', () => {
  const { ctx, as } = setup();
  const acc = as('accountant');
  rate(ctx, as, 'USD', '2026-01-10', '48.5');
  postEntry(ctx, { userId: 4, date: '2026-01-10', lines: [usdBank(10000), { account: '3000', credit: 485000 }] });
  rate(ctx, as, 'USD', '2026-01-31', '50');
  const gain = fx.revalue(ctx, acc, { asOf: '2026-01-31' });
  assert.equal(gain.gain, 15000);
  assert.deepEqual(gain.adjustments.map((a) => [a.account, a.diff]), [['1000', 15000]]);
  assert.equal(accountBalance(ctx.db, '4900').net, -15000);
  assert.equal(accountBalance(ctx.db, '1000').net, 1000000 + 500000);
  assert.ok(trialBalance(ctx.db).balanced);
  // second run on the same rates: nothing to do
  assert.equal(fx.revalue(ctx, acc, { asOf: '2026-01-31' }).entryId, null);
  // the rate falls: loss against 5900
  rate(ctx, as, 'USD', '2026-02-28', '47');
  const loss = fx.revalue(ctx, acc, { asOf: '2026-02-28' });
  assert.equal(loss.loss, 30000);
  assert.equal(accountBalance(ctx.db, '5900').net, 30000);
  assert.equal(accountBalance(ctx.db, '1000').net, 1000000 + 470000);
  // reversing the loss restores the earlier carrying amount and the foreign balance
  reverseEntry(ctx, 4, loss.entryId, 'Wrong rate used');
  assert.equal(accountBalance(ctx.db, '1000').net, 1000000 + 500000);
  assert.equal(accountBalance(ctx.db, '5900').net, 0);
  assert.ok(trialBalance(ctx.db).balanced);
});

test('fx revaluation: a foreign liability that grows in EGP is a loss; settled balances are written off', () => {
  const { ctx, as } = setup();
  rate(ctx, as, 'USD', '2026-01-10', '48');
  postEntry(ctx, { userId: 4, date: '2026-01-10', lines: [{ account: '5000', debit: 480000 }, { account: '2000', credit: 480000, currency: 'USD', fxAmount: 10000 }] });
  rate(ctx, as, 'USD', '2026-01-31', '49');
  const r = fx.revalue(ctx, as('accountant'), { asOf: '2026-01-31' });
  assert.equal(r.loss, 10000);
  assert.equal(accountBalance(ctx.db, '2000').net, -490000);
  // pay the whole USD 100.00 at 49: foreign balance is zero, the carried amount is already 490000
  postEntry(ctx, { userId: 4, date: '2026-02-01', lines: [{ account: '2000', debit: 490000, currency: 'USD', fxAmount: 10000 }, { account: '1000', credit: 490000 }] });
  assert.equal(fx.revalue(ctx, as('accountant'), { asOf: '2026-02-01' }).entryId, null);
  assert.ok(trialBalance(ctx.db).balanced);
});

test('fx revaluation: needs currency.manage and ledger.post, respects the period lock, leaves nothing behind on failure', () => {
  const { ctx, as } = setup();
  rate(ctx, as, 'USD', '2026-01-10', '48.5');
  postEntry(ctx, { userId: 4, date: '2026-01-10', lines: [usdBank(10000), { account: '3000', credit: 485000 }] });
  rate(ctx, as, 'USD', '2026-01-31', '50');
  expectError(() => fx.revalue(ctx, as('auditor'), { asOf: '2026-01-31' }), 'FORBIDDEN');
  expectError(() => fx.revalue(ctx, as('manager'), { asOf: '2026-01-31' }), 'FORBIDDEN');
  ctx.db.prepare("UPDATE period_lock SET through_date = '2026-01-31', mode = 'hard' WHERE id = 1").run();
  const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n;
  expectError(() => fx.revalue(ctx, as('accountant'), { asOf: '2026-01-31' }), 'PERIOD_LOCKED');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, before);
});

test('fx revaluation works inside a foreign-currency entity (cross rate through EGP)', () => {
  const { ctx, as } = setup();
  const { id } = createEntity(ctx, as('owner'), { code: 'USCO', name: 'US branch', currency: 'USD' });
  rate(ctx, as, 'USD', '2026-01-01', '50');
  rate(ctx, as, 'EUR', '2026-01-01', '55');
  // EUR 100.00 received into a USD-book entity: 55/50 = 1.1 USD per EUR -> USD 110.00
  postEntry(ctx, { userId: 4, entityId: id, date: '2026-01-01', lines: [{ account: '1000', currency: 'EUR', fxAmount: 10000, side: 'debit' }, { account: '3000', credit: 11000 }] });
  assert.equal(accountBalance(ctx.db, '1000', { entityId: id }).net, 11000);
  rate(ctx, as, 'EUR', '2026-01-31', '60'); // 1.2 USD per EUR -> USD 120.00
  const r = fx.revalue(ctx, as('accountant'), { entityId: id, asOf: '2026-01-31' });
  assert.equal(r.gain, 1000);
  assert.equal(trialBalance(ctx.db, { entityId: id }).balanced, true);
});
