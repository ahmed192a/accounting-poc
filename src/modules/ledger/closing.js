import { AppError } from '../../errors.js';
import { tx, audit, postEntry, reverseEntry, isoDate } from '../../ledger.js';
import { requirePerm, requireAny } from '../../permissions.js';
import { assertEntityAccess, fiscalRange, fiscalYearOf } from '../entities/service.js';

const RETAINED = '3000'; // Owner equity / retained earnings

/**
 * Year-end closing for one entity: zero every revenue and expense account for the fiscal year and move the net
 * result to 3000. It is an ordinary journal entry dated the last day of the year (source "year_close"), so it is
 * reversible with reverseEntry like any other and the trial balance stays balanced. Close BEFORE hard-locking the year.
 */
export function closeYear(ctx, user, input = {}) {
  requirePerm(user, 'ledger.close');
  const { db } = ctx;
  const entityId = input.entityId ?? 1;
  const entity = assertEntityAccess(ctx, user, entityId);
  const today = isoDate(ctx.now());
  const fy = input.fiscalYear ?? fiscalYearOf(entity.fiscal_year_start_month, today) - 1;
  const { start, end } = fiscalRange(entity.fiscal_year_start_month, fy);
  if (end > today) throw new AppError(409, 'YEAR_NOT_ENDED', `Fiscal year ${fy} ends on ${end}; it cannot be closed before then`);
  const open = db.prepare(`SELECT c.id FROM entities_closings c WHERE c.entity_id = ? AND c.fiscal_year = ?
    AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_id = c.entry_id)`).get(entityId, fy);
  if (open) throw new AppError(409, 'ALREADY_CLOSED', `Fiscal year ${fy} is already closed for this entity; reverse the closing entry to reopen it`);

  // Ignore earlier closing entries (and their reversals) so a reopened year can be closed again.
  const rows = db.prepare(`
    SELECT a.code, a.type, SUM(l.debit) - SUM(l.credit) AS net
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
    WHERE e.entity_id = ? AND e.entry_date BETWEEN ? AND ? AND a.type IN ('revenue','expense')
      AND e.source_type <> 'year_close'
      AND NOT (e.reverses_id IS NOT NULL AND EXISTS (SELECT 1 FROM journal_entries o WHERE o.id = e.reverses_id AND o.source_type = 'year_close'))
    GROUP BY a.id HAVING net <> 0 ORDER BY a.code`).all(entityId, start, end);
  if (!rows.length) throw new AppError(409, 'NOTHING_TO_CLOSE', `No revenue or expense activity in fiscal year ${fy}`);

  const lines = rows.map((r) => (r.net > 0 ? { account: r.code, credit: r.net } : { account: r.code, debit: -r.net }));
  const profit = -rows.reduce((s, r) => s + r.net, 0);
  if (profit > 0) lines.push({ account: RETAINED, credit: profit });
  else if (profit < 0) lines.push({ account: RETAINED, debit: -profit });

  return tx(db, () => {
    const e = postEntry(ctx, {
      userId: user.id, entityId, date: end, lines, allowInactive: true, sourceType: 'year_close', sourceId: fy,
      memo: `Year-end closing, fiscal year ${fy}`, confirmSoftLock: input.confirmSoftLock, reason: input.reason,
    });
    const id = Number(db.prepare('INSERT INTO entities_closings (entity_id, fiscal_year, period_start, period_end, entry_id, net_profit, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(entityId, fy, start, end, e.id, profit, user.id, ctx.now()).lastInsertRowid);
    audit(ctx, { userId: user.id, action: 'year.closed', type: 'closing', id, newValue: { entityId, fiscalYear: fy, entryId: e.id, netProfit: profit } });
    return { id, entryId: e.id, fiscalYear: fy, periodStart: start, periodEnd: end, netProfit: profit };
  });
}

/** Reopen a year. The reversal is dated the closing date itself so period views stay right; lift a lock first. */
export function reverseClosing(ctx, user, closingId, reason, opt = {}) {
  requirePerm(user, 'ledger.close');
  const c = ctx.db.prepare('SELECT * FROM entities_closings WHERE id = ?').get(closingId);
  if (!c) throw new AppError(404, 'NOT_FOUND', 'Closing not found');
  assertEntityAccess(ctx, user, c.entity_id);
  return tx(ctx.db, () => {
    const r = reverseEntry(ctx, user.id, c.entry_id, reason, { date: c.period_end, confirmSoftLock: opt.confirmSoftLock });
    audit(ctx, { userId: user.id, action: 'year.reopened', type: 'closing', id: closingId, reason });
    return { id: closingId, reversalId: r.id };
  });
}

export function listClosings(ctx, user, entityId = 1) {
  requireAny(user, ['ledger.view', 'ledger.close']);
  assertEntityAccess(ctx, user, entityId);
  return ctx.db.prepare(`SELECT c.id, c.entity_id AS entityId, c.fiscal_year AS fiscalYear, c.period_start AS periodStart, c.period_end AS periodEnd,
      c.entry_id AS entryId, c.net_profit AS netProfit,
      EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_id = c.entry_id) AS reversed
    FROM entities_closings c WHERE c.entity_id = ? ORDER BY c.id DESC`).all(entityId).map((r) => ({ ...r, reversed: !!r.reversed }));
}
