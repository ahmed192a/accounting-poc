import { AppError, posInt } from '../../errors.js';
import { audit, tx, getPeriodLock } from '../../ledger.js';
import { requirePerm } from '../../permissions.js';
import { emit } from '../../hooks.js';
import { createBill, voidBillInternal } from '../purchases/service.js';
import { cleanText, validDate } from '../purchases/util.js';
import { getProvider, DEFAULT_PROVIDER } from './providers.js';
import { CATEGORIES, supplierKey } from './extractor.js';

// Safe-AI workflow (MOCK extractor). HARD RULES, enforced here and covered by tests:
//  1. a suggestion never posts anything: accepting creates a bill that goes to the normal approval rules;
//  2. a bill created from a suggestion is never auto-approved, whatever its amount (createBill source 'assist');
//  3. a suggestion dated inside a locked period (soft or hard) is refused at acceptance;
//  4. every accepted suggestion can be undone, and undoing is a reversal, never a deletion.

const MAX_TEXT = 20000;
const MIN_SAMPLE = 20; // below this, accuracy figures carry a "too few to mean much" warning

const parse = (r) => r && ({ ...r, suggestion: JSON.parse(r.suggestion), confidence: JSON.parse(r.confidence), reasons: JSON.parse(r.reasons), final_fields: r.final_fields ? JSON.parse(r.final_fields) : null });

function lookupCategory(db) {
  const q = db.prepare('SELECT category FROM assist_rules WHERE supplier_key = ?');
  return (key) => q.get(key)?.category ?? null;
}

