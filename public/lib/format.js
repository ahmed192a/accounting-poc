// Pure number/money/date formatting and parsing. No DOM access, importable from node:test.
// Money is integer piastres (1 EGP = 100). Digits: 'auto' (locale default), 'latn' (0-9), 'arab' (Arabic-Indic).

export const DIGIT_MODES = ['auto', 'latn', 'arab'];

export function normalizeDigits(mode) { return DIGIT_MODES.includes(mode) ? mode : 'auto'; }

/** BCP-47 tag for Intl, optionally forcing the numbering system. */
export function localeTag(lang, digits = 'auto') {
  const base = lang === 'ar' ? 'ar-EG' : 'en-US';
  const d = normalizeDigits(digits);
  return d === 'auto' ? base : `${base}-u-nu-${d}`;
}

export function formatNumber(n, lang, digits, opts) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n.toLocaleString(localeTag(lang, digits), opts);
}

export function formatMoney(piastres, lang, digits) {
  if (typeof piastres !== 'number' || !Number.isFinite(piastres)) return '—';
  const num = (piastres / 100).toLocaleString(localeTag(lang, digits), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return num + (lang === 'ar' ? ' ج.م' : ' EGP');
}

/** Arabic-Indic (U+0660..) and Eastern/Persian (U+06F0..) digits to 0-9; Arabic decimal and thousands separators normalised. */
export function toWesternDigits(s) {
  return String(s ?? '')
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',');
}

/**
 * Parse what a person typed into integer piastres, or NaN. Accepts Latin or Arabic-Indic digits, "1,234.50",
 * "1.234,50" is NOT guessed (ambiguous). "12,5" (comma + 1-2 digits, no dot) is read as a decimal comma.
 * Rounds half up on the third decimal using string arithmetic (no float error). Empty input is 0.
 */
export function parseAmountToPiastres(v) {
  let s = toWesternDigits(v).replace(/[\s  ‎‏]/g, '');
  if (s === '') return 0;
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^[+-]?\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && !m[3])) return NaN;
  const frac = m[3] ?? '';
  let cents = Number(m[2] || '0') * 100 + Number((frac + '00').slice(0, 2));
  if (frac.length > 2 && frac[2] >= '5') cents += 1;
  return m[1] === '-' ? -cents : cents;
}

export function formatDate(value, lang, digits, opts = { year: 'numeric', month: 'short', day: 'numeric' }) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(localeTag(lang, digits), opts);
}
