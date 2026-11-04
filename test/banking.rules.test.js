import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectError } from './helpers.js';
import { bank, b, journalOn } from './banking.fixtures.js';

test('rules: contains and regex with amount range; priority decides which rule wins', () => {
  const { ctx, accountant, load, lines } = bank();
  b.createRule(ctx, accountant, { name: 'Generic fee', priority: 200, matchType: 'contains', pattern: 'fee', accountCode: '5200', memo: 'Fees (generic)' });
  const small = b.createRule(ctx, accountant, { name: 'Small SMS fee', priority: 10, matchType: 'regex', pattern: '^sms\\s+fee', direction: 'out', minAmount: 100, maxAmount: 500, accountCode: '5100', memo: 'SMS' });
  load([['2026-02-01', 'SMS FEE feb', 'a', '-2.00'], ['2026-02-02', 'SMS FEE big', 'b', '-50.00'], ['2026-02-03', 'Salary', 'c', '-9.00']]);
  const byDesc = (d) => lines().find((l) => l.description === d);
  assert.equal(b.lineSuggestions(ctx, accountant, byDesc('SMS FEE feb').id).suggestions.find((s) => s.kind === 'rule').refId, small.id);
  const bigRule = b.lineSuggestions(ctx, accountant, byDesc('SMS FEE big').id).suggestions.find((s) => s.kind === 'rule');
  assert.equal(bigRule.accountCode, '5200', 'amount out of range: falls through to the generic rule');
  assert.equal(b.lineSuggestions(ctx, accountant, byDesc('Salary').id).suggestions.length, 0);
});

test('rules: accepting a rule suggestion posts the rule account and memo', () => {
  const { ctx, accountant, load, lines } = bank();
  const r = b.createRule(ctx, accountant, { name: 'Interest', matchType: 'contains', pattern: 'interest', direction: 'in', accountCode: '4000', memo: 'Bank interest', method: 'bank_transfer' });
  load([['2026-02-28', 'INTEREST PAID', 'i', '3.21']]);
  const l = lines()[0];
  const m = b.acceptMatch(ctx, accountant, l.id, { kind: 'rule', refId: r.id });
  assert.equal(m.kind, 'rule');
  const j = journalOn(ctx, '1010')[0];
  assert.equal(j.memo, 'Bank interest');
  assert.equal(j.debit, 321);
  assert.equal(lines('reconciled')[0].method, 'bank_transfer', 'rule method tag applied');
});

test('rules: create-entry with no account and no matching rule is refused', () => {
  const { ctx, accountant, load, lines } = bank();
  load([['2026-02-28', 'Mystery', 'm', '-3.00']]);
  expectError(() => b.createEntryFromLine(ctx, accountant, lines()[0].id, {}), 'NO_RULE_MATCH');
});

test('rules: test endpoint checks a sample and counts existing lines without saving anything', () => {
  const { ctx, accountant, load } = bank();
  load([['2026-02-01', 'Fawry payment 1', 'a', '-10'], ['2026-02-02', 'Fawry payment 2', 'b', '-20'], ['2026-02-03', 'Other', 'c', '-30']]);
  const rule = { name: 't', matchType: 'contains', pattern: 'FAWRY', accountCode: '5200' };
  const out = b.testRule(ctx, accountant, { rule, sample: { description: 'my fawry', amount: -100 } });
  assert.equal(out.sample.matches, true);
  assert.equal(out.matchCount, 2);
  assert.equal(b.listRules(ctx, accountant).length, 0, 'testing does not save');
  assert.equal(b.testRule(ctx, accountant, { rule: { ...rule, direction: 'in' }, sample: { description: 'fawry', amount: -1 } }).sample.matches, false);
});

test('rules: validation (bad regex, nested quantifiers, unknown account, bad range) and archive/edit are audited', () => {
  const { ctx, accountant } = bank();
  const base = { name: 'r', matchType: 'regex', pattern: 'ok', accountCode: '5200' };
  expectError(() => b.createRule(ctx, accountant, { ...base, pattern: '([' }), 'BAD_REGEX');
  expectError(() => b.createRule(ctx, accountant, { ...base, pattern: '(a+)+$' }), 'BAD_REGEX');
  expectError(() => b.createRule(ctx, accountant, { ...base, accountCode: '9999' }), 'UNKNOWN_ACCOUNT');
  expectError(() => b.createRule(ctx, accountant, { ...base, minAmount: 500, maxAmount: 100 }), 'BAD_INPUT');
  expectError(() => b.createRule(ctx, accountant, { ...base, method: 'barter' }), 'BAD_METHOD');
  expectError(() => b.createRule(ctx, accountant, { ...base, name: '' }), 'BAD_INPUT');
  const r = b.createRule(ctx, accountant, base);
  const u = b.updateRule(ctx, accountant, r.id, { priority: 5, memo: 'new' });
  assert.deepEqual([u.priority, u.memo, u.pattern], [5, 'new', 'ok']);
  assert.equal(b.archiveRule(ctx, accountant, r.id).active, false);
  const actions = ctx.db.prepare("SELECT action FROM audit_log WHERE record_type = 'bank_rule'").all().map((a) => a.action);
  assert.deepEqual(actions, ['banking.rule_created', 'banking.rule_updated', 'banking.rule_updated']);
});

test('payment methods: tags are validated, audited, and settable from a CSV column', () => {
  const { ctx, acct, accountant, lines } = bank();
  const text = 'Date,Description,Amount,Channel\n2026-02-01,A,10,InstaPay\n2026-02-02,B,20,Fawry kiosk\n2026-02-03,C,30,\n';
  const p = b.createImport(ctx, accountant, { accountId: acct.id, csv: text, mapping: { dateCol: 'Date', descriptionCol: 'Description', amountCol: 'Amount', methodCol: 'Channel', defaultMethod: 'bank transfer' } });
  b.commitImport(ctx, accountant, p.id);
  const by = Object.fromEntries(lines().map((l) => [l.description, l.method]));
  assert.deepEqual(by, { A: 'instapay', B: 'fawry', C: 'bank_transfer' });
  const c = lines().find((l) => l.description === 'C');
  assert.equal(b.setMethod(ctx, accountant, c.id, { method: 'card' }).method, 'card');
  expectError(() => b.setMethod(ctx, accountant, c.id, { method: 'barter' }), 'BAD_METHOD');
  assert.equal(b.setMethod(ctx, accountant, c.id, { method: '' }).method, null);
  assert.equal(b.listLines(ctx, accountant, { accountId: acct.id, state: 'all', method: 'instapay' }).length, 1);
});
