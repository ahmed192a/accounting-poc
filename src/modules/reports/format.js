// Output formats for reports: money formatting (integer arithmetic only), CSV (UTF-8 with BOM so Excel
// shows Arabic) and print-friendly bilingual, RTL-aware HTML. No dependencies.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Integer piastres -> "1,234.50" (or "1234.50" without grouping). Never goes through floating point. */
export function fmtMoney(p, group = true) {
  if (p == null || p === '') return '';
  const neg = p < 0;
  const a = Math.abs(p);
  const whole = String(Math.floor(a / 100));
  const frac = String(a % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${group ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole}.${frac}`;
}

function cell(col, v, forCsv) {
  if (v == null) return '';
  if (col.type === 'money') return fmtMoney(v, !forCsv);
  if (col.type === 'num') return String(v);
  return String(v);
}

// Spreadsheet formula injection guard: a text cell that starts with = + - @ tab or CR is prefixed with an apostrophe.
const FORMULA = /^[=+\-@\t\r]/;
function csvField(s, isText) {
  let v = String(s);
  if (isText && FORMULA.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v;
}

export const BOM = '﻿';

export function toCsv(report) {
  const cols = report.columns;
  const lines = [cols.map((c) => csvField(`${c.en} / ${c.ar}`, false)).join(',')];
  for (const r of report.rows) {
    lines.push(cols.map((c) => {
      const isText = c.type === 'text' || c.type === 'date';
      return csvField(cell(c, r[c.key], true), isText);
    }).join(','));
  }
  return BOM + lines.join('\r\n') + '\r\n';
}

/** Minimal RFC 4180 parser (strips the BOM). Used by tests and handy for importers. Returns string[][]. */
export function parseCsv(text) {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [], f = '', q = false, i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { f += '"'; i += 2; continue; } q = false; i++; continue; }
      f += ch; i++; continue;
    }
    if (ch === '"') { q = true; i++; continue; }
    if (ch === ',') { row.push(f); f = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(f); rows.push(row); row = []; f = ''; i++; continue;
    }
    f += ch; i++;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const CSS = `body{font:13px/1.45 system-ui,"Segoe UI",Tahoma,Arial,sans-serif;color:#111;margin:24px}
h1{font-size:20px;margin:0 0 4px}h1 .alt{color:#555;font-weight:500}
.meta{color:#555;margin:0 0 14px;font-size:12px}
table{width:100%;border-collapse:collapse}th,td{padding:4px 8px;border-bottom:1px solid #ddd;text-align:start;vertical-align:top}
th{background:#f3f4f6;font-size:12px}td.num,th.num{text-align:end;font-variant-numeric:tabular-nums;direction:ltr;unicode-bidi:plaintext}
tr.header td{font-weight:700;background:#fafafa}tr.total td,tr.subtotal td{font-weight:700;border-top:1px solid #888}
tr.check td{font-weight:700}.ok{color:#0a6b3d}.bad{color:#b42318}
.checks{margin:12px 0}.chart{margin:12px 0;page-break-inside:avoid}.chart svg{max-width:100%;height:auto}
footer{margin-top:18px;color:#666;font-size:11px}
@media print{body{margin:8mm}th{background:#eee!important;-webkit-print-color-adjust:exact}a{color:inherit;text-decoration:none}}`;

export function paramsLine(report) {
  const p = report.params;
  const bits = [];
  if (p.kind === 'asof') bits.push(`As of / كما في ${p.to}`);
  else if (p.from && p.to) bits.push(`${p.from} → ${p.to}`);
  if (p.compare) bits.push(`vs / مقارنة ${p.compare.from} → ${p.compare.to}`);
  if (p.entityId != null) bits.push(`Entity / الكيان ${p.entityId}`);
  if (p.account) bits.push(`Account / الحساب ${p.account}`);
  return bits.join(' · ');
}

export function toHtml(report, { lang = 'en', extra = '' } = {}) {
  const rtl = lang === 'ar';
  const cols = report.columns;
  const head = cols.map((c) => `<th class="${c.type === 'money' || c.type === 'num' ? 'num' : ''}">${esc(c.en)} <span class="alt">/ ${esc(c.ar)}</span></th>`).join('');
  const body = report.rows.map((r) => `<tr class="${esc(r.kind ?? 'line')}">${cols.map((c) => {
    const v = r[c.key];
    const num = c.type === 'money' || c.type === 'num';
    return `<td class="${num ? 'num' : ''}">${esc(cell(c, v, false))}</td>`;
  }).join('')}</tr>`).join('');
  const checks = (report.checks ?? []).length
    ? `<div class="checks">${report.checks.map((k) => `<div class="${k.ok ? 'ok' : 'bad'}">${k.ok ? '&#10003;' : '&#10007;'} ${esc(k.en)} / ${esc(k.ar)}${k.difference ? ` (${esc(fmtMoney(k.difference))})` : ''}</div>`).join('')}</div>`
    : '';
  return `<!doctype html>
<html lang="${rtl ? 'ar' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>${esc(report.title.en)} / ${esc(report.title.ar)}</title>
<style>${CSS}</style></head><body>
<h1>${esc(report.title.en)} <span class="alt">/ ${esc(report.title.ar)}</span></h1>
<p class="meta">${esc(paramsLine(report))}</p>
${extra}${report.rows.length ? `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` : `<p>No data for this period. / لا توجد بيانات لهذه الفترة.</p>`}
${checks}
<footer>Generated / أُنشئ ${esc(report.generatedAt)} · Amounts in EGP / المبالغ بالجنيه المصري</footer>
</body></html>`;
}
