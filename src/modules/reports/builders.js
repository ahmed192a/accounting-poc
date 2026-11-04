// Report builders. Each returns { rows, summary?, checks?, meta? }; the service adds titles, comparison and formats.
// Money is integer piastres throughout. Row `key` is the identity used to line up a comparison period.
import {
  CASH_CODES, COGS_CODES, VAT_OUT, VAT_IN, chart, accountByCode, sums, zero, cashIds, reversedSet, requireAccount,
  entityFilter, addDays, daysBetween,
} from './queries.js';

const NAMES = {
  sale: ['Quick sales', 'مبيعات سريعة'], payment: ['Customer payments', 'تحصيلات العملاء'], bill: ['Supplier bills', 'فواتير الموردين'],
  invoice: ['Invoices', 'الفواتير'], manual: ['Manual entries', 'قيود يدوية'], opening: ['Opening balances', 'أرصدة افتتاحية'],
  reversal: ['Reversals', 'قيود عكسية'],
};
const srcName = (s) => NAMES[s] ?? [s, s];
// MOCK/UNVERIFIED simplification: which cash-flow section a source type belongs to.
const SECTION = { opening: 'financing', equity: 'financing', loan: 'financing', capital: 'financing', asset: 'investing' };
const SECTION_NAMES = { operating: ['Operating activities', 'الأنشطة التشغيلية'], investing: ['Investing activities', 'الأنشطة الاستثمارية'], financing: ['Financing activities', 'الأنشطة التمويلية'] };

const st = (key, en, ar) => ({ key, en, ar, type: 'text' });
const mo = (key, en, ar, cmp = false) => ({ key, en, ar, type: 'money', cmp });
const nu = (key, en, ar, cmp = false) => ({ key, en, ar, type: 'num', cmp });
const STMT_COLS = [st('code', 'Code', 'الكود'), st('name', 'Name', 'الاسم'), st('name_ar', 'Name (Arabic)', 'الاسم بالعربية'), mo('amount', 'Amount', 'المبلغ', true)];

const header = (key, [en, ar]) => ({ kind: 'header', key: `h:${key}`, code: '', name: en, name_ar: ar, amount: null });
const total = (key, [en, ar], amount, kind = 'total') => ({ kind, key: `t:${key}`, code: '', name: en, name_ar: ar, amount });
const line = (a, amount) => ({ kind: 'line', key: a.code, code: a.code, name: a.name, name_ar: a.name_ar, amount });
const hasActivity = (s) => s.d !== 0 || s.c !== 0;

// ---------------------------------------------------------------------------------------------
export const trialBalance = {
  name: 'trial-balance', kind: 'asof', title: ['Trial balance', 'ميزان المراجعة'],
  columns: [st('code', 'Code', 'الكود'), st('name', 'Name', 'الاسم'), st('name_ar', 'Name (Arabic)', 'الاسم بالعربية'), st('type', 'Type', 'النوع'),
    mo('debit', 'Debit', 'مدين'), mo('credit', 'Credit', 'دائن'), mo('debitBalance', 'Debit balance', 'رصيد مدين', true), mo('creditBalance', 'Credit balance', 'رصيد دائن', true)],
  build(ctx, p) {
    const m = sums(ctx.db, { to: p.to, entityId: p.entityId });
    const rows = [];
    let td = 0, tc = 0, tdb = 0, tcb = 0;
    for (const a of chart(ctx.db)) {
      const s = m.get(a.id) ?? zero;
      if (!p.includeZero && !hasActivity(s)) continue;
      const net = s.d - s.c;
      const r = { kind: 'line', key: a.code, code: a.code, name: a.name, name_ar: a.name_ar, type: a.type, debit: s.d, credit: s.c, debitBalance: net > 0 ? net : 0, creditBalance: net < 0 ? -net : 0 };
      td += s.d; tc += s.c; tdb += r.debitBalance; tcb += r.creditBalance;
      rows.push(r);
    }
    rows.push({ kind: 'total', key: 'total', code: '', name: 'Total', name_ar: 'الإجمالي', type: '', debit: td, credit: tc, debitBalance: tdb, creditBalance: tcb });
    const balanced = td === tc;
    return {
      rows, summary: { totalDebit: td, totalCredit: tc, balanced },
      checks: [{ id: 'balanced', ok: balanced, difference: Math.abs(td - tc), en: 'Total debits equal total credits', ar: 'إجمالي المدين يساوي إجمالي الدائن' }],
    };
  },
};

