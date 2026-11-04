# Tenant isolation: design proposal (NOT implemented)

Goal: one deployment serves many companies (tenants) with no way for one to read or change another's data, including
through bugs in a single module. Today the app is single-tenant; `journal_entries.entity_id` is a legal entity inside one
company, not a tenant.

## Model
- `tenants(id, name, status, created_at)`; every business table gets `tenant_id INTEGER NOT NULL` (part of every unique key
  and index: `UNIQUE(tenant_id, code)`). `users` belong to one tenant (`users.tenant_id`); a person in two companies has two
  user rows (or a `memberships(user_id, tenant_id, role_id)` table, preferred once multi-company staff such as accountants
  exist). Roles are per tenant; built-in role templates are copied into each tenant at creation.
- Identity carries the tenant: session rows, API keys and webhooks store `tenant_id`; `loadUser` returns `user.tenantId`.
  The tenant is never taken from the request body or a header the client controls.

## Row-level checks (defence in depth)
1. One data-access layer: `ctx.forTenant(user)` returns a handle whose prepared statements always append
   `AND tenant_id = ?` and whose inserts set it. Modules stop using `ctx.db` directly (lint rule: grep for `ctx.db.prepare`
   outside `src/tenancy/`).
2. SQLite has no RLS, so add triggers on every tenant table: `BEFORE INSERT/UPDATE` reject a row whose `tenant_id` differs from
   `(SELECT value FROM temp.current_tenant)`, which the request sets at its start. Cheap, catches module bugs.
3. Foreign keys include the tenant (`FOREIGN KEY (tenant_id, entry_id) REFERENCES journal_entries(tenant_id, id)`), so a
   line cannot point into another tenant's entry.
4. A test-suite fixture creates two tenants and runs every route as tenant A against ids of tenant B, expecting 404.
5. The hash chain, period lock, number sequences, settings and exports become per tenant (chain per tenant keeps verification
   cheap and exports self-contained).

## Per-tenant keys
- Key hierarchy: a master key (env or KMS) wraps a per-tenant data key (AES-256-GCM, stored wrapped in `tenant_keys`).
  Webhook secrets, MFA secrets and later sensitive fields (bank details, ETA credentials) are encrypted with the tenant key.
- Audit chain and API-key hashing use per-tenant HMAC keys; revoking a tenant means destroying its data key (crypto-shred).
- Rotation: new key version column, lazy re-encryption on read, background job for the rest.

## Rollout
1. Add `tenant_id` with default 1 and backfill (single tenant keeps working; migration per module range).
2. Introduce `ctx.forTenant` and move modules one at a time; keep `tenant_id` triggers permissive until done.
3. Turn on the trigger check and the two-tenant test fixture, then onboard a second tenant.
4. Per-tenant keys and per-tenant rate limits last. Consider one SQLite file per tenant as a stronger alternative: hard
   isolation and easy per-tenant backup and export, at the cost of cross-tenant reporting and connection management.

## Risks
Shared caches and the in-memory rate limiter must key by tenant; background jobs (webhook delivery, sealing) must iterate
tenants explicitly; the demo `x-user-id` identity must stay single-tenant only.
