#!/usr/bin/env node
// Deploy check: start the real server on a port, hit /healthz, / and /api/ui-modules and require HTTP 200.
// Usage: node scripts/smoke-server.js [port]   (default: SMOKE_PORT or 3199). Exit 1 on any failure.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PATHS = ['/healthz', '/', '/api/ui-modules'];

/** Fetch each path; returns [{ path, status, ok }]. A network error counts as status 0. */
export async function probe(base, paths = PATHS, fetchImpl = fetch) {
  const out = [];
  for (const path of paths) {
    let status = 0;
    try { status = (await fetchImpl(base + path, { signal: AbortSignal.timeout(5000) })).status; } catch { /* status stays 0 */ }
    out.push({ path, status, ok: status === 200 });
  }
  return out;
}

export async function waitFor(base, tries = 100, delayMs = 100, fetchImpl = fetch) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetchImpl(base + '/healthz')).status === 200) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function main() {
  const port = process.argv[2] ?? process.env.SMOKE_PORT ?? '3199';
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['--no-warnings', 'src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: port }, stdio: ['ignore', 'inherit', 'inherit'] });
  let code = 1;
  try {
    if (!(await waitFor(base))) console.error('Server did not become healthy in time');
    else {
      const results = await probe(base);
      for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} GET ${r.path} -> ${r.status}`);
      code = results.every((r) => r.ok) ? 0 : 1;
    }
  } finally { server.kill(); }
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
