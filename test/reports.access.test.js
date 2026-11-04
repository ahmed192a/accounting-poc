import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError, startApp } from './helpers.js';
import { createApp } from '../src/server.js';
import { loadUser } from '../src/permissions.js';
import { postEntry } from '../src/ledger.js';
import { runReport, saveFilter, listFilters, deleteFilter, entryDetail, catalogue, kpiReport } from '../src/modules/reports/service.js';
import { toCsv, parseCsv, toHtml, fmtMoney, BOM } from '../src/modules/reports/format.js';

function viewerOnly(ctx) { // custom role with just reports.view
  const role = ctx.db.prepare("INSERT INTO roles (name, permissions, limits, builtin) VALUES ('viewer', ?, '{}', 0)").run(JSON.stringify(['reports.view']));
  const u = ctx.db.prepare("INSERT INTO users (name, role_id) VALUES ('Viewer', ?)").run(Number(role.lastInsertRowid));
  return loadUser(ctx, Number(u.lastInsertRowid));
}

test('permission denials: clerk and admin cannot see reports at all', () => {
  const { ctx, as } = setup();
  for (const who of ['clerk', 'admin']) {
    expectError(() => runReport(ctx, as(who), 'trial-balance', {}), 'FORBIDDEN');
    expectError(() => runReport(ctx, as(who), 'dashboard', {}), 'FORBIDDEN');
    expectError(() => listFilters(ctx, as(who)), 'FORBIDDEN');
    expectError(() => catalogue(ctx, as(who)), 'FORBIDDEN');
    expectError(() => kpiReport(ctx, as(who)), 'FORBIDDEN');
  }
});

test('reports.view alone: basic JSON works, exports and advanced reports are refused', () => {
  const { ctx } = setup();
  const v = viewerOnly(ctx);
  assert.ok(runReport(ctx, v, 'profit-loss', {}).rows.length);
  assert.ok(runReport(ctx, v, 'dashboard', {}).charts.length);
  expectError(() => runReport(ctx, v, 'profit-loss', { format: 'csv' }), 'FORBIDDEN');
  expectError(() => runReport(ctx, v, 'dashboard', { format: 'html' }), 'FORBIDDEN');
  for (const n of ['cash-flow', 'ar-aging', 'ap-aging', 'general-ledger', 'account-transactions']) expectError(() => runReport(ctx, v, n, {}), 'FORBIDDEN');
  expectError(() => entryDetail(ctx, v, 1), 'FORBIDDEN');
  expectError(() => saveFilter(ctx, v, { report: 'profit-loss', name: 'x', params: {}, shared: true }), 'FORBIDDEN');
  assert.ok(!catalogue(ctx, v).reports.some((r) => r.advanced));
  assert.deepEqual(catalogue(ctx, v).formats, ['json']);
});

test('built-in grants: manager, accountant, auditor export and go advanced; owner too', () => {
  const { ctx, as } = setup();
  for (const who of ['owner', 'manager', 'accountant', 'auditor']) {
    const r = runReport(ctx, as(who), 'general-ledger', { account: '1000', format: 'csv' });
    assert.ok(r.__raw.body.startsWith(BOM));
  }
});

test('CSV: UTF-8 BOM, Arabic and commas and quotes round-trip, formula cells are neutralised', () => {
  const rep = {
    columns: [{ key: 'name', en: 'Name', ar: 'الاسم', type: 'text' }, { key: 'amount', en: 'Amount', ar: 'المبلغ', type: 'money' }],
    rows: [
      { name: 'شركة النيل، للتجارة', amount: 123456789 },
      { name: 'He said "hi", twice', amount: -5 },
      { name: 'line1\nline2', amount: 0 },
      { name: '=SUM(A1)', amount: 100 },
    ],
  };
  const csv = toCsv(rep);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], ['Name / الاسم', 'Amount / المبلغ']);
  assert.deepEqual(rows[1], ['شركة النيل، للتجارة', '1234567.89']);
  assert.deepEqual(rows[2], ['He said "hi", twice', '-0.05']);
  assert.deepEqual(rows[3], ['line1\nline2', '0.00']);
  assert.equal(rows[4][0], "'=SUM(A1)");
  assert.equal(Buffer.from(csv, 'utf8')[0], 0xef);
});

