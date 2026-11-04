import { AppError } from '../../errors.js';
import { tx, audit } from '../../ledger.js';
import { requirePerm, requireAny } from '../../permissions.js';
import { getCurrency } from './fxcore.js';

// ---------- Entity lookup and access ----------
/** The entity id a request means: body/query `entityId`, default 1. (Header X-Entity-Id is a request for the security agent.) */
export function entityIdOf(...sources) {
  for (const s of sources) {
    const v = s?.entityId;
    if (v != null && v !== '') {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw new AppError(400, 'BAD_INPUT', 'entityId must be a positive whole number');
      return n;
    }
  }
  return 1;
}

export function getEntity(ctx, id) {
  const e = ctx.db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
  if (!e) throw new AppError(404, 'ENTITY_NOT_FOUND', `Unknown entity ${id}`);
  return e;
}

/** An entity without any access rows is open to everyone; otherwise listed users and holders of entities.manage. */
export function canAccessEntity(ctx, user, entityId) {
  const rows = ctx.db.prepare('SELECT user_id FROM entities_users WHERE entity_id = ?').all(entityId);
  return rows.length === 0 || user.permissions.has('entities.manage') || rows.some((r) => r.user_id === user.id);
}

export function assertEntityAccess(ctx, user, entityId) {
  const e = getEntity(ctx, entityId);
  if (!canAccessEntity(ctx, user, entityId)) throw new AppError(403, 'ENTITY_FORBIDDEN', `You do not have access to entity ${e.code}`);
  return e;
}

const view = (e, users) => ({
  id: e.id, code: e.code, name: e.name, nameAr: e.name_ar, kind: e.kind, parentId: e.parent_id, currency: e.currency,
  fiscalYearStartMonth: e.fiscal_year_start_month, active: !!e.active, ...(users ? { userIds: users } : {}),
});

export function listEntities(ctx, user) {
  requireAny(user, ['entities.view', 'entities.manage', 'ledger.view', 'ledger.post']);
  const manage = user.permissions.has('entities.manage');
  return ctx.db.prepare('SELECT * FROM entities ORDER BY id').all()
    .filter((e) => canAccessEntity(ctx, user, e.id))
    .map((e) => view(e, manage ? ctx.db.prepare('SELECT user_id FROM entities_users WHERE entity_id = ? ORDER BY user_id').all(e.id).map((r) => r.user_id) : null));
}

const text = (v, field, { max = 120, required = true } = {}) => {
  const s = String(v ?? '').trim();
  if (required && !s) throw new AppError(400, 'BAD_INPUT', `${field} is required`);
  if (s.length > max) throw new AppError(400, 'BAD_INPUT', `${field} is too long`);
  return s;
};

