import { AppError } from '../../errors.js';
import { tx, audit, postEntry, reverseEntry, trialBalance, isoDate } from '../../ledger.js';
import { requirePerm } from '../../permissions.js';
import { getCurrency, getRate, convertMinor, convertAmount, parseRate, formatRate } from './fxcore.js';
import { assertEntityAccess, canAccessEntity } from './service.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IC_RECEIVABLE = '1500', IC_PAYABLE = '2500', CTA = '3100';

/**
 * Consolidated trial balance across entities, in one report currency (default EGP).
 *  1. each entity's trial balance (as of a date) is translated from its own currency: balance-sheet accounts at the
 *     closing rate, revenue/expense at the closing rate unless `averageRates` ({USD:'48.2'}) are given;
 *  2. intercompany receivable 1500 and payable 2500 are eliminated;
 *  3. the translation difference, rounding and any unmatched intercompany balance land on 3100 Currency translation
 *     reserve, so the consolidated report always balances.
 * Simplification (UNVERIFIED against IAS 21): equity is translated at the closing rate, not historical rates.
 */
export function consolidate(ctx, user, input = {}) {
  requirePerm(user, 'entities.view');
  requirePerm(user, 'reports.view');
  const { db } = ctx;
  const asOf = input.asOf ?? isoDate(ctx.now());
  if (!DATE.test(asOf)) throw new AppError(400, 'BAD_DATE', 'asOf must be YYYY-MM-DD');
  const report = getCurrency(db, input.currency ?? 'EGP');
  const avg = {};
  for (const [c, v] of Object.entries(input.averageRates ?? {})) avg[getCurrency(db, c).code] = parseRate(v);

  let ids = input.entityIds;
  if (typeof ids === 'string') ids = ids.split(',').filter(Boolean).map(Number);
  let entities;
  if (ids == null) entities = db.prepare('SELECT * FROM entities WHERE active = 1 ORDER BY id').all().filter((e) => canAccessEntity(ctx, user, e.id));
  else {
    if (!Array.isArray(ids) || !ids.length || ids.some((i) => !Number.isInteger(i))) throw new AppError(400, 'BAD_INPUT', 'entityIds must be a non-empty list of entity ids');
    entities = [...new Set(ids)].map((i) => assertEntityAccess(ctx, user, i));
  }
  if (!entities.length) throw new AppError(400, 'BAD_INPUT', 'No entities to consolidate');

  const rowsByCode = new Map();
  const entityInfo = [];
  let sumNet = 0;
  for (const e of entities) {
    const cur = getCurrency(db, e.currency);
    const closing = e.currency === report.code ? null : { rate: getRate(db, cur.code, asOf), minor: cur.minor_units };
    const to = { rate: getRate(db, report.code, asOf), minor: report.minor_units };
    const from = (type) => ({ rate: (type === 'revenue' || type === 'expense') && avg[cur.code] ? avg[cur.code] : closing?.rate, minor: cur.minor_units });
    const tb = trialBalance(db, { entityId: e.id, to: asOf });
    let profit = 0;
    for (const r of tb.rows) {
      const net = r.debit - r.credit;
      if (net === 0) continue;
      const tr = closing ? convertMinor(net, from(r.type), to) : net;
      if (r.type === 'revenue' || r.type === 'expense') profit -= tr;
      sumNet += tr;
      const row = rowsByCode.get(r.code) ?? { code: r.code, name: r.name, name_ar: r.name_ar, type: r.type, byEntity: {}, net: 0 };
      row.byEntity[e.id] = (row.byEntity[e.id] ?? 0) + tr;
      row.net += tr;
      rowsByCode.set(r.code, row);
    }
    entityInfo.push({ id: e.id, code: e.code, name: e.name, currency: e.currency, rate: closing ? formatRate(closing.rate) : null, balanced: tb.balanced, netProfit: profit });
  }

  const n1 = rowsByCode.get(IC_RECEIVABLE)?.net ?? 0, n2 = rowsByCode.get(IC_PAYABLE)?.net ?? 0;
  rowsByCode.delete(IC_RECEIVABLE);
  rowsByCode.delete(IC_PAYABLE);
  const plug = -(sumNet - n1 - n2);
  if (plug !== 0) {
    const meta = db.prepare('SELECT code, name, name_ar, type FROM accounts WHERE code = ?').get(CTA);
    const row = rowsByCode.get(CTA) ?? { ...meta, byEntity: {}, net: 0 };
    row.net += plug;
    row.byEntity.adjustment = plug;
    rowsByCode.set(CTA, row);
  }
  const rows = [...rowsByCode.values()].sort((a, b) => (a.code < b.code ? -1 : 1))
    .filter((r) => r.net !== 0)
    .map((r) => ({ ...r, debit: Math.max(r.net, 0), credit: Math.max(-r.net, 0) }));
  const totalDebit = rows.reduce((s, r) => s + r.debit, 0), totalCredit = rows.reduce((s, r) => s + r.credit, 0);
  const rev = rows.filter((r) => r.type === 'revenue').reduce((s, r) => s - r.net, 0);
  const exp = rows.filter((r) => r.type === 'expense').reduce((s, r) => s + r.net, 0);
  return {
    asOf, currency: report.code, entities: entityInfo, rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit,
    netProfit: rev - exp,
    eliminations: { receivable: n1, payable: -n2, difference: n1 + n2 },
    translationAdjustment: -sumNet,
  };
}

