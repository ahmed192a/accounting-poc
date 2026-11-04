import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError } from './helpers.js';
import * as purchases from '../src/modules/purchases/service.js';
import * as eng from '../src/modules/approvals/engine.js';
import * as rules from '../src/modules/approvals/rules.js';
import * as del from '../src/modules/approvals/delegations.js';
import * as notes from '../src/modules/approvals/notifications.js';
import { isoDate } from '../src/ledger.js';

const EGP = 100;
const HOUR = 3600000, DAY = 24 * HOUR;
const bill = (ctx, user, egp = 3000, extra = {}) => purchases.createBill(ctx, user, { supplier: 'Acme', amount: egp * EGP, category: 'rent', ...extra });
const entries = (ctx) => ctx.db.prepare("SELECT COUNT(*) n FROM journal_entries WHERE source_type = 'bill'").get().n;
const reqOf = (ctx, billId) => ctx.db.prepare("SELECT id FROM approvals_requests WHERE doc_type='bill' AND doc_id=? ORDER BY id DESC").get(billId).id;
const mgrThenOwner = (ctx, as, mode = 'sequential', extra = {}) => rules.createRule(ctx, as('owner'), {
  name: 'Two steps', minAmount: 100000, mode, priority: 10,
  steps: [{ approverType: 'role', approverRef: 'manager', ...extra }, { approverType: 'role', approverRef: 'owner' }],
});

test('default rule keeps the single-approver behaviour', () => {
  const { ctx, as } = setup();
  const b = bill(ctx, as('clerk'));
  assert.equal(b.status, 'pending_approval');
  const r = purchases.approveBill(ctx, as('manager'), b.id);
  assert.equal(r.status, 'approved');
  assert.ok(r.entryId);
  assert.equal(entries(ctx), 1);
});

test('sequential steps: ledger entry only after the last step, in order', () => {
  const { ctx, as } = setup();
  mgrThenOwner(ctx, as);
  const b = bill(ctx, as('clerk'));
  const id = reqOf(ctx, b.id);
  expectError(() => eng.approveStep(ctx, as('owner'), id), 'NOT_AN_APPROVER'); // step 2 not open yet
  const first = purchases.approveBill(ctx, as('manager'), b.id);
  assert.equal(first.status, 'pending_approval');
  assert.equal(entries(ctx), 0);
  assert.equal(ctx.db.prepare('SELECT status FROM bills WHERE id = ?').get(b.id).status, 'pending_approval');
  const last = purchases.approveBill(ctx, as('owner'), b.id);
  assert.equal(last.status, 'approved');
  assert.ok(last.entryId);
  assert.equal(entries(ctx), 1);
  assert.equal(ctx.db.prepare('SELECT approved_by FROM bills WHERE id = ?').get(b.id).approved_by, 1);
});

test('parallel steps: any order, completes only when all are approved', () => {
  const { ctx, as } = setup();
  mgrThenOwner(ctx, as, 'parallel');
  const b = bill(ctx, as('clerk'));
  assert.equal(purchases.approveBill(ctx, as('owner'), b.id).status, 'pending_approval');
  assert.equal(entries(ctx), 0);
  assert.equal(purchases.approveBill(ctx, as('manager'), b.id).status, 'approved');
  assert.equal(entries(ctx), 1);
});

test('separation of duties: creator cannot approve at any step', () => {
  const { ctx, as } = setup();
  mgrThenOwner(ctx, as);
  const b = bill(ctx, as('owner'), 3000); // owner creates
  purchases.approveBill(ctx, as('manager'), b.id);
  expectError(() => purchases.approveBill(ctx, as('owner'), b.id), 'SEPARATION_OF_DUTIES'); // step 2
  assert.equal(entries(ctx), 0);
});

test('separation of duties: nobody approves two steps of one request', () => {
  const { ctx, as } = setup();
  rules.createRule(ctx, as('owner'), { name: 'Two perms', minAmount: 100000, mode: 'parallel', priority: 10,
    steps: [{ approverType: 'role', approverRef: 'manager' }, { approverType: 'permission', approverRef: 'purchases.approve' }] });
  const b = bill(ctx, as('clerk'));
  purchases.approveBill(ctx, as('manager'), b.id);
  expectError(() => purchases.approveBill(ctx, as('manager'), b.id), 'SEPARATION_OF_DUTIES');
  assert.equal(purchases.approveBill(ctx, as('owner'), b.id).status, 'approved');
});

