// The default rule reproduces the original behaviour: one approval by anybody holding purchases.approve within their limit.
export function seed(ctx) {
  const res = ctx.db.prepare("INSERT INTO approvals_rules (name, doc_type, mode, priority, is_default, created_by, created_at) VALUES ('Default: one approver', 'bill', 'sequential', 0, 1, 1, ?)").run(ctx.now());
  ctx.db.prepare("INSERT INTO approvals_rule_steps (rule_id, step_no, approver_type, approver_ref) VALUES (?, 1, 'permission', 'purchases.approve')").run(Number(res.lastInsertRowid));
}
