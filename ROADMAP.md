# Roadmap and milestones

Live status: [GitHub milestones](https://github.com/ahmed192a/accounting-poc/milestones) and
[issues](https://github.com/ahmed192a/accounting-poc/issues). Releases: [v0.1.0 to v0.4.0](https://github.com/ahmed192a/accounting-poc/releases).

| Milestone | Release | Status | Theme |
| --- | --- | --- | --- |
| M1 Proof of concept | v0.1.0 | done | Append-only ledger, six roles, invoices and bills, mock ETA queue, English/Arabic UI |
| M2 Modular foundation | v0.2.0 | done | Auto-discovered modules and migrations, hook bus, CI, Docker, Render blueprint, tax and e-invoice mock |
| M3 Core accounting | v0.3.0 | done | Banking and reconciliation, inventory with average cost, multi-entity and currency, sales with credit notes, reports, UI shell |
| M4 Control and experience | v0.4.0 | done | Real sign-in with MFA, API keys and webhooks, audit hash chain, approval chains, 3-way match, safe AI suggestions |
| M5 Pilot ready | v0.5.0 | in progress | Offline client, live ETA adapter and per-company databases are built; real ETA testing, Postgres and the pilot remain |

## M5: Pilot ready (in progress)

Built and merged through pull requests:

- [x] Offline-first client with an exactly-once sync queue ([docs/offline.md](docs/offline.md)).
- [x] Live ETA adapter with OAuth, signing, submit and poll, tested only against a fake server ([docs/eta-live.md](docs/eta-live.md)).
- [x] Multi-tenancy with one SQLite file per company ([docs/tenancy.md](docs/tenancy.md)).
- [x] Permission-aware loading (no more 403 noise when switching users).

Still open:

- [ ] Run the live ETA adapter against the real ETA preprod (needs credentials and the current spec) and fix what differs.
- [ ] PostgreSQL port. Feasibility and counts are in [docs/tenancy.md](docs/tenancy.md); the main cost is making every database call async.
- [x] A scheduler for ETA sync, escalation and recurring bills ([docs/jobs.md](docs/jobs.md)).
- [ ] A UI card for the live ETA settings and one for background jobs.
- [ ] Per-tenant encryption keys, tenant deletion, and splitting demo seeds from reference seeds.
- [ ] Pilot with three real merchants, then triage their complaints.

## Principles that stay fixed

- The ledger is append-only; corrections are reversals with a reason.
- Money is integer piastres; no floating point.
- AI only suggests; a person approves and every action can be undone.
- Anything unverified (tax formats, rates, regulations) is labelled MOCK or UNVERIFIED in code and docs.

## After M5

The review, the innovation bets and the design for milestones M6 to M9 are in
[docs/DESIGN_PLAN.md](docs/DESIGN_PLAN.md). It is a proposal until the owner confirms the direction.

See [docs/PLAN.md](docs/PLAN.md) for the per-milestone scope and acceptance notes, and [CHANGELOG.md](CHANGELOG.md) for details.