test('step amount limit and personal limit are enforced', () => {
  const { ctx, as } = setup();
  rules.createRule(ctx, as('owner'), { name: 'Limited', minAmount: 100000, priority: 10, steps: [{ approverType: 'role', approverRef: 'manager', maxAmount: 2000 * EGP }] });
  const b = bill(ctx, as('clerk'), 3000);
  expectError(() => purchases.approveBill(ctx, as('manager'), b.id), 'OVER_LIMIT');
  const huge = purchases.createBill(ctx, as('owner'), { supplier: 'X', amount: 30000 * EGP, category: 'purchases' });
  rules.createRule(ctx, as('owner'), { name: 'Big', minAmount: 2000000, priority: 20, steps: [{ approverType: 'role', approverRef: 'manager' }] });
  const huge2 = purchases.createBill(ctx, as('owner'), { supplier: 'X', amount: 30000 * EGP, category: 'purchases' });
  expectError(() => purchases.approveBill(ctx, as('manager'), huge2.id), 'OVER_LIMIT'); // manager's own 20,000 limit
  assert.ok(huge.id);
});

test('rule matching: category and supplier narrow the rule, priority wins', () => {
  const { ctx, as } = setup();
  const sup = ctx.db.prepare("SELECT id FROM purchases_suppliers WHERE name = 'Delta Trading'").get().id;
  const a = rules.createRule(ctx, as('owner'), { name: 'Rent', category: 'rent', minAmount: 100000, priority: 5, steps: [{ approverType: 'role', approverRef: 'owner' }] });
  const c = rules.createRule(ctx, as('owner'), { name: 'Delta', supplierId: sup, minAmount: 100000, priority: 5, steps: [{ approverType: 'role', approverRef: 'manager' }] });
  assert.equal(rules.pickRule(ctx, { docType: 'bill', amount: 300000, category: 'rent', supplierId: null }).id, a.id);
  assert.equal(rules.pickRule(ctx, { docType: 'bill', amount: 300000, category: 'utilities', supplierId: sup }).id, c.id);
  assert.equal(rules.pickRule(ctx, { docType: 'bill', amount: 300000, category: 'utilities', supplierId: null }).is_default, 1);
  assert.equal(rules.pickRule(ctx, { docType: 'bill', amount: 5000, category: 'rent', supplierId: null }).is_default, 1); // below min
});

test('rule validation and permission', () => {
  const { ctx, as } = setup();
  const ok = { name: 'R', steps: [{ approverType: 'role', approverRef: 'manager' }] };
  expectError(() => rules.createRule(ctx, as('manager'), ok), 'FORBIDDEN');
  expectError(() => rules.createRule(ctx, as('owner'), { ...ok, steps: [] }), 'BAD_INPUT');
  expectError(() => rules.createRule(ctx, as('owner'), { ...ok, steps: [{ approverType: 'role', approverRef: 'nope' }] }), 'UNKNOWN_ROLE');
  expectError(() => rules.createRule(ctx, as('owner'), { ...ok, minAmount: 10, maxAmount: 5 }), 'BAD_RANGE');
  expectError(() => rules.createRule(ctx, as('owner'), { ...ok, steps: [{ approverType: 'user', approverRef: 2 }, { approverType: 'user', approverRef: 2 }] }), 'DUPLICATE_APPROVER');
  expectError(() => rules.createRule(ctx, as('owner'), { ...ok, mode: 'chaotic' }), 'BAD_INPUT');
});

