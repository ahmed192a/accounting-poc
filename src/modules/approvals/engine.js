import { AppError } from '../../errors.js';
import { audit, tx } from '../../ledger.js';
import { loadUser, limitFor, requirePerm } from '../../permissions.js';
import { emit } from '../../hooks.js';
import { pickRule } from './rules.js';
import { notify } from './notifications.js';
import { activeDelegationsTo, activeDelegationsFrom } from './delegations.js';
import { finalizeBill, rejectBillDoc, cancelBillDoc } from '../purchases/service.js';

// Approval engine. A request is created from the best matching rule; its steps are copied so that later
// edits to the rule never change what is in flight. Strict separation of duties: nobody approves a
// document they created, and nobody approves two steps of the same request (neither as themselves nor
// on behalf of somebody else). The document's side effect (posting a bill) runs only when the last step completes.

const HANDLERS = {
  bill: {
    perm: 'purchases.approve',
    label: (id) => `Bill #${id}`,
    onApproved: (ctx, docId, approverId) => finalizeBill(ctx, docId, approverId),
    onRejected: (ctx, docId, reason, userId) => rejectBillDoc(ctx, docId, reason, userId),
    onCancelled: (ctx, docId) => cancelBillDoc(ctx, docId),
  },
};
const handler = (docType) => {
  const h = HANDLERS[docType];
  if (!h) throw new AppError(400, 'BAD_INPUT', `Unknown document type ${docType}`);
  return h;
};

function history(ctx, requestId, userId, action, detail = null) {
  ctx.db.prepare('INSERT INTO approvals_history (request_id, ts, user_id, action, detail) VALUES (?,?,?,?,?)')
    .run(requestId, ctx.now(), userId, action, detail == null ? null : JSON.stringify(detail));
}

/** User ids who hold a step's approver slot (role / user / permission), plus those with a delegation in force from them. */
function stepRecipients(ctx, step, request) {
  const { db } = ctx;
  let ids = [];
  const target = (type, ref) => {
    if (type === 'role') return db.prepare('SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = ?').all(ref).map((r) => r.id);
    if (type === 'user') return [Number(ref)];
    return db.prepare('SELECT u.id, r.permissions FROM users u JOIN roles r ON r.id = u.role_id').all().filter((r) => JSON.parse(r.permissions).includes(ref)).map((r) => r.id);
  };
  ids = target(step.approver_type, step.approver_ref);
  if (step.escalated_at && step.escalate_to_type) ids = ids.concat(target(step.escalate_to_type, step.escalate_to_ref));
  for (const id of [...ids]) for (const d of activeDelegationsFrom(ctx, id)) ids.push(d.to_user);
  return [...new Set(ids)].filter((id) => id !== request.created_by);
}

function activate(ctx, request, step) {
  const { db } = ctx;
  const due = step.escalate_hours ? ctx.now() + step.escalate_hours * 3600000 : null;
  db.prepare("UPDATE approvals_request_steps SET status = 'pending', activated_at = ?, due_at = ? WHERE id = ?").run(ctx.now(), due, step.id);
  history(ctx, request.id, null, 'step_activated', { step: step.step_no });
  for (const uid of stepRecipients(ctx, step, request)) {
    notify(ctx, uid, { kind: 'approval_needed', title: 'Approval needed', body: `${handler(request.doc_type).label(request.doc_id)}: amount ${request.amount / 100}`, refType: 'approval', refId: request.id });
  }
}

