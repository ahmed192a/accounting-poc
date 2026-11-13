import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, startApp } from './helpers.js';
import { createApp } from '../src/server.js';
import { configure } from '../src/modules/auth/config.js';
import { emit } from '../src/hooks.js';
import { isoDate } from '../src/ledger.js';
import * as q from '../src/modules/jobs/queue.js';
import * as wh from '../src/modules/auth/webhooks.js';
import * as purchases from '../src/modules/purchases/service.js';
import * as rec from '../src/modules/purchases/recurring.js';
import * as rules from '../src/modules/approvals/rules.js';
import * as eng from '../src/modules/approvals/engine.js';
import * as notes from '../src/modules/approvals/notifications.js';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR, EGP = 100;
const PUBLIC = async () => [{ address: '93.184.216.34' }];
const liveJobs = (ctx, kind) => ctx.db.prepare("SELECT * FROM jobs_queue WHERE kind = ? AND status IN ('pending','running')").all(kind);

test('every module that needs background work declares it, and each kind has a schedule', () => {
  const { ctx } = setup();
  const reg = q.registryOf(ctx);
  for (const kind of ['webhooks.deliver', 'approvals.escalate', 'purchases.recurring', 'eta.sync', 'jobs.cleanup']) assert.ok(reg.handlers.has(kind), kind);
  assert.deepEqual(reg.schedules.map((s) => s.name).sort(), ['approvals.escalate', 'eta.sync', 'jobs.cleanup', 'purchases.recurring', 'webhooks.deliver']);
});

test('webhooks: an event wakes one delivery job; a failing endpoint is retried by the job at its backoff time, then delivered', async () => {
  const { ctx, as } = setup();
  const calls = [];
  let status = 500;
  configure(ctx, { env: {}, resolve: PUBLIC, fetch: async (url, init) => { calls.push(init.headers['x-webhook-event']); return new Response(null, { status }); } });
  wh.createWebhook(ctx, as('admin'), { url: 'https://hooks.example.com/in', events: ['invoice.paid'] });
  emit(ctx, 'invoice.paid', { id: 1, total: 100, entryId: 1, userId: 1 });
  emit(ctx, 'invoice.paid', { id: 2, total: 200, entryId: 2, userId: 1 });
  assert.equal(liveJobs(ctx, 'webhooks.deliver').length, 1, 'wake-ups are deduplicated');

  const r1 = await q.runDue(ctx);
  assert.equal(r1.jobs.done + r1.jobs.retried >= 1, true);
  assert.equal(calls.length, 2);
  const job = liveJobs(ctx, 'webhooks.deliver')[0];
  assert.ok(job, 'job re-queued for the retry time');
  const next = ctx.db.prepare("SELECT MIN(next_attempt_at) t FROM auth_webhook_deliveries WHERE status = 'pending'").get().t;
  assert.equal(job.run_at, next);
  assert.equal((await q.runDue(ctx, { now: ctx.now() + 5000 })).jobs.ran, 0, 'not before the backoff has passed');

  status = 200;
  ctx.offsetMs += 2 * MIN;
  await q.runDue(ctx);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM auth_webhook_deliveries WHERE status = 'delivered'").get().n, 2);
  assert.equal(liveJobs(ctx, 'webhooks.deliver').length, 0, 'nothing pending, so no job left behind');
});

test('webhooks: the existing process route and test button still deliver, and the job drains what they queued', async () => {
  const { ctx, as } = setup();
  configure(ctx, { env: {}, resolve: PUBLIC, fetch: async () => new Response(null, { status: 200 }) });
  const w = wh.createWebhook(ctx, as('admin'), { url: 'https://hooks.example.com/in' });
  wh.sendTest(ctx, as('admin'), w.id);
  assert.equal(liveJobs(ctx, 'webhooks.deliver').length, 1);
  await q.runDue(ctx);
  assert.equal(wh.listDeliveries(ctx, as('admin'))[0].status, 'delivered');
});

test('approvals: escalation runs from the scheduler as the system actor, once', async () => {
  const { ctx, as } = setup();
  rules.createRule(ctx, as('owner'), { name: 'Slow manager', minAmount: 100000, priority: 10,
    steps: [{ approverType: 'role', approverRef: 'manager', escalateAfterHours: 24, escalateTo: { type: 'role', ref: 'owner' } }] });
  const b = purchases.createBill(ctx, as('clerk'), { supplier: 'Acme', amount: 3000 * EGP, category: 'rent' });
  await q.runDue(ctx); // creates the schedules
  ctx.offsetMs += 25 * HOUR;
  const out = await q.runDue(ctx);
  assert.ok(out.scheduled >= 1);
  const j = ctx.db.prepare("SELECT * FROM jobs_queue WHERE kind = 'approvals.escalate' AND status = 'done'").get();
  assert.deepEqual(JSON.parse(j.result).escalated.length, 1);
  assert.ok(notes.listNotifications(ctx, as('owner')).items.some((n) => n.kind === 'escalated'));
  purchases.approveBill(ctx, as('owner'), b.id); // the escalation target can now approve
  ctx.offsetMs += 2 * DAY;
  await q.runDue(ctx);
  assert.equal(eng.processEscalations(ctx, as('owner')).escalated.length, 0);
});