test('rejection needs a reason, ends the request, skips the other steps and notifies the creator', () => {
  const { ctx, as } = setup();
  mgrThenOwner(ctx, as);
  const b = bill(ctx, as('clerk'));
  expectError(() => purchases.rejectBill(ctx, as('manager'), b.id, {}), 'REASON_REQUIRED');
  purchases.rejectBill(ctx, as('manager'), b.id, { reason: 'Wrong amount' });
  const row = ctx.db.prepare('SELECT status, reject_reason FROM bills WHERE id = ?').get(b.id);
  assert.deepEqual({ ...row }, { status: 'rejected', reject_reason: 'Wrong amount' });
  assert.equal(entries(ctx), 0);
  const d = eng.getRequestDetail(ctx, as('manager'), reqOf(ctx, b.id));
  assert.equal(d.status, 'rejected');
  assert.deepEqual(d.steps.map((s) => s.status), ['rejected', 'skipped']);
  assert.ok(d.history.some((h) => h.action === 'step_rejected'));
  expectError(() => purchases.approveBill(ctx, as('owner'), b.id), 'NOT_PENDING');
  assert.ok(notes.listNotifications(ctx, as('clerk')).items.some((n) => n.kind === 'rejected'));
});

test('full history and notifications are recorded and private', () => {
  const { ctx, as } = setup();
  const b = bill(ctx, as('clerk'));
  assert.ok(notes.listNotifications(ctx, as('manager')).items.some((n) => n.kind === 'approval_needed'));
  assert.equal(notes.listNotifications(ctx, as('clerk')).items.length, 0);
  purchases.approveBill(ctx, as('manager'), b.id);
  const d = eng.getRequestDetail(ctx, as('auditor'), reqOf(ctx, b.id));
  assert.deepEqual(d.history.map((h) => h.action), ['submitted', 'step_activated', 'step_approved', 'completed']);
  const mine = notes.listNotifications(ctx, as('manager')).items[0];
  expectError(() => notes.markRead(ctx, as('clerk'), mine.id), 'NOT_FOUND');
  notes.markRead(ctx, as('manager'), mine.id);
  assert.ok(notes.listNotifications(ctx, as('manager')).unread >= 0);
  assert.equal(notes.markAllRead(ctx, as('manager')).marked >= 0, true);
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'approvals.step_approved'").get());
});

test('delegation: delegate approves on behalf only inside the date window (ctx.now)', () => {
  const { ctx, as } = setup();
  rules.createRule(ctx, as('owner'), { name: 'Owner only', minAmount: 100000, priority: 10, steps: [{ approverType: 'role', approverRef: 'owner' }] });
  const today = isoDate(ctx.now());
  const b = bill(ctx, as('clerk'));
  expectError(() => purchases.approveBill(ctx, as('accountant'), b.id), 'FORBIDDEN'); // no permission, no delegation
  expectError(() => del.createDelegation(ctx, as('clerk'), { toUserId: 4, startDate: today, endDate: today }), 'FORBIDDEN');
  // starts tomorrow: not yet active
  const tomorrow = isoDate(ctx.now() + DAY), inTwo = isoDate(ctx.now() + 2 * DAY);
  const d = del.createDelegation(ctx, as('owner'), { toUserId: 4, startDate: tomorrow, endDate: inTwo, reason: 'Travel' });
  expectError(() => purchases.approveBill(ctx, as('accountant'), b.id), 'FORBIDDEN');
  ctx.offsetMs += DAY; // now inside the window
  assert.ok(notes.listNotifications(ctx, as('accountant')).items.some((n) => n.kind === 'delegated'));
  const r = purchases.approveBill(ctx, as('accountant'), b.id);
  assert.equal(r.status, 'approved');
  const step = ctx.db.prepare('SELECT acted_by, on_behalf_of FROM approvals_request_steps WHERE request_id = ?').get(reqOf(ctx, b.id));
  assert.deepEqual({ ...step }, { acted_by: 4, on_behalf_of: 1 });
  // after the window
  ctx.offsetMs += 5 * DAY;
  const b2 = bill(ctx, as('clerk'));
  expectError(() => purchases.approveBill(ctx, as('accountant'), b2.id), 'FORBIDDEN');
  assert.equal(del.listDelegations(ctx, as('owner')).find((x) => x.id === d.id).active, false);
});

