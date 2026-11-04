import { AppError } from '../../errors.js';
import { audit, isoDate } from '../../ledger.js';
import { requirePerm } from '../../permissions.js';
import { BUILDERS } from './builders.js';
import { isDate, addDays, addYears, daysBetween } from './queries.js';
import { toCsv, toHtml, esc } from './format.js';
import { buildDashboard, dashboardAsReport, dashboardHtml, kpis } from './dashboard.js';

const REPORTS = new Map(BUILDERS.map((b) => [b.name, b]));
export const REPORT_NAMES = [...REPORTS.keys(), 'dashboard'];
const FORMATS = ['json', 'csv', 'html'];
const PERIODS = ['month', 'quarter', 'year'];
const COMPARE = ['none', 'previous', 'year', 'custom'];
export const FILTER_KEYS = ['from', 'to', 'asOf', 'compare', 'compareFrom', 'compareTo', 'entityId', 'account', 'period', 'limit', 'offset', 'source', 'q', 'min', 'max', 'includeZero', 'detail', 'lang'];

const bad = (msg, code = 'BAD_INPUT') => new AppError(400, code, msg);
const int = (v, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (!/^-?\d+$/.test(String(v))) throw bad(`${field} must be a whole number`);
  const n = Number(v);
  if (n < min || n > max) throw bad(`${field} must be between ${min} and ${max}`);
  return n;
};
const flag = (v) => v === '1' || v === 'true' || v === true;
const has = (q, k) => q[k] !== undefined && q[k] !== '';

/** Validate query parameters into a normalised object. Exported for tests. */
export function parseParams(ctx, def, q = {}) {
  const today = isoDate(ctx.now());
  const to = has(q, 'to') ? q.to : has(q, 'asOf') ? q.asOf : today;
  const from = has(q, 'from') ? q.from : `${to.slice(0, 4)}-01-01`;
  for (const [k, v] of [['from', from], ['to', to]]) if (!isDate(v)) throw bad(`${k} must be a valid date YYYY-MM-DD`, 'BAD_DATE');
  if (from > to) throw bad('from must not be after to', 'BAD_RANGE');
  const p = {
    kind: def.kind, from, to,
    entityId: has(q, 'entityId') ? int(q.entityId, 'entityId', { min: 1 }) : null,
    lang: q.lang === 'ar' ? 'ar' : 'en',
    period: has(q, 'period') ? q.period : 'month',
    account: has(q, 'account') ? String(q.account).slice(0, 20) : null,
    source: has(q, 'source') ? String(q.source).slice(0, 40) : null,
    q: has(q, 'q') ? String(q.q).slice(0, 100) : null,
    min: has(q, 'min') ? int(q.min, 'min') : null,
    max: has(q, 'max') ? int(q.max, 'max') : null,
    limit: has(q, 'limit') ? int(q.limit, 'limit', { min: 1, max: 10000 }) : (def.name.startsWith('sales-by') ? 200 : 1000),
    offset: has(q, 'offset') ? int(q.offset, 'offset') : 0,
    includeZero: flag(q.includeZero), detail: flag(q.detail), compare: null,
  };
  if (!PERIODS.includes(p.period)) throw bad(`period must be one of ${PERIODS.join(', ')}`);
  const mode = has(q, 'compare') ? q.compare : 'none';
  if (!COMPARE.includes(mode)) throw bad(`compare must be one of ${COMPARE.join(', ')}`);
  if (mode === 'previous') {
    const len = daysBetween(from, to) + 1;
    p.compare = { mode, from: addDays(from, -len), to: addDays(from, -1) };
  } else if (mode === 'year') {
    p.compare = { mode, from: addYears(from, -1), to: addYears(to, -1) };
  } else if (mode === 'custom') {
    if (!isDate(q.compareFrom) || !isDate(q.compareTo)) throw bad('compare=custom needs valid compareFrom and compareTo', 'BAD_DATE');
    if (q.compareFrom > q.compareTo) throw bad('compareFrom must not be after compareTo', 'BAD_RANGE');
    p.compare = { mode, from: q.compareFrom, to: q.compareTo };
  }
  return p;
}

const num = (v) => v ?? 0;

