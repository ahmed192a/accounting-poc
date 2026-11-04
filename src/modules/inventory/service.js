import { AppError, posInt } from '../../errors.js';
import { postEntry, tx, audit, isoDate, accountBalance } from '../../ledger.js';
import { requirePerm, limitFor } from '../../permissions.js';
import { setting } from '../../db.js';

// Inventory service. Costing is WEIGHTED AVERAGE per item across all warehouses (a transfer moves goods at
// the current average and changes no ledger balance). Everything is derived from the append-only
// inventory_movements table: quantity, value, average cost. Money is integer piastres, quantities are whole
// numbers of the item's unit (count a kilogram item in grams if you need fractions).
// Ledger: receipt Dr 1300 / Cr 2000; sale COGS Dr 5300 / Cr 1300; shrinkage Dr 5300 / Cr 1300; gain Dr 1300 / Cr 5300.

export const SRC = {
  receipt: 'inventory_receipt', cogs: 'inventory_cogs', adjust: 'inventory_adjustment',
  count: 'inventory_count', return: 'inventory_return',
};
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9\-_.]{0,63}$/;
const BARCODE_RE = /^[A-Za-z0-9\-._]{3,64}$/;
const KINDS = ['purchase', 'sale', 'adjustment', 'transfer', 'return', 'count'];

const bad = (msg, code = 'BAD_INPUT') => new AppError(400, code, msg);
const text = (v, field, max = 200) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw bad(`${field} is required`);
  if (s.length > max) throw bad(`${field} is too long`);
  return s;
};
const intNonZero = (n, field) => {
  if (!Number.isInteger(n) || n === 0 || !Number.isSafeInteger(n)) throw bad(`${field} must be a non-zero whole number`);
  return n;
};
const safeMoney = (n, field) => { if (!Number.isSafeInteger(n)) throw bad(`${field} is too large`); return n; };

/** round(a * b / c) with BigInt, half away from zero, so large piastre values never lose precision. */
export function mulDiv(a, b, c) {
  const n = BigInt(a) * BigInt(b), d = BigInt(c);
  const neg = (n < 0n) !== (d < 0n);
  const an = n < 0n ? -n : n, ad = d < 0n ? -d : d;
  const q = (2n * an + ad) / (2n * ad);
  return Number(neg ? -q : q);
}

/** Accounts 1300 and 5300 (reserved codes). Idempotent; also called by the seed and before every posting. */
export function ensureAccounts(db) {
  const ins = db.prepare('INSERT OR IGNORE INTO accounts (code, name, name_ar, type) VALUES (?,?,?,?)');
  ins.run('1300', 'Inventory', 'المخزون', 'asset');
  ins.run('5300', 'Cost of goods sold', 'تكلفة البضاعة المباعة', 'expense');
}
const post = (ctx, e) => { ensureAccounts(ctx.db); return postEntry(ctx, e); };

// ---------- lookups ----------
export const allowNegative = (db) => (setting(db, 'inventory.allow_negative') ?? '1') !== '0';

function itemRow(db, sku) {
  const it = db.prepare('SELECT sku, name, name_ar, price FROM items WHERE sku = ?').get(sku);
  if (!it) throw bad(`Unknown item ${sku}`, 'UNKNOWN_ITEM');
  return it;
}
const settingsRow = (db, sku) => db.prepare('SELECT * FROM inventory_item_settings WHERE sku = ?').get(sku);

function skuInput(db, v) {
  if (typeof v !== 'string' || !SKU_RE.test(v)) throw bad('sku is required');
  itemRow(db, v);
  return v;
}

function warehouse(db, id) {
  const w = id == null
    ? db.prepare('SELECT * FROM inventory_warehouses WHERE is_default = 1').get()
    : db.prepare('SELECT * FROM inventory_warehouses WHERE id = ?').get(id);
  if (!w) throw new AppError(404, 'NO_WAREHOUSE', 'Warehouse not found');
  if (!w.active) throw new AppError(409, 'WAREHOUSE_INACTIVE', `Warehouse ${w.code} is inactive`);
  return w;
}

/** Make sure the item is a stock item (receiving something auto-enables tracking; other operations need it). */
function requireTracked(ctx, sku, { enable = false, userId = null } = {}) {
  const { db } = ctx;
  const row = settingsRow(db, sku);
  if (row?.track) return row;
  if (!enable) throw new AppError(409, 'NOT_TRACKED', `Item ${sku} is not a stock item; receive stock or enable tracking first`);
  if (row) db.prepare('UPDATE inventory_item_settings SET track = 1, updated_at = ? WHERE sku = ?').run(ctx.now(), sku);
  else db.prepare('INSERT INTO inventory_item_settings (sku, updated_at) VALUES (?, ?)').run(sku, ctx.now());
  audit(ctx, { userId, action: 'inventory.tracking_enabled', type: 'inventory_item', id: null, newValue: { sku } });
  return settingsRow(db, sku);
}

