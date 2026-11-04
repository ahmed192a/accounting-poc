#!/usr/bin/env node
// Runs the test suite with Node's built-in coverage, parses the lcov output for files under src/,
// enforces minimum percentages and prints a markdown summary (also appended to $GITHUB_STEP_SUMMARY).
//
// Thresholds were set from the measured baseline minus a margin (baseline when written:
// src/ only: lines 98.5, branches 91.5, functions 85.3 on the first 50 tests). The margin is a few
// points so merging many feature modules does not flap the job; raise the minimums as the suite grows.
// Override with COV_MIN_LINES / COV_MIN_BRANCHES / COV_MIN_FUNCTIONS.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_THRESHOLDS = { lines: 92, branches: 82, functions: 78 };

/** Parse lcov text into per-file totals, keeping only files whose path starts with `prefix`. */
export function parseLcov(text, prefix = 'src/') {
  const files = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('SF:')) cur = { file: line.slice(3), LF: 0, LH: 0, BRF: 0, BRH: 0, FNF: 0, FNH: 0 };
    else if (line === 'end_of_record') { if (cur) files.push(cur); cur = null; }
    else if (cur) {
      const m = /^(LF|LH|BRF|BRH|FNF|FNH):(\d+)$/.exec(line);
      if (m) cur[m[1]] = Number(m[2]);
    }
  }
  const kept = files.filter((f) => f.file.startsWith(prefix));
  const sum = (k) => kept.reduce((a, f) => a + f[k], 0);
  const pct = (h, f) => (f === 0 ? 100 : Math.round((h / f) * 10000) / 100);
  return {
    files: kept.length,
    lines: pct(sum('LH'), sum('LF')),
    branches: pct(sum('BRH'), sum('BRF')),
    functions: pct(sum('FNH'), sum('FNF')),
    perFile: kept.map((f) => ({ file: f.file, lines: pct(f.LH, f.LF), branches: pct(f.BRH, f.BRF), functions: pct(f.FNH, f.FNF) })),
  };
}

/** Compare totals to thresholds; returns { ok, failures: ['lines 80 < 85', ...] }. */
export function evaluate(totals, thresholds = DEFAULT_THRESHOLDS) {
  const failures = [];
  if (!totals.files) failures.push('no source files found in coverage report');
  for (const k of ['lines', 'branches', 'functions']) {
    if (totals[k] < thresholds[k]) failures.push(`${k} ${totals[k]}% is below the minimum ${thresholds[k]}%`);
  }
  return { ok: failures.length === 0, failures };
}

export function toMarkdown(totals, thresholds, result) {
  const row = (k) => `| ${k} | ${totals[k]}% | ${thresholds[k]}% | ${totals[k] >= thresholds[k] ? 'ok' : 'FAIL'} |`;
  const weakest = [...totals.perFile].sort((a, b) => a.lines - b.lines).slice(0, 5)
    .map((f) => `| \`${f.file}\` | ${f.lines}% | ${f.branches}% | ${f.functions}% |`);
  return [
    `### Test coverage (${totals.files} source files under src/) - ${result.ok ? 'passed' : 'FAILED'}`,
    '', '| metric | measured | minimum | status |', '| --- | --- | --- | --- |',
    row('lines'), row('branches'), row('functions'), '',
    '<details><summary>Five least covered files</summary>', '',
    '| file | lines | branches | functions |', '| --- | --- | --- | --- |', ...weakest, '', '</details>', '',
    ...result.failures.map((f) => `- ${f}`),
  ].join('\n');
}

export function thresholdsFromEnv(env = process.env) {
  const t = { ...DEFAULT_THRESHOLDS };
  for (const k of ['lines', 'branches', 'functions']) {
    const v = env[`COV_MIN_${k.toUpperCase()}`];
    if (v !== undefined && v !== '' && Number.isFinite(Number(v))) t[k] = Number(v);
  }
  return t;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const out = resolve(root, 'coverage', 'lcov.info');
  mkdirSync(dirname(out), { recursive: true });
  const r = spawnSync(process.execPath, [
    '--no-warnings', '--test', '--experimental-test-coverage',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=lcov', `--test-reporter-destination=${out}`,
    'test/**/*.test.js',
  ], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) { console.error('Tests failed; coverage not evaluated.'); process.exit(r.status ?? 1); }
  const totals = parseLcov(readFileSync(out, 'utf8'));
  const thresholds = thresholdsFromEnv();
  const result = evaluate(totals, thresholds);
  const md = toMarkdown(totals, thresholds, result);
  console.log('\n' + md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
