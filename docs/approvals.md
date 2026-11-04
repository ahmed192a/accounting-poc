# Purchases and approvals

Modules: `purchases`, `approvals` (backend `src/modules/*`, UI `public/modules/purchases.js`, `approvals.js`). Migrations 700 (purchases), 710 (approvals), 720 (assist).

## Purchases
- **Suppliers** (`suppliers.manage`): name, Arabic name, tax id (format check only, not verified), payment terms, email, phone. A bill from an unknown supplier name creates a minimal supplier row.
- **Bill status flow**: `draft -> pending_approval -> approved (posted) -> partially_paid -> paid`; `pending_approval -> rejected`; draft / pending / approved-unpaid `-> void` (reversal). Paid or partly paid bills cannot be voided: void the payments first. `approved` means posted with nothing paid.
- **Purchase orders and 3-way match** (basic): PO lines (ordered), `receive` (received), bill lines (billed). Variances: `price` (beyond setting `purchases_match_tolerance_bp`, default 0), `qty_over_ordered`, `qty_over_received` (only once receipts are recorded), `not_on_po`. A variance gives `MATCH_VARIANCE` unless `matchOverrideReason` is sent (stored, status `override`). Rejecting or voiding a bill frees the PO quantity.
- **Attachments**: bytes as BLOBs, default limit 512 KB (setting `purchases_attachment_max_bytes`), max 10 per bill, allow-list PDF, PNG, JPEG, plain text, content sniffed against the declared type. Sent as base64 in JSON.
- **Payments** (`purchases.pay`, amount-limited): Dr 2000, Cr 1000 cash (1010 bank, 1020 wallet if the banking module created them). Explicit allocations or oldest-due-first; partial payments; overpayment refused; void by reversal.
- **Statement** `GET /api/suppliers/:id/statement`, **AP aging** `GET /api/purchases/ap-aging` (buckets by due date; uses current paid amounts, so a past `asOf` is approximate).
- **Recurring bills**: templates (weekly / monthly, month-end clamp); `POST /api/recurring-bills/run` generates due bills on demand (max 12 catch-up per template); they go through the normal approval path.
- Bills may carry `vat` (posted to 1400, created with INSERT OR IGNORE if the tax module has not). Bills under `bill_auto_approve` still auto-post, except source `assist`.

## Approvals engine
- Rules: document type (bill), amount range, category, supplier, priority; ordered steps (role, user or permission), step amount limit, mode sequential or parallel, optional escalation (`escalateAfterHours`, `escalateTo`). Most specific rule wins (priority, then criteria count). The seeded **default rule** is one step "anyone with purchases.approve", the original behaviour.
- Steps are copied into the request, so editing a rule never changes requests in flight.
- **Strict separation of duties**: the creator cannot approve at any step; nobody approves two steps of a request (as themselves or on behalf of someone). Personal `purchases.approve` limit and step limit apply.
- **Delegation** (`approvals.delegate`): date range checked with `ctx.now()`; the delegate acts with the delegator's authority and limits, recorded as `on_behalf_of`. Not transitive. Delegating for others needs `approvals.configure`.
- **Escalation**: `POST /api/approvals/escalations/run` (on demand, idempotent). Steps past their due time let the escalation target approve and notify them.
- Rejection needs a reason, skips the other steps, notifies the creator. Every step is in `approvals_history` and `audit_log`; notifications in `approvals_notifications` (private to each user).
- The ledger entry is posted only when the last step completes, in the same transaction.

## Routes
Bills: `GET/POST /api/bills`, `GET /api/bills/:id`, `POST /api/bills/:id/{submit,approve,reject,void,attachments}`, `GET /api/bills/:id/attachments/:aid`. Suppliers, `/api/purchase-orders` (+ `/:id/receive`, `/:id/cancel`), `/api/supplier-payments` (+ `/:id/void`), `/api/recurring-bills`. Approvals: `/api/approvals`, `/api/approvals/:id/{approve,reject}`, `/api/approval-rules`, `/api/approval-delegations`, `/api/notifications`.

## Permissions
`purchases.view/create/approve/pay`, `suppliers.manage`, `approvals.view/configure/delegate`. Clerk creates, manager approves and pays (limit 20,000 EGP), accountant pays and manages suppliers, auditor views.

## Events
`approvals.requested/completed/rejected`, `purchases.paid` (plus existing `bill.created`, `bill.approved`).

## Limits
Escalation and recurring generation run only when called (no scheduler). Bills are EGP only. Tax id and VAT handling are not validated against any authority (UNVERIFIED).