export function createEntity(ctx, user, input = {}) {
  requirePerm(user, 'entities.manage');
  const { db } = ctx;
  const code = text(input.code, 'code', { max: 20 }).toUpperCase();
  if (!/^[A-Z0-9_-]+$/.test(code)) throw new AppError(400, 'BAD_INPUT', 'code may contain letters, digits, - and _ only');
  const name = text(input.name, 'name');
  const nameAr = text(input.nameAr, 'nameAr', { required: false });
  const kind = input.kind ?? 'company';
  if (!['company', 'branch'].includes(kind)) throw new AppError(400, 'BAD_INPUT', 'kind must be company or branch');
  const currency = String(input.currency ?? 'EGP').toUpperCase();
  getCurrency(db, currency);
  const month = input.fiscalYearStartMonth ?? 1;
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new AppError(400, 'BAD_INPUT', 'fiscalYearStartMonth must be 1-12');
  if (input.parentId != null) getEntity(ctx, input.parentId);
  if (db.prepare('SELECT 1 FROM entities WHERE code = ?').get(code)) throw new AppError(409, 'DUPLICATE', `Entity code ${code} already exists`);
  return tx(db, () => {
    const res = db.prepare('INSERT INTO entities (code, name, name_ar, kind, parent_id, currency, fiscal_year_start_month, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(code, name, nameAr, kind, input.parentId ?? null, currency, month, ctx.now());
    const id = Number(res.lastInsertRowid);
    audit(ctx, { userId: user.id, action: 'entity.created', type: 'entity', id, newValue: { code, name, kind, currency, fiscalYearStartMonth: month } });
    return { id };
  });
}

export function updateEntity(ctx, user, id, input = {}) {
  requirePerm(user, 'entities.manage');
  const { db } = ctx;
  const old = getEntity(ctx, id);
  const next = {
    name: input.name != null ? text(input.name, 'name') : old.name,
    name_ar: input.nameAr != null ? text(input.nameAr, 'nameAr', { required: false }) : old.name_ar,
    active: input.active != null ? (input.active ? 1 : 0) : old.active,
  };
  if (old.id === 1 && !next.active) throw new AppError(409, 'ENTITY_PROTECTED', 'The default entity cannot be deactivated');
  return tx(db, () => {
    db.prepare('UPDATE entities SET name = ?, name_ar = ?, active = ? WHERE id = ?').run(next.name, next.name_ar, next.active, id);
    audit(ctx, { userId: user.id, action: 'entity.updated', type: 'entity', id, oldValue: { name: old.name, nameAr: old.name_ar, active: !!old.active }, newValue: { name: next.name, nameAr: next.name_ar, active: !!next.active } });
    return { id };
  });
}

/** Replace the list of users allowed into an entity. An empty list opens it to everyone again. */
export function setEntityUsers(ctx, user, id, userIds) {
  requirePerm(user, 'entities.manage');
  const { db } = ctx;
  getEntity(ctx, id);
  if (!Array.isArray(userIds) || userIds.some((u) => !Number.isInteger(u))) throw new AppError(400, 'BAD_INPUT', 'userIds must be a list of user ids');
  for (const u of userIds) if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(u)) throw new AppError(404, 'NOT_FOUND', `User ${u} not found`);
  const old = db.prepare('SELECT user_id FROM entities_users WHERE entity_id = ? ORDER BY user_id').all(id).map((r) => r.user_id);
  return tx(db, () => {
    db.prepare('DELETE FROM entities_users WHERE entity_id = ?').run(id);
    const ins = db.prepare('INSERT INTO entities_users (entity_id, user_id) VALUES (?,?)');
    for (const u of new Set(userIds)) ins.run(id, u);
    audit(ctx, { userId: user.id, action: 'entity.access_changed', type: 'entity', id, oldValue: { userIds: old }, newValue: { userIds: [...new Set(userIds)].sort((a, b) => a - b) } });
    return { id, userIds: [...new Set(userIds)] };
  });
}

// ---------- Fiscal year ----------
/** Date range of fiscal year `fy` (the calendar year in which it ENDS) for a start month 1-12. */
export function fiscalRange(startMonth, fy) {
  if (!Number.isInteger(fy) || fy < 1900 || fy > 2999) throw new AppError(400, 'BAD_INPUT', 'fiscalYear must be a year such as 2026');
  const pad = (n) => String(n).padStart(2, '0');
  if (startMonth === 1) return { start: `${fy}-01-01`, end: `${fy}-12-31` };
  const endMonth = startMonth - 1;
  const endDay = new Date(Date.UTC(fy, endMonth, 0)).getUTCDate();
  return { start: `${fy - 1}-${pad(startMonth)}-01`, end: `${fy}-${pad(endMonth)}-${pad(endDay)}` };
}

/** The fiscal year (ending year) that contains `date`. */
export function fiscalYearOf(startMonth, date) {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  return startMonth === 1 || m < startMonth ? y : y + 1;
}

export function getFiscal(ctx, user, entityId) {
  requireAny(user, ['ledger.view', 'ledger.close', 'entities.manage']);
  const e = assertEntityAccess(ctx, user, entityId);
  const fy = fiscalYearOf(e.fiscal_year_start_month, new Date(ctx.now()).toISOString().slice(0, 10));
  return { entityId, startMonth: e.fiscal_year_start_month, currentFiscalYear: fy, ...{ current: fiscalRange(e.fiscal_year_start_month, fy) } };
}

export function setFiscal(ctx, user, entityId, input = {}) {
  requirePerm(user, 'entities.manage');
  const e = getEntity(ctx, entityId);
  const month = input.startMonth;
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new AppError(400, 'BAD_INPUT', 'startMonth must be 1-12');
  if (ctx.db.prepare('SELECT 1 FROM entities_closings WHERE entity_id = ?').get(entityId)) {
    throw new AppError(409, 'FISCAL_LOCKED', 'The fiscal year start cannot change after a year has been closed');
  }
  return tx(ctx.db, () => {
    ctx.db.prepare('UPDATE entities SET fiscal_year_start_month = ? WHERE id = ?').run(month, entityId);
    audit(ctx, { userId: user.id, action: 'entity.fiscal_changed', type: 'entity', id: entityId, oldValue: { startMonth: e.fiscal_year_start_month }, newValue: { startMonth: month } });
    return { entityId, startMonth: month };
  });
}
