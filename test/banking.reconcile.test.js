import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, expectError } from './helpers.js';
import { createApp } from '../src/server.js';
import { bank, b, MAP, csv } from './banking.fixtures.js';
import { postEntry } from '../src/ledger.js';

test('reconciliation: statement vs ledger balance, difference, unreconciled count, and explained difference', () => {
  const { ctx, acct, accountant, load, lines } = bank();
  // ledger: 1,000.00 in, 200.00 out
  postEntry(ctx, { userId: 4, date: '2026-03-01', memo: 'Deposit', lines: [{ account: '1010', debit: 100000 }, { account: '3000', credit: 100000 }] });
  postEntry(ctx, { userId: 4, date: '2026-03-02', memo: 'Cheque 77', lines: [{ account: '5100', debit: 20000 }, { account: '1010', credit: 20000 }] });
  // statement: deposit 1,000.00 and a fee 15.00 the books do not know yet
  load([['2026-03-01', 'Deposit', 'd', '1000.00'], ['2026-03-04', 'Fee', 'f', '-15.00']]);
  const dep = lines().find((l) => l.amount === 100000);
  b.acceptMatch(ctx, accountant, dep.id, { kind: 'ledger', refId: b.suggestionsFor(ctx, ctx.db.prepare('SELECT * FROM bank_lines WHERE id = ?').get(dep.id))[0].refId });
  let s = b.summary(ctx, accountant, { accountId: acct.id, date: '2026-03-31' });
  assert.equal(s.statementBalance, 100000 - 1500);
  assert.equal(s.ledgerBalance, 100000 - 20000);
  assert.equal(s.difference, 98500 - 80000);
  assert.deepEqual(s.unreconciledLines, { count: 1, total: -1500 });
  assert.deepEqual(s.unreconciledLedger, { count: 1, total: -20000 });
  assert.equal(s.explainedByUnmatched, -1500 + 20000);
  assert.equal(s.unexplained, 0, 'the whole difference is explained by the unmatched items');
  assert.equal(s.reconciled, false);
  // as-of date excludes later items
  s = b.summary(ctx, accountant, { accountId: acct.id, date: '2026-03-01' });
  assert.equal(s.unreconciledLines.count, 0);
  assert.equal(s.difference, 0);
  expectError(() => b.summary(ctx, accountant, { accountId: acct.id, date: 'tomorrow' }), 'BAD_DATE');
});

test('reconciliation: report lists matched and unmatched items; sign-off needs a note unless clean', () => {
  const { ctx, acct, as, accountant, load, lines } = bank();
  load([['2026-03-04', 'Fee', 'f', '-15.00']]);
  let rep = b.report(ctx, as('auditor'), { accountId: acct.id, date: '2026-03-31' });
  assert.equal(rep.unreconciledLines.length, 1);
  assert.match(rep.note, /not implemented/);
  expectError(() => b.signoff(ctx, accountant, { accountId: acct.id, date: '2026-03-31' }), 'NOTE_REQUIRED');
  b.createEntryFromLine(ctx, accountant, lines()[0].id, { accountCode: '5200' });
  rep = b.report(ctx, as('auditor'), { accountId: acct.id, date: '2026-03-31' });
  assert.equal(rep.reconciled.length, 1);
  assert.equal(rep.summary.difference, rep.summary.statementBalance - rep.summary.ledgerBalance);
  // statement opening balance (0) vs ledger (-15.00 from the entry) -> opening gap is shown as unexplained, so set the opening balance
  b.updateAccount(ctx, accountant, acct.id, { openingBalance: 0 });
  const so = b.signoff(ctx, accountant, { accountId: acct.id, date: '2026-03-31' });
  assert.equal(so.clean, true);
  assert.equal(b.report(ctx, accountant, { accountId: acct.id }).signoffs.length, 1);
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'banking.signoff'").get());
});

test('reconciliation: widget shows unreconciled count and difference only to banking.view', () => {
  const { ctx, as, load } = bank();
  load([['2026-03-04', 'Fee', 'f', '-15.00'], ['2026-03-05', 'Dep', 'd', '40.00']]);
  const w = b.widgets(ctx, as('manager')).banking;
  assert.equal(w.unreconciled, 2);
  assert.equal(w.difference, 2500, 'statement 25.00 vs empty bank ledger');
  assert.deepEqual(b.widgets(ctx, as('clerk')), {});
  assert.ok(b.widgets(ctx, as('auditor')).banking, 'auditor can read');
});

