import { AppError } from '../../errors.js';
import { postEntry, reverseEntry, tx, audit, isoDate } from '../../ledger.js';
import { requirePerm } from '../../permissions.js';
import { emit } from '../../hooks.js';
import { mapStatement, inspectCsv, normalizeDigits, normalizeMethod, METHODS } from './csv.js';

// ---------------------------------------------------------------------------------------------
// Banking: accounts, CSV statement import (preview -> commit -> rollback), rules, matching engine,
// reconciliation. Live bank feeds are NOT implemented (availability in Egypt is unverified).
// Statement lines and matches are never deleted: rollback/unreconcile mark rows void/undone and
// every ledger correction is a reversal.
// ---------------------------------------------------------------------------------------------

const MAX_CSV_CHARS = 900_000;
const MAX_ROWS = 20_000;
const BASE_CODES = { bank: '1010', wallet: '1020', cash: '1000' };
const BASE_NAMES = { '1010': ['Bank accounts', 'الحسابات البنكية'], '1020': ['Mobile wallets', 'المحافظ الإلكترونية'] };
const REC_ONLY = 'banking.reconcile';

const bad = (code, msg, status = 400) => new AppError(status, code, msg);
const str = (v, field, { max = 200, required = false } = {}) => {
  const s = v == null ? '' : String(v).trim();
  if (required && !s) throw bad('BAD_INPUT', `${field} is required`);
  if (s.length > max) throw bad('BAD_INPUT', `${field} is too long (max ${max})`);
  return s;
};
const intId = (v, field) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad('BAD_INPUT', `${field} must be a positive whole number`);
  return n;
};
const optPiastres = (v, field) => {
  if (v == null || v === '') return null;
  if (!Number.isInteger(v) || v < 0) throw bad('BAD_INPUT', `${field} must be a whole number of piastres, zero or more`);
  return v;
};
const dateStr = (v, field) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) || Number.isNaN(Date.parse(v))) throw bad('BAD_DATE', `${field} must be YYYY-MM-DD`);
  return v;
};
const j = (v) => (v == null ? null : JSON.stringify(v));
const parse = (s, fallback = null) => { try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; } };

// ---------- ledger accounts ----------
export function ensureLedgerAccounts(db) {
  const ins = db.prepare('INSERT OR IGNORE INTO accounts (code, name, name_ar, type) VALUES (?,?,?,?)');
  for (const [code, [en, ar]] of Object.entries(BASE_NAMES)) ins.run(code, en, ar, 'asset');
}
const ledgerAccount = (db, code) => db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);

// ---------- bank accounts ----------
const accountOut = (a) => ({ id: a.id, name: a.name, type: a.type, ledgerCode: a.ledger_code, accountNumber: a.account_number, currency: a.currency,
  openingBalance: a.opening_balance, mapping: parse(a.mapping), active: !!a.active });

function getAccount(db, id) {
  const a = db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(intId(id, 'accountId'));
  if (!a) throw bad('NOT_FOUND', 'Bank account not found', 404);
  return a;
}

export function listAccounts(ctx, user) {
  requirePerm(user, 'banking.view');
  return ctx.db.prepare('SELECT * FROM bank_accounts ORDER BY id').all().map(accountOut);
}

function validateMappingShape(m) {
  if (m == null) return null;
  if (typeof m !== 'object' || Array.isArray(m)) throw bad('BAD_MAPPING', 'mapping must be an object');
  return m;
}

