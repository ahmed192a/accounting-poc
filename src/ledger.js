import { AppError } from './errors.js';
import { emit } from './hooks.js';
import { getCurrency, crossRate, convertWithRate } from './modules/entities/fxcore.js';

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

const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);

/**
 * Validate and normalise lines for one entity. A line is in the entity's own currency (debit/credit only) or carries
 * a foreign amount: { currency: 'USD', fxAmount: 10000, rate?: micro, debit|credit | side: 'debit'|'credit' }.
 * debit/credit are ALWAYS the entity's currency; when only fxAmount+side are given the base amount is derived from the
 * rate (explicit `rate` micro, else the stored rate on `date`). fxAdjustment:true allows fxAmount 0 (revaluation lines).
 */
function normalizeLines(db, entity, lines, date) {
  const mt = getCurrency(db, entity.currency).minor_units;
  return lines.map((l) => {
    const out = { account: l.account, debit: l.debit ?? 0, credit: l.credit ?? 0 };
    const cur = String(l.currency ?? entity.currency).toUpperCase();
    if (l.fxAmount == null && cur === entity.currency) return out;
    if (cur === entity.currency) throw new AppError(400, 'BAD_FX', 'A foreign amount needs a currency different from the entity currency');
    const c = getCurrency(db, cur);
    if (!c.active) throw new AppError(409, 'CURRENCY_INACTIVE', `Currency ${cur} is not active`);
    const fx = l.fxAmount;
    if (!Number.isInteger(fx) || fx < 0 || (fx === 0 && !l.fxAdjustment)) throw new AppError(400, 'BAD_FX', 'fxAmount must be a positive whole number of minor units');
    if (l.rate != null && (!Number.isInteger(l.rate) || l.rate <= 0)) throw new AppError(400, 'BAD_RATE', 'rate must be a positive integer (micro units)');
    const rate = l.rate ?? crossRate(db, cur, entity.currency, date);
    Object.assign(out, { currency: cur, fxAmount: fx, rate });
    if (!out.debit && !out.credit && fx > 0) {
      if (l.side !== 'debit' && l.side !== 'credit') throw new AppError(400, 'BAD_LINE', 'A foreign line without debit/credit needs side: debit or credit');
      out[l.side] = convertWithRate(fx, rate, c.minor_units, mt);
      out.derived = true;
    }
    if (l.fxAdjustment) out.fxAdjustment = true;
    return out;
  });
}

/**
 * Post a balanced journal entry. Entries are never edited or deleted: corrections are reversals.
 * lines: [{ account: '1000', debit?: piastres, credit?: piastres }]
 * Optional (all backwards compatible): entityId (default 1); per line currency, fxAmount, rate, side (see normalizeLines);
 * allowRounding: absorb a rounding difference of at most one minor unit per derived foreign line.
 */
