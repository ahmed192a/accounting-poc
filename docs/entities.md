# Entities, currencies, consolidation and chart of accounts

Modules: `src/modules/entities` (entities, FX, CoA, consolidation, intercompany), `src/modules/ledger` (journal routes, year-end closing),
core posting in `src/ledger.js`. Migration `300_entities`. UI: `public/modules/entities.js`, `public/modules/ledger.js`.

## Model
- `entities`: company or branch, with a functional `currency` (default EGP) and `fiscal_year_start_month`. Entity 1 `MAIN` always exists.
  An entity's journal debit/credit are in the minor units of ITS currency. Access: no `entities_users` rows = open to all; otherwise
  listed users and holders of `entities.manage`.
- Chart of accounts is shared by all entities; balances are per entity (`journal_entries.entity_id`).
- Journal lines gain optional `fx_amount` (foreign minor units) and `fx_rate` (micro rate); `currency` already existed.
- Rates are integers: `rate_micro` = EGP per 1 whole unit x 1,000,000. Latest rate on or before the date wins; corrections are new rows.
  Conversion uses BigInt and rounds once, half away from zero.
- `postEntry(ctx, { ..., entityId?, allowRounding?, lines: [{ account, debit|credit, currency?, fxAmount?, rate?, side? }] })`: all new
  parameters are optional. A foreign line given as `{currency, fxAmount, side}` gets its base amount from the stored rate;
  `allowRounding` absorbs at most 1 minor unit per derived foreign line (audited as `roundingAdjust`).
  Deactivated accounts and entities refuse new postings (reversals and year-end closings are still allowed).
- `trialBalance(db, opts)`, `profitAndLoss`, `accountBalance`, `recentEntries` take optional `{ entityId, from, to }`. No options = whole ledger.
  Routes default to entity 1 and accept `entityId` in body or query.

## Routes (permission)
Entities: `GET/POST /api/entities` (entities.view / entities.manage), `PATCH /api/entities/:id`, `PUT /api/entities/:id/users`, `PUT /api/entities/:id/fiscal` (entities.manage).
Consolidation: `GET /api/entities/consolidation?asOf&currency&entityIds` (entities.view + reports.view); intercompany `POST /api/entities/intercompany` (ledger.post),
`POST /api/entities/intercompany/:id/reverse` (ledger.reverse), `GET /api/entities/intercompany`.
FX (currency.manage unless noted): `GET/POST /api/currencies`, `PATCH /api/currencies/:code`, `GET/POST /api/fx/rates`, `POST /api/fx/rates/fetch`
(MOCK provider), `GET /api/fx/latest`, `GET /api/fx/convert` (entities.view), `POST /api/fx/revalue` (currency.manage + ledger.post).
CoA (coa.manage): `GET/POST /api/coa`, `PATCH/DELETE /api/coa/:code`, `POST /api/coa/import` (CSV, all or nothing, `dryRun`), `GET /api/coa/template`, `POST /api/coa/template/apply`.
Ledger: `GET/POST /api/entries`, `GET /api/reports` accept `entityId`; `GET /api/ledger/fiscal|closings`, `POST /api/ledger/close-year`,
`POST /api/ledger/closings/:id/reverse` (ledger.close).

## Behaviour
- **Revaluation**: per (account, foreign currency) it compares the carried base amount with the foreign balance at the rate on the date and posts the
  difference to 4900 FX gain / 5900 FX loss. Adjustment lines carry the currency with a zero foreign amount. Idempotent; reversible.
- **Consolidation**: each entity's trial balance is translated to the report currency (closing rate; optional `averageRates` for P&L), 1500/2500 are
  eliminated, and translation difference, rounding and any unmatched intercompany balance go to 3100 so the report balances.
  UNVERIFIED simplification: equity is translated at the closing rate, not historical rates (IAS 21 would differ).
- **Intercompany**: two mirrored entries (Dr 1500 in the lender, Cr 2500 in the borrower) with `source_type='intercompany'`, `source_id` = group id; atomic.
- **Year-end closing**: revenue and expense accounts for the fiscal year are zeroed into 3000 by a normal entry dated the last day of the year
  (`source_type='year_close'`). Reversing it (dated the same day, so lift any lock first) reopens the year.
- **CoA**: never delete an account with history (`ACCOUNT_HAS_HISTORY`); deactivate it. Codes used by other modules are protected. The Egyptian starter chart
  has English and Arabic names; the numbering is this app's own and UNVERIFIED against the Egyptian Uniform Accounting System.

## Permissions
`entities.view`, `entities.manage`, `currency.manage`, `coa.manage`, `ledger.close` (plus the existing `ledger.*`, `period.lock`, `reports.view`).
Granted: manager entities.view + ledger.close; accountant entities.view, currency.manage, coa.manage; auditor entities.view.

## Limits
Exchange-rate provider is a MOCK; no historical-rate equity translation; period lock is global (not per entity); rates are quoted against EGP only.
