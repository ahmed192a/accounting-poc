import { AppError } from '../../errors.js';
import { tx, audit } from '../../ledger.js';
import { loadUser } from '../../permissions.js';
import { parseCron, nextCron } from './cron.js';

// Job queue, schedules and outbox. Everything here works on ONE company database (ctx.db) and reads time only from
// ctx.now() (or an injected `now`), so tests and the demo clock drive it. See docs/jobs.md.

export const LEASE_MS = 5 * 60_000;       // a running job not finished in this time is considered crashed and may be re-run
export const BACKOFF = { baseMs: 30_000, maxMs: 60 * 60_000 };
const json = (v) => JSON.stringify(v ?? {});
const clip = (s) => String(s ?? '').slice(0, 500);
export const backoffMs = (attempts) => Math.min(BACKOFF.baseMs * 2 ** Math.max(0, attempts - 1), BACKOFF.maxMs);
const clock = (ctx, now) => (typeof now === 'function' ? now() : Number.isFinite(now) ? now : ctx.now());

/** Handlers and schedules come from the modules: `jobs: { kind: fn(ctx, payload, job) }`, `schedules: [...]`, `outbox: { topic: fn }`. */
const cache = new WeakMap();
export function registryOf(ctx) {
  const reg = ctx.registry;
  if (reg && cache.has(reg)) return cache.get(reg);
  const out = { handlers: new Map(), consumers: new Map(), schedules: [] };
  for (const m of reg?.modules ?? []) {
    for (const [kind, fn] of Object.entries(m.jobs ?? {})) {
      if (typeof fn !== 'function') throw new Error(`Module ${m.name}: job "${kind}" must be a function`);
      if (out.handlers.has(kind)) throw new Error(`Job kind "${kind}" is declared by more than one module`);
      out.handlers.set(kind, fn);
    }
    for (const [topic, fn] of Object.entries(m.outbox ?? {})) {
      if (typeof fn !== 'function') throw new Error(`Module ${m.name}: outbox consumer "${topic}" must be a function`);
      if (out.consumers.has(topic)) throw new Error(`Outbox topic "${topic}" is consumed by more than one module`);
      out.consumers.set(topic, fn);
    }
    for (const s of m.schedules ?? []) out.schedules.push({ ...s, module: m.name });
  }
  if (reg) cache.set(reg, out);
  return out;
}

/**
 * The identity scheduled work runs as: the first active owner of this company. Handlers use it to call the same service
 * functions the HTTP routes call, so permission checks, limits and audit rows behave exactly as for a person.
 */
