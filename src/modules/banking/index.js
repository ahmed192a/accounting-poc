import * as s from './service.js';
import { seed } from './seed.js';

// Banking: bank/cash/wallet accounts, CSV statement import, bank rules, matching, reconciliation.
// banking.view is declared by the ledger module and reused here for read access.
// Live bank feeds are NOT implemented (availability in Egypt unverified): CSV import only.
const route = (method, path, handler, summary, permission) => ({ method, path, handler, meta: { summary, permission } });
const id = (r) => Number(r.params.id);

export default {
  name: 'banking',
  permissions: {
    'banking.import': 'Set up bank accounts and import, commit and roll back statement files',
    'banking.reconcile': 'Match, reject, reconcile and unreconcile statement lines; post entries from lines; sign off',
    'banking.rules': 'Create, edit and test bank rules',
  },
  roleGrants: {
    accountant: ['banking.import', 'banking.reconcile', 'banking.rules'],
    auditor: ['banking.view'], // read-only access to bank balances, statements and reconciliations
  },
  exportTables: ['bank_accounts', 'bank_batches', 'bank_lines', 'bank_rules', 'bank_matches', 'bank_signoffs'],
  routes: [
    route('GET', '/api/banking/accounts', (c, u) => s.listAccounts(c, u), 'List bank, cash and wallet accounts', 'banking.view'),
    route('POST', '/api/banking/accounts', (c, u, r) => s.createAccount(c, u, r.body), 'Create a bank, cash or wallet account linked to a ledger account', 'banking.import'),
    route('PATCH', '/api/banking/accounts/:id', (c, u, r) => s.updateAccount(c, u, id(r), r.body), 'Edit a bank account (name, opening balance, saved CSV mapping, active)', 'banking.import'),
    route('POST', '/api/banking/csv/inspect', (c, u, r) => s.inspectFile(c, u, r.body), 'Read a CSV header and suggest a column mapping', 'banking.import'),
    route('GET', '/api/banking/overview', (c, u, r) => s.overview(c, u, r.query), 'Accounts, rules, queue, summary and batches for the banking page in one call', 'banking.view'),
    route('GET', '/api/banking/imports', (c, u, r) => s.listImports(c, u, r.query), 'List import batches', 'banking.view'),
    route('POST', '/api/banking/imports', (c, u, r) => s.createImport(c, u, r.body), 'Parse a CSV into a preview batch (nothing is committed)', 'banking.import'),
    route('GET', '/api/banking/imports/:id', (c, u, r) => s.getImport(c, u, id(r), { limit: r.query.limit }), 'Preview an import batch with its rows and row-numbered errors', 'banking.view'),
    route('POST', '/api/banking/imports/:id/commit', (c, u, r) => s.commitImport(c, u, id(r), r.body), 'Commit a previewed batch (duplicates are skipped by row hash)', 'banking.import'),
    route('POST', '/api/banking/imports/:id/rollback', (c, u, r) => s.rollbackImport(c, u, id(r), r.body), 'Roll back a batch: its lines are marked void, never deleted', 'banking.import'),
    route('GET', '/api/banking/lines', (c, u, r) => s.listLines(c, u, r.query), 'List statement lines (filter by account, batch, state, method)', 'banking.view'),
    route('GET', '/api/banking/queue', (c, u, r) => s.queue(c, u, r.query), 'Unreconciled lines with their top suggested matches', 'banking.view'),
    route('GET', '/api/banking/lines/:id/suggestions', (c, u, r) => s.lineSuggestions(c, u, id(r)), 'Suggested matches for one line, with confidence and reasons', 'banking.view'),
    route('POST', '/api/banking/lines/:id/method', (c, u, r) => s.setMethod(c, u, id(r), r.body), 'Tag a line with a payment method', 'banking.reconcile'),
    route('POST', '/api/banking/lines/:id/accept', (c, u, r) => s.acceptMatch(c, u, id(r), r.body), 'Accept a suggested match (invoice, bill, ledger entry or rule)', 'banking.reconcile'),
    route('POST', '/api/banking/lines/:id/reject', (c, u, r) => s.rejectMatch(c, u, id(r), r.body), 'Reject a suggested match so it is not suggested again', 'banking.reconcile'),
    route('POST', '/api/banking/lines/:id/reconcile', (c, u, r) => s.manualReconcile(c, u, id(r), r.body), 'Manually reconcile a line to a ledger line (reason required)', 'banking.reconcile'),
    route('POST', '/api/banking/lines/:id/unreconcile', (c, u, r) => s.unreconcile(c, u, id(r), r.body), 'Undo a reconciliation (reverses any entry it posted; reason required)', 'banking.reconcile'),
    route('POST', '/api/banking/lines/:id/create-entry', (c, u, r) => s.createEntryFromLine(c, u, id(r), r.body), 'Post a journal entry from a statement line (fees, interest)', 'banking.reconcile'),
    route('GET', '/api/banking/rules', (c, u) => s.listRules(c, u), 'List bank rules', 'banking.view'),
    route('POST', '/api/banking/rules', (c, u, r) => s.createRule(c, u, r.body), 'Create a bank rule', 'banking.rules'),
    route('POST', '/api/banking/rules/test', (c, u, r) => s.testRule(c, u, r.body), 'Test a rule against a sample and existing lines without saving', 'banking.rules'),
    route('PUT', '/api/banking/rules/:id', (c, u, r) => s.updateRule(c, u, id(r), r.body), 'Edit a bank rule', 'banking.rules'),
    route('DELETE', '/api/banking/rules/:id', (c, u, r) => s.archiveRule(c, u, id(r)), 'Archive a bank rule (it stops applying)', 'banking.rules'),
    route('GET', '/api/banking/reconciliation', (c, u, r) => s.summary(c, u, r.query), 'Reconciliation summary for an account and date', 'banking.view'),
    route('GET', '/api/banking/reconciliation/report', (c, u, r) => s.report(c, u, r.query), 'Reconciliation report: matched, unmatched, sign-offs', 'banking.view'),
    route('POST', '/api/banking/reconciliation/signoff', (c, u, r) => s.signoff(c, u, r.body), 'Sign off a reconciliation as of a date', 'banking.reconcile'),
  ],
  widgets: s.widgets,
  seed,
};
