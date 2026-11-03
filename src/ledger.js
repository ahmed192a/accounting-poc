import { AppError } from './errors.js';

export const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

// Re-entrant transaction helper: the outermost call owns BEGIN/COMMIT.
const depth = new WeakMap();
export function tx(db, fn) {
  if ((depth.get(db) ?? 0) > 0) return fn();
  db.exec('BEGIN');
  depth.set(db, 1);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth.set(db, 0);
  }
}

export function audit(ctx, { userId = null, action, type = null, id = null, oldValue = null, newValue = null, reason = null }) {
  ctx.db
    .prepare('INSERT INTO audit_log (ts, user_id, action, record_type, record_id, old_value, new_value, reason) VALUES (?,?,?,?,?,?,?,?)')
    .run(
      ctx.now(), userId, action, type, id,
      oldValue == null ? null : JSON.stringify(oldValue),
      newValue == null ? null : JSON.stringify(newValue),
      reason
    );
}

const getLock = (db) => db.prepare('SELECT through_date, mode FROM period_lock WHERE id = 1').get();

/**
 * Post a balanced journal entry. Entries are never edited or deleted: corrections are reversals.
 * lines: [{ account: '1000', debit?: piastres, credit?: piastres }]
 */
export function postEntry(ctx, e) {
  const { db } = ctx;
  const lines = e.lines ?? [];
  if (lines.length < 2) throw new AppError(400, 'BAD_ENTRY', 'An entry needs at least two lines');

  let debit = 0, credit = 0;
  for (const l of lines) {
    const d = l.debit ?? 0, c = l.credit ?? 0;
    if (!Number.isInteger(d) || !Number.isInteger(c) || d < 0 || c < 0 || (d > 0 && c > 0) || d + c === 0) {
      throw new AppError(400, 'BAD_LINE', 'Each line needs exactly one positive whole-piastre amount, debit or credit');
    }
    debit += d;
    credit += c;
  }
  if (debit !== credit) throw new AppError(400, 'UNBALANCED', `Entry is not balanced: debits ${debit} vs credits ${credit}`);

  const date = e.date ?? isoDate(ctx.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(400, 'BAD_DATE', 'Date must be YYYY-MM-DD');

  const lock = getLock(db);
  if (lock.through_date && date <= lock.through_date) {
    if (lock.mode === 'hard') {
      throw new AppError(423, 'PERIOD_LOCKED', `Period is hard-locked through ${lock.through_date}; post a reversal dated after the lock instead`);
    }
    if (!e.confirmSoftLock) {
      throw new AppError(409, 'SOFT_LOCK_WARNING', `Period is soft-locked through ${lock.through_date}; resend with confirmSoftLock and a reason to proceed`);
    }
    if (!e.reason || !String(e.reason).trim()) {
      throw new AppError(400, 'REASON_REQUIRED', 'Posting into a soft-locked period requires a reason');
    }
  }

  return tx(db, () => {
    const res = db
      .prepare('INSERT INTO journal_entries (entry_date, memo, source_type, source_id, reverses_id, created_by, created_at, reason) VALUES (?,?,?,?,?,?,?,?)')
      .run(date, e.memo ?? '', e.sourceType ?? 'manual', e.sourceId ?? null, e.reversesId ?? null, e.userId ?? null, ctx.now(), e.reason ?? null);
    const entryId = Number(res.lastInsertRowid);
    const acct = db.prepare('SELECT id FROM accounts WHERE code = ?');
    const ins = db.prepare('INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES (?,?,?,?)');
    for (const l of lines) {
      const a = acct.get(l.account);
      if (!a) throw new AppError(400, 'UNKNOWN_ACCOUNT', `Unknown account code ${l.account}`);
      ins.run(entryId, a.id, l.debit ?? 0, l.credit ?? 0);
    }
    audit(ctx, {
      userId: e.userId, action: 'entry.posted', type: 'journal_entry', id: entryId,
      newValue: { date, memo: e.memo ?? '', source: e.sourceType ?? 'manual', lines },
      reason: e.reason ?? null,
    });
    return { id: entryId, date };
  });
}

export function reverseEntry(ctx, userId, entryId, reason) {
  const { db } = ctx;
  if (!reason || !String(reason).trim()) throw new AppError(400, 'REASON_REQUIRED', 'A reversal needs a reason');
  const entry = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(entryId);
  if (!entry) throw new AppError(404, 'NOT_FOUND', 'Entry not found');
  if (entry.reverses_id) throw new AppError(400, 'CANNOT_REVERSE_REVERSAL', 'A reversal cannot itself be reversed; post a new entry');
  if (db.prepare('SELECT 1 FROM journal_entries WHERE reverses_id = ?').get(entryId)) {
    throw new AppError(409, 'ALREADY_REVERSED', 'This entry has already been reversed');
  }
  const lines = db
    .prepare('SELECT a.code AS account, l.debit, l.credit FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ?')
    .all(entryId)
    .map((l) => ({ account: l.account, debit: l.credit, credit: l.debit })); // swap sides
  return postEntry(ctx, {
    userId, lines, reason, reversesId: entryId, sourceType: 'reversal', sourceId: entryId,
    memo: `Reversal of entry #${entryId}: ${entry.memo}`,
  });
}

export function setPeriodLock(ctx, userId, throughDate, mode, reason) {
  const { db } = ctx;
  if (!reason || !String(reason).trim()) throw new AppError(400, 'REASON_REQUIRED', 'Changing the period lock needs a reason');
  if (mode !== 'none' && !['soft', 'hard'].includes(mode)) throw new AppError(400, 'BAD_MODE', 'Mode must be soft, hard or none');
  if (mode !== 'none' && !/^\d{4}-\d{2}-\d{2}$/.test(throughDate ?? '')) throw new AppError(400, 'BAD_DATE', 'Date must be YYYY-MM-DD');
  const old = getLock(db);
  const next = mode === 'none' ? { through_date: null, mode: null } : { through_date: throughDate, mode };
  tx(db, () => {
    db.prepare('UPDATE period_lock SET through_date = ?, mode = ? WHERE id = 1').run(next.through_date, next.mode);
    audit(ctx, { userId, action: 'period.lock', type: 'period_lock', id: 1, oldValue: old, newValue: next, reason });
  });
  return next;
}

export const getPeriodLock = getLock;

export function trialBalance(db) {
  const rows = db
    .prepare(`SELECT a.code, a.name, a.name_ar, a.type,
                COALESCE(SUM(l.debit), 0) AS debit, COALESCE(SUM(l.credit), 0) AS credit
              FROM accounts a LEFT JOIN journal_lines l ON l.account_id = a.id
              GROUP BY a.id ORDER BY a.code`)
    .all()
    .map((r) => ({ ...r, balance: r.debit - r.credit }));
  const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
  return { rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
}

export function accountBalance(db, code) {
  const r = db
    .prepare(`SELECT COALESCE(SUM(l.debit),0) AS d, COALESCE(SUM(l.credit),0) AS c
              FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = ?`)
    .get(code);
  return { debit: r.d, credit: r.c, net: r.d - r.c };
}

export function profitAndLoss(db) {
  const { rows } = trialBalance(db);
  const revenue = rows.filter((r) => r.type === 'revenue').map((r) => ({ ...r, amount: r.credit - r.debit }));
  const expenses = rows.filter((r) => r.type === 'expense').map((r) => ({ ...r, amount: r.debit - r.credit }));
  const totalRevenue = revenue.reduce((s, r) => s + r.amount, 0);
  const totalExpenses = expenses.reduce((s, r) => s + r.amount, 0);
  return { revenue, expenses, totalRevenue, totalExpenses, netProfit: totalRevenue - totalExpenses };
}

export function recentEntries(db, limit = 10) {
  return db
    .prepare(`SELECT e.id, e.entry_date, e.memo, e.source_type, e.reverses_id, e.reason, e.created_by,
                (SELECT SUM(debit) FROM journal_lines WHERE entry_id = e.id) AS amount,
                EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_id = e.id) AS reversed
              FROM journal_entries e ORDER BY e.id DESC LIMIT ?`)
    .all(limit)
    .map((r) => ({ ...r, reversed: !!r.reversed }));
}
