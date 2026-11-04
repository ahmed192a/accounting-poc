import { AppError, posInt } from '../../errors.js';
import { postEntry, reverseEntry, tx, audit, accountBalance, getPeriodLock } from '../../ledger.js';
import { requirePerm, limitFor } from '../../permissions.js';
import { setting } from '../../db.js';
import { emit } from '../../hooks.js';
import { openRequest, approveStep, rejectStep, requestForDoc, cancelRequest, canActNow } from '../approvals/engine.js';
import { EXPENSE_CODES, CATEGORIES, cleanText, validDate, today, addDays, wholeInt } from './util.js';
import { resolveSupplier } from './suppliers.js';
import { matchBill, applyBilledQty } from './orders.js';
import { listSuppliers } from './suppliers.js';
import { apAging } from './reports.js';

// Bill status flow:
//   draft --submit--> pending_approval --(last approval step)--> approved (posted) --payments--> partially_paid --> paid
//   pending_approval --reject--> rejected         draft / pending_approval / approved (unpaid) --void--> void
// `approved` = approved and posted to the ledger with nothing paid yet. Paid or partly paid bills cannot be voided:
// void the payments first. Every posting is a journal entry; undoing one is a reversal, never an edit.

// 1400 is reserved for the tax module. Created lazily (INSERT OR IGNORE, only when a bill carries VAT) so this module's
// seed never collides with the tax module's own plain INSERT; whoever runs first wins, the code is the same.
const VAT_INPUT = '1400';

function ensureVatAccount(db) {
  db.prepare("INSERT OR IGNORE INTO accounts (code, name, name_ar, type) VALUES (?,?,?,?)").run(VAT_INPUT, 'VAT input', 'ضريبة القيمة المضافة - مدخلات', 'asset');
}

function postBill(ctx, bill, approverId) {
  const lines = [{ account: '2000', credit: bill.amount }];
  const net = bill.amount - (bill.vat ?? 0);
  lines.push({ account: EXPENSE_CODES[bill.category], debit: net });
  if (bill.vat > 0) {
    ensureVatAccount(ctx.db);
    lines.push({ account: VAT_INPUT, debit: bill.vat });
  }
  return postEntry(ctx, {
    userId: approverId, date: bill.bill_date ?? today(ctx), memo: `Bill from ${bill.supplier}`, sourceType: 'bill', sourceId: bill.id, lines,
  });
}

/** Last approval step done: post the ledger entry and mark the bill approved. Called by the approvals engine inside its transaction. */
export function finalizeBill(ctx, id, approverId, { auto = false } = {}) {
  const { db } = ctx;
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
  if (!bill) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
  if (bill.status !== 'pending_approval' && !(auto && bill.status === 'draft')) throw new AppError(409, 'NOT_PENDING', 'Bill is not waiting for approval');
  const entry = postBill(ctx, bill, approverId);
  db.prepare("UPDATE bills SET status = 'approved', approved_by = ?, entry_id = ? WHERE id = ?").run(approverId, entry.id, id);
  audit(ctx, { userId: approverId, action: auto ? 'bill.auto_approved' : 'bill.approved', type: 'bill', id, newValue: { entryId: entry.id } });
  emit(ctx, 'bill.approved', { bill: { id, supplier: bill.supplier, amount: bill.amount, category: bill.category }, entryId: entry.id, userId: approverId, auto });
  return { entryId: entry.id };
}

export function rejectBillDoc(ctx, id, reason, userId) {
  const { db } = ctx;
  db.prepare("UPDATE bills SET status = 'rejected', reject_reason = ? WHERE id = ?").run(reason, id);
  releasePO(ctx, id);
  audit(ctx, { userId, action: 'bill.rejected', type: 'bill', id, reason });
}

export function cancelBillDoc(ctx, id) {
  releasePO(ctx, id);
}

function releasePO(ctx, billId) {
  const { db } = ctx;
  const bill = db.prepare('SELECT po_id FROM bills WHERE id = ?').get(billId);
  if (!bill?.po_id) return;
  const lines = db.prepare('SELECT po_line_id, qty FROM purchases_bill_lines WHERE bill_id = ? AND po_line_id IS NOT NULL').all(billId);
  applyBilledQty(ctx, bill.po_id, lines, -1);
}

