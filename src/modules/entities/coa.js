import { AppError } from '../../errors.js';
import { tx, audit } from '../../ledger.js';
import { requirePerm, requireAny } from '../../permissions.js';

const TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];
const CODE = /^[0-9A-Za-z][0-9A-Za-z.-]{1,11}$/;

// Codes other modules post to by code. They can be renamed but never deactivated or deleted.
export const SYSTEM_CODES = new Set([
  '1000', '1010', '1020', '1200', '1250', '1300', '1400', '1500', '2000', '2100', '2500',
  '3000', '3100', '4000', '4900', '5000', '5100', '5200', '5300', '5900',
]);

const byCode = (db, code) => db.prepare('SELECT * FROM accounts WHERE code = ?').get(String(code));
const hasHistory = (db, id) => !!db.prepare('SELECT 1 FROM journal_lines WHERE account_id = ? LIMIT 1').get(id);

export function listAccounts(ctx, user) {
  requireAny(user, ['coa.manage', 'ledger.view', 'ledger.post']);
  return ctx.db.prepare(`
    SELECT a.id, a.code, a.name, a.name_ar AS nameAr, a.type, a.active, p.code AS parentCode,
           EXISTS (SELECT 1 FROM journal_lines l WHERE l.account_id = a.id) AS hasHistory,
           EXISTS (SELECT 1 FROM accounts c WHERE c.parent_id = a.id) AS hasChildren
    FROM accounts a LEFT JOIN accounts p ON p.id = a.parent_id ORDER BY a.code`).all()
    .map((a) => ({ ...a, active: !!a.active, hasHistory: !!a.hasHistory, hasChildren: !!a.hasChildren, system: SYSTEM_CODES.has(a.code) }));
}

const name = (v, f, req = true) => {
  const s = String(v ?? '').trim();
  if (req && !s) throw new AppError(400, 'BAD_INPUT', `${f} is required`);
  if (s.length > 120) throw new AppError(400, 'BAD_INPUT', `${f} is too long`);
  return s;
};

function parentOf(db, parentCode, type, selfId) {
  if (parentCode == null || parentCode === '') return null;
  const p = byCode(db, parentCode);
  if (!p) throw new AppError(404, 'PARENT_NOT_FOUND', `Parent account ${parentCode} does not exist`);
  if (p.type !== type) throw new AppError(400, 'PARENT_TYPE_MISMATCH', `Parent ${parentCode} is ${p.type}; a child must have the same type (${type})`);
  // cycle check: walk up from the parent; we must never meet the account itself
  for (let cur = p; cur; cur = cur.parent_id ? db.prepare('SELECT * FROM accounts WHERE id = ?').get(cur.parent_id) : null) {
    if (selfId && cur.id === selfId) throw new AppError(400, 'PARENT_CYCLE', 'An account cannot be its own ancestor');
  }
  return p.id;
}

function insertAccount(ctx, userId, a) {
  const { db } = ctx;
  if (!CODE.test(String(a.code ?? ''))) throw new AppError(400, 'BAD_INPUT', 'Account code must be 2-12 letters, digits, "." or "-"');
  if (!TYPES.includes(a.type)) throw new AppError(400, 'BAD_INPUT', `type must be one of ${TYPES.join(', ')}`);
  const nm = name(a.name, 'name'), ar = name(a.nameAr, 'nameAr', false) || nm;
  if (byCode(db, a.code)) throw new AppError(409, 'DUPLICATE', `Account code ${a.code} already exists`);
  const parentId = parentOf(db, a.parentCode, a.type, null);
  const res = db.prepare('INSERT INTO accounts (code, name, name_ar, type, parent_id) VALUES (?,?,?,?,?)').run(String(a.code), nm, ar, a.type, parentId);
  const id = Number(res.lastInsertRowid);
  audit(ctx, { userId, action: 'coa.account_added', type: 'account', id, newValue: { code: a.code, name: nm, nameAr: ar, type: a.type, parent: a.parentCode ?? null } });
  return id;
}

export function addAccount(ctx, user, input = {}) {
  requirePerm(user, 'coa.manage');
  return tx(ctx.db, () => ({ id: insertAccount(ctx, user.id, input), code: String(input.code) }));
}

