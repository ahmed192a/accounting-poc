// Dependency-free accessible SVG charts. Every chart has role="img", <title>, <desc> (a text alternative
// that spells out the numbers) and per-mark <title> tooltips. Colour is never the only carrier of meaning:
// values are printed next to the marks. All text is escaped.
import { esc } from './format.js';

const W = 640, H = 300;
const compact = (p) => { // piastres -> short EGP text, integer arithmetic on whole pounds
  const e = Math.round(p / 100);
  const a = Math.abs(e);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}k` : String(a);
  return (e < 0 ? '-' : '') + s;
};
const full = (p) => (p / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function frame(id, title, desc, inner, lang) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-labelledby="${id}-t ${id}-d" dir="${lang === 'ar' ? 'rtl' : 'ltr'}" font-family="system-ui,Segoe UI,Tahoma,Arial,sans-serif" font-size="11">
<title id="${id}-t">${esc(title)}</title><desc id="${id}-d">${esc(desc)}</desc>${inner}</svg>`;
}
const empty = (id, title, msg, lang) => frame(id, title, msg, `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="currentColor">${esc(msg)}</text>`, lang);

/** Text alternative: "label: value; label: value". */
export const describe = (title, points) => `${title}. ${points.map((p) => `${p.label}: ${full(p.value)} EGP`).join('; ')}.`;

export function lineChart({ id, title, points, lang = 'en', emptyMsg = 'No data' }) {
  if (!points.length) return empty(id, title, emptyMsg, lang);
  const L = 56, R = 16, T = 28, B = 40, iw = W - L - R, ih = H - T - B;
  const vals = points.map((p) => p.value);
  let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  if (hi === lo) hi = lo + 100;
  const x = (i) => L + (points.length === 1 ? iw / 2 : (iw * i) / (points.length - 1));
  const y = (v) => T + ih - ((v - lo) / (hi - lo)) * ih;
  const rtl = lang === 'ar';
  const xp = (i) => (rtl ? W - x(i) : x(i));
  const grid = [0, 1, 2, 3, 4].map((k) => {
    const v = lo + ((hi - lo) * k) / 4;
    return `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="currentColor" stroke-opacity=".15"/><text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" fill="currentColor">${compact(v)}</text>`;
  }).join('');
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${xp(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const step = Math.ceil(points.length / 8);
  const dots = points.map((p, i) => `<circle cx="${xp(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3.5" fill="var(--accent,#1f6feb)"><title>${esc(p.label)}: ${full(p.value)}</title></circle>${i % step === 0 ? `<text x="${xp(i).toFixed(1)}" y="${H - B + 16}" text-anchor="middle" fill="currentColor">${esc(p.label)}</text>` : ''}`).join('');
  const zero = lo < 0 ? `<line x1="${L}" x2="${W - R}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="currentColor" stroke-dasharray="4 3"/>` : '';
  const inner = `<text x="${W / 2}" y="16" text-anchor="middle" font-weight="600" fill="currentColor">${esc(title)}</text>${grid}${zero}<path d="${path}" fill="none" stroke="var(--accent,#1f6feb)" stroke-width="2"/>${dots}`;
  return frame(id, title, describe(title, points), inner, lang);
}

/** Horizontal bars with the value printed at the end of each bar. */
export function hbarChart({ id, title, points, lang = 'en', emptyMsg = 'No data' }) {
  const data = points.filter((p) => p.value !== 0);
  if (!data.length) return empty(id, title, emptyMsg, lang);
  const rtl = lang === 'ar';
  const rows = data.slice(0, 10);
  const L = 150, R = 80, T = 30, rowH = Math.min(26, (H - T - 10) / rows.length);
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  const iw = W - L - R;
  const bars = rows.map((r, i) => {
    const w = Math.max(2, (Math.abs(r.value) / max) * iw);
    const yy = T + i * rowH;
    const bx = rtl ? W - L - w : L;
    const lx = rtl ? W - L + 6 : L - 6;
    const vx = rtl ? bx - 6 : bx + w + 6;
    const label = r.label.length > 22 ? `${r.label.slice(0, 21)}…` : r.label;
    return `<text x="${lx}" y="${(yy + rowH / 2 + 4).toFixed(1)}" text-anchor="${rtl ? 'start' : 'end'}" fill="currentColor">${esc(label)}</text>
<rect x="${bx.toFixed(1)}" y="${(yy + 3).toFixed(1)}" width="${w.toFixed(1)}" height="${(rowH - 6).toFixed(1)}" rx="2" fill="var(--accent,#1f6feb)"><title>${esc(r.label)}: ${full(r.value)}</title></rect>
<text x="${vx.toFixed(1)}" y="${(yy + rowH / 2 + 4).toFixed(1)}" text-anchor="${rtl ? 'end' : 'start'}" fill="currentColor">${compact(r.value)}</text>`;
  }).join('');
  const inner = `<text x="${W / 2}" y="16" text-anchor="middle" font-weight="600" fill="currentColor">${esc(title)}</text>${bars}`;
  return frame(id, title, describe(title, rows), inner, lang);
}
