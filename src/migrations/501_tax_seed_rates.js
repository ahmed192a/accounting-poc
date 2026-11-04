export const id = '501_tax_seed_rates';
// Rates are configurable data, not facts. 14% is the figure the demo has always used; it is flagged UNVERIFIED.
export function up(db) {
  const ins = db.prepare('INSERT INTO tax_vat_rates (code, name, name_ar, rate_bp, verified) VALUES (?,?,?,?,0)');
  ins.run('standard', 'Standard rate (UNVERIFIED)', 'النسبة العامة (غير موثقة)', 1400);
  ins.run('zero', 'Zero rate', 'نسبة صفرية', 0);
  ins.run('exempt', 'Exempt', 'معفى', 0);
}
