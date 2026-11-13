#!/usr/bin/env node
// Repository hygiene checks, run by CI (`npm run check`). Zero dependencies.
//  errors (exit 1): syntax error in any .js file; dependencies in package.json; secret-looking strings;
//    src/modules/<x> without index.js or whose declared name differs; public/modules file without a default
//    export; migrations not named NNN_name.js, duplicate numbers, or id different from the filename
//  warnings (exit 0): migration number outside the range reserved for its module; routes without meta.summary
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'shots', 'artifacts']);

/** Migration ranges from docs/ARCHITECTURE.md. A migration whose name starts with a module key must stay in its range. */
export const RANGES = {
  core: [1, 99], banking: [100, 199], inventory: [200, 299], entities: [300, 399], security: [400, 499],
  tax: [500, 599], reports: [600, 699], approvals: [700, 799], reserved: [800, 899], tenancy: [900, 919], jobs: [920, 939],
};
const NAME_HINTS = {
  bank: 'banking', banking: 'banking', inventory: 'inventory', stock: 'inventory', entities: 'entities', entity: 'entities',
  currency: 'entities', fx: 'entities', auth: 'security', security: 'security', session: 'security', tax: 'tax', eta: 'tax',
  jobs: 'jobs', job: 'jobs', outbox: 'jobs', reports: 'reports', report: 'reports', approvals: 'approvals', approval: 'approvals', purchases: 'approvals', assist: 'approvals',
};

export function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    if (SKIP_DIRS.has(n)) continue;
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, exts, out);
    else if (!exts || exts.some((e) => n.endsWith(e))) out.push(p);
  }
  return out;
}

// Secret patterns are assembled from parts so this file never matches itself.
const J = (...p) => new RegExp(p.join(''));
export const SECRET_PATTERNS = [
  { name: 'private key block', re: J('-----BEGIN ', '(?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?', 'PRIVATE KEY') },
  { name: 'GitHub token', re: J('\\bgh[pousr]_', '[A-Za-z0-9]{30,}') },
  { name: 'GitHub fine-grained token', re: J('\\bgithub_', 'pat_[A-Za-z0-9_]{40,}') },
  { name: 'AWS access key id', re: J('\\b(?:AKIA|ASIA)', '[0-9A-Z]{16}\\b') },
  { name: 'Slack token', re: J('\\bxox[abprs]-', '[A-Za-z0-9-]{10,}') },
  { name: 'Anthropic/OpenAI style API key', re: J('\\bsk-', '(?:ant-|proj-)?[A-Za-z0-9_-]{32,}') },
  { name: 'Google API key', re: J('\\bAIza', '[0-9A-Za-z_-]{35}\\b') },
  { name: 'hard-coded credential assignment', re: J('(?:password|passwd|secret|api[_-]?key|token)', '["\']?\\s*[:=]\\s*["\']', '[A-Za-z0-9+/_-]{20,}["\']') },
];

export function scanSecrets(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (line.includes('secret-scan:ignore')) return;
    for (const p of SECRET_PATTERNS) if (p.re.test(line)) hits.push({ line: i + 1, name: p.name });
  });
  return hits;
}

export function checkDependencies(pkg) {
  const errs = [];
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) {
    const v = pkg[k];
    if (v && (Array.isArray(v) ? v.length : Object.keys(v).length)) errs.push(`package.json must not declare ${k} (this project has zero dependencies)`);
  }
  return errs;
}

/** Validate migration file names. Input: list of file names. Returns { errors, warnings, ids } where ids are checked separately. */
export function checkMigrationNames(files) {
  const errors = [];
  const warnings = [];
  const seen = new Map();
  for (const f of files) {
    const m = /^(\d{3})_([a-z0-9_]+)\.js$/.exec(f);
    if (!m) { errors.push(`migration ${f}: name must be NNN_name.js (three digits, lowercase name)`); continue; }
    const num = Number(m[1]);
    if (seen.has(num)) errors.push(`migration ${f}: number ${m[1]} is already used by ${seen.get(num)}`);
    else seen.set(num, f);
    const owner = Object.entries(RANGES).find(([, [lo, hi]]) => num >= lo && num <= hi)?.[0];
    if (!owner) { warnings.push(`migration ${f}: number ${num} is outside every reserved range (1-899)`); continue; }
    const hint = m[2].split('_').map((w) => NAME_HINTS[w]).find(Boolean);
    if (hint && hint !== owner) warnings.push(`migration ${f}: name suggests module "${hint}" but number ${num} is in the "${owner}" range`);
  }
  return { errors, warnings };
}

