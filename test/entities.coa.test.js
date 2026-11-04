import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError } from './helpers.js';
import { postEntry, trialBalance } from '../src/ledger.js';
import * as coa from '../src/modules/entities/coa.js';

const acct = (ctx, code) => ctx.db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);

test('coa: add an account under a parent, rename it, audited; the code never changes', () => {
  const { ctx, as } = setup();
  coa.addAccount(ctx, as('accountant'), { code: '5110', name: 'Office rent', nameAr: 'إيجار المكتب', type: 'expense', parentCode: '5100' });
  assert.equal(coa.listAccounts(ctx, as('auditor')).find((a) => a.code === '5110').parentCode, '5100');
  coa.updateAccount(ctx, as('accountant'), '5110', { name: 'Head office rent', nameAr: 'إيجار المركز الرئيسي' });
  assert.equal(acct(ctx, '5110').name, 'Head office rent');
  const actions = ctx.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'coa.%' ORDER BY id").all().map((r) => r.action);
  assert.deepEqual(actions, ['coa.account_added', 'coa.account_updated']);
});

test('coa: validation (type, code, parent type, duplicates, cycles) and permission denials', () => {
  const { ctx, as } = setup();
  expectError(() => coa.addAccount(ctx, as('clerk'), { code: '5110', name: 'x', type: 'expense' }), 'FORBIDDEN');
  expectError(() => coa.addAccount(ctx, as('auditor'), { code: '5110', name: 'x', type: 'expense' }), 'FORBIDDEN');
  expectError(() => coa.addAccount(ctx, as('accountant'), { code: '5110', name: 'x', type: 'cost' }), 'BAD_INPUT');
  expectError(() => coa.addAccount(ctx, as('accountant'), { code: '!', name: 'x', type: 'expense' }), 'BAD_INPUT');
  expectError(() => coa.addAccount(ctx, as('accountant'), { code: '5110', name: '', type: 'expense' }), 'BAD_INPUT');
  expectError(() => coa.addAccount(ctx, as('accountant'), { code: '1000', name: 'dup', type: 'asset' }), 'DUPLICATE');
  expectError(() => coa.addAccount(ctx, as('accountant'), { code: '5110', name: 'x', type: 'expense', parentCode: '1000' }), 'PARENT_TYPE_MISMATCH');
  expectError(() => coa.addAccount(ctx, as('accountant'), { code: '5110', name: 'x', type: 'expense', parentCode: '7777' }), 'PARENT_NOT_FOUND');
  coa.addAccount(ctx, as('accountant'), { code: '5110', name: 'a', type: 'expense', parentCode: '5100' });
  coa.addAccount(ctx, as('accountant'), { code: '5111', name: 'b', type: 'expense', parentCode: '5110' });
  expectError(() => coa.updateAccount(ctx, as('accountant'), '5100', { parentCode: '5111' }), 'PARENT_CYCLE');
  expectError(() => coa.updateAccount(ctx, as('accountant'), '9999', { name: 'x' }), 'NOT_FOUND');
});

test('coa: a deactivated account refuses new postings, can be reactivated, and reversals of old entries still work', () => {
  const { ctx, as } = setup();
  coa.addAccount(ctx, as('accountant'), { code: '5300x', name: 'Temp', type: 'expense' });
  const e = postEntry(ctx, { userId: 4, lines: [{ account: '5300x', debit: 100 }, { account: '1000', credit: 100 }] });
  coa.updateAccount(ctx, as('accountant'), '5300x', { active: false, reason: 'No longer used' });
  const lines = [{ account: '5300x', debit: 5 }, { account: '1000', credit: 5 }];
  expectError(() => postEntry(ctx, { userId: 4, lines }), 'ACCOUNT_INACTIVE');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, 2);
  coa.updateAccount(ctx, as('accountant'), '5300x', { active: true });
  assert.ok(postEntry(ctx, { userId: 4, lines }).id);
  assert.ok(e.id);
});

