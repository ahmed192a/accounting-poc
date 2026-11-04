import { AppError, posInt } from '../../errors.js';
import { postEntry, reverseEntry, tx, audit } from '../../ledger.js';
import { requirePerm, limitFor } from '../../permissions.js';
import { emit } from '../../hooks.js';
import { cleanText, validDate, today } from './util.js';
import { resolveSupplier } from './suppliers.js';

// Supplier payments: Dr 2000 Accounts payable, Cr cash / bank / wallet. Allocation to bills is explicit, or
// oldest-due-first when omitted. Partial payments move a bill to partially_paid, full settlement to paid.
const METHOD_ACCOUNT = { cash: '1000', bank: '1010', wallet: '1020' }; // 1010/1020 are created by the banking module

const OPEN = "('approved','partially_paid')";

function statusFor(bill, paid) {
  return paid >= bill.amount ? 'paid' : paid > 0 ? 'partially_paid' : 'approved';
}

export function paySupplier(ctx, user, input = {}) {
  requirePerm(user, 'purchases.pay');
  const { db } = ctx;
  const amount = posInt(input.amount, 'amount');
  if (amount > limitFor(user, 'purchases.pay')) throw new AppError(403, 'OVER_LIMIT', `Amount is above your payment limit of ${limitFor(user, 'purchases.pay') / 100} EGP`);
  const method = input.method ?? 'cash';
  const account = METHOD_ACCOUNT[method];
  if (!account) throw new AppError(400, 'BAD_INPUT', `method must be one of ${Object.keys(METHOD_ACCOUNT).join(', ')}`);
  if (!db.prepare('SELECT 1 FROM accounts WHERE code = ?').get(account)) throw new AppError(409, 'METHOD_UNAVAILABLE', `Payment method ${method} is not set up (no account ${account})`);
  const paidDate = input.paidDate ? validDate(input.paidDate, 'paidDate') : today(ctx);
  const reference = cleanText(input.reference, 'reference', { max: 100 });

  return tx(db, () => {
    const supplier = resolveSupplier(ctx, user.id, { supplierId: input.supplierId, supplier: input.supplier });
    let allocs;
    if (input.allocations != null) {
      if (!Array.isArray(input.allocations) || !input.allocations.length) throw new AppError(400, 'BAD_INPUT', 'allocations must be a non-empty list');
      allocs = input.allocations.map((a) => ({ billId: a?.billId, amount: posInt(a?.amount, 'allocation amount') }));
      if (new Set(allocs.map((a) => a.billId)).size !== allocs.length) throw new AppError(400, 'BAD_INPUT', 'A bill can appear only once in allocations');
      const sum = allocs.reduce((s, a) => s + a.amount, 0);
      if (sum !== amount) throw new AppError(400, 'ALLOCATION_MISMATCH', `Allocations add up to ${sum}, the payment is ${amount}`);
    } else {
      // Oldest due date first.
      allocs = [];
      let left = amount;
      const open = db.prepare(`SELECT * FROM bills WHERE supplier_id = ? AND status IN ${OPEN} ORDER BY due_date, id`).all(supplier.id);
      for (const b of open) {
        if (left <= 0) break;
        const take = Math.min(left, b.amount - b.paid);
        allocs.push({ billId: b.id, amount: take });
        left -= take;
      }
      if (left > 0) throw new AppError(409, 'OVERPAYMENT', `The payment is ${left} more than everything this supplier is owed`);
    }
    for (const a of allocs) {
      const b = db.prepare('SELECT * FROM bills WHERE id = ?').get(a.billId);
      if (!b) throw new AppError(404, 'NOT_FOUND', `Bill ${a.billId} not found`);
      if (b.supplier_id !== supplier.id) throw new AppError(409, 'SUPPLIER_MISMATCH', `Bill ${b.id} belongs to another supplier`);
      if (!['approved', 'partially_paid'].includes(b.status)) throw new AppError(409, 'NOT_PAYABLE', `Bill ${b.id} is ${b.status}; only approved bills can be paid`);
      if (a.amount > b.amount - b.paid) throw new AppError(409, 'OVERPAYMENT', `Bill ${b.id} has only ${b.amount - b.paid} outstanding`);
    }
    const entry = postEntry(ctx, {
      userId: user.id, date: paidDate, memo: `Payment to ${supplier.name}${reference ? ` (${reference})` : ''}`, sourceType: 'bill_payment',
      lines: [{ account: '2000', debit: amount }, { account, credit: amount }],
    });
    const res = db.prepare('INSERT INTO purchases_payments (supplier_id, amount, method, paid_date, reference, entry_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(supplier.id, amount, method, paidDate, reference, entry.id, user.id, ctx.now());
    const id = Number(res.lastInsertRowid);
    for (const a of allocs) {
      const b = db.prepare('SELECT * FROM bills WHERE id = ?').get(a.billId);
      const paid = b.paid + a.amount;
      db.prepare('INSERT INTO purchases_payment_allocations (payment_id, bill_id, amount) VALUES (?,?,?)').run(id, a.billId, a.amount);
      db.prepare('UPDATE bills SET paid = ?, status = ? WHERE id = ?').run(paid, statusFor(b, paid), a.billId);
    }
    audit(ctx, { userId: user.id, action: 'purchases.payment', type: 'supplier_payment', id, newValue: { supplier: supplier.name, amount, method, allocations: allocs, entryId: entry.id } });
    emit(ctx, 'purchases.paid', { paymentId: id, supplierId: supplier.id, amount, entryId: entry.id, userId: user.id });
    return { id, entryId: entry.id, allocations: allocs };
  });
}

export function voidPayment(ctx, user, id, input = {}) {
  requirePerm(user, 'purchases.pay');
  const { db } = ctx;
  const reason = cleanText(input.reason, 'reason', { required: true, max: 300 });
  const p = db.prepare('SELECT * FROM purchases_payments WHERE id = ?').get(id);
  if (!p) throw new AppError(404, 'NOT_FOUND', 'Payment not found');
  if (p.status === 'void') throw new AppError(409, 'ALREADY_VOID', 'Payment is already void');
  return tx(db, () => {
    const rev = reverseEntry(ctx, user.id, p.entry_id, reason);
    for (const a of db.prepare('SELECT * FROM purchases_payment_allocations WHERE payment_id = ?').all(id)) {
      const b = db.prepare('SELECT * FROM bills WHERE id = ?').get(a.bill_id);
      const paid = b.paid - a.amount;
      // A bill voided after being fully paid cannot happen (void refuses bills with payments), so status only moves among the open states.
      db.prepare('UPDATE bills SET paid = ?, status = ? WHERE id = ?').run(paid, statusFor(b, paid), b.id);
    }
    db.prepare("UPDATE purchases_payments SET status = 'void', void_entry_id = ?, void_reason = ? WHERE id = ?").run(rev.id, reason, id);
    audit(ctx, { userId: user.id, action: 'purchases.payment_voided', type: 'supplier_payment', id, reason, newValue: { reversalEntryId: rev.id } });
    return { id, reversalEntryId: rev.id };
  });
}

export function listPayments(ctx, user, query = {}) {
  requirePerm(user, 'purchases.view');
  const rows = ctx.db.prepare(`SELECT p.*, s.name AS supplier FROM purchases_payments p JOIN purchases_suppliers s ON s.id = p.supplier_id
    ${query.supplierId ? 'WHERE p.supplier_id = ?' : ''} ORDER BY p.id DESC`).all(...(query.supplierId ? [Number(query.supplierId)] : []));
  return rows.map((r) => ({ ...r, allocations: ctx.db.prepare('SELECT bill_id, amount FROM purchases_payment_allocations WHERE payment_id = ?').all(r.id) }));
}
