# Simple mode (public/simple/)

A second face for owners and clerks (DESIGN_PLAN 3.3 and 4.1): no accounting words, same API, same books. Open `/simple/`.
Zero dependencies, no build step. Full mode links to it from the header (`public/modules/simple-mode.js`).

| Screen | What it does | Endpoints used |
| --- | --- | --- |
| Today | Sold today, drawer, owed to me with the three longest-waiting names, compliance light | `/api/home`, `/api/invoices`, `/api/customers/aging` |
| Sell | Item grid, search, quantity stepper, camera or typed barcode, cash / wallet / on credit, share receipt | `/api/items`, `/api/sales/quick`, `/api/invoices`, `/api/payments`, `/api/customers`, `/api/inventory/barcode/:code` |
| Owed | Sorted by days late, WhatsApp reminder, partial payment (oldest invoice first) | `/api/customers/aging`, `/api/customers/:id/reminder`, `/api/payments` |
| Words | Arabic/English shop-word glossary, right-to-left | none (`public/simple/glossary.js`) |

No new API. Every posting goes through the existing sales services, so reports in full mode match.

How the three payment choices post:
- **Cash**: `POST /api/sales/quick` (Dr 1000 Cash). Offline, the sale is saved in the same IndexedDB queue as full mode (`/offline-queue.js`) and replayed with its idempotency key.
- **On credit**: `POST /api/invoices` for the chosen customer (Dr 1200 Receivables).
- **Wallet**: an invoice for a customer named `Walk-in`, then `POST /api/payments` with method `wallet` (Dr 1020). Two requests, not one transaction: if the second fails the sale stays owed by Walk-in and the screen says so.

## Mode setting
`ui.mode = simple | full` is kept per user **in this browser** (`localStorage`, key `acct.ui.mode.<userId>`). The simple shell sets it to
`simple`; its "Full mode" link sets `full`. UNVERIFIED limitation: it does not follow the user to another device. A server-side
user setting is a small API addition left for later. In the demo, full mode starts as user 3 while simple mode starts as the owner,
so the redirect only matches when both use the same demo user.

## Honest limits
- Compliance light is a labelled placeholder: the autopilot (4.2) does not exist yet.
- "Sold today" adds today's quick sales to today's issued invoices using the browser's UTC date; it will not match the server while the demo clock is advanced.
- Drawer shows the cash account (1000) only and only to roles with `banking.view`. No wallet balance.
- The estimated total uses the VAT rate from `/api/home`; the server's figure on the receipt is the real one. The receipt is a convenience copy, the e-receipt is a MOCK.
- Camera scanning needs `BarcodeDetector` (Chromium based browsers; not everywhere). Typing a code always works. The Permissions-Policy header now allows the camera for this origin (`camera=(self)`, was `camera=()`).
- Arabic wording is a draft: UNVERIFIED until a native speaker reviews it.
- The performance budget (first interaction under 1 s, sale submit under 300 ms on a throttled mid-range phone) is NOT measured in CI yet; the e2e only prints an unthrottled localhost timing.
- Not built: "I bought" and "I paid" verbs, cash guardian (4.7), close the day.

Tests: `test/simple.logic.test.js` (pure logic, glossary) and `e2e/simple_check.py` (cash, credit and wallet sales, partial payment, reminder, share and print, camera and typed barcode, offline replay, Arabic RTL, mode redirect, clerk view).