// ---------------------------------------------------------------------------------------------
function plFigures(db, p) {
  const m = sums(db, { from: p.from, to: p.to, entityId: p.entityId });
  const rev = [], cogs = [], opex = [];
  for (const a of chart(db)) {
    const s = m.get(a.id) ?? zero;
    if (a.type === 'revenue') rev.push([a, s.c - s.d, s]);
    else if (a.type === 'expense') (COGS_CODES.includes(a.code) ? cogs : opex).push([a, s.d - s.c, s]);
  }
  return { rev, cogs, opex };
}
const sumAmt = (l) => l.reduce((s, x) => s + x[1], 0);

export const profitLoss = {
  name: 'profit-loss', kind: 'range', title: ['Profit and loss', 'قائمة الدخل'], columns: STMT_COLS,
  build(ctx, p) {
    const { rev, cogs, opex } = plFigures(ctx.db, p);
    const show = (l) => l.filter(([, , s]) => p.includeZero || hasActivity(s)).map(([a, amt]) => line(a, amt));
    const R = sumAmt(rev), C = sumAmt(cogs), O = sumAmt(opex), gp = R - C, net = gp - O;
    const rows = [
      header('rev', ['Revenue', 'الإيرادات']), ...show(rev), total('rev', ['Total revenue', 'إجمالي الإيرادات'], R, 'subtotal'),
      header('cogs', ['Cost of goods sold (purchases and COGS accounts)', 'تكلفة البضاعة المباعة']), ...show(cogs), total('cogs', ['Total cost of goods sold', 'إجمالي تكلفة البضاعة'], C, 'subtotal'),
      total('gross', ['Gross profit', 'مجمل الربح'], gp),
      header('opex', ['Operating expenses', 'المصروفات التشغيلية']), ...show(opex), total('opex', ['Total operating expenses', 'إجمالي المصروفات'], O, 'subtotal'),
      total('net', ['Net profit', 'صافي الربح'], net),
    ];
    return { rows, summary: { revenue: R, cogs: C, grossProfit: gp, expenses: O, netProfit: net, grossMarginPct: R > 0 ? Math.round((gp / R) * 10000) / 100 : null } };
  },
};

// ---------------------------------------------------------------------------------------------
export const balanceSheet = {
  name: 'balance-sheet', kind: 'asof', title: ['Balance sheet', 'الميزانية العمومية'], columns: STMT_COLS,
  build(ctx, p) {
    const { db } = ctx;
    const m = sums(db, { to: p.to, entityId: p.entityId });
    const yearStart = `${p.to.slice(0, 4)}-01-01`;
    const cur = sums(db, { from: yearStart, to: p.to, entityId: p.entityId });
    const grp = { asset: [], liability: [], equity: [] };
    let plAll = 0, plCur = 0;
    for (const a of chart(db)) {
      const s = m.get(a.id) ?? zero;
      if (a.type === 'revenue') { plAll += s.c - s.d; const c = cur.get(a.id) ?? zero; plCur += c.c - c.d; continue; }
      if (a.type === 'expense') { plAll -= s.d - s.c; const c = cur.get(a.id) ?? zero; plCur -= c.d - c.c; continue; }
      if (!p.includeZero && !hasActivity(s)) continue;
      grp[a.type].push(line(a, a.type === 'asset' ? s.d - s.c : s.c - s.d));
    }
    const sum = (l) => l.reduce((x, r) => x + r.amount, 0);
    const A = sum(grp.asset), L = sum(grp.liability);
    const prior = plAll - plCur;
    const E = sum(grp.equity) + prior + plCur;
    const diff = A - (L + E);
    const rows = [
      header('assets', ['Assets', 'الأصول']), ...grp.asset, total('assets', ['Total assets', 'إجمالي الأصول'], A),
      header('liab', ['Liabilities', 'الالتزامات']), ...grp.liability, total('liab', ['Total liabilities', 'إجمالي الالتزامات'], L),
      header('eq', ['Equity', 'حقوق الملكية']), ...grp.equity,
      { kind: 'line', key: 'prior-earnings', code: '', name: 'Retained earnings (prior periods, not yet closed)', name_ar: 'أرباح مرحلة (فترات سابقة)', amount: prior },
      { kind: 'line', key: 'current-profit', code: '', name: `Current-period profit (${yearStart} to ${p.to})`, name_ar: `ربح الفترة الحالية (${yearStart} إلى ${p.to})`, amount: plCur },
      total('eq', ['Total equity', 'إجمالي حقوق الملكية'], E, 'subtotal'),
      total('le', ['Total liabilities and equity', 'إجمالي الالتزامات وحقوق الملكية'], L + E),
      total('check', ['Check: assets minus (liabilities + equity)', 'مراجعة: الأصول ناقص (الالتزامات + حقوق الملكية)'], diff, 'check'),
    ];
    return {
      rows, summary: { assets: A, liabilities: L, equity: E, currentPeriodProfit: plCur, priorEarnings: prior, difference: diff, balanced: diff === 0 },
      checks: [{ id: 'balance-sheet', ok: diff === 0, difference: Math.abs(diff), en: 'Assets equal liabilities plus equity', ar: 'الأصول تساوي الالتزامات وحقوق الملكية' }],
    };
  },
};

