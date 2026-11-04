# Live ETA adapter (`eta_live`)

**NEVER VERIFIED against the real ETA service.** The ETA pre-production and production endpoints are not reachable from the
build environment, so this adapter has only ever talked to the fake server in `test/etalive.fake.js`. Every endpoint, field name,
status code, header, signing rule and size limit below was written from recollection of the public ETA SDK documentation and is
**UNVERIFIED**. Treat it as a well-tested skeleton to be checked against the official spec and the ETA pre-production portal,
not as a certified integration. The default adapter stays `eta_mock`.

## What it does
- **Adapter selection**: setting `tax_adapter` = `eta_mock` (default), `zatca_mock` or `eta_live` (`PUT /api/tax/settings {adapter}`).
  Each tax document keeps the adapter it was built with.
- **OAuth2 client credentials**: `POST {idUrl}/connect/token` (form: `grant_type`, `client_id`, `client_secret`, `scope`). The token is cached
  in memory (per credentials), refreshed 30 s before expiry on the demo clock, and refreshed once on a 401.
- **Submit**: `POST {apiUrl}/documentsubmissions {documents:[...]}` in batches (`batchSize`, default 10). Accepted and rejected documents are
  matched by `internalId` (the document number). A batch refused as a whole (4xx) is resent one document at a time. A "duplicate" error code is
  treated as "already at ETA" (a lost response on an earlier attempt) and the document is polled instead of resubmitted.
- **Status polling**: `GET {apiUrl}/documents/{uuid}/details`. `Valid` -> valid (long id and share link stored), `Invalid` -> rejected with the validation
  step errors as the reason, `Rejected` (by the buyer) -> rejected `RECEIVER_REJECTED`, `Cancelled` -> cancelled, `Submitted`/unknown -> asked again next sync.
- **Cancel / reject**: `PUT {apiUrl}/documents/state/{uuid}/state {status:'cancelled'|'rejected', reason}`. Cancelling an issued document asks ETA first, then
  runs the normal local cancellation (reason required, window check, audit). `POST /api/tax/live/reject` rejects a document *received* from a supplier.
- **Rate limits and outages**: 429, 502, 503, 504 and network errors are retried up to `maxRetries` (default 4) with `backoffMs * 2^attempt`
  (capped at `maxWaitMs`); a `Retry-After` header (seconds or HTTP date) wins. When retries run out the documents stay `queued`, the reason is
  stored in `tax_live_docs.last_error` and the next sync tries again. Nothing is lost and nothing is double-posted.
- **Canonical serialisation + signing** (`adapters/eta_sign.js`): see the checklist. CMS/CAdES-BES built with a small DER writer using `node:crypto` only,
  verified in tests with the `openssl cms -verify` CLI for RSA and EC keys, attached and detached.
