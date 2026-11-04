import { AppError, posInt } from '../../errors.js';
import { postEntry, tx, audit } from '../../ledger.js';
import { requirePerm, limitFor } from '../../permissions.js';
import { emit } from '../../hooks.js';
import { text, dateOf, parseLines, nextNumber, today, addDays, vatOf } from './common.js';
import { balanceOf, creditCheck, getCustomerRow } from './customers.js';

export { vatOf, balanceOf };

const numberTaken = (db) => (n) => !!db.prepare('SELECT 1 FROM invoices WHERE number = ?').get(n);

const nonZero = (lines) => lines.filter((l) => (l.debit ?? 0) + (l.credit ?? 0) > 0);

export function getInvoiceRow(db, id) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) throw new AppError(404, 'NOT_FOUND', 'Invoice not found');
  return inv;
}

/** Recompute paid/credited amounts and the lifecycle status from the allocation and credit note rows. */
export function refreshInvoice(ctx, id) {
  const { db } = ctx;
  const inv = getInvoiceRow(db, id);
  if (inv.status === 'draft') return inv;
  const paid = db.prepare(`SELECT COALESCE(SUM(a.amount),0) AS n FROM sales_payment_allocations a JOIN sales_payments p ON p.id = a.payment_id
    WHERE a.invoice_id = ? AND p.status = 'posted'`).get(id).n;
  const credited = db.prepare("SELECT COALESCE(SUM(total),0) AS n FROM sales_credit_notes WHERE invoice_id = ? AND status = 'issued'").get(id).n;
  let status;
  if (inv.entry_reversed || (inv.entry_id == null && inv.status === 'void')) status = 'void';
  else if (paid > 0 && paid + credited >= inv.total) status = 'paid';
  else if (credited >= inv.total) status = 'void';
  else if (paid + credited >= inv.total) status = 'paid';
  else if (paid > 0) status = 'partially_paid';
  else status = 'issued';
  const closed = status === 'paid' || status === 'void' ? 1 : 0; // `paid` column = closed (paid in full or void)
  db.prepare('UPDATE invoices SET amount_paid = ?, amount_credited = ?, status = ?, paid = ? WHERE id = ?').run(paid, credited, status, closed, id);
  return getInvoiceRow(db, id);
}

function resolveCustomer(db, input) {
  if (input.customerId != null) {
    const c = db.prepare('SELECT * FROM sales_customers WHERE id = ?').get(input.customerId);
    if (!c) throw new AppError(404, 'NOT_FOUND', 'Customer not found');
    if (!c.active) throw new AppError(409, 'CUSTOMER_INACTIVE', 'Customer is inactive');
    return c;
  }
  const name = text(input.customer, 'Customer', { max: 120, required: true });
  const c = db.prepare('SELECT * FROM sales_customers WHERE active = 1 AND lower(name) = lower(?)').get(name);
  return c ?? { id: null, name };
}

function totalsOf(db, rawLines) {
  const { lines, subtotal } = parseLines(rawLines);
  const vat = vatOf(db, subtotal);
  return { lines, subtotal, vat, total: subtotal + vat };
}

function insertDraft(ctx, user, input, opts) {
  const { db } = ctx;
  if (input.customerId == null && (!input.customer || !String(input.customer).trim())) throw new AppError(400, 'BAD_INPUT', 'Customer is required');
  const c = resolveCustomer(db, input);
  const t = totalsOf(db, input.lines);
  const issue = input.date ? dateOf(input.date, 'date') : today(ctx);
  const due = input.dueDate ? dateOf(input.dueDate, 'dueDate') : addDays(issue, 14);
  if (due < issue) throw new AppError(400, 'BAD_DATE', 'dueDate cannot be before the invoice date');
  const res = db.prepare(`INSERT INTO invoices (customer, customer_id, lines, subtotal, vat, total, issue_date, due_date, status, notes, quote_id, created_by)
    VALUES (?,?,?,?,?,?,?,?, 'draft', ?,?,?)`)
    .run(c.name, c.id, JSON.stringify(t.lines), t.subtotal, t.vat, t.total, issue, due, text(input.notes, 'notes', { max: 500 }), opts.quoteId ?? null, user.id);
  return Number(res.lastInsertRowid);
}