export function systemActor(ctx) {
  const row = ctx.db.prepare(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
    WHERE r.name = 'owner' AND NOT EXISTS (SELECT 1 FROM auth_credentials c WHERE c.user_id = u.id AND c.active = 0) ORDER BY u.id LIMIT 1`).get();
  if (!row) throw new AppError(409, 'NO_SYSTEM_ACTOR', 'This company has no active owner to run scheduled work as');
  return loadUser(ctx, row.id);
}

// ---- queue ----

/** Add a job. With uniqueKey, a live (pending or running) job with the same key is returned instead of adding another. */
export function enqueue(ctx, kind, payload = {}, { runAt, uniqueKey = null, maxAttempts = 5, scheduleId = null, now } = {}) {
  if (typeof kind !== 'string' || !kind) throw new AppError(400, 'BAD_INPUT', 'kind is required');
  const t = clock(ctx, now);
  const { db } = ctx;
  if (uniqueKey != null) {
    const live = db.prepare("SELECT id FROM jobs_queue WHERE unique_key = ? AND status IN ('pending','running')").get(uniqueKey);
    if (live) return { id: live.id, deduped: true };
  }
  const id = Number(db.prepare('INSERT INTO jobs_queue (kind, payload, run_at, max_attempts, unique_key, schedule_id, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(kind, json(payload), runAt ?? t, maxAttempts, uniqueKey, scheduleId, t).lastInsertRowid);
  return { id, deduped: false };
}

function claim(ctx, t, limit) {
  const { db } = ctx;
  const ids = db.prepare("SELECT id FROM jobs_queue WHERE (status = 'pending' AND run_at <= ?) OR (status = 'running' AND locked_until <= ?) ORDER BY run_at, id LIMIT ?").all(t, t, limit);
  const out = [];
  for (const { id } of ids) {
    const r = db.prepare("UPDATE jobs_queue SET status = 'running', locked_until = ?, attempts = attempts + 1 WHERE id = ? AND ((status = 'pending' AND run_at <= ?) OR (status = 'running' AND locked_until <= ?))")
      .run(t + LEASE_MS, id, t, t);
    if (r.changes) out.push(db.prepare('SELECT * FROM jobs_queue WHERE id = ?').get(id));
  }
  return out;
}

/** Run due jobs, oldest first. A handler may return { rerunAt } to put itself back in the queue (not counted as a failure). */
export async function processJobs(ctx, { now, limit = 20 } = {}) {
  const t = clock(ctx, now);
  const { handlers } = registryOf(ctx);
  const out = { ran: 0, done: 0, retried: 0, dead: 0 };
  for (const job of claim(ctx, t, limit)) {
    out.ran++;
    let result = null, error = null;
    try {
      const fn = handlers.get(job.kind);
      if (!fn) throw Object.assign(new Error(`no handler registered for job kind "${job.kind}"`), { fatal: true });
      result = await fn(ctx, JSON.parse(job.payload), job);
    } catch (e) { error = e; }
    const end = clock(ctx, now);
    if (!error) {
      if (result && Number.isFinite(result.rerunAt)) {
        ctx.db.prepare("UPDATE jobs_queue SET status = 'pending', run_at = ?, attempts = 0, locked_until = NULL, last_error = NULL WHERE id = ?").run(result.rerunAt, job.id);
        out.retried++;
      } else {
        ctx.db.prepare("UPDATE jobs_queue SET status = 'done', finished_at = ?, locked_until = NULL, last_error = NULL, result = ? WHERE id = ?").run(end, JSON.stringify(result ?? null)?.slice(0, 2000) ?? null, job.id);
        out.done++;
      }
    } else if (error.fatal || job.attempts >= job.max_attempts) {
      ctx.db.prepare("UPDATE jobs_queue SET status = 'dead', finished_at = ?, locked_until = NULL, last_error = ? WHERE id = ?").run(end, clip(error.message), job.id);
      out.dead++;
    } else {
      ctx.db.prepare("UPDATE jobs_queue SET status = 'pending', run_at = ?, locked_until = NULL, last_error = ? WHERE id = ?").run(end + backoffMs(job.attempts), clip(error.message), job.id);
      out.retried++;
    }
  }
  return out;
}

export function retryJob(ctx, id, { userId = null, now } = {}) {
  const j = ctx.db.prepare('SELECT * FROM jobs_queue WHERE id = ?').get(id);
  if (!j) throw new AppError(404, 'NOT_FOUND', 'Job not found');
  if (j.status !== 'dead') throw new AppError(409, 'BAD_TRANSITION', 'Only a dead job can be retried');
  return tx(ctx.db, () => {
    ctx.db.prepare("UPDATE jobs_queue SET status = 'pending', attempts = 0, run_at = ?, finished_at = NULL WHERE id = ?").run(clock(ctx, now), id);
    audit(ctx, { userId, action: 'jobs.retried', type: 'job', id, oldValue: { status: 'dead', error: j.last_error } });
    return { id, status: 'pending' };
  });
}

// ---- schedules ----

function firstRun(sched, t) { return sched.cron ? nextCron(sched.cron, t) : t + sched.everyMs; }

/** Add a recurring definition (idempotent by name). Exactly one of everyMs or cron. */
export function defineSchedule(ctx, { name, kind, payload = {}, everyMs = null, cron = null, source = 'module', now }) {
  if (!name || !kind) throw new AppError(400, 'BAD_INPUT', 'name and kind are required');
  if ((everyMs == null) === (cron == null)) throw new AppError(400, 'BAD_INPUT', 'give exactly one of everyMs or cron');
  if (everyMs != null && (!Number.isInteger(everyMs) || everyMs < 1000)) throw new AppError(400, 'BAD_INPUT', 'everyMs must be a whole number of at least 1000');
  if (cron != null) parseCron(cron);
  const t = clock(ctx, now);
  const have = ctx.db.prepare('SELECT id FROM jobs_schedules WHERE name = ?').get(name);
  if (have) return { id: have.id, created: false };
  const next = firstRun({ everyMs, cron }, t);
  if (next == null) throw new AppError(400, 'BAD_CRON', 'cron never matches');
  const id = Number(ctx.db.prepare('INSERT INTO jobs_schedules (name, kind, payload, every_ms, cron, next_run_at, source, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(name, kind, json(payload), everyMs, cron, next, source, t).lastInsertRowid);
  return { id, created: true };
}

const readied = new WeakSet();
/** Make sure every schedule the modules declare exists in this company database (once per open database). Never overwrites edits. */
export function ensureSchedules(ctx, { now, force = false } = {}) {
  if (!force && readied.has(ctx.db)) return 0;
  let n = 0;
  for (const s of registryOf(ctx).schedules) if (defineSchedule(ctx, { ...s, name: s.name ?? s.kind, now }).created) n++;
  readied.add(ctx.db);
  return n;
}

/** Turn due schedules into queued jobs (skipped while the previous run of the same schedule is still live), then move them on. No catch-up burst. */
export function dispatchSchedules(ctx, { now } = {}) {
  const t = clock(ctx, now);
  const { db } = ctx;
  let queued = 0;
  for (const s of db.prepare('SELECT * FROM jobs_schedules WHERE active = 1 AND next_run_at <= ? ORDER BY id').all(t)) {
    tx(db, () => {
      const job = enqueue(ctx, s.kind, JSON.parse(s.payload), { uniqueKey: `schedule:${s.id}`, scheduleId: s.id, now: t });
      const next = s.cron ? nextCron(s.cron, t) : t + s.every_ms;
      db.prepare('UPDATE jobs_schedules SET last_run_at = ?, last_job_id = ?, next_run_at = ?, active = ? WHERE id = ?').run(t, job.id, next ?? t, next == null ? 0 : 1, s.id);
      if (!job.deduped) queued++;
    });
  }
  return queued;
}

export function updateSchedule(ctx, id, patch = {}, { userId = null, now } = {}) {
  const s = ctx.db.prepare('SELECT * FROM jobs_schedules WHERE id = ?').get(id);
  if (!s) throw new AppError(404, 'NOT_FOUND', 'Schedule not found');
  const t = clock(ctx, now);
  const next = { active: s.active, every_ms: s.every_ms, cron: s.cron };
  if (patch.active != null) next.active = patch.active ? 1 : 0;
  if (patch.everyMs != null || patch.cron != null) {
    if (patch.everyMs != null && patch.cron != null) throw new AppError(400, 'BAD_INPUT', 'give everyMs or cron, not both');
    if (patch.everyMs != null) {
      if (!Number.isInteger(patch.everyMs) || patch.everyMs < 1000) throw new AppError(400, 'BAD_INPUT', 'everyMs must be a whole number of at least 1000');
      next.every_ms = patch.everyMs; next.cron = null;
    } else { parseCron(patch.cron); next.cron = String(patch.cron); next.every_ms = null; }
  }
  return tx(ctx.db, () => {
    const nr = next.cron ? nextCron(next.cron, t) : t + next.every_ms;
    ctx.db.prepare('UPDATE jobs_schedules SET active = ?, every_ms = ?, cron = ?, next_run_at = ? WHERE id = ?').run(next.active, next.every_ms, next.cron, nr ?? t, id);
    audit(ctx, { userId, action: 'jobs.schedule_updated', type: 'job_schedule', id, oldValue: { active: !!s.active, everyMs: s.every_ms, cron: s.cron }, newValue: { active: !!next.active, everyMs: next.every_ms, cron: next.cron } });
    return scheduleView(ctx.db.prepare('SELECT * FROM jobs_schedules WHERE id = ?').get(id));
  });
}

export const scheduleView = (s) => ({ id: s.id, name: s.name, kind: s.kind, everyMs: s.every_ms, cron: s.cron, active: !!s.active, nextRunAt: s.next_run_at, lastRunAt: s.last_run_at, lastJobId: s.last_job_id, source: s.source });

// ---- outbox ----

/**
 * Queue an external effect. Call it INSIDE the transaction that changes the books (the row commits or rolls back with it);
 * a consumer registered by a module (`outbox: { topic: fn }`) delivers it later, at least once, with backoff.
 * Consumers must be idempotent: use the row id (second argument's `id`) as the idempotency key towards the outside.
 */
export function enqueueOutbox(ctx, topic, payload, { uniqueKey = null, maxAttempts = 8, now } = {}) {
  if (typeof topic !== 'string' || !topic) throw new AppError(400, 'BAD_INPUT', 'topic is required');
  const t = clock(ctx, now);
  if (uniqueKey != null) {
    const have = ctx.db.prepare('SELECT id FROM jobs_outbox WHERE unique_key = ?').get(uniqueKey);
    if (have) return { id: have.id, deduped: true };
  }
  const id = Number(ctx.db.prepare('INSERT INTO jobs_outbox (topic, payload, max_attempts, next_attempt_at, unique_key, created_at) VALUES (?,?,?,?,?,?)')
    .run(topic, JSON.stringify(payload ?? null), maxAttempts, t, uniqueKey, t).lastInsertRowid);
  return { id, deduped: false };
}

export async function dispatchOutbox(ctx, { now, limit = 50 } = {}) {
  const t = clock(ctx, now);
  const { consumers } = registryOf(ctx);
  const out = { attempted: 0, delivered: 0, failed: 0, dead: 0 };
  for (const { id } of ctx.db.prepare("SELECT id FROM jobs_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?").all(t, limit)) {
    // lease: push next_attempt_at out so a parallel pass skips the row while it is in flight
    if (!ctx.db.prepare("UPDATE jobs_outbox SET next_attempt_at = ? WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?").run(t + LEASE_MS, id, t).changes) continue;
    const row = ctx.db.prepare('SELECT * FROM jobs_outbox WHERE id = ?').get(id);
    out.attempted++;
    let error = null;
    try {
      const fn = consumers.get(row.topic);
      if (!fn) throw Object.assign(new Error(`no consumer for topic "${row.topic}"`), { fatal: true });
      await fn(ctx, JSON.parse(row.payload), { id: row.id, topic: row.topic, attempts: row.attempts + 1 });
    } catch (e) { error = e; }
    const attempts = row.attempts + 1, end = clock(ctx, now);
    if (!error) { ctx.db.prepare("UPDATE jobs_outbox SET status = 'delivered', attempts = ?, delivered_at = ?, last_error = NULL WHERE id = ?").run(attempts, end, id); out.delivered++; }
    else if (error.fatal || attempts >= row.max_attempts) { ctx.db.prepare("UPDATE jobs_outbox SET status = 'dead', attempts = ?, last_error = ? WHERE id = ?").run(attempts, clip(error.message), id); out.dead++; }
    else { ctx.db.prepare('UPDATE jobs_outbox SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?').run(attempts, clip(error.message), end + backoffMs(attempts), id); out.failed++; }
  }
  return out;
}

export function retryOutbox(ctx, id, { userId = null, now } = {}) {
  const r = ctx.db.prepare('SELECT * FROM jobs_outbox WHERE id = ?').get(id);
  if (!r) throw new AppError(404, 'NOT_FOUND', 'Outbox row not found');
  if (r.status !== 'dead') throw new AppError(409, 'BAD_TRANSITION', 'Only a dead outbox row can be retried');
  return tx(ctx.db, () => {
    ctx.db.prepare("UPDATE jobs_outbox SET status = 'pending', attempts = 0, next_attempt_at = ? WHERE id = ?").run(clock(ctx, now), id);
    audit(ctx, { userId, action: 'jobs.outbox_retried', type: 'job_outbox', id, oldValue: { error: r.last_error } });
    return { id, status: 'pending' };
  });
}

// ---- one pass ----

/**
 * One scheduler pass on ONE company database: make sure schedules exist, queue the due ones, run due jobs, deliver the outbox.
 * `now` (a number or a function) overrides ctx.now() for this pass only.
 */
export async function runDue(ctx, opts = {}) {
  ensureSchedules(ctx, opts);
  const scheduled = dispatchSchedules(ctx, opts);
  const jobs = await processJobs(ctx, opts);
  const outbox = await dispatchOutbox(ctx, opts);
  return { scheduled, jobs, outbox };
}

/** The same pass for every active company: the tenant manager visits each database explicitly (never mixes them). Without tenancy: just ctx. */
export async function runDueEverywhere(ctx, tenants = null, opts = {}) {
  const results = [];
  const one = async (c) => { results.push({ tenant: c.tenant?.slug ?? 'default', ...(await runDue(c, opts)) }); };
  if (tenants) await tenants.forEachActive(one); else await one(ctx);
  return results;
}

/** Delete finished jobs and delivered outbox rows older than `days`. Dead rows are kept for a human. */
export function cleanup(ctx, { days = 14, now } = {}) {
  const cutoff = clock(ctx, now) - days * 86400000;
  const a = ctx.db.prepare("DELETE FROM jobs_queue WHERE status = 'done' AND finished_at < ?").run(cutoff).changes;
  const b = ctx.db.prepare("DELETE FROM jobs_outbox WHERE status = 'delivered' AND delivered_at < ?").run(cutoff).changes;
  return { jobs: Number(a), outbox: Number(b) };
}
