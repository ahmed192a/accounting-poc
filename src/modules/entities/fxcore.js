// Pure FX arithmetic and rate lookup. No ledger imports (src/ledger.js imports this file).
// Rates are integers: rate_micro = EGP per 1 whole unit of a currency, times 1,000,000. Amounts are integer
// minor units. Everything is computed with BigInt and rounded ONCE, half away from zero, so there are no floats.
import { AppError } from '../../errors.js';

export const RATE_SCALE = 1_000_000;
export const PIVOT = 'EGP'; // rates are quoted against the Egyptian pound

function roundDiv(n, d) {
  const neg = (n < 0n) !== (d < 0n);
  const an = n < 0n ? -n : n, ad = d < 0n ? -d : d;
  const q = (2n * an + ad) / (2n * ad); // round half up on magnitudes
  return neg ? -q : q;
}

/** Convert integer minor units between currencies given each side's micro rate (to EGP) and minor units. */
export function convertMinor(amount, from, to) {
  if (!Number.isInteger(amount)) throw new AppError(400, 'BAD_INPUT', 'Amount must be a whole number of minor units');
  const num = BigInt(amount) * BigInt(from.rate) * 10n ** BigInt(to.minor);
  const den = 10n ** BigInt(from.minor) * BigInt(to.rate);
  return Number(roundDiv(num, den));
}

/** Parse a decimal rate such as "48.5" or 48.5 into micro units without floating point arithmetic. */
export function parseRate(v) {
  const s = String(v ?? '').trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new AppError(400, 'BAD_RATE', 'Rate must be a positive decimal with at most 6 decimals');
  const [i, f = ''] = s.split('.');
  const micro = Number(i) * RATE_SCALE + Number(f.padEnd(6, '0'));
  if (!(micro > 0) || !Number.isSafeInteger(micro)) throw new AppError(400, 'BAD_RATE', 'Rate must be greater than zero');
  return micro;
}

export const formatRate = (micro) => {
  const i = Math.trunc(micro / RATE_SCALE), f = String(micro % RATE_SCALE).padStart(6, '0').replace(/0+$/, '');
  return f ? `${i}.${f}` : String(i);
};

export function getCurrency(db, code) {
  const c = db.prepare('SELECT code, minor_units, active FROM entities_currencies WHERE code = ?').get(String(code ?? '').toUpperCase());
  if (!c) throw new AppError(400, 'UNKNOWN_CURRENCY', `Unknown currency ${code}`);
  return c;
}

/** Latest rate on or before `date` (micro). EGP is always 1,000,000. */
export function getRate(db, code, date) {
  const c = getCurrency(db, code);
  if (c.code === PIVOT) return RATE_SCALE;
  const r = db.prepare('SELECT rate_micro FROM entities_rates WHERE currency = ? AND rate_date <= ? ORDER BY rate_date DESC, id DESC LIMIT 1').get(c.code, date);
  if (!r) throw new AppError(409, 'NO_RATE', `No exchange rate for ${c.code} on or before ${date}`);
  return r.rate_micro;
}

/** Convert minor units of `from` into minor units of `to` using the rates in force on `date`. */
export function convertAmount(db, amount, fromCode, toCode, date, overrides = {}) {
  const f = getCurrency(db, fromCode), t = getCurrency(db, toCode);
  if (f.code === t.code) return amount;
  const rate = (c) => overrides[c.code] ?? getRate(db, c.code, date);
  return convertMinor(amount, { rate: rate(f), minor: f.minor_units }, { rate: rate(t), minor: t.minor_units });
}

/** Effective micro rate foreign -> target for 1 whole unit (informational, stored on the line). */
export function crossRate(db, fromCode, toCode, date) {
  const f = getCurrency(db, fromCode), t = getCurrency(db, toCode);
  if (f.code === t.code) return RATE_SCALE;
  return convertMinor(10 ** f.minor_units, { rate: getRate(db, f.code, date), minor: f.minor_units }, { rate: getRate(db, t.code, date), minor: 6 });
}

/** Convert foreign minor units to the entity currency with an explicit micro rate (foreign -> entity currency). */
export function convertWithRate(amount, rateMicro, fromMinor, toMinor) {
  return convertMinor(amount, { rate: rateMicro, minor: fromMinor }, { rate: RATE_SCALE, minor: toMinor });
}
