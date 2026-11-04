import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLcov, evaluate, toMarkdown, thresholdsFromEnv, DEFAULT_THRESHOLDS } from '../scripts/coverage-check.js';
import { buildOpenApi, toOpenApiPath, generate } from '../scripts/openapi.js';
import { scanSecrets, checkDependencies, checkMigrationNames, hasDefaultExport, runChecks } from '../scripts/check-repo.js';
import { loadModules, MODULES_DIR } from '../src/modules.js';

const LCOV = `SF:src/a.js
FNF:2
FNH:1
BRF:4
BRH:2
LF:10
LH:9
end_of_record
SF:test/a.test.js
LF:100
LH:1
end_of_record
SF:src/b.js
FNF:0
FNH:0
BRF:0
BRH:0
LF:10
LH:10
end_of_record
`;

test('coverage: parseLcov totals only src/ files and treats empty denominators as 100', () => {
  const t = parseLcov(LCOV);
  assert.equal(t.files, 2);
  assert.equal(t.lines, 95);
  assert.equal(t.branches, 50);
  assert.equal(t.functions, 50);
});

test('coverage: evaluate passes at the threshold and fails below it', () => {
  const ok = evaluate({ files: 1, lines: 92, branches: 82, functions: 78 });
  assert.equal(ok.ok, true);
  const bad = evaluate({ files: 1, lines: 91.9, branches: 90, functions: 90 });
  assert.equal(bad.ok, false);
  assert.match(bad.failures[0], /lines/);
  assert.equal(evaluate({ files: 0, lines: 100, branches: 100, functions: 100 }).ok, false);
});

test('coverage: markdown summary names status and thresholds; env overrides thresholds', () => {
  const t = parseLcov(LCOV);
  const r = evaluate(t, DEFAULT_THRESHOLDS);
  const md = toMarkdown(t, DEFAULT_THRESHOLDS, r);
  assert.match(md, /FAILED/);
  assert.match(md, /\| branches \| 50% \|/);
  assert.equal(thresholdsFromEnv({ COV_MIN_LINES: '50', COV_MIN_BRANCHES: 'x' }).lines, 50);
  assert.equal(thresholdsFromEnv({ COV_MIN_BRANCHES: 'x' }).branches, DEFAULT_THRESHOLDS.branches);
});

test('openapi: path parameter conversion', () => {
  assert.equal(toOpenApiPath('/api/a/:id/b/:sub'), '/api/a/{id}/b/{sub}');
});

test('openapi: generates a document from the real module registry', async () => {
  const reg = await loadModules(MODULES_DIR);
  const doc = buildOpenApi(reg);
  assert.equal(doc.openapi, '3.0.3');
  const ops = Object.values(doc.paths).flatMap((p) => Object.values(p));
  assert.equal(ops.length, reg.routes.length);
  const health = doc.paths['/healthz'].get;
  assert.ok(health.summary);
  assert.equal(health.security, undefined, 'public route has no security requirement');
  const withParam = Object.entries(doc.paths).find(([p]) => p.includes('{'));
  assert.ok(withParam, 'at least one path parameter route');
  const [, methods] = withParam;
  assert.equal(Object.values(methods)[0].parameters[0].in, 'path');
  assert.ok(ops.some((o) => o['x-permission']), 'permissions are carried through');
});

test('openapi: generate() writes valid JSON that is deterministic', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'poc-oa-'));
  const a = await generate(join(dir, 'a.json'));
  const b = await generate(join(dir, 'b.json'));
  assert.equal(readFileSync(a.outFile, 'utf8'), readFileSync(b.outFile, 'utf8'));
  assert.ok(JSON.parse(readFileSync(a.outFile, 'utf8')).paths);
});

test('openapi: handles hand-built routes (POST 201, missing summary)', () => {
  const doc = buildOpenApi({ routes: [{ module: 'x', method: 'POST', path: '/api/x/:id', names: ['id'], isPublic: false, meta: { permission: 'x.do' } }] });
  const op = doc.paths['/api/x/{id}'].post;
  assert.ok(op.responses['201']);
  assert.equal(op['x-permission'], 'x.do');
  assert.equal(op.summary, '');
});