export function postEntry(ctx, e) {
  const { db } = ctx;
  const raw = e.lines ?? [];
  if (raw.length < 2) throw new AppError(400, 'BAD_ENTRY', 'An entry needs at least two lines');

  const entityId = e.entityId ?? 1;
  const entity = Number.isInteger(entityId) ? db.prepare('SELECT id, currency, active FROM entities WHERE id = ?').get(entityId) : null;
  if (!entity) throw new AppError(404, 'ENTITY_NOT_FOUND', `Unknown entity ${entityId}`);
  if (!entity.active && !e.allowInactive) throw new AppError(409, 'ENTITY_INACTIVE', 'This entity is deactivated and cannot be posted to');

  const date = e.date ?? isoDate(ctx.now());
  if (!validDate(date)) throw new AppError(400, 'BAD_DATE', 'Date must be YYYY-MM-DD');

  const lines = normalizeLines(db, entity, raw, date);
  const sums = () => lines.reduce((a, l) => ({ d: a.d + l.debit, c: a.c + l.credit }), { d: 0, c: 0 });
  let roundingAdjust = 0;
  if (e.allowRounding) {
    const { d, c } = sums();
    const diff = d - c;
    const derived = lines.filter((l) => l.derived);
    if (diff !== 0 && Math.abs(diff) <= derived.length) {
      // Put the difference on the last derived line on the side that keeps the entry positive.
      const target = [...derived].reverse().find((l) => (diff > 0 ? l.credit > 0 : l.debit > 0)) ?? derived[derived.length - 1];
      if (diff > 0) { if (target.credit > 0) target.credit += diff; else target.debit -= diff; }
      else if (target.debit > 0) target.debit += -diff; else target.credit -= -diff;
      roundingAdjust = diff;
    }
  }

  let debit = 0, credit = 0;
  for (const l of lines) {
    const d = l.debit, c = l.credit;
    if (!Number.isInteger(d) || !Number.isInteger(c) || d < 0 || c < 0 || (d > 0 && c > 0) || d + c === 0) {
      throw new AppError(400, 'BAD_LINE', 'Each line needs exactly one positive whole-piastre amount, debit or credit');
    }
    debit += d;
    credit += c;
  }
  if (debit !== credit) throw new AppError(400, 'UNBALANCED', `Entry is not balanced: debits ${debit} vs credits ${credit}`);

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
      .prepare('INSERT INTO journal_entries (entity_id, entry_date, memo, source_type, source_id, reverses_id, created_by, created_at, reason) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(entity.id, date, e.memo ?? '', e.sourceType ?? 'manual', e.sourceId ?? null, e.reversesId ?? null, e.userId ?? null, ctx.now(), e.reason ?? null);
    const entryId = Number(res.lastInsertRowid);
    const acct = db.prepare('SELECT id, active FROM accounts WHERE code = ?');
    const ins = db.prepare('INSERT INTO journal_lines (entry_id, account_id, debit, credit, currency, fx_amount, fx_rate) VALUES (?,?,?,?,?,?,?)');
    for (const l of lines) {
      const a = acct.get(l.account);
      if (!a) throw new AppError(400, 'UNKNOWN_ACCOUNT', `Unknown account code ${l.account}`);
      if (!a.active && !e.allowInactive) throw new AppError(409, 'ACCOUNT_INACTIVE', `Account ${l.account} is deactivated and cannot be posted to`);
      ins.run(entryId, a.id, l.debit, l.credit, l.currency ?? entity.currency, l.fxAmount ?? null, l.rate ?? null);
    }
    const clean = lines.map(({ derived, ...rest }) => rest);
    audit(ctx, {
      userId: e.userId, action: 'entry.posted', type: 'journal_entry', id: entryId,
      newValue: { date, memo: e.memo ?? '', source: e.sourceType ?? 'manual', entityId: entity.id, lines: clean, ...(roundingAdjust ? { roundingAdjust } : {}) },
      reason: e.reason ?? null,
    });
    emit(ctx, 'entry.posted', { entryId, date, lines: clean, entityId: entity.id, sourceType: e.sourceType ?? 'manual', sourceId: e.sourceId ?? null, reversesId: e.reversesId ?? null, userId: e.userId ?? null });
    return { id: entryId, date };
  });
}

