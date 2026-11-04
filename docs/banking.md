# Banking module

Bank, cash and mobile-wallet accounts, CSV statement import, bank rules, matching of statement lines to
invoices, bills and ledger entries, and reconciliation. Code: `src/modules/banking/`, UI: `public/modules/banking.js`,
schema: `src/migrations/100_banking.js`.

## Limits (read first)
- **Live bank feeds are NOT implemented.** Availability of bank feeds/open banking in Egypt is unverified. Statements
  come only from CSV files. The UI says so on the Banking page.
- Matching is a heuristic scoring engine (amount, reference text, customer/supplier name, dates), not AI. Every suggestion
  carries a 0-100 confidence and human-readable reasons; nothing is posted until a person accepts it.
- Invoice/bill settlement: the module posts the bank-side entry (Dr bank / Cr 1200, or Dr 2000 / Cr bank) and emits
  `banking.invoice_settled` / `banking.bill_settled`. It does not write to the sales/purchases tables; the owning module
  must listen to mark the document paid (see "Requests for shared files" in the build report). Until then the invoice's
  own `paid` flag is unchanged, but the matching engine will not offer it again.
- A regex rule is length-limited and rejected if it has nested repetition (ReDoS heuristic); not a proof of safety.
- Single currency (EGP). Opening balance of the statement can be set per account or derived from a balance column when
  the first row is unambiguous.

## Accounts
`type` is `bank`, `cash` or `wallet`, linked to a ledger account: 1010 Bank accounts, 1020 Mobile wallets, 1000 Cash.
Each bank account owns one ledger account so its ledger balance is exact; a second bank account gets a sub-account
such as `1010-2` (created automatically) or an explicit `ledgerCode` (existing asset account).

## CSV import
`POST /api/banking/csv/inspect` suggests a mapping. `POST /api/banking/imports` parses into a **preview** batch (nothing
is a statement line yet); `commit` activates it; `rollback` marks its lines `void` (never deleted; refused while any line
is reconciled). Mapping: `dateCol, dateFormat, descriptionCol, referenceCol, amountCol | debitCol+creditCol, balanceCol,
methodCol, defaultMethod, decimal (auto . ,), delimiter, invertSign, hasHeader`. Handles UTF-8 BOM, quoted commas/newlines,
`""` escapes, Arabic-Indic digits and separators, parentheses/trailing-minus negatives. Malformed rows are reported with
row numbers (header = row 1); commit needs `skipErrors` when any exist. Dedupe: sha256 of account, date, amount,
normalised text and an occurrence number (identical rows inside one file are legitimate); re-importing adds nothing.
Limits: about 900 KB and 20,000 rows per import.

## Rules, matching, reconciliation
- Rules: `contains`/`regex`, direction, amount range, account code, memo, method, priority (lower first). Test endpoint
  evaluates a sample and the existing lines without saving. "Delete" archives.
- Suggestions: `GET /api/banking/lines/:id/suggestions`, queue: `GET /api/banking/queue`. Accept (`invoice`, `bill`,
  `ledger`, `rule`), reject (never suggested again for that line), manual reconcile (reason required), unreconcile
  (reason required; any entry the match posted is **reversed**, never deleted). Create entry from a line (fees, interest)
  goes through `postEntry` so period locks apply (soft lock needs `confirmSoftLock` + `reason`).
- Summary/report: statement balance (opening + lines) vs ledger balance as of a date, difference, unreconciled counts,
  and `unexplained` (difference not accounted for by unmatched items). Sign-off needs a note unless everything is clean.
- Payment method tags: cash, instapay, fawry, wallet, card, bank_transfer, other.

## Routes (all under /api/banking)
GET accounts, overview, imports, imports/:id, lines, queue, lines/:id/suggestions, rules, reconciliation,
reconciliation/report. POST accounts, csv/inspect, imports, imports/:id/commit, imports/:id/rollback,
lines/:id/{method,accept,reject,reconcile,unreconcile,create-entry}, rules, rules/test,
reconciliation/signoff. PATCH accounts/:id. PUT/DELETE rules/:id.

## Permissions
`banking.view` (declared by the ledger module, reused for all reads), `banking.import` (accounts, import, rollback),
`banking.reconcile` (match, entries from lines, tags, sign-off), `banking.rules`. Grants: accountant gets all three
new atoms; manager has view only; auditor gets view (read-only); owner everything.

## Events (src/hooks.js)
`banking.imported {batchId, accountId, added, duplicates, userId}`, `banking.reconciled {accountId, asOf, difference, clean, userId}`,
`banking.invoice_settled` / `banking.bill_settled {id, amount, entryId, lineId, userId}`,
`banking.settlement_reversed {kind, id, lineId, reversalEntryId, userId}`.

## Widget
`widgets.banking = { unreconciled, difference, accounts: [...] }` for users with `banking.view`.