test('CSV of a real report with Arabic memo round-trips through the ledger', () => {
  const { ctx, as } = setup();
  postEntry(ctx, { userId: 1, date: '2026-03-03', memo: 'دفعة إيجار، شهر مارس "٢٠٢٦"', lines: [{ account: '5100', debit: 150050 }, { account: '1000', credit: 150050 }] });
  const out = runReport(ctx, as('accountant'), 'account-transactions', { account: '5100', from: '2026-03-01', to: '2026-03-31', format: 'csv' });
  assert.equal(out.__raw.contentType, 'text/csv; charset=utf-8');
  assert.match(out.__raw.filename, /^account-transactions-2026-03-31\.csv$/);
  const rows = parseCsv(out.__raw.body);
  const memoCol = rows[0].findIndex((h) => h.startsWith('Memo'));
  const debitCol = rows[0].findIndex((h) => h.startsWith('Debit'));
  assert.equal(rows[1][memoCol], 'دفعة إيجار، شهر مارس "٢٠٢٦"');
  assert.equal(rows[1][debitCol], '1500.50');
  assert.equal(rows.at(-1)[debitCol], '1500.50'); // total row
});

test('HTML: RTL for lang=ar, bilingual headings, user text escaped, print stylesheet, balance check shown', () => {
  const { ctx, as } = setup();
  postEntry(ctx, { userId: 1, date: '2026-03-03', memo: '<script>alert(1)</script>', lines: [{ account: '5100', debit: 100 }, { account: '1000', credit: 100 }] });
  const ar = runReport(ctx, as('auditor'), 'account-transactions', { account: '5100', lang: 'ar', format: 'html', from: '2026-03-01', to: '2026-03-31' }).__raw.body;
  assert.match(ar, /<html lang="ar" dir="rtl">/);
  assert.match(ar, /Account transactions <span class="alt">\/ حركة الحسابات/);
  assert.ok(!ar.includes('<script>alert'));
  assert.ok(ar.includes('&lt;script&gt;'));
  assert.match(ar, /@media print/);
  const en = runReport(ctx, as('auditor'), 'balance-sheet', { format: 'html' }).__raw.body;
  assert.match(en, /dir="ltr"/);
  assert.match(en, /Assets equal liabilities plus equity/);
  assert.match(en, /الأصول تساوي الالتزامات/);
  assert.ok(toHtml({ title: { en: 'T', ar: 'ت' }, params: {}, columns: [], rows: [], generatedAt: 'x' }).includes('No data'));
});

test('exports are audited; plain JSON runs are not', () => {
  const { ctx, as } = setup();
  const count = () => ctx.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'report.exported'").get().n;
  runReport(ctx, as('owner'), 'profit-loss', {});
  assert.equal(count(), 0);
  runReport(ctx, as('owner'), 'profit-loss', { format: 'csv' });
  runReport(ctx, as('owner'), 'dashboard', { format: 'html' });
  assert.equal(count(), 2);
});

test('fmtMoney uses integer arithmetic and groups thousands', () => {
  assert.equal(fmtMoney(0), '0.00');
  assert.equal(fmtMoney(-5), '-0.05');
  assert.equal(fmtMoney(123456789012), '1,234,567,890.12');
  assert.equal(fmtMoney(123456789012, false), '1234567890.12');
});

test('saved filters: private by default, sharing needs reports.advanced, owner-only delete, validation, audit', () => {
  const { ctx, as } = setup();
  const acc = saveFilter(ctx, as('accountant'), { report: 'profit-loss', name: 'Q1', params: { from: '2026-01-01', to: '2026-03-31', compare: 'year' } });
  assert.deepEqual(listFilters(ctx, as('auditor')), []);
  assert.equal(listFilters(ctx, as('accountant'))[0].params.compare, 'year');
  saveFilter(ctx, as('accountant'), { report: 'profit-loss', name: 'Team view', params: { from: '2026-01-01' }, shared: true });
  assert.equal(listFilters(ctx, as('auditor')).length, 1);
  assert.equal(listFilters(ctx, as('auditor'))[0].mine, false);
  expectError(() => deleteFilter(ctx, as('auditor'), acc.id), 'NOT_FOUND');
  const shared = listFilters(ctx, as('auditor'))[0];
  expectError(() => deleteFilter(ctx, as('auditor'), shared.id), 'FORBIDDEN');
  expectError(() => saveFilter(ctx, as('accountant'), { report: 'profit-loss', name: 'Q1', params: {} }), 'DUPLICATE');
  expectError(() => saveFilter(ctx, as('accountant'), { report: 'nope', name: 'a', params: {} }), 'BAD_INPUT');
  expectError(() => saveFilter(ctx, as('accountant'), { report: 'profit-loss', name: 'a', params: { evil: '1' } }), 'BAD_INPUT');
  expectError(() => saveFilter(ctx, as('accountant'), { report: 'profit-loss', name: '  ', params: {} }), 'BAD_INPUT');
  expectError(() => saveFilter(ctx, as('clerk'), { report: 'profit-loss', name: 'a', params: {} }), 'FORBIDDEN');
  deleteFilter(ctx, as('accountant'), acc.id);
  const acts = ctx.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'report.filter_%' ORDER BY id").all().map((r) => r.action);
  assert.deepEqual(acts, ['report.filter_saved', 'report.filter_saved', 'report.filter_deleted']);
});