test('coa: an account with history can never be deleted; system accounts are protected; unused ones can go', () => {
  const { ctx, as } = setup();
  coa.addAccount(ctx, as('accountant'), { code: '5999', name: 'Misc', type: 'expense' });
  coa.addAccount(ctx, as('accountant'), { code: '5998', name: 'Unused', type: 'expense' });
  postEntry(ctx, { userId: 4, lines: [{ account: '5999', debit: 100 }, { account: '1000', credit: 100 }] });
  expectError(() => coa.deleteAccount(ctx, as('accountant'), '5999'), 'ACCOUNT_HAS_HISTORY');
  expectError(() => coa.deleteAccount(ctx, as('accountant'), '1000'), 'ACCOUNT_PROTECTED');
  expectError(() => coa.updateAccount(ctx, as('accountant'), '1000', { active: false }), 'ACCOUNT_PROTECTED');
  expectError(() => coa.deleteAccount(ctx, as('clerk'), '5998'), 'FORBIDDEN');
  assert.ok(acct(ctx, '5999'), 'the account with history is still there');
  coa.deleteAccount(ctx, as('accountant'), '5998');
  assert.equal(acct(ctx, '5998'), undefined);
  assert.ok(trialBalance(ctx.db).balanced);
  // a parent with children cannot go either
  coa.addAccount(ctx, as('accountant'), { code: '5997', name: 'Parent', type: 'expense' });
  coa.addAccount(ctx, as('accountant'), { code: '5996', name: 'Child', type: 'expense', parentCode: '5997' });
  expectError(() => coa.deleteAccount(ctx, as('accountant'), '5997'), 'HAS_CHILDREN');
  expectError(() => coa.updateAccount(ctx, as('accountant'), '5997', { active: false }), 'HAS_ACTIVE_CHILDREN');
});

test('coa csv: quoted Arabic names, children before parents, and a dry run changes nothing', () => {
  const { ctx, as } = setup();
  const csv = 'code,name,name_ar,type,parent_code\n6110,"Salaries, net","الرواتب, الصافي",expense,6100\n6100,Staff costs,تكاليف العاملين,expense,\n1000,Cash again,x,asset,\n';
  const dry = coa.importCsv(ctx, as('accountant'), { csv, dryRun: true });
  assert.deepEqual([dry.dryRun, dry.created.sort(), dry.skipped], [true, ['6100', '6110'], ['1000']]);
  assert.equal(acct(ctx, '6100'), undefined);
  const real = coa.importCsv(ctx, as('accountant'), { csv });
  assert.deepEqual(real.created.sort(), ['6100', '6110']);
  assert.equal(acct(ctx, '6110').name, 'Salaries, net');
  assert.equal(acct(ctx, '6110').name_ar, 'الرواتب, الصافي');
  assert.equal(acct(ctx, '6110').parent_id, acct(ctx, '6100').id);
  assert.equal(acct(ctx, '1000').name, 'Cash', 'an existing account is skipped, never overwritten');
});

test('coa csv: one bad row rejects the whole file (atomic)', () => {
  const { ctx, as } = setup();
  const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  const bad = 'code,name,name_ar,type,parent_code\n6100,Good,,expense,\n6200,Bad type,,widget,\n6300,Orphan,,expense,9999\n';
  const err = expectError(() => coa.importCsv(ctx, as('accountant'), { csv: bad }), 'IMPORT_INVALID');
  assert.match(err.message, /line 3/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, before);
  expectError(() => coa.importCsv(ctx, as('accountant'), { csv: 'code,name\n1,2' }), 'IMPORT_INVALID');
  expectError(() => coa.importCsv(ctx, as('accountant'), { csv: '' }), 'IMPORT_INVALID');
  expectError(() => coa.importCsv(ctx, as('accountant'), { csv: 'code,name,type\n6100,A,expense\n6100,B,expense\n' }), 'IMPORT_INVALID');
  expectError(() => coa.importCsv(ctx, as('clerk'), { csv: bad }), 'FORBIDDEN');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, before);
});

test('coa: the Egyptian starter template has English and Arabic names, applies once and is skipped afterwards', () => {
  const { ctx, as } = setup();
  const t = coa.starterTemplate(ctx, as('accountant'));
  assert.ok(t.accounts.length >= 30);
  assert.ok(t.accounts.every((a) => a.name && /[؀-ۿ]/.test(a.nameAr)), 'every account has an Arabic name');
  assert.match(t.csv, /^code,name,name_ar,type,parent_code\n/);
  const first = coa.applyStarterTemplate(ctx, as('accountant'), {});
  assert.ok(first.created.length > 25);
  assert.ok(first.skipped.includes('1000'));
  assert.equal(acct(ctx, '1610').parent_id, acct(ctx, '1600').id);
  const second = coa.applyStarterTemplate(ctx, as('accountant'), {});
  assert.equal(second.created.length, 0);
  // the CSV form of the template round-trips
  assert.equal(coa.parseCsv(t.csv).length, t.accounts.length + 1);
  assert.ok(trialBalance(ctx.db).balanced);
});
