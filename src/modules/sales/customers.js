import { AppError } from '../../errors.js';
import { audit, tx } from '../../ledger.js';
import { requirePerm } from '../../permissions.js';
import { setting } from '../../db.js';
import { text, today, daysBetween, fmtMoney } from './common.js';

const OPEN = "('issued','partially_paid')";
export const balanceOf = (i) => Math.max(0, i.total - i.amount_paid - i.amount_credited);

const PHONE = /^[+\d\s()-]{5,25}$/;
const TAX_ID = /^[A-Za-z0-9 \-/]{1,30}$/;

function fields(input, partial) {
  const out = {};
  const has = (k) => !partial || k in input;
  if (has('name')) out.name = text(input.name, 'name', { max: 120, required: true });
  if (has('phone')) {
    out.phone = text(input.phone, 'phone', { max: 25 });
    if (out.phone && !PHONE.test(out.phone)) throw new AppError(400, 'BAD_PHONE', 'Phone may contain digits, spaces, + ( ) - only');
  }
  if (has('taxId')) {
    out.tax_id = text(input.taxId, 'taxId', { max: 30 });
    if (out.tax_id && !TAX_ID.test(out.tax_id)) throw new AppError(400, 'BAD_TAX_ID', 'Tax id may contain letters, digits, space, - and / only');
  }
  if (has('address')) out.address = text(input.address, 'address', { max: 300 });
  if (has('notes')) out.notes = text(input.notes, 'notes', { max: 1000 });
  if (has('creditLimit')) {
    const v = input.creditLimit ?? 0;
    if (!Number.isInteger(v) || v < 0) throw new AppError(400, 'BAD_INPUT', 'creditLimit must be a whole number of piastres (0 = no limit)');
    out.credit_limit = v;
  }
  return out;
}

const openRows = (db, c) =>
  db.prepare(`SELECT * FROM invoices WHERE status IN ${OPEN} AND (customer_id = ? OR (customer_id IS NULL AND lower(customer) = lower(?)))`).all(c.id, c.name);

export function outstanding(db, c) {
  return openRows(db, c).reduce((s, i) => s + balanceOf(i), 0);
}

const view = (db, c) => ({
  id: c.id, name: c.name, phone: c.phone, taxId: c.tax_id, address: c.address, creditLimit: c.credit_limit,
  notes: c.notes, active: !!c.active, createdAt: c.created_at, balance: outstanding(db, c),
});

export function getCustomerRow(db, id) {
  const c = db.prepare('SELECT * FROM sales_customers WHERE id = ?').get(id);
  if (!c) throw new AppError(404, 'NOT_FOUND', 'Customer not found');
  return c;
}