// ---------------------------------------------------------------------------------------------
export const cashFlow = {
  name: 'cash-flow', kind: 'range', advanced: true, title: ['Cash flow statement (direct method)', 'قائمة التدفقات النقدية (الطريقة المباشرة)'],
  columns: [st('name', 'Source', 'المصدر'), st('name_ar', 'Source (Arabic)', 'المصدر بالعربية'), mo('inflow', 'Cash in', 'مقبوضات'), mo('outflow', 'Cash out', 'مدفوعات'), mo('net', 'Net', 'الصافي', true), nu('count', 'Entries', 'القيود')],
  build(ctx, p) {
    const { db } = ctx;
    const ids = cashIds(db);
    const f = entityFilter(p.entityId);
    const per = ids.length ? db.prepare(
      `SELECT x.source_type AS st, COUNT(*) AS n,
              SUM(CASE WHEN x.net > 0 THEN x.net ELSE 0 END) AS inflow, SUM(CASE WHEN x.net < 0 THEN -x.net ELSE 0 END) AS outflow
         FROM (SELECT e.id, e.source_type, SUM(l.debit - l.credit) AS net
                 FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
                WHERE l.account_id IN (${ids.map(() => '?').join(',')}) AND e.entry_date >= ? AND e.entry_date <= ?${f.sql}
                GROUP BY e.id HAVING net <> 0) x
        GROUP BY x.source_type ORDER BY x.source_type`).all(...ids, p.from, p.to, ...f.args) : [];
    const bySection = { operating: [], investing: [], financing: [] };
    for (const r of per) bySection[SECTION[r.st] ?? 'operating'].push(r);
    const rows = [];
    let net = 0;
    for (const sec of ['operating', 'investing', 'financing']) {
      const list = bySection[sec];
      if (!list.length) continue;
      rows.push({ kind: 'header', key: `h:${sec}`, name: SECTION_NAMES[sec][0], name_ar: SECTION_NAMES[sec][1] });
      let i = 0, o = 0;
      for (const r of list) {
        const [en, ar] = srcName(r.st);
        rows.push({ kind: 'line', key: `s:${r.st}`, name: en, name_ar: ar, inflow: r.inflow, outflow: r.outflow, net: r.inflow - r.outflow, count: r.n });
        i += r.inflow; o += r.outflow;
      }
      rows.push({ kind: 'subtotal', key: `t:${sec}`, name: `Net ${SECTION_NAMES[sec][0].toLowerCase()}`, name_ar: `صافي ${SECTION_NAMES[sec][1]}`, inflow: i, outflow: o, net: i - o });
      net += i - o;
    }
    const dayBefore = addDays(p.from, -1);
    const bal = (to) => { const m = sums(db, { to, entityId: p.entityId }); return ids.reduce((s, id) => s + ((m.get(id)?.d ?? 0) - (m.get(id)?.c ?? 0)), 0); };
    const opening = bal(dayBefore), closing = bal(p.to);
    rows.push({ kind: 'total', key: 't:net', name: 'Net change in cash', name_ar: 'صافي التغير في النقدية', net });
    rows.push({ kind: 'line', key: 't:open', name: 'Cash at start', name_ar: 'النقدية أول الفترة', net: opening });
    rows.push({ kind: 'total', key: 't:close', name: 'Cash at end', name_ar: 'النقدية آخر الفترة', net: opening + net });
    const diff = opening + net - closing;
    return {
      rows, summary: { opening, netChange: net, closing, ledgerClosing: closing, difference: diff, cashAccounts: CASH_CODES.filter((c) => accountByCode(db, c)) },
      checks: [{ id: 'cash-ties', ok: diff === 0, difference: Math.abs(diff), en: 'Opening cash plus net change equals ledger cash at the end', ar: 'النقدية الافتتاحية مع صافي التغير تساوي رصيد الدفتر' }],
    };
  },
};

