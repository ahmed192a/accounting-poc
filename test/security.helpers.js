import { createApp, createDemoContext } from '../src/server.js';
import { DEMO_PASSWORD } from '../src/modules/auth/service.js';

export { DEMO_PASSWORD };
export const OWNER_PW = 'Correct-Horse-Battery-9';

/**
 * Start the app on a random port with a tiny cookie-jar client.
 * required: true  -> AUTH_REQUIRED mode with INITIAL_OWNER_PASSWORD (owner@example.test / OWNER_PW).
 * The client sends x-csrf-token automatically from the last login unless `csrf: false` is passed.
 */
export async function boot({ required = false, env = {}, ...opts } = {}) {
  const fullEnv = required ? { AUTH_REQUIRED: '1', INITIAL_OWNER_EMAIL: 'owner@example.test', INITIAL_OWNER_PASSWORD: OWNER_PW, ...env } : { ...env };
  const logs = [];
  const ctx = createDemoContext();
  const server = createApp(ctx, { backgroundJobs: false, loginRateLimit: { capacity: 1000, perMinute: 1000 }, env: fullEnv, authRequired: required, logger: (e) => logs.push(e), ...opts });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map();
  const state = { csrf: null };

  async function call(method, path, { body, as, key, headers = {}, csrf, cookies = true, raw } = {}) {
    const h = { ...headers };
    if (body !== undefined || raw !== undefined) h['content-type'] = 'application/json';
    if (as) h['x-user-id'] = String(as);
    if (key) h.authorization = `Bearer ${key}`;
    if (cookies && jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const token = csrf === undefined ? state.csrf : csrf;
    if (token) h['x-csrf-token'] = token;
    const res = await fetch(base + path, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (/Max-Age=0/i.test(sc) || v === '') jar.delete(k); else jar.set(k, v);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text, headers: res.headers, setCookie: res.headers.getSetCookie() };
  }

  async function login(email, password, extra = {}) {
    const r = await call('POST', '/api/auth/login', { body: { email, password, ...extra }, csrf: false });
    if (r.status === 200) state.csrf = r.body.csrfToken;
    return r;
  }
  const loginOwner = () => login('owner@example.test', OWNER_PW);
  const close = () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
  return { ctx, server, base, call, login, loginOwner, jar, state, logs, close };
}

/** Invite a user through the API as the signed-in client, accept the invite, return their credentials. */
export async function addUser(app, { name, email, roleId, password = 'Another-Strong-Pass-7' }) { // secret-scan:ignore test fixture
  const inv = await app.call('POST', '/api/auth/users', { body: { name, email, roleId } });
  if (inv.status !== 201) throw new Error(`invite failed: ${inv.text}`);
  const acc = await app.call('POST', '/api/auth/accept-invite', { body: { token: inv.body.inviteToken, password }, csrf: false });
  if (acc.status !== 200) throw new Error(`accept failed: ${acc.text}`);
  return { id: inv.body.id, email, password };
}

export const roleId = (ctx, name) => ctx.db.prepare('SELECT id FROM roles WHERE name = ?').get(name).id;
