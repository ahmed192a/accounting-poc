// Pure CSV statement parsing: no database, no clock. Money is returned as integer piastres, never floats.
import { createHash } from 'node:crypto';

export const DATE_FORMATS = ['YYYY-MM-DD', 'YYYY/MM/DD', 'DD/MM/YYYY', 'DD-MM-YYYY', 'DD.MM.YYYY', 'MM/DD/YYYY', 'MM-DD-YYYY', 'D/M/YYYY'];
export const METHODS = ['cash', 'instapay', 'fawry', 'wallet', 'card', 'bank_transfer', 'other'];

/** Arabic-Indic (U+0660..) and Extended Arabic-Indic (U+06F0..) digits and Arabic separators -> ASCII. */
export function normalizeDigits(s) {
  return String(s ?? '')
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.') // Arabic decimal separator
    .replace(/٬/g, ',') // Arabic thousands separator
    .replace(/،/g, ','); // Arabic comma
}

/** Strip a UTF-8 BOM (decoded as U+FEFF) and normalise line endings are left to the parser. */
export const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

export function detectDelimiter(text) {
  const first = stripBom(text).split(/\r?\n/).find((l) => l.trim()) ?? '';
  let best = ',', bestN = -1;
  for (const d of [',', ';', '\t', '|']) {
    // count delimiters outside quotes
    let n = 0, q = false;
    for (const ch of first) { if (ch === '"') q = !q; else if (ch === d && !q) n++; }
    if (n > bestN) { best = d; bestN = n; }
  }
  return best;
}

/**
 * RFC-4180-style parser: quoted fields, "" escapes, commas and newlines inside quotes, CRLF/LF/CR.
 * Returns { records: [{ cells, line }], error } where `line` is the physical line the record starts on.
 * An unterminated quote is reported as an error with the line where the quote opened.
 */
export function parseCsv(text, delimiter = ',') {
  const s = stripBom(String(text ?? ''));
  const records = [];
  let cells = [], cell = '', inQ = false, quoted = false, line = 1, startLine = 1, qLine = 1, i = 0;
  const endCell = () => { cells.push(cell); cell = ''; quoted = false; };
  const endRecord = () => {
    endCell();
    if (!(cells.length === 1 && cells[0].trim() === '' )) records.push({ cells, line: startLine });
    cells = [];
  };
  while (i < s.length) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      if (ch === '\n') line++;
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === '' && !quoted) { inQ = true; quoted = true; qLine = line; i++; continue; }
    if (ch === delimiter) { endCell(); i++; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      i++; line++;
      endRecord(); startLine = line; continue;
    }
    cell += ch; i++;
  }
  if (inQ) return { records, error: { line: qLine, message: `Unterminated quoted field starting on line ${qLine}` } };
  if (cell !== '' || cells.length || quoted) endRecord();
  return { records, error: null };
}

/**
 * Parse a money string to signed integer piastres. Handles Arabic-Indic digits, thousands separators,
 * decimal comma or point, parentheses and trailing minus for negatives, and currency words/symbols.
 * decimal: 'auto' | '.' | ','. Returns null for an empty cell; throws Error(message) when malformed.
 */
