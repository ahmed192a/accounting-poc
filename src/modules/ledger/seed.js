import { postEntry } from '../../ledger.js';

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

export function seed(ctx) {
  const acc = ctx.db.prepare('INSERT INTO accounts (code, name, name_ar, type) VALUES (?,?,?,?)');
  ACCOUNTS.forEach((a) => acc.run(...a));
}

// Demo: an opening balance so the books are not empty.
export function demoSeed(ctx) {
  postEntry(ctx, {
    userId: 1, memo: 'Opening balance', sourceType: 'opening',
    lines: [{ account: '1000', debit: 1000000 }, { account: '3000', credit: 1000000 }], // 10,000 EGP
  });
}
