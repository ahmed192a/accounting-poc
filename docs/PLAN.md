# Plan and milestone detail

Each milestone ends with a tagged GitHub release. Module documentation lives next to this file.

## M1 Proof of concept (v0.1.0)

Goal: show the idea works with roles that matter to small shops.
Scope: ledger with reversals and period locks; roles and role-specific home screens; quick sale, invoices, bills with limits;
mock ETA e-receipt queue; full export; Arabic and English.
Done when: the browser check walks all six roles. Evidence: first 27 tests.

## M2 Modular foundation (v0.2.0)

Goal: let many people build features in parallel without stepping on each other.
Scope: module contract and migration ranges ([ARCHITECTURE.md](ARCHITECTURE.md)); event hooks; GitHub Actions (tests, checks, e2e);
Docker and Render blueprint; tax module with mock ETA/ZATCA adapters, VAT return and item codes ([tax.md](tax.md)).

## M3 Core accounting (v0.3.0)

Goal: cover the daily accounting jobs of a small trader.
Scope: banking import and reconciliation ([banking.md](banking.md)); inventory with average cost and stocktake
([inventory.md](inventory.md)); multi-entity, multi-currency and chart of accounts ([entities.md](entities.md));
customers, quotes, credit notes, print ([sales.md](sales.md)); statements and dashboards ([reports.md](reports.md));
navigation shell with light/dark themes and installable PWA.

## M4 Control and experience (v0.4.0)

Goal: make it safe to let more than one person use it.
Scope: sign-in, MFA, API keys, signed webhooks, audit hash chain ([security.md](security.md)); configurable approval chains,
purchase orders with 3-way match, suggestion-only assistant ([approvals.md](approvals.md), [assist.md](assist.md)).

## M5 Pilot ready (v0.5.0, in progress)

Built: offline queue, live ETA adapter (unverified), per-company databases. Open items are checked off in [ROADMAP.md](../ROADMAP.md).
Acceptance: three merchants run a real week on it and their top complaints are triaged.

## Known gaps carried forward

- Mock integrations (ETA, ZATCA, FX rates, bank feeds) are not validated against real systems.
- Purchase-order and attachment screens are API-only.
- No e-mail sending; invites and resets are handed over manually.