/** Line a comparison result up with the current one by row key; adds <col>Prev and <col>Change. */
function mergeCompare(def, cur, prev) {
  const cmp = def.columns.filter((c) => c.cmp);
  const prevByKey = new Map(prev.rows.map((r) => [r.key, r]));
  const seen = new Set();
  const rows = cur.rows.map((r) => {
    const pr = prevByKey.get(r.key);
    seen.add(r.key);
    const out = { ...r };
    for (const c of cmp) {
      if (r[c.key] == null) continue;
      out[`${c.key}Prev`] = num(pr?.[c.key]);
      out[`${c.key}Change`] = num(r[c.key]) - num(pr?.[c.key]);
    }
    return out;
  });
  if (def.prevOnly !== false) {
    const totalAt = rows.findIndex((r) => r.kind === 'total' && r.key === 'total');
    const extra = [];
    for (const pr of prev.rows) {
      if (seen.has(pr.key) || pr.kind !== 'line') continue;
      const out = { ...pr };
      for (const c of cmp) { out[c.key] = 0; out[`${c.key}Prev`] = num(pr[c.key]); out[`${c.key}Change`] = -num(pr[c.key]); }
      extra.push(out);
    }
    rows.splice(totalAt >= 0 ? totalAt : rows.length, 0, ...extra);
  }
  const columns = [...def.columns];
  for (const c of cmp) {
    columns.push({ key: `${c.key}Prev`, en: `Previous: ${c.en}`, ar: `السابق: ${c.ar}`, type: c.type });
    columns.push({ key: `${c.key}Change`, en: `Change: ${c.en}`, ar: `التغير: ${c.ar}`, type: c.type });
  }
  return { rows, columns, summaryPrev: prev.summary };
}

function execute(ctx, def, p) {
  const cur = def.build(ctx, p);
  let rows = cur.rows, columns = def.columns, summaryPrev;
  if (p.compare && !def.noCompare) {
    const prev = def.build(ctx, { ...p, from: p.compare.from, to: p.compare.to });
    ({ rows, columns, summaryPrev } = mergeCompare(def, cur, prev));
  }
  return {
    name: def.name, title: { en: def.title[0], ar: def.title[1] },
    params: { kind: def.kind, from: def.kind === 'asof' ? undefined : p.from, to: p.to, entityId: p.entityId, account: p.account, period: def.name === 'vat-summary' ? p.period : undefined, compare: def.noCompare ? null : p.compare },
    columns, rows, summary: cur.summary ?? {}, summaryPrev, checks: cur.checks ?? [], meta: cur.meta ?? {},
    generatedAt: new Date(ctx.now()).toISOString(), currency: 'EGP',
  };
}

function authorize(user, def, format) {
  requirePerm(user, 'reports.view');
  if (def?.advanced) requirePerm(user, 'reports.advanced');
  if (format !== 'json') requirePerm(user, 'reports.export');
}

const raw = (contentType, filename, body) => ({ __raw: { contentType, filename, body } });

/** The report catalogue the UI uses to build its picker. */
export function catalogue(ctx, user) {
  requirePerm(user, 'reports.view');
  const mayAdv = user.permissions.has('reports.advanced');
  return {
    formats: FORMATS.filter((f) => f === 'json' || user.permissions.has('reports.export')),
    reports: [...BUILDERS.map((b) => ({ name: b.name, kind: b.kind, advanced: !!b.advanced, title: { en: b.title[0], ar: b.title[1] }, comparable: !b.noCompare })), { name: 'dashboard', kind: 'range', advanced: false, title: { en: 'Dashboard', ar: 'لوحة المؤشرات' }, comparable: false }]
      .filter((r) => mayAdv || !r.advanced),
  };
}

/**
 * Run a report. format=json returns the report object; csv/html return { __raw: { contentType, filename, body } }
 * which an HTTP layer that understands `__raw` sends as-is (the current server wraps it in JSON; see docs/reports.md).
 */
export function runReport(ctx, user, name, query = {}) {
  const format = has(query, 'format') ? query.format : 'json';
  if (!FORMATS.includes(format)) throw bad(`format must be one of ${FORMATS.join(', ')}`, 'BAD_FORMAT');
  if (name === 'dashboard') return runDashboard(ctx, user, query, format);
  const def = REPORTS.get(name);
  if (!def) throw new AppError(404, 'UNKNOWN_REPORT', `Unknown report "${name}". Known: ${REPORT_NAMES.join(', ')}`);
  authorize(user, def, format);
  const p = parseParams(ctx, def, query);
  const report = execute(ctx, def, p);
  if (format === 'json') return report;
  audit(ctx, { userId: user.id, action: 'report.exported', type: 'report', newValue: { name, format, from: p.from, to: p.to, entityId: p.entityId, account: p.account } });
  const base = `${name}-${p.to}`;
  return format === 'csv'
    ? raw('text/csv; charset=utf-8', `${base}.csv`, toCsv(report))
    : raw('text/html; charset=utf-8', `${base}.html`, toHtml(report, { lang: p.lang }));
}

function runDashboard(ctx, user, query, format) {
  authorize(user, null, format);
  const p = parseParams(ctx, { name: 'dashboard', kind: 'range' }, query);
  const d = buildDashboard(ctx, p);
  if (format === 'json') return d;
  audit(ctx, { userId: user.id, action: 'report.exported', type: 'report', newValue: { name: 'dashboard', format, from: p.from, to: p.to, entityId: p.entityId } });
  const rep = dashboardAsReport(ctx, d, p);
  return format === 'csv'
    ? raw('text/csv; charset=utf-8', `dashboard-${p.to}.csv`, toCsv(rep))
    : raw('text/html; charset=utf-8', `dashboard-${p.to}.html`, toHtml(rep, { lang: p.lang, extra: dashboardHtml(d, p.lang) }));
}

