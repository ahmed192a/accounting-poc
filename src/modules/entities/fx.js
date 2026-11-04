import { AppError } from '../../errors.js';
import { tx, audit, postEntry, isoDate } from '../../ledger.js';
import { requirePerm, requireAny } from '../../permissions.js';
import { getCurrency, getRate, parseRate, formatRate, convertAmount, crossRate, RATE_SCALE, PIVOT } from './fxcore.js';
import { assertEntityAccess } from './service.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const needDate = (d) => { if (!DATE.test(d ?? '')) throw new AppError(400, 'BAD_DATE', 'Date must be YYYY-MM-DD'); return d; };

// ---------- Currencies ----------
export function listCurrencies(ctx, user) {
  requireAny(user, ['currency.manage', 'entities.view', 'ledger.view', 'ledger.post']);
  return ctx.db.prepare('SELECT code, name, name_ar AS nameAr, minor_units AS minorUnits, active FROM entities_currencies ORDER BY code').all().map((c) => ({ ...c, active: !!c.active }));
}

export function addCurrency(ctx, user, input = {}) {
  requirePerm(user, 'currency.manage');
  const code = String(input.code ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new AppError(400, 'BAD_INPUT', 'Currency code must be three letters (ISO 4217)');
  const name = String(input.name ?? '').trim();
  if (!name) throw new AppError(400, 'BAD_INPUT', 'name is required');
  const minor = input.minorUnits ?? 2;
  if (!Number.isInteger(minor) || minor < 0 || minor > 4) throw new AppError(400, 'BAD_INPUT', 'minorUnits must be 0-4');
  if (ctx.db.prepare('SELECT 1 FROM entities_currencies WHERE code = ?').get(code)) throw new AppError(409, 'DUPLICATE', `Currency ${code} already exists`);
  return tx(ctx.db, () => {
    ctx.db.prepare('INSERT INTO entities_currencies (code, name, name_ar, minor_units) VALUES (?,?,?,?)').run(code, name, String(input.nameAr ?? '').trim() || name, minor);
    audit(ctx, { userId: user.id, action: 'currency.added', type: 'currency', newValue: { code, name, minorUnits: minor } });
    return { code };
  });
}

export function setCurrencyActive(ctx, user, code, active) {
  requirePerm(user, 'currency.manage');
  const c = getCurrency(ctx.db, code);
  if (c.code === PIVOT) throw new AppError(409, 'CURRENCY_PROTECTED', 'EGP is the base currency and cannot be deactivated');
  return tx(ctx.db, () => {
    ctx.db.prepare('UPDATE entities_currencies SET active = ? WHERE code = ?').run(active ? 1 : 0, c.code);
    audit(ctx, { userId: user.id, action: active ? 'currency.activated' : 'currency.deactivated', type: 'currency', newValue: { code: c.code } });
    return { code: c.code, active: !!active };
  });
}

// ---------- Rates: manual entry plus a provider interface ----------
export function setRate(ctx, user, input = {}) {
  requirePerm(user, 'currency.manage');
  const c = getCurrency(ctx.db, input.currency);
  if (c.code === PIVOT) throw new AppError(400, 'BAD_INPUT', 'EGP is the base currency; its rate is always 1');
  const date = needDate(input.date);
  const micro = input.rateMicro != null ? input.rateMicro : parseRate(input.rate);
  if (!Number.isSafeInteger(micro) || micro <= 0) throw new AppError(400, 'BAD_RATE', 'Rate must be greater than zero');
  return tx(ctx.db, () => {
    const res = ctx.db.prepare('INSERT INTO entities_rates (currency, rate_date, rate_micro, source, created_by, created_at) VALUES (?,?,?,?,?,?)')
      .run(c.code, date, micro, input.source ?? 'manual', user.id, ctx.now());
    const id = Number(res.lastInsertRowid);
    audit(ctx, { userId: user.id, action: 'fx.rate_set', type: 'fx_rate', id, newValue: { currency: c.code, date, rate: formatRate(micro), source: input.source ?? 'manual' } });
    return { id, currency: c.code, date, rate: formatRate(micro) };
  });
}

export function listRates(ctx, user, { currency, limit } = {}) {
  requireAny(user, ['currency.manage', 'entities.view', 'ledger.view', 'ledger.post']);
  const n = Math.min(Number(limit) || 100, 500);
  const rows = currency
    ? ctx.db.prepare('SELECT * FROM entities_rates WHERE currency = ? ORDER BY rate_date DESC, id DESC LIMIT ?').all(String(currency).toUpperCase(), n)
    : ctx.db.prepare('SELECT * FROM entities_rates ORDER BY rate_date DESC, id DESC LIMIT ?').all(n);
  return rows.map((r) => ({ id: r.id, currency: r.currency, date: r.rate_date, rate: formatRate(r.rate_micro), rateMicro: r.rate_micro, source: r.source }));
}

/** Latest rate per currency as of a date (for dashboards and the journal-entry form). */
export function latestRates(ctx, user, date) {
  requireAny(user, ['currency.manage', 'entities.view', 'ledger.view', 'ledger.post']);
  const d = date ? needDate(date) : isoDate(ctx.now());
  const out = {};
  for (const c of ctx.db.prepare("SELECT code FROM entities_currencies WHERE active = 1 AND code <> 'EGP' ORDER BY code").all()) {
    try { out[c.code] = { rateMicro: getRate(ctx.db, c.code, d), rate: formatRate(getRate(ctx.db, c.code, d)) }; } catch { /* no rate yet */ }
  }
  return out;
}

const providers = new Map();
/** A provider is { name, fetchRates(currencies, date) -> { USD: '48.5', ... } }. Real providers (central bank, API) plug in here. */
export function registerRateProvider(p) {
  if (!p || typeof p.name !== 'string' || typeof p.fetchRates !== 'function') throw new Error('A rate provider needs { name, fetchRates(currencies, date) }');
  providers.set(p.name, p);
}

// MOCK provider: deterministic pseudo-rates around fixed anchors. NOT real market data, never use for real books.
const MOCK_ANCHOR = { USD: 48500000, EUR: 52800000, SAR: 12930000, GBP: 61400000, AED: 13200000 };
export const mockProvider = {
  name: 'mock',
  fetchRates(currencies, date) {
    const out = {};
    for (const code of currencies) {
      const anchor = MOCK_ANCHOR[code] ?? 10 * RATE_SCALE;
      let h = 0;
      for (const ch of `${code}|${date}`) h = (h * 31 + ch.charCodeAt(0)) % 1_000_003;
      const bp = (h % 201) - 100; // -1.00% .. +1.00%
      out[code] = formatRate(anchor + Math.trunc((anchor * bp) / 10000));
    }
    return out;
  },
};
registerRateProvider(mockProvider);

export function fetchRates(ctx, user, input = {}) {
  requirePerm(user, 'currency.manage');
  const p = providers.get(input.provider ?? 'mock');
  if (!p) throw new AppError(400, 'UNKNOWN_PROVIDER', `Unknown rate provider ${input.provider}`);
  const date = needDate(input.date ?? isoDate(ctx.now()));
  const codes = (input.currencies ?? ctx.db.prepare("SELECT code FROM entities_currencies WHERE active = 1 AND code <> 'EGP'").all().map((c) => c.code)).map((c) => getCurrency(ctx.db, c).code);
  if (codes.includes(PIVOT)) throw new AppError(400, 'BAD_INPUT', 'EGP needs no rate');
  const fetched = p.fetchRates(codes, date);
  return tx(ctx.db, () => {
    const saved = codes.map((code) => setRate(ctx, user, { currency: code, date, rate: fetched[code], source: p.name }));
    return { provider: p.name, date, saved, mock: p.name === 'mock' };
  });
}

export function convert(ctx, user, { amount, from, to, date }) {
  requireAny(user, ['currency.manage', 'entities.view', 'ledger.view', 'ledger.post']);
  const n = Number(amount);
  if (!Number.isInteger(n)) throw new AppError(400, 'BAD_INPUT', 'amount must be a whole number of minor units');
  const d = needDate(date ?? isoDate(ctx.now()));
  return { amount: convertAmount(ctx.db, n, from, to, d), from: String(from).toUpperCase(), to: String(to).toUpperCase(), date: d };
}

// ---------- Revaluation of foreign-currency balances ----------
/**
 * Revalue the foreign-currency balances of one entity as of a date. For every (account, currency) with foreign
 * lines it compares the carried base amount with the foreign balance at the rate in force on that date and posts the
 * difference to 4900 FX gain or 5900 FX loss. The adjustment lines carry the currency with a zero foreign amount, so
 * the next revaluation sees them. A second run on the same rates posts nothing. Reversible like any entry.
 */
export function revalue(ctx, user, { entityId = 1, asOf, memo } = {}) {
  requirePerm(user, 'currency.manage');
  requirePerm(user, 'ledger.post');
  const entity = assertEntityAccess(ctx, user, entityId);
  const date = needDate(asOf ?? isoDate(ctx.now()));
  const { db } = ctx;
  const rows = db.prepare(`
    SELECT a.code AS account, l.currency,
           SUM(CASE WHEN l.debit > 0 THEN COALESCE(l.fx_amount, 0) ELSE -COALESCE(l.fx_amount, 0) END) AS foreign_net,
           SUM(l.debit - l.credit) AS carried
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
    WHERE e.entity_id = ? AND e.entry_date <= ? AND l.currency <> ?
    GROUP BY a.code, l.currency ORDER BY a.code, l.currency`).all(entityId, date, entity.currency);
  const adjustments = [];
  for (const r of rows) {
    const c = getCurrency(db, r.currency);
    const rate = crossRate(db, r.currency, entity.currency, date);
    const revalued = r.foreign_net === 0 ? 0 : convertAmount(db, r.foreign_net, r.currency, entity.currency, date);
    const diff = revalued - r.carried;
    if (diff !== 0) adjustments.push({ account: r.account, currency: r.currency, foreign: r.foreign_net, carried: r.carried, revalued, diff, rate, minor: c.minor_units });
  }
  if (!adjustments.length) return { entryId: null, date, adjustments: [], gain: 0, loss: 0 };
  const lines = [];
  let gain = 0, loss = 0;
  for (const a of adjustments) {
    const adj = { account: a.account, currency: a.currency, fxAmount: 0, rate: a.rate, fxAdjustment: true };
    if (a.diff > 0) { lines.push({ ...adj, debit: a.diff }); gain += a.diff; }
    else { lines.push({ ...adj, credit: -a.diff }); loss += -a.diff; }
  }
  if (gain) lines.push({ account: '4900', credit: gain });
  if (loss) lines.push({ account: '5900', debit: loss });
  return tx(db, () => {
    const e = postEntry(ctx, { userId: user.id, entityId, date, lines, sourceType: 'fx_revaluation', memo: memo ?? `FX revaluation as of ${date}` });
    audit(ctx, { userId: user.id, action: 'fx.revalued', type: 'journal_entry', id: e.id, newValue: { entityId, date, gain, loss, accounts: adjustments.length } });
    return { entryId: e.id, date, adjustments, gain, loss };
  });
}