// ---------------------------------------------------------------------------------------------
const bucketAr = (days) => (days <= 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90p');
const bucketAp = (age) => (age <= 30 ? 'b0_30' : age <= 60 ? 'b31_60' : age <= 90 ? 'b61_90' : 'b90p');

function agingRows(groups, keys, otherAmt, detail) {
  const rows = [];
  const tot = Object.fromEntries([...keys, 'other', 'total'].map((k) => [k, 0]));
  for (const g of groups) {
    const r = { kind: 'line', key: g.key, name: g.name, ...Object.fromEntries(keys.map((k) => [k, g.b[k] ?? 0])), other: 0 };
    r.total = keys.reduce((s, k) => s + r[k], 0);
    keys.forEach((k) => { tot[k] += r[k]; });
    tot.total += r.total;
    if (detail) { r.due = g.due; r.days = g.days; }
    rows.push(r);
  }
  if (otherAmt !== 0) {
    rows.push({ kind: 'line', key: 'other', name: 'Other / unapplied ledger balance', name_ar: 'أرصدة أخرى / غير مخصصة', ...Object.fromEntries(keys.map((k) => [k, 0])), other: otherAmt, total: otherAmt });
    tot.other = otherAmt; tot.total += otherAmt;
  }
  rows.push({ kind: 'total', key: 'total', name: 'Total', ...tot });
  return rows;
}

export const arAging = {
  name: 'ar-aging', kind: 'asof', advanced: true, title: ['Accounts receivable aging', 'أعمار الذمم المدينة'],
  columns: [st('name', 'Customer', 'العميل'), mo('current', 'Not yet due', 'غير مستحق'), mo('d1_30', '1-30 days late', '1-30 يوم'), mo('d31_60', '31-60 days', '31-60 يوم'), mo('d61_90', '61-90 days', '61-90 يوم'), mo('d90p', 'Over 90 days', 'أكثر من 90 يوم'), mo('other', 'Other / unapplied', 'أخرى'), mo('total', 'Total', 'الإجمالي', true)],
  build(ctx, p) {
    const { db } = ctx;
    const ar = accountByCode(db, '1200');
    const f = entityFilter(p.entityId);
    const rev = reversedSet(db, p.to);
    const invs = db.prepare(`SELECT i.id, i.number, i.customer, i.total, i.due_date, i.entry_id FROM invoices i JOIN journal_entries e ON e.id = i.entry_id WHERE e.entry_date <= ?${f.sql} ORDER BY i.due_date, i.id`).all(p.to, ...f.args);
    const paid = new Map();
    if (ar) {
      const f2 = entityFilter(p.entityId, 'p');
      for (const r of db.prepare(`SELECT p.id, p.source_id AS inv, SUM(l.credit - l.debit) AS amt FROM journal_entries p JOIN journal_lines l ON l.entry_id = p.id WHERE p.source_type = 'payment' AND p.entry_date <= ? AND l.account_id = ?${f2.sql} GROUP BY p.id`).all(p.to, ar.id, ...f2.args)) {
        if (!rev.has(r.id)) paid.set(r.inv, (paid.get(r.inv) ?? 0) + r.amt);
      }
    }
    const keys = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90p'];
    const groups = new Map();
    let sumOut = 0;
    for (const i of invs) {
      if (rev.has(i.entry_id)) continue;
      const out = i.total - (paid.get(i.id) ?? 0);
      if (out <= 0) continue;
      const days = daysBetween(i.due_date, p.to);
      const key = p.detail ? `inv:${i.id}` : i.customer;
      const g = groups.get(key) ?? { key, name: p.detail ? `${i.number} - ${i.customer}` : i.customer, b: {}, due: i.due_date, days };
      const b = bucketAr(days);
      g.b[b] = (g.b[b] ?? 0) + out;
      groups.set(key, g);
      sumOut += out;
    }
    const m = sums(db, { to: p.to, entityId: p.entityId });
    const ledger = ar ? (m.get(ar.id)?.d ?? 0) - (m.get(ar.id)?.c ?? 0) : 0;
    const list = [...groups.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    const rows = agingRows(list, keys, ledger - sumOut, false);
    return { rows, summary: { ledgerBalance: ledger, invoiceOutstanding: sumOut, unapplied: ledger - sumOut, asOf: p.to },
      checks: [{ id: 'ties-to-ledger', ok: rows.at(-1).total === ledger, difference: Math.abs(rows.at(-1).total - ledger), en: 'Aging total equals ledger account 1200', ar: 'إجمالي الأعمار يساوي رصيد حساب 1200' }] };
  },
};

export const apAging = {
  name: 'ap-aging', kind: 'asof', advanced: true, title: ['Accounts payable aging', 'أعمار الذمم الدائنة'],
  columns: [st('name', 'Supplier', 'المورد'), mo('b0_30', '0-30 days', '0-30 يوم'), mo('b31_60', '31-60 days', '31-60 يوم'), mo('b61_90', '61-90 days', '61-90 يوم'), mo('b90p', 'Over 90 days', 'أكثر من 90 يوم'), mo('other', 'Other / unapplied', 'أخرى'), mo('total', 'Total', 'الإجمالي', true)],
  // MOCK/limit: bills carry no due date or payment link, so age counts from the bill date and ledger
  // debits to 2000 that are not tied to a bill are applied to the oldest bills first (FIFO).
  build(ctx, p) {
    const { db } = ctx;
    const ap = accountByCode(db, '2000');
    const f = entityFilter(p.entityId);
    const rev = reversedSet(db, p.to);
    const bills = db.prepare(`SELECT b.id, b.supplier, b.amount, b.entry_id, e.entry_date AS d FROM bills b JOIN journal_entries e ON e.id = b.entry_id WHERE b.status = 'approved' AND e.entry_date <= ?${f.sql} ORDER BY e.entry_date, b.id`).all(p.to, ...f.args).filter((b) => !rev.has(b.entry_id));
    const S = bills.reduce((s, b) => s + b.amount, 0);
    const m = sums(db, { to: p.to, entityId: p.entityId });
    const B = ap ? (m.get(ap.id)?.c ?? 0) - (m.get(ap.id)?.d ?? 0) : 0;
    let consume = B < S ? Math.min(S, S - B) : 0;
    const keys = ['b0_30', 'b31_60', 'b61_90', 'b90p'];
    const groups = new Map();
    for (const b of bills) {
      const take = Math.min(consume, b.amount);
      consume -= take;
      const out = b.amount - take;
      if (out <= 0) continue;
      const g = groups.get(b.supplier) ?? { key: b.supplier, name: b.supplier, b: {} };
      const k = bucketAp(daysBetween(b.d, p.to));
      g.b[k] = (g.b[k] ?? 0) + out;
      groups.set(b.supplier, g);
    }
    const open = [...groups.values()].reduce((s, g) => s + Object.values(g.b).reduce((x, y) => x + y, 0), 0);
    const rows = agingRows([...groups.values()].sort((a, b) => (a.name < b.name ? -1 : 1)), keys, B - open, false);
    return { rows, summary: { ledgerBalance: B, billOutstanding: open, unapplied: B - open, asOf: p.to },
      checks: [{ id: 'ties-to-ledger', ok: rows.at(-1).total === B, difference: Math.abs(rows.at(-1).total - B), en: 'Aging total equals ledger account 2000', ar: 'إجمالي الأعمار يساوي رصيد حساب 2000' }] };
  },
};

// ---------------------------------------------------------------------------------------------
function salesDocs(db, p) {
  const f = entityFilter(p.entityId);
  const rev = reversedSet(db, p.to);
  const inv = db.prepare(`SELECT i.customer, i.lines, i.subtotal, i.vat, i.total, i.entry_id FROM invoices i JOIN journal_entries e ON e.id = i.entry_id WHERE e.entry_date >= ? AND e.entry_date <= ?${f.sql}`).all(p.from, p.to, ...f.args).filter((r) => !rev.has(r.entry_id));
  const sal = db.prepare(`SELECT s.items, s.subtotal, s.vat, s.total, s.entry_id FROM sales s JOIN journal_entries e ON e.id = s.entry_id WHERE e.entry_date >= ? AND e.entry_date <= ?${f.sql}`).all(p.from, p.to, ...f.args).filter((r) => !rev.has(r.entry_id));
  return { inv, sal };
}
const safeJson = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };

export const salesByItem = {
  name: 'sales-by-item', kind: 'range', title: ['Sales by item', 'المبيعات حسب الصنف'],
  columns: [st('name', 'Item', 'الصنف'), st('sku', 'SKU', 'الكود'), nu('qty', 'Quantity', 'الكمية', true), mo('amount', 'Sales (excl. VAT)', 'المبيعات (بدون ضريبة)', true)],
  build(ctx, p) {
    const { db } = ctx;
    const names = new Map(db.prepare('SELECT sku, name FROM items').all().map((r) => [r.sku, r.name]));
    const { inv, sal } = salesDocs(db, p);
    const acc = new Map();
    const add = (name, sku, qty, amount) => { const a = acc.get(name) ?? { name, sku, qty: 0, amount: 0 }; a.qty += qty; a.amount += amount; acc.set(name, a); };
    for (const i of inv) for (const l of safeJson(i.lines)) add(String(l.description), '', l.qty, l.qty * l.unitPrice);
    for (const s of sal) for (const l of safeJson(s.items)) add(names.get(l.sku) ?? l.sku, l.sku, l.qty, l.qty * l.price);
    const list = [...acc.values()].sort((a, b) => b.amount - a.amount || (a.name < b.name ? -1 : 1)).slice(0, p.limit);
    const rows = list.map((a) => ({ kind: 'line', key: a.name, ...a }));
    rows.push({ kind: 'total', key: 'total', name: 'Total', sku: '', qty: list.reduce((s, a) => s + a.qty, 0), amount: list.reduce((s, a) => s + a.amount, 0) });
    return { rows, summary: { items: list.length, amount: rows.at(-1).amount } };
  },
};

export const salesByCustomer = {
  name: 'sales-by-customer', kind: 'range', title: ['Sales by customer', 'المبيعات حسب العميل'],
  columns: [st('name', 'Customer', 'العميل'), nu('documents', 'Documents', 'المستندات', true), mo('subtotal', 'Sales (excl. VAT)', 'المبيعات (بدون ضريبة)', true), mo('vat', 'VAT', 'الضريبة'), mo('total', 'Total', 'الإجمالي', true)],
  build(ctx, p) {
    const { inv, sal } = salesDocs(ctx.db, p);
    const acc = new Map();
    const add = (name, r) => { const a = acc.get(name) ?? { name, documents: 0, subtotal: 0, vat: 0, total: 0 }; a.documents++; a.subtotal += r.subtotal; a.vat += r.vat; a.total += r.total; acc.set(name, a); };
    for (const i of inv) add(i.customer, i);
    for (const s of sal) add('Walk-in (quick sales) / عميل نقدي (بيع سريع)', s);
    const list = [...acc.values()].sort((a, b) => b.total - a.total || (a.name < b.name ? -1 : 1)).slice(0, p.limit);
    const rows = list.map((a) => ({ kind: 'line', key: a.name, ...a }));
    const t = (k) => list.reduce((s, a) => s + a[k], 0);
    rows.push({ kind: 'total', key: 'total', name: 'Total', documents: t('documents'), subtotal: t('subtotal'), vat: t('vat'), total: t('total') });
    return { rows, summary: { customers: list.length, total: t('total') } };
  },
};

export const salesByDay = {
  name: 'sales-by-day', kind: 'range', prevOnly: false, title: ['Sales by day', 'المبيعات اليومية'],
  columns: [st('date', 'Date', 'التاريخ'), nu('entries', 'Entries', 'القيود'), mo('amount', 'Net sales', 'صافي المبيعات', true)],
  build(ctx, p) {
    const { db } = ctx;
    const ids = chart(db).filter((a) => a.type === 'revenue').map((a) => a.id);
    const f = entityFilter(p.entityId);
    const data = ids.length ? db.prepare(
      `SELECT e.entry_date AS date, COUNT(DISTINCT e.id) AS entries, SUM(l.credit - l.debit) AS amount
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.account_id IN (${ids.map(() => '?').join(',')}) AND e.entry_date >= ? AND e.entry_date <= ?${f.sql}
        GROUP BY e.entry_date ORDER BY e.entry_date`).all(...ids, p.from, p.to, ...f.args) : [];
    const rows = data.map((r) => ({ kind: 'line', key: daysBetween(p.from, r.date), ...r }));
    rows.push({ kind: 'total', key: 'total', date: '', entries: data.reduce((s, r) => s + r.entries, 0), amount: data.reduce((s, r) => s + r.amount, 0) });
    return { rows, summary: { days: data.length, amount: rows.at(-1).amount } };
  },
};

// ---------------------------------------------------------------------------------------------
function periodKeys(from, to, period) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  if (period === 'year') { for (; y <= ty; y++) out.push(String(y)); return out; }
  if (period === 'quarter') {
    let q = Math.floor((m - 1) / 3);
    const tq = Math.floor((tm - 1) / 3);
    for (;;) { out.push(`${y}-Q${q + 1}`); if (y === ty && q === tq) break; q++; if (q > 3) { q = 0; y++; } }
    return out;
  }
  for (;;) { out.push(`${y}-${String(m).padStart(2, '0')}`); if (y === ty && m === tm) break; m++; if (m > 12) { m = 1; y++; } }
  return out;
}
const PERIOD_SQL = { month: 'substr(e.entry_date,1,7)', year: 'substr(e.entry_date,1,4)', quarter: "substr(e.entry_date,1,4) || '-Q' || ((CAST(substr(e.entry_date,6,2) AS INTEGER) + 2) / 3)" };

