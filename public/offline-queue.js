// Offline write queue: pure logic with injected storage and fetch, so node:test can drive it without a browser.
// The browser wiring (IndexedDB, navigator.onLine, UI) lives in public/modules/offline.js.
//
// Item: { id, key, identity, method, path, body, label, status: 'pending'|'failed', attempts, createdAt, error, lastAttemptAt }
// - `key` is the Idempotency-Key sent on every attempt, so a request whose response was lost is never posted twice (src/idempotency.js).
// - Replay is strictly in creation order. A network error, 401, 429, 408 or 5xx STOPS the run (items stay pending, nothing is lost).
//   Any other 4xx is a business conflict: the item becomes `failed` with the server's reason and the run continues with the next item.

/** Writes that may be queued while offline. Everything else (voids, approvals, edits) needs a connection on purpose. */
export const QUEUEABLE = [
  { method: 'POST', re: /^\/api\/sales\/quick$/, kind: 'sale' },
  { method: 'POST', re: /^\/api\/invoices$/, kind: 'invoice' },
  { method: 'POST', re: /^\/api\/bills$/, kind: 'bill' },
  { method: 'POST', re: /^\/api\/customers$/, kind: 'customer' },
];
export const MAX_QUEUE = 200;

export function queueKind(method, path) {
  const p = String(path).split('?')[0];
  return QUEUEABLE.find((q) => q.method === String(method).toUpperCase() && q.re.test(p))?.kind ?? null;
}

