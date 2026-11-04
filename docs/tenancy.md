# Multi-tenancy: one SQLite file per tenant

Status: **implemented** (Milestone 5) as the "stronger alternative" of the earlier design note: every company (tenant) gets its
own SQLite database file. There is no `tenant_id` column anywhere; isolation comes from the fact that a request is handed a
`ctx` whose `ctx.db` is the tenant's own database, so no query can reach another company's rows, including through a bug in a module.
`journal_entries.entity_id` is still a legal entity inside one company and has nothing to do with tenants.

It is a proof of concept: see "Limits" before relying on it.

## What was built

| Piece | File |
| --- | --- |
| Tenant manager: registry, provisioning, resolution, backup, export, LRU of open databases | `src/tenants.js` |
| Operator API, permissions | `src/modules/tenants/index.js` |
| Per-request context selection, background jobs per tenant, `TENANTS_DIR` | `src/server.js` |
| Database identity table (`tenant_info`) | `src/migrations/900_tenant_info.js` |
| Companies page (list, create, suspend, export, backup), EN and AR | `public/modules/tenants.js` |
| Tests | `test/tenancy.http.test.js`, `test/tenancy.manager.test.js`; browser check `e2e/tenancy_check.py` |

```
TENANTS_DIR/registry.db        tenants(id, slug, name, status, db_file, is_default, created_at, created_by, suspended_at)
TENANTS_DIR/tenant-<id>.db     one full application database per company (schema, seeds, users, roles, sessions, keys, ledger, audit)
TENANTS_DIR/backups/           <slug>-<timestamp>.db copies written by the backup action
DB_PATH                        the DEFAULT tenant (id 1, slug "default"): the database the process always had
```

### Turning it on
Set `TENANTS_DIR` (optional `TENANT_MAX_OPEN`, default 50). Without `TENANTS_DIR` nothing changes: no manager exists, the
request path is the old one, `/api/tenants` answers `409 TENANCY_DISABLED`. With it but with no second tenant yet, requests also
take the single-tenant fast path (no credential lookups) and the demo `x-user-id` switcher works exactly as before.
In code: `createApp(ctx, { tenants: true | { dir, maxOpen } })` (omit `dir` to keep tenant databases in memory, used by tests).

### How the tenant of a request is found
The tenant is **never** taken from a header, cookie or body field that grants anything. For an authenticated request the server
asks which tenant database actually contains the presented credential:

1. API key (`Authorization: Bearer acck_...` / `x-api-key`): look up `sha256(key)` in `auth_api_keys` of each tenant.
2. Session cookie: look up `sha256(token)` in `auth_sessions` of each tenant.
3. Found: the request runs against that tenant's `ctx`, and the normal auth code then verifies the credential (expiry, revoke, CSRF,
   deactivation, scopes) against that one database only. Not found anywhere: the default tenant handles it and returns its usual 401.

Hits are remembered in a bounded in-memory map (tenant routing hint only; each hit is re-verified against the cached tenant's
table, so a revoked or expired credential is still judged by the database). A tenant whose file is missing, corrupt or carries
the wrong identity is skipped while probing and listed in `manager.broken`, so one damaged company never blocks another's sign-in.

Public routes (`/api/auth/*`): a caller may name a company with `tenant` (body or query). That only selects which database the
credentials are checked against, so it grants nothing: credentials of A named against B give the same `401 INVALID_CREDENTIALS` as
a wrong password. Without a name, `POST /api/auth/login` is routed by e-mail when exactly one company knows it; an e-mail used in
several companies gets `409 TENANT_REQUIRED` listing the slugs; an unknown e-mail falls to the default tenant (ordinary 401).
`accept-invite` and `setup` must name the company once a second company exists (`400 TENANT_REQUIRED`).

### Demo mode and required mode
- Demo mode (`AUTH_REQUIRED` unset): the `x-user-id` identity and the demo passwords exist **only in the default tenant**. Provisioned
  tenants always run with `security.required = true` (set before their seeds, so the auth seed makes inert placeholder users instead
  of demo passwords) and ignore the header.
- Required mode: unchanged; every tenant needs sign-in.

