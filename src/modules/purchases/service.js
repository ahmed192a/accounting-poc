import { AppError, posInt } from '../../errors.js';
import { postEntry, tx, audit, accountBalance } from '../../ledger.js';
import { requirePerm, limitFor } from '../../permissions.js';
import { setting } from '../../db.js';

const EXPENSE_CODES = { purchases: '5000', rent: '5100', utilities: '5200' };

// Amount limits, auto-approval, approval with separation of duties.
function postBill(ctx, bill, approverId) {
  return postEntry(ctx, {
    userId: approverId, memo: `Bill from ${bill.supplier}`, sourceType: 'bill', sourceId: bill.id,
    lines: [{ account: EXPENSE_CODES[bill.category], debit: bill.amount }, { account: '2000', credit: bill.amount }],
  });
}

export function createBill(ctx, user, input) {
  requirePerm(user, 'purchases.create');
  const { db } = ctx;
  const amount = posInt(input.amount, 'amount');
  if (!input.supplier) throw new AppError(400, 'BAD_INPUT', 'Supplier is required');
  if (!EXPENSE_CODES[input.category]) throw new AppError(400, 'BAD_INPUT', `Category must be one of ${Object.keys(EXPENSE_CODES).join(', ')}`);
  if (amount > limitFor(user, 'purchases.create')) {
    throw new AppError(403, 'OVER_LIMIT', `Amount is above your bill-creation limit of ${limitFor(user, 'purchases.create') / 100} EGP`);
  }
  const auto = amount <= Number(setting(db, 'bill_auto_approve'));
  return tx(db, () => {
    const res = db
      .prepare('INSERT INTO bills (supplier, amount, category, status, created_by, created_at) VALUES (?,?,?,?,?,?)')
      .run(input.supplier, amount, input.category, auto ? 'approved' : 'pending_approval', user.id, ctx.now());
    const bill = { id: Number(res.lastInsertRowid), supplier: input.supplier, amount, category: input.category };
    if (auto) {
      const entry = postBill(ctx, bill, user.id);
      db.prepare('UPDATE bills SET entry_id = ? WHERE id = ?').run(entry.id, bill.id);
    }
    audit(ctx, { userId: user.id, action: auto ? 'bill.auto_approved' : 'bill.submitted', type: 'bill', id: bill.id, newValue: { amount } });
    return { id: bill.id, status: auto ? 'approved' : 'pending_approval' };
  });
}

export function approveBill(ctx, user, id) {
  requirePerm(user, 'purchases.approve');
  const { db } = ctx;
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
  if (!bill) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
  if (bill.status !== 'pending_approval') throw new AppError(409, 'NOT_PENDING', 'Bill is not waiting for approval');
  if (bill.created_by === user.id) throw new AppError(403, 'SEPARATION_OF_DUTIES', 'You cannot approve a bill you created');
  if (bill.amount > limitFor(user, 'purchases.approve')) {
    throw new AppError(403, 'OVER_LIMIT', `Bill is above your approval limit of ${limitFor(user, 'purchases.approve') / 100} EGP`);
  }
  return tx(db, () => {
    const entry = postBill(ctx, bill, user.id);
    db.prepare("UPDATE bills SET status = 'approved', approved_by = ?, entry_id = ? WHERE id = ?").run(user.id, entry.id, id);
    audit(ctx, { userId: user.id, action: 'bill.approved', type: 'bill', id, newValue: { entryId: entry.id } });
    return { id, entryId: entry.id };
  });
}

export const listBills = (ctx, user) => {
  requirePerm(user, 'purchases.view');
  return ctx.db.prepare('SELECT * FROM bills ORDER BY id DESC').all();
};

// Home widgets: payables (needs reports.view) and the approval queue.
export function widgets(ctx, user) {
  const { db } = ctx;
  const has = (p) => user.permissions.has(p);
  const w = {};
  if (has('reports.view')) w.payables = { total: -accountBalance(db, '2000').net };
  if (has('purchases.approve')) {
    w.approvals = db.prepare("SELECT id, supplier, amount, category, created_by FROM bills WHERE status = 'pending_approval' ORDER BY id").all()
      .map((b) => ({ ...b, canApprove: b.created_by !== user.id && b.amount <= limitFor(user, 'purchases.approve') }));
  }
  return w;
}
