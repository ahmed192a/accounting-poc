# Accounting app proof of concept

A small, dependency-free proof of concept for the riskiest ideas in the requirements plan. It is a
demo, not a product: identity is a user switcher, the ETA is a mock, and data lives in memory.

## Run it

Needs Node 22.13 or newer. No `npm install` (it uses Node's built-in SQLite).

```
npm start          # http://localhost:3000
npm test           # 27 tests
PORT=4000 DB_PATH=./data.db npm start   # optional: another port, data kept in a file
```

Open the app, then use the "Signed in as" box to switch between the six demo users.

## Host it free

GitHub Pages cannot run this (it needs a Node server), so use Render's free tier:

1. Sign in at https://render.com with your GitHub account.
2. New + > Blueprint > pick this repository. Render reads `render.yaml` and deploys.
3. Open the URL Render gives you. Free instances sleep when idle, so the first load can take a minute,
   and data resets on restart. Health check: `/healthz`.

Tests also run on every push through GitHub Actions (`.github/workflows/test.yml`).

## What it proves

| Idea from the plan | Where | How to see it |
| --- | --- | --- |
| Append-only double-entry ledger; corrections are reversals with a reason | `src/ledger.js`, `src/db.js` | Sign in as Hossam (accountant), try Reverse with and without a reason |
| The database itself refuses edits and deletes of the journal and audit log | triggers in `src/db.js` | `test/ledger.test.js` |
| Period lock: soft (warn, then reason) and hard (block) | `src/ledger.js` | Sign in as Karim (manager), set a lock, then post |
| Roles are bundles of permission atoms, so views and actions follow permissions, not role names | `src/permissions.js`, `home()` in `src/services.js` | Sign in as each user; compare home views. As Omar (admin) create a role and assign it |
| Sensitive areas are separate grants (payroll, bank balances) | `src/permissions.js` | Sara (clerk) never sees cash; Omar (admin) sees no financial data |
| Amount limits, auto-approval, and no self-approval | `createBill`, `approveBill` | Sara creates a bill over 1,000 EGP; Karim approves it |
| Separation-of-duties warnings when a role holds conflicting permissions | `sodConflicts` | The owner role shows a warning in the admin view |
| Offline e-receipt queue with a 24-hour window and rejection handling | `src/eta.js` | Karim: "Simulate offline". Sara: make a sale. Footer: advance the clock |
| Full-fidelity export including the audit log | `exportAll` | Omar: "Export everything" |
| Arabic RTL and English | `public/index.html` | Language button |
| Multi-entity and multi-currency fields present from day one | `entity_id`, `currency` columns | `src/db.js` |

## What it does not do (yet)

- Real authentication, sessions, MFA, per-tenant isolation (a header names the user)
- The real ETA protocol: signing, authentication, schemas, GS1 validation. `src/eta.js` is a mock behind
  a small adapter interface; the 24-hour window and rejection rules come from the research notes and
  must be checked against ETA documentation
- Bank and wallet statement import, inventory, reports beyond the trial balance and profit and loss
- Invoices are not sent to the ETA (only POS receipts are); VAT is a flat 14% setting, not per-item rates
- Offline in the browser: the "offline" here is the connection between the server and the mock ETA.
  A real offline-first client (local database, operation queue, client IDs) is the next big piece
- Concurrency and scale testing

## Layout

```
src/db.js           schema, append-only triggers
src/ledger.js       posting, reversal, period lock, reports
src/permissions.js  permission atoms, built-in roles, separation-of-duties rules
src/eta.js          mock ETA adapter and receipt queue
src/services.js     business operations and role-based home views
src/server.js       HTTP API and static page
public/index.html   the web UI
test/               27 tests (node:test)
```

Money is stored as whole piastres (never floats). Demo-only endpoint `POST /api/dev/advance-clock`
moves the clock so you can see the 24-hour deadline without waiting.
