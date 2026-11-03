import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError } from './helpers.js';
import * as s from '../src/services.js';
import { sodConflicts } from '../src/permissions.js';
import { postEntry } from '../src/ledger.js';

const EGP = 100;

test('role permissions gate actions', () => {
  const { ctx, as } = setup();
  expectError(() => s.reports(ctx, as('clerk')), 'FORBIDDEN');
  expectError(() => s.reverse(ctx, as('clerk'), 1, 'x'), 'FORBIDDEN');
  expectError(() => s.createInvoice(ctx, as('auditor'), { customer: 'A', lines: [{ description: 'x', qty: 1, unitPrice: 100 }] }), 'FORBIDDEN');
  expectError(() => s.lockPeriod(ctx, as('accountant'), { through: '2026-01-01', mode: 'hard', reason: 'x' }), 'FORBIDDEN');
  assert.ok(s.reports(ctx, as('auditor')).trialBalance.balanced);
});

test('the auditor is read-only everywhere but can read the audit log', () => {
  const { ctx, as } = setup();
  const a = as('auditor');
  for (const p of ['sales.create', 'purchases.create', 'purchases.approve', 'ledger.post', 'ledger.reverse', 'period.lock', 'users.manage', 'export.all']) {
    assert.ok(!a.permissions.has(p), p);
  }
  assert.ok(s.auditSearch(ctx, a).length > 0);
});

test('sensitive areas are separate grants: nobody gets payroll or bank balances by accident', () => {
  const { ctx, as } = setup();
  assert.ok(!as('manager').permissions.has('payroll.view'));
  assert.ok(!as('clerk').permissions.has('banking.view'));
  assert.equal(s.home(ctx, as('clerk')).widgets.cash, undefined);
  assert.ok(s.home(ctx, as('manager')).widgets.cash);
  assert.equal(s.home(ctx, as('admin')).widgets.cash, undefined); // admins do not see money
  assert.equal(s.home(ctx, as('admin')).widgets.receivables, undefined);
});

test('bills: amount limits, auto-approval, and the creator cannot approve their own bill', () => {
  const { ctx, as } = setup();
  const clerk = as('clerk'), manager = as('manager'), owner = as('owner');
  expectError(() => s.createBill(ctx, manager, { supplier: 'S', amount: 100, category: 'rent' }), 'FORBIDDEN'); // managers approve, they do not create

  expectError(() => s.createBill(ctx, clerk, { supplier: 'S', amount: 6000 * EGP, category: 'rent' }), 'OVER_LIMIT');

  const small = s.createBill(ctx, clerk, { supplier: 'Cleaner', amount: 500 * EGP, category: 'utilities' });
  assert.equal(small.status, 'approved'); // under the 1,000 EGP auto-approve threshold

  const big = s.createBill(ctx, clerk, { supplier: 'Landlord', amount: 4000 * EGP, category: 'rent' });
  assert.equal(big.status, 'pending_approval');
  assert.equal(ctx.db.prepare('SELECT entry_id FROM bills WHERE id = ?').get(big.id).entry_id, null); // nothing posted yet

  // even the owner, who holds both permissions, cannot approve a bill they created themselves
  const mine = s.createBill(ctx, owner, { supplier: 'Self', amount: 3000 * EGP, category: 'rent' });
  expectError(() => s.approveBill(ctx, owner, mine.id), 'SEPARATION_OF_DUTIES');
  assert.ok(s.approveBill(ctx, manager, mine.id).entryId); // a second person can

  assert.ok(s.approveBill(ctx, manager, big.id).entryId);
  assert.equal(ctx.db.prepare('SELECT approved_by FROM bills WHERE id = ?').get(big.id).approved_by, manager.id);

  // above the manager's 20,000 EGP limit only the owner can approve
  const huge = s.createBill(ctx, owner, { supplier: 'Equipment', amount: 30000 * EGP, category: 'purchases' });
  expectError(() => s.approveBill(ctx, manager, huge.id), 'OVER_LIMIT');
});