export const vatSummary = {
  name: 'vat-summary', kind: 'range', prevOnly: false, title: ['VAT summary', 'ملخص ضريبة القيمة المضافة'],
  columns: [st('period', 'Period', 'الفترة'), mo('taxableSales', 'Taxable sales', 'المبيعات الخاضعة', true), mo('outputVat', 'Output VAT (2100)', 'ضريبة المخرجات', true), mo('inputVat', 'Input VAT (1400)', 'ضريبة المدخلات', true), mo('netVat', 'Net VAT payable', 'صافي الضريبة المستحقة', true)],
  // UNVERIFIED: not a tax return. Output VAT = ledger 2100, input VAT = ledger 1400 if that account exists.
  build(ctx, p) {
    const { db } = ctx;
    const out = accountByCode(db, VAT_OUT), inn = accountByCode(db, VAT_IN);
    const rev = chart(db).filter((a) => a.type === 'revenue').map((a) => a.id);
    const ids = [out?.id, inn?.id, ...rev].filter((x) => x != null);
    const f = entityFilter(p.entityId);
    const data = ids.length ? db.prepare(
      `SELECT ${PERIOD_SQL[p.period]} AS period, l.account_id AS acc, SUM(l.debit) AS d, SUM(l.credit) AS c
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.account_id IN (${ids.map(() => '?').join(',')}) AND e.entry_date >= ? AND e.entry_date <= ?${f.sql}
        GROUP BY period, l.account_id`).all(...ids, p.from, p.to, ...f.args) : [];
    const by = new Map(periodKeys(p.from, p.to, p.period).map((k) => [k, { period: k, taxableSales: 0, outputVat: 0, inputVat: 0 }]));
    for (const r of data) {
      const row = by.get(r.period);
      if (!row) continue;
      if (r.acc === out?.id) row.outputVat += r.c - r.d;
      else if (r.acc === inn?.id) row.inputVat += r.d - r.c;
      else row.taxableSales += r.c - r.d;
    }
    const rows = [...by.values()].map((r, i) => ({ kind: 'line', key: i, ...r, netVat: r.outputVat - r.inputVat }));
    const t = (k) => rows.reduce((s, r) => s + r[k], 0);
    rows.push({ kind: 'total', key: 'total', period: 'Total', taxableSales: t('taxableSales'), outputVat: t('outputVat'), inputVat: t('inputVat'), netVat: t('netVat') });
    return { rows, summary: { outputVat: t('outputVat'), inputVat: t('inputVat'), netVat: t('netVat'), inputVatAccountPresent: !!inn }, meta: { disclaimer: 'UNVERIFIED: management summary of ledger VAT accounts, not a VAT return.' } };
  },
};

