import { AppError } from '../../errors.js';
import { requirePerm } from '../../permissions.js';
import { validDate, today, daysBetween } from './util.js';


/**
 * Supplier statement: posted bills increase what we owe, live payments reduce it, running balance in piastres.
 * Voided bills and voided payments are left out (their ledger reversals net to zero).
 */
export function supplierStatement(ctx, user, supplierId, query = {}) {
  requirePerm(user, 'purchases.view');
  const { db } = ctx;
  const supplier = db.prepare('SELECT * FROM purchases_suppliers WHERE id = ?').get(supplierId);
  if (!supplier) throw new AppError(404, 'NOT_FOUND', 'Supplier not found');
  const from = query.from ? validDate(query.from, 'from') : '0000-01-01';
  const to = query.to ? validDate(query.to, 'to') : '9999-12-31';
  if (to < from) throw new AppError(400, 'BAD_RANGE', 'to must not be before from');
  const events = [
    ...db.prepare("SELECT id, bill_date AS date, amount, number AS ref FROM bills WHERE supplier_id = ? AND status IN ('approved','partially_paid','paid')").all(supplierId)
      .map((b) => ({ date: b.date, type: 'bill', id: b.id, ref: b.ref, charge: b.amount, payment: 0 })),
    ...db.prepare("SELECT id, paid_date AS date, amount, reference AS ref FROM purchases_payments WHERE supplier_id = ? AND status = 'posted'").all(supplierId)
      .map((p) => ({ date: p.date, type: 'payment', id: p.id, ref: p.ref, charge: 0, payment: p.amount })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.type === b.type ? a.id - b.id : a.type === 'bill' ? -1 : 1));
  let balance = 0, opening = 0;
  const rows = [];
  for (const e of events) {
    balance += e.charge - e.payment;
    if (e.date < from) { opening = balance; continue; }
    if (e.date > to) continue;
    rows.push({ ...e, balance });
  }
  return { supplier: { id: supplier.id, name: supplier.name, taxId: supplier.tax_id }, from: query.from ?? null, to: query.to ?? null, opening, rows, closing: rows.length ? rows[rows.length - 1].balance : opening };
}

export const BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'];

function bucketOf(overdueDays) {
  if (overdueDays <= 0) return 'current';
  if (overdueDays <= 30) return 'd1_30';
  if (overdueDays <= 60) return 'd31_60';
  if (overdueDays <= 90) return 'd61_90';
  return 'd90_plus';
}

/** AP aging by due date as of a date (default today by the demo clock): what is owed, and how late it is. */
export function apAging(ctx, user, query = {}) {
  requirePerm(user, 'purchases.view');
  const asOf = query.asOf ? validDate(query.asOf, 'asOf') : today(ctx);
  const bills = ctx.db.prepare(`SELECT b.*, s.name AS supplier_name FROM bills b JOIN purchases_suppliers s ON s.id = b.supplier_id
    WHERE b.status IN ('approved','partially_paid') AND b.bill_date <= ? ORDER BY s.name, b.due_date`).all(asOf);
  const suppliers = new Map();
  const totals = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  totals.total = 0;
  for (const b of bills) {
    const open = b.amount - b.paid;
    if (open <= 0) continue;
    const bucket = bucketOf(daysBetween(b.due_date, asOf));
    const row = suppliers.get(b.supplier_id) ?? { supplierId: b.supplier_id, supplier: b.supplier_name, ...Object.fromEntries(BUCKETS.map((k) => [k, 0])), total: 0, bills: [] };
    row[bucket] += open; row.total += open;
    totals[bucket] += open; totals.total += open;
    row.bills.push({ id: b.id, number: b.number, dueDate: b.due_date, outstanding: open, daysOverdue: Math.max(0, daysBetween(b.due_date, asOf)), bucket });
    suppliers.set(b.supplier_id, row);
  }
  return { asOf, suppliers: [...suppliers.values()], totals };
}