export function createAccount(ctx, user, input = {}) {
  requirePerm(user, 'banking.import');
  const { db } = ctx;
  const name = str(input.name, 'name', { required: true, max: 80 });
  if (!BASE_CODES[input.type]) throw bad('BAD_INPUT', 'type must be bank, cash or wallet');
  const opening = input.openingBalance == null ? 0 : input.openingBalance;
  if (!Number.isInteger(opening)) throw bad('BAD_INPUT', 'openingBalance must be a whole number of piastres');
  return tx(db, () => {
    ensureLedgerAccounts(db);
    let code = input.ledgerCode ? String(input.ledgerCode) : null;
    const taken = (c) => db.prepare('SELECT 1 FROM bank_accounts WHERE ledger_code = ? AND active = 1').get(c);
    if (code) {
      const a = ledgerAccount(db, code);
      if (!a) throw bad('UNKNOWN_ACCOUNT', `Unknown ledger account ${code}`);
      if (a.type !== 'asset') throw bad('BAD_INPUT', 'A bank, cash or wallet account must be linked to an asset ledger account');
      if (taken(code)) throw bad('LEDGER_ACCOUNT_IN_USE', `Ledger account ${code} is already linked to another bank account`, 409);
    } else {
      const base = BASE_CODES[input.type];
      if (!ledgerAccount(db, base)) throw bad('UNKNOWN_ACCOUNT', `Ledger account ${base} does not exist`);
      if (!taken(base)) code = base;
      else {
        // One ledger account per bank account keeps each balance exact: further accounts get a sub-account of the base code.
        for (let n = 2; ; n++) {
          const c = `${base}-${n}`;
          if (!ledgerAccount(db, c)) {
            const b = ledgerAccount(db, base);
            db.prepare('INSERT INTO accounts (code, name, name_ar, type) VALUES (?,?,?,?)').run(c, `${b.name} - ${name}`, `${b.name_ar} - ${name}`, 'asset');
            code = c;
            break;
          }
          if (!taken(c)) { code = c; break; }
        }
      }
    }
    const res = db.prepare('INSERT INTO bank_accounts (name, type, ledger_code, account_number, currency, opening_balance, mapping, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(name, input.type, code, str(input.accountNumber, 'accountNumber', { max: 40 }) || null, 'EGP', opening, j(validateMappingShape(input.mapping)), user.id, ctx.now());
    const id = Number(res.lastInsertRowid);
    audit(ctx, { userId: user.id, action: 'banking.account_created', type: 'bank_account', id, newValue: { name, type: input.type, ledgerCode: code } });
    return accountOut(getAccount(db, id));
  });
}

export function updateAccount(ctx, user, id, input = {}) {
  requirePerm(user, 'banking.import');
  const { db } = ctx;
  const a = getAccount(db, id);
  const next = { name: a.name, account_number: a.account_number, opening_balance: a.opening_balance, mapping: a.mapping, active: a.active };
  if (input.name !== undefined) next.name = str(input.name, 'name', { required: true, max: 80 });
  if (input.accountNumber !== undefined) next.account_number = str(input.accountNumber, 'accountNumber', { max: 40 }) || null;
  if (input.openingBalance !== undefined) {
    if (!Number.isInteger(input.openingBalance)) throw bad('BAD_INPUT', 'openingBalance must be a whole number of piastres');
    next.opening_balance = input.openingBalance;
  }
  if (input.mapping !== undefined) next.mapping = j(validateMappingShape(input.mapping));
  if (input.active !== undefined) next.active = input.active ? 1 : 0;
  return tx(db, () => {
    db.prepare('UPDATE bank_accounts SET name=?, account_number=?, opening_balance=?, mapping=?, active=? WHERE id=?')
      .run(next.name, next.account_number, next.opening_balance, next.mapping, next.active, id);
    audit(ctx, { userId: user.id, action: 'banking.account_updated', type: 'bank_account', id, oldValue: accountOut(a), newValue: accountOut(getAccount(db, id)) });
    return accountOut(getAccount(db, id));
  });
}

// ---------- CSV import: preview -> commit -> rollback ----------
export function inspectFile(ctx, user, input = {}) {
  requirePerm(user, 'banking.import');
  const csv = String(input.csv ?? '');
  if (!csv.trim()) throw bad('BAD_INPUT', 'csv is required');
  if (csv.length > MAX_CSV_CHARS) throw bad('TOO_LARGE', 'CSV is too large (max about 900 KB per import; split the file)');
  try { return inspectCsv(csv); } catch (e) { throw bad('BAD_CSV', e.message); }
}

const batchOut = (b) => ({ id: b.id, accountId: b.account_id, filename: b.filename, status: b.status, mapping: parse(b.mapping), totalRows: b.total_rows,
  goodRows: b.good_rows, duplicateRows: b.duplicate_rows, errorRows: b.error_rows, errors: parse(b.errors, []), createdBy: b.created_by, createdAt: b.created_at,
  committedAt: b.committed_at, rolledBackAt: b.rolled_back_at, rollbackReason: b.rollback_reason });
const lineOut = (l) => ({ id: l.id, batchId: l.batch_id, accountId: l.account_id, row: l.row_no, date: l.txn_date, description: l.description, reference: l.reference,
  amount: l.amount, balance: l.balance, status: l.status, method: l.method, reconState: l.recon_state });

function getBatch(db, id) {
  const b = db.prepare('SELECT * FROM bank_batches WHERE id = ?').get(intId(id, 'batch id'));
  if (!b) throw bad('NOT_FOUND', 'Import batch not found', 404);
  return b;
}

/** Parse a CSV and stage it as a 'preview' batch. Nothing is visible to reconciliation until commit. */
export function createImport(ctx, user, input = {}) {
  requirePerm(user, 'banking.import');
  const { db } = ctx;
  const account = getAccount(db, input.accountId);
  if (!account.active) throw bad('ACCOUNT_INACTIVE', 'This bank account is inactive', 409);
  const csv = String(input.csv ?? '');
  if (!csv.trim()) throw bad('BAD_INPUT', 'csv is required');
  if (csv.length > MAX_CSV_CHARS) throw bad('TOO_LARGE', 'CSV is too large (max about 900 KB per import; split the file)');
  const mapping = validateMappingShape(input.mapping) ?? parse(account.mapping);
  if (!mapping) throw bad('BAD_MAPPING', 'A column mapping is required (send mapping, or save one on the account)');
  let parsed;
  try { parsed = mapStatement(csv, mapping, account.id); } catch (e) { throw bad('BAD_MAPPING', e.message); }
  if (parsed.totalRows > MAX_ROWS) throw bad('TOO_MANY_ROWS', `Too many rows (max ${MAX_ROWS}); split the file`);

  return tx(db, () => {
    const existing = db.prepare("SELECT 1 FROM bank_lines WHERE account_id = ? AND row_hash = ? AND status = 'active'");
    const dupes = parsed.lines.filter((l) => existing.get(account.id, l.hash)).length;
    const res = db.prepare(`INSERT INTO bank_batches (account_id, filename, status, mapping, total_rows, good_rows, duplicate_rows, error_rows, errors, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(account.id, str(input.filename, 'filename', { max: 200 }) || null, 'preview', JSON.stringify(mapping), parsed.totalRows,
      parsed.lines.length - dupes, dupes, parsed.errors.length, JSON.stringify(parsed.errors.slice(0, 500)), user.id, ctx.now());
    const batchId = Number(res.lastInsertRowid);
    const ins = db.prepare(`INSERT INTO bank_lines (batch_id, account_id, row_no, txn_date, description, reference, amount, balance, row_hash, status, method)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const l of parsed.lines) {
      ins.run(batchId, account.id, l.row, l.date, l.description, l.reference, l.amount, l.balance, l.hash, existing.get(account.id, l.hash) ? 'duplicate' : 'staged', l.method);
    }
    if (input.saveMapping) db.prepare('UPDATE bank_accounts SET mapping = ? WHERE id = ?').run(JSON.stringify(mapping), account.id);
    audit(ctx, { userId: user.id, action: 'banking.import_previewed', type: 'bank_batch', id: batchId,
      newValue: { accountId: account.id, rows: parsed.totalRows, good: parsed.lines.length - dupes, duplicates: dupes, errors: parsed.errors.length } });
    return getImport(ctx, user, batchId);
  });
}

export function listImports(ctx, user, query = {}) {
  requirePerm(user, 'banking.view');
  const rows = query.accountId
    ? ctx.db.prepare('SELECT * FROM bank_batches WHERE account_id = ? ORDER BY id DESC LIMIT 100').all(intId(query.accountId, 'accountId'))
    : ctx.db.prepare('SELECT * FROM bank_batches ORDER BY id DESC LIMIT 100').all();
  return rows.map(batchOut);
}

export function getImport(ctx, user, id, { limit = 100 } = {}) {
  requirePerm(user, 'banking.view');
  const b = getBatch(ctx.db, id);
  const lines = ctx.db.prepare('SELECT * FROM bank_lines WHERE batch_id = ? ORDER BY row_no LIMIT ?').all(b.id, Math.min(Number(limit) || 100, 500)).map(lineOut);
  return { ...batchOut(b), lines };
}

// When the statement carries a running balance and the account has no lines yet, derive the opening balance
// from the chronologically first row (only if that row is unambiguous: a unique earliest date).
function openingFromBalance(db, account, batchId) {
  if (account.opening_balance !== 0) return null;
  if (db.prepare("SELECT 1 FROM bank_lines WHERE account_id = ? AND status = 'active' AND batch_id <> ?").get(account.id, batchId)) return null;
  const rows = db.prepare("SELECT txn_date, amount, balance FROM bank_lines WHERE batch_id = ? AND status = 'active' ORDER BY txn_date LIMIT 2").all(batchId);
  if (!rows.length || rows[0].balance == null || (rows[1] && rows[1].txn_date === rows[0].txn_date)) return null;
  return rows[0].balance - rows[0].amount;
}

export function commitImport(ctx, user, id, input = {}) {
  requirePerm(user, 'banking.import');
  const { db } = ctx;
  const b = getBatch(db, id);
  if (b.status !== 'preview') throw bad('BAD_STATE', `Batch is already ${b.status}`, 409);
  if (b.error_rows > 0 && !input.skipErrors) {
    throw bad('HAS_ERRORS', `${b.error_rows} row(s) could not be read; fix the file, or commit with skipErrors to import only the good rows`, 409);
  }
  return tx(db, () => {
    const account = getAccount(db, b.account_id);
    const exists = db.prepare("SELECT 1 FROM bank_lines WHERE account_id = ? AND row_hash = ? AND status = 'active'");
    const staged = db.prepare("SELECT id, row_hash FROM bank_lines WHERE batch_id = ? AND status IN ('staged','duplicate') ORDER BY row_no").all(b.id);
    const setStatus = db.prepare('UPDATE bank_lines SET status = ? WHERE id = ?');
    let good = 0, dup = 0;
    for (const l of staged) {
      // re-check at commit: another batch may have been committed since the preview
      if (exists.get(account.id, l.row_hash)) { setStatus.run('duplicate', l.id); dup++; } else { setStatus.run('active', l.id); good++; }
    }
    if (good === 0) throw bad('NOTHING_TO_COMMIT', 'No new rows to import (all rows are duplicates or unreadable)', 409);
    const opening = openingFromBalance(db, account, b.id);
    if (opening != null) db.prepare('UPDATE bank_accounts SET opening_balance = ? WHERE id = ?').run(opening, account.id);
    db.prepare("UPDATE bank_batches SET status='committed', good_rows=?, duplicate_rows=?, committed_by=?, committed_at=? WHERE id=?").run(good, dup, user.id, ctx.now(), b.id);
    audit(ctx, { userId: user.id, action: 'banking.import_committed', type: 'bank_batch', id: b.id, newValue: { added: good, duplicates: dup, skippedErrors: b.error_rows, openingBalance: opening } });
    emit(ctx, 'banking.imported', { batchId: b.id, accountId: account.id, added: good, duplicates: dup, userId: user.id });
    return getImport(ctx, user, b.id);
  });
}

/** Roll back a batch: its lines are marked void (never deleted). Refused while any line is reconciled. */
export function rollbackImport(ctx, user, id, input = {}) {
  requirePerm(user, 'banking.import');
  const { db } = ctx;
  const b = getBatch(db, id);
  const reason = str(input.reason, 'reason', { required: true });
  if (b.status === 'rolled_back') throw bad('BAD_STATE', 'Batch is already rolled back', 409);
  return tx(db, () => {
    const blocked = db.prepare("SELECT COUNT(*) AS n FROM bank_lines WHERE batch_id = ? AND recon_state = 'reconciled' AND status = 'active'").get(b.id).n;
    if (blocked) throw bad('ROLLBACK_BLOCKED', `${blocked} line(s) in this batch are reconciled; unreconcile them first`, 409);
    const res = db.prepare("UPDATE bank_lines SET status = 'void' WHERE batch_id = ? AND status <> 'void'").run(b.id);
    db.prepare("UPDATE bank_batches SET status='rolled_back', rolled_back_by=?, rolled_back_at=?, rollback_reason=? WHERE id=?").run(user.id, ctx.now(), reason, b.id);
    audit(ctx, { userId: user.id, action: 'banking.import_rolled_back', type: 'bank_batch', id: b.id, oldValue: { status: b.status }, newValue: { voided: Number(res.changes) }, reason });
    return getImport(ctx, user, b.id);
  });
}

// ---------- statement lines ----------
function getLine(db, id) {
  const l = db.prepare('SELECT * FROM bank_lines WHERE id = ?').get(intId(id, 'line id'));
  if (!l) throw bad('NOT_FOUND', 'Statement line not found', 404);
  return l;
}
function activeLine(db, id) {
  const l = getLine(db, id);
  if (l.status !== 'active') throw bad('LINE_NOT_ACTIVE', `Line is ${l.status}`, 409);
  return l;
}

export function listLines(ctx, user, query = {}) {
  requirePerm(user, 'banking.view');
  const where = [], args = [];
  if (query.accountId) { where.push('l.account_id = ?'); args.push(intId(query.accountId, 'accountId')); }
  if (query.batchId) { where.push('l.batch_id = ?'); args.push(intId(query.batchId, 'batchId')); } else where.push("l.status = 'active'");
  const state = query.state ?? 'unreconciled';
  if (state === 'unreconciled' || state === 'reconciled') { where.push('l.recon_state = ?'); args.push(state); }
  else if (state !== 'all') throw bad('BAD_INPUT', 'state must be unreconciled, reconciled or all');
  if (query.method) { where.push('l.method = ?'); args.push(String(query.method)); }
  const limit = Math.min(Number(query.limit) || 100, 500), offset = Math.max(Number(query.offset) || 0, 0);
  const rows = ctx.db.prepare(`SELECT l.*, m.kind AS match_kind, m.confidence AS match_confidence, m.entry_id AS match_entry
    FROM bank_lines l LEFT JOIN bank_matches m ON m.line_id = l.id AND m.status = 'accepted'
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.txn_date DESC, l.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  return rows.map((r) => ({ ...lineOut(r), matchKind: r.match_kind, matchConfidence: r.match_confidence, matchEntryId: r.match_entry }));
}

export function setMethod(ctx, user, lineId, input = {}) {
  requirePerm(user, REC_ONLY);
  const { db } = ctx;
  const l = getLine(db, lineId);
  let method = input.method == null || input.method === '' ? null : String(input.method);
  if (method !== null && !METHODS.includes(method)) throw bad('BAD_METHOD', `method must be one of ${METHODS.join(', ')}`);
  return tx(db, () => {
    db.prepare('UPDATE bank_lines SET method = ? WHERE id = ?').run(method, l.id);
    audit(ctx, { userId: user.id, action: 'banking.method_tagged', type: 'bank_line', id: l.id, oldValue: { method: l.method }, newValue: { method } });
    return lineOut(getLine(db, l.id));
  });
}

// ---------- rules ----------
const RULE_DIRECTIONS = ['in', 'out', 'any'];
const ruleOut = (r) => ({ id: r.id, name: r.name, priority: r.priority, matchType: r.match_type, pattern: r.pattern, direction: r.direction,
  minAmount: r.min_amount, maxAmount: r.max_amount, accountCode: r.account_code, memo: r.memo, method: r.method, active: !!r.active });

// Heuristic ReDoS guard (a quantified group containing a quantifier, e.g. (a+)+); patterns are also length-limited.
const NESTED_QUANT = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/;

function normalizeRule(db, input, base = {}) {
  const r = {
    name: str(input.name ?? base.name, 'name', { required: true, max: 80 }),
    priority: input.priority ?? base.priority ?? 100,
    matchType: input.matchType ?? base.matchType ?? 'contains',
    pattern: str(input.pattern ?? base.pattern, 'pattern', { required: true, max: 200 }),
    direction: input.direction ?? base.direction ?? 'any',
    minAmount: input.minAmount !== undefined ? optPiastres(input.minAmount, 'minAmount') : base.minAmount ?? null,
    maxAmount: input.maxAmount !== undefined ? optPiastres(input.maxAmount, 'maxAmount') : base.maxAmount ?? null,
    accountCode: str(input.accountCode ?? base.accountCode, 'accountCode', { required: true, max: 20 }),
    memo: str(input.memo ?? base.memo, 'memo', { max: 200 }),
    method: input.method !== undefined ? (input.method || null) : base.method ?? null,
  };
  if (!Number.isInteger(r.priority) || r.priority < 0 || r.priority > 100000) throw bad('BAD_INPUT', 'priority must be a whole number 0..100000 (lower runs first)');
  if (!['contains', 'regex'].includes(r.matchType)) throw bad('BAD_INPUT', 'matchType must be contains or regex');
  if (!RULE_DIRECTIONS.includes(r.direction)) throw bad('BAD_INPUT', 'direction must be in, out or any');
  if (r.minAmount != null && r.maxAmount != null && r.minAmount > r.maxAmount) throw bad('BAD_INPUT', 'minAmount cannot be above maxAmount');
  if (r.method != null && !METHODS.includes(r.method)) throw bad('BAD_METHOD', `method must be one of ${METHODS.join(', ')}`);
  if (r.matchType === 'regex') {
    if (NESTED_QUANT.test(r.pattern)) throw bad('BAD_REGEX', 'This regular expression has nested repetition, which can hang the server; simplify it');
    try { new RegExp(r.pattern, 'iu'); } catch (e) { throw bad('BAD_REGEX', `Invalid regular expression: ${e.message}`); }
  }
  if (!ledgerAccount(db, r.accountCode)) throw bad('UNKNOWN_ACCOUNT', `Unknown ledger account ${r.accountCode}`);
  return r;
}

const lowered = (s) => normalizeDigits(s).toLowerCase();

/** Does a rule (API shape) match a line-like { description, reference, amount }? Returns reasons[] or null. */
export function ruleMatches(rule, line) {
  const text = lowered(`${line.description ?? ''} ${line.reference ?? ''}`).slice(0, 600);
  const abs = Math.abs(line.amount);
  if (rule.direction === 'in' && line.amount <= 0) return null;
  if (rule.direction === 'out' && line.amount >= 0) return null;
  if (rule.minAmount != null && abs < rule.minAmount) return null;
  if (rule.maxAmount != null && abs > rule.maxAmount) return null;
  const reasons = [];
  if (rule.matchType === 'contains') {
    if (!text.includes(lowered(rule.pattern))) return null;
    reasons.push(`Text contains "${rule.pattern}"`);
  } else {
    let re;
    try { re = new RegExp(rule.pattern, 'iu'); } catch { return null; }
    if (!re.test(text)) return null;
    reasons.push(`Text matches /${rule.pattern}/`);
  }
  if (rule.minAmount != null || rule.maxAmount != null) reasons.push('Amount is in range');
  return reasons;
}

const activeRules = (db) => db.prepare('SELECT * FROM bank_rules WHERE active = 1 ORDER BY priority, id').all().map(ruleOut);
const firstRuleFor = (db, line) => {
  for (const r of activeRules(db)) { const reasons = ruleMatches(r, line); if (reasons) return { rule: r, reasons }; }
  return null;
};

export function listRules(ctx, user) {
  requirePerm(user, 'banking.view');
  return ctx.db.prepare('SELECT * FROM bank_rules ORDER BY active DESC, priority, id').all().map(ruleOut);
}

export function createRule(ctx, user, input = {}) {
  requirePerm(user, 'banking.rules');
  const { db } = ctx;
  const r = normalizeRule(db, input);
  return tx(db, () => {
    const res = db.prepare(`INSERT INTO bank_rules (name, priority, match_type, pattern, direction, min_amount, max_amount, account_code, memo, method, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(r.name, r.priority, r.matchType, r.pattern, r.direction, r.minAmount, r.maxAmount, r.accountCode, r.memo, r.method, user.id, ctx.now());
    const id = Number(res.lastInsertRowid);
    audit(ctx, { userId: user.id, action: 'banking.rule_created', type: 'bank_rule', id, newValue: r });
    return ruleOut(db.prepare('SELECT * FROM bank_rules WHERE id = ?').get(id));
  });
}

export function updateRule(ctx, user, id, input = {}) {
  requirePerm(user, 'banking.rules');
  const { db } = ctx;
  const row = db.prepare('SELECT * FROM bank_rules WHERE id = ?').get(intId(id, 'rule id'));
  if (!row) throw bad('NOT_FOUND', 'Rule not found', 404);
  const old = ruleOut(row);
  const r = normalizeRule(db, input, old);
  const active = input.active === undefined ? row.active : input.active ? 1 : 0;
  return tx(db, () => {
    db.prepare(`UPDATE bank_rules SET name=?, priority=?, match_type=?, pattern=?, direction=?, min_amount=?, max_amount=?, account_code=?, memo=?, method=?, active=? WHERE id=?`)
      .run(r.name, r.priority, r.matchType, r.pattern, r.direction, r.minAmount, r.maxAmount, r.accountCode, r.memo, r.method, active, row.id);
    const next = ruleOut(db.prepare('SELECT * FROM bank_rules WHERE id = ?').get(row.id));
    audit(ctx, { userId: user.id, action: 'banking.rule_updated', type: 'bank_rule', id: row.id, oldValue: old, newValue: next });
    return next;
  });
}

/** Rules are configuration, not ledger data: "delete" archives (active = 0) so the audit trail stays meaningful. */
export function archiveRule(ctx, user, id) {
  return updateRule(ctx, user, id, { active: false });
}

/** Test a rule without saving it: against a sample and/or the active statement lines. */
export function testRule(ctx, user, input = {}) {
  requirePerm(user, 'banking.rules');
  const { db } = ctx;
  let rule;
  if (input.ruleId) {
    const row = db.prepare('SELECT * FROM bank_rules WHERE id = ?').get(intId(input.ruleId, 'ruleId'));
    if (!row) throw bad('NOT_FOUND', 'Rule not found', 404);
    rule = ruleOut(row);
  } else rule = { ...normalizeRule(db, input.rule ?? {}) };
  const out = { rule };
  if (input.sample) {
    const s = { description: str(input.sample.description, 'sample.description', { max: 500 }), reference: str(input.sample.reference, 'sample.reference', { max: 200 }), amount: input.sample.amount };
    if (!Number.isInteger(s.amount)) throw bad('BAD_INPUT', 'sample.amount must be a whole number of piastres (negative = money out)');
    const reasons = ruleMatches(rule, s);
    out.sample = { matches: !!reasons, reasons: reasons ?? [] };
  }
  const args = [];
  let sql = "SELECT * FROM bank_lines WHERE status = 'active'";
  if (input.accountId) { sql += ' AND account_id = ?'; args.push(intId(input.accountId, 'accountId')); }
  const hits = [];
  let count = 0;
  for (const l of db.prepare(sql + ' ORDER BY txn_date DESC, id DESC LIMIT 2000').all(...args)) {
    if (ruleMatches(rule, { description: l.description, reference: l.reference, amount: l.amount })) { count++; if (hits.length < 25) hits.push(lineOut(l)); }
  }
  out.matchCount = count;
  out.matches = hits;
  return out;
}

// ---------- matching engine ----------
const STOP = new Set(['ltd', 'llc', 'co', 'inc', 'company', 'the', 'and', 'for', 'from', 'payment', 'transfer', 'pay', 'شركة', 'مؤسسة', 'ال']);
const arNorm = (s) => s.replace(/[ً-ٟـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
export function tokens(s) {
  return arNorm(normalizeDigits(s).toLowerCase()).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2 && !STOP.has(t));
}
function nameReason(name, text, textTokens, label) {
  const nt = tokens(name);
  if (!nt.length) return null;
  const hit = nt.filter((t) => textTokens.has(t) || (t.length >= 4 && arNorm(text).includes(t))).length;
  const frac = hit / nt.length;
  if (frac === 1) return { score: 25, reason: `${label} name "${name}" appears in the description` };
  if (frac >= 0.5) return { score: 12, reason: `Part of the ${label.toLowerCase()} name "${name}" appears in the description` };
  return null;
}
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const label = (c) => (c >= 80 ? 'high' : c >= 60 ? 'medium' : 'low');

/** Ledger lines on the bank's ledger account that no statement line accounts for yet (reversal pairs that never hit the bank are excluded). */
export function unreconciledLedger(db, ledgerCode, asOf = null) {
  const rows = db.prepare(`SELECT jl.id, jl.entry_id, je.entry_date, je.memo, je.reverses_id, jl.debit - jl.credit AS amount,
      (SELECT r.id FROM journal_entries r WHERE r.reverses_id = je.id) AS reversed_by
    FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id JOIN journal_entries je ON je.id = jl.entry_id
    WHERE a.code = ? ${asOf ? 'AND je.entry_date <= ?' : ''} ORDER BY je.entry_date, jl.id`).all(...(asOf ? [ledgerCode, asOf] : [ledgerCode]));
  const matched = new Set(db.prepare("SELECT ledger_line_id AS id FROM bank_matches WHERE status = 'accepted' AND ledger_line_id IS NOT NULL").all().map((r) => r.id));
  const entryMatched = new Set(rows.filter((r) => matched.has(r.id)).map((r) => r.entry_id));
  return rows.filter((r) => {
    if (matched.has(r.id)) return false;
    if (r.reversed_by && !entryMatched.has(r.entry_id)) return false;           // original, reversed, never matched
    if (r.reverses_id && !entryMatched.has(r.reverses_id)) return false;        // its reversal
    return true;
  }).map((r) => ({ journalLineId: r.id, entryId: r.entry_id, date: r.entry_date, memo: r.memo, amount: r.amount }));
}

function rejectedSet(db, lineId) {
  return new Set(db.prepare("SELECT kind || ':' || COALESCE(ref_id, 0) AS k FROM bank_matches WHERE line_id = ? AND status = 'rejected'").all(lineId).map((r) => r.k));
}

/** Suggested matches for one statement line, best first, each with a 0-100 confidence and human-readable reasons. */
export function suggestionsFor(ctx, line, { limit = 5 } = {}) {
  const { db } = ctx;
  const account = db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(line.account_id);
  const text = `${line.description} ${line.reference}`;
  const textTokens = new Set(tokens(text));
  const flat = lowered(text);
  const rejected = rejectedSet(db, line.id);
  const out = [];
  const push = (c) => { if (!rejected.has(`${c.kind}:${c.refId ?? 0}`)) out.push({ ...c, confidence: Math.min(100, c.score), label: label(Math.min(100, c.score)) }); };

  if (line.amount > 0) {
    const invoices = db.prepare(`SELECT i.* FROM invoices i WHERE i.paid = 0 AND i.total = ?
      AND NOT EXISTS (SELECT 1 FROM bank_matches m WHERE m.kind = 'invoice' AND m.ref_id = i.id AND m.status = 'accepted')`).all(line.amount);
    for (const inv of invoices) {
      let score = 50; const reasons = [`Amount equals the open invoice total`];
      const num = inv.number ?? `INV-${inv.id}`;
      const digits = String(inv.number ?? inv.id).replace(/\D/g, '').replace(/^0+/, '') || String(inv.id);
      if (new RegExp(`inv[-\\s_#]?0*${digits}(?!\\d)`, 'i').test(flat) || lowered(line.reference) === num.toLowerCase()) { score += 35; reasons.push(`Reference "${num}" found in the text`); }
      const n = nameReason(inv.customer, text, textTokens, 'Customer'); if (n) { score += n.score; reasons.push(n.reason); }
      const d = daysBetween(inv.issue_date, line.txn_date);
      if (d >= 0 && d <= 60) { score += 5; reasons.push(`Received ${d} day(s) after the invoice date`); }
      push({ kind: 'invoice', refId: inv.id, title: `${num} - ${inv.customer}`, amount: inv.total, date: inv.issue_date, score, reasons, creates: 'Posts Dr bank / Cr accounts receivable and marks the invoice settled' });
    }
  } else if (line.amount < 0) {
    const bills = db.prepare(`SELECT b.* FROM bills b WHERE b.status = 'approved' AND b.amount = ?
      AND NOT EXISTS (SELECT 1 FROM bank_matches m WHERE m.kind = 'bill' AND m.ref_id = b.id AND m.status = 'accepted')`).all(-line.amount);
    for (const b of bills) {
      let score = 50; const reasons = ['Amount equals the approved, unpaid bill'];
      if (new RegExp(`bill[-\\s_#]?0*${b.id}(?!\\d)`, 'i').test(flat)) { score += 35; reasons.push(`Reference "BILL-${b.id}" found in the text`); }
      const n = nameReason(b.supplier, text, textTokens, 'Supplier'); if (n) { score += n.score; reasons.push(n.reason); }
      push({ kind: 'bill', refId: b.id, title: `Bill #${b.id} - ${b.supplier}`, amount: b.amount, date: null, score, reasons, creates: 'Posts Dr accounts payable / Cr bank and marks the bill settled' });
    }
  }

  for (const e of unreconciledLedger(db, account.ledger_code)) {
    if (e.amount !== line.amount) continue;
    let score = 50; const reasons = ['Amount equals an unreconciled ledger entry'];
    const d = Math.abs(daysBetween(e.date, line.txn_date));
    if (d === 0) { score += 30; reasons.push('Same date'); } else if (d <= 3) { score += 20; reasons.push(`Dates are ${d} day(s) apart`); } else if (d <= 7) { score += 10; reasons.push(`Dates are ${d} days apart`); } else if (d > 45) score -= 15;
    const mt = tokens(e.memo), overlap = mt.filter((t) => textTokens.has(t));
    if (overlap.length) { score += Math.min(20, 8 * overlap.length); reasons.push(`Shared words with the entry memo: ${overlap.slice(0, 3).join(', ')}`); }
    push({ kind: 'ledger', refId: e.journalLineId, title: `Entry #${e.entryId}: ${e.memo}`, amount: e.amount, date: e.date, score, reasons, creates: 'Links the statement line to the existing entry (nothing is posted)' });
  }

  const hit = firstRuleFor(db, { description: line.description, reference: line.reference, amount: line.amount });
  if (hit) {
    push({ kind: 'rule', refId: hit.rule.id, title: `Rule "${hit.rule.name}" -> ${hit.rule.accountCode}`, amount: line.amount, date: null, score: 60,
      reasons: [...hit.reasons, `Would post to account ${hit.rule.accountCode}`], creates: 'Posts a new journal entry through the ledger', accountCode: hit.rule.accountCode, memo: hit.rule.memo });
  }
  return out.sort((a, b) => b.confidence - a.confidence || (a.kind < b.kind ? -1 : 1)).slice(0, limit);
}

export function lineSuggestions(ctx, user, lineId) {
  requirePerm(user, 'banking.view');
  const l = activeLine(ctx.db, lineId);
  return { line: lineOut(l), suggestions: suggestionsFor(ctx, l) };
}

export function queue(ctx, user, query = {}) {
  requirePerm(user, 'banking.view');
  const lines = listLines(ctx, user, { accountId: query.accountId, state: 'unreconciled', limit: Math.min(Number(query.limit) || 50, 200) });
  return lines.map((l) => ({ line: l, suggestions: suggestionsFor(ctx, getLine(ctx.db, l.id), { limit: 3 }) }));
}

function bankSideLine(db, entryId, code) {
  return db.prepare('SELECT jl.id FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE jl.entry_id = ? AND a.code = ?').get(entryId, code)?.id ?? null;
}
const lockOpts = (input) => ({ confirmSoftLock: !!input.confirmSoftLock, reason: input.reason ? String(input.reason) : undefined });

function recordMatch(ctx, user, line, m) {
  const { db } = ctx;
  const res = db.prepare(`INSERT INTO bank_matches (line_id, kind, ref_id, entry_id, ledger_line_id, status, confidence, reasons, note, created_by, created_at)
    VALUES (?,?,?,?,?,'accepted',?,?,?,?,?)`).run(line.id, m.kind, m.refId ?? null, m.entryId ?? null, m.ledgerLineId ?? null, m.confidence ?? null, j(m.reasons ?? []), m.note ?? null, user.id, ctx.now());
  const id = Number(res.lastInsertRowid);
  db.prepare("UPDATE bank_lines SET recon_state = 'reconciled' WHERE id = ?").run(line.id);
  audit(ctx, { userId: user.id, action: 'banking.reconciled', type: 'bank_line', id: line.id, newValue: { matchId: id, kind: m.kind, refId: m.refId ?? null, entryId: m.entryId ?? null, confidence: m.confidence ?? null }, reason: m.note ?? null });
  return id;
}

function requireOpen(line) {
  if (line.recon_state !== 'unreconciled') throw bad('ALREADY_RECONCILED', 'This statement line is already reconciled; unreconcile it first', 409);
}

/** Accept a suggestion (or any valid candidate). invoice/bill post a settlement entry; ledger links an existing entry; rule posts via the rule. */
export function acceptMatch(ctx, user, lineId, input = {}) {
  requirePerm(user, REC_ONLY);
  const { db } = ctx;
  const kind = input.kind;
  if (!['invoice', 'bill', 'ledger', 'rule'].includes(kind)) throw bad('BAD_INPUT', 'kind must be invoice, bill, ledger or rule');
  const refId = intId(input.refId, 'refId');
  return tx(db, () => {
    const line = activeLine(db, lineId);
    requireOpen(line);
    const account = getAccount(db, line.account_id);
    const suggestion = suggestionsFor(ctx, line, { limit: 50 }).find((s) => s.kind === kind && s.refId === refId);
    const meta = { confidence: suggestion?.confidence ?? null, reasons: suggestion?.reasons ?? ['Accepted manually'] };

    if (kind === 'rule') return createEntryFromLine(ctx, user, line.id, { ...input, ruleId: refId });

    if (kind === 'ledger') {
      const e = unreconciledLedger(db, account.ledger_code).find((x) => x.journalLineId === refId);
      if (!e) throw bad('NOT_AVAILABLE', 'That ledger line is not available (wrong account, already reconciled, or reversed)', 409);
      if (e.amount !== line.amount) throw bad('AMOUNT_MISMATCH', 'Amounts differ; use manual reconcile with a reason for a mismatch', 409);
      const id = recordMatch(ctx, user, line, { kind, refId, ledgerLineId: refId, ...meta });
      return matchResult(db, id);
    }

    let entry, doc;
    if (kind === 'invoice') {
      doc = db.prepare('SELECT * FROM invoices WHERE id = ?').get(refId);
      if (!doc) throw bad('NOT_FOUND', 'Invoice not found', 404);
      if (doc.paid || db.prepare("SELECT 1 FROM bank_matches WHERE kind='invoice' AND ref_id=? AND status='accepted'").get(refId)) throw bad('ALREADY_SETTLED', 'Invoice is already paid', 409);
      if (line.amount !== doc.total) throw bad('AMOUNT_MISMATCH', `Invoice total is ${doc.total} piastres but the line is ${line.amount}`, 409);
      entry = postEntry(ctx, { userId: user.id, date: line.txn_date, memo: `Bank receipt for ${doc.number}`, sourceType: 'bank_match', sourceId: line.id,
        lines: [{ account: account.ledger_code, debit: doc.total }, { account: '1200', credit: doc.total }], ...lockOpts(input) });
    } else {
      doc = db.prepare('SELECT * FROM bills WHERE id = ?').get(refId);
      if (!doc) throw bad('NOT_FOUND', 'Bill not found', 404);
      if (doc.status !== 'approved') throw bad('NOT_APPROVED', 'Only approved bills can be matched to a payment', 409);
      if (db.prepare("SELECT 1 FROM bank_matches WHERE kind='bill' AND ref_id=? AND status='accepted'").get(refId)) throw bad('ALREADY_SETTLED', 'Bill is already settled', 409);
      if (line.amount !== -doc.amount) throw bad('AMOUNT_MISMATCH', `Bill amount is ${doc.amount} piastres but the line is ${line.amount}`, 409);
      entry = postEntry(ctx, { userId: user.id, date: line.txn_date, memo: `Bank payment for bill #${doc.id} (${doc.supplier})`, sourceType: 'bank_match', sourceId: line.id,
        lines: [{ account: '2000', debit: doc.amount }, { account: account.ledger_code, credit: doc.amount }], ...lockOpts(input) });
    }
    const id = recordMatch(ctx, user, line, { kind, refId, entryId: entry.id, ledgerLineId: bankSideLine(db, entry.id, account.ledger_code), ...meta });
    // The owning module (sales/purchases) listens to these events to mark the document settled.
    emit(ctx, kind === 'invoice' ? 'banking.invoice_settled' : 'banking.bill_settled', { id: refId, amount: Math.abs(line.amount), entryId: entry.id, lineId: line.id, userId: user.id });
    return matchResult(db, id);
  });
}

function matchResult(db, id) {
  const m = db.prepare('SELECT * FROM bank_matches WHERE id = ?').get(id);
  return { id: m.id, lineId: m.line_id, kind: m.kind, refId: m.ref_id, entryId: m.entry_id, ledgerLineId: m.ledger_line_id, status: m.status, confidence: m.confidence, reasons: parse(m.reasons, []) };
}

export function rejectMatch(ctx, user, lineId, input = {}) {
  requirePerm(user, REC_ONLY);
  const { db } = ctx;
  if (!['invoice', 'bill', 'ledger', 'rule'].includes(input.kind)) throw bad('BAD_INPUT', 'kind must be invoice, bill, ledger or rule');
  const refId = intId(input.refId, 'refId');
  return tx(db, () => {
    const line = activeLine(db, lineId);
    if (!db.prepare("SELECT 1 FROM bank_matches WHERE line_id=? AND kind=? AND ref_id=? AND status='rejected'").get(line.id, input.kind, refId)) {
      const res = db.prepare("INSERT INTO bank_matches (line_id, kind, ref_id, status, note, created_by, created_at) VALUES (?,?,?,'rejected',?,?,?)")
        .run(line.id, input.kind, refId, str(input.reason, 'reason', { max: 200 }) || null, user.id, ctx.now());
      audit(ctx, { userId: user.id, action: 'banking.suggestion_rejected', type: 'bank_line', id: line.id, newValue: { kind: input.kind, refId, matchId: Number(res.lastInsertRowid) } });
    }
    return { lineId: line.id, kind: input.kind, refId, rejected: true };
  });
}

/** Manual reconcile: link a line to a specific ledger line, even if the amounts differ. A reason is always required and audited. */
export function manualReconcile(ctx, user, lineId, input = {}) {
  requirePerm(user, REC_ONLY);
  const { db } = ctx;
  const reason = str(input.reason, 'reason', { required: true });
  const jlId = intId(input.journalLineId, 'journalLineId');
  return tx(db, () => {
    const line = activeLine(db, lineId);
    requireOpen(line);
    const account = getAccount(db, line.account_id);
    const e = unreconciledLedger(db, account.ledger_code).find((x) => x.journalLineId === jlId);
    if (!e) throw bad('NOT_AVAILABLE', 'That ledger line is not available (wrong account, already reconciled, or reversed)', 409);
    const reasons = [`Reconciled manually: ${reason}`];
    if (e.amount !== line.amount) reasons.push(`Amounts differ by ${line.amount - e.amount} piastres`);
    const id = recordMatch(ctx, user, line, { kind: 'manual', refId: jlId, ledgerLineId: jlId, reasons, note: reason });
    return matchResult(db, id);
  });
}

/** Undo a reconciliation. If the match posted a journal entry, that entry is reversed (never deleted); period locks apply. */
export function unreconcile(ctx, user, lineId, input = {}) {
  requirePerm(user, REC_ONLY);
  const { db } = ctx;
  const reason = str(input.reason, 'reason', { required: true });
  return tx(db, () => {
    const line = getLine(db, lineId);
    const m = db.prepare("SELECT * FROM bank_matches WHERE line_id = ? AND status = 'accepted'").get(line.id);
    if (!m) throw bad('NOT_RECONCILED', 'This statement line is not reconciled', 409);
    let reversal = null;
    if (m.entry_id) reversal = reverseEntry(ctx, user.id, m.entry_id, reason).id;
    db.prepare("UPDATE bank_matches SET status='undone', undone_by=?, undone_at=?, undo_reason=? WHERE id=?").run(user.id, ctx.now(), reason, m.id);
    db.prepare("UPDATE bank_lines SET recon_state='unreconciled' WHERE id=?").run(line.id);
    audit(ctx, { userId: user.id, action: 'banking.unreconciled', type: 'bank_line', id: line.id, oldValue: { matchId: m.id, kind: m.kind, refId: m.ref_id, entryId: m.entry_id }, newValue: { reversalEntryId: reversal }, reason });
    if (m.kind === 'invoice' || m.kind === 'bill') emit(ctx, 'banking.settlement_reversed', { kind: m.kind, id: m.ref_id, lineId: line.id, reversalEntryId: reversal, userId: user.id });
    return { lineId: line.id, matchId: m.id, reversalEntryId: reversal };
  });
}

/** Post a new journal entry from a statement line (bank fees, interest ...). Account/memo come from the input or the first matching rule. */
export function createEntryFromLine(ctx, user, lineId, input = {}) {
  requirePerm(user, REC_ONLY);
  const { db } = ctx;
  return tx(db, () => {
    const line = activeLine(db, lineId);
    requireOpen(line);
    const account = getAccount(db, line.account_id);
    let code = input.accountCode ? String(input.accountCode) : null, memo = input.memo ? str(input.memo, 'memo', { max: 200 }) : null, ruleId = null, method = null;
    if (input.ruleId) {
      const row = db.prepare('SELECT * FROM bank_rules WHERE id = ? AND active = 1').get(intId(input.ruleId, 'ruleId'));
      if (!row) throw bad('NOT_FOUND', 'Rule not found or inactive', 404);
      const r = ruleOut(row);
      if (!ruleMatches(r, { description: line.description, reference: line.reference, amount: line.amount })) throw bad('RULE_NO_MATCH', 'That rule does not match this line', 409);
      code = code ?? r.accountCode;
      memo = memo ?? (r.memo || null);
      ruleId = r.id; method = r.method;
    } else if (!code) {
      const hit = firstRuleFor(db, { description: line.description, reference: line.reference, amount: line.amount });
      if (!hit) throw bad('NO_RULE_MATCH', 'No accountCode given and no bank rule matches this line', 400);
      code = hit.rule.accountCode; memo = memo ?? (hit.rule.memo || null); ruleId = hit.rule.id; method = hit.rule.method;
    }
    const target = ledgerAccount(db, code);
    if (!target) throw bad('UNKNOWN_ACCOUNT', `Unknown ledger account ${code}`);
    if (code === account.ledger_code) throw bad('BAD_INPUT', 'The counter account cannot be the bank account itself');
    const amt = Math.abs(line.amount);
    const lines = line.amount > 0
      ? [{ account: account.ledger_code, debit: amt }, { account: code, credit: amt }]
      : [{ account: code, debit: amt }, { account: account.ledger_code, credit: amt }];
    const entry = postEntry(ctx, { userId: user.id, date: input.date ? dateStr(input.date, 'date') : line.txn_date, memo: memo || line.description || 'Bank statement line',
      sourceType: 'bank_line', sourceId: line.id, lines, ...lockOpts(input) });
    if (method && !line.method) db.prepare('UPDATE bank_lines SET method = ? WHERE id = ?').run(method, line.id);
    const id = recordMatch(ctx, user, line, { kind: ruleId ? 'rule' : 'entry', refId: ruleId ?? entry.id, entryId: entry.id, ledgerLineId: bankSideLine(db, entry.id, account.ledger_code),
      confidence: ruleId ? 60 : null, reasons: [ruleId ? `Created from rule #${ruleId}` : 'Entry created from the statement line'] });
    return { ...matchResult(db, id), accountCode: code };
  });
}

// ---------- reconciliation ----------
export function computeSummary(ctx, account, asOf) {
  const { db } = ctx;
  const lines = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS s FROM bank_lines WHERE account_id = ? AND status = 'active' AND txn_date <= ?").get(account.id, asOf);
  const unrecLines = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS s FROM bank_lines WHERE account_id = ? AND status = 'active' AND recon_state = 'unreconciled' AND txn_date <= ?").get(account.id, asOf);
  const ledger = db.prepare(`SELECT COALESCE(SUM(jl.debit - jl.credit),0) AS s FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
    JOIN journal_entries je ON je.id = jl.entry_id WHERE a.code = ? AND je.entry_date <= ?`).get(account.ledger_code, asOf).s;
  const unrecLedger = unreconciledLedger(db, account.ledger_code, asOf);
  const ledgerSum = unrecLedger.reduce((s, e) => s + e.amount, 0);
  const hasStatement = lines.n > 0;
  const statementBalance = hasStatement ? account.opening_balance + lines.s : null;
  const difference = hasStatement ? statementBalance - ledger : null;
  const explained = unrecLines.s - ledgerSum; // what unmatched items on each side account for
  return {
    accountId: account.id, name: account.name, type: account.type, ledgerCode: account.ledger_code, asOf,
    statementBalance, ledgerBalance: ledger, difference,
    unreconciledLines: { count: unrecLines.n, total: unrecLines.s },
    unreconciledLedger: { count: unrecLedger.length, total: ledgerSum },
    explainedByUnmatched: hasStatement ? explained : null,
    unexplained: hasStatement ? difference - explained : null,
    reconciled: hasStatement && unrecLines.n === 0 && unrecLedger.length === 0 && difference === 0,
  };
}

export function summary(ctx, user, query = {}) {
  requirePerm(user, 'banking.view');
  const asOf = query.date ? dateStr(query.date, 'date') : isoDate(ctx.now());
  return computeSummary(ctx, getAccount(ctx.db, query.accountId), asOf);
}

export function report(ctx, user, query = {}) {
  requirePerm(user, 'banking.view');
  const { db } = ctx;
  const asOf = query.date ? dateStr(query.date, 'date') : isoDate(ctx.now());
  const account = getAccount(db, query.accountId);
  const s = computeSummary(ctx, account, asOf);
  const reconciled = db.prepare(`SELECT l.*, m.kind AS match_kind, m.entry_id, m.ledger_line_id, m.confidence, m.reasons FROM bank_lines l JOIN bank_matches m ON m.line_id = l.id AND m.status = 'accepted'
    WHERE l.account_id = ? AND l.status = 'active' AND l.txn_date <= ? ORDER BY l.txn_date, l.id`).all(account.id, asOf)
    .map((r) => ({ ...lineOut(r), matchKind: r.match_kind, entryId: r.entry_id, ledgerLineId: r.ledger_line_id, confidence: r.confidence, reasons: parse(r.reasons, []) }));
  const unreconciled = db.prepare("SELECT * FROM bank_lines WHERE account_id = ? AND status = 'active' AND recon_state = 'unreconciled' AND txn_date <= ? ORDER BY txn_date, id").all(account.id, asOf).map(lineOut);
  const signoffs = db.prepare('SELECT * FROM bank_signoffs WHERE account_id = ? ORDER BY id DESC LIMIT 10').all(account.id)
    .map((r) => ({ id: r.id, asOf: r.as_of, statementBalance: r.statement_balance, ledgerBalance: r.ledger_balance, difference: r.difference, unreconciledCount: r.unreconciled_count, note: r.note, createdBy: r.created_by, createdAt: r.created_at }));
  const byMethod = db.prepare("SELECT COALESCE(method,'untagged') AS method, COUNT(*) AS n, SUM(amount) AS total FROM bank_lines WHERE account_id = ? AND status = 'active' AND txn_date <= ? GROUP BY 1 ORDER BY 1").all(account.id, asOf);
  return { summary: s, reconciled, unreconciledLines: unreconciled, unreconciledLedger: unreconciledLedger(db, account.ledger_code, asOf), signoffs, byMethod,
    note: 'Statement lines come from CSV imports only. Live bank feeds are not implemented (availability in Egypt is unverified).' };
}

/** Record that an account was reconciled as of a date. Open items or a non-zero difference need a note. */
export function signoff(ctx, user, input = {}) {
  requirePerm(user, REC_ONLY);
  const { db } = ctx;
  const asOf = input.date ? dateStr(input.date, 'date') : isoDate(ctx.now());
  const note = str(input.note, 'note', { max: 300 });
  return tx(db, () => {
    const account = getAccount(db, input.accountId);
    const s = computeSummary(ctx, account, asOf);
    if (s.statementBalance == null) throw bad('NO_STATEMENT', 'There are no statement lines for this account yet', 409);
    const clean = s.reconciled;
    if (!clean && !note) throw bad('NOTE_REQUIRED', 'There are unreconciled items or a difference; add a note explaining why you are signing off', 400);
    const res = db.prepare('INSERT INTO bank_signoffs (account_id, as_of, statement_balance, ledger_balance, difference, unreconciled_count, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(account.id, asOf, s.statementBalance, s.ledgerBalance, s.difference, s.unreconciledLines.count + s.unreconciledLedger.count, note || null, user.id, ctx.now());
    const id = Number(res.lastInsertRowid);
    audit(ctx, { userId: user.id, action: 'banking.signoff', type: 'bank_account', id: account.id, newValue: { signoffId: id, asOf, difference: s.difference, clean }, reason: note || null });
    emit(ctx, 'banking.reconciled', { accountId: account.id, asOf, difference: s.difference, clean, userId: user.id });
    return { id, ...s, clean };
  });
}

// ---------- home widget ----------
export function widgets(ctx, user) {
  if (!user.permissions.has('banking.view')) return {};
  const today = isoDate(ctx.now());
  const accounts = ctx.db.prepare('SELECT * FROM bank_accounts WHERE active = 1 ORDER BY id').all().map((a) => computeSummary(ctx, a, today));
  return { banking: {
    unreconciled: accounts.reduce((n, a) => n + a.unreconciledLines.count, 0),
    difference: accounts.reduce((n, a) => n + (a.difference ?? 0), 0),
    accounts: accounts.map((a) => ({ id: a.accountId, name: a.name, unreconciled: a.unreconciledLines.count, difference: a.difference, statementBalance: a.statementBalance, ledgerBalance: a.ledgerBalance })),
  } };
}

export { normalizeMethod };