### Provisioning (`POST /api/tenants`)
Input `{ slug, name, ownerEmail, ownerPassword, ownerName? }`. The manager registers the tenant as `provisioning`, creates
`tenant-<id>.db`, applies every migration, syncs the built-in roles, runs every module seed, writes `tenant_info`, and creates the
owner with the password policy of the auth module (via its first-run path; the password is never stored in the registry or logged).
On any failure the registry row and the file are removed (tested). Audit: `tenant.created` in the default tenant's log and
`tenant.provisioned` in the new tenant's log. Existing tenant files are migrated and role-synced the first time they are opened
after an upgrade.

Slugs: 3 to 32 characters, `[a-z][a-z0-9-]*[a-z0-9]`, with a reserved list. File names use the numeric id, never the slug.

### Operator API
The operator is a user of the **default** tenant. A request that resolved to any other tenant gets `403 OPERATOR_ONLY`, so a company
owner can never list, create, suspend or export other companies, even though the permission atoms exist in every tenant's roles.

| Route | Permission | Notes |
| --- | --- | --- |
| `GET /api/tenant` | signed in | Which company am I in; is tenancy on |
| `GET /api/tenants`, `GET /api/tenants/:slug` | `tenants.view` | List; one tenant with user, journal and audit counts and file size |
| `POST /api/tenants` | `tenants.manage` | Provision |
| `POST /api/tenants/:slug/suspend`, `/resume` | `tenants.manage` | Suspended: sign-in and every request get `403 TENANT_SUSPENDED`; data is kept; the default tenant cannot be suspended |
| `GET /api/tenants/:slug/export` | `tenants.export` | The same JSON as `/api/export` for that tenant only; audited in both databases |
| `POST /api/tenants/:slug/backup` | `tenants.export` | `VACUUM INTO TENANTS_DIR/backups/<slug>-<time>.db` (consistent while running); returns path, size, sha256. Never overwrites |