/** Item-wide quantity and value from the movements, plus the last known positive unit cost. */
export function costState(db, sku) {
  const r = db.prepare('SELECT COALESCE(SUM(qty),0) AS q, COALESCE(SUM(value),0) AS v FROM inventory_movements WHERE sku = ?').get(sku);
  const last = db.prepare("SELECT unit_cost FROM inventory_movements WHERE sku = ? AND qty > 0 AND kind <> 'transfer' AND unit_cost > 0 ORDER BY id DESC LIMIT 1").get(sku);
  return { q: r.q, v: r.v, last: last?.unit_cost ?? null };
}
const whQty = (db, sku, wh) => db.prepare('SELECT COALESCE(SUM(qty),0) AS q FROM inventory_movements WHERE sku = ? AND warehouse_id = ?').get(sku, wh).q;

/** Plan the cost of taking `q` units out. Never writes. */
export function planIssue(db, sku, wh, q) {
  const st = costState(db, sku);
  const flags = [];
  const covered = Math.max(0, Math.min(st.q, q));
  let cost = 0;
  if (covered > 0) cost += covered === st.q ? st.v : mulDiv(st.v, covered, st.q);
  const short = q - covered;
  if (short > 0) {
    const unit = st.last ?? (st.q > 0 && st.v > 0 ? Math.round(st.v / st.q) : null);
    if (unit == null) flags.push('cost_unknown'); else cost += unit * short;
  }
  if (whQty(db, sku, wh) - q < 0) flags.push('negative');
  return { qty: -q, value: -cost, unitCost: Math.round(cost / q), flags };
}

/** Plan the cost of bringing `q` units in. A given unit cost wins; otherwise average, else last cost, else unknown. */
function planReceive(db, sku, q, unitCost) {
  const flags = [];
  let cost;
  if (unitCost != null) cost = safeMoney(q * unitCost, 'value');
  else {
    const st = costState(db, sku);
    if (st.q > 0 && st.v > 0) cost = mulDiv(st.v, q, st.q);
    else if (st.last != null) cost = st.last * q;
    else { cost = 0; flags.push('cost_unknown'); }
  }
  return { qty: q, value: cost, unitCost: unitCost ?? Math.round(cost / q), flags };
}

