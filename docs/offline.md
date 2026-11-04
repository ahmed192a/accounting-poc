# Offline-first client

Merchants lose connectivity. This feature lets the till keep working: some writes are saved on the device and sent later,
exactly once, and some reads keep working from cache. Everything else needs a connection and says so.

## What works offline (and what does not)

| Works offline | Needs a connection |
| --- | --- |
| The app shell and all cards (service worker cache) | Voids, credit notes, refunds, approvals, payments |
| Reading home figures, items, customers, recent sales, invoices, bills, suppliers **as last seen** (may be out of date) | Fresh reports, e-receipt submission, sign-in, administration |
| Saving a quick sale, an invoice, a bill or a new customer (queued in IndexedDB) | Editing or deleting existing records |

The shell banner and the **Offline** page state this in English and Arabic. Queued writes show as a "N pending" chip in the header.

## How the queue works (`public/offline-queue.js`, wired by `public/modules/offline.js`)

1. `public/app.js` `api()` asks `App.offlineKey(method, path)`; for queueable writes it sends an `Idempotency-Key` (UUID) on the normal online request.
2. If the request cannot reach the server, `App.offlineWrite` stores `{ key, identity, method, path, body, label }` in IndexedDB (`acct-offline`) and returns a
   result shaped like the real one with `queued: true` (quick sale: `sale.total` is an **estimate**, `receipt.status` is `queued`). Because the same key is reused,
   a request whose response was lost but which did reach the server is **not** posted twice on replay.
3. On the `online` event, on load, and on a backoff timer (2s, 4s ... 60s, honours `Retry-After`), `queue.sync()` replays items **in creation order**:
   - 2xx: item removed, home data reloaded.
   - network error, 401, 408, 429, 5xx, 409 `IDEMPOTENCY_IN_PROGRESS`: the run stops, items stay pending (order is preserved).
   - any other 4xx (stock, validation, permission, inactive item ...): item becomes **Not accepted** with the server's code and message; the run continues.
4. A failed item can be **Tried again**, **Edited** (JSON body; a new idempotency key is issued) or **Discarded** (confirmed). Nothing is dropped silently.
5. Items replay only for the identity that queued them (`demo:<userId>`, or `session` when sign-in is required). One sync runs at a time (`navigator.locks` across tabs).
6. At most 200 changes can wait (`QUEUE_FULL`).

Queueable writes: `POST /api/sales/quick`, `/api/invoices`, `/api/bills`, `/api/customers` (see `QUEUEABLE`).

## Service worker (`public/sw.js`)

- Static shell: network first, cache fallback (unchanged), now also pre-caches the UI modules and `/offline-queue.js`.
- Read endpoints `/api/home /items /customers /sales /invoices /bills /suppliers /demo-users /ui-modules`: **stale-while-revalidate** in cache `acct-api-v1`, keyed per `x-user-id`.
  When the background refresh differs from what was just shown, clients get `acct-api-updated` and the header offers "Newer data available. Refresh" (no silent re-render, so a half-filled form is never wiped).
- Any successful non-GET `/api/*` empties the API cache, so a read after a write is never pre-write. A 401/403 on revalidation drops the entry.
- No other API path is cached (auth, admin, exports, ledger are never stored). The worker never queues or replays writes itself.

## Idempotency (`src/idempotency.js`, one call in `src/server.js`)

`Idempotency-Key: <8-128 chars of A-Z a-z 0-9 . _ : ->` on any authenticated non-GET request.

- Key scope is (user, method, route path, key). Request hash = canonical JSON of method, path+query, body.
- First request runs; a **2xx** result is stored with status, body and `sha256` of the body for **24 h** (table `idempotency_keys`, created on first use, expired rows purged at most once a minute).
- Same key and same request: the original status and body are returned with `Idempotency-Replayed: true`; the handler does not run.
- Same key, different request: `422 IDEMPOTENCY_KEY_REUSED`. Same key while the first is still running: `409 IDEMPOTENCY_IN_PROGRESS`. Bad format: `400 BAD_IDEMPOTENCY_KEY`.
- Failures are not stored, so a corrected retry with the same key works. Requests without the header behave exactly as before.

No new permissions, events or env vars. Tests: `test/offline.queue.test.js`, `offline.idempotency.test.js`, `offline.sw.test.js`; browser: `python3 e2e/offline_check.py` (POC_PORT 3201).

## Known limits (honest list)

- The idempotency record is written right after the handler's transaction commits, not inside it: a process crash in that instant could let one retry run twice. Closing it needs the key insert inside the handler transaction (a shared-file change).
- Replay stops at the first transient failure, so one stuck item holds back the ones behind it (deliberate: ordering).
- Offline-created records have no server id, so an invoice for a customer created offline in the same session will be rejected on replay (the customer is replayed first, but the invoice body refers to a name/id the user typed). Review it under "Not accepted" and edit.
- The quick-sale total shown offline is an estimate from cached prices; the server computes the real total (VAT, discount rounding) on replay.
- Cached read data may be stale and is stored in the browser on this device (per demo user id). In sign-in mode the cache is not keyed per user; it is emptied by every successful write (sign-in/out included) and dropped on 401/403, but a shared kiosk should still use a private window.
- Queued items store the request body in IndexedDB unencrypted. Signing out does not delete waiting items; they replay for the `session` identity at next sign-in.
- Server-down while the browser believes it is online is treated like offline (fetch throws); an HTTP 5xx is not queued at submit time (the user sees the error).
- Tested in Chromium (Playwright). Safari/Firefox IndexedDB, service worker and `navigator.locks` behaviour is UNVERIFIED.
