# D1: Database through the pilot

Status: proposed — awaiting owner confirmation

Proposed outcome: **SQLite per company**

## Context

The requirements proposed PostgreSQL with a shared database and a tenant id. Building produced Node's built-in SQLite with one database file per company, 671 synchronous `.prepare(...)` calls in 71 files (see [tenancy.md](../tenancy.md)). Design plan 1.3 records this as a decision made by building; 5.3 asks that it be decided with criteria.

## Decision

**Stay on one SQLite file per company through the pilot.** Make it safe to run:

- continuous replication of each file to object storage, plus a monthly restore drill in CI against a real backup (the drill script and CI job are added alongside: `scripts/restore-drill.js`, `.github/workflows/restore-drill.yml`);
- write-ahead logging and a busy timeout set once in `openDb`;
- a load test that states the measured ceiling (companies per process, sales per second).

**Move to PostgreSQL only when one of these is true:** a second application process is required for availability; a customer contract demands it; cross-company analytics are needed in the product; or measured write contention exceeds the stated ceiling. The route then is schema-per-tenant and an async data layer, as analysed in [tenancy.md](../tenancy.md).

Until then keep new code port-friendly: all SQL in service files, no new SQLite-only syntax, `RETURNING` instead of `lastInsertRowid` in new code.

## Consequences

Positive: isolation by construction, instant backup, export and sandbox, no operations burden, and it is what makes the shop box (design plan 4.13) possible.
Negative: a single application process, no cross-tenant reporting, and a large synchronous-to-asynchronous rewrite if PostgreSQL is ever needed.
Needs from the owner: confirmation (design plan section 11, item 4).

## References

Design plan 1.3, 5.3, 11. Related: D2.
