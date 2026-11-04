import { postEntry, reverseEntry, setPeriodLock, getPeriodLock, accountBalance, trialBalance, profitAndLoss, recentEntries } from '../../ledger.js';
import { requirePerm } from '../../permissions.js';

export function manualEntry(ctx, user, input) {
  requirePerm(user, 'ledger.post');
  return postEntry(ctx, {
    userId: user.id, date: input.date, memo: input.memo, lines: input.lines,
    confirmSoftLock: input.confirmSoftLock, reason: input.reason, sourceType: 'manual',
  });
}

export function reverse(ctx, user, id, reason) {
  requirePerm(user, 'ledger.reverse');
  return reverseEntry(ctx, user.id, id, reason);
}

export function lockPeriod(ctx, user, input) {
  requirePerm(user, 'period.lock');
  return setPeriodLock(ctx, user.id, input.through, input.mode, input.reason);
}

export function entries(ctx, user) {
  requirePerm(user, 'ledger.view');
  return recentEntries(ctx.db, 50);
}

export function reports(ctx, user) {
  requirePerm(user, 'reports.view');
  return { trialBalance: trialBalance(ctx.db), profitAndLoss: profitAndLoss(ctx.db) };
}

// Home widgets: cash, ledger, and the bare period-lock control for roles that can lock but not read the ledger.
export function widgets(ctx, user) {
  const { db } = ctx;
  const has = (p) => user.permissions.has(p);
  const w = {};
  if (has('banking.view')) w.cash = { balance: accountBalance(db, '1000').net };
  if (has('ledger.view')) w.ledger = { entries: recentEntries(db, 10), balanced: trialBalance(db).balanced, lock: getPeriodLock(db) };
  if (!has('ledger.view') && has('period.lock')) w.lock = getPeriodLock(db);
  return w;
}
