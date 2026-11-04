import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, createSeededContext, PUBLIC_DIR, resolvePublicPath } from '../src/server.js';
import { startApp } from './helpers.js';

// fetch() normalises ".." away, so traversal attempts go through a raw request.
const raw = (base, path) => new Promise((resolve, reject) => {
  const u = new URL(base);
  http.get({ host: u.hostname, port: u.port, path }, (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: data }));
  }).on('error', reject);
});

test('static: the shell, app.js, style.css and every UI module are served with the right content type', async () => {
  const { server, base } = await startApp(createApp, createSeededContext());
  try {
    const type = async (p) => { const r = await fetch(base + p); return [r.status, r.headers.get('content-type')]; };
    assert.deepEqual(await type('/'), [200, 'text/html; charset=utf-8']);
    assert.deepEqual(await type('/index.html'), [200, 'text/html; charset=utf-8']);
    assert.deepEqual(await type('/app.js'), [200, 'text/javascript; charset=utf-8']);
    assert.deepEqual(await type('/style.css'), [200, 'text/css; charset=utf-8']);
    for (const f of readdirSync(join(PUBLIC_DIR, 'modules'))) assert.deepEqual(await type('/modules/' + f), [200, 'text/javascript; charset=utf-8']);
    assert.match(await (await fetch(base + '/')).text(), /type="module" src="\/app\.js"/);
  } finally { server.close(); }
});

test('static: GET /api/ui-modules is public and lists the files in public/modules', async () => {
  const { server, call } = await startApp(createApp, createSeededContext());
  try {
    const r = await call('GET', '/api/ui-modules'); // no user header
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, readdirSync(join(PUBLIC_DIR, 'modules')).filter((f) => f.endsWith('.js')).sort());
    for (const f of ['sales.js', 'purchases.js', 'ledger.js', 'eta.js', 'audit.js', 'admin.js', 'home-stats.js']) assert.ok(r.body.includes(f), f);
  } finally { server.close(); }
});

test('static: json, svg and png are served with correct types; unknown extensions and missing files are 404', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'poc-pub-'));
  try {
    writeFileSync(join(dir, 'index.html'), '<p>hi</p>');
    writeFileSync(join(dir, 'a.json'), '{"a":1}');
    writeFileSync(join(dir, 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(dir, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(dir, 'a.exe'), 'nope');
    writeFileSync(join(dir, '.secret.json'), '{}');
    mkdirSync(join(dir, 'sub'));
    const { server, base } = await startApp(createApp, createSeededContext(), { publicDir: dir });
    try {
      const get = async (p) => { const r = await fetch(base + p); return [r.status, r.headers.get('content-type')]; };
      assert.deepEqual(await get('/a.json'), [200, 'application/json; charset=utf-8']);
      assert.deepEqual(await get('/a.svg'), [200, 'image/svg+xml']);
      assert.deepEqual(await get('/a.png'), [200, 'image/png']);
      assert.equal((await get('/a.exe'))[0], 404);
      assert.equal((await get('/nope.js'))[0], 404);
      assert.equal((await get('/sub'))[0], 404);
      assert.equal((await get('/.secret.json'))[0], 404, 'dotfiles are never served');
      const png = await fetch(base + '/a.png');
      assert.equal((await png.arrayBuffer()).byteLength, 4);
      const post = await fetch(base + '/a.json', { method: 'POST', body: '{}' });
      assert.equal(post.status, 404, 'static files are GET/HEAD only');
    } finally { server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('static: path traversal cannot escape public/', async () => {
  const { server, base } = await startApp(createApp, createSeededContext());
  try {
    for (const p of [
      '/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/%2e%2e%2fsrc/server.js', '/modules/../../package.json',
      '/modules/%2e%2e/%2e%2e/src/db.js', '/..\\package.json', '/%00', '/%2e%2e%5cpackage.json', '/%', '//etc/passwd',
    ]) {
      const r = await raw(base, p);
      assert.notEqual(r.status, 200, `${p} must not be served`);
      assert.ok(!r.body.includes('"accounting-poc"') && !r.body.includes('createApp'), `${p} leaked a file`);
    }
  } finally { server.close(); }
  const pub = '/srv/app/public';
  assert.equal(resolvePublicPath(pub, '/../secret'), null);
  assert.equal(resolvePublicPath(pub, '/a/../../secret'), null);
  assert.equal(resolvePublicPath(pub, '/%2e%2e/secret'), null);
  assert.equal(resolvePublicPath(pub, '/ok.js'), '/srv/app/public/ok.js');
  assert.equal(resolvePublicPath(pub, '/'), '/srv/app/public/index.html');
});
