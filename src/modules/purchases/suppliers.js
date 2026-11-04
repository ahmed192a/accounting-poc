import { AppError } from '../../errors.js';
import { audit, tx } from '../../ledger.js';
import { requirePerm } from '../../permissions.js';
import { cleanText, wholeInt } from './util.js';

const TAX_ID = /^[0-9A-Za-z\-]{5,20}$/;

function fields(input, { partial = false } = {}) {
  const out = {};
  if (!partial || 'name' in input) out.name = cleanText(input.name, 'name', { required: true, max: 120 });
  if ('nameAr' in input) out.name_ar = cleanText(input.nameAr, 'nameAr', { max: 120 });
  if ('taxId' in input) {
    const t = cleanText(input.taxId, 'taxId', { max: 20 });
    if (t && !TAX_ID.test(t)) throw new AppError(400, 'BAD_TAX_ID', 'Tax id must be 5-20 letters, digits or dashes'); // format only; not verified against any registry
    out.tax_id = t;
  }
  if ('paymentTermsDays' in input) out.payment_terms_days = wholeInt(input.paymentTermsDays, 'paymentTermsDays', { min: 0, max: 365 });
  if ('email' in input) {
    const e = cleanText(input.email, 'email', { max: 120 });
    if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new AppError(400, 'BAD_INPUT', 'email is not valid');
    out.email = e;
  }
  if ('phone' in input) out.phone = cleanText(input.phone, 'phone', { max: 30 });
  if ('active' in input) out.active = input.active ? 1 : 0;
  return out;
}

export function createSupplier(ctx, user, input = {}) {
  requirePerm(user, 'suppliers.manage');
  const f = fields(input);
  const { db } = ctx;
  if (db.prepare('SELECT 1 FROM purchases_suppliers WHERE name = ?').get(f.name)) throw new AppError(409, 'DUPLICATE_SUPPLIER', 'A supplier with this name already exists');
  return tx(db, () => {
    const res = db.prepare(`INSERT INTO purchases_suppliers (name, name_ar, tax_id, payment_terms_days, email, phone, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(f.name, f.name_ar ?? null, f.tax_id ?? null, f.payment_terms_days ?? 0, f.email ?? null, f.phone ?? null, user.id, ctx.now());
    const id = Number(res.lastInsertRowid);
    audit(ctx, { userId: user.id, action: 'supplier.created', type: 'supplier', id, newValue: f });
    return { id };
  });
}

export function updateSupplier(ctx, user, id, input = {}) {
  requirePerm(user, 'suppliers.manage');
  const { db } = ctx;
  const old = db.prepare('SELECT * FROM purchases_suppliers WHERE id = ?').get(id);
  if (!old) throw new AppError(404, 'NOT_FOUND', 'Supplier not found');
  const f = fields(input, { partial: true });
  const keys = Object.keys(f);
  if (!keys.length) throw new AppError(400, 'BAD_INPUT', 'Nothing to change');
  if (f.name && db.prepare('SELECT 1 FROM purchases_suppliers WHERE name = ? AND id != ?').get(f.name, id)) throw new AppError(409, 'DUPLICATE_SUPPLIER', 'A supplier with this name already exists');
  return tx(db, () => {
    db.prepare(`UPDATE purchases_suppliers SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), id);
    if (f.name && f.name !== old.name) db.prepare('UPDATE bills SET supplier = ? WHERE supplier_id = ?').run(f.name, id);
    audit(ctx, { userId: user.id, action: 'supplier.updated', type: 'supplier', id, oldValue: old, newValue: f });
    return { id };
  });
}

export function listSuppliers(ctx, user) {
  requirePerm(user, 'purchases.view');
  return ctx.db.prepare(`SELECT s.*, COALESCE((SELECT SUM(b.amount - b.paid) FROM bills b WHERE b.supplier_id = s.id AND b.status IN ('approved','partially_paid')), 0) AS outstanding
    FROM purchases_suppliers s ORDER BY s.name`).all();
}

export function getSupplier(ctx, user, id) {
  requirePerm(user, 'purchases.view');
  const s = ctx.db.prepare('SELECT * FROM purchases_suppliers WHERE id = ?').get(id);
  if (!s) throw new AppError(404, 'NOT_FOUND', 'Supplier not found');
  return s;
}

/** Find a supplier by id or (case-insensitive) name; a bill from an unknown name creates a minimal supplier row. */
export function resolveSupplier(ctx, userId, { supplierId, supplier }) {
  const { db } = ctx;
  if (supplierId != null) {
    const s = db.prepare('SELECT * FROM purchases_suppliers WHERE id = ?').get(supplierId);
    if (!s) throw new AppError(404, 'SUPPLIER_NOT_FOUND', 'Supplier not found');
    if (!s.active) throw new AppError(409, 'SUPPLIER_INACTIVE', 'Supplier is inactive');
    return s;
  }
  const name = cleanText(supplier, 'supplier', { required: true, max: 120 });
  let s = db.prepare('SELECT * FROM purchases_suppliers WHERE name = ?').get(name);
  if (!s) {
    const res = db.prepare('INSERT INTO purchases_suppliers (name, auto_created, created_by, created_at) VALUES (?,?,?,?)').run(name, 1, userId, ctx.now());
    s = db.prepare('SELECT * FROM purchases_suppliers WHERE id = ?').get(Number(res.lastInsertRowid));
    audit(ctx, { userId, action: 'supplier.auto_created', type: 'supplier', id: s.id, newValue: { name } });
  } else if (!s.active) throw new AppError(409, 'SUPPLIER_INACTIVE', 'Supplier is inactive');
  return s;
}
