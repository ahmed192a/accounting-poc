import { AppError } from '../../errors.js';
import { audit, tx } from '../../ledger.js';
import { requirePerm } from '../../permissions.js';
import { CATEGORIES, cleanText, wholeInt } from '../purchases/util.js';

export const DOC_TYPES = ['bill'];

function cleanStep(db, s, i) {
  const where = `step ${i + 1}`;
  if (!['role', 'user', 'permission'].includes(s?.approverType)) throw new AppError(400, 'BAD_INPUT', `${where}: approverType must be role, user or permission`);
  let ref = s.approverRef;
  if (s.approverType === 'role') {
    if (typeof ref !== 'string' || !db.prepare('SELECT 1 FROM roles WHERE name = ?').get(ref)) throw new AppError(400, 'UNKNOWN_ROLE', `${where}: unknown role`);
  } else if (s.approverType === 'user') {
    if (!Number.isInteger(ref) || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(ref)) throw new AppError(400, 'UNKNOWN_USER', `${where}: unknown user`);
    ref = String(ref);
  } else if (typeof ref !== 'string' || !/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(ref)) throw new AppError(400, 'BAD_INPUT', `${where}: permission must look like area.action`);
  const out = { type: s.approverType, ref, max: null, hours: null, escType: null, escRef: null };
  if (s.maxAmount != null) out.max = wholeInt(s.maxAmount, `${where} maxAmount`, { min: 1 });
  if (s.escalateAfterHours != null) {
    out.hours = wholeInt(s.escalateAfterHours, `${where} escalateAfterHours`, { min: 1, max: 24 * 90 });
    const t = s.escalateTo ?? { type: 'role', ref: 'owner' };
    if (!['role', 'user'].includes(t.type)) throw new AppError(400, 'BAD_INPUT', `${where}: escalateTo.type must be role or user`);
    const ok = t.type === 'role' ? db.prepare('SELECT 1 FROM roles WHERE name = ?').get(t.ref) : db.prepare('SELECT 1 FROM users WHERE id = ?').get(t.ref);
    if (!ok) throw new AppError(400, 'UNKNOWN_ESCALATION_TARGET', `${where}: escalation target does not exist`);
    out.escType = t.type;
    out.escRef = String(t.ref);
  }
  return out;
}

function clean(ctx, input) {
  const { db } = ctx;
  const docType = input.docType ?? 'bill';
  if (!DOC_TYPES.includes(docType)) throw new AppError(400, 'BAD_INPUT', `docType must be one of ${DOC_TYPES.join(', ')}`);
  const name = cleanText(input.name, 'name', { required: true, max: 100 });
  const min = input.minAmount == null ? 0 : wholeInt(input.minAmount, 'minAmount', { min: 0 });
  const max = input.maxAmount == null ? null : wholeInt(input.maxAmount, 'maxAmount', { min: 1 });
  if (max != null && max < min) throw new AppError(400, 'BAD_RANGE', 'maxAmount must not be below minAmount');
  if (input.category != null && !CATEGORIES.includes(input.category)) throw new AppError(400, 'BAD_INPUT', `category must be one of ${CATEGORIES.join(', ')}`);
  if (input.supplierId != null && !db.prepare('SELECT 1 FROM purchases_suppliers WHERE id = ?').get(input.supplierId)) throw new AppError(404, 'SUPPLIER_NOT_FOUND', 'Supplier not found');
  const mode = input.mode ?? 'sequential';
  if (!['sequential', 'parallel'].includes(mode)) throw new AppError(400, 'BAD_INPUT', 'mode must be sequential or parallel');
  if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > 8) throw new AppError(400, 'BAD_INPUT', 'A rule needs 1 to 8 steps');
  const steps = input.steps.map((s, i) => cleanStep(db, s, i));
  // Strict separation of duties means one person can never satisfy two steps of the same request.
  const users = steps.filter((s) => s.type === 'user').map((s) => s.ref);
  if (new Set(users).size !== users.length) throw new AppError(400, 'DUPLICATE_APPROVER', 'The same user cannot be named on two steps: nobody may approve twice');
  return { docType, name, min, max, category: input.category ?? null, supplierId: input.supplierId ?? null, mode, priority: wholeInt(input.priority ?? 0, 'priority', { min: 0, max: 1000 }), steps };
}