export function kpiReport(ctx, user, query = {}) {
  requirePerm(user, 'reports.view');
  const p = parseParams(ctx, { name: 'kpis', kind: 'range' }, query);
  return kpis(ctx, p);
}

/** Entry with all its lines: the drill-down target for general-ledger rows. */
export function entryDetail(ctx, user, id) {
  requirePerm(user, 'reports.advanced');
  const n = int(id, 'id', { min: 1 });
  const e = ctx.db.prepare('SELECT id, entry_date, memo, source_type, source_id, reverses_id, created_by, created_at, reason FROM journal_entries WHERE id = ?').get(n);
  if (!e) throw new AppError(404, 'NOT_FOUND', 'Entry not found');
  const lines = ctx.db.prepare('SELECT l.id, a.code, a.name, a.name_ar, l.debit, l.credit FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.id').all(n);
  const reversedBy = ctx.db.prepare('SELECT id FROM journal_entries WHERE reverses_id = ?').get(n)?.id ?? null;
  return { entry: e, lines, reversedBy, totalDebit: lines.reduce((s, l) => s + l.debit, 0), totalCredit: lines.reduce((s, l) => s + l.credit, 0) };
}

// ---------------------------------------------------------------------------------------------
// Saved report filters (own table). Private by default; sharing needs reports.advanced.
export function saveFilter(ctx, user, input = {}) {
  requirePerm(user, 'reports.view');
  const report = String(input.report ?? '');
  if (!REPORT_NAMES.includes(report)) throw bad(`report must be one of ${REPORT_NAMES.join(', ')}`);
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 80) throw bad('name is required (max 80 characters)');
  if (!input.params || typeof input.params !== 'object' || Array.isArray(input.params)) throw bad('params must be an object');
  const params = {};
  for (const [k, v] of Object.entries(input.params)) {
    if (!FILTER_KEYS.includes(k)) throw bad(`Unknown filter parameter "${k}"`);
    if (!['string', 'number', 'boolean'].includes(typeof v) || String(v).length > 100) throw bad(`Filter parameter "${k}" must be a short string, number or boolean`);
    params[k] = v;
  }
  const shared = input.shared ? 1 : 0;
  if (shared) requirePerm(user, 'reports.advanced');
  if (ctx.db.prepare('SELECT 1 FROM reports_saved_filters WHERE user_id = ? AND report = ? AND name = ?').get(user.id, report, name)) {
    throw new AppError(409, 'DUPLICATE', 'You already saved a filter with this name for this report');
  }
  const res = ctx.db.prepare('INSERT INTO reports_saved_filters (user_id, report, name, params, shared, created_at) VALUES (?,?,?,?,?,?)').run(user.id, report, name, JSON.stringify(params), shared, ctx.now());
  const id = Number(res.lastInsertRowid);
  audit(ctx, { userId: user.id, action: 'report.filter_saved', type: 'report_filter', id, newValue: { report, name, shared: !!shared } });
  return { id, report, name, params, shared: !!shared };
}

export function listFilters(ctx, user, query = {}) {
  requirePerm(user, 'reports.view');
  const rows = ctx.db.prepare(`SELECT id, user_id, report, name, params, shared FROM reports_saved_filters WHERE (user_id = ? OR shared = 1)${query.report ? ' AND report = ?' : ''} ORDER BY report, name`).all(user.id, ...(query.report ? [String(query.report)] : []));
  return rows.map((r) => ({ id: r.id, report: r.report, name: r.name, params: JSON.parse(r.params), shared: !!r.shared, mine: r.user_id === user.id }));
}

export function deleteFilter(ctx, user, id) {
  requirePerm(user, 'reports.view');
  const n = int(id, 'id', { min: 1 });
  const row = ctx.db.prepare('SELECT * FROM reports_saved_filters WHERE id = ?').get(n);
  if (!row || (row.user_id !== user.id && !row.shared)) throw new AppError(404, 'NOT_FOUND', 'Saved filter not found');
  if (row.user_id !== user.id) throw new AppError(403, 'FORBIDDEN', 'Only the owner can delete a saved filter');
  ctx.db.prepare('DELETE FROM reports_saved_filters WHERE id = ?').run(n);
  audit(ctx, { userId: user.id, action: 'report.filter_deleted', type: 'report_filter', id: n, oldValue: { report: row.report, name: row.name } });
  return { id: n, deleted: true };
}

export function widgets(ctx, user) {
  if (!user.permissions.has('reports.view')) return {};
  const today = isoDate(ctx.now());
  return { reportKpis: kpis(ctx, { to: today, from: `${today.slice(0, 4)}-01-01`, entityId: null }) };
}

export { esc };