/** Rename and/or re-parent. The code and the type never change (history would be misread). */
export function updateAccount(ctx, user, code, input = {}) {
  requirePerm(user, 'coa.manage');
  const { db } = ctx;
  const a = byCode(db, code);
  if (!a) throw new AppError(404, 'NOT_FOUND', `Account ${code} not found`);
  const next = {
    name: input.name != null ? name(input.name, 'name') : a.name,
    name_ar: input.nameAr != null ? name(input.nameAr, 'nameAr') : a.name_ar,
    parent_id: 'parentCode' in input ? parentOf(db, input.parentCode, a.type, a.id) : a.parent_id,
    active: a.active,
  };
  if ('active' in input) {
    next.active = input.active ? 1 : 0;
    if (!next.active) {
      if (SYSTEM_CODES.has(a.code)) throw new AppError(409, 'ACCOUNT_PROTECTED', `Account ${a.code} is used by the system and cannot be deactivated`);
      if (db.prepare('SELECT 1 FROM accounts WHERE parent_id = ? AND active = 1').get(a.id)) throw new AppError(409, 'HAS_ACTIVE_CHILDREN', 'Deactivate the child accounts first');
    }
  }
  return tx(db, () => {
    db.prepare('UPDATE accounts SET name = ?, name_ar = ?, parent_id = ?, active = ? WHERE id = ?').run(next.name, next.name_ar, next.parent_id, next.active, a.id);
    audit(ctx, {
      userId: user.id, action: next.active !== a.active ? (next.active ? 'coa.account_activated' : 'coa.account_deactivated') : 'coa.account_updated', type: 'account', id: a.id,
      oldValue: { name: a.name, nameAr: a.name_ar, active: !!a.active }, newValue: { name: next.name, nameAr: next.name_ar, active: !!next.active },
      reason: input.reason ?? null,
    });
    return { code: a.code, active: !!next.active };
  });
}

/** Only a never-used, childless, non-system account may be deleted. Anything with history is deactivated instead. */
export function deleteAccount(ctx, user, code) {
  requirePerm(user, 'coa.manage');
  const { db } = ctx;
  const a = byCode(db, code);
  if (!a) throw new AppError(404, 'NOT_FOUND', `Account ${code} not found`);
  if (SYSTEM_CODES.has(a.code)) throw new AppError(409, 'ACCOUNT_PROTECTED', `Account ${a.code} is used by the system and cannot be deleted`);
  if (hasHistory(db, a.id)) throw new AppError(409, 'ACCOUNT_HAS_HISTORY', `Account ${a.code} has journal history and cannot be deleted; deactivate it instead`);
  if (db.prepare('SELECT 1 FROM accounts WHERE parent_id = ?').get(a.id)) throw new AppError(409, 'HAS_CHILDREN', 'Delete or move the child accounts first');
  return tx(db, () => {
    db.prepare('DELETE FROM accounts WHERE id = ?').run(a.id);
    audit(ctx, { userId: user.id, action: 'coa.account_deleted', type: 'account', id: a.id, oldValue: { code: a.code, name: a.name, type: a.type } });
    return { code: a.code };
  });
}

// ---------- CSV import / starter template ----------
export const CSV_HEADER = 'code,name,name_ar,type,parent_code';

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const csvCell = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);
export const toCsv = (accounts) => [CSV_HEADER, ...accounts.map((a) => [a.code, a.name, a.nameAr, a.type, a.parentCode ?? ''].map(csvCell).join(','))].join('\n') + '\n';

// Egyptian small-business starter chart (names in English and Arabic). UNVERIFIED against the Egyptian Uniform
// Accounting System (النظام المحاسبي الموحد): codes are this app's own, not the official numbering.
// Codes reserved by other modules (1010, 1020, 1300, 1400, 1500, 2500, 3100, 4900, 5300, 5900) are seeded by them.
export const EGYPT_STARTER = [
  ['1100', 'Current assets', 'الأصول المتداولة', 'asset', ''],
  ['1000', 'Cash', 'النقدية', 'asset', '1100'],
  ['1110', 'Cheques under collection', 'شيكات تحت التحصيل', 'asset', '1100'],
  ['1120', 'Employee advances', 'سلف العاملين', 'asset', '1100'],
  ['1130', 'Prepaid expenses', 'مصروفات مدفوعة مقدماً', 'asset', '1100'],
  ['1140', 'Tax authority debit balances', 'مصلحة الضرائب - أرصدة مدينة', 'asset', '1100'],
  ['1600', 'Fixed assets', 'الأصول الثابتة', 'asset', ''],
  ['1610', 'Furniture and fixtures', 'الأثاث والتجهيزات', 'asset', '1600'],
  ['1620', 'Equipment and machinery', 'المعدات والآلات', 'asset', '1600'],
  ['1630', 'Vehicles', 'وسائل النقل', 'asset', '1600'],
  ['1690', 'Accumulated depreciation', 'مجمع الإهلاك', 'asset', '1600'],
  ['2050', 'Notes payable', 'أوراق الدفع', 'liability', ''],
  ['2110', 'Salaries payable', 'مستحقات العاملين', 'liability', ''],
  ['2120', 'Social insurance payable', 'التأمينات الاجتماعية المستحقة', 'liability', ''],
  ['2130', 'Withholding tax payable', 'ضريبة الخصم والإضافة المستحقة', 'liability', ''],
  ['2140', 'Income tax payable', 'ضريبة الدخل المستحقة', 'liability', ''],
  ['2200', 'Customer deposits', 'دفعات مقدمة من العملاء', 'liability', ''],
  ['2300', 'Loans payable', 'القروض', 'liability', ''],
  ['3200', 'Owner drawings', 'مسحوبات المالك', 'equity', ''],
  ['4100', 'Service revenue', 'إيرادات الخدمات', 'revenue', ''],
  ['4200', 'Other income', 'إيرادات أخرى', 'revenue', ''],
  ['4300', 'Sales returns and discounts', 'مردودات ومسموحات المبيعات', 'revenue', ''],
  ['5400', 'Salaries and wages', 'الرواتب والأجور', 'expense', ''],
  ['5410', 'Social insurance expense', 'مصروف التأمينات الاجتماعية', 'expense', '5400'],
  ['5500', 'Telephone and internet', 'الاتصالات والإنترنت', 'expense', ''],
  ['5510', 'Transport and travel', 'النقل والانتقالات', 'expense', ''],
  ['5520', 'Marketing and advertising', 'الدعاية والإعلان', 'expense', ''],
  ['5530', 'Repairs and maintenance', 'الإصلاح والصيانة', 'expense', ''],
  ['5540', 'Bank charges', 'مصاريف بنكية', 'expense', ''],
  ['5550', 'Professional fees', 'أتعاب مهنية', 'expense', ''],
  ['5560', 'Office supplies', 'أدوات مكتبية', 'expense', ''],
  ['5570', 'Depreciation expense', 'مصروف الإهلاك', 'expense', ''],
  ['5580', 'Government fees and licences', 'رسوم حكومية وتراخيص', 'expense', ''],
  ['5590', 'Insurance', 'التأمين', 'expense', ''],
  ['5600', 'Taxes and stamp duties', 'ضرائب ودمغات', 'expense', ''],
].map(([code, nm, nameAr, type, parentCode]) => ({ code, name: nm, nameAr, type, parentCode }));