function writeSteps(db, ruleId, steps) {
  const ins = db.prepare(`INSERT INTO approvals_rule_steps (rule_id, step_no, approver_type, approver_ref, max_amount, escalate_after_hours, escalate_to_type, escalate_to_ref)
    VALUES (?,?,?,?,?,?,?,?)`);
  steps.forEach((s, i) => ins.run(ruleId, i + 1, s.type, s.ref, s.max, s.hours, s.escType, s.escRef));
}

export function createRule(ctx, user, input = {}) {
  requirePerm(user, 'approvals.configure');
  const r = clean(ctx, input);
  const { db } = ctx;
  return tx(db, () => {
    const res = db.prepare(`INSERT INTO approvals_rules (name, doc_type, min_amount, max_amount, category, supplier_id, mode, priority, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(r.name, r.docType, r.min, r.max, r.category, r.supplierId, r.mode, r.priority, user.id, ctx.now());
    const id = Number(res.lastInsertRowid);
    writeSteps(db, id, r.steps);
    audit(ctx, { userId: user.id, action: 'approvals.rule_created', type: 'approval_rule', id, newValue: input });
    return { id };
  });
}

/** Replace a rule's criteria and steps. Requests already in flight keep the steps they were created with. */
export function updateRule(ctx, user, id, input = {}) {
  requirePerm(user, 'approvals.configure');
  const { db } = ctx;
  const old = db.prepare('SELECT * FROM approvals_rules WHERE id = ?').get(id);
  if (!old) throw new AppError(404, 'NOT_FOUND', 'Rule not found');
  const r = clean(ctx, input);
  return tx(db, () => {
    db.prepare('UPDATE approvals_rules SET name=?, doc_type=?, min_amount=?, max_amount=?, category=?, supplier_id=?, mode=?, priority=?, active=? WHERE id=?')
      .run(r.name, r.docType, r.min, r.max, r.category, r.supplierId, r.mode, r.priority, input.active === false ? 0 : 1, id);
    db.prepare('DELETE FROM approvals_rule_steps WHERE rule_id = ?').run(id);
    writeSteps(db, id, r.steps);
    audit(ctx, { userId: user.id, action: 'approvals.rule_updated', type: 'approval_rule', id, oldValue: old, newValue: input });
    return { id };
  });
}

export function deactivateRule(ctx, user, id) {
  requirePerm(user, 'approvals.configure');
  const { db } = ctx;
  const old = db.prepare('SELECT * FROM approvals_rules WHERE id = ?').get(id);
  if (!old) throw new AppError(404, 'NOT_FOUND', 'Rule not found');
  tx(db, () => {
    db.prepare('UPDATE approvals_rules SET active = 0 WHERE id = ?').run(id);
    audit(ctx, { userId: user.id, action: 'approvals.rule_deactivated', type: 'approval_rule', id, oldValue: old });
  });
  return { id };
}

export function listRules(ctx, user) {
  requirePerm(user, 'approvals.view');
  const { db } = ctx;
  return db.prepare('SELECT * FROM approvals_rules ORDER BY priority DESC, id').all()
    .map((r) => ({ ...r, steps: db.prepare('SELECT * FROM approvals_rule_steps WHERE rule_id = ? ORDER BY step_no').all(r.id) }));
}

/** The most specific active rule for a document: highest priority, then most criteria set, then lowest id. */
export function pickRule(ctx, { docType, amount, category, supplierId }) {
  const rows = ctx.db.prepare(`SELECT * FROM approvals_rules WHERE active = 1 AND doc_type = ? AND min_amount <= ? AND (max_amount IS NULL OR max_amount >= ?)
      AND (category IS NULL OR category = ?) AND (supplier_id IS NULL OR supplier_id = ?)`).all(docType, amount, amount, category ?? null, supplierId ?? null);
  const spec = (r) => (r.category ? 1 : 0) + (r.supplier_id ? 1 : 0) + (r.max_amount != null || r.min_amount > 0 ? 1 : 0);
  rows.sort((a, b) => b.priority - a.priority || spec(b) - spec(a) || a.id - b.id);
  return rows[0] ?? null;
}
