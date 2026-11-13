import * as s from './service.js';
import { cleanup } from './queue.js';

// Jobs kernel: queue, schedules, outbox. Other modules plug in with `jobs`, `schedules` and `outbox` (docs/jobs.md).
const r = (method, path, permission, summary, handler) => ({ method, path, handler, meta: { summary, permission, ...(method === 'POST' ? { status: 200 } : {}) } });
const id = (q) => Number(q.params.id);

export default {
  name: 'jobs',
  permissions: { 'jobs.view': 'See background jobs, schedules and the outbox', 'jobs.manage': 'Run, retry, pause and reschedule background jobs' },
  roleGrants: { admin: ['jobs.view', 'jobs.manage'], manager: ['jobs.view'], auditor: ['jobs.view'] },
  exportTables: ['jobs_schedules'],
  jobs: { 'jobs.cleanup': (ctx) => cleanup(ctx) },
  schedules: [{ name: 'jobs.cleanup', kind: 'jobs.cleanup', cron: '17 3 * * *' }],
  routes: [
    r('GET', '/api/jobs', 'jobs.view', 'Background jobs overview: counts, schedules, recent jobs', (c, u) => s.overview(c, u)),
    r('GET', '/api/jobs/list', 'jobs.view', 'List jobs (filter by status and kind)', (c, u, q) => s.listJobs(c, u, q.query)),
    r('GET', '/api/jobs/schedules', 'jobs.view', 'List recurring schedules', (c, u) => s.listSchedules(c, u)),
    r('PATCH', '/api/jobs/schedules/:id', 'jobs.manage', 'Pause, resume or retime a schedule', (c, u, q) => s.patchSchedule(c, u, id(q), q.body)),
    r('POST', '/api/jobs/schedules/:id/run', 'jobs.manage', 'Queue one run of a schedule now', (c, u, q) => s.runScheduleNow(c, u, id(q))),
    r('POST', '/api/jobs/run', 'jobs.manage', 'Run one scheduler pass for this company now', (c, u) => s.runNow(c, u)),
    r('POST', '/api/jobs/:id/retry', 'jobs.manage', 'Retry a dead job', (c, u, q) => s.retry(c, u, id(q))),
    r('GET', '/api/jobs/outbox', 'jobs.view', 'List outbox rows', (c, u, q) => s.listOutbox(c, u, q.query)),
    r('POST', '/api/jobs/outbox/:id/retry', 'jobs.manage', 'Retry a dead outbox row', (c, u, q) => s.retryOutboxRow(c, u, id(q))),
  ],
  widgets: s.widgets,
};
