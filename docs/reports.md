# Reports module

Read-only reporting over the ledger (`journal_entries(entry_date, entity_id)`, `journal_lines(entry_id, account_id, debit, credit)`, `accounts`). Money is integer piastres. Own table: `reports_saved_filters`. Migration `600_reports` adds indexes on `journal_lines(account_id)`, `journal_lines(entry_id)`, `journal_entries(entry_date)`, `journal_entries(source_type, source_id)`.

## API
`GET /api/reports/:name?format=json|csv|html` (the ledger module's plain `/api/reports` is untouched). Names: `trial-balance`, `profit-loss`, `balance-sheet`, `cash-flow`, `ar-aging`, `ap-aging`, `sales-by-item`, `sales-by-customer`, `sales-by-day`, `vat-summary`, `general-ledger`, `account-transactions`, `dashboard`.

Query: `from`, `to` (or `asOf`), `compare=previous|year|custom` (+`compareFrom`, `compareTo`), `entityId` (optional, ignored if absent), `account`, `period=month|quarter|year` (VAT), `limit`/`offset`, `q`, `source`, `min`, `max`, `includeZero`, `lang=en|ar` (HTML direction and chart labels).

Other routes: `GET /api/report-catalogue`, `GET /api/report-kpis`, `GET /api/report-entries/:id` (drill-down), `GET|POST /api/report-filters`, `DELETE /api/report-filters/:id`. Home widget `reportKpis`.

Every report: `{ name, title{en,ar}, params, columns, rows, summary, summaryPrev?, checks[], meta, generatedAt }`. Rows have a `kind` (line, header, subtotal, total, check). With a comparison, each comparable column gains `<col>Prev` and `<col>Change`.

CSV: UTF-8 with BOM, CRLF, bilingual header row, plain decimals; text cells starting with `= + - @` are prefixed with `'` (spreadsheet formula injection guard). HTML: print stylesheet, `dir=rtl` for `lang=ar`, bilingual headings, escaped text.

**Raw output limitation:** `src/server.js` only sends JSON, so csv/html are returned as `{ "__raw": { contentType, filename, body } }`. The UI unwraps it. If the server adds support for `__raw` (send `body` with that content type and a `content-disposition` header) nothing else changes.

## Permissions
`reports.view` (declared by ledger): basic JSON reports, dashboard, KPIs, own saved filters. `reports.export`: csv/html. `reports.advanced`: cash flow, aging, general ledger, account transactions, entry drill-down, shared filters. Granted to manager, accountant, auditor (owner has all). Exports are audited (`report.exported`); filters audited too.

## Accounting notes and limits
- Balance sheet: no closing entries exist, so equity shows prior-period retained earnings plus current-year profit (from 1 January of the as-of year); a visible check row and `checks[]` prove assets = liabilities + equity.
- P&L: accounts 5000 and 5300 are treated as cost of goods sold (assumption).
- Cash flow: direct method from accounts 1000/1010/1020 per entry, grouped by source type; operating/investing/financing classification is a simplification (UNVERIFIED).
- AR aging uses invoices, payments (`source_type=payment`) and due dates; any difference from account 1200 appears as an "Other / unapplied" row. AP aging: bills have no due dates or payment links, so age counts from the bill date and unlinked debits to 2000 are applied oldest-first (MOCK).
- VAT summary is a management view of ledger 2100 and 1400, not a tax return (UNVERIFIED). Sales by item/customer read invoices and quick sales (excluding reversed entries).
- KPIs: DSO is an approximation (receivables / 90-day credit sales x 90); current ratio treats assets below code 1500 as current (UNVERIFIED).
- Multi-currency amounts are summed as stored; currency translation is not handled here.
