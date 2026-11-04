import { AppError } from '../../errors.js';
import { requirePerm } from '../../permissions.js';

export function notify(ctx, userId, { kind, title, body = null, refType = null, refId = null }) {
  ctx.db.prepare('INSERT INTO approvals_notifications (user_id, ts, kind, title, body, ref_type, ref_id) VALUES (?,?,?,?,?,?,?)')
    .run(userId, ctx.now(), kind, title, body, refType, refId);
}

export function listNotifications(ctx, user, { unread } = {}) {
  requirePerm(user, 'approvals.view');
  const rows = ctx.db.prepare(`SELECT * FROM approvals_notifications WHERE user_id = ? ${unread ? 'AND read_at IS NULL' : ''} ORDER BY id DESC LIMIT 50`).all(user.id);
  const unreadCount = ctx.db.prepare('SELECT COUNT(*) AS n FROM approvals_notifications WHERE user_id = ? AND read_at IS NULL').get(user.id).n;
  return { unread: unreadCount, items: rows };
}

export function markRead(ctx, user, id) {
  requirePerm(user, 'approvals.view');
  const row = ctx.db.prepare('SELECT * FROM approvals_notifications WHERE id = ?').get(id);
  if (!row || row.user_id !== user.id) throw new AppError(404, 'NOT_FOUND', 'Notification not found'); // never reveal other people's notifications
  ctx.db.prepare('UPDATE approvals_notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?').run(ctx.now(), id);
  return { id };
}

export function markAllRead(ctx, user) {
  requirePerm(user, 'approvals.view');
  const r = ctx.db.prepare('UPDATE approvals_notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(ctx.now(), user.id);
  return { marked: Number(r.changes) };
}