test('check-repo: secret scanner catches key material and tokens, honours ignore marker', () => {
  const pem = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
  const gh = 'ghp_' + 'a'.repeat(36);
  const aws = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  assert.equal(scanSecrets(pem).length, 1);
  assert.equal(scanSecrets(`const t = "${gh}";`)[0].name, 'GitHub token');
  assert.equal(scanSecrets(aws).length, 1);
  assert.equal(scanSecrets(`password = "${'x'.repeat(24)}"`).length, 1);
  assert.equal(scanSecrets(`${gh} // secret-scan:ignore`).length, 0);
  assert.equal(scanSecrets('const password = process.env.PASSWORD;').length, 0);
  assert.equal(scanSecrets('plain text with nothing special').length, 0);
});

test('check-repo: dependencies are forbidden, empty objects are fine', () => {
  assert.deepEqual(checkDependencies({ name: 'x', dependencies: {} }), []);
  assert.equal(checkDependencies({ dependencies: { left: '1' } }).length, 1);
  assert.equal(checkDependencies({ devDependencies: { a: '1' }, peerDependencies: { b: '1' } }).length, 2);
});

test('check-repo: migration names, duplicates and range warnings', () => {
  assert.deepEqual(checkMigrationNames(['001_core.js', '100_bank_accounts.js']), { errors: [], warnings: [] });
  const bad = checkMigrationNames(['1_x.js', 'abc.js', '010_a.js', '010_b.js']);
  assert.equal(bad.errors.length, 3);
  assert.ok(bad.errors.some((e) => e.includes('already used')));
  assert.ok(bad.errors.some((e) => e.includes('1_x.js')));
  const warn = checkMigrationNames(['250_bank_rules.js', '950_misc.js']);
  assert.equal(warn.errors.length, 0);
  assert.equal(warn.warnings.length, 2);
  assert.ok(warn.warnings[0].includes('banking'));
});

test('check-repo: default export detection', () => {
  assert.ok(hasDefaultExport('export default function register(App) {}'));
  assert.ok(hasDefaultExport('const a = 1;\nexport { a as default };'));
  assert.ok(!hasDefaultExport('export function register() {}'));
  assert.ok(!hasDefaultExport('// export default in a comment only'));
});

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'poc-repo-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

test('check-repo: runChecks passes a minimal good tree and flags each kind of defect', async () => {
  const good = fixture({
    'package.json': '{"name":"x"}',
    'src/modules/hello/index.js': "export default { name: 'hello', routes: [] };\n",
    'src/migrations/001_a.js': "export const id = '001_a';\nexport function up() {}\n",
    'public/modules/hello.js': 'export default function register() {}\n',
  });
  const ok = await runChecks(good);
  assert.deepEqual(ok.errors, []);

  const bad = fixture({
    'package.json': '{"dependencies":{"x":"1"}}',
    'src/modules/hello/index.js': "export default { name: 'other' };\n",
    'src/modules/nofile/readme.txt': 'x',
    'src/migrations/001_a.js': "export const id = '002_zzz';\nexport function up() {}\n",
    'public/modules/nodefault.js': 'export const a = 1;\n',
    'broken.js': 'const = ;\n',
    'leak.txt': '-----BEGIN ' + 'PRIVATE KEY-----\n',
  });
  const res = await runChecks(bad);
  const all = res.errors.join('\n');
  for (const needle of ['dependencies', "declares name 'other'", 'nofile', 'must equal "001_a"', 'no default export', 'syntax: broken.js']) {
    assert.ok(all.includes(needle), `expected an error containing: ${needle}\n${all}`);
  }
  assert.ok(res.errors.some((e) => e.startsWith('secret?')), 'secret flagged');
});

test('check-repo: the real repository is clean', async () => {
  const res = await runChecks();
  assert.deepEqual(res.errors, []);
});

import { probe, waitFor } from '../scripts/smoke-server.js';

test('smoke-server: probe reports status per path and treats errors as failures', async () => {
  const fake = async (url) => {
    if (url.endsWith('/boom')) throw new Error('refused');
    return { status: url.endsWith('/missing') ? 404 : 200 };
  };
  const r = await probe('http://x', ['/ok', '/missing', '/boom'], fake);
  assert.deepEqual(r.map((x) => [x.status, x.ok]), [[200, true], [404, false], [0, false]]);
});

test('smoke-server: waitFor gives up when the server never answers and succeeds once it does', async () => {
  assert.equal(await waitFor('http://x', 3, 1, async () => { throw new Error('down'); }), false);
  let n = 0;
  assert.equal(await waitFor('http://x', 5, 1, async () => ({ status: ++n < 3 ? 503 : 200 })), true);
});
