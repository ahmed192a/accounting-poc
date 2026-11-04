// Read-only ledger queries shared by the report builders. They touch only
// journal_entries(entry_date, entity_id), journal_lines(entry_id, account_id, debit, credit) and accounts.
// `entityId` is an optional filter: when absent every entry is included.
import { AppError } from '../../errors.js';

export const CASH_CODES = ['1000', '1010', '1020'];     // cash, bank accounts, mobile wallets (those that exist)
export const COGS_CODES = ['5000', '5300'];             // purchases and cost of goods sold (assumption, see docs)
export const VAT_OUT = '2100';
export const VAT_IN = '1400';

export function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export const addDays = (s, n) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
export function addYears(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const out = new Date(Date.UTC(y + n, m - 1, d));
  if (out.getUTCMonth() !== m - 1) out.setUTCDate(0); // 29 Feb -> 28 Feb
  return out.toISOString().slice(0, 10);
}

const ent = (entityId, alias = 'e') => (entityId == null ? { sql: '', args: [] } : { sql: ` AND ${alias}.entity_id = ?`, args: [entityId] });
export const entityFilter = ent;

export const chart = (db) => db.prepare('SELECT id, code, name, name_ar, type FROM accounts ORDER BY code').all();
export const accountByCode = (db, code) => db.prepare('SELECT id, code, name, name_ar, type FROM accounts WHERE code = ?').get(code);

/** Per-account debit/credit totals for entries dated within [from, to] (from optional). Map account_id -> {d, c}. */
export function sums(db, { from = null, to, entityId = null }) {
  const f = ent(entityId);
  const rows = db.prepare(
    `SELECT l.account_id AS id, SUM(l.debit) AS d, SUM(l.credit) AS c
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.entry_date <= ?${from ? ' AND e.entry_date >= ?' : ''}${f.sql}
      GROUP BY l.account_id`).all(...(from ? [to, from] : [to]), ...f.args);
  return new Map(rows.map((r) => [r.id, { d: r.d, c: r.c }]));
}
export const zero = { d: 0, c: 0 };

/** Net debit-minus-credit across accounts of one code list, dated up to `to`. */
export function netByCodes(db, codes, { from = null, to, entityId = null }) {
  const ids = codes.map((c) => accountByCode(db, c)?.id).filter((x) => x != null);
  if (!ids.length) return 0;
  const m = sums(db, { from, to, entityId });
  return ids.reduce((s, id) => s + ((m.get(id)?.d ?? 0) - (m.get(id)?.c ?? 0)), 0);
}

export function cashIds(db) {
  return CASH_CODES.map((c) => accountByCode(db, c)?.id).filter((x) => x != null);
}

/** Entry ids that have been reversed (by a reversal dated up to `to`). */
export function reversedSet(db, to) {
  return new Set(db.prepare('SELECT reverses_id AS id FROM journal_entries WHERE reverses_id IS NOT NULL AND entry_date <= ?').all(to).map((r) => r.id));
}

export function requireAccount(db, code) {
  if (!code || typeof code !== 'string') throw new AppError(400, 'BAD_INPUT', 'account (account code) is required');
  const a = accountByCode(db, code);
  if (!a) throw new AppError(404, 'UNKNOWN_ACCOUNT', `Unknown account code ${code}`);
  return a;
}
