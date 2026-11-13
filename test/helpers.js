import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemoContext } from '../src/server.js';
import { loadUser } from '../src/permissions.js';

export const IDS = { owner: 1, manager: 2, clerk: 3, accountant: 4, auditor: 5, admin: 6 };

export function setup() {
  const ctx = createDemoContext();
  const as = (name) => loadUser(ctx, IDS[name]);
  return { ctx, as };
}

export function expectError(fn, code) {
  let err;
  try { fn(); } catch (e) { err = e; }
  if (!err) throw new Error(`Expected error ${code}, but nothing was thrown`);
  if (err.code !== code) throw new Error(`Expected error ${code}, got ${err.code}: ${err.message}`);
  return err;
}

/** A temp folder usable as an extra modules dir: { 'fake/index.js': source, ... }. */
export function tempModules(files) {
  const dir = mkdtempSync(join(tmpdir(), 'poc-mods-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

/** Start the app on a random port; returns { server, base, call(method, path, userId, body) }. */
export async function startApp(createApp, ctx, opts) {
  const server = createApp(ctx, opts);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, userId, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(userId ? { 'x-user-id': String(userId) } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { server, base, call };
}
