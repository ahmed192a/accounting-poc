# Jobs, schedules and the outbox

The `jobs` kernel module (`src/modules/jobs/`, migration `920_jobs`, range 920-939) runs background work reliably, **inside each
company's own database**. It answers design plan sections 5.4 and 8.2 (`feat/jobs-scheduler`). Zero dependencies.

## Pieces

| Piece | Table | What it is |
| --- | --- | --- |
| Queue | `jobs_queue` | One row per unit of work: `kind`, JSON `payload`, `run_at`, `attempts`, `status` (`pending`, `running`, `done`, `dead`), `locked_until`, `last_error`, optional `unique_key`. |
| Schedules | `jobs_schedules` | Recurring definitions: an interval (`every_ms`, at least 1000) **or** a 5-field `cron` in UTC. A due schedule queues one job. |
| Outbox | `jobs_outbox` | External effects written in the same transaction as the books, delivered later, at least once. |

All time comes from `ctx.now()` (so the demo clock `ctx.offsetMs` and `POST /api/dev/advance-clock` drive it). Every function also
accepts `{ now }` (a number or a function) to override the clock for one call, which is how tests advance time without sleeping.

## How a module plugs in

Three optional keys on the module object (read from `ctx.registry.modules`, so no shared loader file changed):

```js
export default {
  name: 'tax',
  jobs: { 'eta.sync': async (ctx, payload, job) => result },          // kind -> handler (sync or async)
  schedules: [{ name: 'eta.sync', kind: 'eta.sync', everyMs: 5 * 60_000 }],   // or cron: '5 * * * *'
  outbox: { 'my.topic': async (ctx, payload, row) => {} },            // topic -> consumer
};
```

- A kind may be declared by one module only (a clash throws when the registry is first used). Schedule names are unique per company.
- Handlers run **outside** any transaction (they may be async) and call the same service functions the HTTP routes call, as
  `systemActor(ctx)`: the first active owner of that company. Permissions, limits, approvals and the audit log therefore behave as for a person.
  Ledger writes still go only through `postEntry` / `reverseEntry`, and money stays integer piastres; the kernel never touches either.
- A handler may return `{ rerunAt: epochMs }` to put itself back in the queue (not counted as a failure). Webhook delivery uses this to wake at its backoff time.

## Reliability rules

- **Lease.** A job is claimed with `locked_until = now + 5 min`. A process that dies mid-job leaves an expired lease, and the job is re-run (at-least-once, so handlers must be idempotent; all four built-in ones are).
- **Retry.** A thrown error re-queues the job with backoff `30 s * 2^(attempts-1)`, capped at 1 h. After `max_attempts` (default 5) it is `dead` and stays visible. A job with no registered handler goes `dead` immediately. Dead jobs and outbox rows can be retried by hand.
- **Unique key.** `enqueue(..., { uniqueKey })` returns the live job instead of adding a second one. The key is freed when the job finishes. Each schedule uses `schedule:<id>`, so a slow run is never doubled up.
- **No catch-up burst.** After a long pause a schedule fires once and moves to its next slot; handlers that need catch-up (recurring bills) do it themselves.
- **Outbox.** `enqueueOutbox(ctx, topic, payload, { uniqueKey })` must be called inside the transaction that changes the books; a rollback removes the row. Delivery is at-least-once with the same backoff (8 attempts); a consumer must use the row `id` as its idempotency key towards the outside.
- **Cleanup.** Schedule `jobs.cleanup` (daily 03:17 UTC) deletes finished jobs and delivered outbox rows older than 14 days. Dead rows are kept.

## Per company

Each company has its own `jobs_*` tables, schedules and handlers' data. A pass is `runDue(ctx)`: ensure schedules exist, queue due schedules, run due jobs
(up to 20), deliver due outbox rows (up to 50). `runDueEverywhere(ctx, tenants)` calls it for every active company through
`tenants.forEachActive` (suspended companies are skipped), never mixing databases. The server's background tick (`createApp`, every
`webhook.intervalMs`, default 30 s, unref'd) does audit sealing and `runDue` per company. `runBackgroundJobs()` on the server runs one pass on demand.
Schedules are created in each database the first time a pass runs there and are never overwritten afterwards, so edits survive restarts.

## What runs on it

| Kind | Module | Schedule | Replaces |
| --- | --- | --- | --- |
| `webhooks.deliver` | `auth` | every 30 s, plus a wake-up job when a delivery row is added or retried | the direct `processDeliveries` call in the server tick |
| `approvals.escalate` | `approvals` | every 15 min | pressing "Run escalations" (the button and route still work) |
| `purchases.recurring` | `purchases` | hourly at :05 | pressing "Generate due recurring bills" (route kept) |
| `eta.sync` | `tax` | every 5 min | `POST /api/tax/sync` (route kept): MOCK documents, e-receipt queue, then the live adapter; a missing live setup is recorded, not retried. Live ETA behaviour stays UNVERIFIED |
| `jobs.cleanup` | `jobs` | daily 03:17 UTC | new |

Webhooks keep `auth_webhook_deliveries` as their own outbox (one row per endpoint with its own retry state and the delivery log the UI shows); the generic `jobs_outbox` is for new consumers such as the compliance digest and ETA submission described in the design plan.
Moving ETA submission itself behind the outbox is not done yet.

## API

All routes have `meta.summary` and a permission. `jobs.view`: owner, admin, manager, auditor. `jobs.manage`: owner, admin.

| Route | Permission | Purpose |
| --- | --- | --- |
| `GET /api/jobs` | `jobs.view` | counts, schedules, recent jobs, known kinds |
| `GET /api/jobs/list?status=&kind=&limit=` | `jobs.view` | jobs |
| `GET /api/jobs/schedules` | `jobs.view` | schedules |
| `PATCH /api/jobs/schedules/:id` | `jobs.manage` | `{ active, everyMs }` or `{ cron }` (audited) |
| `POST /api/jobs/schedules/:id/run` | `jobs.manage` | queue one run now |
| `POST /api/jobs/run` | `jobs.manage` | one pass for this company now |
| `POST /api/jobs/:id/retry` | `jobs.manage` | retry a dead job |
| `GET /api/jobs/outbox` | `jobs.view` | outbox rows |
| `POST /api/jobs/outbox/:id/retry` | `jobs.manage` | retry a dead outbox row |

The home payload gets a `jobs` widget (pending and dead counts); there is no UI card yet.

## Cron subset

`minute hour day-of-month month day-of-week`, UTC. Each field accepts `*`, `n`, `a-b`, `*/n`, `a-b/n` and comma lists; day-of-week 0-7 (0 and 7 are Sunday). When both day fields are restricted, either may match (classic cron). No names (`MON`) and no `@daily` shortcuts.

## Limits

- One process drives the loop. Several processes on one SQLite file are safe against double runs (the claim is one atomic `UPDATE`), but there is no leader election or cross-host lease; PostgreSQL would need `SKIP LOCKED`.
- Handlers share the event loop; a long synchronous handler delays HTTP. Keep them short or async.
- The scheduler acts as the company's first owner; there is no dedicated service account yet.