test('delegation does not bypass separation of duties; revoke works; validation', () => {
  const { ctx, as } = setup();
  rules.createRule(ctx, as('owner'), { name: 'Owner only', minAmount: 100000, priority: 10, steps: [{ approverType: 'role', approverRef: 'owner' }] });
  const today = isoDate(ctx.now());
  const d = del.createDelegation(ctx, as('owner'), { toUserId: 4, startDate: today, endDate: today });
  const ownerBill = bill(ctx, as('owner')); // the delegator created it
  expectError(() => purchases.approveBill(ctx, as('accountant'), ownerBill.id), 'SEPARATION_OF_DUTIES');
  del.revokeDelegation(ctx, as('owner'), d.id);
  const b = bill(ctx, as('clerk'));
  expectError(() => purchases.approveBill(ctx, as('accountant'), b.id), 'FORBIDDEN');
  expectError(() => del.createDelegation(ctx, as('owner'), { toUserId: 1, startDate: today, endDate: today }), 'BAD_INPUT');
  expectError(() => del.createDelegation(ctx, as('owner'), { toUserId: 4, startDate: today, endDate: '2000-01-01' }), 'BAD_RANGE');
  expectError(() => del.createDelegation(ctx, as('manager'), { fromUserId: 1, toUserId: 4, startDate: today, endDate: today }), 'FORBIDDEN');
  expectError(() => del.revokeDelegation(ctx, as('clerk'), d.id), 'FORBIDDEN');
});

test('escalation: after N hours an on-demand run lets the escalation target approve, once', () => {
  const { ctx, as } = setup();
  rules.createRule(ctx, as('owner'), { name: 'Slow manager', minAmount: 100000, priority: 10,
    steps: [{ approverType: 'role', approverRef: 'manager', escalateAfterHours: 24, escalateTo: { type: 'role', ref: 'owner' } }] });
  const b = bill(ctx, as('clerk'));
  expectError(() => purchases.approveBill(ctx, as('owner'), b.id), 'NOT_AN_APPROVER');
  expectError(() => eng.processEscalations(ctx, as('manager')), 'FORBIDDEN');
  assert.deepEqual(eng.processEscalations(ctx, as('owner')).escalated, []); // too early
  ctx.offsetMs += 25 * HOUR;
  assert.equal(eng.processEscalations(ctx, as('owner')).escalated.length, 1);
  assert.equal(eng.processEscalations(ctx, as('owner')).escalated.length, 0); // idempotent
  assert.ok(notes.listNotifications(ctx, as('owner')).items.some((n) => n.kind === 'escalated'));
  assert.equal(purchases.approveBill(ctx, as('owner'), b.id).status, 'approved');
  assert.ok(eng.getRequestDetail(ctx, as('owner'), reqOf(ctx, b.id)).history.some((h) => h.action === 'escalated'));
});

test('atomicity: a failing post leaves the approval step unapproved', () => {
  const { ctx, as } = setup();
  const b = bill(ctx, as('clerk'));
  ctx.db.prepare("UPDATE bills SET bill_date = '2000-01-01' WHERE id = ?").run(b.id);
  ctx.db.prepare("UPDATE period_lock SET through_date = '2010-01-01', mode = 'hard' WHERE id = 1").run();
  expectError(() => purchases.approveBill(ctx, as('manager'), b.id), 'PERIOD_LOCKED');
  const d = eng.getRequestDetail(ctx, as('manager'), reqOf(ctx, b.id));
  assert.equal(d.status, 'pending');
  assert.equal(d.steps[0].status, 'pending');
  assert.equal(ctx.db.prepare('SELECT status FROM bills WHERE id = ?').get(b.id).status, 'pending_approval');
});

test('approval hooks are registered events and bill.approved fires only at completion', () => {
  const { ctx, as } = setup();
  const seen = [];
  ctx.registry.hooks['bill.approved'] = [{ module: 't', fn: (c, p) => seen.push(p.bill.id) }];
  mgrThenOwner(ctx, as);
  const b = bill(ctx, as('clerk'));
  purchases.approveBill(ctx, as('manager'), b.id);
  assert.deepEqual(seen, []);
  purchases.approveBill(ctx, as('owner'), b.id);
  assert.deepEqual(seen, [b.id]);
  delete ctx.registry.hooks['bill.approved'];
});
