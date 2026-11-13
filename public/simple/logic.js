// Simple mode: pure logic (no DOM, no fetch) so node:test can cover it. Money is always integer piastres.
// Nothing here talks to the ledger; the shell sends the results to the existing endpoints.

export const DAY_MS = 86_400_000;

/** Cart is an array of { sku, qty }, in the order items were first added. Returns a new array; qty 0 removes the line. */
export function setQty(cart, sku, qty) {
  const q = Math.max(0, Math.min(9999, Math.trunc(Number(qty) || 0)));
  const has = cart.some((l) => l.sku === sku);
  const next = has ? cart.map((l) => (l.sku === sku ? { sku, qty: q } : l)) : [...cart, { sku, qty: q }];
  return next.filter((l) => l.qty > 0);
}
export const addOne = (cart, sku, delta = 1) => setQty(cart, sku, (cart.find((l) => l.sku === sku)?.qty ?? 0) + delta);

/** Cart lines joined to the catalogue; unknown or inactive skus are dropped. */
export function cartLines(cart, items) {
  const by = new Map(items.map((i) => [i.sku, i]));
  return cart.filter((l) => by.has(l.sku)).map((l) => {
    const i = by.get(l.sku);
    return { sku: l.sku, qty: l.qty, name: i.name, nameAr: i.name_ar || i.name, unitPrice: i.price, amount: i.price * l.qty };
  });
}
export const cartSubtotal = (lines) => lines.reduce((s, l) => s + l.amount, 0);
/** Same rounding as the server (src/modules/sales/common.js vatOf). An ESTIMATE: the server's figure is the one that counts. */
export const estimateVat = (subtotal, vatRateBp) => Math.round((subtotal * Number(vatRateBp || 0)) / 10000);

export function filterItems(items, q, lang = 'en') {
  const s = String(q ?? '').trim().toLowerCase();
  if (!s) return items;
  return items.filter((i) => [i.name, i.name_ar, i.sku].some((v) => String(v ?? '').toLowerCase().includes(s)))
    .sort((a, b) => Number(String(b[lang === 'ar' ? 'name_ar' : 'name']).toLowerCase().startsWith(s)) - Number(String(a[lang === 'ar' ? 'name_ar' : 'name']).toLowerCase().startsWith(s)));
}

/** Typed or scanned code: exact sku (any case) wins. The server barcode lookup is tried first by the shell. */
export const matchCode = (items, code) => items.find((i) => i.sku.toLowerCase() === String(code ?? '').trim().toLowerCase()) ?? null;

/** Invoice lines for POST /api/invoices from cart lines. */
export const invoiceLines = (lines) => lines.map((l) => ({ description: l.name, qty: l.qty, unitPrice: l.unitPrice, sku: l.sku }));
export const quickItems = (lines) => lines.map((l) => ({ sku: l.sku, qty: l.qty }));

/** Aging rows to owed rows: days late = the oldest overdue invoice; sorted most late first, then biggest. */
export function rankOwed(rows) {
  return rows.map((r) => {
    const open = [...(r.invoices ?? [])].sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.id - b.id));
    return { customerId: r.customerId ?? null, name: r.customer, total: r.total, daysLate: open.reduce((m, i) => Math.max(m, i.daysPastDue || 0), 0), invoices: open };
  }).sort((a, b) => b.daysLate - a.daysLate || b.total - a.total || a.name.localeCompare(b.name));
}

/** Oldest-due-first allocation of a (possibly partial) payment. Returns { allocations, left } or throws on bad amounts. */
export function planAllocations(invoices, amount) {
  if (!Number.isInteger(amount) || amount <= 0) throw new RangeError('amount must be a positive whole number of piastres');
  let left = amount; const allocations = [];
  for (const inv of invoices) {
    if (left <= 0) break;
    const take = Math.min(left, inv.balance);
    if (take > 0) { allocations.push({ invoiceId: inv.id, amount: take }); left -= take; }
  }
  return { allocations, left };
}

/** Whole days between an ISO date and today (UTC date, as the server uses). */
export const isoToday = (nowMs = Date.now()) => new Date(nowMs).toISOString().slice(0, 10);

/** Sold today = quick (cash) sales from the home widget + invoices issued today that are not void. Counts credit and wallet sales too. */
export function soldToday({ total: quickTotal = 0, count: quickCount = 0 }, invoices, today) {
  const mine = invoices.filter((i) => i.issue_date === today && i.status !== 'draft' && i.status !== 'void' && !i.entry_reversed);
  return { total: quickTotal + mine.reduce((s, i) => s + i.total, 0), count: quickCount + mine.length };
}

/** Digits for wa.me in international form, like the server's waNumber: 0xxxxxxxx becomes <countryCode>xxxxxxxx. Country code 20 (Egypt) is UNVERIFIED outside Egypt. */
export function waDigits(phone, countryCode = '20') {
  const raw = String(phone ?? '').replace(/[^\d+]/g, '');
  let d = raw.replace(/\D/g, '');
  if (!raw.startsWith('+')) { if (d.startsWith('00')) d = d.slice(2); else if (d.startsWith('0')) d = countryCode + d.slice(1); }
  return d;
}
export function whatsappLink(text, phone, countryCode = '20') {
  const d = waDigits(phone, countryCode);
  return `https://wa.me/${d.length >= 8 && d.length <= 15 ? d : ''}?text=${encodeURIComponent(text)}`;
}

/**
 * Plain-text receipt for sharing. `fmt` formats piastres. method: cash | wallet | credit.
 * Not a tax document: the e-receipt/e-invoice is the legal one (and is a MOCK in this PoC).
 */
export function receiptText({ business = '', number = '', date = '', lines, subtotal, vat, total, method, customer = '', labels, fmt, lang = 'en' }) {
  const L = labels;
  const out = [];
  out.push(business || L.receipt);
  if (business) out.push(L.receipt);
  if (number) out.push(`${L.no} ${number}`);
  if (date) out.push(date);
  out.push('');
  for (const l of lines) out.push(`${lang === 'ar' ? l.nameAr : l.name} x${l.qty}  ${fmt(l.amount)}`);
  out.push('');
  if (vat) { out.push(`${L.before}: ${fmt(subtotal)}`); out.push(`${L.tax}: ${fmt(vat)}`); }
  out.push(`${L.total}: ${fmt(total)}`);
  out.push(`${L.paidBy}: ${L['m_' + method] ?? method}`);
  if (customer) out.push(`${L.customer}: ${customer}`);
  if (method === 'credit') out.push(L.owedNote);
  out.push(L.thanks);
  return out.join('\n');
}
