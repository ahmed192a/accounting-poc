import { AppError } from '../../errors.js';
import { audit, tx } from '../../ledger.js';
import { requirePerm } from '../../permissions.js';
import { setting } from '../../db.js';
import { ADAPTERS, DEFAULT_ADAPTER, listAdapters } from './adapters/index.js';

const HOUR = 3600 * 1000;
// Every figure below is CONFIGURABLE and UNVERIFIED: deadlines, windows, thresholds and retention are set by
// the authority and change over time. The defaults only make the demo behave sensibly.
export const DEFAULTS = {
  tax_adapter: DEFAULT_ADAPTER,
  tax_einvoice_enabled: '1',
  tax_cancel_window_hours: '72',        // UNVERIFIED
  tax_submit_deadline_hours: '24',      // UNVERIFIED (mirrors the receipt demo window)
  tax_buyer_id_threshold: '5000000',    // piastres, UNVERIFIED mock rule: buyer tax id required at or above
  tax_retention_years: '5',             // UNVERIFIED
  tax_seller_name: 'Demo Trading Co. (demo data)',
  tax_seller_address: 'Cairo, Egypt (demo data)',
  tax_reg_number: '100200300',          // DEMO value, not a real registration
  tax_regnum_pattern: '^\\d{9}$',       // UNVERIFIED format check used by the wizard and the Egypt mock
  tax_go_live: '0',
  tax_last_sync: '',
  tax_withholding_rates: '{}',
  // Simplified-regime turnover bands (PLACEHOLDER numbers, UNVERIFIED): tax = fixed + turnover * rateBp / 10000
  // for the first band whose upTo (annual turnover, piastres) is not exceeded; upTo null = no upper limit.
  tax_turnover_bands: JSON.stringify([
    { upTo: 50000000, rateBp: 40, fixed: 0 },
    { upTo: 200000000, rateBp: 80, fixed: 0 },
    { upTo: null, rateBp: 120, fixed: 0 },
  ]),
};

export function seedSettings(db) {
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)');
  for (const [k, v] of Object.entries(DEFAULTS)) ins.run(k, v);
}

export const cfg = (db, key) => setting(db, key) ?? DEFAULTS[key];
export const cfgInt = (db, key) => Number(cfg(db, key));
export const hoursMs = (db, key) => cfgInt(db, key) * HOUR;

const intIn = (v, lo, hi, f) => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new AppError(400, 'BAD_INPUT', `${f} must be a whole number between ${lo} and ${hi}`);
  return v;
};
const text = (v, f) => {
  if (typeof v !== 'string' || !v.trim() || v.length > 200) throw new AppError(400, 'BAD_INPUT', `${f} must be a non-empty text of at most 200 characters`);
  return v.trim();
};

// body key -> [setting key, validator returning the stored string]
const FIELDS = {
  adapter: ['tax_adapter', (v) => { if (!ADAPTERS[v]) throw new AppError(400, 'UNKNOWN_ADAPTER', `Unknown tax adapter "${v}"`); return v; }],
  einvoiceEnabled: ['tax_einvoice_enabled', (v) => { if (typeof v !== 'boolean') throw new AppError(400, 'BAD_INPUT', 'einvoiceEnabled must be true or false'); return v ? '1' : '0'; }],
  cancelWindowHours: ['tax_cancel_window_hours', (v) => String(intIn(v, 0, 8760, 'cancelWindowHours'))],
  submitDeadlineHours: ['tax_submit_deadline_hours', (v) => String(intIn(v, 1, 8760, 'submitDeadlineHours'))],
  buyerIdThresholdPiastres: ['tax_buyer_id_threshold', (v) => String(intIn(v, 0, 1e12, 'buyerIdThresholdPiastres'))],
  retentionYears: ['tax_retention_years', (v) => String(intIn(v, 1, 50, 'retentionYears'))],
  sellerName: ['tax_seller_name', (v) => text(v, 'sellerName')],
  sellerAddress: ['tax_seller_address', (v) => text(v, 'sellerAddress')],
  registrationNumber: ['tax_reg_number', (v) => { if (typeof v !== 'string' || !/^[A-Za-z0-9-]{5,20}$/.test(v)) throw new AppError(400, 'BAD_INPUT', 'registrationNumber must be 5 to 20 letters, digits or dashes'); return v; }],
  regNumberPattern: ['tax_regnum_pattern', (v) => { try { new RegExp(v); } catch { throw new AppError(400, 'BAD_INPUT', 'regNumberPattern is not a valid regular expression'); } return v; }],
};

export function getSettings(ctx, user) {
  requirePerm(user, 'tax.view');
  const db = ctx.db;
  return {
    mock: true,
    notice: 'Everything that talks to a tax authority is a MOCK. Deadlines, windows, thresholds, rates and formats below are configurable and UNVERIFIED.',
    adapter: cfg(db, 'tax_adapter'), adapters: listAdapters(),
    einvoiceEnabled: cfg(db, 'tax_einvoice_enabled') === '1',
    cancelWindowHours: cfgInt(db, 'tax_cancel_window_hours'),
    submitDeadlineHours: cfgInt(db, 'tax_submit_deadline_hours'),
    buyerIdThresholdPiastres: cfgInt(db, 'tax_buyer_id_threshold'),
    retentionYears: cfgInt(db, 'tax_retention_years'),
    sellerName: cfg(db, 'tax_seller_name'), sellerAddress: cfg(db, 'tax_seller_address'),
    registrationNumber: cfg(db, 'tax_reg_number'), regNumberPattern: cfg(db, 'tax_regnum_pattern'),
    goLive: cfg(db, 'tax_go_live') === '1',
  };
}

export function updateSettings(ctx, user, body) {
  requirePerm(user, 'tax.configure');
  const keys = Object.keys(body ?? {});
  if (!keys.length) throw new AppError(400, 'BAD_INPUT', 'Nothing to change');
  for (const k of keys) if (!FIELDS[k]) throw new AppError(400, 'BAD_INPUT', `Unknown setting "${k}"`);
  const next = Object.fromEntries(keys.map((k) => [FIELDS[k][0], FIELDS[k][1](body[k])])); // validate everything first
  tx(ctx.db, () => {
    const old = {};
    for (const [k, v] of Object.entries(next)) {
      old[k] = cfg(ctx.db, k);
      ctx.db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
    }
    audit(ctx, { userId: user.id, action: 'tax.settings', type: 'tax_settings', oldValue: old, newValue: next });
  });
  return getSettings(ctx, user);
}