function cleanBillLines(lines) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 100) throw new AppError(400, 'BAD_INPUT', 'lines must hold 1 to 100 entries');
  return lines.map((l, i) => ({
    description: cleanText(l?.description, `line ${i + 1} description`, { required: true, max: 200 }),
    qty: posInt(l?.qty, `line ${i + 1} qty`),
    unitPrice: wholeInt(l?.unitPrice, `line ${i + 1} unitPrice`, { min: 0 }),
    poLineId: l?.poLineId ?? null,
  }));
}

/**
 * Create a bill. `opts.source` is set by trusted server code only ('assist', 'recurring'); the HTTP route never passes it.
 * Bills from assist are NEVER auto-approved, whatever their amount.
 */
export function createBill(ctx, user, input = {}, opts = {}) {
  requirePerm(user, 'purchases.create');
  const { db } = ctx;
  const source = opts.source ?? (input.poId ? 'po' : 'manual');
  const lines = input.lines != null ? cleanBillLines(input.lines) : null;
  const vat = input.vat == null ? 0 : wholeInt(input.vat, 'vat', { min: 0 });
  let amount;
  if (lines) amount = lines.reduce((s, l) => s + l.qty * l.unitPrice, 0) + vat;
  else amount = posInt(input.amount, 'amount');
  if (amount <= 0) throw new AppError(400, 'BAD_INPUT', 'amount must be a positive whole number');
  if (vat >= amount) throw new AppError(400, 'BAD_INPUT', 'vat must be smaller than the bill amount');
  if (!input.supplier && input.supplierId == null) throw new AppError(400, 'BAD_INPUT', 'Supplier is required');
  if (!EXPENSE_CODES[input.category]) throw new AppError(400, 'BAD_INPUT', `Category must be one of ${CATEGORIES.join(', ')}`);
  if (amount > limitFor(user, 'purchases.create')) {
    throw new AppError(403, 'OVER_LIMIT', `Amount is above your bill-creation limit of ${limitFor(user, 'purchases.create') / 100} EGP`);
  }
  const billDate = input.billDate ? validDate(input.billDate, 'billDate') : today(ctx);
  const number = cleanText(input.number, 'number', { max: 60 });
  const draft = !!input.draft;
  const auto = !draft && source !== 'assist' && amount <= Number(setting(db, 'bill_auto_approve'));

  return tx(db, () => {
    const supplier = resolveSupplier(ctx, user.id, input);
    if (number && db.prepare("SELECT 1 FROM bills WHERE supplier_id = ? AND number = ? AND status NOT IN ('void','rejected')").get(supplier.id, number)) {
      throw new AppError(409, 'DUPLICATE_BILL', 'This supplier already has a bill with that number');
    }
    const dueDate = input.dueDate ? validDate(input.dueDate, 'dueDate') : addDays(billDate, supplier.payment_terms_days);

    let po = null, matchStatus = 'none', matchNote = null;
    if (input.poId != null) {
      po = db.prepare('SELECT * FROM purchases_orders WHERE id = ?').get(input.poId);
      if (!po) throw new AppError(404, 'NOT_FOUND', 'Purchase order not found');
      if (po.supplier_id !== supplier.id) throw new AppError(409, 'PO_SUPPLIER_MISMATCH', 'The purchase order belongs to a different supplier');
      if (po.status === 'cancelled') throw new AppError(409, 'PO_CANCELLED', 'Purchase order is cancelled');
      if (!lines) throw new AppError(400, 'BAD_INPUT', 'A bill against a purchase order needs lines');
      const { variances } = matchBill(ctx, po, lines);
      if (variances.length) {
        const why = input.matchOverrideReason ? cleanText(input.matchOverrideReason, 'matchOverrideReason', { max: 300 }) : null;
        if (!why) throw new AppError(409, 'MATCH_VARIANCE', 'The bill does not match the purchase order; fix it or give a matchOverrideReason', { variances });
        matchStatus = 'override';
        matchNote = `${why} (${variances.map((v) => v.kind).join(', ')})`;
      } else matchStatus = 'matched';
    }

    const res = db.prepare(`INSERT INTO bills (supplier, amount, category, status, created_by, created_at, supplier_id, po_id, number, vat, bill_date, due_date, source, source_ref, match_status, match_note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(supplier.name, amount, input.category, draft ? 'draft' : 'pending_approval', user.id, ctx.now(), supplier.id, po?.id ?? null, number, vat, billDate, dueDate, source, opts.sourceRef ?? null, matchStatus, matchNote);
    const id = Number(res.lastInsertRowid);
    if (lines) {
      const ins = db.prepare('INSERT INTO purchases_bill_lines (bill_id, po_line_id, description, qty, unit_price) VALUES (?,?,?,?,?)');
      for (const l of lines) ins.run(id, l.poLineId, l.description, l.qty, l.unitPrice);
    }
    if (po) applyBilledQty(ctx, po.id, lines, +1);
    const bill = { id, supplier: supplier.name, amount, category: input.category };
    audit(ctx, { userId: user.id, action: draft ? 'bill.drafted' : auto ? 'bill.created' : 'bill.submitted', type: 'bill', id, newValue: { amount, source, vat } });
    emit(ctx, 'bill.created', { bill, status: draft ? 'draft' : auto ? 'approved' : 'pending_approval', userId: user.id });
    let status = draft ? 'draft' : 'pending_approval';
    let entryId = null;
    if (auto) {
      entryId = finalizeBill(ctx, id, user.id, { auto: true }).entryId;
      status = 'approved';
    } else if (!draft) {
      openRequest(ctx, { docType: 'bill', docId: id, amount, category: input.category, supplierId: supplier.id, createdBy: user.id });
    }
    return { id, status, ...(entryId ? { entryId } : {}) };
  });
}

/** Send a draft bill for approval (or post it at once if it is under the auto-approve threshold). */
export function submitBill(ctx, user, id) {
  requirePerm(user, 'purchases.create');
  const { db } = ctx;
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
  if (!bill) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
  if (bill.status !== 'draft') throw new AppError(409, 'NOT_DRAFT', 'Only a draft bill can be submitted');
  if (bill.created_by !== user.id) throw new AppError(403, 'FORBIDDEN', 'Only the bill creator can submit their draft');
  const auto = bill.source !== 'assist' && bill.amount <= Number(setting(db, 'bill_auto_approve'));
  return tx(db, () => {
    db.prepare("UPDATE bills SET status = 'pending_approval' WHERE id = ?").run(id);
    audit(ctx, { userId: user.id, action: 'bill.submitted', type: 'bill', id });
    if (auto) {
      const { entryId } = finalizeBill(ctx, id, user.id, { auto: true });
      return { id, status: 'approved', entryId };
    }
    openRequest(ctx, { docType: 'bill', docId: id, amount: bill.amount, category: bill.category, supplierId: bill.supplier_id, createdBy: user.id });
    return { id, status: 'pending_approval' };
  });
}

// A pending bill from before the approvals engine existed has no request yet: open one on first use.
function ensureRequest(ctx, bill) {
  const req = requestForDoc(ctx, 'bill', bill.id);
  if (req?.status === 'pending') return req;
  const id = openRequest(ctx, { docType: 'bill', docId: bill.id, amount: bill.amount, category: bill.category, supplierId: bill.supplier_id, createdBy: bill.created_by });
  return { id };
}

/** Single-call approve kept from the original module: now one step of the approval engine. */
export function approveBill(ctx, user, id, input = {}) {
  const { db } = ctx;
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
  if (!bill) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
  if (bill.status !== 'pending_approval') throw new AppError(409, 'NOT_PENDING', 'Bill is not waiting for approval');
  const r = approveStep(ctx, user, ensureRequest(ctx, bill).id, input);
  return { id, entryId: r.entryId, status: r.complete ? 'approved' : 'pending_approval', remainingSteps: r.remaining };
}

export function rejectBill(ctx, user, id, input = {}) {
  const { db } = ctx;
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
  if (!bill) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
  if (bill.status !== 'pending_approval') throw new AppError(409, 'NOT_PENDING', 'Bill is not waiting for approval');
  rejectStep(ctx, user, ensureRequest(ctx, bill).id, input);
  return { id, status: 'rejected' };
}

/** Void a bill without checking permissions (callers do): cancel its approval, or reverse its ledger entry. */
export function voidBillInternal(ctx, userId, id, reason) {
  const { db } = ctx;
  const why = cleanText(reason, 'reason', { required: true, max: 300 });
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
  if (!bill) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
  if (['void', 'rejected'].includes(bill.status)) throw new AppError(409, 'ALREADY_CLOSED', `Bill is already ${bill.status}`);
  if (bill.paid > 0) throw new AppError(409, 'HAS_PAYMENTS', 'This bill has payments; void the payments first');
  return tx(db, () => {
    let reversal = null;
    if (bill.status === 'pending_approval') {
      const req = requestForDoc(ctx, 'bill', id);
      if (req?.status === 'pending') cancelRequest(ctx, req.id, userId, why);
    }
    if (bill.entry_id) reversal = reverseEntry(ctx, userId, bill.entry_id, why);
    releasePO(ctx, id);
    db.prepare("UPDATE bills SET status = 'void', void_reason = ?, void_entry_id = ? WHERE id = ?").run(why, reversal?.id ?? null, id);
    audit(ctx, { userId, action: 'bill.voided', type: 'bill', id, reason: why, newValue: { reversalEntryId: reversal?.id ?? null } });
    return { id, status: 'void', reversalEntryId: reversal?.id ?? null };
  });
}

export function voidBill(ctx, user, id, input = {}) {
  requirePerm(user, 'purchases.approve');
  return voidBillInternal(ctx, user.id, id, input.reason);
}

export function listBills(ctx, user, query = {}) {
  requirePerm(user, 'purchases.view');
  const where = [], args = [];
  if (query.status) { where.push('status = ?'); args.push(String(query.status)); }
  if (query.supplierId) { where.push('supplier_id = ?'); args.push(Number(query.supplierId)); }
  return ctx.db.prepare(`SELECT * FROM bills ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`).all(...args);
}

export function getBill(ctx, user, id) {
  requirePerm(user, 'purchases.view');
  const { db } = ctx;
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
  if (!bill) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
  const req = requestForDoc(ctx, 'bill', id);
  return {
    ...bill,
    lines: db.prepare('SELECT * FROM purchases_bill_lines WHERE bill_id = ? ORDER BY id').all(id),
    attachments: db.prepare('SELECT id, filename, mime, size, sha256, uploaded_by, created_at FROM purchases_attachments WHERE bill_id = ? ORDER BY id').all(id),
    payments: db.prepare(`SELECT a.payment_id, a.amount, p.paid_date, p.method, p.status FROM purchases_payment_allocations a JOIN purchases_payments p ON p.id = a.payment_id WHERE a.bill_id = ? ORDER BY a.id`).all(id),
    approvalRequestId: req?.id ?? null,
    outstanding: ['approved', 'partially_paid'].includes(bill.status) ? bill.amount - bill.paid : 0,
  };
}

// Home widgets: payables (needs reports.view) and the approval queue.
export function widgets(ctx, user) {
  const { db } = ctx;
  const has = (p) => user.permissions.has(p);
  const w = {};
  if (has('reports.view')) w.payables = { total: -accountBalance(db, '2000').net };
  if (has('purchases.approve') || has('approvals.view')) {
    const rows = db.prepare("SELECT id, supplier, amount, category, created_by FROM bills WHERE status = 'pending_approval' ORDER BY id").all();
    if (has('purchases.approve') || rows.length) {
      w.approvals = rows.map((b) => {
        const req = requestForDoc(ctx, 'bill', b.id);
        const can = req ? canActNow(ctx, user, req) : false;
        return { ...b, canApprove: can, requestId: req?.id ?? null };
      }).filter((b) => has('purchases.approve') || b.canApprove);
    }
  }
  // One payload for the purchases cards, so the UI needs no extra requests (keeps loading and re-rendering fast).
  if (has('purchases.view')) {
    w.purchasesData = { suppliers: listSuppliers(ctx, user), aging: apAging(ctx, user, {}), bills: listBills(ctx, user).slice(0, 8) };
  }
  return w;
}

export { getPeriodLock };
