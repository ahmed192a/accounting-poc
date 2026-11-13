import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError, tempModules } from './helpers.js';
import { createSeededContext } from '../src/server.js';
import { loadModules, MODULES_DIR } from '../src/modules.js';
import { createTenantManager } from '../src/tenants.js';
import { parseCron, nextCron } from '../src/modules/jobs/cron.js';
import * as q from '../src/modules/jobs/queue.js';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

// A throwaway module that declares jobs, a schedule and an outbox consumer, loaded next to the real modules.
const FAKE = `
export const calls = (globalThis.__jobsCalls ??= []);
export default {
  name: 'fakejobs',
  jobs: {
    'fake.ok': (ctx, payload) => { calls.push(['ok', ctx.tenant?.slug ?? 'default', payload]); return { seen: payload.n ?? null }; },
    'fake.flaky': (ctx, payload, job) => { calls.push(['flaky', job.attempts]); if (job.attempts < 3) throw new Error('boom ' + job.attempts); return 'fine'; },
    'fake.always': () => { throw new Error('never works'); },
    'fake.again': (ctx, p, job) => (job.attempts === 1 && !globalThis.__again ? (globalThis.__again = 1, { rerunAt: ctx.now() + 10 * 60000 }) : 'second'),
  },
  schedules: [{ name: 'fake.every10', kind: 'fake.ok', everyMs: 600000, payload: { n: 10 } }, { name: 'fake.daily', kind: 'fake.ok', cron: '30 2 * * *', payload: { n: 2 } }],
  outbox: {
    'fake.topic': (ctx, payload, row) => { calls.push(['outbox', row.id, row.attempts, payload]); if (payload.fail && row.attempts < payload.fail) throw new Error('sink down'); },
  },
};`;

async function fakeCtx() {
  globalThis.__jobsCalls = []; delete globalThis.__again;
  const dir = tempModules({ 'fakejobs/index.js': FAKE });
  const registry = await loadModules([MODULES_DIR, dir]);
  return createSeededContext(':memory:', registry);
}
const calls = () => globalThis.__jobsCalls;
const job = (ctx, id) => ctx.db.prepare('SELECT * FROM jobs_queue WHERE id = ?').get(id);

test('cron: parse, next occurrence in UTC, steps, ranges, lists, day-of-week, bad input', () => {
  const t0 = Date.UTC(2026, 10, 13, 10, 7, 30); // Fri 2026-11-13 10:07:30Z
  assert.equal(nextCron('*/15 * * * *', t0), Date.UTC(2026, 10, 13, 10, 15));
  assert.equal(nextCron('30 2 * * *', t0), Date.UTC(2026, 10, 14, 2, 30));
  assert.equal(nextCron('5 * * * *', t0), Date.UTC(2026, 10, 13, 11, 5));
  assert.equal(nextCron('0 9 * * 1-5', t0), Date.UTC(2026, 10, 16, 9, 0)); // next Monday
  assert.equal(nextCron('0 0 1 1,7 *', t0), Date.UTC(2027, 0, 1));
  assert.equal(nextCron('0 0 * * 7', t0), Date.UTC(2026, 10, 15)); // 7 = Sunday
  assert.equal(nextCron('* * * * *', Date.UTC(2026, 0, 1, 0, 0, 0)), Date.UTC(2026, 0, 1, 0, 1)); // strictly after
  assert.equal(nextCron('0 0 30 2 *', t0), null);
  for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', 'a * * * *', '*/0 * * * *', '5-1 * * * *']) expectError(() => parseCron(bad), 'BAD_CRON');
});

test('queue: a job runs once at its time, results are stored, the clock is injectable', async () => {
  const ctx = await fakeCtx();
  const t = ctx.now();
  const { id } = q.enqueue(ctx, 'fake.ok', { n: 7 }, { runAt: t + HOUR });
  assert.equal((await q.processJobs(ctx)).ran, 0, 'not due yet');
  assert.equal((await q.processJobs(ctx, { now: t + HOUR })).done, 1, 'injected now');
  assert.equal(job(ctx, id).status, 'done');
  assert.deepEqual(JSON.parse(job(ctx, id).result), { seen: 7 });
  assert.equal((await q.processJobs(ctx, { now: t + 2 * HOUR })).ran, 0, 'never twice');
  ctx.offsetMs += 3 * HOUR; // the demo clock works as well
  q.enqueue(ctx, 'fake.ok', { n: 8 }, { runAt: t + 2 * HOUR });
  assert.equal((await q.processJobs(ctx)).done, 1);
});

