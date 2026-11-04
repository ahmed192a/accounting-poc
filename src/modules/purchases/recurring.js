import { AppError, posInt } from '../../errors.js';
import { audit, tx } from '../../ledger.js';
import { requirePerm } from '../../permissions.js';
import { cleanText, validDate, today, addDays, addMonths, wholeInt, CATEGORIES } from './util.js';
import { resolveSupplier } from './suppliers.js';
import { createBill } from './service.js';

const MAX_CATCH_UP = 12; // bills created per template per run, so a forgotten template cannot flood the books

export function createRecurring(ctx, user, input = {}) {
  requirePerm(user, 'purchases.create');
  const amount = posInt(input.amount, 'amount');
  const vat = input.vat == null ? 0 : wholeInt(input.vat, 'vat', { min: 0 });
  if (vat >= amount) throw new AppError(400, 'BAD_INPUT', 'vat must be smaller than the amount');
  if (!CATEGORIES.includes(input.category)) throw new AppError(400, 'BAD_INPUT', `category must be one of ${CATEGORIES.join(', ')}`);
  if (!['weekly', 'monthly'].includes(input.frequency)) throw new AppError(400, 'BAD_INPUT', 'frequency must be weekly or monthly');
  const start = validDate(input.startDate, 'startDate');
  const end = input.endDate ? validDate(input.endDate, 'endDate') : null;
  if (end && end < start) throw new AppError(400, 'BAD_RANGE', 'endDate must not be before startDate');
  return tx(ctx.db, () => {
    const supplier = resolveSupplier(ctx, user.id, input);
    const res = ctx.db.prepare(`INSERT INTO purchases_recurring (supplier_id, description, amount, vat, category, frequency, anchor_day, next_date, end_date, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(supplier.id, cleanText(input.description, 'description', { max: 200 }), amount, vat, input.category, input.frequency, Number(start.slice(8)), start, end, user.id, ctx.now());
    const id = Number(res.lastInsertRowid);
    audit(ctx, { userId: user.id, action: 'recurring.created', type: 'recurring_bill', id, newValue: { supplier: supplier.name, amount, frequency: input.frequency, start } });
    return { id };
  });
}

export function listRecurring(ctx, user) {
  requirePerm(user, 'purchases.view');
  return ctx.db.prepare('SELECT r.*, s.name AS supplier FROM purchases_recurring r JOIN purchases_suppliers s ON s.id = r.supplier_id ORDER BY r.id DESC').all();
}

export function stopRecurring(ctx, user, id) {
  requirePerm(user, 'purchases.create');
  const r = ctx.db.prepare('SELECT * FROM purchases_recurring WHERE id = ?').get(id);
  if (!r) throw new AppError(404, 'NOT_FOUND', 'Recurring bill not found');
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE purchases_recurring SET active = 0 WHERE id = ?').run(id);
    audit(ctx, { userId: user.id, action: 'recurring.stopped', type: 'recurring_bill', id });
  });
  return { id };
}

const nextOccurrence = (r) => (r.frequency === 'weekly' ? addDays(r.next_date, 7) : addMonths(r.next_date, 1, r.anchor_day));

/**
 * On-demand generator (button or scheduled call): creates a bill for every template whose next date has arrived.
 * Each bill goes through the normal bill path, so approval rules and limits still apply. Atomic per template.
 */
export function runRecurring(ctx, user) {
  requirePerm(user, 'purchases.create');
  const { db } = ctx;
  const t = today(ctx);
  const created = [];
  const due = db.prepare('SELECT * FROM purchases_recurring WHERE active = 1 AND next_date <= ? ORDER BY id').all(t);
  for (const r of due) {
    tx(db, () => {
      let cur = r, n = 0;
      while (cur.next_date <= t && n < MAX_CATCH_UP && (!cur.end_date || cur.next_date <= cur.end_date)) {
        const bill = createBill(ctx, user, { supplierId: cur.supplier_id, amount: cur.amount, vat: cur.vat, category: cur.category, billDate: cur.next_date }, { source: 'recurring', sourceRef: `recurring:${r.id}` });
        created.push({ recurringId: r.id, billId: bill.id, billDate: cur.next_date, status: bill.status });
        cur = { ...cur, next_date: nextOccurrence(cur) };
        n++;
      }
      const finished = cur.end_date && cur.next_date > cur.end_date;
      db.prepare('UPDATE purchases_recurring SET next_date = ?, runs = runs + ?, active = ? WHERE id = ?').run(cur.next_date, n, finished ? 0 : 1, r.id);
      audit(ctx, { userId: user.id, action: 'recurring.run', type: 'recurring_bill', id: r.id, newValue: { created: n, next: cur.next_date } });
    });
  }
  return { created };
}
