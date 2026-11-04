import { AppError } from '../../errors.js';
import { postEntry, reverseEntry, setPeriodLock, getPeriodLock, accountBalance, trialBalance, profitAndLoss, recentEntries } from '../../ledger.js';
import { requirePerm } from '../../permissions.js';
import { assertEntityAccess } from '../entities/service.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function manualEntry(ctx, user, input = {}) {
  requirePerm(user, 'ledger.post');
  const entityId = input.entityId ?? 1;
  assertEntityAccess(ctx, user, entityId);
  if (!Array.isArray(input.lines)) throw new AppError(400, 'BAD_ENTRY', 'lines must be a list');
  return postEntry(ctx, {
    userId: user.id, date: input.date, memo: input.memo, lines: input.lines, entityId,
    confirmSoftLock: input.confirmSoftLock, reason: input.reason, sourceType: 'manual', allowRounding: !!input.allowRounding,
  });
}

export function reverse(ctx, user, id, reason) {
  requirePerm(user, 'ledger.reverse');
  const e = ctx.db.prepare('SELECT entity_id FROM journal_entries WHERE id = ?').get(id);
  if (e) assertEntityAccess(ctx, user, e.entity_id);
  return reverseEntry(ctx, user.id, id, reason);
}

export function lockPeriod(ctx, user, input) {
  requirePerm(user, 'period.lock');
  return setPeriodLock(ctx, user.id, input.through, input.mode, input.reason);
}

export function entries(ctx, user, query = {}) {
  requirePerm(user, 'ledger.view');
  const entityId = query.entityId != null ? Number(query.entityId) : 1;
  assertEntityAccess(ctx, user, entityId);
  return recentEntries(ctx.db, 50, { entityId });
}

/** Trial balance and P&L for one entity (default 1). Optional from/asOf narrow the dates. */
export function reports(ctx, user, query = {}) {
  requirePerm(user, 'reports.view');
  const entityId = query.entityId != null ? Number(query.entityId) : 1;
  const entity = assertEntityAccess(ctx, user, entityId);
  for (const k of ['from', 'asOf']) if (query[k] && !DATE.test(query[k])) throw new AppError(400, 'BAD_DATE', `${k} must be YYYY-MM-DD`);
  const opts = { entityId, from: query.from, to: query.asOf };
  return { entityId, currency: entity.currency, trialBalance: trialBalance(ctx.db, opts), profitAndLoss: profitAndLoss(ctx.db, opts) };
}

// Home widgets: cash, ledger, and the bare period-lock control for roles that can lock but not read the ledger.
// Widgets show the default entity (1); other entities are fetched through the routes.
export function widgets(ctx, user) {
  const { db } = ctx;
  const has = (p) => user.permissions.has(p);
  const w = {};
  if (has('banking.view')) w.cash = { balance: accountBalance(db, '1000', { entityId: 1 }).net };
  if (has('ledger.view')) w.ledger = { entries: recentEntries(db, 10, { entityId: 1 }), balanced: trialBalance(db).balanced, lock: getPeriodLock(db) };
  if (!has('ledger.view') && has('period.lock')) w.lock = getPeriodLock(db);
  return w;
}