export function hasDefaultExport(src) {
  return /^\s*export\s+default\b/m.test(src) || /^\s*export\s*\{[^}]*\bas\s+default\b[^}]*\}/m.test(src);
}

export async function runChecks(root = ROOT) {
  const errors = [];
  const warnings = [];
  const rel = (p) => relative(root, p).split(sep).join('/');

  // 1. syntax of every .js file
  const jsFiles = walk(root, ['.js']);
  for (const f of jsFiles) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) errors.push(`syntax: ${rel(f)}\n${(r.stderr || '').split('\n').slice(0, 4).join('\n')}`);
  }

  // 2. no dependencies
  const pkgFile = join(root, 'package.json');
  if (existsSync(pkgFile)) errors.push(...checkDependencies(JSON.parse(readFileSync(pkgFile, 'utf8'))));
  for (const lock of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']) if (existsSync(join(root, lock))) errors.push(`${lock} must not exist (no dependencies)`);

  // 3. secrets (text files only)
  const textExts = ['.js', '.mjs', '.json', '.md', '.yml', '.yaml', '.py', '.html', '.css', '.txt', '.env', 'Dockerfile'];
  for (const f of walk(root, textExts)) {
    if (statSync(f).size > 2_000_000) continue;
    for (const h of scanSecrets(readFileSync(f, 'utf8'))) errors.push(`secret? ${rel(f)}:${h.line} looks like a ${h.name} (add "secret-scan:ignore" on the line if it is a harmless example)`);
  }

  // 4. module folders
  const modsDir = join(root, 'src', 'modules');
  if (existsSync(modsDir)) {
    for (const n of readdirSync(modsDir)) {
      const dir = join(modsDir, n);
      if (n.startsWith('.') || n.startsWith('_') || !statSync(dir).isDirectory()) continue;
      const idx = join(dir, 'index.js');
      if (!existsSync(idx)) { errors.push(`module ${n}: src/modules/${n}/index.js is missing`); continue; }
      const m = /\bname\s*:\s*['"]([^'"]+)['"]/.exec(readFileSync(idx, 'utf8'));
      if (!m) errors.push(`module ${n}: index.js declares no name: '${n}'`);
      else if (m[1] !== n) errors.push(`module ${n}: index.js declares name '${m[1]}', it must equal the folder name`);
    }
  }

  // 5. UI modules
  const uiDir = join(root, 'public', 'modules');
  for (const f of walk(uiDir, ['.js'])) if (!hasDefaultExport(readFileSync(f, 'utf8'))) errors.push(`ui module ${rel(f)}: no default export`);

  // 6. migrations
  const migDir = join(root, 'src', 'migrations');
  if (existsSync(migDir)) {
    const files = readdirSync(migDir).filter((f) => f.endsWith('.js'));
    const r = checkMigrationNames(files);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    for (const f of files) {
      const expected = f.replace(/\.js$/, '');
      try {
        const mod = await import(pathToFileURL(join(migDir, f)).href);
        if (mod.id !== expected) errors.push(`migration ${f}: exported id ${JSON.stringify(mod.id)} must equal "${expected}"`);
        if (typeof mod.up !== 'function') errors.push(`migration ${f}: must export function up(db)`);
      } catch (e) { errors.push(`migration ${f}: cannot import (${e.message})`); }
    }
  }

  // 7. routes without meta.summary (warning only)
  if (existsSync(join(root, 'src', 'modules.js'))) try {
    const { loadModules } = await import(pathToFileURL(join(root, 'src', 'modules.js')).href);
    const reg = await loadModules(modsDir);
    for (const r of reg.routes) if (!r.meta?.summary) warnings.push(`route ${r.method} ${r.path} (${r.module}) has no meta.summary`);
  } catch (e) { errors.push(`module registry failed to load: ${e.message}`); }

  return { errors, warnings, jsFiles: jsFiles.length };
}

async function main() {
  const { errors, warnings, jsFiles } = await runChecks();
  for (const w of warnings) console.log(`WARN  ${w}`);
  for (const e of errors) console.log(`ERROR ${e}`);
  const md = [`### Repo checks - ${errors.length ? 'FAILED' : 'passed'}`, '', `${jsFiles} JavaScript files checked, ${errors.length} errors, ${warnings.length} warnings.`,
    ...errors.map((e) => `- ERROR ${e.split('\n')[0]}`), ...warnings.slice(0, 40).map((w) => `- warning: ${w}`)].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) (await import('node:fs')).appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  console.log(`\n${jsFiles} JS files checked: ${errors.length} errors, ${warnings.length} warnings`);
  process.exit(errors.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