test('queue: unique keys dedupe live jobs and free the key once finished', async () => {
  const ctx = await fakeCtx();
  const a = q.enqueue(ctx, 'fake.ok', {}, { uniqueKey: 'k' });
  const b = q.enqueue(ctx, 'fake.ok', {}, { uniqueKey: 'k' });
  assert.equal(b.deduped, true); assert.equal(b.id, a.id);
  await q.processJobs(ctx);
  assert.equal(q.enqueue(ctx, 'fake.ok', {}, { uniqueKey: 'k' }).deduped, false);
});

test('queue: failures back off exponentially, then succeed; exhausted jobs go dead and can be retried by hand', async () => {
  const ctx = await fakeCtx();
  const t = ctx.now();
  const { id } = q.enqueue(ctx, 'fake.flaky', {}, { now: t });
  assert.equal((await q.processJobs(ctx, { now: t })).retried, 1);
  assert.equal(job(ctx, id).run_at, t + q.backoffMs(1)); assert.equal(job(ctx, id).last_error, 'boom 1');
  assert.equal((await q.processJobs(ctx, { now: t + 1000 })).ran, 0, 'backing off');
  assert.equal((await q.processJobs(ctx, { now: t + q.backoffMs(1) })).retried, 1);
  assert.equal(job(ctx, id).run_at, t + q.backoffMs(1) + q.backoffMs(2), 'delay doubles');
  assert.equal((await q.processJobs(ctx, { now: t + HOUR })).done, 1);
  assert.deepEqual(calls().filter((c) => c[0] === 'flaky').map((c) => c[1]), [1, 2, 3]);

  const dead = q.enqueue(ctx, 'fake.always', {}, { maxAttempts: 2, now: t });
  await q.processJobs(ctx, { now: t });
  assert.equal((await q.processJobs(ctx, { now: t + HOUR })).dead, 1);
  assert.equal(job(ctx, dead.id).status, 'dead');
  expectError(() => q.retryJob(ctx, id), 'BAD_TRANSITION');
  q.retryJob(ctx, dead.id, { now: t + HOUR });
  assert.equal(job(ctx, dead.id).status, 'pending'); assert.equal(job(ctx, dead.id).attempts, 0);
});

test('queue: unknown kind goes dead immediately; a handler can ask to run again later; a crashed (expired lease) job is re-run', async () => {
  const ctx = await fakeCtx();
  const t = ctx.now();
  const u = q.enqueue(ctx, 'no.such.kind', {}, { now: t });
  assert.equal((await q.processJobs(ctx, { now: t })).dead, 1);
  assert.match(job(ctx, u.id).last_error, /no handler/);

  const again = q.enqueue(ctx, 'fake.again', {}, { now: t });
  await q.processJobs(ctx, { now: t });
  assert.equal(job(ctx, again.id).status, 'pending'); assert.ok(Math.abs(job(ctx, again.id).run_at - (t + 10 * MIN)) < 5000); assert.equal(job(ctx, again.id).attempts, 0);
  await q.processJobs(ctx, { now: t + 11 * MIN });
  assert.equal(job(ctx, again.id).status, 'done');

  const crashed = q.enqueue(ctx, 'fake.ok', { n: 1 }, { now: t });
  ctx.db.prepare("UPDATE jobs_queue SET status = 'running', attempts = 1, locked_until = ? WHERE id = ?").run(t + q.LEASE_MS, crashed.id);
  assert.equal((await q.processJobs(ctx, { now: t + 1000 })).ran, 0, 'lease still valid');
  assert.equal((await q.processJobs(ctx, { now: t + q.LEASE_MS + 1 })).done, 1);
});

