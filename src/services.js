import { AppError } from './errors.js';
import {
  postEntry, reverseEntry, setPeriodLock, getPeriodLock, tx, audit, isoDate,
  trialBalance, profitAndLoss, accountBalance, recentEntries,
} from './ledger.js';
import { PERMISSIONS, ALL_PERMISSIONS, requirePerm, requireAny, limitFor, sodConflicts, loadUser } from './permissions.js';
import * as eta from './eta.js';

const DAY = 24 * 3600 * 1000;
const EXPENSE_CODES = { purchases: '5000', rent: '5100', utilities: '5200' };

function posInt(n, field) {
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, 'BAD_INPUT', `${field} must be a positive whole number`);
  return n;
}
const setting = (db, key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
const vatOf = (db, subtotal) => Math.round((subtotal * Number(setting(db, 'vat_rate_bp'))) / 10000);

// ---------- Sales ----------
export function createInvoice(ctx, user, input) {
  requirePerm(user, 'sales.create');
  const { db } = ctx;
  if (!input.customer || !String(input.customer).trim()) throw new AppError(400, 'BAD_INPUT', 'Customer is required');
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new AppError(400, 'BAD_INPUT', 'At least one line is required');
  let subtotal = 0;
  const lines = input.lines.map((l) => {
    if (!l.description) throw new AppError(400, 'BAD_INPUT', 'Each line needs a description');
    const qty = posInt(l.qty, 'qty'), unitPrice = posInt(l.unitPrice, 'unitPrice');
    subtotal += qty * unitPrice;
    return { description: l.description, qty, unitPrice };
  });
  const vat = vatOf(db, subtotal), total = subtotal + vat;
  const issue = input.date ?? isoDate(ctx.now());
  const due = input.dueDate ?? isoDate(Date.parse(issue) + 14 * DAY);

  return tx(db, () => {
    const entry = postEntry(ctx, {
      userId: user.id, date: issue, memo: `Invoice for ${input.customer}`, sourceType: 'invoice',
      lines: [{ account: '1200', debit: total }, { account: '4000', credit: subtotal }, { account: '2100', credit: vat }],
    });
    const res = db
      .prepare('INSERT INTO invoices (customer, lines, subtotal, vat, total, issue_date, due_date, entry_id, created_by) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(input.customer, JSON.stringify(lines), subtotal, vat, total, issue, due, entry.id, user.id);
    const id = Number(res.lastInsertRowid);
    const number = `INV-${String(id).padStart(4, '0')}`;
    db.prepare('UPDATE invoices SET number = ? WHERE id = ?').run(number, id);
    audit(ctx, { userId: user.id, action: 'invoice.created', type: 'invoice', id, newValue: { number, total } });
    return { id, number, subtotal, vat, total, entryId: entry.id };
  });
}

export function payInvoice(ctx, user, id) {
  requirePerm(user, 'sales.create');
  const { db } = ctx;
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) throw new AppError(404, 'NOT_FOUND', 'Invoice not found');
  if (inv.paid) throw new AppError(409, 'ALREADY_PAID', 'Invoice is already paid');
  return tx(db, () => {
    const entry = postEntry(ctx, {
      userId: user.id, memo: `Payment for ${inv.number}`, sourceType: 'payment', sourceId: id,
      lines: [{ account: '1000', debit: inv.total }, { account: '1200', credit: inv.total }],
    });
    db.prepare('UPDATE invoices SET paid = 1 WHERE id = ?').run(id);
    audit(ctx, { userId: user.id, action: 'invoice.paid', type: 'invoice', id, newValue: { entryId: entry.id } });
    return { id, entryId: entry.id };
  });
}

export function quickSale(ctx, user, input) {
  requirePerm(user, 'sales.create');
  const { db } = ctx;
  if (!Array.isArray(input.items) || input.items.length === 0) throw new AppError(400, 'BAD_INPUT', 'Add at least one item');
  const bySku = db.prepare('SELECT * FROM items WHERE sku = ?');
  const items = input.items.map((i) => {
    const item = bySku.get(i.sku);
    if (!item) throw new AppError(400, 'UNKNOWN_ITEM', `Unknown item ${i.sku}`);
    return { ...item, qty: posInt(i.qty, 'qty') };
  });
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const vat = vatOf(db, subtotal), total = subtotal + vat;

  return tx(db, () => {
    const entry = postEntry(ctx, {
      userId: user.id, memo: 'Quick sale', sourceType: 'sale',
      lines: [{ account: '1000', debit: total }, { account: '4000', credit: subtotal }, { account: '2100', credit: vat }],
    });
    const res = db
      .prepare('INSERT INTO sales (items, subtotal, vat, total, created_by, created_at, entry_id) VALUES (?,?,?,?,?,?,?)')
      .run(JSON.stringify(items.map((i) => ({ sku: i.sku, qty: i.qty, price: i.price }))), subtotal, vat, total, user.id, ctx.now(), entry.id);
    const sale = { id: Number(res.lastInsertRowid), subtotal, vat, total };
    audit(ctx, { userId: user.id, action: 'sale.created', type: 'sale', id: sale.id, newValue: { total } });
    const receipt = eta.queueReceipt(ctx, sale, items);
    return { sale, receipt, entryId: entry.id };
  });
}

export const listInvoices = (ctx, user) => {
  requirePerm(user, 'sales.view');
  return ctx.db.prepare('SELECT id, number, customer, total, issue_date, due_date, paid, created_by FROM invoices ORDER BY id DESC').all();
};

export const listItems = (ctx, user) => {
  requireAny(user, ['sales.view', 'sales.create']);
  return ctx.db.prepare('SELECT sku, name, name_ar, price, eta_code FROM items ORDER BY id').all();
};

// ---------- Purchases: amount limits, auto-approval, approval with separation of duties ----------
function postBill(ctx, bill, approverId) {
  return postEntry(ctx, {
    userId: approverId, memo: `Bill from ${bill.supplier}`, sourceType: 'bill', sourceId: bill.id,
    lines: [{ account: EXPENSE_CODES[bill.category], debit: bill.amount }, { account: '2000', credit: bill.amount }],
  });
}

export function createBill(ctx, user, input) {
  requirePerm(user, 'purchases.create');
  const { db } = ctx;
  const amount = posInt(input.amount, 'amount');
  if (!input.supplier) throw new AppError(400, 'BAD_INPUT', 'Supplier is required');
  if (!EXPENSE_CODES[input.category]) throw new AppError(400, 'BAD_INPUT', `Category must be one of ${Object.keys(EXPENSE_CODES).join(', ')}`);
  if (amount > limitFor(user, 'purchases.create')) {
    throw new AppError(403, 'OVER_LIMIT', `Amount is above your bill-creation limit of ${limitFor(user, 'purchases.create') / 100} EGP`);
  }
  const auto = amount <= Number(setting(db, 'bill_auto_approve'));
  return tx(db, () => {
    const res = db
      .prepare('INSERT INTO bills (supplier, amount, category, status, created_by, created_at) VALUES (?,?,?,?,?,?)')
      .run(input.supplier, amount, input.category, auto ? 'approved' : 'pending_approval', user.id, ctx.now());
    const bill = { id: Number(res.lastInsertRowid), supplier: input.supplier, amount, category: input.category };
    if (auto) {
      const entry = postBill(ctx, bill, user.id);
      db.prepare('UPDATE bills SET entry_id = ? WHERE id = ?').run(entry.id, bill.id);
    }
    audit(ctx, { userId: user.id, action: auto ? 'bill.auto_approved' : 'bill.submitted', type: 'bill', id: bill.id, newValue: { amount } });
    return { id: bill.id, status: auto ? 'approved' : 'pending_approval' };
  });
}

export function approveBill(ctx, user, id) {
  requirePerm(user, 'purchases.approve');
  const { db } = ctx;
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
  if (!bill) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
  if (bill.status !== 'pending_approval') throw new AppError(409, 'NOT_PENDING', 'Bill is not waiting for approval');
  if (bill.created_by === user.id) throw new AppError(403, 'SEPARATION_OF_DUTIES', 'You cannot approve a bill you created');
  if (bill.amount > limitFor(user, 'purchases.approve')) {
    throw new AppError(403, 'OVER_LIMIT', `Bill is above your approval limit of ${limitFor(user, 'purchases.approve') / 100} EGP`);
  }
  return tx(db, () => {
    const entry = postBill(ctx, bill, user.id);
    db.prepare("UPDATE bills SET status = 'approved', approved_by = ?, entry_id = ? WHERE id = ?").run(user.id, entry.id, id);
    audit(ctx, { userId: user.id, action: 'bill.approved', type: 'bill', id, newValue: { entryId: entry.id } });
    return { id, entryId: entry.id };
  });
}

export const listBills = (ctx, user) => {
  requirePerm(user, 'purchases.view');
  return ctx.db.prepare('SELECT * FROM bills ORDER BY id DESC').all();
};

// ---------- Ledger ----------
export function manualEntry(ctx, user, input) {
  requirePerm(user, 'ledger.post');
  return postEntry(ctx, {
    userId: user.id, date: input.date, memo: input.memo, lines: input.lines,
    confirmSoftLock: input.confirmSoftLock, reason: input.reason, sourceType: 'manual',
  });
}

export function reverse(ctx, user, id, reason) {
  requirePerm(user, 'ledger.reverse');
  return reverseEntry(ctx, user.id, id, reason);
}

export function lockPeriod(ctx, user, input) {
  requirePerm(user, 'period.lock');
  return setPeriodLock(ctx, user.id, input.through, input.mode, input.reason);
}

export function entries(ctx, user) {
  requirePerm(user, 'ledger.view');
  return recentEntries(ctx.db, 50);
}

export function reports(ctx, user) {
  requirePerm(user, 'reports.view');
  return { trialBalance: trialBalance(ctx.db), profitAndLoss: profitAndLoss(ctx.db) };
}

export function auditSearch(ctx, user, { q, userId } = {}) {
  requirePerm(user, 'audit.view');
  const rows = ctx.db
    .prepare(`SELECT a.id, a.ts, a.user_id, COALESCE(u.name, 'system') AS user_name, a.action, a.record_type, a.record_id,
                a.old_value, a.new_value, a.reason
              FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 500`)
    .all();
  const needle = (q ?? '').toLowerCase();
  return rows
    .filter((r) => !userId || String(r.user_id) === String(userId))
    .filter((r) => !needle || [r.action, r.user_name, r.record_type, r.new_value, r.reason].some((v) => v && String(v).toLowerCase().includes(needle)))
    .slice(0, 100);
}

// ---------- ETA ----------
export function etaQueue(ctx, user) {
  requireAny(user, ['sales.view', 'sales.create', 'eta.manage']);
  return eta.queueView(ctx);
}
export function etaSync(ctx, user) {
  requireAny(user, ['sales.create', 'eta.manage']);
  return eta.syncQueue(ctx);
}
export function etaSetOnline(ctx, user, online) {
  requirePerm(user, 'eta.manage');
  return eta.setOnline(ctx, user.id, !!online);
}

// ---------- Users and roles ----------
export const demoUsers = (ctx) =>
  ctx.db.prepare('SELECT u.id, u.name, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.id').all();

export function listRoles(ctx, user) {
  requireAny(user, ['roles.manage', 'users.manage']);
  return ctx.db.prepare('SELECT * FROM roles ORDER BY id').all().map((r) => {
    const permissions = JSON.parse(r.permissions);
    return { id: r.id, name: r.name, builtin: !!r.builtin, permissions, limits: JSON.parse(r.limits), sodWarnings: sodConflicts(permissions) };
  });
}

export function createRole(ctx, user, input) {
  requirePerm(user, 'roles.manage');
  const { db } = ctx;
  if (!input.name || !String(input.name).trim()) throw new AppError(400, 'BAD_INPUT', 'Role name is required');
  if (!Array.isArray(input.permissions) || input.permissions.some((p) => !ALL_PERMISSIONS.includes(p))) {
    throw new AppError(400, 'BAD_INPUT', 'Unknown permission in list');
  }
  if (db.prepare('SELECT 1 FROM roles WHERE name = ?').get(input.name)) throw new AppError(409, 'DUPLICATE', 'A role with this name exists');
  const limits = input.limits ?? {};
  return tx(db, () => {
    const res = db.prepare('INSERT INTO roles (name, permissions, limits, builtin) VALUES (?,?,?,0)').run(input.name, JSON.stringify(input.permissions), JSON.stringify(limits));
    const id = Number(res.lastInsertRowid);
    audit(ctx, { userId: user.id, action: 'role.created', type: 'role', id, newValue: { name: input.name, permissions: input.permissions, limits } });
    return { id, sodWarnings: sodConflicts(input.permissions) };
  });
}

export function setUserRole(ctx, user, userId, roleId) {
  requirePerm(user, 'users.manage');
  const { db } = ctx;
  const target = db.prepare('SELECT u.id, u.name, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?').get(userId);
  if (!target) throw new AppError(404, 'NOT_FOUND', 'User not found');
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
  if (!role) throw new AppError(404, 'NOT_FOUND', 'Role not found');
  return tx(db, () => {
    db.prepare('UPDATE users SET role_id = ? WHERE id = ?').run(roleId, userId);
    audit(ctx, { userId: user.id, action: 'user.role_changed', type: 'user', id: userId, oldValue: { role: target.role }, newValue: { role: role.name } });
    return { id: userId, role: role.name, sodWarnings: sodConflicts(JSON.parse(role.permissions)) };
  });
}

// ---------- Export ----------
export function exportAll(ctx, user) {
  requirePerm(user, 'export.all');
  const tables = ['accounts', 'journal_entries', 'journal_lines', 'audit_log', 'invoices', 'bills', 'sales', 'receipts', 'users', 'roles', 'items', 'settings', 'period_lock'];
  const out = { exportedAt: new Date(ctx.now()).toISOString(), format: 'accounting-poc/v1' };
  for (const t of tables) out[t] = ctx.db.prepare(`SELECT * FROM ${t}`).all();
  audit(ctx, { userId: user.id, action: 'data.exported' });
  return out;
}

// ---------- Home: widgets come from permissions, not from hard-coded role names ----------
export function home(ctx, user) {
  const { db } = ctx;
  const has = (p) => user.permissions.has(p);
  const today = isoDate(ctx.now());
  const w = {};

  if (has('banking.view')) w.cash = { balance: accountBalance(db, '1000').net };
  if (has('reports.view')) {
    const open = db.prepare('SELECT total, due_date FROM invoices WHERE paid = 0').all();
    w.receivables = {
      total: open.reduce((s, r) => s + r.total, 0), count: open.length,
      overdue: open.filter((r) => r.due_date < today).length,
      invoices: db.prepare('SELECT id, number, customer, total, due_date FROM invoices WHERE paid = 0 ORDER BY due_date').all(),
    };
    w.payables = { total: -accountBalance(db, '2000').net };
  }
  if (has('purchases.approve')) {
    w.approvals = db.prepare("SELECT id, supplier, amount, category, created_by FROM bills WHERE status = 'pending_approval' ORDER BY id").all()
      .map((b) => ({ ...b, canApprove: b.created_by !== user.id && b.amount <= limitFor(user, 'purchases.approve') }));
  }
  if (has('sales.create')) {
    w.myWork = {
      invoices: db.prepare('SELECT id, number, customer, total, paid FROM invoices WHERE created_by = ? ORDER BY id DESC LIMIT 5').all(user.id),
      bills: db.prepare('SELECT id, supplier, amount, status FROM bills WHERE created_by = ? ORDER BY id DESC LIMIT 5').all(user.id),
    };
  }
  if (has('sales.view')) {
    const start = Date.parse(today);
    const r = db.prepare('SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS n FROM sales WHERE created_at >= ?').get(start);
    w.todaySales = { total: r.total, count: r.n };
  }
  if (has('sales.create') || has('eta.manage')) w.eta = eta.queueView(ctx);
  if (has('ledger.view')) w.ledger = { entries: recentEntries(db, 10), balanced: trialBalance(db).balanced, lock: getPeriodLock(db) };
  if (has('audit.view')) w.audit = auditSearch(ctx, user).slice(0, 10);
  if (has('users.manage') || has('roles.manage')) {
    w.admin = {
      users: demoUsers(ctx),
      roles: listRoles(ctx, user),
      permissions: PERMISSIONS,
    };
  }
  if (!has('ledger.view') && has('period.lock')) w.lock = getPeriodLock(db);

  return {
    user: { id: user.id, name: user.name, role: user.role },
    permissions: [...user.permissions],
    limits: user.limits,
    vatRateBp: Number(setting(db, 'vat_rate_bp')),
    widgets: w,
  };
}

export { loadUser };
