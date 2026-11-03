import { postEntry, tx } from './ledger.js';
import { BUILTIN_ROLES } from './permissions.js';

const ACCOUNTS = [
  ['1000', 'Cash', 'النقدية', 'asset'],
  ['1200', 'Accounts receivable', 'العملاء', 'asset'],
  ['2000', 'Accounts payable', 'الموردون', 'liability'],
  ['2100', 'VAT payable', 'ضريبة القيمة المضافة المستحقة', 'liability'],
  ['3000', 'Owner equity', 'حقوق الملكية', 'equity'],
  ['4000', 'Sales revenue', 'إيرادات المبيعات', 'revenue'],
  ['5000', 'Purchases', 'المشتريات', 'expense'],
  ['5100', 'Rent', 'الإيجار', 'expense'],
  ['5200', 'Utilities', 'المرافق', 'expense'],
];

const USERS = [
  ['Mona (owner)', 'owner'],
  ['Karim (manager)', 'manager'],
  ['Sara (clerk)', 'clerk'],
  ['Hossam (accountant)', 'accountant'],
  ['Laila (auditor)', 'auditor'],
  ['Omar (admin / developer)', 'admin'],
];

const ITEMS = [
  ['TEA-250', 'Black tea 250g', 'شاي أسود ٢٥٠ جم', 4500, 'EGS-EG-100200-TEA250'],
  ['RICE-1K', 'Rice 1kg', 'أرز ١ كجم', 3200, 'EGS-EG-100200-RICE1K'],
  ['OIL-1L', 'Sunflower oil 1L', 'زيت عباد الشمس ١ لتر', 8900, 'EGS-EG-100200-OIL1L'],
  ['SPICE-LOOSE', 'Loose spices (no item code yet)', 'بهارات سائبة (بدون كود صنف)', 2500, null],
];

export function seed(ctx) {
  const { db } = ctx;
  tx(db, () => {
    const acc = db.prepare('INSERT INTO accounts (code, name, name_ar, type) VALUES (?,?,?,?)');
    ACCOUNTS.forEach((a) => acc.run(...a));

    const role = db.prepare('INSERT INTO roles (name, permissions, limits, builtin) VALUES (?,?,?,1)');
    BUILTIN_ROLES.forEach((r) => role.run(r.name, JSON.stringify(r.permissions), JSON.stringify(r.limits)));

    const user = db.prepare('INSERT INTO users (name, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))');
    USERS.forEach((u) => user.run(...u));

    const item = db.prepare('INSERT INTO items (sku, name, name_ar, price, eta_code) VALUES (?,?,?,?,?)');
    ITEMS.forEach((i) => item.run(...i));

    const set = db.prepare('INSERT INTO settings (key, value) VALUES (?,?)');
    set.run('vat_rate_bp', '1400');          // 14% VAT, configurable; verify the rate for your goods
    set.run('bill_auto_approve', '100000');  // bills up to 1,000 EGP post without approval
    set.run('eta_online', '1');

    postEntry(ctx, {
      userId: 1, memo: 'Opening balance', sourceType: 'opening',
      lines: [{ account: '1000', debit: 1000000 }, { account: '3000', credit: 1000000 }], // 10,000 EGP
    });
  });
  return ctx;
}
