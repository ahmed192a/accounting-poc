import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb, createContext } from './db.js';
import { seed } from './seed.js';
import { AppError } from './errors.js';
import { loadUser } from './permissions.js';
import * as s from './services.js';

const INDEX = fileURLToPath(new URL('../public/index.html', import.meta.url));

// [method, path pattern, handler, public?]. Handler: (ctx, user, { params, query, body }) => result
const ROUTES = [
  ['GET', '/api/demo-users', (ctx) => s.demoUsers(ctx), true],
  ['GET', '/api/home', (ctx, u) => s.home(ctx, u)],
  ['GET', '/api/items', (ctx, u) => s.listItems(ctx, u)],
  ['POST', '/api/sales/quick', (ctx, u, r) => s.quickSale(ctx, u, r.body)],
  ['GET', '/api/invoices', (ctx, u) => s.listInvoices(ctx, u)],
  ['POST', '/api/invoices', (ctx, u, r) => s.createInvoice(ctx, u, r.body)],
  ['POST', '/api/invoices/:id/pay', (ctx, u, r) => s.payInvoice(ctx, u, Number(r.params.id))],
  ['GET', '/api/bills', (ctx, u) => s.listBills(ctx, u)],
  ['POST', '/api/bills', (ctx, u, r) => s.createBill(ctx, u, r.body)],
  ['POST', '/api/bills/:id/approve', (ctx, u, r) => s.approveBill(ctx, u, Number(r.params.id))],
  ['GET', '/api/entries', (ctx, u) => s.entries(ctx, u)],
  ['POST', '/api/entries', (ctx, u, r) => s.manualEntry(ctx, u, r.body)],
  ['POST', '/api/entries/:id/reverse', (ctx, u, r) => s.reverse(ctx, u, Number(r.params.id), r.body.reason)],
  ['POST', '/api/period-lock', (ctx, u, r) => s.lockPeriod(ctx, u, r.body)],
  ['GET', '/api/reports', (ctx, u) => s.reports(ctx, u)],
  ['GET', '/api/audit', (ctx, u, r) => s.auditSearch(ctx, u, r.query)],
  ['GET', '/api/eta/queue', (ctx, u) => s.etaQueue(ctx, u)],
  ['POST', '/api/eta/sync', (ctx, u) => s.etaSync(ctx, u)],
  ['POST', '/api/eta/online', (ctx, u, r) => s.etaSetOnline(ctx, u, r.body.online)],
  ['GET', '/api/roles', (ctx, u) => s.listRoles(ctx, u)],
  ['POST', '/api/roles', (ctx, u, r) => s.createRole(ctx, u, r.body)],
  ['PATCH', '/api/users/:id', (ctx, u, r) => s.setUserRole(ctx, u, Number(r.params.id), r.body.roleId)],
  ['GET', '/api/export', (ctx, u) => s.exportAll(ctx, u)],
  // Demo only: move the clock forward to see the 24-hour e-receipt deadline in action.
  ['POST', '/api/dev/advance-clock', (ctx, u, r) => { ctx.offsetMs += Number(r.body.hours ?? 0) * 3600 * 1000; return { now: new Date(ctx.now()).toISOString() }; }],
].map(([method, path, handler, isPublic]) => {
  const names = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)')) + '$');
  return { method, re, names, handler, isPublic: !!isPublic };
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new AppError(413, 'TOO_LARGE', 'Request too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new AppError(400, 'BAD_JSON', 'Body must be valid JSON')); }
    });
  });
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type + '; charset=utf-8' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

export function createApp(ctx) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, readFileSync(INDEX, 'utf8'), 'text/html');
      }
      for (const r of ROUTES) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
        const body = req.method === 'GET' ? {} : await readBody(req);
        // PoC identification only: a header names the user. Real auth (sessions + MFA) comes later.
        const user = r.isPublic ? null : loadUser(ctx, Number(req.headers['x-user-id']));
        const result = r.handler(ctx, user, { params, query: Object.fromEntries(url.searchParams), body });
        return send(res, req.method === 'POST' ? 201 : 200, result);
      }
      throw new AppError(404, 'NOT_FOUND', 'No such route');
    } catch (e) {
      if (e instanceof AppError) return send(res, e.status, { error: { code: e.code, message: e.message, ...(e.extra ?? {}) } });
      console.error(e);
      send(res, 500, { error: { code: 'INTERNAL', message: 'Unexpected error' } });
    }
  });
}

export function createSeededContext(path = ':memory:') {
  return seed(createContext(openDb(path)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  createApp(createSeededContext(process.env.DB_PATH ?? ':memory:')).listen(port, () => {
    console.log(`Accounting PoC running at http://localhost:${port}`);
  });
}