test('roles can be created and cloned, and separation-of-duties conflicts are flagged', () => {
  const { ctx, as } = setup();
  const admin = as('admin');
  const risky = s.createRole(ctx, admin, { name: 'shop-lead', permissions: ['purchases.create', 'purchases.approve', 'sales.create'], limits: { 'purchases.approve': 100000 } });
  assert.equal(risky.sodWarnings.length, 1);
  assert.deepEqual(risky.sodWarnings[0].pair, ['purchases.create', 'purchases.approve']);
  const safe = s.createRole(ctx, admin, { name: 'cashier-plus', permissions: ['sales.create', 'sales.view', 'banking.view'] }); // clerk who can also see the till
  assert.equal(safe.sodWarnings.length, 0);
  expectError(() => s.createRole(ctx, admin, { name: 'bad', permissions: ['made.up'] }), 'BAD_INPUT');
  expectError(() => s.createRole(ctx, as('manager'), { name: 'x', permissions: [] }), 'FORBIDDEN');

  // assigning the custom role changes what the user sees: home views follow permissions
  const before = Object.keys(s.home(ctx, as('clerk')).widgets).sort();
  const res = s.setUserRole(ctx, admin, 3, safe.id);
  assert.equal(res.role, 'cashier-plus');
  const after = Object.keys(s.home(ctx, as('clerk')).widgets).sort();
  assert.ok(!before.includes('cash') && after.includes('cash'));
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'user.role_changed'").get());
});

test('built-in roles: only the owner holds every separation-of-duties conflict', () => {
  const { ctx, as } = setup();
  const roles = s.listRoles(ctx, as('admin'));
  const warned = roles.filter((r) => r.sodWarnings.length).map((r) => r.name);
  assert.deepEqual(warned, ['owner']);
  assert.equal(sodConflicts(['ledger.post', 'period.lock']).length, 1);
});

test('home views differ by role and are built from permissions', () => {
  const { ctx, as } = setup();
  const keys = (n) => Object.keys(s.home(ctx, as(n)).widgets);
  assert.ok(keys('manager').includes('approvals'));
  assert.ok(keys('clerk').includes('myWork'));
  assert.ok(keys('accountant').includes('ledger'));
  assert.ok(keys('auditor').includes('audit'));
  assert.ok(!keys('auditor').includes('myWork'));
  assert.ok(keys('admin').includes('admin'));
  assert.ok(keys('admin').includes('eta'));
});

test('invoices post balanced entries with 14% VAT and can be paid once', () => {
  const { ctx, as } = setup();
  const inv = s.createInvoice(ctx, as('clerk'), { customer: 'Cafe Nile', lines: [{ description: 'Tea', qty: 10, unitPrice: 4500 }] });
  assert.equal(inv.subtotal, 45000);
  assert.equal(inv.vat, 6300);
  assert.equal(inv.total, 51300);
  assert.match(inv.number, /^INV-\d{4}$/);
  const paid = s.payInvoice(ctx, as('clerk'), inv.id);
  assert.ok(paid.entryId);
  expectError(() => s.payInvoice(ctx, as('clerk'), inv.id), 'ALREADY_PAID');
  assert.ok(s.reports(ctx, as('owner')).trialBalance.balanced);
});

test('a hard-locked period also blocks invoices dated inside it, atomically', () => {
  const { ctx, as } = setup();
  s.lockPeriod(ctx, as('manager'), { through: '2026-12-31', mode: 'hard', reason: 'Year closed' });
  const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n;
  expectError(() => s.createInvoice(ctx, as('clerk'), { customer: 'X', date: '2026-06-01', lines: [{ description: 'x', qty: 1, unitPrice: 100 }] }), 'PERIOD_LOCKED');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n, before);
});

test('full export includes the audit log and complete history', () => {
  const { ctx, as } = setup();
  s.quickSale(ctx, as('clerk'), { items: [{ sku: 'TEA-250', qty: 1 }] });
  expectError(() => s.exportAll(ctx, as('clerk')), 'FORBIDDEN');
  const dump = s.exportAll(ctx, as('admin'));
  assert.ok(dump.audit_log.length > 0 && dump.journal_lines.length > 0 && dump.receipts.length === 1);
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'data.exported'").get());
});

test('manual entries need the ledger.post permission', () => {
  const { ctx, as } = setup();
  const lines = [{ account: '5100', debit: 100 }, { account: '1000', credit: 100 }];
  expectError(() => s.manualEntry(ctx, as('clerk'), { lines }), 'FORBIDDEN');
  assert.ok(s.manualEntry(ctx, as('accountant'), { lines }).id);
  assert.ok(postEntry);
});
