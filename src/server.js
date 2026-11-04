import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, sep, extname } from 'node:path';
import { openDb, createContext } from './db.js';
import { defaultRegistry, initContext } from './modules.js';
import { AppError } from './errors.js';
import { loadUser } from './permissions.js';

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

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
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
    res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  } catch {
    return false;
  }
}

export function createApp(ctx, { publicDir = PUBLIC_DIR } = {}) {
  const routes = ctx.registry.routes;
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
        const body = req.method === 'GET' ? {} : await readBody(req);
        // PoC identification only: a header names the user. Real auth (sessions + MFA) comes later.
        const user = r.isPublic ? null : loadUser(ctx, Number(req.headers['x-user-id']));
        const result = r.handler(ctx, user, { params, query: Object.fromEntries(url.searchParams), body });
        return sendJson(res, req.method === 'POST' ? 201 : 200, result);
      }
      if (await serveStatic(req, res, url, publicDir)) return;
      throw new AppError(404, 'NOT_FOUND', 'No such route');
    } catch (e) {
      if (e instanceof AppError) return sendJson(res, e.status, { error: { code: e.code, message: e.message, ...(e.extra ?? {}) } });
      console.error(e);
      sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Unexpected error' } });
    }
  });
}

/** Open the database (running migrations), load the modules, sync built-in roles, run pending seeds. */
export function createSeededContext(path = ':memory:', registry = defaultRegistry) {
  return initContext(createContext(openDb(path), registry), registry);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  createApp(createSeededContext(process.env.DB_PATH ?? ':memory:')).listen(port, () => {
    console.log(`Accounting PoC running at http://localhost:${port}`);
  });
}
