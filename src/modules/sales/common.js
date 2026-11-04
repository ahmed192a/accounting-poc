import { AppError, posInt } from '../../errors.js';
import { isoDate } from '../../ledger.js';
import { setting } from '../../db.js';

export const DAY = 24 * 3600 * 1000;
export const today = (ctx) => isoDate(ctx.now());
export const vatOf = (db, subtotal) => Math.round((subtotal * Number(setting(db, 'vat_rate_bp'))) / 10000);
export const addDays = (date, n) => isoDate(Date.parse(date) + n * DAY);
export const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);

export function text(v, field, { max = 200, required = false } = {}) {
  if (v == null || v === '') {
    if (required) throw new AppError(400, 'BAD_INPUT', `${field} is required`);
    return null;
  }
  if (typeof v !== 'string') throw new AppError(400, 'BAD_INPUT', `${field} must be text`);
  const s = v.trim();
  if (!s) {
    if (required) throw new AppError(400, 'BAD_INPUT', `${field} is required`);
    return null;
  }
  if (s.length > max) throw new AppError(400, 'BAD_INPUT', `${field} is too long (max ${max} characters)`);
  return s;
}

export function dateOf(v, field) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v ?? '') || Number.isNaN(Date.parse(v))) throw new AppError(400, 'BAD_DATE', `${field} must be YYYY-MM-DD`);
  return v;
}

export function money(n, field) {
  return posInt(n, field);
}

/** Validate invoice/quote lines (net, VAT-exclusive) and return { lines, subtotal }. */
export function parseLines(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new AppError(400, 'BAD_INPUT', 'At least one line is required');
  if (raw.length > 200) throw new AppError(400, 'BAD_INPUT', 'Too many lines (max 200)');
  let subtotal = 0;
  const lines = raw.map((l) => {
    if (!l || !l.description || typeof l.description !== 'string' || !l.description.trim()) throw new AppError(400, 'BAD_INPUT', 'Each line needs a description');
    if (l.description.length > 200) throw new AppError(400, 'BAD_INPUT', 'Line description is too long (max 200 characters)');
    const qty = posInt(l.qty, 'qty'), unitPrice = posInt(l.unitPrice, 'unitPrice');
    subtotal += qty * unitPrice;
    if (l.sku != null && (typeof l.sku !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(l.sku))) throw new AppError(400, 'BAD_INPUT', 'Line sku must be a valid item sku');
    return l.sku ? { description: l.description, qty, unitPrice, sku: l.sku } : { description: l.description, qty, unitPrice }; // sku is optional and lets other modules match items exactly
  });
  return { lines, subtotal };
}

const fmtSeq = (s, n) => `${s.prefix}${String(n).padStart(s.padding, '0')}`;

/** Take the next number from a configurable sequence (gap-free inside the caller's transaction). */
export function nextNumber(ctx, name, usedBy) {
  const { db } = ctx;
  const s = db.prepare('SELECT * FROM sales_sequences WHERE name = ?').get(name);
  if (!s) throw new AppError(500, 'NO_SEQUENCE', `Unknown number sequence ${name}`);
  let n = s.next_no;
  while (usedBy(fmtSeq(s, n))) n += 1; // never hand out a number that already exists
  db.prepare('UPDATE sales_sequences SET next_no = ? WHERE name = ?').run(n + 1, name);
  return fmtSeq(s, n);
}

export const fmtMoney = (piastres) => (piastres / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
