# Sales module

Customers, quotes, invoices (lifecycle, payments, credit notes, print), quick sale (discounts, parked sales, refunds) and
the item catalogue. Money is integer piastres. All postings go through `postEntry`; corrections are reversals.

## Data
Migrations 800 (customers, sequences, extra columns on `invoices`, `sales`, `items`) and 801 (payments, allocations, credit
notes, quotes, parked sales). Tables: `sales_customers`, `sales_sequences`, `sales_payments`, `sales_payment_allocations`,
`sales_credit_notes`, `sales_quotes`, `sales_parked` (all exported). `invoices.paid` now means *closed* (paid in full or void);
use `invoices.status` (`draft issued partially_paid paid void`) and `amount_paid`/`amount_credited` for logic. Drafts have
`paid = 0` and no ledger entry: readers of receivables should filter on `status IN ('issued','partially_paid')`.

## Permissions
`sales.view`, `sales.create` (existing); `sales.credit` (credit notes, void issued invoice, refund quick sale, override a
credit limit; optional amount limit through roleLimits); `sales.discount` (limit in piastres, clerk 5000); `customers.manage`;
`quotes.manage`; `sales.configure` (catalogue and numbering/print settings, extra atom). Manager has all; clerk has view,
create, discount, customers.manage, quotes.manage; accountant view + credit; auditor view.

## API (all JSON)
- Customers: `GET/POST /api/customers`, `GET/PATCH/DELETE /api/customers/:id`, `GET /api/customers/aging?asOf=`,
  `GET /api/customers/:id/statement?from&to`, `GET /api/customers/:id/reminder?lang=ar|en` (wa.me link, nothing sent).
- Quotes: `GET/POST /api/quotes`, `GET/PATCH /api/quotes/:id`, `POST /:id/status {status}`, `POST /:id/convert`.
- Invoices: `GET/POST /api/invoices` (`draft:true`, `customerId`, `creditOverride:{reason}`), `GET/PATCH /api/invoices/:id`,
  `POST /:id/issue|pay|void|credit-notes`, `GET /:id/print?lang=` (returns `{ html }`: the server only emits JSON, the UI opens it in a window).
- `GET /api/credit-notes[/:id]`, `GET/POST /api/payments` (explicit `allocations` or `customerId` for oldest-first).
- Quick sale: `GET /api/sales`, `POST /api/sales/quick` (`discount:{type:'percent'|'fixed', value}`), parked: `GET/POST /api/sales/parked`,
  `POST /api/sales/parked/:id/checkout`, `DELETE /api/sales/parked/:id`; `POST /api/sales/:id/refund {reason}`.
- Items: `GET/POST /api/items`, `PATCH/DELETE /api/items/:sku`. Settings: `GET/PUT /api/sales/settings`.

## Rules
- Credit limit (0 = none) is checked when an invoice is issued: open balances + new total. Error `CREDIT_LIMIT_EXCEEDED`; `sales.credit` plus a reason overrides, audited.
- Aging buckets by days past due date: current (not late), 1-30, 31-60, 61+, based on today's (demo clock) or `asOf` open balances.
- Credit note: net from lines or `amount`; VAT proportional to the invoice, the final credit takes the exact remainder, total can never exceed the invoice (`CREDIT_EXCEEDS_INVOICE`). Posts Dr 4000, Dr 2100, Cr 1200.
- Reversal in the ledger of a sale, credit note, payment or invoice entry is picked up by a hook that keeps the sales rows in step (and emits `sale.refunded` for sales). Reversing an invoice that has payments/credit notes is refused.
- Payments: cash 1000, bank 1010, wallet 1020 (the latter two only if the banking module created those accounts). No advance payments (`OVERPAYMENT`).
- Numbers come from `sales_sequences` (invoice, quote, credit_note), prefix/padding configurable, never backwards or repeated.

## Events
Unchanged: `sale.created`, `invoice.created`, `invoice.paid` (the latter only when an invoice becomes fully paid).
New: `sale.refunded { sale, items, entryId, originalEntryId, reason, receipt, userId }` and
`credit_note.created { creditNote: {id, number, invoiceId, lines, subtotal, vat, total}, invoice, entryId, voided, userId }`.
Invoice/quote lines accept an optional `sku`.

## Limits
Refund is whole-sale only. A discounted sale queues an ETA receipt whose item prices are list prices while totals are net (MOCK ETA; tax module to refine).
The QR on the printout is a labelled placeholder, not an ETA/ZATCA code. Wa.me phone normalisation assumes Egypt (+20) by default (UNVERIFIED elsewhere; `countryCode` setting).