- **Signer interface**: `registerSigner(id, async (ctx) => ({ id, sign: async ({ canonical, now, detached }) => base64Cms }))`. Select it with
  `PUT /api/tax/live/config {signer:'id'}`. A USB-token / HSM integration registers its factory at start-up and can use the exported
  `buildCms({content, certDer, signRaw})`, supplying only the raw signature callback (PKCS#11 `C_Sign` or similar). The built-in `pem` signer reads
  `eta_signing_key_pem`, `eta_signing_cert_pem` and optionally `eta_signing_pin` (key passphrase) from the tax secret store.

## Why it is asynchronous
The adapter interface used by `documents.js` is synchronous and runs inside SQLite transactions, which must never wait for a network call.
So for `eta_live`, `buildDocument` and `qr` are real, while `submit`/`status` only say "unreachable": the document is created `queued` in the invoice's
transaction exactly as before. The network work is done by `liveSync` (`adapters/eta_live_sync.js`), outside any transaction, and applied with the normal
state machine (so hash chain, audit, hooks and states are the same as with the mocks). **Something must call sync regularly**: `POST /api/tax/sync`
(the "Submit and sync now" button) or a cron job calling it. Submission deadlines (`tax_submit_deadline_hours`) still apply.

## Routes and permissions
| Route | Permission |
|---|---|
| `POST /api/tax/sync` (mock part as before, plus `live: {...}` result; a live configuration problem is reported inside `live.error`, it does not fail the call) | `tax.submit` |
| `POST /api/tax/live/sync` live submission and polling only | `tax.submit` |
| `POST /api/tax/documents/:id/cancel`, `/retry` (live documents go through ETA) | `tax.submit` |
| `POST /api/tax/live/reject {uuid, reason}` | `tax.submit` |
| `POST /api/tax/live/test` token request + signer probe; success unlocks the wizard `sandbox_test` step for the live adapter | `tax.configure` |
| `GET/PUT /api/tax/live/config` | `tax.view` / `tax.configure` |
| `GET /api/tax/live/log`, `GET /api/tax/live/documents/:id` | `tax.view` |
| `PUT /api/tax/secrets/:name` with `eta_client_id`, `eta_client_secret`, `eta_signing_key_pem`, `eta_signing_cert_pem`, `eta_signing_pin` | `tax.configure` |

Configuration keys (`PUT /api/tax/live/config`): `idUrl`, `apiUrl` (https only; plain http only for localhost; no embedded credentials), `scope` (default
`InvoicingAPI`), `signer`, `cmsDetached`, `batchSize`, `maxRetries`, `backoffMs`, `maxWaitMs`, `timeoutMs`, `onBehalfOf`, `documentVersion`, `activityCode`.
Changing a URL or the signer clears the "connection tested" flag.

## Secrets
Credentials and the signing key live only in the AES-256-GCM `tax_secrets` store (key from `TAX_SECRET_KEY`; set it, the development fallback is not safe).
They are read server-side at call time, sent only to the configured identity URL (client id/secret) or used locally (signing key), never returned by any route,
never put in audit rows or `tax_live_log`, and passed through a redactor before they could appear in an error text. A test asserts none of them appear in
audit, log, settings, responses, exports or console output. Redirects are refused, so credentials are not forwarded to another host.

## Events, tables, migrations
Same events as the tax module (`tax.document_created`, `tax.document_status`). Migration `520_tax_live`: `tax_live_docs` (long id, share link, last error,
cancel confirmation; exported with the tax data) and `tax_live_log` (op, outcome, code; no bodies, no secrets).

## MUST be checked against the official ETA specification before any real use (all UNVERIFIED)
1. Identity and API host names, paths (`/connect/token`, `/documentsubmissions`, `/documents/{uuid}/details`, `/documents/state/{uuid}/state`), API version prefix, scope name (`InvoicingAPI`), the `onbehalfof` header.
2. Request/response shapes: `acceptedDocuments`/`rejectedDocuments`, error object (`code`, `message`, `details`), status values (`Submitted`, `Valid`, `Invalid`, `Rejected`, `Cancelled`), `longId`, the validation-step structure.
3. Document JSON: field names and nesting (issuer/receiver address block, `documentTypeVersion` value, `taxpayerActivityCode`, line fields, `unitValue.amountEGP`, tax type `T1` and sub-types `V009`/`V001`, `rate` as percent, decimal pounds as JSON numbers, `dateTimeIssued` format, credit-note `references`). Mandatory fields we leave empty (branch id, governorate, city, street, building number, purchase order, payment/delivery) and the receiver rules for individuals vs businesses.
4. Canonical serialisation: upper-casing of names, quoting, the repeated array name, handling of numbers and nulls, and exactly which properties are excluded.
5. Signature: CAdES-BES profile details, attached vs detached content (`cmsDetached`), hash algorithm, signed attributes (we include content type, message digest, signing time, signing-certificate-v2), `signatureType` value `I`, whether the certificate chain must be embedded, RSA vs EC acceptance, and token/HSM specifics (the token's PKCS#11 flow is not implemented, only the interface).
6. Limits and behaviour: batch size and payload size, submission rate limits and the `Retry-After` semantics, duplicate-submission error code and response, how long a document may be cancelled or rejected (the window setting defaults to a placeholder), how a buyer rejection is reported.
7. The QR / share link format (`{shareBase}/documents/{uuid}/share/{longId}`): the stored `qr` on the immutable document row is only the prefix because the long id exists after validation; the full link is in `tax_live_docs.share_url`.
8. E-receipts (point of sale) are NOT covered by this adapter: they keep using the existing mock receipt queue.

## Limits
- No UI of its own (the tax page is owned by another module): configure through the API above. A card for live configuration and the long-id/share link is a follow-up.
- No background scheduler: sync is triggered by a user or an external cron.
- Polling is one request per submitted document (no batch status call); fine for small merchants, revisit for volume.
- No PKCS#11 / USB-token code, only the pluggable interface. No mutual-TLS support.
- Tested only against a fake server and `openssl` CMS verification, never against ETA.
