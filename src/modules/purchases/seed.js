export function seed(ctx) {
  // Bills up to 1,000 EGP post without approval.
  ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('bill_auto_approve', '100000')").run();
  // 3-way match: allowed unit-price difference from the purchase order, in basis points (0 = exact).
  ctx.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('purchases_match_tolerance_bp', '0')").run();
}

// Demo: sample suppliers.
export function demoSeed(ctx) {
  const sup = ctx.db.prepare('INSERT OR IGNORE INTO purchases_suppliers (name, name_ar, tax_id, payment_terms_days, created_by, created_at) VALUES (?,?,?,?,1,?)');
  sup.run('Delta Trading', 'دلتا للتجارة', '100-200-300', 30, ctx.now());
  sup.run('Nile Office Supplies', 'النيل للمستلزمات المكتبية', '400-500-600', 15, ctx.now());
}