/** Create the approval request for a document. Returns the request id. */
export function openRequest(ctx, { docType, docId, amount, category = null, supplierId = null, createdBy }) {
  const { db } = ctx;
  handler(docType);
  return tx(db, () => {
    const rule = pickRule(ctx, { docType, amount, category, supplierId });
    // No rule at all (all deactivated): fall back to the original behaviour, one approver holding the permission.
    const steps = rule
      ? db.prepare('SELECT * FROM approvals_rule_steps WHERE rule_id = ? ORDER BY step_no').all(rule.id)
      : [{ approver_type: 'permission', approver_ref: handler(docType).perm, max_amount: null, escalate_after_hours: null, escalate_to_type: null, escalate_to_ref: null }];
    const mode = rule?.mode ?? 'sequential';
    const res = db.prepare(`INSERT INTO approvals_requests (doc_type, doc_id, rule_id, rule_name, mode, amount, status, created_by, created_at)
      VALUES (?,?,?,?,?,?,'pending',?,?)`).run(docType, docId, rule?.id ?? null, rule?.name ?? 'Fallback single approver', mode, amount, createdBy, ctx.now());
    const id = Number(res.lastInsertRowid);
    const ins = db.prepare(`INSERT INTO approvals_request_steps (request_id, step_no, approver_type, approver_ref, max_amount, status, escalate_hours, escalate_to_type, escalate_to_ref)
      VALUES (?,?,?,?,?,'waiting',?,?,?)`);
    steps.forEach((s, i) => ins.run(id, i + 1, s.approver_type, s.approver_ref, s.max_amount, s.escalate_after_hours, s.escalate_to_type, s.escalate_to_ref));
    history(ctx, id, createdBy, 'submitted', { rule: rule?.name ?? 'fallback', mode, steps: steps.length });
    audit(ctx, { userId: createdBy, action: 'approvals.requested', type: 'approval_request', id, newValue: { docType, docId, amount, rule: rule?.name ?? null, mode } });
    const request = getRequestRow(ctx, id);
    const all = db.prepare('SELECT * FROM approvals_request_steps WHERE request_id = ? ORDER BY step_no').all(id);
    for (const s of (mode === 'parallel' ? all : all.slice(0, 1))) activate(ctx, request, s);
    emit(ctx, 'approvals.requested', { requestId: id, docType, docId, amount, userId: createdBy });
    return id;
  });
}

const getRequestRow = (ctx, id) => ctx.db.prepare('SELECT * FROM approvals_requests WHERE id = ?').get(id);
const steps = (ctx, id) => ctx.db.prepare('SELECT * FROM approvals_request_steps WHERE request_id = ? ORDER BY step_no').all(id);

export function requestForDoc(ctx, docType, docId) {
  return ctx.db.prepare('SELECT * FROM approvals_requests WHERE doc_type = ? AND doc_id = ? ORDER BY id DESC LIMIT 1').get(docType, docId);
}

// ---- who may act ----

/** The identities a user can act as: themselves, plus everyone who has delegated to them (window checked by ctx.now()). */
function identities(ctx, user) {
  const out = [{ u: user, delegated: false }];
  for (const d of activeDelegationsTo(ctx, user.id)) {
    try { out.push({ u: loadUser(ctx, d.from_user), delegated: true }); } catch { /* delegator removed */ }
  }
  return out;
}

function matches(step, u) {
  const direct = step.approver_type === 'role' ? u.role === step.approver_ref
    : step.approver_type === 'user' ? String(u.id) === step.approver_ref
      : u.permissions.has(step.approver_ref);
  if (direct) return 'direct';
  if (step.escalated_at && step.escalate_to_type) {
    const esc = step.escalate_to_type === 'role' ? u.role === step.escalate_to_ref : String(u.id) === step.escalate_to_ref;
    if (esc) return 'escalation';
  }
  return null;
}

const sodError = (m) => new AppError(403, 'SEPARATION_OF_DUTIES', m);

/** Check one (step, identity) pair. Returns null when allowed, otherwise the AppError to raise. */
function checkActor(ctx, request, step, actor, ident, via, { forReject = false } = {}) {
  const perm = handler(request.doc_type).perm;
  if (!ident.u.permissions.has(perm)) return new AppError(403, 'FORBIDDEN', `Role "${ident.u.role}" does not have permission ${perm}`);
  if (forReject) return null; // rejecting creates no risk; creator/limits do not block it
  const ids = [actor.id, ident.u.id];
  if (ids.includes(request.created_by)) return sodError(`You cannot approve a ${request.doc_type} you created`);
  const done = ctx.db.prepare("SELECT acted_by, on_behalf_of FROM approvals_request_steps WHERE request_id = ? AND status = 'approved'").all(request.id);
  if (done.some((d) => ids.includes(d.acted_by) || ids.includes(d.on_behalf_of))) return sodError('You already approved another step of this request; a different person must approve each step');
  const lim = limitFor(ident.u, perm);
  if (request.amount > lim) return new AppError(403, 'OVER_LIMIT', `Amount is above your approval limit of ${lim / 100} EGP`);
  if (via === 'direct' && step.max_amount != null && request.amount > step.max_amount) {
    return new AppError(403, 'OVER_LIMIT', `Amount is above this step's limit of ${step.max_amount / 100} EGP; it must be escalated`);
  }
  return null;
}

function candidates(ctx, user, request, opts) {
  const pending = steps(ctx, request.id).filter((s) => s.status === 'pending');
  const out = [];
  for (const step of pending) {
    for (const ident of identities(ctx, user)) {
      const via = matches(step, ident.u);
      if (!via) continue;
      out.push({ step, ident, via, error: checkActor(ctx, request, step, user, ident, via, opts) });
    }
  }
  return out;
}

