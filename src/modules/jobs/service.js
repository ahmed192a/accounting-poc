import { AppError } from '../../errors.js';
import { tx, audit } from '../../ledger.js';
import { requirePerm } from '../../permissions.js';
import * as q from './queue.js';

const view = (j) => ({ id: j.id, kind: j.kind, status: j.status, runAt: j.run_at, attempts: j.attempts, maxAttempts: j.max_attempts, lastError: j.last_error, uniqueKey: j.unique_key, scheduleId: j.schedule_id, createdAt: j.created_at, finishedAt: j.finished_at });
const count = (db, sql, ...a) => db.prepare(sql).get(...a).n;

export function overview(ctx, user) {
  requirePerm(user, 'jobs.view');
  q.ensureSchedules(ctx);
  const { db } = ctx;
  const by = (table) => Object.fromEntries(db.prepare(`SELECT status, COUNT(*) n FROM ${table} GROUP BY status`).all().map((r) => [r.status, r.n]));
  return {
    now: ctx.now(),
    jobs: by('jobs_queue'),
    outbox: by('jobs_outbox'),
    schedules: db.prepare('SELECT * FROM jobs_schedules ORDER BY id').all().map(q.scheduleView),
    recent: db.prepare('SELECT * FROM jobs_queue ORDER BY id DESC LIMIT 30').all().map(view),
    kinds: [...q.registryOf(ctx).handlers.keys()].sort(),
  };
}

export function listJobs(ctx, user, { status, kind, limit } = {}) {
  requirePerm(user, 'jobs.view');
  return ctx.db.prepare('SELECT * FROM jobs_queue WHERE (? IS NULL OR status = ?) AND (? IS NULL OR kind = ?) ORDER BY id DESC LIMIT ?')
    .all(status ?? null, status ?? null, kind ?? null, kind ?? null, Math.min(Number(limit) || 50, 200)).map(view);
}

export function listOutbox(ctx, user, { status, limit } = {}) {
  requirePerm(user, 'jobs.view');
  return ctx.db.prepare('SELECT id, topic, status, attempts, max_attempts, next_attempt_at, last_error, created_at, delivered_at FROM jobs_outbox WHERE (? IS NULL OR status = ?) ORDER BY id DESC LIMIT ?')
    .all(status ?? null, status ?? null, Math.min(Number(limit) || 50, 200));
}

export function listSchedules(ctx, user) {
  requirePerm(user, 'jobs.view');
  q.ensureSchedules(ctx);
  return ctx.db.prepare('SELECT * FROM jobs_schedules ORDER BY id').all().map(q.scheduleView);
}

export function patchSchedule(ctx, user, id, body = {}) {
  requirePerm(user, 'jobs.manage');
  return q.updateSchedule(ctx, id, body, { userId: user.id });
}

/** Queue one run of a schedule's job right now (does not move the schedule). */
export function runScheduleNow(ctx, user, id) {
  requirePerm(user, 'jobs.manage');
  const s = ctx.db.prepare('SELECT * FROM jobs_schedules WHERE id = ?').get(id);
  if (!s) throw new AppError(404, 'NOT_FOUND', 'Schedule not found');
  return tx(ctx.db, () => {
    const job = q.enqueue(ctx, s.kind, JSON.parse(s.payload), { uniqueKey: `schedule:${s.id}`, scheduleId: s.id });
    audit(ctx, { userId: user.id, action: 'jobs.schedule_run_now', type: 'job_schedule', id, newValue: { jobId: job.id, deduped: job.deduped } });
    return job;
  });
}

/** Run one scheduler pass for THIS company now (the same pass the background loop does). */
export async function runNow(ctx, user) {
  requirePerm(user, 'jobs.manage');
  const r = await q.runDue(ctx);
  audit(ctx, { userId: user.id, action: 'jobs.run_now', type: 'job', newValue: { ran: r.jobs.ran, outbox: r.outbox.attempted } });
  return r;
}

export const retry = (ctx, user, id) => { requirePerm(user, 'jobs.manage'); return q.retryJob(ctx, id, { userId: user.id }); };
export const retryOutboxRow = (ctx, user, id) => { requirePerm(user, 'jobs.manage'); return q.retryOutbox(ctx, id, { userId: user.id }); };

export function widgets(ctx, user) {
  if (!user.permissions.has('jobs.view')) return {};
  const { db } = ctx;
  return { jobs: { pending: count(db, "SELECT COUNT(*) n FROM jobs_queue WHERE status = 'pending'"), dead: count(db, "SELECT COUNT(*) n FROM jobs_queue WHERE status = 'dead'"), outboxPending: count(db, "SELECT COUNT(*) n FROM jobs_outbox WHERE status = 'pending'"), outboxDead: count(db, "SELECT COUNT(*) n FROM jobs_outbox WHERE status = 'dead'") } };
}