export function submitIntake(ctx, user, input = {}) {
  requirePerm(user, 'assist.use');
  const { db } = ctx;
  if (typeof input.text !== 'string' || !input.text.trim()) throw new AppError(400, 'BAD_INPUT', 'Paste the receipt text first');
  if (input.text.length > MAX_TEXT) throw new AppError(413, 'TEXT_TOO_LARGE', `Text is longer than ${MAX_TEXT} characters`);
  let provider;
  try { provider = getProvider(input.provider ?? DEFAULT_PROVIDER); } catch { throw new AppError(400, 'UNKNOWN_PROVIDER', 'Unknown extraction provider'); }
  const out = provider.extract(input.text, { lookupCategory: lookupCategory(db) });
  return tx(db, () => {
    const res = db.prepare('INSERT INTO assist_items (raw_text, provider, suggestion, confidence, reasons, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(input.text, provider.name, JSON.stringify(out.fields), JSON.stringify(out.confidence), JSON.stringify(out.reasons), 'pending', user.id, ctx.now());
    const id = Number(res.lastInsertRowid);
    audit(ctx, { userId: user.id, action: 'assist.intake', type: 'assist_item', id, newValue: { provider: provider.name, mock: !!provider.mock, chars: input.text.length } });
    return { id, provider: provider.name, mock: !!provider.mock, suggestion: out.fields, confidence: out.confidence, reasons: out.reasons };
  });
}

export function listItems(ctx, user, { status } = {}) {
  if (!user.permissions.has('assist.review') && !user.permissions.has('assist.use')) requirePerm(user, 'assist.use');
  const own = !user.permissions.has('assist.review');
  const where = [], args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (own) { where.push('created_by = ?'); args.push(user.id); }
  return ctx.db.prepare(`SELECT * FROM assist_items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`).all(...args).map(parse);
}

export function getItem(ctx, user, id) {
  const item = parse(ctx.db.prepare('SELECT * FROM assist_items WHERE id = ?').get(id));
  if (!item) throw new AppError(404, 'NOT_FOUND', 'Item not found');
  if (!user.permissions.has('assist.review')) {
    requirePerm(user, 'assist.use');
    if (item.created_by !== user.id) throw new AppError(404, 'NOT_FOUND', 'Item not found');
  }
  return item;
}

function cleanEdits(base, edits = {}) {
  if (edits == null || typeof edits !== 'object') throw new AppError(400, 'BAD_INPUT', 'edits must be an object');
  const f = { ...base, ...Object.fromEntries(Object.entries(edits).filter(([k]) => ['supplier', 'date', 'total', 'vat', 'currency', 'category'].includes(k))) };
  f.supplier = cleanText(f.supplier, 'supplier', { required: true, max: 120 });
  f.date = validDate(f.date, 'date');
  posInt(f.total, 'total');
  if (!Number.isInteger(f.vat) || f.vat < 0 || f.vat >= f.total) throw new AppError(400, 'BAD_INPUT', 'vat must be a whole number of piastres below the total');
  if (f.currency !== 'EGP') throw new AppError(422, 'CURRENCY_UNSUPPORTED', `Bills are in EGP only; this document is in ${f.currency}. Multi-currency bills are not supported here yet`);
  if (!CATEGORIES.includes(f.category)) throw new AppError(400, 'BAD_INPUT', `category must be one of ${CATEGORIES.join(', ')}`);
  return f;
}

export function acceptItem(ctx, user, id, input = {}) {
  requirePerm(user, 'assist.review');
  const { db } = ctx;
  const item = parse(db.prepare('SELECT * FROM assist_items WHERE id = ?').get(id));
  if (!item) throw new AppError(404, 'NOT_FOUND', 'Item not found');
  if (item.status !== 'pending') throw new AppError(409, 'NOT_PENDING', `This suggestion is already ${item.status}`);
  const fields = cleanEdits(item.suggestion, input.edits);
  const lock = getPeriodLock(db);
  if (lock.through_date && fields.date <= lock.through_date) {
    throw new AppError(423, 'PERIOD_LOCKED', `The date ${fields.date} is inside the locked period (through ${lock.through_date}); suggestions never post into locked periods. Change the date or ask the owner`);
  }
  const changed = Object.keys(item.suggestion).filter((k) => item.suggestion[k] !== fields[k]);
  const edited = changed.length > 0;
  return tx(db, () => {
    const bill = createBill(ctx, user, { supplier: fields.supplier, amount: fields.total, vat: fields.vat, category: fields.category, billDate: fields.date }, { source: 'assist', sourceRef: `assist:${id}` });
    db.prepare("UPDATE assist_items SET status = 'accepted', outcome = ?, final_fields = ?, bill_id = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?")
      .run(edited ? 'edited' : 'unchanged', JSON.stringify(fields), bill.id, user.id, ctx.now(), id);
    // Learning: only a corrected category teaches a supplier -> category rule.
    if (changed.includes('category')) {
      const key = supplierKey(fields.supplier);
      if (key) {
        db.prepare(`INSERT INTO assist_rules (supplier_key, category, hits, updated_by, updated_at) VALUES (?,?,1,?,?)
          ON CONFLICT(supplier_key) DO UPDATE SET category = excluded.category, hits = CASE WHEN category = excluded.category THEN hits + 1 ELSE 1 END, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
          .run(key, fields.category, user.id, ctx.now());
        audit(ctx, { userId: user.id, action: 'assist.rule_learned', type: 'assist_rule', id, newValue: { supplierKey: key, category: fields.category } });
      }
    }
    audit(ctx, { userId: user.id, action: 'assist.accepted', type: 'assist_item', id, newValue: { billId: bill.id, edited, changed }, oldValue: item.suggestion });
    emit(ctx, 'assist.accepted', { itemId: id, billId: bill.id, edited, userId: user.id });
    return { id, billId: bill.id, billStatus: bill.status, edited, changed };
  });
}

export function rejectItem(ctx, user, id, input = {}) {
  requirePerm(user, 'assist.review');
  const { db } = ctx;
  const reason = cleanText(input.reason, 'reason', { required: true, max: 300 });
  const item = db.prepare('SELECT * FROM assist_items WHERE id = ?').get(id);
  if (!item) throw new AppError(404, 'NOT_FOUND', 'Item not found');
  if (item.status !== 'pending') throw new AppError(409, 'NOT_PENDING', `This suggestion is already ${item.status}`);
  tx(db, () => {
    db.prepare("UPDATE assist_items SET status = 'rejected', reject_reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(reason, user.id, ctx.now(), id);
    audit(ctx, { userId: user.id, action: 'assist.rejected', type: 'assist_item', id, reason });
  });
  return { id, status: 'rejected' };
}

/** Undo an accepted suggestion: the bill is voided (approval cancelled, or ledger entry reversed). Refused once the bill has payments. */
export function undoItem(ctx, user, id, input = {}) {
  requirePerm(user, 'assist.review');
  const { db } = ctx;
  const reason = cleanText(input.reason, 'reason', { required: true, max: 300 });
  const item = db.prepare('SELECT * FROM assist_items WHERE id = ?').get(id);
  if (!item) throw new AppError(404, 'NOT_FOUND', 'Item not found');
  if (item.status !== 'accepted') throw new AppError(409, 'NOT_ACCEPTED', 'Only an accepted suggestion can be undone');
  return tx(db, () => {
    const v = voidBillInternal(ctx, user.id, item.bill_id, `Assist undo: ${reason}`);
    db.prepare("UPDATE assist_items SET status = 'undone', undo_reason = ? WHERE id = ?").run(reason, id);
    audit(ctx, { userId: user.id, action: 'assist.undone', type: 'assist_item', id, reason, newValue: { billId: item.bill_id, reversalEntryId: v.reversalEntryId } });
    emit(ctx, 'assist.undone', { itemId: id, billId: item.bill_id, userId: user.id });
    return { id, status: 'undone', billId: item.bill_id, reversalEntryId: v.reversalEntryId };
  });
}

/** Honest accuracy: counts of reviewed suggestions with the sample size, and a warning while the sample is small. */
export function accuracyStats(ctx, user) {
  requirePerm(user, 'assist.review');
  const { db } = ctx;
  const c = (sql) => db.prepare(sql).get().n;
  const unchanged = c("SELECT COUNT(*) n FROM assist_items WHERE status IN ('accepted') AND outcome = 'unchanged'");
  const edited = c("SELECT COUNT(*) n FROM assist_items WHERE status IN ('accepted') AND outcome = 'edited'");
  const rejected = c("SELECT COUNT(*) n FROM assist_items WHERE status = 'rejected'");
  const undone = c("SELECT COUNT(*) n FROM assist_items WHERE status = 'undone'");
  const pending = c("SELECT COUNT(*) n FROM assist_items WHERE status = 'pending'");
  const n = unchanged + edited + rejected;
  const fieldEdits = {};
  for (const r of db.prepare("SELECT suggestion, final_fields FROM assist_items WHERE status = 'accepted' AND outcome = 'edited'").all()) {
    const a = JSON.parse(r.suggestion), b = JSON.parse(r.final_fields);
    for (const k of Object.keys(a)) if (a[k] !== b[k]) fieldEdits[k] = (fieldEdits[k] ?? 0) + 1;
  }
  const pct = (x) => (n ? Math.round((x * 1000) / n) / 10 : null);
  return {
    mock: true, sampleSize: n, acceptedUnchanged: unchanged, acceptedEdited: edited, rejected, undone, pending, fieldEdits,
    acceptedUnchangedPct: pct(unchanged), editedPct: pct(edited), rejectedPct: pct(rejected),
    caution: n === 0 ? 'Nothing reviewed yet, so there is no accuracy to report.'
      : n < MIN_SAMPLE ? `Only ${n} reviewed so far: too few to say how accurate the suggestions are. Undone items are not counted.` : null,
  };
}

export function listRules(ctx, user) {
  requirePerm(user, 'assist.review');
  return ctx.db.prepare('SELECT * FROM assist_rules ORDER BY updated_at DESC, id DESC').all();
}

export function deleteRule(ctx, user, id) {
  requirePerm(user, 'assist.review');
  const rule = ctx.db.prepare('SELECT * FROM assist_rules WHERE id = ?').get(id);
  if (!rule) throw new AppError(404, 'NOT_FOUND', 'Rule not found');
  tx(ctx.db, () => {
    ctx.db.prepare('DELETE FROM assist_rules WHERE id = ?').run(id);
    audit(ctx, { userId: user.id, action: 'assist.rule_deleted', type: 'assist_rule', id, oldValue: rule });
  });
  return { id };
}

export function widgets(ctx, user) {
  if (!user.permissions.has('assist.review')) return {};
  const stats = accuracyStats(ctx, user);
  return { assist: { pending: stats.pending, stats, items: listItems(ctx, user) } };
}
