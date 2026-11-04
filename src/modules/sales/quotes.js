import { AppError } from '../../errors.js';
import { tx, audit } from '../../ledger.js';
import { requirePerm } from '../../permissions.js';
import { text, dateOf, parseLines, nextNumber, today, addDays, vatOf } from './common.js';
import { createInvoice } from './invoices.js';

const get = (db, id) => {
  const q = db.prepare('SELECT * FROM sales_quotes WHERE id = ?').get(id);
  if (!q) throw new AppError(404, 'NOT_FOUND', 'Quote not found');
  return q;
};

// "expired" is derived: an open or accepted quote past its valid-until date (on the demo clock).
const view = (ctx, q) => ({
  id: q.id, number: q.number, customer: q.customer, customer_id: q.customer_id, lines: JSON.parse(q.lines), subtotal: q.subtotal, vat: q.vat, total: q.total,
  issue_date: q.issue_date, valid_until: q.valid_until, invoice_id: q.invoice_id, notes: q.notes,
  status: ['open', 'accepted'].includes(q.status) && q.valid_until < today(ctx) ? 'expired' : q.status, stored_status: q.status,
});

function party(db, input) {
  if (input.customerId != null) {
    const c = db.prepare('SELECT * FROM sales_customers WHERE id = ? AND active = 1').get(input.customerId);
    if (!c) throw new AppError(404, 'NOT_FOUND', 'Customer not found or inactive');
    return { id: c.id, name: c.name };
  }
  const name = text(input.customer, 'Customer', { max: 120, required: true });
  const c = db.prepare('SELECT * FROM sales_customers WHERE active = 1 AND lower(name) = lower(?)').get(name);
  return c ? { id: c.id, name: c.name } : { id: null, name };
}

export function createQuote(ctx, user, input = {}) {
  requirePerm(user, 'quotes.manage');
  const { db } = ctx;
  const who = party(db, input);
  const { lines, subtotal } = parseLines(input.lines);
  const vat = vatOf(db, subtotal);
  const issue = input.date ? dateOf(input.date, 'date') : today(ctx);
  const until = input.validUntil ? dateOf(input.validUntil, 'validUntil') : addDays(issue, 30);
  if (until < issue) throw new AppError(400, 'BAD_DATE', 'validUntil cannot be before the quote date');
  return tx(db, () => {
    const number = nextNumber(ctx, 'quote', (n) => !!db.prepare('SELECT 1 FROM sales_quotes WHERE number = ?').get(n));
    const res = db.prepare('INSERT INTO sales_quotes (number, customer_id, customer, lines, subtotal, vat, total, issue_date, valid_until, notes, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(number, who.id, who.name, JSON.stringify(lines), subtotal, vat, subtotal + vat, issue, until, text(input.notes, 'notes', { max: 500 }), user.id, ctx.now());
    const id = Number(res.lastInsertRowid);
    audit(ctx, { userId: user.id, action: 'quote.created', type: 'quote', id, newValue: { number, total: subtotal + vat, validUntil: until } });
    return view(ctx, get(db, id));
  });
}

export function updateQuote(ctx, user, id, input = {}) {
  requirePerm(user, 'quotes.manage');
  const { db } = ctx;
  const q = get(db, id);
  if (q.status !== 'open') throw new AppError(409, 'QUOTE_NOT_OPEN', `Quote is ${q.status} and can no longer be edited`);
  const who = input.customerId != null || input.customer ? party(db, input) : { id: q.customer_id, name: q.customer };
  const t = input.lines ? parseLines(input.lines) : { lines: JSON.parse(q.lines), subtotal: q.subtotal };
  const vat = input.lines ? vatOf(db, t.subtotal) : q.vat;
  const until = input.validUntil ? dateOf(input.validUntil, 'validUntil') : q.valid_until;
  if (until < q.issue_date) throw new AppError(400, 'BAD_DATE', 'validUntil cannot be before the quote date');
  return tx(db, () => {
    db.prepare('UPDATE sales_quotes SET customer = ?, customer_id = ?, lines = ?, subtotal = ?, vat = ?, total = ?, valid_until = ?, notes = ? WHERE id = ?')
      .run(who.name, who.id, JSON.stringify(t.lines), t.subtotal, vat, t.subtotal + vat, until, 'notes' in input ? text(input.notes, 'notes', { max: 500 }) : q.notes, id);
    audit(ctx, { userId: user.id, action: 'quote.updated', type: 'quote', id, oldValue: { total: q.total }, newValue: { total: t.subtotal + vat } });
    return view(ctx, get(db, id));
  });
}

export function setQuoteStatus(ctx, user, id, status) {
  requirePerm(user, 'quotes.manage');
  if (!['accepted', 'declined'].includes(status)) throw new AppError(400, 'BAD_INPUT', 'status must be accepted or declined');
  const { db } = ctx;
  const q = get(db, id);
  if (!['open', 'accepted'].includes(q.status)) throw new AppError(409, 'QUOTE_NOT_OPEN', `Quote is ${q.status}`);
  return tx(db, () => {
    db.prepare('UPDATE sales_quotes SET status = ? WHERE id = ?').run(status, id);
    audit(ctx, { userId: user.id, action: `quote.${status}`, type: 'quote', id, oldValue: { status: q.status }, newValue: { status } });
    return view(ctx, get(db, id));
  });
}

/** Convert a quote into an invoice (issued, or a draft with `draft: true`). Needs quotes.manage and sales.create. */
export function convertQuote(ctx, user, id, input = {}) {
  requirePerm(user, 'quotes.manage');
  requirePerm(user, 'sales.create');
  const { db } = ctx;
  const q = get(db, id);
  if (q.status === 'converted') throw new AppError(409, 'ALREADY_CONVERTED', 'This quote was already converted', { invoiceId: q.invoice_id });
  if (q.status === 'declined') throw new AppError(409, 'QUOTE_DECLINED', 'A declined quote cannot be converted');
  if (q.valid_until < today(ctx)) throw new AppError(409, 'QUOTE_EXPIRED', `Quote expired on ${q.valid_until}`);
  return tx(db, () => {
    const inv = createInvoice(ctx, user, {
      customerId: q.customer_id ?? undefined, customer: q.customer, lines: JSON.parse(q.lines), notes: q.notes ?? undefined,
      draft: input.draft, date: input.date, dueDate: input.dueDate, creditOverride: input.creditOverride,
    }, { quoteId: id });
    db.prepare("UPDATE sales_quotes SET status = 'converted', invoice_id = ? WHERE id = ?").run(inv.id, id);
    audit(ctx, { userId: user.id, action: 'quote.converted', type: 'quote', id, newValue: { invoiceId: inv.id } });
    return { quoteId: id, invoice: inv };
  });
}

export function listQuotes(ctx, user) {
  requirePerm(user, 'sales.view');
  return ctx.db.prepare('SELECT * FROM sales_quotes ORDER BY id DESC').all().map((q) => view(ctx, q));
}

export function getQuote(ctx, user, id) {
  requirePerm(user, 'sales.view');
  return view(ctx, get(ctx.db, id));
}
