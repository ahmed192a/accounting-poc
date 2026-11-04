import { AppError, posInt } from '../../errors.js';
import { postEntry, tx, audit, isoDate } from '../../ledger.js';
import { requirePerm, requireAny } from '../../permissions.js';
import { setting } from '../../db.js';
import * as eta from '../eta/adapter.js';
import { emit } from '../../hooks.js';

const DAY = 24 * 3600 * 1000;
export const vatOf = (db, subtotal) => Math.round((subtotal * Number(setting(db, 'vat_rate_bp'))) / 10000);

export function createInvoice(ctx, user, input) {
  requirePerm(user, 'sales.create');
  const { db } = ctx;
  if (!input.customer || !String(input.customer).trim()) throw new AppError(400, 'BAD_INPUT', 'Customer is required');
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new AppError(400, 'BAD_INPUT', 'At least one line is required');
  let subtotal = 0;
  const lines = input.lines.map((l) => {
    if (!l.description) throw new AppError(400, 'BAD_INPUT', 'Each line needs a description');
    const qty = posInt(l.qty, 'qty'), unitPrice = posInt(l.unitPrice, 'unitPrice');
    subtotal += qty * unitPrice;
    return { description: l.description, qty, unitPrice };
  });
  const vat = vatOf(db, subtotal), total = subtotal + vat;
  const issue = input.date ?? isoDate(ctx.now());
  const due = input.dueDate ?? isoDate(Date.parse(issue) + 14 * DAY);

  return tx(db, () => {
    const entry = postEntry(ctx, {
      userId: user.id, date: issue, memo: `Invoice for ${input.customer}`, sourceType: 'invoice',
      lines: [{ account: '1200', debit: total }, { account: '4000', credit: subtotal }, { account: '2100', credit: vat }],
    });
    const res = db
      .prepare('INSERT INTO invoices (customer, lines, subtotal, vat, total, issue_date, due_date, entry_id, created_by) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(input.customer, JSON.stringify(lines), subtotal, vat, total, issue, due, entry.id, user.id);
    const id = Number(res.lastInsertRowid);
    const number = `INV-${String(id).padStart(4, '0')}`;
    db.prepare('UPDATE invoices SET number = ? WHERE id = ?').run(number, id);
    audit(ctx, { userId: user.id, action: 'invoice.created', type: 'invoice', id, newValue: { number, total } });
    emit(ctx, 'invoice.created', { invoice: { id, number, customer: input.customer, lines, subtotal, vat, total, issueDate: issue }, entryId: entry.id, userId: user.id });
    return { id, number, subtotal, vat, total, entryId: entry.id };
  });
}

export function payInvoice(ctx, user, id) {
  requirePerm(user, 'sales.create');
  const { db } = ctx;
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) throw new AppError(404, 'NOT_FOUND', 'Invoice not found');
  if (inv.paid) throw new AppError(409, 'ALREADY_PAID', 'Invoice is already paid');
  return tx(db, () => {
    const entry = postEntry(ctx, {
      userId: user.id, memo: `Payment for ${inv.number}`, sourceType: 'payment', sourceId: id,
      lines: [{ account: '1000', debit: inv.total }, { account: '1200', credit: inv.total }],
    });
    db.prepare('UPDATE invoices SET paid = 1 WHERE id = ?').run(id);
    audit(ctx, { userId: user.id, action: 'invoice.paid', type: 'invoice', id, newValue: { entryId: entry.id } });
    emit(ctx, 'invoice.paid', { id, total: inv.total, entryId: entry.id, userId: user.id });
    return { id, entryId: entry.id };
  });
}

export function quickSale(ctx, user, input) {
  requirePerm(user, 'sales.create');
  const { db } = ctx;
  if (!Array.isArray(input.items) || input.items.length === 0) throw new AppError(400, 'BAD_INPUT', 'Add at least one item');
  const bySku = db.prepare('SELECT * FROM items WHERE sku = ?');
  const items = input.items.map((i) => {
    const item = bySku.get(i.sku);
    if (!item) throw new AppError(400, 'UNKNOWN_ITEM', `Unknown item ${i.sku}`);
    return { ...item, qty: posInt(i.qty, 'qty') };
  });
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const vat = vatOf(db, subtotal), total = subtotal + vat;

  return tx(db, () => {
    const entry = postEntry(ctx, {
      userId: user.id, memo: 'Quick sale', sourceType: 'sale',
      lines: [{ account: '1000', debit: total }, { account: '4000', credit: subtotal }, { account: '2100', credit: vat }],
    });
    const res = db
      .prepare('INSERT INTO sales (items, subtotal, vat, total, created_by, created_at, entry_id) VALUES (?,?,?,?,?,?,?)')
      .run(JSON.stringify(items.map((i) => ({ sku: i.sku, qty: i.qty, price: i.price }))), subtotal, vat, total, user.id, ctx.now(), entry.id);
    const sale = { id: Number(res.lastInsertRowid), subtotal, vat, total };
    audit(ctx, { userId: user.id, action: 'sale.created', type: 'sale', id: sale.id, newValue: { total } });
    const receipt = eta.queueReceipt(ctx, sale, items);
    emit(ctx, 'sale.created', { sale, items, entryId: entry.id, receipt, userId: user.id });
    return { sale, receipt, entryId: entry.id };
  });
}

export const listInvoices = (ctx, user) => {
  requirePerm(user, 'sales.view');
  return ctx.db.prepare('SELECT id, number, customer, total, issue_date, due_date, paid, created_by FROM invoices ORDER BY id DESC').all();
};

export const listItems = (ctx, user) => {
  requireAny(user, ['sales.view', 'sales.create']);
  return ctx.db.prepare('SELECT sku, name, name_ar, price, eta_code FROM items ORDER BY id').all();
};

// Home widgets: receivables (needs reports.view) and today's sales.
export function widgets(ctx, user) {
  const { db } = ctx;
  const has = (p) => user.permissions.has(p);
  const w = {};
  if (has('reports.view')) {
    const today = isoDate(ctx.now());
    const open = db.prepare('SELECT total, due_date FROM invoices WHERE paid = 0').all();
    w.receivables = {
      total: open.reduce((s, r) => s + r.total, 0), count: open.length,
      overdue: open.filter((r) => r.due_date < today).length,
      invoices: db.prepare('SELECT id, number, customer, total, due_date FROM invoices WHERE paid = 0 ORDER BY due_date').all(),
    };
  }
  if (has('sales.view')) {
    const start = Date.parse(isoDate(ctx.now()));
    const r = db.prepare('SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS n FROM sales WHERE created_at >= ?').get(start);
    w.todaySales = { total: r.total, count: r.n };
  }
  return w;
}
