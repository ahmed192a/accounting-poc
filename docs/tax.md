# Tax and compliance (modules `tax` and `eta`)

**Everything that talks to a tax authority is a MOCK.** No network call is ever made. Document formats, QR layouts,
VAT rates, turnover bands, deadlines, cancellation windows, thresholds and retention periods are UNVERIFIED
placeholders, stored as settings so they can be corrected. Verify against official ETA/ZATCA documentation and an adviser.

## What it does
- **Adapters** (`src/modules/tax/adapters/`): interface `buildDocument, submit, status, cancel, qr`. `eta_mock` (Egypt e-invoice;
  e-receipts wrap the existing `eta` receipt queue) and `zatca_mock` (TLV base64 Phase 1 QR, tags 1-5). Active adapter = setting `tax_adapter`;
  each document keeps the adapter it was built with.
- **E-invoices**: hook `invoice.created` creates a document (seller/buyer tax ids, GS1/EGS line codes, tax totals, UUID, QR) chained by
  `hash = sha256(seq|kind|number|uuid|total|vat|prev_hash|payload)`. Content columns are immutable (DB trigger); `GET /api/tax/chain` verifies.
  States: queued, submitted, valid, rejected, cancelled. Rejections carry a reason and a fix hint (en/ar); `reissue` chains a corrected document.
  Cancellation allowed inside a configurable window (default 72 h, UNVERIFIED), measured on the demo clock. Credit/debit notes via
  `POST /api/tax/documents/:id/notes` and, if sales emits it, the `credit_note.created` hook (registered only when the event exists in `src/hooks.js`).
- **Item codes**: own table keyed by sku, GS1 check digit and EGS pattern validation (EGS format UNVERIFIED), all-or-nothing CSV import, missing-code flags.
- **Registration wizard**: tax number, ERP registered, secret keys, sandbox test, go-live (each needs the previous). Secrets: AES-256-GCM, key from `TAX_SECRET_KEY`
  (a dev fallback logs a warning); never returned, logged or audited, `tax_secrets` is not in the export list.
- **VAT**: rates table (standard 14% flagged UNVERIFIED), `GET /api/tax/vat/return?from&to` (output 2100, input 1400), `tax_bill_tax` + `POST /api/tax/vat/bills/:id`,
  `bill.approved` hook posts input VAT (Dr 1400, Cr the bill's expense account) only when VAT info exists. Turnover tax ESTIMATE with configurable bands; withholding placeholder.
- **Retention**: each document has `retain_until`; `GET /api/tax/export` returns submitted documents as JSON with chain status.

## Permissions
`tax.view`, `tax.submit` (submit/retry/cancel/notes/sync), `tax.configure` (settings, codes, secrets, wizard, rates), `tax.vat_return` (returns, estimate, bill VAT).
`eta.manage` is unchanged. Widget key: `tax` (queued, due soon <4h, overdue, rejected, last sync).

## Events
Emits `tax.document_created`, `tax.document_status`. Listens to `invoice.created`, `bill.approved` (and `credit_note.created` when defined).

## Limits
No real signing, auth or portal. Cancelling does not reverse the ledger (sales owns invoices): issue a credit note. Invoice lines are matched to items by sku or exact description.