test('recurring bills: created by the hourly schedule, through the normal bill path, and not twice', async () => {
  const { ctx, as } = setup();
  rec.createRecurring(ctx, as('clerk'), { supplier: 'Landlord Co', amount: 4000 * EGP, category: 'rent', frequency: 'monthly', startDate: isoDate(ctx.now() + DAY) });
  await q.runDue(ctx);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM bills WHERE source = 'recurring'").get().n, 0);
  ctx.offsetMs += 2 * DAY;
  await q.runDue(ctx);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM bills WHERE source = 'recurring'").get().n, 1);
  assert.equal(ctx.db.prepare("SELECT status FROM bills WHERE source = 'recurring'").get().status, 'pending_approval'); // still needs a human
  ctx.offsetMs += 3 * HOUR;
  await q.runDue(ctx);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM bills WHERE source = 'recurring'").get().n, 1);
});

test('ETA sync: the scheduled job submits queued mock receipts and records the sync time (MOCK adapter)', async () => {
  const { ctx } = setup();
  await q.runDue(ctx);
  assert.ok(!Number(ctx.db.prepare("SELECT value FROM settings WHERE key = 'tax_last_sync'").get()?.value));
  ctx.offsetMs += 6 * MIN;
  const out = await q.runDue(ctx);
  assert.ok(out.scheduled >= 1);
  const j = ctx.db.prepare("SELECT * FROM jobs_queue WHERE kind = 'eta.sync'").get();
  assert.equal(j.status, 'done', j.last_error);
  assert.ok(Number(ctx.db.prepare("SELECT value FROM settings WHERE key = 'tax_last_sync'").get().value) > 0);
  assert.ok('receipts' in JSON.parse(j.result));
});

test('the HTTP background tick runs the jobs pass (webhook delivery still happens without any manual call)', async () => {
  const { ctx, as } = setup();
  const seen = [];
  const app = await startApp(createApp, ctx, { backgroundJobs: true, env: {}, resolve: PUBLIC, fetch: async (u, init) => { seen.push(init.headers['x-webhook-event']); return new Response(null, { status: 200 }); } });
  try {
    wh.createWebhook(ctx, as('admin'), { url: 'https://hooks.example.com/in' });
    emit(ctx, 'bill.created', { bill: { id: 1 }, status: 'pending_approval', userId: 1 });
    await app.server.runBackgroundJobs();
    assert.deepEqual(seen, ['bill.created']);
  } finally { await new Promise((r) => { app.server.close(r); app.server.closeAllConnections?.(); }); }
});

test('jobs HTTP routes: summaries, permission gating, run now, pause a schedule, retry a dead job', async () => {
  const { ctx } = setup();
  const app = await startApp(createApp, ctx, { backgroundJobs: false, env: {} });
  try {
    const call = app.call;
    const ov = await call('GET', '/api/jobs', 6);
    assert.equal(ov.status, 200);
    assert.ok(ov.body.schedules.length >= 5); assert.ok(ov.body.kinds.includes('eta.sync'));
    assert.equal((await call('GET', '/api/jobs', 3)).status, 403, 'clerk');
    assert.equal((await call('GET', '/api/jobs', 5)).status, 200, 'auditor reads');
    assert.equal((await call('POST', '/api/jobs/run', 5)).status, 403, 'auditor cannot run');
    assert.equal((await call('POST', '/api/jobs/run', 2)).status, 403, 'manager cannot run');
    const run = await call('POST', '/api/jobs/run', 6);
    assert.equal(run.status, 200); assert.ok('jobs' in run.body && 'outbox' in run.body);

    const sid = ov.body.schedules.find((s) => s.name === 'eta.sync').id;
    const p = await call('PATCH', `/api/jobs/schedules/${sid}`, 6, { active: false });
    assert.equal(p.body.active, false);
    assert.equal((await call('PATCH', `/api/jobs/schedules/${sid}`, 6, { cron: 'bad' })).body.error.code, 'BAD_CRON');
    assert.equal((await call('PATCH', `/api/jobs/schedules/${sid}`, 5, { active: true })).status, 403);
    const now = await call('POST', `/api/jobs/schedules/${sid}/run`, 6);
    assert.equal(now.status, 200);
    assert.equal((await call('POST', `/api/jobs/schedules/${sid}/run`, 6)).body.deduped, true);

    const dead = q.enqueue(ctx, 'nope.kind', {}, { maxAttempts: 1 });
    await call('POST', '/api/jobs/run', 6);
    const list = await call('GET', '/api/jobs/list?status=dead', 6);
    assert.ok(list.body.some((j) => j.id === dead.id));
    assert.equal((await call('POST', `/api/jobs/${dead.id}/retry`, 6)).body.status, 'pending');
    assert.equal((await call('POST', `/api/jobs/${dead.id}/retry`, 6)).body.error.code, 'BAD_TRANSITION');
    assert.equal((await call('GET', '/api/jobs/outbox', 6)).status, 200);
    assert.equal((await call('POST', '/api/jobs/outbox/999/retry', 6)).status, 404);
    assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'jobs.run_now'").get());
    const home = await call('GET', '/api/home', 6);
    assert.ok(home.body.widgets.jobs);
  } finally { await new Promise((r) => { app.server.close(r); app.server.closeAllConnections?.(); }); }
});

test('every jobs route has meta.summary and a permission', () => {
  const { ctx } = setup();
  for (const r of ctx.registry.routes.filter((x) => x.module === 'jobs')) { assert.ok(r.meta.summary, r.path); assert.ok(r.meta.permission, r.path); }
});
