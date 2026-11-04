# Accounting PoC

[![test](https://github.com/ahmed192a/accounting-poc/actions/workflows/test.yml/badge.svg)](https://github.com/ahmed192a/accounting-poc/actions/workflows/test.yml)
[![checks](https://github.com/ahmed192a/accounting-poc/actions/workflows/checks.yml/badge.svg)](https://github.com/ahmed192a/accounting-poc/actions/workflows/checks.yml)
[![e2e](https://github.com/ahmed192a/accounting-poc/actions/workflows/e2e.yml/badge.svg)](https://github.com/ahmed192a/accounting-poc/actions/workflows/e2e.yml)

A web accounting application for small businesses and markets (Egypt first, global later), built as a
**proof of concept**. It is not production software: read [SECURITY.md](SECURITY.md) before putting anything real in it.

What it tries to do differently from the incumbents:

- an **append-only, auditable ledger**: the database itself refuses edits and deletes; corrections are reversals with a reason
- **granular roles** (owner, manager, clerk, accountant, auditor, admin/developer) with role-specific home views
- **honest, flat pricing** and a **free, full-fidelity data export** that includes the audit log
- **safe, reversible AI assistance** (suggestions that a person approves)
- **offline-first** and **Arabic/RTL** from the start
- native **Egypt ETA e-invoice / e-receipt** support (currently a labelled mock)

It has zero npm dependencies: Node 22, built-in `node:sqlite`, `node:http`, `node:test` and a vanilla JavaScript UI.

## Quick start

Needs Node 22.13 or newer. No `npm install`.

```
npm start                                # http://localhost:3000, data in memory
PORT=4000 DB_PATH=./data.db npm start    # another port, data kept in a file
npm test                                 # unit and HTTP tests
npm run coverage                         # tests with coverage thresholds
npm run check                            # repository conventions (syntax, no dependencies, secrets, module rules)
npm run openapi                          # writes docs/openapi.json from the route declarations
python3 e2e/run_all.py                   # browser checks (pip install playwright; playwright install chromium)
```

Docker and hosting: see [docs/DEPLOY.md](docs/DEPLOY.md). Free hosting on Render works from `render.yaml`
(sleeps when idle, data resets on restart).

## Feature map by module

Each feature is a folder `src/modules/<name>/` plus `public/modules/<name>.js`; the loader discovers them, so the
list below grows as modules are merged. Per-module details live in `docs/<module>.md` when present.

| Module | What it does |
| --- | --- |
| `core` | Home dashboard, demo users, users and roles, audit search, full export |
| `ledger` | Journal entries, reversal with a reason, period lock (soft/hard), trial balance, reports |
| `sales` | Items, quick sale (POS), invoices, 14% VAT setting |
| `purchases` | Bills with amount limits, auto-approval and no self-approval |
| `eta` | Mock Egypt ETA adapter, e-receipt queue with the 24-hour window and rejection handling (MOCK) |
| other modules | banking, inventory, entities and currency, auth, tax, reports, approvals and assistant are built in parallel branches; see `docs/` once merged |

Live API reference: run `npm run openapi` and open `docs/openapi.json` (generated, not committed; CI uploads it as an artifact).

## Role guide

| Demo user | Role | Sees and does |
| --- | --- | --- |
| Mona | owner | Everything, including all permissions and approvals |
| Karim | manager | Approvals, period lock, ETA connection, reports |
| Sara | clerk | Quick sale and invoices; never sees cash, ledger or audit log |
| Hossam | accountant | Ledger, reversals, reports, bills |
| Laila | auditor | Read-only: ledger, audit log, reports; no write controls |
| Omar | admin / developer | Users and roles, export; sees no financial data |

Roles are bundles of permission atoms (`area.action`); screens and actions follow permissions, never role names.
The owner role shows a separation-of-duties warning because it can create and approve the same bill.

## Demo walkthrough (5 minutes)

1. Open the app as **Sara** (default). Sell two items: the live total includes VAT. Note there is no cash or ledger card.
2. Switch to **Karim**, click "Simulate offline" (the ETA connection goes down).
3. Back as **Sara**, make another sale: it completes and the e-receipt is queued.
4. As anyone, use "Advance clock" five times (30 hours): the queued receipt turns "Overdue" past the 24-hour window.
5. As **Karim**, "Go online"; as **Sara**, "Sync queue now": the receipt is submitted.
6. As **Hossam**, try "Reverse" on a ledger entry with no reason (refused), then with a reason (a mirror entry is posted, the trial balance stays balanced).
7. As **Laila** confirm nothing can be changed; as **Omar** create a role and export everything.
8. Press the language button for Arabic and right-to-left layout.

## Continuous integration

| Workflow | Jobs |
| --- | --- |
| `test` | `npm test` on Node 22 and 24; coverage thresholds with a job summary |
| `checks` | repository checks; OpenAPI generation (artifact); deploy check (server answers 200 on `/healthz`, `/`, `/api/ui-modules`) |
| `e2e` | Playwright: `ui_check.py`, every `*_check.py`, and `smoke_all_modules.py` (all six users, every navigation page); screenshots uploaded on failure |

Dependabot keeps the GitHub Actions versions current. CodeQL is intentionally not enabled (it needs paid features on private repositories).

## Contributing and the ownership model

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short: a feature owns only its own
module folder, UI file, migration number range and tests; shared files (`src/db.js`, `src/server.js`,
`src/permissions.js`, `public/app.js`, `public/style.css`, ...) have named owners and change only through them. New features are added
without editing shared files, so parallel work does not conflict. `.github/CODEOWNERS` is a placeholder to fill in.

## What it does not do yet

- Real authentication, sessions, MFA and tenant isolation (a header names the user); see [SECURITY.md](SECURITY.md)
- The real ETA protocol (signing, authentication, schemas, GS1 validation); the adapter is a mock and its rules must be checked against ETA documentation
- A real offline-first client (local database, operation queue, client IDs)
- Concurrency and scale testing

Money is stored as whole piastres (never floats). Demo-only endpoint `POST /api/dev/advance-clock` moves the clock.

## Layout

```
src/db.js, src/ledger.js, src/permissions.js, src/server.js, src/modules.js   shared core (named owners)
src/migrations/       NNN_name.js schema steps, applied in order (see numbering ranges)
src/modules/<name>/   backend modules (routes, permissions, widgets, seeds)
public/               vanilla JS shell (index.html, app.js, style.css) and public/modules/<name>.js
test/                 node:test files named <module>.<topic>.test.js
e2e/                  Playwright (Python) browser checks, run_all.py runs them all
scripts/              coverage-check.js, check-repo.js, openapi.js, smoke-server.js
docs/                 ARCHITECTURE.md, DEPLOY.md, per-module docs
```
