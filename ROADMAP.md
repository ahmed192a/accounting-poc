# Roadmap and milestones

Live status: [GitHub milestones](https://github.com/ahmed192a/accounting-poc/milestones) and
[issues](https://github.com/ahmed192a/accounting-poc/issues). Releases: [v0.1.0 to v0.4.0](https://github.com/ahmed192a/accounting-poc/releases).

| Milestone | Release | Status | Theme |
| --- | --- | --- | --- |
| M1 Proof of concept | v0.1.0 | done | Append-only ledger, six roles, invoices and bills, mock ETA queue, English/Arabic UI |
| M2 Modular foundation | v0.2.0 | done | Auto-discovered modules and migrations, hook bus, CI, Docker, Render blueprint, tax and e-invoice mock |
| M3 Core accounting | v0.3.0 | done | Banking and reconciliation, inventory with average cost, multi-entity and currency, sales with credit notes, reports, UI shell |
| M4 Control and experience | v0.4.0 | done | Real sign-in with MFA, API keys and webhooks, audit hash chain, approval chains, 3-way match, safe AI suggestions |
| M5 Pilot ready | v0.5.0 | next | See below |

## M5: Pilot ready (next)

Everything below is **not started** and is deliberately outside what a demo can prove.

- Replace the mock ETA adapter with a real one. Needs sandbox credentials, signing material and the current ETA specification.
- PostgreSQL support and real multi-tenancy (design in [docs/tenancy.md](docs/tenancy.md)).
- Offline-first client with a local queue and sync (today the service worker only caches static files).
- Fix the permission-aware fetching noise ([issue](https://github.com/ahmed192a/accounting-poc/issues)).
- Pilot with three real merchants, then triage their complaints.

## Principles that stay fixed

- The ledger is append-only; corrections are reversals with a reason.
- Money is integer piastres; no floating point.
- AI only suggests; a person approves and every action can be undone.
- Anything unverified (tax formats, rates, regulations) is labelled MOCK or UNVERIFIED in code and docs.

See [docs/PLAN.md](docs/PLAN.md) for the per-milestone scope and acceptance notes, and [CHANGELOG.md](CHANGELOG.md) for details.