function insertMovement(ctx, m) {
  const res = ctx.db.prepare(`INSERT INTO inventory_movements
    (sku, warehouse_id, kind, qty, unit_cost, value, flags, ref_type, ref_id, entry_id, supplier, reason, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    m.sku, m.warehouseId, m.kind, m.qty, m.unitCost, m.value, (m.flags ?? []).join(','), m.refType ?? null, m.refId ?? null,
    m.entryId ?? null, m.supplier ?? null, m.reason ?? null, m.userId ?? null, ctx.now());
  return Number(res.lastInsertRowid);
}

function checkLimit(user, perm, value) {
  if (value > limitFor(user, perm)) {
    throw new AppError(403, 'OVER_LIMIT', `Value is above your ${perm} limit of ${limitFor(user, perm) / 100} EGP`);
  }
}

function checkStockAvailable(db, sku, wh, q) {
  if (allowNegative(db)) return;
  const have = whQty(db, sku, wh);
  if (have < q) throw new AppError(409, 'INSUFFICIENT_STOCK', `Only ${have} of ${sku} in stock, ${q} needed (negative stock is switched off)`);
}

// ---------- receiving ----------
export function receiveStock(ctx, user, input) {
  requirePerm(user, 'inventory.receive');
  const { db } = ctx;
  const supplier = text(input.supplier, 'supplier');
  const raw = Array.isArray(input.lines) ? input.lines : [{ sku: input.sku, qty: input.qty, unitCost: input.unitCost }];
  if (raw.length === 0 || raw.length > 200) throw bad('Add between 1 and 200 lines');
  const wh = warehouse(db, input.warehouseId);
  const lines = raw.map((l) => ({ sku: skuInput(db, l?.sku), qty: posInt(l?.qty, 'qty'), unitCost: posInt(l?.unitCost, 'unitCost') }));
  lines.forEach((l) => { l.value = safeMoney(l.qty * l.unitCost, 'value'); });
  const total = safeMoney(lines.reduce((s, l) => s + l.value, 0), 'total');
  checkLimit(user, 'inventory.receive', total);
  const reference = input.reference ? text(input.reference, 'reference', 100) : null;

  return tx(db, () => {
    for (const l of lines) requireTracked(ctx, l.sku, { enable: true, userId: user.id });
    const entry = post(ctx, {
      userId: user.id, date: input.date, sourceType: SRC.receipt,
      memo: `Stock received from ${supplier}${reference ? ` (${reference})` : ''}`,
      lines: [{ account: '1300', debit: total }, { account: '2000', credit: total }],
    });
    const movements = lines.map((l) => insertMovement(ctx, {
      sku: l.sku, warehouseId: wh.id, kind: 'purchase', qty: l.qty, unitCost: l.unitCost, value: l.value,
      refType: 'receipt', refId: entry.id, entryId: entry.id, supplier, reason: reference, userId: user.id,
    }));
    audit(ctx, { userId: user.id, action: 'inventory.received', type: 'inventory_receipt', id: entry.id, newValue: { supplier, warehouse: wh.code, lines, total } });
    return { entryId: entry.id, total, movements, lines };
  });
}

// ---------- adjustments, returns ----------
function postValueEntry(ctx, user, { value, memo, source, reason, date }) {
  // value > 0: stock gained (Dr 1300 / Cr 5300). value < 0: stock lost (Dr 5300 / Cr 1300). 0: nothing to post.
  if (value === 0) return null;
  const abs = Math.abs(value);
  const lines = value > 0
    ? [{ account: '1300', debit: abs }, { account: '5300', credit: abs }]
    : [{ account: '5300', debit: abs }, { account: '1300', credit: abs }];
  return post(ctx, { userId: user.id, date, memo, sourceType: source, lines, reason });
}

export function adjustStock(ctx, user, input) {
  requirePerm(user, 'inventory.adjust');
  const { db } = ctx;
  const sku = skuInput(db, input.sku);
  const qty = intNonZero(input.qty, 'qty');
  const reason = text(input.reason, 'reason');
  const wh = warehouse(db, input.warehouseId);
  const unitCost = input.unitCost == null ? null : posInt(input.unitCost, 'unitCost');
  return tx(db, () => {
    requireTracked(ctx, sku);
    let plan;
    if (qty < 0) { checkStockAvailable(db, sku, wh.id, -qty); plan = planIssue(db, sku, wh.id, -qty); }
    else plan = planReceive(db, sku, qty, unitCost);
    checkLimit(user, 'inventory.adjust', Math.abs(plan.value));
    const entry = postValueEntry(ctx, user, { value: plan.value, memo: `Stock adjustment ${sku}: ${reason}`, source: SRC.adjust, reason, date: input.date });
    const id = insertMovement(ctx, { ...plan, sku, warehouseId: wh.id, kind: 'adjustment', refType: 'adjustment', entryId: entry?.id, reason, userId: user.id });
    audit(ctx, { userId: user.id, action: 'inventory.adjusted', type: 'inventory_movement', id, newValue: { sku, warehouse: wh.code, qty, value: plan.value, flags: plan.flags }, reason });
    return { id, entryId: entry?.id ?? null, qty: plan.qty, value: plan.value, flags: plan.flags };
  });
}

/** Customer return (direction "in", goods come back at average cost) or return to supplier ("out"). */
export function returnStock(ctx, user, input) {
  requirePerm(user, 'inventory.adjust');
  const { db } = ctx;
  const sku = skuInput(db, input.sku);
  const qty = posInt(input.qty, 'qty');
  const direction = input.direction ?? 'in';
  if (!['in', 'out'].includes(direction)) throw bad('direction must be in or out');
  const reason = text(input.reason, 'reason');
  const wh = warehouse(db, input.warehouseId);
  return tx(db, () => {
    requireTracked(ctx, sku);
    let plan, entry;
    if (direction === 'in') {
      plan = planReceive(db, sku, qty, input.unitCost == null ? null : posInt(input.unitCost, 'unitCost'));
      checkLimit(user, 'inventory.adjust', plan.value);
      entry = postValueEntry(ctx, user, { value: plan.value, memo: `Customer return ${sku}: ${reason}`, source: SRC.return, reason, date: input.date });
    } else {
      checkStockAvailable(db, sku, wh.id, qty);
      plan = planIssue(db, sku, wh.id, qty);
      checkLimit(user, 'inventory.adjust', -plan.value);
      const abs = -plan.value;
      entry = abs > 0 ? post(ctx, {
        userId: user.id, date: input.date, sourceType: SRC.return, memo: `Return to supplier ${sku}: ${reason}`,
        lines: [{ account: '2000', debit: abs }, { account: '1300', credit: abs }],
      }) : null;
    }
    const id = insertMovement(ctx, { ...plan, sku, warehouseId: wh.id, kind: 'return', refType: 'return', entryId: entry?.id, reason, supplier: direction === 'out' ? (input.supplier ?? null) : null, userId: user.id });
    audit(ctx, { userId: user.id, action: 'inventory.returned', type: 'inventory_movement', id, newValue: { sku, direction, qty, value: plan.value }, reason });
    return { id, entryId: entry?.id ?? null, qty: plan.qty, value: plan.value, flags: plan.flags };
  });
}

// ---------- transfers ----------
export function transferStock(ctx, user, input) {
  requirePerm(user, 'inventory.adjust');
  const { db } = ctx;
  const sku = skuInput(db, input.sku);
  const qty = posInt(input.qty, 'qty');
  const from = warehouse(db, input.fromWarehouseId), to = warehouse(db, input.toWarehouseId);
  if (from.id === to.id) throw bad('Choose two different warehouses', 'SAME_WAREHOUSE');
  const note = input.note ? text(input.note, 'note') : null;
  return tx(db, () => {
    requireTracked(ctx, sku);
    checkStockAvailable(db, sku, from.id, qty);
    const out = planIssue(db, sku, from.id, qty); // goods move at average; item-wide value is unchanged
    const ref = db.prepare("SELECT COALESCE(MAX(ref_id),0) + 1 AS n FROM inventory_movements WHERE ref_type = 'transfer'").get().n;
    const base = { sku, kind: 'transfer', refType: 'transfer', refId: ref, reason: note, userId: user.id };
    const outId = insertMovement(ctx, { ...base, warehouseId: from.id, qty: -qty, value: out.value, unitCost: out.unitCost, flags: out.flags });
    const inId = insertMovement(ctx, { ...base, warehouseId: to.id, qty, value: -out.value, unitCost: out.unitCost, flags: out.flags.filter((f) => f !== 'negative') });
    audit(ctx, { userId: user.id, action: 'inventory.transferred', type: 'inventory_transfer', id: ref, newValue: { sku, qty, from: from.code, to: to.code } });
    return { transferId: ref, movements: [outId, inId], flags: out.flags };
  });
}

// ---------- stocktake ----------
const countRow = (db, id) => {
  const c = db.prepare('SELECT * FROM inventory_counts WHERE id = ?').get(id);
  if (!c) throw new AppError(404, 'NOT_FOUND', 'Count sheet not found');
  return c;
};

export function createCount(ctx, user, input = {}) {
  requirePerm(user, 'inventory.adjust');
  const { db } = ctx;
  const wh = warehouse(db, input.warehouseId);
  const note = input.note ? text(input.note, 'note') : null;
  return tx(db, () => {
    const skus = db.prepare('SELECT sku FROM inventory_item_settings WHERE track = 1 ORDER BY sku').all().map((r) => r.sku);
    if (!skus.length) throw new AppError(409, 'NO_STOCK_ITEMS', 'No stock items to count');
    const res = db.prepare('INSERT INTO inventory_counts (warehouse_id, note, created_by, created_at) VALUES (?,?,?,?)').run(wh.id, note, user.id, ctx.now());
    const id = Number(res.lastInsertRowid);
    const ins = db.prepare('INSERT INTO inventory_count_lines (count_id, sku, expected_qty) VALUES (?,?,?)');
    for (const sku of skus) ins.run(id, sku, whQty(db, sku, wh.id));
    audit(ctx, { userId: user.id, action: 'inventory.count_created', type: 'inventory_count', id, newValue: { warehouse: wh.code, items: skus.length } });
    return getCount(ctx, user, id);
  });
}

export function getCount(ctx, user, id) {
  requirePerm(user, 'inventory.view');
  const { db } = ctx;
  const c = countRow(db, id);
  const lines = db.prepare(`SELECT l.sku, i.name, i.name_ar, l.expected_qty, l.counted_qty, l.variance_qty
    FROM inventory_count_lines l JOIN items i ON i.sku = l.sku WHERE l.count_id = ? ORDER BY l.sku`).all(id);
  return { ...c, lines };
}

export function listCounts(ctx, user) {
  requirePerm(user, 'inventory.view');
  return ctx.db.prepare(`SELECT c.id, c.status, c.note, c.created_at, c.posted_at, w.code AS warehouse,
    (SELECT COUNT(*) FROM inventory_count_lines WHERE count_id = c.id AND counted_qty IS NOT NULL) AS counted,
    (SELECT COUNT(*) FROM inventory_count_lines WHERE count_id = c.id) AS total
    FROM inventory_counts c JOIN inventory_warehouses w ON w.id = c.warehouse_id ORDER BY c.id DESC LIMIT 50`).all();
}

export function saveCountLines(ctx, user, id, input) {
  requirePerm(user, 'inventory.adjust');
  const { db } = ctx;
  const c = countRow(db, id);
  if (c.status !== 'open') throw new AppError(409, 'COUNT_CLOSED', `Count sheet is ${c.status}`);
  if (!Array.isArray(input.lines) || !input.lines.length) throw bad('lines are required');
  return tx(db, () => {
    const upd = db.prepare('UPDATE inventory_count_lines SET counted_qty = ? WHERE count_id = ? AND sku = ?');
    for (const l of input.lines) {
      if (l.countedQty !== null && (!Number.isInteger(l.countedQty) || l.countedQty < 0)) throw bad('countedQty must be a whole number, zero or more (or null to clear)');
      if (upd.run(l.countedQty, id, l.sku).changes === 0) throw bad(`Item ${l.sku} is not on this count sheet`, 'NOT_ON_SHEET');
    }
    audit(ctx, { userId: user.id, action: 'inventory.count_saved', type: 'inventory_count', id, newValue: { lines: input.lines.length } });
    return getCount(ctx, user, id);
  });
}

export function postCount(ctx, user, id, input = {}) {
  requirePerm(user, 'inventory.adjust');
  const { db } = ctx;
  const c = countRow(db, id);
  if (c.status !== 'open') throw new AppError(409, 'COUNT_CLOSED', `Count sheet is ${c.status}`);
  return tx(db, () => {
    const lines = db.prepare('SELECT sku, counted_qty FROM inventory_count_lines WHERE count_id = ? AND counted_qty IS NOT NULL ORDER BY sku').all(id);
    if (!lines.length) throw new AppError(409, 'NOTHING_COUNTED', 'Enter at least one counted quantity');
    const plans = [];
    let gain = 0, loss = 0;
    for (const l of lines) {
      const diff = l.counted_qty - whQty(db, l.sku, c.warehouse_id);
      db.prepare('UPDATE inventory_count_lines SET variance_qty = ? WHERE count_id = ? AND sku = ?').run(diff, id, l.sku);
      if (diff === 0) continue;
      const plan = diff < 0 ? planIssue(db, l.sku, c.warehouse_id, -diff) : planReceive(db, l.sku, diff, null);
      plans.push({ sku: l.sku, plan });
      if (plan.value > 0) gain += plan.value; else loss -= plan.value;
    }
    checkLimit(user, 'inventory.adjust', gain + loss);
    let entry = null;
    if (gain || loss) {
      const lns = [];
      if (gain) lns.push({ account: '1300', debit: gain }, { account: '5300', credit: gain });
      if (loss) lns.push({ account: '5300', debit: loss }, { account: '1300', credit: loss });
      entry = post(ctx, { userId: user.id, date: input.date, sourceType: SRC.count, sourceId: id, memo: `Stocktake #${id} variances`, lines: lns });
    }
    for (const { sku, plan } of plans) {
      insertMovement(ctx, { ...plan, sku, warehouseId: c.warehouse_id, kind: 'count', refType: 'count', refId: id, entryId: entry?.id, reason: `Stocktake #${id}`, userId: user.id });
    }
    db.prepare("UPDATE inventory_counts SET status = 'posted', entry_id = ?, posted_by = ?, posted_at = ? WHERE id = ?").run(entry?.id ?? null, user.id, ctx.now(), id);
    audit(ctx, { userId: user.id, action: 'inventory.count_posted', type: 'inventory_count', id, newValue: { adjusted: plans.length, gain, loss, entryId: entry?.id ?? null } });
    return { id, adjusted: plans.length, gain, loss, entryId: entry?.id ?? null };
  });
}

