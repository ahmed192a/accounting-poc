// Idempotency-Key support for write requests (offline queue replay, flaky-network retries).
//
// Contract (modelled on the common "Idempotency-Key" HTTP header convention; the IETF draft is not final):
//  - Only authenticated, non-GET requests that carry an `Idempotency-Key` header are affected. No header = unchanged behaviour.
//  - A key is scoped to (user, method, path) so one user's key can never replay another user's response.
//  - First request with a key runs the handler. A 2xx result is stored (request hash, status, response body, response hash) for 24h.
//  - A repeat with the same key and the same body returns the ORIGINAL status and body and sets `Idempotency-Replayed: true`; the handler is not run again.
//  - Same key but a different body/path/method: 422 IDEMPOTENCY_KEY_REUSED (a client bug; never guess).
//  - Same key while the first request is still running: 409 IDEMPOTENCY_IN_PROGRESS (client retries shortly).
//  - Failed requests (4xx/5xx, thrown errors) are NOT stored, so the client may fix the problem and retry with the same key.
// Known limit: the stored record is written right after the handler's own transaction commits, not inside it. A process crash in
// that instant would let a retry run twice. Closing that gap needs the key insert inside the handler transaction (shared-file change).
import { createHash } from 'node:crypto';
import { AppError } from './errors.js';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const ready = new WeakSet();
const inflight = new Set();
const purgedAt = new WeakMap();

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Stable JSON: object keys sorted, so {a:1,b:2} and {b:2,a:1} hash equal. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

function ensureTable(db) {
  if (ready.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS idempotency_keys (
    scope_hash TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    status INTEGER NOT NULL,
    response_json TEXT NOT NULL,
    response_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at)');
  ready.add(db);
}

/** Delete expired records (at most once a minute per database). Returns the number removed. */
export function purgeExpired(ctx) {
  ensureTable(ctx.db);
  const now = ctx.now();
  if (now - (purgedAt.get(ctx.db) ?? 0) < 60_000) return 0;
  purgedAt.set(ctx.db, now);
  return Number(ctx.db.prepare('DELETE FROM idempotency_keys WHERE expires_at <= ?').run(now).changes);
}

/**
 * Wrap one route execution. `run()` returns the JSON result; the wrapper returns `{ result, replayed, status }`.
 * req: Node request (reads the header); user: authenticated user or null; route: { method, path }; body: parsed JSON body.
 */
export async function withIdempotency(ctx, { req, user, route, body, status = 200 }, run) {
  const raw = req.headers['idempotency-key'];
  if (raw === undefined || !user || req.method === 'GET' || req.method === 'HEAD') return { result: await run(), replayed: false, status };
  const key = String(raw).trim();
  if (!KEY_RE.test(key)) throw new AppError(400, 'BAD_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8-128 characters: letters, digits, . _ : -');
  ensureTable(ctx.db);
  purgeExpired(ctx);
  const url = new URL(req.url, 'http://localhost');
  const scope = sha256(`${user.id}\n${req.method}\n${route.path}\n${key}`);
  const requestHash = sha256(canonicalJson({ m: req.method, p: url.pathname + url.search, b: body ?? {} }));
  const now = ctx.now();
  const hit = ctx.db.prepare('SELECT * FROM idempotency_keys WHERE scope_hash = ? AND expires_at > ?').get(scope, now);
  if (hit) {
    if (hit.request_hash !== requestHash) throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
    return { result: JSON.parse(hit.response_json), replayed: true, status: hit.status };
  }
  if (inflight.has(scope)) throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed; retry shortly');
  inflight.add(scope);
  try {
    const result = await run();
    const json = JSON.stringify(result ?? null);
    ctx.db.prepare('INSERT OR REPLACE INTO idempotency_keys (scope_hash, request_hash, status, response_json, response_hash, created_at, expires_at) VALUES (?,?,?,?,?,?,?)')
      .run(scope, requestHash, status, json, sha256(json), now, now + IDEMPOTENCY_TTL_MS);
    return { result, replayed: false, status };
  } finally { inflight.delete(scope); }
}
