// Client layout: the shell is ES modules under public/core and public/ui (no bundler). These checks keep the
// service worker's offline asset list, the import graph and the readiness signal from drifting apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PUBLIC = new URL('../public/', import.meta.url).pathname;
const files = (dir) => readdirSync(join(PUBLIC, dir)).filter((f) => f.endsWith('.js')).map((f) => `/${dir}/${f}`);
const NOT_SHELL = new Set(['/lib/contrast.js']); // QA-only helper, never loaded by the app
const shell = ['/app.js', ...files('core'), ...files('ui'), ...files('lib')].filter((f) => !NOT_SHELL.has(f));

test('service worker precaches every shell file, so the installed app opens offline', () => {
  const sw = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');
  const list = sw.slice(sw.indexOf('const PRECACHE'), sw.indexOf('const STATIC_EXT'));
  const cached = new Set([...list.matchAll(/'(\/[^']*)'/g)].map((m) => m[1]));
  for (const f of shell) assert.ok(cached.has(f), `${f} is missing from PRECACHE in public/sw.js`);
  for (const f of cached) if (f.endsWith('.js')) assert.ok(existsSync(join(PUBLIC, f)), `PRECACHE lists ${f}, which does not exist`);
});

test('every absolute import in the shell resolves to a file', () => {
  for (const f of shell) {
    const src = readFileSync(join(PUBLIC, f), 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*'(\/[^']+\.js)'/g)) assert.ok(existsSync(join(PUBLIC, m[1])), `${f} imports ${m[1]}, which does not exist`);
  }
});

test('app.js is only the entry point and index.html still loads it as a module', () => {
  assert.ok(readFileSync(join(PUBLIC, 'app.js'), 'utf8').split('\n').length < 30);
  assert.match(readFileSync(join(PUBLIC, 'index.html'), 'utf8'), /<script type="module" src="\/app\.js"><\/script>/);
});

test('readiness signal: data-ready, window.__appReady and App.ready exist and boot marks readiness', () => {
  const ready = readFileSync(join(PUBLIC, 'core/ready.js'), 'utf8');
  assert.match(ready, /dataset\.ready =/);
  assert.match(ready, /window\.__appReady = true/);
  assert.match(readFileSync(join(PUBLIC, 'core/boot.js'), 'utf8'), /markReady\(/);
  assert.match(readFileSync(join(PUBLIC, 'core/app.js'), 'utf8'), /\bready,/);
});