export function cancelCount(ctx, user, id, input = {}) {
  requirePerm(user, 'inventory.adjust');
  const c = countRow(ctx.db, id);
  if (c.status !== 'open') throw new AppError(409, 'COUNT_CLOSED', `Count sheet is ${c.status}`);
  const reason = text(input.reason, 'reason');
  tx(ctx.db, () => {
    ctx.db.prepare("UPDATE inventory_counts SET status = 'cancelled' WHERE id = ?").run(id);
    audit(ctx, { userId: user.id, action: 'inventory.count_cancelled', type: 'inventory_count', id, reason });
  });
  return { id, status: 'cancelled' };
}

// ---------- hooks: COGS on sale and on invoices with sku lines ----------
function consume(ctx, { rows, refType, refId, userId, memo, date }) {
  const { db } = ctx;
  if (db.prepare("SELECT 1 FROM inventory_movements WHERE kind = 'sale' AND ref_type = ? AND ref_id = ? LIMIT 1").get(refType, refId)) return null; // idempotent
  const merged = new Map();
  for (const r of rows) {
    if (typeof r.sku !== 'string' || !Number.isInteger(r.qty) || r.qty <= 0) continue;
    merged.set(r.sku, (merged.get(r.sku) ?? 0) + r.qty);
  }
  const work = [];
  for (const [sku, qty] of merged) {
    if (!settingsRow(db, sku)?.track) continue; // not a stock item: nothing to relieve
    const wh = warehouse(db, null);
    checkStockAvailable(db, sku, wh.id, qty);
    work.push({ sku, wh, plan: planIssue(db, sku, wh.id, qty) });
  }
  if (!work.length) return null;
  const cost = work.reduce((s, w) => s - w.plan.value, 0);
  const entry = cost > 0 ? post(ctx, {
    userId, date, memo, sourceType: SRC.cogs, sourceId: refId,
    lines: [{ account: '5300', debit: cost }, { account: '1300', credit: cost }],
  }) : null;
  const ids = work.map((w) => insertMovement(ctx, { ...w.plan, sku: w.sku, warehouseId: w.wh.id, kind: 'sale', refType, refId, entryId: entry?.id, userId }));
  const flagged = work.filter((w) => w.plan.flags.length).map((w) => ({ sku: w.sku, flags: w.plan.flags }));
  audit(ctx, { userId, action: 'inventory.cogs', type: refType, id: refId, newValue: { cost, entryId: entry?.id ?? null, items: work.length, flagged } });
  return { cost, entryId: entry?.id ?? null, movements: ids, flagged };
}