export function parseAmount(raw, decimal = 'auto') {
  let s = normalizeDigits(raw).replace(/[\s ‎‏]/g, '');
  if (s === '') return null;
  s = s.replace(/(egp|le|ج\.?م\.?|جنيه|\$|£|€)/gi, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-') || s.startsWith('−')) { neg = !neg || neg; s = s.slice(1); neg = true; }
  else if (s.startsWith('+')) s = s.slice(1);
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  if (!/^[0-9.,]+$/.test(s) || !/[0-9]/.test(s)) throw new Error(`"${String(raw).trim()}" is not a valid amount`);
  let dec = decimal;
  if (dec === 'auto') {
    const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) dec = lastDot > lastComma ? '.' : ',';
    else if (lastDot >= 0 || lastComma >= 0) {
      const sep = lastDot >= 0 ? '.' : ',';
      const parts = s.split(sep);
      // one separator followed by exactly 3 digits is thousands ("1,234" = 1234.00, documented); several = thousands; else decimal
      dec = parts.length === 2 && parts[1].length !== 3 ? sep : '';
    } else dec = '';
  }
  const thousands = dec === '.' ? ',' : dec === ',' ? '.' : s.includes(',') ? ',' : '.';
  let intPart = s, frac = '';
  if (dec) {
    const idx = s.lastIndexOf(dec);
    if (idx >= 0) { intPart = s.slice(0, idx); frac = s.slice(idx + 1); }
  }
  if (frac.includes(thousands) || frac.includes(dec || '\0')) throw new Error(`"${String(raw).trim()}" is not a valid amount`);
  intPart = intPart.split(thousands).join('');
  if (/[.,]/.test(intPart)) throw new Error(`"${String(raw).trim()}" is not a valid amount`);
  if (frac.length > 2 && /[1-9]/.test(frac.slice(2))) throw new Error(`"${String(raw).trim()}" has more than 2 decimal places`);
  frac = (frac + '00').slice(0, 2);
  if (intPart === '') intPart = '0';
  if (intPart.length > 13) throw new Error(`"${String(raw).trim()}" is too large`);
  const value = Number(intPart) * 100 + Number(frac);
  if (!Number.isSafeInteger(value)) throw new Error(`"${String(raw).trim()}" is too large`);
  return neg ? -value : value;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
function validYmd(y, m, d) {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= dim;
}

/** Parse a date in one of DATE_FORMATS (Arabic digits ok; a trailing time part is ignored). Returns YYYY-MM-DD or throws. */
export function parseDate(raw, format = 'YYYY-MM-DD') {
  if (!DATE_FORMATS.includes(format)) throw new Error(`Unknown date format ${format}`);
  const s = normalizeDigits(raw).trim().replace(/[T\s].*$/, '');
  if (!s) throw new Error('date is empty');
  const parts = s.split(/[-/.]/);
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) throw new Error(`"${String(raw).trim()}" is not a date in format ${format}`);
  const order = format.replace(/[^YMD]/g, '').replace(/(.)\1+/g, '$1'); // e.g. "DMY"
  const v = {};
  order.split('').forEach((k, i) => { v[k] = parts[i]; });
  const y = Number(v.Y), m = Number(v.M), d = Number(v.D);
  if (v.Y.length !== 4) throw new Error(`"${String(raw).trim()}" needs a 4-digit year (format ${format})`);
  if (!validYmd(y, m, d)) throw new Error(`"${String(raw).trim()}" is not a real calendar date (format ${format})`);
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** Normalise a free-text payment method to one of METHODS (unknown -> 'other'). */
export function normalizeMethod(v) {
  const s = String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!s) return null;
  if (METHODS.includes(s)) return s;
  if (s.includes('insta')) return 'instapay';
  if (s.includes('fawry') || s.includes('فوري')) return 'fawry';
  if (s.includes('wallet') || s.includes('محفظ')) return 'wallet';
  if (s.includes('card') || s.includes('visa') || s.includes('master') || s.includes('بطاق')) return 'card';
  if (s.includes('transfer') || s.includes('تحويل')) return 'bank_transfer';
  if (s.includes('cash') || s.includes('نقد')) return 'cash';
  return 'other';
}

const normText = (s) => normalizeDigits(s).replace(/\s+/g, ' ').trim().toLowerCase();

export function rowHash(accountId, line, occurrence) {
  return createHash('sha256')
    .update([accountId, line.date, line.amount, normText(line.description), normText(line.reference), occurrence].join('|'))
    .digest('hex');
}

function colIndex(spec, headers, what, required) {
  if (spec === undefined || spec === null || spec === '') {
    if (required) throw new Error(`mapping.${what} is required`);
    return -1;
  }
  if (Number.isInteger(spec)) return spec;
  const i = headers.findIndex((h) => normText(h) === normText(spec));
  if (i < 0) throw new Error(`mapping.${what}: column "${spec}" not found in header (${headers.map((h) => `"${h}"`).join(', ')})`);
  return i;
}

/**
 * Turn CSV text into statement lines using a mapping. Never throws for bad rows: they are returned in
 * `errors` with their record number (header = row 1) and physical line. Mapping problems throw Error.
 * mapping: { delimiter?, hasHeader=true, dateCol, dateFormat, descriptionCol, referenceCol?, amountCol? |
 *            debitCol+creditCol, balanceCol?, methodCol?, defaultMethod?, decimal='auto', invertSign? }
 * Debit/credit columns: credit = money in, debit = money out (bank statement view).
 */
