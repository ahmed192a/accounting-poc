import { AppError, posInt } from '../../errors.js';
import { postEntry, tx, audit, reverseEntry } from '../../ledger.js';
import { requirePerm, limitFor } from '../../permissions.js';
import * as eta from '../eta/adapter.js';
import { emit } from '../../hooks.js';
import { text, vatOf } from './common.js';

const nonZero = (lines) => lines.filter((l) => (l.debit ?? 0) + (l.credit ?? 0) > 0);

/** Parse { type: 'percent'|'fixed', value } into a piastre amount of the gross subtotal. */
function discountAmount(user, raw, gross) {
  if (raw == null) return { amount: 0 };
  requirePerm(user, 'sales.discount');
  const type = raw.type;
  let amount;
  if (type === 'percent') {
    if (typeof raw.value !== 'number' || !(raw.value > 0) || raw.value > 100) throw new AppError(400, 'BAD_INPUT', 'Percent discount must be above 0 and at most 100');
    amount = Math.round((gross * Math.round(raw.value * 100)) / 10000); // percent kept to 2 decimals as basis points
  } else if (type === 'fixed') {
    amount = posInt(raw.value, 'discount value');
  } else {
    throw new AppError(400, 'BAD_INPUT', 'discount.type must be percent or fixed');
  }
  if (amount <= 0) throw new AppError(400, 'BAD_INPUT', 'Discount rounds to nothing');
  if (amount >= gross) throw new AppError(400, 'DISCOUNT_TOO_LARGE', 'Discount must be smaller than the sale subtotal');
  const max = limitFor(user, 'sales.discount');
  if (amount > max) throw new AppError(403, 'DISCOUNT_LIMIT', 'Discount is above your limit; ask a manager', { limit: max, requested: amount });
  return { amount, type, value: type === 'percent' ? Math.round(raw.value * 100) : raw.value };
}

