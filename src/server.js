import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, sep, extname } from 'node:path';
import { openDb, createContext } from './db.js';
import { defaultRegistry, initContext } from './modules.js';
import { AppError } from './errors.js';
import { configure } from './modules/auth/config.js';
import { RateLimiter, rateHeaders } from './modules/auth/ratelimit.js';
import { securityHeaders, newRequestId, makeHttp, authenticate, checkOrigin, isSecureRequest } from './modules/auth/http.js';
import { ensureFirstRun } from './modules/auth/service.js';
import { sealAudit } from './modules/auth/auditchain.js';
import { processDeliveries } from './modules/auth/webhooks.js';
import { sha256Hex } from './modules/auth/crypto.js';
import { withIdempotency } from './idempotency.js';
import { createTenantManager } from './tenants.js';

// Routes, permissions, widgets and seeds all come from src/modules/*; this file only routes HTTP
// to them and serves public/. Nothing here changes when a feature is added.
export const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > max) { req.resume(); return reject(new AppError(413, 'TOO_LARGE', `Request body is larger than ${max} bytes`)); }
    const chunks = [];
    let size = 0, over = false;
    req.on('data', (c) => {
      if (over) return; // keep draining so the 413 can be sent, but keep nothing
      size += c.length;
      if (size > max) { over = true; chunks.length = 0; return reject(new AppError(413, 'TOO_LARGE', `Request body is larger than ${max} bytes`)); }
      chunks.push(c);
    });
    req.on('error', () => reject(new AppError(400, 'BAD_REQUEST', 'Request aborted')));
    req.on('end', () => {
      if (over) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      let parsed;
      try { parsed = JSON.parse(text); } catch { return reject(new AppError(400, 'BAD_JSON', 'Body must be valid JSON')); }
      if (parsed === null || typeof parsed !== 'object') return reject(new AppError(400, 'BAD_JSON', 'Body must be a JSON object'));
      resolve(parsed);
    });
  });
}

function sendJson(res, status, body, cookies = []) {
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * Resolve a URL path to a file inside publicDir, or null. Refuses anything that escapes the folder
 * (.., encoded .., absolute paths, NUL bytes) and hidden files.
 */
export function resolvePublicPath(publicDir, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return null; }
  if (rel.includes('\0') || rel.includes('\\')) return null;
  if (rel === '/' || rel === '') rel = '/index.html';
  const root = resolve(publicDir);
  const file = resolve(root, '.' + rel);
  if (file !== root && !file.startsWith(root + sep)) return null;
  if (file.slice(root.length).split(sep).some((seg) => seg.startsWith('.'))) return null;
  return file;
}

async function serveStatic(req, res, url, publicDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const file = resolvePublicPath(publicDir, url.pathname);
  if (!file) return false;
  const type = TYPES[extname(file).toLowerCase()];
  if (!type) return false;
  try {
    if (!(await stat(file)).isFile()) return false;
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  } catch {
    return false;
  }
}

/** One JSON line per request: id, method, path (no query string), status, duration, caller. */
export const defaultLogger = (entry) => process.stdout.write(JSON.stringify(entry) + '\n');

/**
 * opts: publicDir; authRequired (default: env AUTH_REQUIRED === '1'); logger(entry) (default: silent, the CLI passes defaultLogger);
 * fetch / resolve (webhook delivery, injectable); backgroundJobs (default true: unref'd interval for webhook retries and audit sealing);
 * tenants (default null = single-tenant): true | { dir, maxOpen } | a tenant manager; enables one SQLite file per tenant (docs/tenancy.md);
 * plus any key of src/modules/auth/config.js (rateLimit, loginRateLimit, maxBodyBytes, trustProxy, webhook, lockThreshold, ...).
 */