/**
 * Intercompany transaction: the "from" entity lends (or charges) the "to" entity. Two mirrored, balanced entries are
 * posted atomically, one in each entity, and tied together by a group row:
 *   from: Dr 1500 Intercompany receivable / Cr lenderAccount     to: Dr borrowerAccount / Cr 2500 Intercompany payable
 * `amount` is in the from-entity currency; the to-entity amount is converted at the rate on `date` unless `amountTo` is given.
 */
export function postIntercompany(ctx, user, input = {}) {
  requirePerm(user, 'ledger.post');
  const { db } = ctx;
  const fromId = input.fromEntityId, toId = input.toEntityId;
  if (!Number.isInteger(fromId) || !Number.isInteger(toId)) throw new AppError(400, 'BAD_INPUT', 'fromEntityId and toEntityId are required');
  if (fromId === toId) throw new AppError(400, 'BAD_INPUT', 'An intercompany transaction needs two different entities');
  const from = assertEntityAccess(ctx, user, fromId), to = assertEntityAccess(ctx, user, toId);
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw new AppError(400, 'BAD_INPUT', 'amount must be a positive whole number of minor units');
  const date = input.date ?? isoDate(ctx.now());
  if (!DATE.test(date)) throw new AppError(400, 'BAD_DATE', 'Date must be YYYY-MM-DD');
  const amountTo = input.amountTo ?? convertAmount(db, input.amount, from.currency, to.currency, date);
  if (!Number.isInteger(amountTo) || amountTo <= 0) throw new AppError(400, 'BAD_INPUT', 'amountTo must be a positive whole number');
  const lender = input.lenderAccount ?? '1000', borrower = input.borrowerAccount ?? '1000';
  const memo = String(input.memo ?? '').trim() || 'Intercompany transaction';
  return tx(db, () => {
    const groupId = Number(db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM entities_ic_groups').get().n);
    const common = { userId: user.id, date, sourceType: 'intercompany', sourceId: groupId, confirmSoftLock: input.confirmSoftLock, reason: input.reason };
    const a = postEntry(ctx, { ...common, entityId: fromId, memo: `${memo} (to ${to.code})`, lines: [{ account: IC_RECEIVABLE, debit: input.amount }, { account: lender, credit: input.amount }] });
    const b = postEntry(ctx, { ...common, entityId: toId, memo: `${memo} (from ${from.code})`, lines: [{ account: borrower, debit: amountTo }, { account: IC_PAYABLE, credit: amountTo }] });
    db.prepare('INSERT INTO entities_ic_groups (id, from_entity_id, to_entity_id, amount_from, amount_to, entry_date, memo, from_entry_id, to_entry_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(groupId, fromId, toId, input.amount, amountTo, date, memo, a.id, b.id, user.id, ctx.now());
    audit(ctx, { userId: user.id, action: 'intercompany.posted', type: 'ic_group', id: groupId, newValue: { fromEntityId: fromId, toEntityId: toId, amountFrom: input.amount, amountTo, date, entries: [a.id, b.id] } });
    return { groupId, fromEntryId: a.id, toEntryId: b.id, amountFrom: input.amount, amountTo };
  });
}

export function reverseIntercompany(ctx, user, groupId, reason) {
  requirePerm(user, 'ledger.reverse');
  const g = ctx.db.prepare('SELECT * FROM entities_ic_groups WHERE id = ?').get(groupId);
  if (!g) throw new AppError(404, 'NOT_FOUND', 'Intercompany group not found');
  assertEntityAccess(ctx, user, g.from_entity_id);
  assertEntityAccess(ctx, user, g.to_entity_id);
  return tx(ctx.db, () => {
    const a = reverseEntry(ctx, user.id, g.from_entry_id, reason);
    const b = reverseEntry(ctx, user.id, g.to_entry_id, reason);
    audit(ctx, { userId: user.id, action: 'intercompany.reversed', type: 'ic_group', id: groupId, reason });
    return { groupId, reversalIds: [a.id, b.id] };
  });
}

export function listIntercompany(ctx, user) {
  requirePerm(user, 'entities.view');
  return ctx.db.prepare('SELECT * FROM entities_ic_groups ORDER BY id DESC LIMIT 50').all()
    .filter((g) => canAccessEntity(ctx, user, g.from_entity_id) && canAccessEntity(ctx, user, g.to_entity_id));
}
