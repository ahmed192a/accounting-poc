// Dashboard: KPI widgets and four accessible SVG charts (sales trend, expenses by category, cash position,
// top customers). Every chart ships with its data so the UI can show a text alternative.
import { chart as chartOf, sums, zero, cashIds, entityFilter, addDays } from './queries.js';
import { profitLoss, salesByCustomer } from './builders.js';
import { lineChart, hbarChart } from './charts.js';
import { fmtMoney, esc } from './format.js';

const round1 = (x) => Math.round(x * 10) / 10;

export function kpis(ctx, p) {
  const { db } = ctx;
  const m = sums(db, { to: p.to, entityId: p.entityId });
  let currentAssets = 0, liabilities = 0, ar = 0, ap = 0, cash = 0;
  const cashSet = new Set(cashIds(db));
  for (const a of chartOf(db)) {
    const s = m.get(a.id) ?? zero;
    if (a.type === 'asset' && a.code < '1500') currentAssets += s.d - s.c; // UNVERIFIED: every asset below 1500 is current
    if (a.type === 'liability') liabilities += s.c - s.d;
    if (a.code === '1200') ar = s.d - s.c;
    if (a.code === '2000') ap = s.c - s.d;
    if (cashSet.has(a.id)) cash += s.d - s.c;
  }
  const ytdFrom = `${p.to.slice(0, 4)}-01-01`;
  const pl = profitLoss.build(ctx, { from: ytdFrom, to: p.to, entityId: p.entityId }).summary;
  const f = entityFilter(p.entityId);
  const ar1200 = db.prepare("SELECT id FROM accounts WHERE code = '1200'").get();
  const credit90 = ar1200 ? db.prepare(`SELECT COALESCE(SUM(l.debit),0) AS s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = ? AND e.entry_date > ? AND e.entry_date <= ?${f.sql}`).get(ar1200.id, addDays(p.to, -90), p.to, ...f.args).s : 0;
  return {
    asOf: p.to,
    grossMarginPct: pl.grossMarginPct,
    dsoDays: credit90 > 0 ? round1((ar / credit90) * 90) : null, // approximation: receivables / credit sales of the last 90 days x 90
    currentRatio: liabilities > 0 ? Math.round((currentAssets / liabilities) * 100) / 100 : null,
    netProfitYtd: pl.netProfit, revenueYtd: pl.revenue, cash, receivables: ar, payables: ap,
    notes: { dso: 'Approximation from the ledger, not from invoice due dates', currentRatio: 'Assets with code below 1500 over all liabilities (UNVERIFIED classification)' },
  };
}

const monthKey = (d) => d.slice(0, 7);
function lastMonths(to, n) {
  let [y, m] = to.split('-').map(Number);
  const out = [];
  for (let i = 0; i < n; i++) { out.unshift(`${y}-${String(m).padStart(2, '0')}`); m--; if (m < 1) { m = 12; y--; } }
  return out;
}