export function createCustomer(ctx, user, input = {}) {
  requirePerm(user, 'customers.manage');
  const { db } = ctx;
  const f = fields(input, false);
  if (db.prepare('SELECT 1 FROM sales_customers WHERE active = 1 AND lower(name) = lower(?)').get(f.name)) {
    throw new AppError(409, 'DUPLICATE_CUSTOMER', 'An active customer with this name already exists');
  }
  return tx(db, () => {
    const res = db.prepare('INSERT INTO sales_customers (name, phone, tax_id, address, credit_limit, notes, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(f.name, f.phone, f.tax_id, f.address, f.credit_limit, f.notes, user.id, ctx.now());
    const id = Number(res.lastInsertRowid);
    audit(ctx, { userId: user.id, action: 'customer.created', type: 'customer', id, newValue: { name: f.name, creditLimit: f.credit_limit } });
    return view(db, getCustomerRow(db, id));
  });
}

export function updateCustomer(ctx, user, id, input = {}) {
  requirePerm(user, 'customers.manage');
  const { db } = ctx;
  const old = getCustomerRow(db, id);
  const f = fields(input, true);
  if ('active' in input) f.active = input.active ? 1 : 0;
  const keys = Object.keys(f);
  if (!keys.length) throw new AppError(400, 'BAD_INPUT', 'Nothing to update');
  const nextName = f.name ?? old.name;
  const nextActive = f.active ?? old.active;
  if (nextActive && db.prepare('SELECT 1 FROM sales_customers WHERE active = 1 AND lower(name) = lower(?) AND id <> ?').get(nextName, id)) {
    throw new AppError(409, 'DUPLICATE_CUSTOMER', 'An active customer with this name already exists');
  }
  return tx(db, () => {
    db.prepare(`UPDATE sales_customers SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => f[k]), ctx.now(), id);
    audit(ctx, { userId: user.id, action: 'customer.updated', type: 'customer', id, oldValue: view(db, old), newValue: f });
    return view(db, getCustomerRow(db, id));
  });
}

export function deleteCustomer(ctx, user, id) {
  requirePerm(user, 'customers.manage');
  const { db } = ctx;
  const c = getCustomerRow(db, id);
  const used = db.prepare(`SELECT (SELECT COUNT(*) FROM invoices WHERE customer_id = ?1) + (SELECT COUNT(*) FROM sales_quotes WHERE customer_id = ?1)
    + (SELECT COUNT(*) FROM sales_payments WHERE customer_id = ?1) AS n`).get(id).n;
  if (used) throw new AppError(409, 'CUSTOMER_IN_USE', 'This customer has documents; deactivate it instead of deleting');
  return tx(db, () => {
    db.prepare('DELETE FROM sales_customers WHERE id = ?').run(id);
    audit(ctx, { userId: user.id, action: 'customer.deleted', type: 'customer', id, oldValue: { name: c.name } });
    return { id, deleted: true };
  });
}

export function listCustomers(ctx, user, query = {}) {
  requirePerm(user, 'sales.view');
  const rows = ctx.db.prepare(`SELECT * FROM sales_customers ${query.all ? '' : 'WHERE active = 1'} ORDER BY lower(name)`).all();
  return rows.map((c) => view(ctx.db, c));
}

export function getCustomer(ctx, user, id) {
  requirePerm(user, 'sales.view');
  return view(ctx.db, getCustomerRow(ctx.db, id));
}

/** Account statement: invoices (debit), payments and credit notes (credit) with a running balance. */
export function statement(ctx, user, id, query = {}) {
  requirePerm(user, 'sales.view');
  const { db } = ctx;
  const c = getCustomerRow(db, id);
  const from = query.from || null, to = query.to || null;
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new AppError(400, 'BAD_DATE', 'from must be YYYY-MM-DD');
  if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new AppError(400, 'BAD_DATE', 'to must be YYYY-MM-DD');
  const mine = '(customer_id = ?1 OR (customer_id IS NULL AND lower(customer) = lower(?2)))';
  const docs = [];
  for (const i of db.prepare(`SELECT id, number, issue_date, total, status, entry_reversed FROM invoices WHERE status <> 'draft' AND entry_id IS NOT NULL AND ${mine}`).all(c.id, c.name)) {
    docs.push({ date: i.issue_date, ord: 0, id: i.id, type: 'invoice', number: i.number, debit: i.total, credit: 0, reversed: !!i.entry_reversed });
  }
  for (const n of db.prepare(`SELECT id, number, issue_date, total, status FROM sales_credit_notes WHERE ${mine}`).all(c.id, c.name)) {
    docs.push({ date: n.issue_date, ord: 1, id: n.id, type: 'credit_note', number: n.number, debit: 0, credit: n.total, reversed: n.status === 'reversed' });
  }
  for (const p of db.prepare(`SELECT id, pay_date, amount, status, reference FROM sales_payments WHERE ${mine}`).all(c.id, c.name)) {
    docs.push({ date: p.pay_date, ord: 2, id: p.id, type: 'payment', number: p.reference || `PAY-${p.id}`, debit: 0, credit: p.amount, reversed: p.status === 'reversed' });
  }
  docs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.ord - b.ord || a.id - b.id));
  let bal = 0, opening = 0;
  const lines = [];
  for (const d of docs) {
    const net = d.reversed ? 0 : d.debit - d.credit;
    if (from && d.date < from) { opening += net; bal += net; continue; }
    if (to && d.date > to) continue;
    bal += net;
    lines.push({ date: d.date, type: d.type, id: d.id, number: d.number, debit: d.debit, credit: d.credit, reversed: d.reversed, balance: bal });
  }
  return { customer: view(db, c), from, to, openingBalance: opening, lines, closingBalance: bal };
}

export const bucketOf = (daysPastDue) => (daysPastDue <= 0 ? 'current' : daysPastDue <= 30 ? 'd1_30' : daysPastDue <= 60 ? 'd31_60' : 'd61_plus');

/** Aging by days past due date, as of a date (default: today on the demo clock). */
export function aging(ctx, user, query = {}) {
  requirePerm(user, 'sales.view');
  const { db } = ctx;
  const asOf = query.asOf || today(ctx);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new AppError(400, 'BAD_DATE', 'asOf must be YYYY-MM-DD');
  const groups = new Map();
  for (const i of db.prepare(`SELECT * FROM invoices WHERE status IN ${OPEN}`).all()) {
    const bal = balanceOf(i);
    if (!bal) continue;
    const key = i.customer_id ? `c${i.customer_id}` : `n${i.customer.toLowerCase()}`;
    const g = groups.get(key) ?? { customerId: i.customer_id, customer: i.customer, current: 0, d1_30: 0, d31_60: 0, d61_plus: 0, total: 0, invoices: [] };
    const days = daysBetween(i.due_date, asOf);
    const bucket = bucketOf(days);
    g[bucket] += bal;
    g.total += bal;
    g.invoices.push({ id: i.id, number: i.number, dueDate: i.due_date, daysPastDue: Math.max(0, days), balance: bal, bucket });
    groups.set(key, g);
  }
  const rows = [...groups.values()].sort((a, b) => b.total - a.total);
  const totals = rows.reduce((t, r) => ({ current: t.current + r.current, d1_30: t.d1_30 + r.d1_30, d31_60: t.d31_60 + r.d31_60, d61_plus: t.d61_plus + r.d61_plus, total: t.total + r.total }),
    { current: 0, d1_30: 0, d31_60: 0, d61_plus: 0, total: 0 });
  return { asOf, rows, totals };
}

/** Normalise a phone number for wa.me: digits only, international format. UNVERIFIED outside Egypt. */
export function waNumber(phone, countryCode = '20') {
  let d = String(phone ?? '').replace(/[^\d+]/g, '');
  const plus = d.startsWith('+');
  d = d.replace(/\D/g, '');
  if (!plus) {
    if (d.startsWith('00')) d = d.slice(2);
    else if (d.startsWith('0')) d = countryCode + d.slice(1);
  }
  if (d.length < 8 || d.length > 15) throw new AppError(400, 'BAD_PHONE', 'Phone number cannot be turned into an international number');
  return d;
}

/** WhatsApp-ready payment reminder. Pure text + wa.me link: nothing is sent and no network is used. */
export function reminder(ctx, user, id, query = {}) {
  requirePerm(user, 'sales.view');
  const { db } = ctx;
  const c = getCustomerRow(db, id);
  const lang = query.lang === 'ar' ? 'ar' : 'en';
  if (!c.phone) throw new AppError(409, 'NO_PHONE', 'This customer has no phone number');
  const asOf = today(ctx);
  const overdue = openRows(db, c).filter((i) => i.due_date < asOf && balanceOf(i) > 0).sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
  if (!overdue.length) throw new AppError(409, 'NOTHING_OVERDUE', 'This customer has no overdue invoices');
  const sum = overdue.reduce((s, i) => s + balanceOf(i), 0);
  const biz = setting(db, 'sales_business_name');
  const list = overdue.map((i) => `${i.number} (${i.due_date}): ${fmtMoney(balanceOf(i))}`).join('\n');
  const message = lang === 'ar'
    ? `السلام عليكم ${c.name}،\nتذكير ودي${biz ? ` من ${biz}` : ''} بوجود ${overdue.length} فاتورة مستحقة بإجمالي ${fmtMoney(sum)} ج.م:\n${list}\nنرجو التكرم بالسداد في أقرب وقت. شكرا لتعاملكم معنا.`
    : `Hello ${c.name},\nA friendly reminder${biz ? ` from ${biz}` : ''}: you have ${overdue.length} overdue invoice${overdue.length > 1 ? 's' : ''} totalling EGP ${fmtMoney(sum)}:\n${list}\nPlease arrange payment at your earliest convenience. Thank you.`;
  const number = waNumber(c.phone, setting(db, 'sales_country_code') || '20');
  return { customerId: c.id, lang, phone: number, overdueCount: overdue.length, overdueTotal: sum, message, link: `https://wa.me/${number}?text=${encodeURIComponent(message)}`, sent: false };
}

/** Credit-limit check at invoice creation. Returns null when fine, else details. */
export function creditCheck(db, customer, newTotal) {
  if (!customer || !customer.credit_limit) return null;
  const exposure = outstanding(db, customer) + newTotal;
  return exposure > customer.credit_limit ? { limit: customer.credit_limit, current: exposure - newTotal, newTotal, exposure } : null;
}

