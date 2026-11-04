import { AppError, posInt } from '../../errors.js';
import { audit, tx } from '../../ledger.js';
import { requirePerm } from '../../permissions.js';
import { setting } from '../../db.js';
import { cleanText, validDate, today, wholeInt } from './util.js';
import { resolveSupplier } from './suppliers.js';

function cleanLines(lines, { priceMax = 10 ** 12 } = {}) {
  if (!Array.isArray(lines) || !lines.length) throw new AppError(400, 'BAD_INPUT', 'At least one line is required');
  if (lines.length > 100) throw new AppError(400, 'BAD_INPUT', 'At most 100 lines');
  return lines.map((l, i) => ({
    description: cleanText(l?.description, `line ${i + 1} description`, { required: true, max: 200 }),
    qty: posInt(l?.qty, `line ${i + 1} qty`),
    unitPrice: wholeInt(l?.unitPrice, `line ${i + 1} unitPrice`, { min: 0, max: priceMax }),
  }));
}

export function createPurchaseOrder(ctx, user, input = {}) {
  requirePerm(user, 'purchases.create');
  const { db } = ctx;
  const lines = cleanLines(input.lines);
  const orderDate = input.orderDate ? validDate(input.orderDate, 'orderDate') : today(ctx);
  return tx(db, () => {
    const supplier = resolveSupplier(ctx, user.id, input);
    const res = db.prepare("INSERT INTO purchases_orders (number, supplier_id, order_date, status, note, created_by, created_at) VALUES ('tmp',?,?,'open',?,?,?)")
      .run(supplier.id, orderDate, cleanText(input.note, 'note', { max: 300 }), user.id, ctx.now());
    const id = Number(res.lastInsertRowid);
    const number = `PO-${String(id).padStart(5, '0')}`;
    db.prepare('UPDATE purchases_orders SET number = ? WHERE id = ?').run(number, id);
    const ins = db.prepare('INSERT INTO purchases_order_lines (po_id, description, qty, unit_price) VALUES (?,?,?,?)');
    for (const l of lines) ins.run(id, l.description, l.qty, l.unitPrice);
    const total = lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
    audit(ctx, { userId: user.id, action: 'po.created', type: 'purchase_order', id, newValue: { number, supplier: supplier.name, total } });
    return { id, number, total };
  });
}

export function getPurchaseOrder(ctx, user, id) {
  requirePerm(user, 'purchases.view');
  const po = ctx.db.prepare('SELECT o.*, s.name AS supplier FROM purchases_orders o JOIN purchases_suppliers s ON s.id = o.supplier_id WHERE o.id = ?').get(id);
  if (!po) throw new AppError(404, 'NOT_FOUND', 'Purchase order not found');
  const lines = ctx.db.prepare('SELECT * FROM purchases_order_lines WHERE po_id = ? ORDER BY id').all(id);
  return { ...po, lines, total: lines.reduce((s, l) => s + l.qty * l.unit_price, 0) };
}

export function listPurchaseOrders(ctx, user) {
  requirePerm(user, 'purchases.view');
  return ctx.db.prepare(`SELECT o.*, s.name AS supplier,
      (SELECT COALESCE(SUM(qty * unit_price), 0) FROM purchases_order_lines WHERE po_id = o.id) AS total
    FROM purchases_orders o JOIN purchases_suppliers s ON s.id = o.supplier_id ORDER BY o.id DESC`).all();
}

/** Record goods received against PO lines: input.lines = [{ lineId, qty }]. Basic receipt tracking for the 3-way match. */
export function receivePurchaseOrder(ctx, user, id, input = {}) {
  requirePerm(user, 'purchases.create');
  const { db } = ctx;
  const po = db.prepare('SELECT * FROM purchases_orders WHERE id = ?').get(id);
  if (!po) throw new AppError(404, 'NOT_FOUND', 'Purchase order not found');
  if (po.status === 'cancelled') throw new AppError(409, 'PO_CANCELLED', 'Purchase order is cancelled');
  if (!Array.isArray(input.lines) || !input.lines.length) throw new AppError(400, 'BAD_INPUT', 'lines are required');
  return tx(db, () => {
    for (const l of input.lines) {
      const line = db.prepare('SELECT * FROM purchases_order_lines WHERE id = ? AND po_id = ?').get(l?.lineId, id);
      if (!line) throw new AppError(404, 'LINE_NOT_FOUND', 'Line does not belong to this purchase order');
      const qty = posInt(l.qty, 'qty');
      if (line.received_qty + qty > line.qty) throw new AppError(409, 'OVER_RECEIPT', `Cannot receive more than ordered (${line.qty}) for "${line.description}"`);
      db.prepare('UPDATE purchases_order_lines SET received_qty = received_qty + ? WHERE id = ?').run(qty, line.id);
    }
    db.prepare('UPDATE purchases_orders SET received_any = 1 WHERE id = ?').run(id);
    audit(ctx, { userId: user.id, action: 'po.received', type: 'purchase_order', id, newValue: { lines: input.lines } });
    return { id };
  });
}