export function buildDashboard(ctx, p) {
  const { db } = ctx;
  const months = lastMonths(p.to, 12);
  const trendFrom = `${months[0]}-01`;
  const f = entityFilter(p.entityId);
  const rev = chartOf(db).filter((a) => a.type === 'revenue').map((a) => a.id);
  const trendRows = rev.length ? db.prepare(`SELECT substr(e.entry_date,1,7) AS m, SUM(l.credit - l.debit) AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id IN (${rev.map(() => '?').join(',')}) AND e.entry_date >= ? AND e.entry_date <= ?${f.sql} GROUP BY m`).all(...rev, trendFrom, p.to, ...f.args) : [];
  const trendMap = new Map(trendRows.map((r) => [r.m, r.v]));
  const ids = cashIds(db);
  const cashRows = ids.length ? db.prepare(`SELECT substr(e.entry_date,1,7) AS m, SUM(l.debit - l.credit) AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id IN (${ids.map(() => '?').join(',')}) AND e.entry_date >= ? AND e.entry_date <= ?${f.sql} GROUP BY m`).all(...ids, trendFrom, p.to, ...f.args) : [];
  const cashMap = new Map(cashRows.map((r) => [r.m, r.v]));
  const before = sums(db, { to: addDays(trendFrom, -1), entityId: p.entityId });
  let run = ids.reduce((s, id) => s + ((before.get(id)?.d ?? 0) - (before.get(id)?.c ?? 0)), 0);

  const data = {
    salesTrend: months.map((m) => ({ label: m, value: trendMap.get(m) ?? 0 })),
    cashPosition: months.map((m) => { run += cashMap.get(m) ?? 0; return { label: m, value: run }; }),
  };
  const within = sums(db, { from: p.from, to: p.to, entityId: p.entityId });
  data.expensesByCategory = chartOf(db).filter((a) => a.type === 'expense').map((a) => ({ label: a.name, label_ar: a.name_ar, value: (within.get(a.id)?.d ?? 0) - (within.get(a.id)?.c ?? 0) })).filter((x) => x.value !== 0).sort((a, b) => b.value - a.value);
  data.topCustomers = salesByCustomer.build(ctx, { ...p, limit: 5 }).rows.filter((r) => r.kind === 'line').map((r) => ({ label: r.name, value: r.total }));

  const T = {
    salesTrend: ['Sales trend (last 12 months)', 'اتجاه المبيعات (آخر 12 شهرًا)'],
    expensesByCategory: ['Expenses by category', 'المصروفات حسب البند'],
    cashPosition: ['Cash position (month end)', 'الموقف النقدي (نهاية الشهر)'],
    topCustomers: ['Top customers', 'أهم العملاء'],
  };
  const mk = (key, fn) => {
    const svg = {};
    for (const lang of ['en', 'ar']) svg[lang] = fn({ id: `reports-${key}-${lang}`, title: T[key][lang === 'ar' ? 1 : 0], points: data[key].map((d) => ({ ...d, label: lang === 'ar' && d.label_ar ? d.label_ar : d.label })), lang, emptyMsg: lang === 'ar' ? 'لا توجد بيانات' : 'No data' });
    return { id: key, title: { en: T[key][0], ar: T[key][1] }, type: fn === lineChart ? 'line' : 'bar', data: data[key], svg };
  };
  return {
    asOf: p.to, from: p.from, to: p.to, entityId: p.entityId, kpis: kpis(ctx, p),
    charts: [mk('salesTrend', lineChart), mk('expensesByCategory', hbarChart), mk('cashPosition', lineChart), mk('topCustomers', hbarChart)],
    generatedAt: new Date(ctx.now()).toISOString(),
  };
}

/** Flatten the dashboard so the generic CSV/HTML writers can emit it. */
export function dashboardAsReport(ctx, d, p) {
  const rows = [];
  for (const [k, v] of Object.entries(d.kpis)) if (k !== 'notes' && k !== 'asOf') rows.push({ kind: 'line', key: `k${k}`, section: 'KPI', label: k, value: v == null ? '' : ['grossMarginPct', 'dsoDays', 'currentRatio'].includes(k) ? String(v) : fmtMoney(v) });
  for (const c of d.charts) for (const pt of c.data) rows.push({ kind: 'line', key: `${c.id}:${pt.label}`, section: c.title.en, label: pt.label, value: fmtMoney(pt.value) });
  return {
    name: 'dashboard', title: { en: 'Dashboard', ar: 'لوحة المؤشرات' }, params: { kind: 'range', from: p.from, to: p.to, entityId: p.entityId },
    columns: [{ key: 'section', en: 'Section', ar: 'القسم', type: 'text' }, { key: 'label', en: 'Label', ar: 'البند', type: 'text' }, { key: 'value', en: 'Value', ar: 'القيمة', type: 'text' }],
    rows, checks: [], generatedAt: d.generatedAt,
  };
}

export function dashboardHtml(d, lang) {
  return d.charts.map((c) => `<div class="chart">${c.svg[lang]}</div>`).join('');
}
export { esc };
