// Same API as full mode. Identity: demo user switcher (x-user-id) when /api/demo-users lists users, otherwise the session cookie
// plus the CSRF token from /api/auth/me. Writes carry an Idempotency-Key so a double tap or a retry never posts twice.
import { createQueue, idbStorage, memoryStorage, newKey } from '/offline-queue.js';

export const session = { users: [], userId: null, csrf: null };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked: preference is simply not kept */ } },
};
export { store, newKey };

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'ERROR', details } = {}) { super(message); this.status = status; this.code = code; this.details = details; }
}

export async function init() {
  try { session.users = await (await fetch('/api/demo-users')).json(); } catch { session.users = []; }
  if (!Array.isArray(session.users)) session.users = [];
  if (session.users.length) {
    const saved = Number(store.get('acct.simple.user'));
    session.userId = session.users.some((u) => u.id === saved) ? saved : (session.users.find((u) => u.role === 'owner') ?? session.users[0]).id;
  } else {
    try { const me = await call('GET', '/api/auth/me'); session.csrf = me.csrfToken ?? null; } catch { /* AUTH_REQUIRED is surfaced by the first real call */ }
  }
}
export function setUser(id) { session.userId = Number(id); store.set('acct.simple.user', String(id)); }
export const identity = () => (session.users.length ? `demo:${session.userId}` : 'session');
export const authHeaders = () => ({ ...(session.users.length ? { 'x-user-id': String(session.userId) } : {}), ...(session.csrf ? { 'x-csrf-token': session.csrf } : {}) });

export async function call(method, path, body, key) {
  const headers = { 'content-type': 'application/json', ...authHeaders(), ...(key ? { 'idempotency-key': key } : {}) };
  let res;
  try { res = await fetch(path, { method, headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new ApiError('offline', { code: 'NETWORK' }); }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!res.ok) throw new ApiError(data.error?.message ?? `Error ${res.status}`, { status: res.status, code: data.error?.code ?? `HTTP_${res.status}`, details: data.error?.details });
  return data;
}
export const get = (path) => call('GET', path);
export const post = (path, body, key) => call('POST', path, body, key ?? newKey());

// Offline: the same IndexedDB queue as full mode (public/offline-queue.js), so a cash sale made here shows on the full-mode Offline page.
let _queue;
export function queue(onChange = () => {}) {
  if (_queue) return _queue;
  let storage;
  try { storage = globalThis.indexedDB ? idbStorage(globalThis.indexedDB) : memoryStorage(); } catch { storage = memoryStorage(); }
  _queue = createQueue({ storage, fetch: (...a) => fetch(...a), getHeaders: authHeaders, getIdentity: identity, onChange });
  return _queue;
}