test('schedules: declared by modules, created once, fire on the injected clock, no catch-up burst, unique per schedule', async () => {
  const ctx = await fakeCtx();
  const t = ctx.now();
  assert.ok(q.ensureSchedules(ctx, { now: t }) >= 2);
  assert.equal(q.ensureSchedules(ctx, { now: t, force: true }), 0, 'idempotent');
  const sched = (n) => ctx.db.prepare('SELECT * FROM jobs_schedules WHERE name = ?').get(n);
  assert.equal(sched('fake.every10').next_run_at, t + 10 * MIN);
  assert.ok(nextCron('30 2 * * *', t) === sched('fake.daily').next_run_at);

  await q.runDue(ctx, { now: t + 9 * MIN });
  assert.ok(!calls().some((c) => c[0] === 'ok'), 'nothing of ours is due yet');
  const r = await q.runDue(ctx, { now: t + 10 * MIN });
  assert.ok(r.scheduled >= 1);
  assert.ok(calls().some((c) => c[0] === 'ok' && c[2].n === 10));
  assert.equal(sched('fake.every10').next_run_at, t + 20 * MIN);
  const before = calls().filter((c) => c[2]?.n === 10).length;
  await q.runDue(ctx, { now: t + 25 * HOUR }); // a day later: one run, not 150
  assert.equal(calls().filter((c) => c[2]?.n === 10).length, before + 1);
  assert.ok(calls().some((c) => c[2]?.n === 2), 'the daily cron fired');

  // a still-live job blocks a second one of the same schedule
  ctx.db.prepare("UPDATE jobs_schedules SET next_run_at = ? WHERE name = 'fake.every10'").run(t);
  q.dispatchSchedules(ctx, { now: t + 26 * HOUR });
  ctx.db.prepare("UPDATE jobs_schedules SET next_run_at = ? WHERE name = 'fake.every10'").run(t);
  q.dispatchSchedules(ctx, { now: t + 26 * HOUR });
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM jobs_queue WHERE kind = 'fake.ok' AND status = 'pending' AND unique_key = ?").get(`schedule:${sched('fake.every10').id}`).n, 1);
});

test('schedules: pause, retime and validation', async () => {
  const ctx = await fakeCtx();
  const t = ctx.now();
  q.ensureSchedules(ctx, { now: t });
  const id = ctx.db.prepare("SELECT id FROM jobs_schedules WHERE name = 'fake.every10'").get().id;
  q.updateSchedule(ctx, id, { active: false }, { now: t });
  await q.runDue(ctx, { now: t + DAY });
  assert.ok(!calls().some((c) => c[2]?.n === 10), 'paused schedules never fire');
  const v = q.updateSchedule(ctx, id, { active: true, cron: '0 12 * * *' }, { now: t });
  assert.equal(v.cron, '0 12 * * *'); assert.equal(v.everyMs, null);
  expectError(() => q.updateSchedule(ctx, id, { everyMs: 10 }), 'BAD_INPUT');
  expectError(() => q.updateSchedule(ctx, id, { everyMs: 5000, cron: '* * * * *' }), 'BAD_INPUT');
  expectError(() => q.updateSchedule(ctx, id, { cron: 'nope' }), 'BAD_CRON');
  expectError(() => q.updateSchedule(ctx, 9999, {}), 'NOT_FOUND');
  expectError(() => q.defineSchedule(ctx, { name: 'x', kind: 'fake.ok' }), 'BAD_INPUT');
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'jobs.schedule_updated'").get());
});