`tenants.view` and `tenants.manage` go to the built-in admin role; `tenants.export` (another company's complete data) is held by the
owner only. No hook events were added.

### Background jobs
Webhook delivery and audit-chain sealing visit every active tenant explicitly (`forEachActive`); one tenant's failure is logged with
its slug and does not stop the others.

### Open databases
File-backed tenant databases are opened on first use and closed least-recently-used beyond `TENANT_MAX_OPEN` when no request is
using them (a lease counter is held until the response is finished). In-memory tenants (tests) are never evicted. Opening runs
pending migrations, so every tenant is upgraded lazily.

## Isolation tests
`test/tenancy.http.test.js` runs two or three tenants with the same primary keys and checks: customers, audit, API keys and
sessions never cross; a user of A cannot sign in to B (named or not), A's session and API key stay in A even with `?tenant=B` or an
`x-tenant` header; the demo header cannot reach a provisioned tenant; operator-only routes; suspend and resume; export holds one
tenant only; backup opens as a standalone database; restart finds the registry again; a file copied into another tenant's slot is
refused (`TENANT_DB_MISMATCH`); the open-database cap; background sealing per tenant; and failed provisioning leaves nothing behind.

## Limits (honest list)
- **Probing cost**: finding a credential's tenant opens and queries tenant databases one by one until it is found (cached afterwards).
  Fine for tens of tenants; for thousands add a persisted `credential hash -> tenant` index maintained by the auth module, or a
  tenant hint in the session cookie (a hint only; the database would still verify it).
- **Single process**: SQLite files and the in-memory caches assume one app server. The per-tenant rate limiter is not implemented:
  the limiter is still per IP or API key, process-wide.
- **Shared secrets**: `TAX_SECRET_KEY` and other environment secrets are one per process, not one per tenant (the per-tenant key
  hierarchy of the original design is NOT built). Backups and exports are not encrypted.
- **Seeds include sample data**: module seeds run unchanged, so a new tenant also gets the six placeholder demo users (inactive, no
  password), sample items and sample customers. A reference-data-only seed split needs each module's agreement.
- **No cross-tenant reporting**, no tenant deletion (suspend only), no tenant rename, no moving a database between servers other
  than copying the file with the registry row.
- **Login form**: the UI sign-in has no "company" field; a shared e-mail shows the server's `TENANT_REQUIRED` message. The API accepts `tenant`.
- **Shared demo clock**: `/api/dev/advance-clock` moves the clock of the tenant the caller is in only.
- `DB_PATH` plus `TENANTS_DIR` means the default tenant and the registry are separate files; back up both.

## PostgreSQL feasibility (not implemented)
Question: how much of the code is SQLite-specific if the same product had to run on PostgreSQL? Counts below come from `grep`
over `src/` at this commit (run them again before planning; they include `src/tenants.js`).

| SQLite-specific thing | Count (grep) | Where | PostgreSQL equivalent / effort |
| --- | --- | --- | --- |
| `node:sqlite` import (`DatabaseSync`) | 2 files (`src/db.js`, `src/tenants.js`) | db layer | One adapter. The real cost is below |
| Synchronous API: `.prepare(...)` | 671 calls in 71 files; `.run/.get/.all` 732 call sites; `ctx.db` 369 | everywhere | PostgreSQL drivers are asynchronous: every service function and handler that touches the database becomes `async`. This is the dominant cost (the whole call graph), not any single SQL feature |
| Hand-rolled transactions `exec('BEGIN'/'COMMIT'/'ROLLBACK')` | 6 | `src/db.js`, `src/ledger.js` (`tx`) | A transaction must pin one pooled connection; `tx()` keyed by `db` handle in a `WeakMap` would key by a client |
| `lastInsertRowid` | 43 | most services | `INSERT ... RETURNING id` |
| `INTEGER PRIMARY KEY` (rowid alias, auto id) | 61 | migrations | `BIGINT GENERATED BY DEFAULT AS IDENTITY` |
| `CREATE TRIGGER ... RAISE(ABORT, 'msg')` (append-only journal, audit, stock movements, tax documents) | 10 triggers, 3 files (`001_core`, `200_inventory`, `500_tax_core`) | migrations | PL/pgSQL function with `RAISE EXCEPTION` plus `CREATE TRIGGER ... EXECUTE FUNCTION`; `BEFORE UPDATE OF cols` is supported. Append-only guarantees survive, but each needs rewriting and re-testing |
| `INSERT OR IGNORE` | 13 in 10 files | seeds, services, `700` migration | `ON CONFLICT DO NOTHING`; note SQLite's `OR IGNORE` also swallows NOT NULL and CHECK failures, PostgreSQL's does not |
| `ON CONFLICT ... DO UPDATE` | 18 | services | Compatible as written |
| `PRAGMA table_info(...)` | 2 (`300`, `800` migrations) | migrations | `information_schema.columns` |
| `sqlite_master` introspection | 5 (`db.js`, `300`, `600`, `800`, `801`) | migrations | `to_regclass()` / `information_schema.tables` |
| `ALTER TABLE ... ADD COLUMN` | 4 | migrations | Compatible (add `IF NOT EXISTS`) |
| `VACUUM INTO` | 1 (`src/tenants.js` backup) | tenancy | `pg_dump` of the tenant schema |
| `substr(...)` for month and year buckets | 3 | reports | Compatible (`substr` exists) |
| `LIKE` (case-insensitive for ASCII in SQLite) | 4 | sales items, inventory, reports | PostgreSQL `LIKE` is case-sensitive: use `ILIKE` |
| `IS NOT ?` | 1 | sessions | `IS DISTINCT FROM` |
| `?` positional placeholders | about 730 statements | everywhere | `$1, $2, ...` (mechanical, but touches every statement) |
| Dynamic typing (a TEXT value in an INTEGER column is accepted) | not countable | all tables | PostgreSQL rejects it; money is `INTEGER` piastres everywhere, so use `BIGINT`, and note `COUNT`/`SUM` return `bigint`/`numeric`, which node drivers return as strings |
| Booleans stored as 0/1, dates as ISO text or epoch milliseconds | all tables | all tables | Works as is, but `BOOLEAN`/`timestamptz` would be the natural types |
| No `AUTOINCREMENT`, no `strftime/datetime`, no `json_*`, no `rowid` use | 0 each | | Nothing to port |

Verdict: SQL dialect differences are small and mostly mechanical (about 25 distinct places in migrations plus 43 `lastInsertRowid`
sites). The expensive part is the **synchronous to asynchronous** change across about 70 files, plus rewriting the 10 immutability
triggers. For tenancy the PostgreSQL analogue of this design is **one schema per tenant** with `SET search_path` chosen per request
(the same `ctx` per request idea), which keeps the no-`tenant_id` property; the single-schema `tenant_id` + row-level security
model from the earlier note would instead touch every query.