export const hooks = {
  'sale.created': (ctx, p) => {
    consume(ctx, { rows: p.items ?? [], refType: 'sale', refId: p.sale.id, userId: p.userId, memo: `Cost of goods sold, sale #${p.sale.id}` });
  },
  // Invoice lines are { description, qty, unitPrice, sku? }. Only lines that carry a sku relieve stock.
  'invoice.created': (ctx, p) => {
    const rows = (p.invoice.lines ?? []).filter((l) => l.sku).map((l) => ({ sku: l.sku, qty: l.qty }));
    if (rows.length) consume(ctx, { rows, refType: 'invoice', refId: p.invoice.id, userId: p.userId, memo: `Cost of goods sold, invoice ${p.invoice.number}`, date: p.invoice.issueDate });
  },
};

// ---------- reads ----------
const canCosts = (user) => user.permissions.has('inventory.costs');

function stockMaps(db) {
  const wh = new Map(); // sku -> [{warehouseId, qty}]
  for (const r of db.prepare('SELECT sku, warehouse_id, qty FROM inventory_stock_on_hand').all()) {
    if (!wh.has(r.sku)) wh.set(r.sku, []);
    wh.get(r.sku).push({ warehouseId: r.warehouse_id, qty: r.qty });
  }
  const tot = new Map(db.prepare('SELECT sku, SUM(qty) AS q, SUM(value) AS v FROM inventory_movements GROUP BY sku').all().map((r) => [r.sku, r]));
  return { wh, tot };
}

