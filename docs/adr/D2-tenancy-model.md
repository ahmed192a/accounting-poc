# D2: Tenancy model

Status: proposed — awaiting owner confirmation

Proposed outcome: **File per company (built); schema-per-tenant if ported**

## Context

The requirements proposed a shared database with a tenant id on every row. Milestone 5 built one database file per company with no `tenant_id` column anywhere; a request is handed a `ctx` whose `ctx.db` is that company's database ([tenancy.md](../tenancy.md)).

## Decision

Keep **one database file per company**, selected per request from the credential presented (never from a header that grants anything). If the product moves to PostgreSQL (D1), the analogue is **one schema per tenant** with `SET search_path` chosen per request, which keeps the no-`tenant_id` property. A single schema with `tenant_id` and row-level security is rejected: it would touch every query.

## Consequences

Positive: no query can reach another company's rows, even through a module bug; per-company backup, export and sandbox are file copies.
Negative: probing cost grows with the number of tenants until a credential-to-tenant index is added; per-tenant key hierarchy and rate limiting are not built.

## References

Design plan 1.3, 5.3. Related: D1.