// ---------------------------------------------------------------------------------------------
export const generalLedger = {
  name: 'general-ledger', kind: 'range', advanced: true, noCompare: true, title: ['General ledger', 'دفتر الأستاذ العام'],
  columns: [st('date', 'Date', 'التاريخ'), nu('entryId', 'Entry', 'القيد'), st('memo', 'Memo', 'البيان'), st('source', 'Source', 'المصدر'), mo('debit', 'Debit', 'مدين'), mo('credit', 'Credit', 'دائن'), mo('balance', 'Balance (debit +)', 'الرصيد (مدين +)')],
  build(ctx, p) {
    const { db } = ctx;
    const f = entityFilter(p.entityId);
    if (!p.account) { // no account: one summary row per account (opening, movements, closing)
      const before = sums(db, { to: addDays(p.from, -1), entityId: p.entityId });
      const within = sums(db, { from: p.from, to: p.to, entityId: p.entityId });
      const rows = [];
      for (const a of chart(db)) {
        const b = before.get(a.id) ?? zero, w = within.get(a.id) ?? zero;
        if (!hasActivity(b) && !hasActivity(w)) continue;
        const open = b.d - b.c;
        rows.push({ kind: 'line', key: a.code, date: a.code, entryId: null, memo: `${a.name} / ${a.name_ar}`, source: 'account', debit: w.d, credit: w.c, balance: open + w.d - w.c, opening: open, account: a.code });
      }
      return { rows, summary: { mode: 'accounts', accounts: rows.length }, meta: { note: 'Pass account=<code> for the entry-level ledger with a running balance.' } };
    }
    const a = requireAccount(db, p.account);
    const bs = sums(db, { to: addDays(p.from, -1), entityId: p.entityId }).get(a.id) ?? zero;
    const opening = bs.d - bs.c;
    const agg = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(l.debit),0) AS d, COALESCE(SUM(l.credit),0) AS c FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = ? AND e.entry_date >= ? AND e.entry_date <= ?${f.sql}`).get(a.id, p.from, p.to, ...f.args);
    const data = db.prepare(
      `SELECT * FROM (SELECT e.entry_date AS date, e.id AS entryId, l.id AS lineId, e.memo, e.source_type AS source, l.debit, l.credit,
                             SUM(l.debit - l.credit) OVER (ORDER BY e.entry_date, e.id, l.id) AS run
                        FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
                       WHERE l.account_id = ? AND e.entry_date >= ? AND e.entry_date <= ?${f.sql})
        ORDER BY date, entryId, lineId LIMIT ? OFFSET ?`).all(a.id, p.from, p.to, ...f.args, p.limit, p.offset);
    const rows = [];
    if (p.offset === 0) rows.push({ kind: 'header', key: 'open', date: p.from, entryId: null, memo: 'Opening balance', source: '', debit: null, credit: null, balance: opening });
    for (const r of data) rows.push({ kind: 'line', key: `l${r.lineId}`, date: r.date, entryId: r.entryId, memo: r.memo, source: r.source, debit: r.debit, credit: r.credit, balance: opening + r.run });
    const closing = opening + agg.d - agg.c;
    const hasMore = p.offset + data.length < agg.n;
    if (!hasMore) rows.push({ kind: 'total', key: 'close', date: p.to, entryId: null, memo: 'Closing balance', source: '', debit: agg.d, credit: agg.c, balance: closing });
    return {
      rows, summary: { mode: 'entries', account: { code: a.code, name: a.name, name_ar: a.name_ar, type: a.type }, opening, debit: agg.d, credit: agg.c, closing, lines: agg.n, offset: p.offset, limit: p.limit, hasMore },
      checks: [{ id: 'running', ok: opening + agg.d - agg.c === closing, difference: 0, en: 'Opening plus movements equals closing', ar: 'الافتتاحي مع الحركة يساوي الختامي' }],
    };
  },
};

export const accountTransactions = {
  name: 'account-transactions', kind: 'range', advanced: true, noCompare: true, title: ['Account transactions', 'حركة الحسابات'],
  columns: [st('date', 'Date', 'التاريخ'), nu('entryId', 'Entry', 'القيد'), st('account', 'Account', 'الحساب'), st('memo', 'Memo', 'البيان'), st('source', 'Source', 'المصدر'), st('counter', 'Counter accounts', 'الحسابات المقابلة'), mo('debit', 'Debit', 'مدين'), mo('credit', 'Credit', 'دائن')],
  build(ctx, p) {
    const { db } = ctx;
    const f = entityFilter(p.entityId);
    const acc = p.account ? requireAccount(db, p.account) : null;
    const where = [`e.entry_date >= ? AND e.entry_date <= ?${f.sql}`];
    const args = [p.from, p.to, ...f.args];
    if (acc) { where.push('l.account_id = ?'); args.push(acc.id); }
    if (p.source) { where.push('e.source_type = ?'); args.push(p.source); }
    if (p.q) { where.push("e.memo LIKE ? ESCAPE '\\'"); args.push(`%${p.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
    if (p.min != null) { where.push('(l.debit + l.credit) >= ?'); args.push(p.min); }
    if (p.max != null) { where.push('(l.debit + l.credit) <= ?'); args.push(p.max); }
    const W = where.join(' AND ');
    const agg = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(l.debit),0) AS d, COALESCE(SUM(l.credit),0) AS c FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE ${W}`).get(...args);
    const page = db.prepare(`SELECT e.entry_date AS date, e.id AS entryId, l.id AS lineId, l.account_id, e.memo, e.source_type AS source, l.debit, l.credit
                               FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE ${W} ORDER BY e.entry_date, e.id, l.id LIMIT ? OFFSET ?`).all(...args, p.limit, p.offset);
    const codes = new Map(chart(db).map((a) => [a.id, a.code]));
    const others = db.prepare('SELECT account_id FROM journal_lines WHERE entry_id = ? AND id <> ?');
    const rows = page.map((r) => ({
      kind: 'line', key: `l${r.lineId}`, date: r.date, entryId: r.entryId, account: codes.get(r.account_id), memo: r.memo, source: r.source,
      counter: [...new Set(others.all(r.entryId, r.lineId).map((o) => codes.get(o.account_id)))].join(' '), debit: r.debit, credit: r.credit,
    }));
    const hasMore = p.offset + page.length < agg.n;
    if (!hasMore) rows.push({ kind: 'total', key: 'total', date: '', entryId: null, account: acc?.code ?? '', memo: 'Total', source: '', counter: '', debit: agg.d, credit: agg.c });
    return { rows, summary: { lines: agg.n, debit: agg.d, credit: agg.c, offset: p.offset, limit: p.limit, hasMore } };
  },
};

export const BUILDERS = [trialBalance, profitLoss, balanceSheet, cashFlow, arAging, apAging, salesByItem, salesByCustomer, salesByDay, vatSummary, generalLedger, accountTransactions];
