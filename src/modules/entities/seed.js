import { isoDate } from '../../ledger.js';

// Accounts reserved for this module (docs/COMMON.md). INSERT OR IGNORE: other seeds may have created them already.
const ACCOUNTS = [
  ['1500', 'Intercompany receivable', 'مستحقات من شركات المجموعة', 'asset'],
  ['2500', 'Intercompany payable', 'مستحقات لشركات المجموعة', 'liability'],
  ['3100', 'Currency translation reserve', 'احتياطي فروق ترجمة العملات', 'equity'],
  ['4900', 'FX gain', 'أرباح فروق العملة', 'revenue'],
  ['5900', 'FX loss', 'خسائر فروق العملة', 'expense'],
];

// Demo exchange rates, labelled source "seed". MOCK numbers, not market data.
const RATES = [['USD', 48500000], ['EUR', 52800000], ['SAR', 12930000]];

export function seed(ctx) {
  const acc = ctx.db.prepare('INSERT OR IGNORE INTO accounts (code, name, name_ar, type) VALUES (?,?,?,?)');
  ACCOUNTS.forEach((a) => acc.run(...a));
}

export function demoSeed(ctx) {
  const date = isoDate(ctx.now());
  const rate = ctx.db.prepare('INSERT INTO entities_rates (currency, rate_date, rate_micro, source, created_by, created_at) VALUES (?,?,?,?,1,?)');
  RATES.forEach(([c, r]) => rate.run(c, date, r, 'seed', ctx.now()));
}
