// MOCK document extractor: a deterministic, rule-based heuristic over pasted receipt / OCR text, English and Arabic.
// It is NOT machine learning and there is no OCR anywhere in this app. It exists to prove the safe workflow around
// AI (suggestions with per-field confidence and reasons, human review, reversible acceptance) and to be replaced
// by a real provider behind the same interface: extract(text, { lookupCategory }) -> { fields, confidence, reasons }.
import { isoDate } from '../../ledger.js';

export const CATEGORIES = ['purchases', 'rent', 'utilities'];

const AR_DIGITS = /[٠-٩۰-۹]/g;
export function normalizeDigits(s) {
  return s
    .replace(AR_DIGITS, (d) => String(d.charCodeAt(0) >= 0x06f0 ? d.charCodeAt(0) - 0x06f0 : d.charCodeAt(0) - 0x0660))
    .replace(/٫/g, '.').replace(/٬/g, ',').replace(/،/g, ',');
}
// For keyword matching: lower-case, strip Arabic diacritics and tatweel, fold alef / yaa / taa-marbuta variants.
export const fold = (s) => s.toLowerCase().replace(/[ً-ٟـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');

export const supplierKey = (name) => fold(String(name)).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** "1,234.50" "1.234,50" "١٢٣٫٥٠" "114" -> integer piastres, or null. No floats are used. */
export function parseAmount(token) {
  const t = token.replace(/[.,]+$/, '');
  if (!/^\d[\d.,]*$/.test(t)) return null;
  const lastSep = Math.max(t.lastIndexOf('.'), t.lastIndexOf(','));
  let intPart = t, frac = '';
  if (lastSep >= 0) {
    const after = t.slice(lastSep + 1);
    if (after.length <= 2) { intPart = t.slice(0, lastSep); frac = after; } // 1-2 digits after the last separator = decimals
    else if (after.length !== 3) return null;                              // exactly 3 = a thousands group; anything else is not an amount
  }
  const digits = intPart.replace(/[.,]/g, '');
  if (!digits || digits.length > 12) return null;
  return Number(digits) * 100 + Number((frac + '00').slice(0, 2));
}

function amountsIn(line) {
  // numbers on a line, skipping percentages ("14%" / "%14") and tax-id-like long digit runs
  const out = [];
  const re = /\d[\d.,]*/g;
  let m;
  while ((m = re.exec(line))) {
    const before = line.slice(Math.max(0, m.index - 1), m.index), after = line.slice(m.index + m[0].length, m.index + m[0].length + 2);
    if (/%/.test(after) || /%/.test(before) || /^\s*%/.test(after)) continue;
    if (m[0].replace(/\D/g, '').length > 10) continue;
    const v = parseAmount(m[0]);
    if (v != null) out.push(v);
  }
  return out;
}
function percentIn(line) {
  const m = /(\d{1,2}(?:[.,]\d+)?)\s*%|%\s*(\d{1,2}(?:[.,]\d+)?)/.exec(line);
  return m ? Number((m[1] ?? m[2]).replace(',', '.')) : null;
}

const TOTAL_KW = ['grand total', 'total due', 'amount due', 'balance due', 'net amount', 'total', 'اجمالي', 'الاجمالي', 'المجموع', 'مجموع', 'الصافي', 'المطلوب', 'المبلغ المستحق', 'المبلغ الاجمالي'];
const SUBTOTAL_KW = ['subtotal', 'sub total', 'sub-total', 'قبل الضريبه', 'الاجمالي الفرعي', 'المجموع الفرعي', 'اجمالي قبل'];
const VAT_KW = ['vat', 'tax', 'ضريبه', 'القيمه المضافه'];
const VAT_ABBR = /ض\s*\.?\s*ق\s*\.?\s*م/;
const has = (folded, kws) => kws.some((k) => (/^[a-z -]+$/.test(k) ? new RegExp(`(^|[^a-z])${k.replace(/[- ]/g, '[- ]?')}([^a-z]|$)`).test(folded) : folded.includes(k)));
const isVatLine = (raw, folded) => has(folded, VAT_KW) || VAT_ABBR.test(raw);

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  يناير: 1, فبراير: 2, مارس: 3, ابريل: 4, مايو: 5, يونيو: 6, يوليو: 7, اغسطس: 8, سبتمبر: 9, اكتوبر: 10, نوفمبر: 11, ديسمبر: 12,
};

const realDate = (y, m, d) => {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isoDate(Date.parse(iso + 'T00:00:00Z')) === iso ? iso : null;
};

function findDate(lines) {
  const cands = [];
  lines.forEach((raw, idx) => {
    const line = raw, f = fold(raw);
    const labelled = /date|التاريخ|تاريخ/.test(f);
    let m;
    const ymd = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/g;
    while ((m = ymd.exec(line))) { const d = realDate(+m[1], +m[2], +m[3]); if (d) cands.push({ d, labelled, idx, why: 'Year-month-day format', conf: 0.95 }); }
    const dmy = /(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/g;
    while ((m = dmy.exec(line))) {
      const a = +m[1], b = +m[2], y = +m[3];
      let d, why, conf;
      if (a > 12) { d = realDate(y, b, a); why = 'Day/month/year (the first number is above 12)'; conf = 0.9; }
      else if (b > 12) { d = realDate(y, a, b); why = 'Month/day/year (the second number is above 12)'; conf = 0.8; }
      else { d = realDate(y, b, a); why = 'Ambiguous numeric date; read as day/month/year, the usual order in Egypt'; conf = 0.6; }
      if (d) cands.push({ d, labelled, idx, why, conf });
    }
    const dMonY = /(\d{1,2})\s+([a-zA-Z؀-ۿ]{3,})\.?,?\s+(\d{4})/g;
    while ((m = dMonY.exec(line))) {
      const mon = MONTHS[fold(m[2]).slice(0, 3)] ?? MONTHS[fold(m[2])];
      const d = mon && realDate(+m[3], mon, +m[1]);
      if (d) cands.push({ d, labelled, idx, why: 'Written-out month name', conf: 0.9 });
    }
    const monDY = /([a-zA-Z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/g;
    while ((m = monDY.exec(line))) {
      const mon = MONTHS[m[1].toLowerCase().slice(0, 3)];
      const d = mon && realDate(+m[3], mon, +m[2]);
      if (d) cands.push({ d, labelled, idx, why: 'Written-out month name', conf: 0.9 });
    }
  });
  if (!cands.length) return null;
  return cands.find((c) => c.labelled) ?? cands[0];
}

const CURRENCIES = [
  ['EGP', /\bEGP\b|\bL\.?E\.?\b|جنيه|ج\.?\s?م/i],
  ['USD', /\bUSD\b|\$|دولار/i],
  ['EUR', /\bEUR\b|€|يورو/i],
  ['SAR', /\bSAR\b|ر\.?\s?س\b|ريال/i],
  ['AED', /\bAED\b|درهم/i],
];

const NOT_NAME = /^(tax invoice|invoice|receipt|cash receipt|فاتوره|فاتورة|ايصال|إيصال|welcome|thank|شكرا|tel|phone|هاتف|تليفون|date|time|no\.?|#)/i;
const SUPPLIER_LABEL = /^\s*(?:supplier|vendor|merchant|store|from|المورد|البائع|اسم المحل|المحل|الشركه|الشركة)\s*[:\-–]\s*(.+)$/i;

const CAT_HINTS = [
  ['utilities', ['electric', 'electricity', 'water', 'gas company', 'internet', 'telecom', 'vodafone', 'etisalat', 'orange', 'utility', 'كهرباء', 'الكهرباء', 'مياه', 'المياه', 'غاز', 'انترنت', 'الانترنت', 'اتصالات', 'فودافون', 'اورنج', 'مرافق']],
  ['rent', ['rent', 'lease', 'landlord', 'ايجار', 'الايجار', 'استئجار']],
  ['purchases', ['supermarket', 'market', 'wholesale', 'goods', 'stock', 'supplies', 'trading', 'سوبر', 'ماركت', 'بضاعه', 'مشتريات', 'جمله', 'تجاره']],
];

/** The heuristic MOCK extractor. `opts.lookupCategory(supplierKey)` returns a category learned from earlier corrections, or null. */
export function extractHeuristic(text, opts = {}) {
  const normalized = normalizeDigits(String(text));
  const lines = normalized.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const fields = {}, confidence = {}, reasons = {};

  // supplier
  let supplier = null;
  for (const l of lines) {
    const m = SUPPLIER_LABEL.exec(l);
    if (m) { supplier = m[1].replace(/[*=#_]+/g, '').trim(); confidence.supplier = 0.9; reasons.supplier = 'Found a line labelled supplier / المورد.'; break; }
  }
  if (!supplier) {
    for (const l of lines.slice(0, 6)) {
      const clean = l.replace(/[*=#_\-~|]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (clean.length < 2 || !/\p{L}{2}/u.test(clean) || NOT_NAME.test(fold(clean)) || NOT_NAME.test(clean)) continue;
      if (/^\d/.test(clean) || amountsIn(clean).length > 1) continue;
      supplier = clean; confidence.supplier = 0.6; reasons.supplier = 'No supplier label; used the first line that looks like a business name. Please check it.';
      break;
    }
  }
  fields.supplier = supplier;
  if (!supplier) { confidence.supplier = 0; reasons.supplier = 'Could not find a supplier name.'; }

  // date
  const d = findDate(lines);
  fields.date = d?.d ?? null;
  confidence.date = d ? d.conf : 0;
  reasons.date = d ? `${d.why}${d.labelled ? ', on a line labelled date' : ''}.` : 'No date found; enter one before accepting.';

  // currency
  const all = normalized;
  const cur = CURRENCIES.find(([, re]) => re.test(all));
  fields.currency = cur ? cur[0] : 'EGP';
  confidence.currency = cur ? 0.9 : 0.5;
  reasons.currency = cur ? `Found a ${cur[0]} marker in the text.` : 'No currency printed; assumed EGP.';

  // total
  let total = null, totalWhy = '', totalConf = 0;
  const totalHits = [];
  lines.forEach((l, i) => {
    const f = fold(l);
    if (!has(f, TOTAL_KW) || has(f, SUBTOTAL_KW) || isVatLine(l, f)) return;
    let a = amountsIn(l);
    if (!a.length && lines[i + 1] && !has(fold(lines[i + 1]), TOTAL_KW)) a = amountsIn(lines[i + 1]);
    if (a.length) totalHits.push(a[a.length - 1]);
  });
  if (totalHits.length) {
    total = totalHits[totalHits.length - 1];
    const agree = totalHits.every((x) => x === total);
    totalConf = agree ? 0.9 : 0.7;
    totalWhy = agree ? 'Taken from the line labelled total / الإجمالي.' : 'Several different total lines; used the last one. Please check it.';
  } else {
    const nums = lines.filter((l) => !isVatLine(l, fold(l))).flatMap(amountsIn);
    if (nums.length) { total = Math.max(...nums); totalConf = 0.4; totalWhy = 'No total line found; used the largest amount in the text.'; }
  }
  fields.total = total;
  confidence.total = total == null ? 0 : totalConf;
  reasons.total = total == null ? 'No amounts found; enter the total before accepting.' : totalWhy;

  // VAT
  let vat = null;
  for (const l of lines) {
    const f = fold(l);
    if (!isVatLine(l, f) || has(f, ['vat number', 'tax id', 'tax no', 'tax reg', 'رقم ضريبي', 'الرقم الضريبي', 'سجل ضريبي'])) continue;
    const a = amountsIn(l);
    if (a.length) { vat = a[a.length - 1]; confidence.vat = 0.85; reasons.vat = 'Taken from the VAT / ضريبة line.'; break; }
    const pct = percentIn(l);
    if (pct != null && total != null) {
      const bp = Math.round(pct * 100);
      vat = total - Math.round((total * 10000) / (10000 + bp));
      confidence.vat = 0.5; reasons.vat = `Only a ${pct}% rate was printed; estimated the VAT as included in the total (UNVERIFIED assumption).`;
      break;
    }
  }
  if (vat == null || (total != null && vat >= total)) {
    vat = 0; confidence.vat = 0.3; reasons.vat = 'No usable VAT amount found; assumed 0.';
  }
  fields.vat = vat;

  // category: learned correction > keywords > default
  const learned = supplier ? opts.lookupCategory?.(supplierKey(supplier)) ?? null : null;
  if (learned) { fields.category = learned; confidence.category = 0.95; reasons.category = 'You corrected this supplier to this category before; applying that rule.'; }
  else {
    const body = fold(`${supplier ?? ''}\n${normalized}`);
    const hit = CAT_HINTS.map(([c, kws]) => [c, kws.find((k) => has(body, [fold(k)]))]).find(([, k]) => k);
    if (hit) { fields.category = hit[0]; confidence.category = 0.65; reasons.category = `The word "${hit[1]}" suggests ${hit[0]}.`; }
    else { fields.category = 'purchases'; confidence.category = 0.3; reasons.category = 'No hint found; defaulted to purchases. Please check it.'; }
  }
  return { fields, confidence, reasons };
}