test('outbox: row commits with the transaction, delivered at least once with backoff, dead after max attempts, retryable', async () => {
  const ctx = await fakeCtx();
  const t = ctx.now();
  assert.throws(() => ctx.db.exec('BEGIN') || (q.enqueueOutbox(ctx, 'fake.topic', { a: 1 }, { now: t }), (() => { throw new Error('rollback me'); })()), /rollback me/);
  ctx.db.exec('ROLLBACK');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM jobs_outbox').get().n, 0, 'rolled back with the caller');

  const a = q.enqueueOutbox(ctx, 'fake.topic', { fail: 3 }, { uniqueKey: 'evt-1', now: t });
  assert.equal(q.enqueueOutbox(ctx, 'fake.topic', { fail: 3 }, { uniqueKey: 'evt-1', now: t }).deduped, true);
  assert.equal((await q.dispatchOutbox(ctx, { now: t })).failed, 1);
  assert.equal((await q.dispatchOutbox(ctx, { now: t + 1000 })).attempted, 0, 'backing off');
  assert.equal((await q.dispatchOutbox(ctx, { now: t + HOUR })).failed, 1);
  assert.equal((await q.dispatchOutbox(ctx, { now: t + 2 * HOUR })).delivered, 1);
  assert.deepEqual(calls().filter((c) => c[0] === 'outbox').map((c) => c[2]), [1, 2, 3]);
  assert.equal(ctx.db.prepare('SELECT status FROM jobs_outbox WHERE id = ?').get(a.id).status, 'delivered');

  const d = q.enqueueOutbox(ctx, 'fake.topic', { fail: 99 }, { maxAttempts: 1, now: t });
  assert.equal((await q.dispatchOutbox(ctx, { now: t })).dead, 1);
  const n = q.enqueueOutbox(ctx, 'unknown.topic', {}, { now: t });
  assert.equal((await q.dispatchOutbox(ctx, { now: t })).dead, 1);
  expectError(() => q.retryOutbox(ctx, a.id), 'BAD_TRANSITION');
  q.retryOutbox(ctx, d.id, { now: t });
  assert.equal(ctx.db.prepare('SELECT status FROM jobs_outbox WHERE id = ?').get(d.id).status, 'pending');
  void n;
});

test('cleanup removes old finished jobs and delivered outbox rows but keeps dead ones', async () => {
  const ctx = await fakeCtx();
  const t = ctx.now();
  q.enqueue(ctx, 'fake.ok', {}, { now: t }); await q.processJobs(ctx, { now: t });
  q.enqueue(ctx, 'fake.always', {}, { maxAttempts: 1, now: t }); await q.processJobs(ctx, { now: t });
  q.enqueueOutbox(ctx, 'fake.topic', {}, { now: t }); await q.dispatchOutbox(ctx, { now: t });
  assert.deepEqual(q.cleanup(ctx, { now: t + DAY }), { jobs: 0, outbox: 0 });
  assert.deepEqual(q.cleanup(ctx, { now: t + 20 * DAY }), { jobs: 1, outbox: 1 });
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM jobs_queue WHERE status = 'dead'").get().n, 1);
});

test('per company: each database has its own queue, and a pass visits every active company explicitly', async () => {
  globalThis.__jobsCalls = [];
  const ctx = await fakeCtx();
  const m = createTenantManager(ctx, {});
  const op = { id: 1 };
  for (const slug of ['alpha', 'beta']) m.create(op, { slug, name: `${slug} Trading`, ownerEmail: `o@${slug}.test`, ownerPassword: 'Tenant-Strong-Pass-2026-x' }); // secret-scan:ignore test fixture
  m.with('alpha', (a) => q.enqueue(a, 'fake.ok', { n: 'A' }));
  const out = await q.runDueEverywhere(ctx, m);
  assert.deepEqual(out.map((r) => r.tenant).sort(), ['alpha', 'beta', 'default']);
  assert.deepEqual(calls().filter((c) => c[0] === 'ok').map((c) => [c[1], c[2].n]), [['alpha', 'A']], 'only alpha had work, and it ran in alpha');
  m.with('beta', (b) => assert.equal(b.db.prepare('SELECT COUNT(*) n FROM jobs_queue').get().n, 0));
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM jobs_queue').get().n, 0);
  // schedules were created per database
  for (const slug of ['alpha', 'beta']) m.with(slug, (c) => assert.ok(c.db.prepare('SELECT COUNT(*) n FROM jobs_schedules').get().n >= 4));
  // a suspended company is skipped
  m.setStatus(op, 'alpha', 'suspended');
  m.with('alpha', (a) => q.enqueue(a, 'fake.ok', { n: 'B' }));
  await q.runDueEverywhere(ctx, m);
  assert.equal(calls().filter((c) => c[2]?.n === 'B').length, 0);
  m.close();
});

test('systemActor is the first active owner and the module registry rejects duplicate job kinds', async () => {
  const { ctx } = setup();
  assert.equal(q.systemActor(ctx).role, 'owner');
  const dir = tempModules({ 'dup/index.js': "export default { name: 'dup', jobs: { 'webhooks.deliver': () => 1 } };" });
  const registry = await loadModules([MODULES_DIR, dir]);
  assert.throws(() => q.registryOf({ registry }), /more than one module/);
});