/** True when the user could approve right now (no error). Used for queues and buttons. */
export function canActNow(ctx, user, request) {
  if (request.status !== 'pending') return false;
  return candidates(ctx, user, request).some((c) => !c.error);
}

function pickCandidate(ctx, user, request, stepId, opts) {
  let list = candidates(ctx, user, request, opts);
  if (stepId != null) list = list.filter((c) => c.step.id === stepId);
  const ok = list.find((c) => !c.error);
  if (ok) return ok;
  if (list.length) throw list[0].error;
  const perm = handler(request.doc_type).perm;
  if (!user.permissions.has(perm) && !activeDelegationsTo(ctx, user.id).length) requirePerm(user, perm);
  throw new AppError(403, 'NOT_AN_APPROVER', 'You are not an approver for any open step of this request');
}

// ---- acting ----

export function approveStep(ctx, user, requestId, { stepId, comment } = {}) {
  const { db } = ctx;
  const request = getRequestRow(ctx, requestId);
  if (!request) throw new AppError(404, 'NOT_FOUND', 'Approval request not found');
  if (request.status !== 'pending') throw new AppError(409, 'NOT_PENDING', 'This request is not waiting for approval');
  const c = pickCandidate(ctx, user, request, stepId);
  return tx(db, () => {
    const note = comment ? String(comment).slice(0, 300) : null;
    db.prepare("UPDATE approvals_request_steps SET status = 'approved', acted_by = ?, on_behalf_of = ?, acted_at = ?, comment = ? WHERE id = ?")
      .run(user.id, c.ident.delegated ? c.ident.u.id : null, ctx.now(), note, c.step.id);
    history(ctx, requestId, user.id, 'step_approved', { step: c.step.step_no, onBehalfOf: c.ident.delegated ? c.ident.u.id : null, via: c.via, comment: note });
    audit(ctx, { userId: user.id, action: 'approvals.step_approved', type: 'approval_request', id: requestId, newValue: { step: c.step.step_no, onBehalfOf: c.ident.delegated ? c.ident.u.id : null } });

    let all = steps(ctx, requestId);
    if (request.mode === 'sequential') {
      const hasPending = all.some((s) => s.status === 'pending');
      const next = all.find((s) => s.status === 'waiting');
      if (!hasPending && next) activate(ctx, request, next);
    }
    all = steps(ctx, requestId);
    const open = all.filter((s) => s.status === 'pending' || s.status === 'waiting').length;
    if (open > 0) return { requestId, complete: false, status: 'pending', remaining: open, entryId: null };

    db.prepare("UPDATE approvals_requests SET status = 'approved', completed_at = ? WHERE id = ?").run(ctx.now(), requestId);
    history(ctx, requestId, user.id, 'completed');
    const r = handler(request.doc_type).onApproved(ctx, request.doc_id, user.id);
    notify(ctx, request.created_by, { kind: 'approved', title: 'Approved', body: handler(request.doc_type).label(request.doc_id), refType: 'approval', refId: requestId });
    emit(ctx, 'approvals.completed', { requestId, docType: request.doc_type, docId: request.doc_id, userId: user.id });
    return { requestId, complete: true, status: 'approved', remaining: 0, entryId: r?.entryId ?? null };
  });
}

export function rejectStep(ctx, user, requestId, { stepId, reason } = {}) {
  const { db } = ctx;
  if (!reason || !String(reason).trim()) throw new AppError(400, 'REASON_REQUIRED', 'Rejecting needs a reason');
  const request = getRequestRow(ctx, requestId);
  if (!request) throw new AppError(404, 'NOT_FOUND', 'Approval request not found');
  if (request.status !== 'pending') throw new AppError(409, 'NOT_PENDING', 'This request is not waiting for approval');
  const c = pickCandidate(ctx, user, request, stepId, { forReject: true });
  const why = String(reason).trim().slice(0, 300);
  return tx(db, () => {
    db.prepare("UPDATE approvals_request_steps SET status = 'rejected', acted_by = ?, on_behalf_of = ?, acted_at = ?, comment = ? WHERE id = ?")
      .run(user.id, c.ident.delegated ? c.ident.u.id : null, ctx.now(), why, c.step.id);
    db.prepare("UPDATE approvals_request_steps SET status = 'skipped' WHERE request_id = ? AND status IN ('pending','waiting')").run(requestId);
    db.prepare("UPDATE approvals_requests SET status = 'rejected', completed_at = ?, reason = ? WHERE id = ?").run(ctx.now(), why, requestId);
    history(ctx, requestId, user.id, 'step_rejected', { step: c.step.step_no, reason: why });
    audit(ctx, { userId: user.id, action: 'approvals.rejected', type: 'approval_request', id: requestId, reason: why });
    handler(request.doc_type).onRejected(ctx, request.doc_id, why, user.id);
    notify(ctx, request.created_by, { kind: 'rejected', title: 'Rejected', body: `${handler(request.doc_type).label(request.doc_id)}: ${why}`, refType: 'approval', refId: requestId });
    emit(ctx, 'approvals.rejected', { requestId, docType: request.doc_type, docId: request.doc_id, reason: why, userId: user.id });
    return { requestId, status: 'rejected' };
  });
}