/** Opt: { date, confirmSoftLock } post the reversal on a given date (default today) and confirm a soft lock. */
export function reverseEntry(ctx, userId, entryId, reason, opt = {}) {
  const { db } = ctx;
  if (!reason || !String(reason).trim()) throw new AppError(400, 'REASON_REQUIRED', 'A reversal needs a reason');
  const entry = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(entryId);
  if (!entry) throw new AppError(404, 'NOT_FOUND', 'Entry not found');
  if (entry.reverses_id) throw new AppError(400, 'CANNOT_REVERSE_REVERSAL', 'A reversal cannot itself be reversed; post a new entry');
  if (db.prepare('SELECT 1 FROM journal_entries WHERE reverses_id = ?').get(entryId)) {
    throw new AppError(409, 'ALREADY_REVERSED', 'This entry has already been reversed');
  }
  // Same entity, same currencies and foreign amounts, sides swapped, so foreign balances net to zero too.
  const lines = db
    .prepare('SELECT a.code AS account, l.debit, l.credit, l.currency, l.fx_amount, l.fx_rate FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.id')
    .all(entryId)
    .map((l) => ({
      account: l.account, debit: l.credit, credit: l.debit, // swap sides
      ...(l.fx_amount != null ? { currency: l.currency, fxAmount: l.fx_amount, rate: l.fx_rate, fxAdjustment: true } : {}),
    }));
  return postEntry(ctx, {
    userId, lines, reason, reversesId: entryId, sourceType: 'reversal', sourceId: entryId,
    entityId: entry.entity_id, allowInactive: true, date: opt.date, confirmSoftLock: opt.confirmSoftLock,
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

// Optional scoping for every report: { entityId, from, to } (to = inclusive "as of" date). No options = whole ledger.
function scope(opts = {}) {
  const w = [], p = [];
  if (opts.entityId != null) { w.push('e.entity_id = ?'); p.push(opts.entityId); }
  if (opts.from) { w.push('e.entry_date >= ?'); p.push(opts.from); }
  if (opts.to) { w.push('e.entry_date <= ?'); p.push(opts.to); }
  return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', params: p };
}

export function trialBalance(db, opts = {}) {
  const sc = scope(opts);
  const rows = db
    .prepare(`SELECT a.code, a.name, a.name_ar, a.type,
                COALESCE(SUM(l.debit), 0) AS debit, COALESCE(SUM(l.credit), 0) AS credit
              FROM accounts a LEFT JOIN (SELECT jl.* FROM journal_lines jl JOIN journal_entries e ON e.id = jl.entry_id ${sc.where}) l ON l.account_id = a.id
              GROUP BY a.id ORDER BY a.code`)
    .all(...sc.params)
    .map((r) => ({ ...r, balance: r.debit - r.credit }));
  const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
  return { rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
}

export function accountBalance(db, code, opts = {}) {
  const sc = scope(opts);
  const r = db
    .prepare(`SELECT COALESCE(SUM(l.debit),0) AS d, COALESCE(SUM(l.credit),0) AS c
              FROM journal_lines l JOIN accounts a ON a.id = l.account_id JOIN journal_entries e ON e.id = l.entry_id
              ${sc.where ? sc.where + ' AND' : 'WHERE'} a.code = ?`)
    .get(...sc.params, code);
  return { debit: r.d, credit: r.c, net: r.d - r.c };
}

export function profitAndLoss(db, opts = {}) {
  const { rows } = trialBalance(db, opts);
  const revenue = rows.filter((r) => r.type === 'revenue').map((r) => ({ ...r, amount: r.credit - r.debit }));
  const expenses = rows.filter((r) => r.type === 'expense').map((r) => ({ ...r, amount: r.debit - r.credit }));
  const totalRevenue = revenue.reduce((s, r) => s + r.amount, 0);
  const totalExpenses = expenses.reduce((s, r) => s + r.amount, 0);
  return { revenue, expenses, totalRevenue, totalExpenses, netProfit: totalRevenue - totalExpenses };
}

export function recentEntries(db, limit = 10, opts = {}) {
  const sc = scope(opts);
  return db
    .prepare(`SELECT e.id, e.entity_id, e.entry_date, e.memo, e.source_type, e.reverses_id, e.reason, e.created_by,
                (SELECT SUM(debit) FROM journal_lines WHERE entry_id = e.id) AS amount,
                EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_id = e.id) AS reversed
              FROM journal_entries e ${sc.where} ORDER BY e.id DESC LIMIT ?`)
    .all(...sc.params, limit)
    .map((r) => ({ ...r, reversed: !!r.reversed }));
}