function stockRows(db, user, { warehouseId = null } = {}) {
  const { wh, tot } = stockMaps(db);
  const items = db.prepare(`SELECT s.sku, i.name, i.name_ar, s.unit, s.barcode, s.reorder_level, s.reorder_qty
    FROM inventory_item_settings s JOIN items i ON i.sku = s.sku WHERE s.track = 1 ORDER BY s.sku`).all();
  const costs = canCosts(user);
  return items.map((it) => {
    const byWh = wh.get(it.sku) ?? [];
    const t = tot.get(it.sku) ?? { q: 0, v: 0 };
    const qty = warehouseId ? (byWh.find((x) => x.warehouseId === warehouseId)?.qty ?? 0) : t.q;
    const row = {
      ...it, qty, warehouses: byWh,
      negative: byWh.some((x) => x.qty < 0),
      outOfStock: qty <= 0,
      low: it.reorder_level > 0 && qty <= it.reorder_level,
    };
    if (costs) { row.avgCost = t.q > 0 ? Math.round(t.v / t.q) : null; row.value = t.v; }
    return row;
  });
}

export function listStock(ctx, user, query = {}) {
  requirePerm(user, 'inventory.view');
  const warehouseId = query.warehouse ? Number(query.warehouse) : null;
  let rows = stockRows(ctx.db, user, { warehouseId });
  if (query.low === '1' || query.low === 'true') rows = rows.filter((r) => r.low);
  return { warehouses: ctx.db.prepare('SELECT id, code, name, name_ar, is_default, active FROM inventory_warehouses ORDER BY id').all(), items: rows };
}

export function stockDetail(ctx, user, sku) {
  requirePerm(user, 'inventory.view');
  const row = stockRows(ctx.db, user).find((r) => r.sku === sku);
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Not a stock item');
  return { ...row, movements: listMovements(ctx, user, { sku, limit: '50' }) };
}

export function listMovements(ctx, user, q = {}) {
  requirePerm(user, 'inventory.view');
  const where = [], args = [];
  if (q.sku) { where.push('sku = ?'); args.push(q.sku); }
  if (q.kind) { if (!KINDS.includes(q.kind)) throw bad('Unknown kind'); where.push('kind = ?'); args.push(q.kind); }
  if (q.warehouse) { where.push('warehouse_id = ?'); args.push(Number(q.warehouse)); }
  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
  const costs = canCosts(user);
  return ctx.db.prepare(`SELECT id, sku, warehouse_id, kind, qty, unit_cost, value, flags, ref_type, ref_id, entry_id, supplier, reason, created_by, created_at
    FROM inventory_movements ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`).all(...args)
    .map((m) => (costs ? m : { ...m, unit_cost: null, value: null }));
}

export function lookupBarcode(ctx, user, code) {
  requirePerm(user, 'inventory.view');
  const s = ctx.db.prepare('SELECT sku FROM inventory_item_settings WHERE barcode = ?').get(String(code).trim());
  if (!s) throw new AppError(404, 'BARCODE_NOT_FOUND', 'No item has this barcode');
  const row = stockRows(ctx.db, user).find((r) => r.sku === s.sku);
  const it = itemRow(ctx.db, s.sku);
  return { ...(row ?? { sku: s.sku, name: it.name, name_ar: it.name_ar, qty: 0 }), price: it.price };
}

export function lowStock(ctx, user) {
  requirePerm(user, 'inventory.view');
  return stockRows(ctx.db, user).filter((r) => r.low || r.negative)
    .map((r) => ({ sku: r.sku, name: r.name, name_ar: r.name_ar, unit: r.unit, qty: r.qty, reorder_level: r.reorder_level, reorder_qty: r.reorder_qty, negative: r.negative }))
    .sort((a, b) => a.qty - b.qty);
}

export function warnings(ctx, user) {
  requirePerm(user, 'inventory.view');
  const { db } = ctx;
  const negative = stockRows(db, user).filter((r) => r.negative).map((r) => ({ sku: r.sku, name: r.name, name_ar: r.name_ar, qty: r.qty }));
  const flagged = db.prepare("SELECT id, sku, kind, qty, flags, ref_type, ref_id, created_at FROM inventory_movements WHERE flags <> '' ORDER BY id DESC LIMIT 50").all();
  return { negative, flagged };
}

