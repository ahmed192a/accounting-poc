import { AppError } from '../../errors.js';
import { audit, tx, isoDate } from '../../ledger.js';
import { requirePerm } from '../../permissions.js';
import { validDate } from '../purchases/util.js';
import { notify } from './notifications.js';

/** Delegations in force today (by the demo clock): who may act for `userId`, or for whom `userId` may act. */
export function activeDelegationsTo(ctx, toUser) {
  const d = isoDate(ctx.now());
  return ctx.db.prepare('SELECT * FROM approvals_delegations WHERE to_user = ? AND revoked = 0 AND start_date <= ? AND end_date >= ?').all(toUser, d, d);
}
export function activeDelegationsFrom(ctx, fromUser) {
  const d = isoDate(ctx.now());
  return ctx.db.prepare('SELECT * FROM approvals_delegations WHERE from_user = ? AND revoked = 0 AND start_date <= ? AND end_date >= ?').all(fromUser, d, d);
}

export function createDelegation(ctx, user, input = {}) {
  requirePerm(user, 'approvals.delegate');
  const { db } = ctx;
  const from = input.fromUserId ?? user.id;
  // Delegating on behalf of somebody else is an administrative act.
  if (from !== user.id) requirePerm(user, 'approvals.configure');
  const to = input.toUserId;
  if (!Number.isInteger(to)) throw new AppError(400, 'BAD_INPUT', 'toUserId is required');
  if (to === from) throw new AppError(400, 'BAD_INPUT', 'Cannot delegate to yourself');
  for (const [id, label] of [[from, 'fromUserId'], [to, 'toUserId']]) {
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw new AppError(404, 'USER_NOT_FOUND', `${label} is not a known user`);
  }
  const start = validDate(input.startDate, 'startDate'), end = validDate(input.endDate, 'endDate');
  if (end < start) throw new AppError(400, 'BAD_RANGE', 'endDate must not be before startDate');
  const reason = input.reason ? String(input.reason).slice(0, 200) : null;
  return tx(db, () => {
    const res = db.prepare('INSERT INTO approvals_delegations (from_user, to_user, start_date, end_date, reason, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(from, to, start, end, reason, user.id, ctx.now());
    const id = Number(res.lastInsertRowid);
    audit(ctx, { userId: user.id, action: 'approvals.delegated', type: 'approval_delegation', id, newValue: { from, to, start, end }, reason });
    notify(ctx, to, { kind: 'delegated', title: 'Approval delegation', body: `You can approve on behalf of user #${from} from ${start} to ${end}`, refType: 'delegation', refId: id });
    return { id };
  });
}

export function revokeDelegation(ctx, user, id) {
  requirePerm(user, 'approvals.delegate');
  const { db } = ctx;
  const d = db.prepare('SELECT * FROM approvals_delegations WHERE id = ?').get(id);
  if (!d) throw new AppError(404, 'NOT_FOUND', 'Delegation not found');
  if (d.from_user !== user.id && d.created_by !== user.id && !user.permissions.has('approvals.configure')) {
    throw new AppError(403, 'FORBIDDEN', 'Only the delegator, its creator or an approvals administrator can revoke it');
  }
  tx(db, () => {
    db.prepare('UPDATE approvals_delegations SET revoked = 1 WHERE id = ?').run(id);
    audit(ctx, { userId: user.id, action: 'approvals.delegation_revoked', type: 'approval_delegation', id, oldValue: d });
  });
  return { id };
}

export function listDelegations(ctx, user) {
  requirePerm(user, 'approvals.view');
  const all = user.permissions.has('approvals.configure');
  const rows = ctx.db.prepare(`SELECT d.*, f.name AS from_name, t.name AS to_name FROM approvals_delegations d
    JOIN users f ON f.id = d.from_user JOIN users t ON t.id = d.to_user
    ${all ? '' : 'WHERE d.from_user = ? OR d.to_user = ?'} ORDER BY d.id DESC`).all(...(all ? [] : [user.id, user.id]));
  const d = isoDate(ctx.now());
  return rows.map((r) => ({ ...r, active: !r.revoked && r.start_date <= d && r.end_date >= d }));
}
