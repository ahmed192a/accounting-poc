import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, createSeededContext } from '../src/server.js';

export const OP_EMAIL = 'platform-op@example.test';
export const OP_PW = 'Operator-Horse-Battery-9';       // secret-scan:ignore test fixture
export const PW = 'Tenant-Strong-Pass-2026-x';          // secret-scan:ignore test fixture

/** A cookie-jar HTTP client for one browser/session. */
export function client(base) {
  const jar = new Map();
  const state = { csrf: null };
  async function call(method, path, { body, as, key, headers = {} } = {}) {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (as) h['x-user-id'] = String(as);
    if (key) h.authorization = `Bearer ${key}`;
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (state.csrf) h['x-csrf-token'] = state.csrf;
    const res = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (/Max-Age=0/i.test(sc) || v === '') jar.delete(k); else jar.set(k, v);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, code: json?.error?.code };
  }
  async function login(email, password, extra = {}) {
    state.csrf = null;
    const r = await call('POST', '/api/auth/login', { body: { email, password, ...extra } });
    if (r.status === 200) state.csrf = r.body.csrfToken;
    return r;
  }
  return { call, login, jar, state };
}

/**
 * Boot an app with tenancy enabled. required (default true) = AUTH_REQUIRED mode with a default-tenant owner (OP_EMAIL / OP_PW),
 * who is the platform operator. dir: tenants folder (default a fresh temp dir).
 */
export async function bootTenancy({ required = true, dir = mkdtempSync(join(tmpdir(), 'poc-tenants-')), maxOpen, ctx = createSeededContext(), ...opts } = {}) {
  const env = required ? { AUTH_REQUIRED: '1', INITIAL_OWNER_EMAIL: OP_EMAIL, INITIAL_OWNER_PASSWORD: OP_PW } : {};
  const server = createApp(ctx, {
    backgroundJobs: true, env, authRequired: required, tenants: { dir, ...(maxOpen ? { maxOpen } : {}) },
    rateLimit: { capacity: 100000, perMinute: 100000 }, loginRateLimit: { capacity: 1000, perMinute: 1000 }, ...opts,
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
  const operator = client(base);
  if (required) {
    const r = await operator.login(OP_EMAIL, OP_PW);
    if (r.status !== 200) throw new Error('operator login failed: ' + JSON.stringify(r.body));
  }
  const provision = async (slug, email, extra = {}) => {
    const r = await operator.call('POST', '/api/tenants', { as: required ? undefined : 1, body: { slug, name: `${slug} Trading`, ownerEmail: email, ownerPassword: PW, ...extra } });
    if (r.status !== 201) throw new Error(`provision ${slug} failed: ${JSON.stringify(r.body)}`);
    return r;
  };
  return { ctx, server, base, dir, close, operator, provision, tenants: ctx.tenants, client: () => client(base) };
}