export function createApp(ctx, { publicDir = PUBLIC_DIR, logger = null, backgroundJobs = true, tenants: tenantOpt = null, ...secOpts } = {}) {
  const c = configure(ctx, secOpts);
  const ownManager = !!tenantOpt && typeof tenantOpt.forRequest !== 'function';
  const tenants = !tenantOpt ? null : typeof tenantOpt.forRequest === 'function' ? tenantOpt : createTenantManager(ctx, tenantOpt === true ? {} : tenantOpt);
  const limiter = new RateLimiter(c.rateLimit);
  const loginLimiter = new RateLimiter(c.loginRateLimit);
  if (c.required) ensureFirstRun(ctx, { log: logger ? (m) => logger({ level: 'info', msg: m }) : console.log, env: c.env });
  const routes = ctx.registry.routes;
  const log = logger ?? (() => {});

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const requestId = newRequestId(req.headers['x-request-id']);
    const h = makeHttp(req, ctx, { requestId });
    let who = null, status = 0;
    res.setHeader('x-request-id', requestId);
    for (const [k, v] of Object.entries(securityHeaders({ secure: isSecureRequest(req, c) }))) res.setHeader(k, v);
    let lease = null;
    res.on('close', () => { lease?.release(); lease = null; });
    res.on('finish', () => {
      status = res.statusCode;
      log({ ts: new Date(started).toISOString(), requestId, method: req.method, path: (req.url ?? '').split('?')[0].slice(0, 200), status, ms: Date.now() - started, ip: h.ip, user: who, via: h.via });
    });
    try {
      const url = new URL(req.url, 'http://localhost');
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));

        // rate limit: per API key if one is presented, else per client IP (healthz is exempt for platform probes)
        if (url.pathname !== '/healthz') {
          const presented = req.headers['x-api-key'] ?? /^Bearer\s+(acck_\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
          const rl = limiter.take(presented ? `key:${sha256Hex(String(presented)).slice(0, 16)}` : `ip:${h.ip}`, ctx.now());
          for (const [k, v] of Object.entries(rateHeaders(rl))) res.setHeader(k, v);
          if (!rl.allowed) throw new AppError(429, 'RATE_LIMITED', 'Too many requests; slow down', { retryAfter: rl.retryAfterSec });
        }
        if (r.isPublic && req.method !== 'GET') {
          checkOrigin(req, ctx);
          if (r.path.startsWith('/api/auth/')) {
            const ll = loginLimiter.take(`login:${h.ip}`, ctx.now());
            if (!ll.allowed) throw new AppError(429, 'RATE_LIMITED', 'Too many sign-in attempts; wait a moment', { retryAfter: ll.retryAfterSec });
          }
        }

        // Tenancy: pick the database this request runs against. Without tenancy (or before a second tenant exists) rctx is ctx.
        let rctx = ctx, early = null;
        const query = Object.fromEntries(url.searchParams);
        if (tenants) {
          if (r.isPublic) {
            if (req.method !== 'GET') early = await readBody(req, c.maxBodyBytes);
            lease = tenants.forPublic(url.pathname, query, early ?? {});
          } else lease = tenants.forRequest(req, h);
          rctx = lease.ctx;
        }

        let user = null;
        if (!r.isPublic) {
          const a = authenticate(rctx, req, h, r);
          user = a.user; h.via = a.via; h.session = a.session; h.apiKey = a.apiKey ?? null;
          who = user.id;
        }
        const body = req.method === 'GET' ? {} : (early ?? await readBody(req, c.maxBodyBytes));
        const okStatus = r.meta.status ?? (req.method === 'POST' ? 201 : 200);
        const out = await withIdempotency(rctx, { req, user, route: r, body, status: okStatus }, () => r.handler(rctx, user, { params, query, body, http: h }));
        if (out.replayed) res.setHeader('idempotency-replayed', 'true');
        if (req.method !== 'GET') { try { sealAudit(rctx); } catch (e) { log({ level: 'error', requestId, msg: `audit seal failed: ${e.message}` }); } }
        return sendJson(res, out.status, out.result, h.cookies);
      }
      if (await serveStatic(req, res, url, publicDir)) return;
      throw new AppError(404, 'NOT_FOUND', 'No such route');
    } catch (e) {
      if (e instanceof AppError) {
        if (e.extra?.retryAfter) res.setHeader('retry-after', String(e.extra.retryAfter));
        if (e.status === 413) { res.setHeader('connection', 'close'); res.on('finish', () => req.socket.destroy()); }
        return sendJson(res, e.status, { error: { code: e.code, message: e.message, ...(e.extra ?? {}), requestId } }, h.cookies);
      }
      // Never leak internals: the client gets a request id, the log gets the stack.
      log({ level: 'error', requestId, msg: String(e?.stack ?? e) });
      if (!logger) console.error(e);
      sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Unexpected error', requestId } });
    }
  });

  if (ownManager) server.on('close', () => { try { tenants.close(); } catch { /* already closed */ } });
  if (backgroundJobs) {
    let timer;
    const tick = async () => {
      try {
        const job = async (tctx) => {
          try {
            sealAudit(tctx);
            await processDeliveries(tctx, { fetchImpl: c.fetch ?? globalThis.fetch, resolve: c.resolve });
          } catch (e) { log({ level: 'error', msg: `background job failed${tctx.tenant ? ` (tenant ${tctx.tenant.slug})` : ''}: ${e.message}` }); }
        };
        if (tenants) await tenants.forEachActive(job); else await job(ctx); // every tenant is visited explicitly
      } catch (e) { log({ level: 'error', msg: `background job failed: ${e.message}` }); }
    };
    server.on('listening', () => { timer = setInterval(tick, c.webhook.intervalMs); timer.unref(); });
    server.on('close', () => clearInterval(timer));
    server.runBackgroundJobs = tick; // tests and operators can trigger one pass
  }
  return server;
}

/**
 * Open the database (running migrations), load the modules, sync built-in roles, run pending reference seeds
 * (chart of accounts, settings, the owner placeholder). Demo data (demo users, items, customers, opening balance,
 * demo credentials) is added only with `{ demo: true }`: see initContext in src/modules.js.
 */
export function createSeededContext(path = ':memory:', registry = defaultRegistry, opts = {}) {
  return initContext(createContext(openDb(path), registry), registry, opts);
}

/** Reference seeds plus the demo data set. What tests, the demo switcher and `SEED_DEMO=1` / `--demo` use. */
export const createDemoContext = (path = ':memory:', registry = defaultRegistry) => createSeededContext(path, registry, { demo: true });

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  const tenants = process.env.TENANTS_DIR ? { dir: process.env.TENANTS_DIR, maxOpen: Number(process.env.TENANT_MAX_OPEN) || 50 } : null;
  // Demo data is opt-in: SEED_DEMO=1 or --demo. Without it a new database holds reference data only (docs/ARCHITECTURE.md, "Seeds").
  const demo = process.env.SEED_DEMO === '1' || process.argv.includes('--demo');
  createApp(createSeededContext(process.env.DB_PATH ?? ':memory:', defaultRegistry, { demo }), { logger: process.env.REQUEST_LOG === '0' ? null : defaultLogger, tenants }).listen(port, () => {
    console.log(`Accounting PoC running at http://localhost:${port} (${process.env.AUTH_REQUIRED === '1' ? 'sign-in REQUIRED' : (demo ? 'demo mode: x-user-id identity, demo data and credentials seeded' : 'demo mode: x-user-id identity, reference data only; SEED_DEMO=1 adds demo data')}${tenants ? `, multi-tenant: one database per company in ${tenants.dir}` : ''})`);
  });
}