test('permissions: read-only roles cannot import, reconcile or edit rules; clerk cannot even read', () => {
  const { ctx, as, acct, accountant, load, lines } = bank();
  load([['2026-03-04', 'Fee', 'f', '-15.00']]);
  const id = lines()[0].id;
  for (const who of ['manager', 'auditor', 'clerk']) {
    const u = as(who);
    expectError(() => b.createAccount(ctx, u, { name: 'x', type: 'cash' }), 'FORBIDDEN');
    expectError(() => b.createImport(ctx, u, { accountId: acct.id, csv: csv([]), mapping: MAP }), 'FORBIDDEN');
    expectError(() => b.rollbackImport(ctx, u, 1, { reason: 'x' }), 'FORBIDDEN');
    expectError(() => b.acceptMatch(ctx, u, id, { kind: 'rule', refId: 1 }), 'FORBIDDEN');
    expectError(() => b.createEntryFromLine(ctx, u, id, { accountCode: '5200' }), 'FORBIDDEN');
    expectError(() => b.unreconcile(ctx, u, id, { reason: 'x' }), 'FORBIDDEN');
    expectError(() => b.setMethod(ctx, u, id, { method: 'card' }), 'FORBIDDEN');
    expectError(() => b.createRule(ctx, u, { name: 'r', pattern: 'x', accountCode: '5200' }), 'FORBIDDEN');
    expectError(() => b.signoff(ctx, u, { accountId: acct.id }), 'FORBIDDEN');
  }
  expectError(() => b.listLines(ctx, as('clerk'), {}), 'FORBIDDEN');
  assert.equal(b.listLines(ctx, as('manager'), { accountId: acct.id }).length, 1, 'manager has view-only access');
  assert.equal(b.report(ctx, as('auditor'), { accountId: acct.id }).summary.accountId, acct.id);
  assert.ok(accountant.permissions.has('banking.import') && accountant.permissions.has('banking.rules'));
  assert.equal(lines('reconciled').length, 0, 'nothing changed');
});

test('http: full flow over the API with permission checks and 4xx errors', async () => {
  const { ctx, acct } = bank();
  const { server, call } = await startApp(createApp, ctx);
  try {
    const body = { accountId: acct.id, csv: csv([['2026-04-01', 'Fee', 'f', '-9.50'], ['bad', 'x', 'y', '1']]), mapping: MAP, filename: 'apr.csv' };
    assert.equal((await call('POST', '/api/banking/imports', 3, body)).status, 403, 'clerk');
    assert.equal((await call('POST', '/api/banking/imports', 2, body)).status, 403, 'manager is view-only');
    const prev = await call('POST', '/api/banking/imports', 4, body);
    assert.equal(prev.status, 201);
    assert.equal(prev.body.errors[0].row, 3);
    const bid = prev.body.id;
    assert.equal((await call('POST', `/api/banking/imports/${bid}/commit`, 4, {})).body.error.code, 'HAS_ERRORS');
    assert.equal((await call('POST', `/api/banking/imports/${bid}/commit`, 4, { skipErrors: true })).status, 201);
    const q = await call('GET', `/api/banking/queue?accountId=${acct.id}`, 2);
    assert.equal(q.status, 200);
    assert.equal(q.body.length, 1);
    const lineId = q.body[0].line.id;
    assert.equal((await call('POST', `/api/banking/lines/${lineId}/create-entry`, 2, { accountCode: '5200' })).status, 403);
    assert.equal((await call('POST', `/api/banking/lines/${lineId}/create-entry`, 4, { accountCode: '5200' })).status, 201);
    const rec = await call('GET', `/api/banking/reconciliation?accountId=${acct.id}`, 5);
    assert.equal(rec.status, 200);
    assert.equal(rec.body.unreconciledLines.count, 0);
    assert.equal((await call('GET', `/api/banking/reconciliation?accountId=${acct.id}`, 3)).status, 403);
    const rule = await call('POST', '/api/banking/rules/test', 4, { rule: { name: 't', matchType: 'contains', pattern: 'fee', accountCode: '5200' } });
    assert.equal(rule.body.matchCount, 1);
    assert.equal((await call('POST', '/api/banking/rules/test', 2, { rule: {} })).status, 403);
    const home = await call('GET', '/api/home', 2);
    assert.ok(home.body.widgets.banking);
    assert.equal((await call('GET', '/api/home', 3)).body.widgets.banking, undefined);
    assert.equal((await call('GET', '/api/banking/imports/999', 4)).status, 404);
  } finally { server.close(); }
});

test('data: nothing in banking ever deletes rows; ledger stays balanced after a busy session', () => {
  const { ctx, accountant, load, lines } = bank();
  load([['2026-03-01', 'Fee a', '1', '-1'], ['2026-03-02', 'Fee b', '2', '-2']]);
  const ids = lines().map((l) => l.id);
  b.createEntryFromLine(ctx, accountant, ids[0], { accountCode: '5200' });
  b.unreconcile(ctx, accountant, ids[0], { reason: 'redo' });
  b.createEntryFromLine(ctx, accountant, ids[0], { accountCode: '5200' });
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM bank_lines').get().n, 2);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM bank_matches').get().n, 2);
  assert.equal(ctx.db.prepare('SELECT SUM(debit) - SUM(credit) AS d FROM journal_lines').get().d, 0);
});