test('entry drill-down returns lines; unknown entry is 404', () => {
  const { ctx, as } = setup();
  const d = entryDetail(ctx, as('auditor'), 1);
  assert.equal(d.lines.length, 2);
  assert.equal(d.totalDebit, d.totalCredit);
  expectError(() => entryDetail(ctx, as('auditor'), 99999), 'NOT_FOUND');
  expectError(() => entryDetail(ctx, as('auditor'), 'abc'), 'BAD_INPUT');
});

test('dashboard: four charts with SVG text alternatives in both languages, KPIs, no script injection', () => {
  const { ctx, as } = setup();
  postEntry(ctx, { userId: 1, date: '2026-10-01', memo: 'x', lines: [{ account: '5100', debit: 80000 }, { account: '1000', credit: 80000 }] });
  postEntry(ctx, { userId: 1, date: '2026-10-02', memo: 'x', lines: [{ account: '1000', debit: 500000 }, { account: '4000', credit: 500000 }] });
  const d = runReport(ctx, as('manager'), 'dashboard', { to: '2026-11-30' });
  assert.deepEqual(d.charts.map((c) => c.id), ['salesTrend', 'expensesByCategory', 'cashPosition', 'topCustomers']);
  for (const c of d.charts) for (const lang of ['en', 'ar']) {
    assert.match(c.svg[lang], /<svg [^>]*role="img"/);
    assert.match(c.svg[lang], /<title id="[^"]+-t">/);
    assert.match(c.svg[lang], /<desc id="[^"]+-d">/);
  }
  assert.equal(d.charts[0].data.length, 12);
  assert.equal(d.charts[0].data.at(-2).value, 500000); // October
  assert.equal(d.charts[2].data.at(-1).value, 1000000 + 500000 - 80000);
  assert.match(d.charts[1].svg.ar, /الإيجار/);
  assert.equal(d.kpis.grossMarginPct, 100);
  assert.equal(d.kpis.currentRatio, null); // no liabilities yet
  assert.equal(d.kpis.dsoDays, null);
  assert.match(d.charts[3].svg.en, /No data/);
});

test('KPIs: gross margin, current ratio and DSO approximation from ledger postings', () => {
  const { ctx, as } = setup();
  postEntry(ctx, { userId: 1, date: '2026-10-01', memo: 's', lines: [{ account: '1200', debit: 900000 }, { account: '4000', credit: 900000 }] });
  postEntry(ctx, { userId: 1, date: '2026-10-02', memo: 'p', lines: [{ account: '5000', debit: 300000 }, { account: '2000', credit: 300000 }] });
  const k = kpiReport(ctx, as('owner'), { to: '2026-10-31' });
  assert.equal(k.grossMarginPct, 66.67);
  assert.equal(k.dsoDays, 90); // receivables equal the last 90 days of credit sales
  assert.equal(k.currentRatio, 3); // opening cash is dated later (demo clock), so 900000 / 300000
});

test('HTTP: new routes work, existing /api/reports still works, csv arrives as a raw envelope', async () => {
  const { ctx } = setup();
  const { server, call } = await startApp(createApp, ctx);
  try {
    assert.equal((await call('GET', '/api/reports', 4)).status, 200);
    const tb = await call('GET', '/api/reports/trial-balance?to=2030-01-01', 4);
    assert.equal(tb.status, 200);
    assert.equal(tb.body.summary.balanced, true);
    const csv = await call('GET', '/api/reports/profit-loss?format=csv', 4);
    assert.equal(csv.status, 200);
    assert.ok(csv.body.__raw.body.startsWith(BOM));
    assert.equal((await call('GET', '/api/reports/profit-loss', 3)).status, 403);
    assert.equal((await call('GET', '/api/reports/profit-loss?format=csv', 2)).status, 200);
    assert.equal((await call('GET', '/api/reports/nope', 4)).status, 404);
    assert.equal((await call('GET', '/api/reports/profit-loss?from=bad', 4)).status, 400);
    const saved = await call('POST', '/api/report-filters', 4, { report: 'profit-loss', name: 'YTD', params: { compare: 'previous' } });
    assert.equal(saved.status, 201);
    assert.equal((await call('GET', '/api/report-filters', 4)).body.length, 1);
    assert.equal((await call('DELETE', `/api/report-filters/${saved.body.id}`, 4)).status, 200);
    assert.equal((await call('GET', '/api/report-entries/1', 5)).body.lines.length, 2);
    assert.ok((await call('GET', '/api/home', 4)).body.widgets.reportKpis);
    assert.equal((await call('GET', '/api/home', 3)).body.widgets.reportKpis, undefined);
  } finally { server.close(); }
});