function issueRow(ctx, user, id, input = {}) {
  const { db } = ctx;
  const inv = getInvoiceRow(db, id);
  if (inv.status !== 'draft') throw new AppError(409, 'INVOICE_NOT_DRAFT', 'Only a draft invoice can be issued');
  const customer = inv.customer_id ? getCustomerRow(db, inv.customer_id) : null;
  let overrideReason = null;
  const breach = creditCheck(db, customer, inv.total);
  if (breach) {
    const ov = input.creditOverride;
    if (!ov) throw new AppError(409, 'CREDIT_LIMIT_EXCEEDED', `Credit limit exceeded for ${customer.name}`, breach);
    requirePerm(user, 'sales.credit');
    overrideReason = text(ov.reason, 'creditOverride.reason', { max: 300, required: true });
  }
  let issue = inv.issue_date, due = inv.due_date;
  if (input.date) { issue = dateOf(input.date, 'date'); if (due < issue) due = addDays(issue, 14); }
  const number = nextNumber(ctx, 'invoice', numberTaken(db));
  const entry = postEntry(ctx, {
    userId: user.id, date: issue, memo: `Invoice for ${inv.customer}`, sourceType: 'invoice', sourceId: id,
    lines: nonZero([{ account: '1200', debit: inv.total }, { account: '4000', credit: inv.subtotal }, { account: '2100', credit: inv.vat }]),
  });
  db.prepare("UPDATE invoices SET number = ?, entry_id = ?, status = 'issued', issue_date = ?, due_date = ?, credit_override_reason = ? WHERE id = ?")
    .run(number, entry.id, issue, due, overrideReason, id);
  audit(ctx, { userId: user.id, action: 'invoice.created', type: 'invoice', id, newValue: { number, total: inv.total } });
  if (overrideReason) {
    audit(ctx, { userId: user.id, action: 'invoice.credit_override', type: 'invoice', id, newValue: { customerId: customer.id, ...breach }, reason: overrideReason });
  }
  emit(ctx, 'invoice.created', {
    invoice: { id, number, customer: inv.customer, lines: JSON.parse(inv.lines), subtotal: inv.subtotal, vat: inv.vat, total: inv.total, issueDate: issue },
    entryId: entry.id, userId: user.id,
  });
  return { id, number, subtotal: inv.subtotal, vat: inv.vat, total: inv.total, entryId: entry.id, status: 'issued' };
}

/** Create an invoice: issued straight away (posts to the ledger) or, with `draft: true`, as a draft. */
export function createInvoice(ctx, user, input = {}, opts = {}) {
  requirePerm(user, 'sales.create');
  const { db } = ctx;
  return tx(db, () => {
    const id = insertDraft(ctx, user, input, opts);
    if (input.draft) {
      const inv = getInvoiceRow(db, id);
      audit(ctx, { userId: user.id, action: 'invoice.drafted', type: 'invoice', id, newValue: { total: inv.total } });
      return { id, number: null, subtotal: inv.subtotal, vat: inv.vat, total: inv.total, entryId: null, status: 'draft' };
    }
    return issueRow(ctx, user, id, input);
  });
}

export function issueInvoice(ctx, user, id, input = {}) {
  requirePerm(user, 'sales.create');
  return tx(ctx.db, () => issueRow(ctx, user, id, input));
}

