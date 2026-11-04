import { ensureLedgerAccounts } from './service.js';

// Demo bank accounts. Ledger accounts 1010/1020 are created here (INSERT OR IGNORE); 1000 Cash is created by the
// ledger module's seed, which runs after this one, so we only reference its code. No statement lines are seeded.
export function seed(ctx) {
  ensureLedgerAccounts(ctx.db);
  const ins = ctx.db.prepare('INSERT INTO bank_accounts (name, type, ledger_code, account_number, created_by, created_at) VALUES (?,?,?,?,1,?)');
  ins.run('Cash drawer', 'cash', '1000', null, ctx.now());
  ins.run('Main bank account (demo)', 'bank', '1010', 'DEMO-0001', ctx.now());
  ins.run('Mobile wallet (demo)', 'wallet', '1020', '01000000000', ctx.now());
}
