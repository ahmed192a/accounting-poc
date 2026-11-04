import { AppError } from '../../errors.js';
import { isoDate } from '../../ledger.js';

export const EXPENSE_CODES = { purchases: '5000', rent: '5100', utilities: '5200' };
export const CATEGORIES = Object.keys(EXPENSE_CODES);

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validDate(s, field) {
  if (typeof s !== 'string' || !DATE_RE.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z')) || isoDate(Date.parse(s + 'T00:00:00Z')) !== s) {
    throw new AppError(400, 'BAD_DATE', `${field} must be a real date as YYYY-MM-DD`);
  }
  return s;
}

export const today = (ctx) => isoDate(ctx.now());

export function addDays(date, n) {
  return isoDate(Date.parse(date + 'T00:00:00Z') + n * 86400000);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

/** Add whole months, keeping the anchor day but clamping to the end of shorter months. */
export function addMonths(date, n, anchorDay) {
  const [y, m] = date.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12), nm = (idx % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const d = Math.min(anchorDay, last);
  return `${ny}-${String(nm).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function cleanText(v, field, { max = 200, required = false } = {}) {
  if (v == null || v === '') {
    if (required) throw new AppError(400, 'BAD_INPUT', `${field} is required`);
    return null;
  }
  if (typeof v !== 'string') throw new AppError(400, 'BAD_INPUT', `${field} must be text`);
  const s = v.trim();
  if (!s && required) throw new AppError(400, 'BAD_INPUT', `${field} is required`);
  if (s.length > max) throw new AppError(400, 'BAD_INPUT', `${field} is too long (max ${max})`);
  return s || null;
}

export function wholeInt(n, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(n) || n < min || n > max) throw new AppError(400, 'BAD_INPUT', `${field} must be a whole number between ${min} and ${max}`);
  return n;
}
