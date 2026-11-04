import { setup } from './helpers.js';
import * as b from '../src/modules/banking/service.js';
import { createInvoice } from '../src/modules/sales/service.js';
import { createBill } from '../src/modules/purchases/service.js';

export const MAP = { dateCol: 'Date', dateFormat: 'YYYY-MM-DD', descriptionCol: 'Description', referenceCol: 'Reference', amountCol: 'Amount' };
export const csv = (rows) => 'Date,Description,Reference,Amount\n' + rows.map((r) => r.join(',')).join('\n') + '\n';

/** Fresh context with the seeded demo bank account (id 2, ledger 1010) and helpers. */
export function bank() {
  const { ctx, as } = setup();
  const acct = b.listAccounts(ctx, as('owner')).find((a) => a.type === 'bank');
  const accountant = as('accountant');
  /** import + commit a CSV (rows = arrays), returns the committed batch */
  const load = (rows, extra = {}) => {
    const p = b.createImport(ctx, accountant, { accountId: acct.id, csv: csv(rows), mapping: MAP, ...extra });
    return b.commitImport(ctx, accountant, p.id, { skipErrors: true });
  };
  const lines = (state = 'all') => b.listLines(ctx, accountant, { accountId: acct.id, state });
  return { ctx, as, acct, accountant, load, lines };
}

export const journalOn = (ctx, code) => ctx.db.prepare(`SELECT je.id AS entry_id, je.entry_date, je.memo, jl.id, jl.debit, jl.credit FROM journal_lines jl
  JOIN accounts a ON a.id = jl.account_id JOIN journal_entries je ON je.id = jl.entry_id WHERE a.code = ? ORDER BY jl.id`).all(code);

export { b, createInvoice, createBill };
