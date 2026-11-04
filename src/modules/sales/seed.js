const ITEMS = [
  ['TEA-250', 'Black tea 250g', 'شاي أسود ٢٥٠ جم', 4500, 'EGS-EG-100200-TEA250'],
  ['RICE-1K', 'Rice 1kg', 'أرز ١ كجم', 3200, 'EGS-EG-100200-RICE1K'],
  ['OIL-1L', 'Sunflower oil 1L', 'زيت عباد الشمس ١ لتر', 8900, 'EGS-EG-100200-OIL1L'],
  ['SPICE-LOOSE', 'Loose spices (no item code yet)', 'بهارات سائبة (بدون كود صنف)', 2500, null],
];

export function seed(ctx) {
  const item = ctx.db.prepare('INSERT INTO items (sku, name, name_ar, price, eta_code) VALUES (?,?,?,?,?)');
  ITEMS.forEach((i) => item.run(...i));
  ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('vat_rate_bp', '1400')").run(); // 14% VAT, configurable; verify the rate for your goods
}
