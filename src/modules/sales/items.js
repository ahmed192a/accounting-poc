import { AppError, posInt } from '../../errors.js';
import { tx, audit } from '../../ledger.js';
import { requirePerm, requireAny } from '../../permissions.js';
import { text } from './common.js';

// Catalogue only: stock levels belong to the inventory module, which reads this table by sku.
const SKU = /^[A-Za-z0-9._-]{1,40}$/;
const COLS = 'sku, name, name_ar, price, eta_code, active';

const row = (db, sku) => {
  const i = db.prepare(`SELECT ${COLS} FROM items WHERE sku = ?`).get(sku);
  if (!i) throw new AppError(404, 'NOT_FOUND', 'Item not found');
  return { ...i, active: !!i.active };
};

export function listItems(ctx, user, query = {}) {
  requireAny(user, ['sales.view', 'sales.create']);
  if (query.all) requirePerm(user, 'sales.configure');
  return ctx.db.prepare(`SELECT ${COLS} FROM items ${query.all ? '' : 'WHERE active = 1'} ORDER BY id`).all().map((i) => ({ ...i, active: !!i.active }));
}

export function createItem(ctx, user, input = {}) {
  requirePerm(user, 'sales.configure');
  const { db } = ctx;
  const sku = text(input.sku, 'sku', { max: 40, required: true });
  if (!SKU.test(sku)) throw new AppError(400, 'BAD_INPUT', 'sku may contain letters, digits, . _ - only');
  const name = text(input.name, 'name', { max: 120, required: true });
  const nameAr = text(input.name_ar ?? input.nameAr, 'name_ar', { max: 120 }) ?? name;
  const price = posInt(input.price, 'price');
  const eta = text(input.eta_code ?? input.etaCode, 'eta_code', { max: 80 });
  if (db.prepare('SELECT 1 FROM items WHERE sku = ?').get(sku)) throw new AppError(409, 'DUPLICATE_SKU', 'An item with this sku already exists');
  return tx(db, () => {
    db.prepare('INSERT INTO items (sku, name, name_ar, price, eta_code, active) VALUES (?,?,?,?,?,1)').run(sku, name, nameAr, price, eta);
    audit(ctx, { userId: user.id, action: 'item.created', type: 'item', newValue: { sku, name, price } });
    return row(db, sku);
  });
}

/** The sku never changes (inventory references it); price, names, ETA code and the active flag can. */
export function updateItem(ctx, user, sku, input = {}) {
  requirePerm(user, 'sales.configure');
  const { db } = ctx;
  const old = row(db, sku);
  const next = { ...old };
  if ('name' in input) next.name = text(input.name, 'name', { max: 120, required: true });
  if ('name_ar' in input || 'nameAr' in input) next.name_ar = text(input.name_ar ?? input.nameAr, 'name_ar', { max: 120, required: true });
  if ('price' in input) next.price = posInt(input.price, 'price');
  if ('eta_code' in input || 'etaCode' in input) next.eta_code = text(input.eta_code ?? input.etaCode, 'eta_code', { max: 80 });
  if ('active' in input) next.active = !!input.active;
  if ('sku' in input && input.sku !== sku) throw new AppError(400, 'SKU_IMMUTABLE', 'The sku cannot be changed; create a new item instead');
  return tx(db, () => {
    db.prepare('UPDATE items SET name = ?, name_ar = ?, price = ?, eta_code = ?, active = ? WHERE sku = ?').run(next.name, next.name_ar, next.price, next.eta_code, next.active ? 1 : 0, sku);
    audit(ctx, { userId: user.id, action: 'item.updated', type: 'item', oldValue: old, newValue: next });
    return row(db, sku);
  });
}

export function deleteItem(ctx, user, sku) {
  requirePerm(user, 'sales.configure');
  const { db } = ctx;
  const old = row(db, sku);
  const sold = db.prepare('SELECT 1 FROM sales WHERE items LIKE ? LIMIT 1').get(`%"sku":${JSON.stringify(sku)}%`)
    || db.prepare("SELECT 1 FROM sales_parked WHERE status = 'held' AND items LIKE ? LIMIT 1").get(`%"sku":${JSON.stringify(sku)}%`);
  if (sold) throw new AppError(409, 'ITEM_IN_USE', 'This item appears in sales; deactivate it instead of deleting');
  return tx(db, () => {
    try {
      db.prepare('DELETE FROM items WHERE sku = ?').run(sku);
    } catch (e) {
      if (/constraint/i.test(e.message)) throw new AppError(409, 'ITEM_IN_USE', 'Other records refer to this item; deactivate it instead of deleting');
      throw e;
    }
    audit(ctx, { userId: user.id, action: 'item.deleted', type: 'item', oldValue: old });
    return { sku, deleted: true };
  });
}