export function cancelPurchaseOrder(ctx, user, id, reason) {
  requirePerm(user, 'purchases.create');
  const { db } = ctx;
  const po = db.prepare('SELECT * FROM purchases_orders WHERE id = ?').get(id);
  if (!po) throw new AppError(404, 'NOT_FOUND', 'Purchase order not found');
  if (po.status !== 'open') throw new AppError(409, 'PO_NOT_OPEN', 'Only an untouched open purchase order can be cancelled');
  const r = cleanText(reason, 'reason', { required: true, max: 200 });
  tx(db, () => {
    db.prepare("UPDATE purchases_orders SET status = 'cancelled' WHERE id = ?").run(id);
    audit(ctx, { userId: user.id, action: 'po.cancelled', type: 'purchase_order', id, reason: r });
  });
  return { id };
}

const toleranceBp = (db) => Number(setting(db, 'purchases_match_tolerance_bp') ?? 0);

/**
 * Basic 3-way match of bill lines against a purchase order (ordered vs received vs billed).
 * Returns { variances } where each variance is { poLineId, kind, expected, actual }.
 *  - price: unit price differs from the PO price by more than the tolerance (basis points)
 *  - qty_over_ordered: total billed on this line would exceed the ordered quantity
 *  - qty_over_received: receipts are tracked on this PO and the bill would exceed what was received
 */
export function matchBill(ctx, po, billLines) {
  const { db } = ctx;
  const tol = toleranceBp(db);
  const variances = [];
  const seen = new Map();
  for (const bl of billLines) {
    if (bl.poLineId == null) {
      variances.push({ poLineId: null, kind: 'not_on_po', expected: null, actual: bl.description });
      continue;
    }
    const line = db.prepare('SELECT * FROM purchases_order_lines WHERE id = ? AND po_id = ?').get(bl.poLineId, po.id);
    if (!line) throw new AppError(404, 'LINE_NOT_FOUND', 'Bill line points to a line that is not on this purchase order');
    const qtyNow = (seen.get(line.id) ?? 0) + bl.qty;
    seen.set(line.id, qtyNow);
    if (Math.abs(bl.unitPrice - line.unit_price) * 10000 > line.unit_price * tol) {
      variances.push({ poLineId: line.id, kind: 'price', expected: line.unit_price, actual: bl.unitPrice });
    }
    if (line.billed_qty + qtyNow > line.qty) variances.push({ poLineId: line.id, kind: 'qty_over_ordered', expected: line.qty - line.billed_qty, actual: qtyNow });
    else if (po.received_any && line.billed_qty + qtyNow > line.received_qty) variances.push({ poLineId: line.id, kind: 'qty_over_received', expected: line.received_qty - line.billed_qty, actual: qtyNow });
  }
  return { variances };
}

/** Move PO line billed quantities (+1 when a bill is created, -1 when it is rejected or voided) and refresh the PO status. */
export function applyBilledQty(ctx, poId, lines, sign) {
  const { db } = ctx;
  for (const l of lines) {
    if (l.po_line_id ?? l.poLineId) db.prepare('UPDATE purchases_order_lines SET billed_qty = billed_qty + ? WHERE id = ?').run(sign * l.qty, l.po_line_id ?? l.poLineId);
  }
  const sums = db.prepare('SELECT SUM(qty) q, SUM(billed_qty) b FROM purchases_order_lines WHERE po_id = ?').get(poId);
  const status = sums.b <= 0 ? 'open' : sums.b >= sums.q ? 'billed' : 'partially_billed';
  db.prepare("UPDATE purchases_orders SET status = ? WHERE id = ? AND status != 'cancelled'").run(status, poId);
}