export function newKey(cryptoImpl = globalThis.crypto) {
  if (cryptoImpl?.randomUUID) return cryptoImpl.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Delay before the next automatic sync attempt: 2s, 4s, 8s ... capped at 60s. */
export const backoffMs = (attempts) => Math.min(60_000, 2000 * 2 ** Math.max(0, Math.min(attempts, 10) - 1));

export class QueueError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function memoryStorage() {
  const rows = new Map(); let seq = 0;
  return {
    async getAll() { return [...rows.values()].map((r) => structuredClone(r)).sort((a, b) => a.id - b.id); },
    async add(item) { const id = ++seq; rows.set(id, { ...structuredClone(item), id }); return id; },
    async update(item) { if (!rows.has(item.id)) throw new Error('missing'); rows.set(item.id, structuredClone(item)); },
    async remove(id) { rows.delete(id); },
  };
}

/** IndexedDB-backed storage. `idb` is the IDBFactory (window.indexedDB). */
export function idbStorage(idb, name = 'acct-offline') {
  let dbp;
  const open = () => (dbp ??= new Promise((resolve, reject) => {
    const req = idb.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction('queue', mode);
      let out;
      const r = fn(t.objectStore('queue'));
      r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  };
  return {
    getAll: async () => (await run('readonly', (s) => s.getAll())).sort((a, b) => a.id - b.id),
    add: (item) => { const { id: _drop, ...rest } = item; return run('readwrite', (s) => s.add(rest)); },
    update: (item) => run('readwrite', (s) => s.put(item)),
    remove: (id) => run('readwrite', (s) => s.delete(id)),
  };
}

/**
 * opts: storage, fetch, now (ms), uuid(), getHeaders() -> extra auth headers (x-user-id, x-csrf-token),
 *       getIdentity() -> string; items only replay for the identity that queued them, onChange(), maxItems.
 */
export function createQueue({ storage, fetch: fetchImpl, now = () => Date.now(), uuid = newKey, getHeaders = () => ({}), getIdentity = () => 'default', onChange = () => {}, maxItems = MAX_QUEUE } = {}) {
  if (!storage || typeof fetchImpl !== 'function') throw new Error('createQueue needs { storage, fetch }');
  let syncing = null;
  const changed = () => { try { onChange(); } catch { /* UI errors must not break the queue */ } };
  const mine = (all) => all.filter((i) => i.identity === getIdentity());
  const find = async (id) => (await storage.getAll()).find((i) => i.id === id);

  async function enqueue({ method = 'POST', path, body = {}, label = '', key }) {
    const kind = queueKind(method, path);
    if (!kind) throw new QueueError('NOT_QUEUEABLE', `${method} ${path} cannot be saved offline`);
    let clean;
    try { clean = JSON.parse(JSON.stringify(body ?? {})); } catch { throw new QueueError('BAD_BODY', 'Body must be JSON'); }
    if (clean === null || typeof clean !== 'object' || Array.isArray(clean)) throw new QueueError('BAD_BODY', 'Body must be a JSON object');
    if ((await storage.getAll()).length >= maxItems) throw new QueueError('QUEUE_FULL', `At most ${maxItems} offline changes can wait; connect and sync first`);
    const item = { key: key || uuid(), identity: getIdentity(), method: String(method).toUpperCase(), path, body: clean, label: label || kind, kind, status: 'pending', attempts: 0, createdAt: now(), error: null, lastAttemptAt: null };
    item.id = await storage.add(item);
    changed();
    return item;
  }

  const list = async () => mine(await storage.getAll());
  const counts = async () => {
    const l = await list();
    return { pending: l.filter((i) => i.status === 'pending').length, failed: l.filter((i) => i.status === 'failed').length, total: l.length };
  };

  async function attempt(item) {
    const headers = { 'content-type': 'application/json', ...getHeaders(), 'idempotency-key': item.key };
    item.attempts += 1; item.lastAttemptAt = now();
    await storage.update(item);
    let res;
    try { res = await fetchImpl(item.path, { method: item.method, headers, credentials: 'same-origin', body: JSON.stringify(item.body) }); }
    catch { return { outcome: 'network' }; }
    const text = await res.text().catch(() => '');
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    if (res.ok) return { outcome: 'ok', data, replayed: res.headers?.get?.('idempotency-replayed') === 'true' };
    const err = { status: res.status, code: data?.error?.code ?? `HTTP_${res.status}`, message: data?.error?.message ?? `Server answered ${res.status}` };
    if (res.status === 401) return { outcome: 'auth', err };
    if (res.status === 408 || res.status === 429 || res.status >= 500 || (res.status === 409 && err.code === 'IDEMPOTENCY_IN_PROGRESS')) {
      return { outcome: 'retryable', err, retryAfterMs: Number(res.headers?.get?.('retry-after')) * 1000 || null };
    }
    return { outcome: 'conflict', err };
  }

  /** Replay pending items in order. Concurrent calls share one run. Returns { synced, failed, remaining, stopped, retryAfterMs }. */
  function sync() {
    if (syncing) return syncing;
    syncing = (async () => {
      const summary = { synced: [], failed: [], remaining: 0, stopped: null, retryAfterMs: null };
      try {
        for (const item of (await list()).filter((i) => i.status === 'pending')) {
          const r = await attempt(item);
          if (r.outcome === 'ok') { await storage.remove(item.id); summary.synced.push({ id: item.id, kind: item.kind, label: item.label, response: r.data, replayed: r.replayed }); changed(); continue; }
          if (r.outcome === 'conflict') {
            item.status = 'failed'; item.error = r.err; await storage.update(item); summary.failed.push({ id: item.id, label: item.label, error: r.err }); changed(); continue;
          }
          item.error = r.err ?? null; await storage.update(item); // network / auth / retryable: keep pending, stop the run (order matters)
          summary.stopped = r.outcome; summary.retryAfterMs = r.retryAfterMs ?? null;
          break;
        }
      } finally { syncing = null; }
      summary.remaining = (await counts()).pending;
      changed();
      return summary;
    })();
    return syncing;
  }

  async function retry(id) {
    const it = await find(id);
    if (!it || it.identity !== getIdentity()) throw new QueueError('NOT_FOUND', 'No such queued change');
    if (it.status !== 'failed') throw new QueueError('NOT_FAILED', 'Only failed changes can be retried');
    it.status = 'pending'; it.error = null; await storage.update(it); changed();
    return it;
  }
  /** Replace the body of a failed (or pending) item. A new idempotency key is issued because it is a different request now. */
  async function edit(id, body) {
    const it = await find(id);
    if (!it || it.identity !== getIdentity()) throw new QueueError('NOT_FOUND', 'No such queued change');
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new QueueError('BAD_BODY', 'Body must be a JSON object');
    it.body = JSON.parse(JSON.stringify(body)); it.key = uuid(); it.status = 'pending'; it.error = null; it.attempts = 0;
    await storage.update(it); changed();
    return it;
  }
  async function discard(id) {
    const it = await find(id);
    if (!it || it.identity !== getIdentity()) throw new QueueError('NOT_FOUND', 'No such queued change');
    await storage.remove(id); changed();
  }

  return { enqueue, list, counts, sync, retry, edit, discard, isSyncing: () => !!syncing };
}