export function updateDraft(ctx, user, id, input = {}) {
  requirePerm(user, 'sales.create');
  const { db } = ctx;
  const inv = getInvoiceRow(db, id);
  if (inv.status !== 'draft') throw new AppError(409, 'INVOICE_NOT_DRAFT', 'Only a draft invoice can be edited; issued invoices are corrected with a credit note');
  return tx(db, () => {
    const c = input.customerId != null || input.customer ? resolveCustomer(db, input) : { id: inv.customer_id, name: inv.customer };
    const t = input.lines ? totalsOf(db, input.lines) : { lines: JSON.parse(inv.lines), subtotal: inv.subtotal, vat: inv.vat, total: inv.total };
    const issue = input.date ? dateOf(input.date, 'date') : inv.issue_date;
    const due = input.dueDate ? dateOf(input.dueDate, 'dueDate') : inv.due_date;
    if (due < issue) throw new AppError(400, 'BAD_DATE', 'dueDate cannot be before the invoice date');
    const notes = 'notes' in input ? text(input.notes, 'notes', { max: 500 }) : inv.notes;
    db.prepare('UPDATE invoices SET customer = ?, customer_id = ?, lines = ?, subtotal = ?, vat = ?, total = ?, issue_date = ?, due_date = ?, notes = ? WHERE id = ?')
      .run(c.name, c.id, JSON.stringify(t.lines), t.subtotal, t.vat, t.total, issue, due, notes, id);
    audit(ctx, { userId: user.id, action: 'invoice.draft_updated', type: 'invoice', id, oldValue: { total: inv.total }, newValue: { total: t.total } });
    return { id, status: 'draft', subtotal: t.subtotal, vat: t.vat, total: t.total };
  });
}

const METHOD_ACCOUNT = { cash: '1000', bank: '1010', wallet: '1020' };