export function mapStatement(text, mapping, accountId) {
  const m = mapping ?? {};
  const delimiter = m.delimiter === 'tab' ? '\t' : m.delimiter || detectDelimiter(text);
  const { records, error } = parseCsv(text, delimiter);
  const hasHeader = m.hasHeader !== false;
  const out = { delimiter, lines: [], errors: [], totalRows: 0, headers: [] };
  if (error) out.errors.push({ row: null, line: error.line, message: error.message });
  if (!records.length) { out.errors.push({ row: null, line: 1, message: 'The file has no rows' }); return out; }
  const headers = hasHeader ? records[0].cells.map((c) => c.trim()) : records[0].cells.map((_, i) => `#${i}`);
  out.headers = headers;
  const dateI = colIndex(m.dateCol, headers, 'dateCol', true);
  const descI = colIndex(m.descriptionCol, headers, 'descriptionCol', false);
  const refI = colIndex(m.referenceCol, headers, 'referenceCol', false);
  const amtI = colIndex(m.amountCol, headers, 'amountCol', false);
  const debI = colIndex(m.debitCol, headers, 'debitCol', false);
  const creI = colIndex(m.creditCol, headers, 'creditCol', false);
  const balI = colIndex(m.balanceCol, headers, 'balanceCol', false);
  const metI = colIndex(m.methodCol, headers, 'methodCol', false);
  if (amtI < 0 && (debI < 0 || creI < 0)) throw new Error('mapping needs amountCol, or both debitCol and creditCol');
  if (amtI >= 0 && (debI >= 0 || creI >= 0)) throw new Error('mapping: use amountCol or debitCol/creditCol, not both');
  const dateFormat = m.dateFormat || 'YYYY-MM-DD';
  if (!DATE_FORMATS.includes(dateFormat)) throw new Error(`mapping.dateFormat must be one of ${DATE_FORMATS.join(', ')}`);
  const decimal = m.decimal || 'auto';
  if (!['auto', '.', ','].includes(decimal)) throw new Error("mapping.decimal must be 'auto', '.' or ','");
  const defaultMethod = m.defaultMethod ? normalizeMethod(m.defaultMethod) : null;

  const need = Math.max(dateI, descI, refI, amtI, debI, creI, balI, metI);
  const seen = new Map();
  const body = hasHeader ? records.slice(1) : records;
  body.forEach((rec, idx) => {
    const row = idx + (hasHeader ? 2 : 1);
    out.totalRows++;
    const c = rec.cells;
    const fail = (message) => out.errors.push({ row, line: rec.line, message });
    if (c.length <= need) return fail(`Row has ${c.length} columns but the mapping needs at least ${need + 1}`);
    let date, amount, balance = null;
    try { date = parseDate(c[dateI], dateFormat); } catch (e) { return fail(`Date: ${e.message}`); }
    try {
      if (amtI >= 0) {
        amount = parseAmount(c[amtI], decimal);
        if (amount === null) return fail('Amount is empty');
      } else {
        const d = parseAmount(c[debI], decimal), cr = parseAmount(c[creI], decimal);
        if ((d === null || d === 0) && (cr === null || cr === 0)) return fail('Both debit and credit are empty');
        if (d && cr) return fail('Both debit and credit have a value');
        amount = cr ? Math.abs(cr) : -Math.abs(d);
      }
      if (balI >= 0 && c[balI].trim() !== '') balance = parseAmount(c[balI], decimal);
    } catch (e) { return fail(`Amount: ${e.message}`); }
    if (m.invertSign) amount = -amount;
    if (amount === 0) return fail('Amount is zero');
    const description = descI >= 0 ? c[descI].trim() : '';
    const reference = refI >= 0 ? c[refI].trim() : '';
    if (description.length > 500 || reference.length > 200) return fail('Description or reference is too long');
    const base = { date, amount, description, reference };
    const key = `${date}|${amount}|${normText(description)}|${normText(reference)}`;
    const occurrence = (seen.get(key) ?? 0) + 1; // identical rows inside ONE file are legitimate: number them
    seen.set(key, occurrence);
    const method = (metI >= 0 && normalizeMethod(c[metI])) || defaultMethod;
    out.lines.push({ row, ...base, balance, method, hash: rowHash(accountId, base, occurrence) });
  });
  return out;
}

/** Look at a file and suggest a mapping from its header (used by the import wizard). */
export function inspectCsv(text) {
  const delimiter = detectDelimiter(text);
  const { records, error } = parseCsv(text, delimiter);
  if (error) throw Object.assign(new Error(error.message), { line: error.line });
  const headers = (records[0]?.cells ?? []).map((c) => c.trim());
  const find = (...res) => headers.find((h) => res.some((r) => r.test(h))) ?? null;
  const suggested = {
    delimiter, hasHeader: true,
    dateCol: find(/date|تاريخ/i),
    descriptionCol: find(/desc|narr|detail|particular|memo|بيان|وصف|تفاصيل/i),
    referenceCol: find(/ref|مرجع|رقم/i),
    amountCol: find(/^amount|المبلغ|قيمة/i),
    debitCol: find(/debit|withdraw|مدين|سحب/i),
    creditCol: find(/credit|deposit|دائن|إيداع|ايداع/i),
    balanceCol: find(/balance|رصيد/i),
    dateFormat: 'YYYY-MM-DD', decimal: 'auto',
  };
  if (suggested.amountCol) { suggested.debitCol = null; suggested.creditCol = null; }
  const sample = records.slice(1, 6).map((r) => r.cells);
  const first = normalizeDigits(sample[0]?.[headers.indexOf(suggested.dateCol)] ?? '');
  if (/^\d{4}[-/]/.test(first)) suggested.dateFormat = first.includes('/') ? 'YYYY/MM/DD' : 'YYYY-MM-DD';
  else if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(first)) suggested.dateFormat = 'DD/MM/YYYY';
  else if (/^\d{1,2}-\d{1,2}-\d{4}/.test(first)) suggested.dateFormat = 'DD-MM-YYYY';
  return { delimiter, headers, sample, suggested, rows: Math.max(0, records.length - 1) };
}
