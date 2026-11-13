# Documents

Module `documents` (backend `src/modules/documents`, UI `public/modules/documents.js`, migration `960_documents`, tests `test/documents.store.test.js`).
A per-tenant store for attachments and source files, linked to bills, purchase orders and invoices. Each tenant has its own
database file (see [tenancy.md](tenancy.md)), so documents are isolated by construction.

## Data
- `documents_files`: metadata (kind `attachment` or `source`, filename, mime, size, `sha256`, status `active|removed`, who and when).
- `documents_blobs`: the bytes, one row per document. Kept apart so `GET /api/export` carries the metadata and hashes without megabytes of blobs
  (a SQLite file backup or a tenant export has the bytes). Removing a document deletes its blob and keeps the metadata, hash and audit row.
- `documents_links`: document to `bill`, `purchase_order` or `invoice` (one document may link to several records).
- `documents_edoc_status`: the "has valid e-document" flag (see below).

## Limits
Default 512 KB per file (setting `documents_max_bytes`, hard ceiling 700 KB so base64 fits the 1 MB request body), 10 active documents per record,
allow-list PDF, PNG, JPEG, WebP, text, CSV, JSON, XML. Content is sniffed against the declared type (a "PDF" must start with `%PDF-`, JSON must parse).
The same file (same hash) cannot be attached twice to one record. The browser shrinks photos to fit before upload.

## API (all permission-gated, all with `meta.summary`; see `GET /api/openapi` / `npm run openapi`)
| Route | Permission |
| --- | --- |
| `GET /api/documents?entityType&entityId` (list), `GET /api/documents/:id`, `GET /api/documents/:id/content` (base64, hash re-checked), `GET /api/documents/limits` | `documents.view` |
| `POST /api/documents` (upload and link), `POST /api/documents/:id/link` | `documents.upload` |
| `POST /api/documents/:id/remove` (reason required, audited) | `documents.manage` |
| `GET /api/documents/edoc`, `POST /api/documents/edoc` | `documents.view`, `documents.upload` |

Grants: manager all three, clerk and accountant view and upload, auditor view. Home widget `documents` (count and bytes).

## The existing attachment API keeps working
`POST /api/bills/:id/attachments` and `GET /api/bills/:id/attachments/:aid` (purchases module) are unchanged and still write `purchases_attachments`.
Migration 960 copies the existing rows into the store (`legacy_id` keeps it idempotent) and every documents read or write first copies any
newer legacy rows, so a file uploaded through the old route shows up on the new screens. Limits: the old route has its own setting
(`purchases_attachment_max_bytes`). Known gap: removing a document here does not remove the legacy copy, which the old route can still serve.
Plan: switch purchases to write through `documents` and retire the old table (needs the purchases owner).

## Has valid e-document: yes / no / unknown (rule UNVERIFIED)
Bills (the expense record in this app; there is no separate expenses table) and invoices carry a flag that defaults to `unknown`. A person sets it
with an optional note; every change is audited. **UNVERIFIED**: whether an expense needs a valid e-invoice or e-receipt to be accepted for tax, and what
counts as valid, is not confirmed with the ETA or counsel (see [DESIGN_PLAN.md](DESIGN_PLAN.md) section 2). Nothing validates the document: the flag is a
manual note, and the API and the screens repeat that label. A later compliance check can read it.

## Screens (page Purchases)
- **Documents card**: choose a bill or purchase order, see its files, download, upload (file picker, "source file" type for e-invoice JSON or XML),
  take a photo, remove (needs `documents.manage`), set the e-document flag on bills. Write controls show only with the permission.
- **Receipt photo card** (under New bill): take a photo and choose the e-document flag before creating the bill; both are attached when the bill is saved
  (`purchases.js` fires the `purchases:bill-created` event and waits for the listeners). Offline, the bill is queued without an id, so the photo is kept and
  attached from the Documents card after the bill syncs. Files themselves are not queued offline (limit of this version).
- **Camera**: `<input type="file" accept="image/*" capture="environment">` opens the rear camera on phones; where the browser ignores `capture` (desktop) the
  "Use the camera on this device" button opens a `getUserMedia` preview with a Snap button. getUserMedia needs HTTPS or localhost. Not tested on real devices (UNVERIFIED).
- No OCR: the photo is stored, not read.

## Tests
`test/documents.store.test.js` (store rules, permissions, legacy sync, migration backfill, HTTP) and `e2e/documents_check.py` (photo on bill entry, upload,
e-document flag, read-only role; picked up by `e2e/run_all.py`). The page CSP allows `img-src 'self' data:`, so previews are data URLs and downloads use an anchor.