export function valuation(ctx, user) {
  requirePerm(user, 'inventory.costs');
  const { db } = ctx;
  const { tot } = stockMaps(db);
  const items = db.prepare('SELECT s.sku, i.name, i.name_ar, s.unit FROM inventory_item_settings s JOIN items i ON i.sku = s.sku ORDER BY s.sku').all()
    .map((it) => {
      const t = tot.get(it.sku) ?? { q: 0, v: 0 };
      return { ...it, qty: t.q, avgCost: t.q > 0 ? Math.round(t.v / t.q) : null, value: t.v, negative: t.q < 0 };
    }).filter((it) => it.qty !== 0 || it.value !== 0);
  const total = items.reduce((s, i) => s + i.value, 0);
  const subledger = db.prepare('SELECT COALESCE(SUM(value),0) AS v FROM inventory_movements').get().v;
  const ledger = accountBalance(db, '1300').net;
  const fromInventory = db.prepare(`SELECT COALESCE(SUM(l.debit - l.credit),0) AS n FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    JOIN journal_entries e ON e.id = l.entry_id WHERE a.code = '1300' AND e.source_type LIKE 'inventory%'`).get().n;
  return {
    items, total: subledger, subledgerTotal: total, ledgerBalance: ledger, difference: ledger - subledger, reconciled: ledger === subledger,
    ledgerFromInventory: fromInventory, ledgerOther: ledger - fromInventory, asOf: ctx.now(),
    note: 'Difference = ledger balance of 1300 minus stock valuation. A non-zero difference means entries were posted to 1300 outside the inventory module (see ledgerOther).',
  };
}

// ---------- setup: item settings, warehouses, units, settings ----------
export function listItemSettings(ctx, user) {
  requirePerm(user, 'inventory.view');
  return ctx.db.prepare(`SELECT i.sku, i.name, i.name_ar, COALESCE(s.track, 0) AS track, s.unit, s.barcode, s.reorder_level, s.reorder_qty
    FROM items i LEFT JOIN inventory_item_settings s ON s.sku = i.sku ORDER BY i.id`).all();
}

export function setItemSettings(ctx, user, sku, input) {
  requirePerm(user, 'inventory.manage');
  const { db } = ctx;
  skuInput(db, sku);
  const old = settingsRow(db, sku);
  const next = { track: old?.track ?? 1, unit: old?.unit ?? 'pcs', barcode: old?.barcode ?? null, reorder_level: old?.reorder_level ?? 0, reorder_qty: old?.reorder_qty ?? 0 };
  if ('track' in input) next.track = input.track ? 1 : 0;
  if ('unit' in input) {
    if (!db.prepare('SELECT 1 FROM inventory_units WHERE code = ?').get(input.unit)) throw bad('Unknown unit', 'UNKNOWN_UNIT');
    next.unit = input.unit;
  }
  if ('barcode' in input) {
    const b = input.barcode == null || input.barcode === '' ? null : String(input.barcode).trim();
    if (b !== null && !BARCODE_RE.test(b)) throw bad('Barcode must be 3-64 letters, digits, dash, dot or underscore', 'BAD_BARCODE');
    next.barcode = b;
  }
  for (const [k, f] of [['reorderLevel', 'reorder_level'], ['reorderQty', 'reorder_qty']]) {
    if (k in input) {
      if (!Number.isInteger(input[k]) || input[k] < 0) throw bad(`${k} must be a whole number, zero or more`);
      next[f] = input[k];
    }
  }
  return tx(db, () => {
    try {
      db.prepare(`INSERT INTO inventory_item_settings (sku, track, unit, barcode, reorder_level, reorder_qty, updated_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(sku) DO UPDATE SET track = excluded.track, unit = excluded.unit, barcode = excluded.barcode,
        reorder_level = excluded.reorder_level, reorder_qty = excluded.reorder_qty, updated_at = excluded.updated_at`)
        .run(sku, next.track, next.unit, next.barcode, next.reorder_level, next.reorder_qty, ctx.now());
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new AppError(409, 'DUPLICATE_BARCODE', 'Another item already uses this barcode');
      throw e;
    }
    audit(ctx, { userId: user.id, action: 'inventory.item_settings', type: 'inventory_item', id: null, oldValue: old ?? null, newValue: { sku, ...next } });
    return { sku, ...next };
  });
}

export function listWarehouses(ctx, user) {
  requirePerm(user, 'inventory.view');
  return ctx.db.prepare('SELECT id, code, name, name_ar, is_default, active FROM inventory_warehouses ORDER BY id').all();
}