/** Quick sale with optional discount. Existing payloads (sale.created, receipt queue) are unchanged. */
export function quickSale(ctx, user, input = {}, opts = {}) {
  requirePerm(user, 'sales.create');
  const { db } = ctx;
  if (!Array.isArray(input.items) || input.items.length === 0) throw new AppError(400, 'BAD_INPUT', 'Add at least one item');
  const bySku = db.prepare('SELECT * FROM items WHERE sku = ?');
  const items = input.items.map((i) => {
    const item = bySku.get(i?.sku);
    if (!item) throw new AppError(400, 'UNKNOWN_ITEM', `Unknown item ${i?.sku}`);
    if (!item.active) throw new AppError(400, 'ITEM_INACTIVE', `Item ${item.sku} is not for sale any more`);
    return { ...item, qty: posInt(i.qty, 'qty') };
  });
  const gross = items.reduce((s, i) => s + i.price * i.qty, 0);
  const disc = discountAmount(user, input.discount, gross);
  const subtotal = gross - disc.amount;
  const vat = vatOf(db, subtotal), total = subtotal + vat;

  return tx(db, () => {
    const entry = postEntry(ctx, {
      userId: user.id, memo: disc.amount ? 'Quick sale (discounted)' : 'Quick sale', sourceType: 'sale',
      lines: nonZero([{ account: '1000', debit: total }, { account: '4000', credit: subtotal }, { account: '2100', credit: vat }]),
    });
    const res = db
      .prepare('INSERT INTO sales (items, subtotal, vat, total, created_by, created_at, entry_id, discount_type, discount_value, discount_amount) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(JSON.stringify(items.map((i) => ({ sku: i.sku, qty: i.qty, price: i.price }))), subtotal, vat, total, user.id, ctx.now(), entry.id, disc.type ?? null, disc.value ?? null, disc.amount);
    const sale = { id: Number(res.lastInsertRowid), subtotal, vat, total };
    if (disc.amount) sale.discount = disc.amount; // only present on discounted sales; revenue is posted net of it
    audit(ctx, { userId: user.id, action: 'sale.created', type: 'sale', id: sale.id, newValue: { total, ...(disc.amount ? { discount: disc.amount } : {}) } });
    const receipt = eta.queueReceipt(ctx, sale, items);
    emit(ctx, 'sale.created', { sale, items, entryId: entry.id, receipt, userId: user.id });
    if (opts.parkedId) db.prepare("UPDATE sales_parked SET status = 'sold', sale_id = ? WHERE id = ?").run(sale.id, opts.parkedId);
    return { sale, receipt, entryId: entry.id };
  });
}

/** Refund a whole quick sale: posts a ledger reversal. The reaction hook marks the sale and emits sale.refunded. */
export function refundSale(ctx, user, id, input = {}) {
  requirePerm(user, 'sales.credit');
  const { db } = ctx;
  const reason = text(input.reason, 'reason', { max: 300, required: true });
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
  if (!sale) throw new AppError(404, 'NOT_FOUND', 'Sale not found');
  if (sale.refunded) throw new AppError(409, 'ALREADY_REFUNDED', 'This sale was already refunded');
  if (sale.total > limitFor(user, 'sales.credit')) throw new AppError(403, 'CREDIT_LIMIT', 'Refund is above your approval limit', { limit: limitFor(user, 'sales.credit'), requested: sale.total });
  return tx(db, () => {
    const rev = reverseEntry(ctx, user.id, sale.entry_id, reason);
    const after = db.prepare('SELECT refunded, refund_entry_id FROM sales WHERE id = ?').get(id);
    if (!after.refunded) throw new AppError(500, 'REFUND_NOT_RECORDED', 'Refund was not recorded; nothing was changed');
    return { id, refundEntryId: rev.id, total: sale.total };
  });
}

export function listSales(ctx, user) {
  requirePerm(user, 'sales.view');
  return ctx.db.prepare('SELECT id, subtotal, vat, total, discount_amount, created_by, created_at, refunded, refund_reason FROM sales ORDER BY id DESC LIMIT 50').all()
    .map((s) => ({ ...s, refunded: !!s.refunded }));
}

// Parked (held) sales: a cart saved for later; prices and discount rights are re-checked at checkout.
export function parkSale(ctx, user, input = {}) {
  requirePerm(user, 'sales.create');
  const { db } = ctx;
  if (!Array.isArray(input.items) || input.items.length === 0) throw new AppError(400, 'BAD_INPUT', 'Add at least one item');
  if (input.items.length > 100) throw new AppError(400, 'BAD_INPUT', 'Too many items');
  const items = input.items.map((i) => {
    const item = db.prepare('SELECT sku FROM items WHERE sku = ? AND active = 1').get(i?.sku);
    if (!item) throw new AppError(400, 'UNKNOWN_ITEM', `Unknown or inactive item ${i?.sku}`);
    return { sku: item.sku, qty: posInt(i.qty, 'qty') };
  });
  const label = text(input.label, 'label', { max: 60 }) ?? `Held ${new Date(ctx.now()).toISOString().slice(11, 16)}`;
  return tx(db, () => {
    const res = db.prepare('INSERT INTO sales_parked (label, items, discount, created_by, created_at) VALUES (?,?,?,?,?)')
      .run(label, JSON.stringify(items), input.discount ? JSON.stringify(input.discount) : null, user.id, ctx.now());
    const id = Number(res.lastInsertRowid);
    audit(ctx, { userId: user.id, action: 'sale.parked', type: 'parked_sale', id, newValue: { label, lines: items.length } });
    return { id, label, items };
  });
}

export function listParked(ctx, user) {
  requirePerm(user, 'sales.create');
  return ctx.db.prepare("SELECT id, label, items, discount, created_by, created_at FROM sales_parked WHERE status = 'held' ORDER BY id").all()
    .map((p) => ({ ...p, items: JSON.parse(p.items), discount: p.discount ? JSON.parse(p.discount) : null }));
}

const heldRow = (db, id) => {
  const p = db.prepare('SELECT * FROM sales_parked WHERE id = ?').get(id);
  if (!p) throw new AppError(404, 'NOT_FOUND', 'Parked sale not found');
  if (p.status !== 'held') throw new AppError(409, 'NOT_HELD', `This parked sale is already ${p.status}`);
  return p;
};

export function checkoutParked(ctx, user, id) {
  requirePerm(user, 'sales.create');
  const p = heldRow(ctx.db, id);
  return quickSale(ctx, user, { items: JSON.parse(p.items), discount: p.discount ? JSON.parse(p.discount) : undefined }, { parkedId: id });
}

export function discardParked(ctx, user, id) {
  requirePerm(user, 'sales.create');
  const { db } = ctx;
  const p = heldRow(db, id);
  return tx(db, () => {
    db.prepare("UPDATE sales_parked SET status = 'discarded' WHERE id = ?").run(id);
    audit(ctx, { userId: user.id, action: 'sale.park_discarded', type: 'parked_sale', id, oldValue: { label: p.label } });
    return { id, discarded: true };
  });
}