/** Post one payment and allocate it across invoices. Caller has checked the permission. */
function postPayment(ctx, user, { amount, method, date, reference, customerId, allocations }) {
  const { db } = ctx;
  const account = METHOD_ACCOUNT[method];
  if (!account) throw new AppError(400, 'BAD_INPUT', `method must be one of ${Object.keys(METHOD_ACCOUNT).join(', ')}`);
  if (!db.prepare('SELECT 1 FROM accounts WHERE code = ?').get(account)) throw new AppError(400, 'METHOD_UNAVAILABLE', `Payment method ${method} is not set up (no account ${account})`);
  const rows = allocations.map((a) => ({ a, inv: getInvoiceRow(db, a.invoiceId) }));
  const keyOf = (i) => (i.customer_id ? `c${i.customer_id}` : `n${i.customer.toLowerCase()}`);
  if (new Set(rows.map((r) => keyOf(r.inv))).size > 1) throw new AppError(400, 'CUSTOMER_MISMATCH', 'A payment can only be allocated to invoices of one customer');
  if (customerId != null && rows.some((r) => r.inv.customer_id !== customerId)) throw new AppError(400, 'CUSTOMER_MISMATCH', 'Invoice does not belong to this customer');
  for (const { a, inv } of rows) {
    if (inv.status === 'paid') throw new AppError(409, 'ALREADY_PAID', `Invoice ${inv.number} is already paid`);
    if (!['issued', 'partially_paid'].includes(inv.status)) throw new AppError(409, 'INVOICE_NOT_OPEN', `Invoice ${inv.number ?? '#' + inv.id} is ${inv.status} and cannot take a payment`);
    if (a.amount > balanceOf(inv)) throw new AppError(400, 'ALLOCATION_EXCEEDS_BALANCE', `Allocation to ${inv.number} is above its open balance`, { invoiceId: inv.id, balance: balanceOf(inv) });
  }
  const sum = allocations.reduce((s, a) => s + a.amount, 0);
  if (sum !== amount) throw new AppError(400, 'ALLOCATION_MISMATCH', 'Allocations must add up to the payment amount');
  return tx(db, () => {
    const first = rows[0].inv;
    const pay = db.prepare('INSERT INTO sales_payments (customer_id, customer, amount, method, pay_date, reference, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(first.customer_id, first.customer, amount, method, date, reference, user.id, ctx.now());
    const payId = Number(pay.lastInsertRowid);
    const entry = postEntry(ctx, {
      userId: user.id, date, memo: `Payment for ${rows.map((r) => r.inv.number).join(', ')}`, sourceType: 'payment', sourceId: payId,
      lines: [{ account, debit: amount }, { account: '1200', credit: amount }],
    });
    db.prepare('UPDATE sales_payments SET entry_id = ? WHERE id = ?').run(entry.id, payId);
    const ins = db.prepare('INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount) VALUES (?,?,?)');
    const out = [];
    for (const { a, inv } of rows) {
      ins.run(payId, inv.id, a.amount);
      const after = refreshInvoice(ctx, inv.id);
      out.push({ invoiceId: inv.id, number: inv.number, amount: a.amount, status: after.status });
      if (after.status === 'paid') {
        audit(ctx, { userId: user.id, action: 'invoice.paid', type: 'invoice', id: inv.id, newValue: { entryId: entry.id } });
        emit(ctx, 'invoice.paid', { id: inv.id, total: inv.total, entryId: entry.id, userId: user.id });
      }
    }
    audit(ctx, { userId: user.id, action: 'payment.recorded', type: 'payment', id: payId, newValue: { amount, method, allocations: out.map((o) => ({ invoiceId: o.invoiceId, amount: o.amount })) } });
    return { id: payId, entryId: entry.id, amount, allocations: out };
  });
}

/** Payment API: explicit allocations, or FIFO (oldest due date first) across a customer's open invoices. */
export function recordPayment(ctx, user, input = {}) {
  requirePerm(user, 'sales.create');
  const { db } = ctx;
  const amount = posInt(input.amount, 'amount');
  const method = input.method ?? 'cash';
  const date = input.date ? dateOf(input.date, 'date') : today(ctx);
  const reference = text(input.reference, 'reference', { max: 60 });
  let allocations;
  if (Array.isArray(input.allocations) && input.allocations.length) {
    const seen = new Set();
    allocations = input.allocations.map((a) => {
      const invoiceId = posInt(a?.invoiceId, 'invoiceId');
      if (seen.has(invoiceId)) throw new AppError(400, 'BAD_INPUT', 'An invoice can only appear once in allocations');
      seen.add(invoiceId);
      return { invoiceId, amount: posInt(a.amount, 'allocation amount') };
    });
  } else if (input.customerId != null) {
    const c = getCustomerRow(db, input.customerId);
    let left = amount;
    allocations = [];
    const open = db.prepare(`SELECT * FROM invoices WHERE status IN ('issued','partially_paid') AND (customer_id = ? OR (customer_id IS NULL AND lower(customer) = lower(?)))
      ORDER BY due_date, id`).all(c.id, c.name);
    for (const inv of open) {
      if (left <= 0) break;
      const take = Math.min(left, balanceOf(inv));
      if (take > 0) { allocations.push({ invoiceId: inv.id, amount: take }); left -= take; }
    }
    if (left > 0) throw new AppError(400, 'OVERPAYMENT', 'Payment is above the customer\'s open balance; advance payments are not supported yet', { openBalance: amount - left });
  } else {
    throw new AppError(400, 'BAD_INPUT', 'Give allocations [{invoiceId, amount}] or a customerId to allocate oldest-first');
  }
  return postPayment(ctx, user, { amount, method, date, reference, customerId: input.customerId ?? null, allocations });
}

/** Existing API: pay the whole open balance of one invoice. */
export function payInvoice(ctx, user, id) {
  requirePerm(user, 'sales.create');
  const inv = getInvoiceRow(ctx.db, id);
  if (inv.status === 'paid') throw new AppError(409, 'ALREADY_PAID', 'Invoice is already paid');
  if (!['issued', 'partially_paid'].includes(inv.status)) throw new AppError(409, 'INVOICE_NOT_OPEN', `Invoice is ${inv.status} and cannot be paid`);
  const bal = balanceOf(inv);
  const r = postPayment(ctx, user, { amount: bal, method: 'cash', date: today(ctx), reference: null, customerId: null, allocations: [{ invoiceId: id, amount: bal }] });
  return { id, entryId: r.entryId, paymentId: r.id };
}

export function listPayments(ctx, user, query = {}) {
  requirePerm(user, 'sales.view');
  const rows = ctx.db.prepare('SELECT * FROM sales_payments ORDER BY id DESC LIMIT 200').all();
  const alloc = ctx.db.prepare('SELECT invoice_id AS invoiceId, amount FROM sales_payment_allocations WHERE payment_id = ?');
  return rows.filter((p) => !query.customerId || p.customer_id === Number(query.customerId)).map((p) => ({ ...p, allocations: alloc.all(p.id) }));
}

const cnRow = (db, id) => {
  const n = db.prepare('SELECT * FROM sales_credit_notes WHERE id = ?').get(id);
  if (!n) throw new AppError(404, 'NOT_FOUND', 'Credit note not found');
  return n;
};

/**
 * Credit note: reverses revenue and VAT for (part of) one invoice. Net amount comes from `lines` or `amount`;
 * VAT is proportional to the invoice and the last credit takes the exact remainder, so the sum never exceeds the invoice.
 */
function creditNoteRow(ctx, user, inv, input, { voids = false } = {}) {
  const { db } = ctx;
  if (!inv.entry_id || !['issued', 'partially_paid', 'paid'].includes(inv.status)) {
    throw new AppError(409, 'INVOICE_NOT_CREDITABLE', `Invoice is ${inv.status}; only issued invoices can be credited`);
  }
  const reason = text(input.reason, 'reason', { max: 300, required: true });
  const done = db.prepare("SELECT COALESCE(SUM(subtotal),0) AS s, COALESCE(SUM(vat),0) AS v FROM sales_credit_notes WHERE invoice_id = ? AND status = 'issued'").get(inv.id);
  const remNet = inv.subtotal - done.s, remVat = inv.vat - done.v;
  let lines, net;
  if (voids) {
    net = remNet;
    lines = [{ description: 'Void invoice', qty: 1, unitPrice: net }];
  } else if (input.lines) {
    ({ lines, subtotal: net } = parseLines(input.lines));
  } else {
    net = posInt(input.amount, 'amount');
    lines = [{ description: text(input.description, 'description', { max: 200 }) ?? 'Credit', qty: 1, unitPrice: net }];
  }
  if (net <= 0) throw new AppError(409, 'NOTHING_TO_CREDIT', 'This invoice is already fully credited');
  if (net > remNet) throw new AppError(400, 'CREDIT_EXCEEDS_INVOICE', 'Credit note is above the amount still creditable on this invoice', { creditable: remNet, requested: net });
  const vat = net === remNet ? remVat : Math.min(remVat, Math.round((net * inv.vat) / inv.subtotal));
  const total = net + vat;
  if (total > limitFor(user, 'sales.credit')) throw new AppError(403, 'CREDIT_LIMIT', 'Credit note is above your approval limit', { limit: limitFor(user, 'sales.credit'), requested: total });
  return tx(db, () => {
    const number = nextNumber(ctx, 'credit_note', (n) => !!db.prepare('SELECT 1 FROM sales_credit_notes WHERE number = ?').get(n));
    const issue = today(ctx);
    const res = db.prepare(`INSERT INTO sales_credit_notes (number, invoice_id, customer_id, customer, lines, subtotal, vat, total, reason, issue_date, voids_invoice, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(number, inv.id, inv.customer_id, inv.customer, JSON.stringify(lines), net, vat, total, reason, issue, voids ? 1 : 0, user.id, ctx.now());
    const id = Number(res.lastInsertRowid);
    const entry = postEntry(ctx, {
      userId: user.id, date: issue, memo: `Credit note ${number} for ${inv.number}`, sourceType: 'credit_note', sourceId: id,
      lines: nonZero([{ account: '4000', debit: net }, { account: '2100', debit: vat }, { account: '1200', credit: total }]),
    });
    db.prepare('UPDATE sales_credit_notes SET entry_id = ? WHERE id = ?').run(entry.id, id);
    const after = refreshInvoice(ctx, inv.id);
    audit(ctx, { userId: user.id, action: 'credit_note.created', type: 'credit_note', id, newValue: { number, invoiceId: inv.id, subtotal: net, vat, total }, reason });
    emit(ctx, 'credit_note.created', {
      creditNote: { id, number, invoiceId: inv.id, lines, subtotal: net, vat, total }, invoice: { id: inv.id, number: inv.number, customer: inv.customer },
      entryId: entry.id, voided: after.status === 'void', userId: user.id,
    });
    return { id, number, subtotal: net, vat, total, entryId: entry.id, invoiceStatus: after.status };
  });
}

export function createCreditNote(ctx, user, invoiceId, input = {}) {
  requirePerm(user, 'sales.credit');
  return creditNoteRow(ctx, user, getInvoiceRow(ctx.db, invoiceId), input);
}

/** Void: a draft is simply closed; an issued invoice without payments is cancelled by a full credit note. */
export function voidInvoice(ctx, user, id, input = {}) {
  const { db } = ctx;
  const inv = getInvoiceRow(db, id);
  const reason = text(input.reason, 'reason', { max: 300, required: true });
  if (inv.status === 'void') throw new AppError(409, 'ALREADY_VOID', 'Invoice is already void');
  if (inv.status === 'draft') {
    requirePerm(user, 'sales.create');
    return tx(db, () => {
      db.prepare("UPDATE invoices SET status = 'void', paid = 1 WHERE id = ?").run(id);
      audit(ctx, { userId: user.id, action: 'invoice.voided', type: 'invoice', id, oldValue: { status: 'draft' }, newValue: { status: 'void' }, reason });
      return { id, status: 'void', creditNoteId: null, entryId: null };
    });
  }
  requirePerm(user, 'sales.credit');
  if (inv.amount_paid > 0) throw new AppError(409, 'INVOICE_HAS_PAYMENTS', 'This invoice has payments; use a partial credit note instead of voiding it');
  return tx(db, () => {
    const cn = creditNoteRow(ctx, user, inv, { reason }, { voids: true });
    audit(ctx, { userId: user.id, action: 'invoice.voided', type: 'invoice', id, newValue: { creditNoteId: cn.id }, reason });
    return { id, status: cn.invoiceStatus, creditNoteId: cn.id, entryId: cn.entryId };
  });
}

const view = (i) => ({
  id: i.id, number: i.number, customer: i.customer, customer_id: i.customer_id, total: i.total, subtotal: i.subtotal, vat: i.vat, issue_date: i.issue_date, due_date: i.due_date,
  paid: i.paid, status: i.status, amount_paid: i.amount_paid, amount_credited: i.amount_credited, balance: i.status === 'draft' || i.status === 'void' ? 0 : balanceOf(i), created_by: i.created_by,
});

export function listInvoices(ctx, user, query = {}) {
  requirePerm(user, 'sales.view');
  const where = [], args = [];
  if (query.status) { where.push('status = ?'); args.push(String(query.status)); }
  if (query.customerId) { where.push('customer_id = ?'); args.push(Number(query.customerId)); }
  const rows = ctx.db.prepare(`SELECT * FROM invoices ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`).all(...args);
  return rows.map(view);
}

export function getInvoice(ctx, user, id) {
  requirePerm(user, 'sales.view');
  const { db } = ctx;
  const inv = getInvoiceRow(db, id);
  return {
    ...view(inv), lines: JSON.parse(inv.lines), notes: inv.notes, entry_id: inv.entry_id, quote_id: inv.quote_id,
    payments: db.prepare(`SELECT p.id, p.pay_date, p.method, p.status, a.amount FROM sales_payment_allocations a JOIN sales_payments p ON p.id = a.payment_id WHERE a.invoice_id = ? ORDER BY p.id`).all(id),
    creditNotes: db.prepare('SELECT id, number, issue_date, subtotal, vat, total, reason, status FROM sales_credit_notes WHERE invoice_id = ? ORDER BY id').all(id),
  };
}

export function listCreditNotes(ctx, user) {
  requirePerm(user, 'sales.view');
  return ctx.db.prepare(`SELECT n.id, n.number, n.invoice_id, i.number AS invoice_number, n.customer, n.subtotal, n.vat, n.total, n.reason, n.issue_date, n.status
    FROM sales_credit_notes n JOIN invoices i ON i.id = n.invoice_id ORDER BY n.id DESC`).all();
}

export function getCreditNote(ctx, user, id) {
  requirePerm(user, 'sales.view');
  const n = cnRow(ctx.db, id);
  return { ...n, lines: JSON.parse(n.lines) };
}