export function createWarehouse(ctx, user, input) {
  requirePerm(user, 'inventory.manage');
  const { db } = ctx;
  const code = text(input.code, 'code', 20).toUpperCase();
  if (!/^[A-Z0-9_-]+$/.test(code)) throw bad('code may only use letters, digits, dash and underscore');
  const name = text(input.name, 'name', 100), nameAr = input.name_ar ? text(input.name_ar, 'name_ar', 100) : name;
  return tx(db, () => {
    if (db.prepare('SELECT 1 FROM inventory_warehouses WHERE code = ?').get(code)) throw new AppError(409, 'DUPLICATE', `Warehouse ${code} already exists`);
    if (input.isDefault) db.prepare('UPDATE inventory_warehouses SET is_default = 0').run();
    const id = Number(db.prepare('INSERT INTO inventory_warehouses (code, name, name_ar, is_default) VALUES (?,?,?,?)').run(code, name, nameAr, input.isDefault ? 1 : 0).lastInsertRowid);
    audit(ctx, { userId: user.id, action: 'inventory.warehouse_created', type: 'inventory_warehouse', id, newValue: { code, name, isDefault: !!input.isDefault } });
    return { id, code, name, name_ar: nameAr, is_default: input.isDefault ? 1 : 0, active: 1 };
  });
}

export function updateWarehouse(ctx, user, id, input) {
  requirePerm(user, 'inventory.manage');
  const { db } = ctx;
  const w = db.prepare('SELECT * FROM inventory_warehouses WHERE id = ?').get(id);
  if (!w) throw new AppError(404, 'NOT_FOUND', 'Warehouse not found');
  const next = { ...w };
  if ('name' in input) next.name = text(input.name, 'name', 100);
  if ('name_ar' in input) next.name_ar = text(input.name_ar, 'name_ar', 100);
  if ('active' in input) next.active = input.active ? 1 : 0;
  if (input.isDefault) next.is_default = 1;
  if (!next.active) {
    if (w.is_default) throw new AppError(409, 'DEFAULT_WAREHOUSE', 'The default warehouse cannot be deactivated; make another one the default first');
    const left = db.prepare('SELECT COUNT(*) AS n FROM inventory_stock_on_hand WHERE warehouse_id = ? AND qty <> 0').get(id).n;
    if (left) throw new AppError(409, 'WAREHOUSE_NOT_EMPTY', 'Move the remaining stock out before deactivating');
  }
  if (next.is_default && !next.active) throw new AppError(409, 'DEFAULT_WAREHOUSE', 'The default warehouse must be active');
  tx(db, () => {
    if (input.isDefault) db.prepare('UPDATE inventory_warehouses SET is_default = 0').run();
    db.prepare('UPDATE inventory_warehouses SET name = ?, name_ar = ?, active = ?, is_default = ? WHERE id = ?').run(next.name, next.name_ar, next.active, next.is_default, id);
    audit(ctx, { userId: user.id, action: 'inventory.warehouse_updated', type: 'inventory_warehouse', id, oldValue: w, newValue: next });
  });
  return next;
}

export function listUnits(ctx, user) {
  requirePerm(user, 'inventory.view');
  return ctx.db.prepare('SELECT code, name, name_ar FROM inventory_units ORDER BY code').all();
}

export function createUnit(ctx, user, input) {
  requirePerm(user, 'inventory.manage');
  const code = text(input.code, 'code', 12).toLowerCase();
  if (!/^[a-z0-9]+$/.test(code)) throw bad('code may only use letters and digits');
  const name = text(input.name, 'name', 60), nameAr = input.name_ar ? text(input.name_ar, 'name_ar', 60) : name;
  if (ctx.db.prepare('SELECT 1 FROM inventory_units WHERE code = ?').get(code)) throw new AppError(409, 'DUPLICATE', `Unit ${code} already exists`);
  tx(ctx.db, () => {
    ctx.db.prepare('INSERT INTO inventory_units (code, name, name_ar) VALUES (?,?,?)').run(code, name, nameAr);
    audit(ctx, { userId: user.id, action: 'inventory.unit_created', type: 'inventory_unit', id: null, newValue: { code, name } });
  });
  return { code, name, name_ar: nameAr };
}

export function getSettings(ctx, user) {
  requirePerm(user, 'inventory.view');
  return { allowNegative: allowNegative(ctx.db) };
}

export function putSettings(ctx, user, input) {
  requirePerm(user, 'inventory.manage');
  if (typeof input.allowNegative !== 'boolean') throw bad('allowNegative must be true or false');
  const old = allowNegative(ctx.db);
  tx(ctx.db, () => {
    ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('inventory.allow_negative', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(input.allowNegative ? '1' : '0');
    audit(ctx, { userId: user.id, action: 'inventory.settings', type: 'settings', id: null, oldValue: { allowNegative: old }, newValue: { allowNegative: input.allowNegative } });
  });
  return { allowNegative: input.allowNegative };
}

// ---------- home widget ----------
export function widgets(ctx, user) {
  if (!user.permissions.has('inventory.view')) return {};
  const rows = stockRows(ctx.db, user);
  const low = rows.filter((r) => r.low || r.negative);
  const w = {
    tracked: rows.length,
    lowCount: low.length,
    negativeCount: rows.filter((r) => r.negative).length,
    outOfStockCount: rows.filter((r) => r.outOfStock).length,
    low: low.sort((a, b) => a.qty - b.qty).slice(0, 8).map((r) => ({ sku: r.sku, name: r.name, name_ar: r.name_ar, qty: r.qty, reorder_level: r.reorder_level, negative: r.negative })),
  };
  if (canCosts(user)) w.value = rows.reduce((s, r) => s + (r.value ?? 0), 0);
  return { inventory: w };
}
