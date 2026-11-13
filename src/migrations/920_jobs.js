// Jobs kernel: a per-company job queue, recurring schedules and a transactional outbox (docs/jobs.md).
// Lives in every company database, so jobs never cross tenants. Times are epoch milliseconds from ctx.now().
export const id = '920_jobs';

export function up(db) {
  db.exec(`
    CREATE TABLE jobs_queue (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','dead')),
      run_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      locked_until INTEGER,
      last_error TEXT,
      result TEXT,
      unique_key TEXT,
      schedule_id INTEGER,
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX jobs_queue_due ON jobs_queue (status, run_at);
    -- at most one live (pending or running) job per unique key; finished jobs free the key
    CREATE UNIQUE INDEX jobs_queue_unique_live ON jobs_queue (unique_key) WHERE unique_key IS NOT NULL AND status IN ('pending','running');

    CREATE TABLE jobs_schedules (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      every_ms INTEGER CHECK (every_ms IS NULL OR every_ms >= 1000),
      cron TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      next_run_at INTEGER NOT NULL,
      last_run_at INTEGER,
      last_job_id INTEGER,
      source TEXT NOT NULL DEFAULT 'module',
      created_at INTEGER NOT NULL,
      CHECK ((every_ms IS NOT NULL AND cron IS NULL) OR (every_ms IS NULL AND cron IS NOT NULL))
    );

    CREATE TABLE jobs_outbox (
      id INTEGER PRIMARY KEY,
      topic TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','dead')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 8,
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT,
      unique_key TEXT UNIQUE,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER
    );
    CREATE INDEX jobs_outbox_due ON jobs_outbox (status, next_attempt_at);
  `);
}