/** Called when the document is voided or withdrawn while approval is still open. */
export function cancelRequest(ctx, requestId, userId, reason) {
  const { db } = ctx;
  db.prepare("UPDATE approvals_request_steps SET status = 'skipped' WHERE request_id = ? AND status IN ('pending','waiting')").run(requestId);
  db.prepare("UPDATE approvals_requests SET status = 'cancelled', completed_at = ?, reason = ? WHERE id = ? AND status = 'pending'").run(ctx.now(), reason ?? null, requestId);
  history(ctx, requestId, userId, 'cancelled', { reason });
  audit(ctx, { userId, action: 'approvals.cancelled', type: 'approval_request', id: requestId, reason });
}

/**
 * Escalation processor, run on demand (button or scheduled call): every pending step past its due time
 * that has an escalation target is marked escalated once, the target may now approve it, and is notified.
 * Idempotent: running it again changes nothing.
 */
export function processEscalations(ctx, user) {
  requirePerm(user, 'approvals.configure');
  const { db } = ctx;
  const due = db.prepare(`SELECT s.*, r.doc_type, r.doc_id, r.amount, r.created_by FROM approvals_request_steps s JOIN approvals_requests r ON r.id = s.request_id
    WHERE s.status = 'pending' AND s.due_at IS NOT NULL AND s.due_at <= ? AND s.escalated_at IS NULL AND s.escalate_to_type IS NOT NULL AND r.status = 'pending'`).all(ctx.now());
  return tx(db, () => {
    const done = [];
    for (const s of due) {
      db.prepare('UPDATE approvals_request_steps SET escalated_at = ? WHERE id = ?').run(ctx.now(), s.id);
      const request = getRequestRow(ctx, s.request_id);
      const step = { ...s, escalated_at: ctx.now() };
      history(ctx, s.request_id, user.id, 'escalated', { step: s.step_no, to: `${s.escalate_to_type}:${s.escalate_to_ref}` });
      audit(ctx, { userId: user.id, action: 'approvals.escalated', type: 'approval_request', id: s.request_id, newValue: { step: s.step_no, to: `${s.escalate_to_type}:${s.escalate_to_ref}` } });
      for (const uid of stepRecipients(ctx, step, request)) {
        notify(ctx, uid, { kind: 'escalated', title: 'Approval overdue (escalated)', body: `${handler(s.doc_type).label(s.doc_id)} waited too long at step ${s.step_no}`, refType: 'approval', refId: s.request_id });
      }
      done.push({ requestId: s.request_id, step: s.step_no });
    }
    return { escalated: done };
  });
}

// ---- reading ----

export function getRequestDetail(ctx, user, id) {
  requirePerm(user, 'approvals.view');
  const request = getRequestRow(ctx, id);
  if (!request) throw new AppError(404, 'NOT_FOUND', 'Approval request not found');
  const names = new Map(ctx.db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));
  return {
    ...request,
    canAct: canActNow(ctx, user, request),
    steps: steps(ctx, id).map((s) => ({ ...s, acted_by_name: names.get(s.acted_by) ?? null, on_behalf_of_name: names.get(s.on_behalf_of) ?? null })),
    history: ctx.db.prepare('SELECT * FROM approvals_history WHERE request_id = ? ORDER BY id').all(id)
      .map((h) => ({ ...h, user_name: names.get(h.user_id) ?? null, detail: h.detail ? JSON.parse(h.detail) : null })),
  };
}

export function listRequests(ctx, user, { status, mine } = {}) {
  requirePerm(user, 'approvals.view');
  const rows = ctx.db.prepare(`SELECT * FROM approvals_requests ${status ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT 200`).all(...(status ? [status] : []));
  const out = rows.map((r) => ({ ...r, canAct: canActNow(ctx, user, r), mine: r.created_by === user.id }));
  return mine ? out.filter((r) => r.canAct) : out;
}
