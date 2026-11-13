// api(): same-origin credentials, optional CSRF token, offline-queue hooks, 401 AUTH_REQUIRED -> login screen.
import { state } from '/core/state.js';
import { t } from '/core/i18n.js';
import { App } from '/core/host.js';
import { showLogin } from '/core/login.js';
import { tracked } from '/core/ready.js';

export const api = (method, path, body) => tracked(() => request(method, path, body));

async function request(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (state.users.length) headers['x-user-id'] = String(state.userId); // demo identity switcher only
  if (App.csrfToken && method !== 'GET' && method !== 'HEAD') headers['x-csrf-token'] = App.csrfToken;
  const idemKey = App.offlineKey?.(method, path); // offline module: Idempotency-Key for queueable writes, so a retry/replay never double-posts
  if (idemKey) headers['idempotency-key'] = idemKey;
  let res;
  try {
    res = await fetch(path, { method, headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined });
  } catch {
    const queued = idemKey && App.offlineWrite ? await App.offlineWrite(method, path, body, idemKey) : null; // saved on this device, sent when back online
    if (queued) return queued;
    const e = new Error(t('sh.offlineShort')); e.code = 'NETWORK'; throw e;
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!res.ok) {
    const e = new Error(data.error?.message ?? `Error ${res.status}`); e.code = data.error?.code; e.status = res.status;
    if (res.status === 401 && e.code === 'AUTH_REQUIRED') showLogin();
    throw e;
  }
  return data;
}