export function starterTemplate(ctx, user) {
  requireAny(user, ['coa.manage', 'ledger.view']);
  return { name: 'egypt-small-business', accounts: EGYPT_STARTER, csv: toCsv(EGYPT_STARTER) };
}

/** Import rows [{code,name,nameAr,type,parentCode}]. All-or-nothing: one invalid row rejects the whole import. */
function importRows(ctx, user, rows, { dryRun = false } = {}) {
  const { db } = ctx;
  const errors = [], created = [], skipped = [];
  const run = () => {
    const pending = [];
    rows.forEach((r, i) => {
      const line = r.line ?? i + 1;
      if (!CODE.test(String(r.code ?? ''))) return errors.push({ line, error: `bad code "${r.code ?? ''}"` });
      if (!TYPES.includes(r.type)) return errors.push({ line, error: `bad type "${r.type ?? ''}"` });
      if (!String(r.name ?? '').trim()) return errors.push({ line, error: 'name is required' });
      if (byCode(db, r.code)) return skipped.push(r.code);
      if (pending.some((p) => p.code === r.code)) return errors.push({ line, error: `duplicate code ${r.code} in the file` });
      pending.push(r);
    });
    // Insert parents before children, whatever the file order.
    let left = pending;
    while (left.length && !errors.length) {
      const next = [];
      for (const r of left) {
        const pc = r.parentCode || '';
        if (pc && !byCode(db, pc)) { next.push(r); continue; }
        try { insertAccount(ctx, user.id, r); created.push(r.code); } catch (e) { errors.push({ line: r.line, error: e.message }); }
      }
      if (next.length === left.length) { next.forEach((r) => errors.push({ line: r.line, error: `parent ${r.parentCode} not found` })); break; }
      left = next;
    }
    if (errors.length) throw new AppError(400, 'IMPORT_INVALID', `Import rejected, nothing was changed: ${errors.slice(0, 5).map((e) => `line ${e.line}: ${e.error}`).join('; ')}`, { errors });
    if (dryRun) throw Object.assign(new Error('dry-run'), { dry: true });
    audit(ctx, { userId: user.id, action: 'coa.imported', type: 'account', newValue: { created, skipped } });
  };
  try { tx(db, run); } catch (e) { if (!e.dry) throw e; return { dryRun: true, created: [...created], skipped, errors: [] }; }
  return { dryRun: false, created, skipped, errors: [] };
}

export function importCsv(ctx, user, input = {}) {
  requirePerm(user, 'coa.manage');
  const table = parseCsv(input.csv);
  if (!table.length) throw new AppError(400, 'IMPORT_INVALID', 'The CSV is empty');
  const head = table[0].map((h) => h.trim().toLowerCase());
  const col = (n) => head.indexOf(n);
  for (const need of ['code', 'name', 'type']) if (col(need) < 0) throw new AppError(400, 'IMPORT_INVALID', `The CSV needs a "${need}" column (header: ${CSV_HEADER})`);
  const rows = table.slice(1).map((c, i) => ({
    line: i + 2, code: (c[col('code')] ?? '').trim(), name: (c[col('name')] ?? '').trim(), nameAr: (c[col('name_ar')] ?? '').trim(),
    type: (c[col('type')] ?? '').trim().toLowerCase(), parentCode: (c[col('parent_code')] ?? '').trim(),
  }));
  if (rows.length > 2000) throw new AppError(400, 'IMPORT_INVALID', 'At most 2000 accounts per import');
  return importRows(ctx, user, rows, { dryRun: !!input.dryRun });
}

export function applyStarterTemplate(ctx, user, input = {}) {
  requirePerm(user, 'coa.manage');
  return importRows(ctx, user, EGYPT_STARTER.map((a, i) => ({ ...a, line: i + 1 })), { dryRun: !!input.dryRun });
}
