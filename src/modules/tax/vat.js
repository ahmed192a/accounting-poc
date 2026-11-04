import { AppError } from '../../errors.js';
import { postEntry, tx, audit, isoDate } from '../../ledger.js';
import { requirePerm } from '../../permissions.js';
import { cfg } from './config.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const UNVERIFIED_NOTE = 'Rates, bands and rules here are configurable placeholders and UNVERIFIED. Verify with the tax authority or an adviser before filing.';

export function period(q) {
  const from = q?.from, to = q?.to;
  if (!DATE.test(from ?? '') || !DATE.test(to ?? '')) throw new AppError(400, 'BAD_DATE', 'from and to must be YYYY-MM-DD');
  if (from > to) throw new AppError(400, 'BAD_DATE', 'from must not be after to');
  return { from, to };
}

export function listRates(ctx, user) {
  requirePerm(user, 'tax.view');
  return ctx.db.prepare('SELECT code, name, name_ar AS nameAr, rate_bp AS rateBp, verified, active FROM tax_vat_rates ORDER BY code').all()
    .map((r) => ({ ...r, verified: !!r.verified, active: !!r.active, unverified: !r.verified }));
}

export function setRate(ctx, user, code, { rateBp, verified, active }) {
  requirePerm(user, 'tax.configure');
  const old = ctx.db.prepare('SELECT * FROM tax_vat_rates WHERE code = ?').get(code);
  if (!old) throw new AppError(404, 'NOT_FOUND', `Unknown VAT rate ${code}`);
  if (rateBp !== undefined && (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 10000)) throw new AppError(400, 'BAD_INPUT', 'rateBp must be a whole number between 0 and 10000');
  if (['zero', 'exempt'].includes(code) && rateBp) throw new AppError(400, 'BAD_INPUT', `The ${code} rate must stay at 0`);
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE tax_vat_rates SET rate_bp = ?, verified = ?, active = ? WHERE code = ?')
      .run(rateBp ?? old.rate_bp, verified === undefined ? old.verified : verified ? 1 : 0, active === undefined ? old.active : active ? 1 : 0, code);
    audit(ctx, { userId: user.id, action: 'tax.vat_rate', type: 'tax_vat_rate', oldValue: old, newValue: { code, rateBp, verified, active } });
  });
  return listRates(ctx, user).find((r) => r.code === code);
}

const sums = (db, code, from, to) => db.prepare(
  `SELECT COALESCE(SUM(l.debit),0) AS d, COALESCE(SUM(l.credit),0) AS c, COUNT(*) AS n
   FROM journal_lines l JOIN accounts a ON a.id = l.account_id JOIN journal_entries e ON e.id = l.entry_id
   WHERE a.code = ? AND e.entry_date >= ? AND e.entry_date <= ?`).get(code, from, to);

/** VAT return for a period straight from the ledger: output VAT = 2100 net credits, input VAT = 1400 net debits. */
export function vatReturn(ctx, user, q) {
  requirePerm(user, 'tax.vat_return');
  const { from, to } = period(q);
  const out = sums(ctx.db, '2100', from, to), inn = sums(ctx.db, '1400', from, to), sales = sums(ctx.db, '4000', from, to);
  const outputVat = out.c - out.d, inputVat = inn.d - inn.c;
  const missing = ctx.db.prepare(
    `SELECT b.id, b.supplier, b.amount FROM bills b JOIN journal_entries e ON e.id = b.entry_id
     WHERE e.entry_date >= ? AND e.entry_date <= ? AND NOT EXISTS (SELECT 1 FROM tax_bill_tax t WHERE t.bill_id = b.id) ORDER BY b.id`).all(from, to);
  const standard = ctx.db.prepare("SELECT verified FROM tax_vat_rates WHERE code = 'standard'").get();
  return {
    from, to, outputVat, inputVat, netPayable: outputVat - inputVat, taxableSales: sales.c - sales.d,
    refund: outputVat - inputVat < 0,
    billsWithoutVatInfo: missing, // approved bills with no VAT information: input VAT may be under-claimed
    unverified: !standard?.verified, notice: UNVERIFIED_NOTE,
  };
}

const EXPENSE_FALLBACK = '5000';

function postInputVat(ctx, row, bill, userId) {
  if (row.vat === 0) return null;
  const exp = ctx.db.prepare('SELECT a.code FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? AND l.debit > 0 ORDER BY l.id LIMIT 1').get(bill.entry_id)?.code ?? EXPENSE_FALLBACK;
  const e = postEntry(ctx, {
    userId, date: isoDate(ctx.now()), memo: `Input VAT on bill #${bill.id} (${bill.supplier})`, sourceType: 'bill_vat', sourceId: bill.id,
    lines: [{ account: '1400', debit: row.vat }, { account: exp, credit: row.vat }], // reclass: VAT leaves the expense, becomes recoverable
  });
  ctx.db.prepare('UPDATE tax_bill_tax SET entry_id = ? WHERE id = ?').run(e.id, row.id);
  return e.id;
}

/** Record VAT information on a bill. Posts the input VAT now if the bill is already approved, else on bill.approved. */
export function recordBillVat(ctx, user, billId, input) {
  requirePerm(user, 'tax.vat_return');
  const { db } = ctx;
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
  if (!bill) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
  const rateCode = input?.rateCode ?? 'standard';
  const rate = db.prepare('SELECT * FROM tax_vat_rates WHERE code = ? AND active = 1').get(rateCode);
  if (!rate) throw new AppError(400, 'BAD_INPUT', `Unknown or inactive VAT rate ${rateCode}`);
  const vat = input?.vat;
  if (!Number.isInteger(vat) || vat < 0) throw new AppError(400, 'BAD_INPUT', 'vat must be a whole number of piastres (0 or more)');
  if (vat >= bill.amount) throw new AppError(400, 'BAD_INPUT', 'vat must be less than the bill amount (the amount includes VAT)');
  if (rate.rate_bp === 0 && vat !== 0) throw new AppError(400, 'BAD_INPUT', `Rate ${rateCode} is 0%, so vat must be 0`);
  const taxId = input?.supplierTaxId ?? null;
  if (taxId != null && !/^[A-Za-z0-9-]{5,20}$/.test(taxId)) throw new AppError(400, 'BAD_INPUT', 'supplierTaxId must be 5 to 20 letters, digits or dashes');
  if (db.prepare('SELECT 1 FROM tax_bill_tax WHERE bill_id = ?').get(billId)) throw new AppError(409, 'ALREADY_RECORDED', 'VAT information is already recorded for this bill');
  return tx(db, () => {
    const res = db.prepare('INSERT INTO tax_bill_tax (bill_id, rate_code, vat, supplier_tax_id, invoice_ref, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(billId, rateCode, vat, taxId, input?.invoiceRef ?? null, user.id, ctx.now());
    const row = db.prepare('SELECT * FROM tax_bill_tax WHERE id = ?').get(Number(res.lastInsertRowid));
    const entryId = bill.status === 'approved' && bill.entry_id ? postInputVat(ctx, row, bill, user.id) : null;
    audit(ctx, { userId: user.id, action: 'tax.bill_vat', type: 'bill', id: billId, newValue: { vat, rateCode, entryId } });
    return { billId, vat, rateCode, entryId, posted: entryId != null };
  });
}

export function getBillVat(ctx, user, billId) {
  requirePerm(user, 'tax.view');
  const r = ctx.db.prepare('SELECT bill_id AS billId, rate_code AS rateCode, vat, supplier_tax_id AS supplierTaxId, invoice_ref AS invoiceRef, entry_id AS entryId FROM tax_bill_tax WHERE bill_id = ?').get(billId);
  if (!r) throw new AppError(404, 'NOT_FOUND', 'No VAT information recorded for this bill');
  return r;
}

// Hook: bill.approved posts input VAT only when VAT info exists. Runs inside the approval transaction.
export function onBillApproved(ctx, p) {
  const row = ctx.db.prepare('SELECT * FROM tax_bill_tax WHERE bill_id = ? AND entry_id IS NULL').get(p.bill.id);
  if (!row) return;
  const bill = { ...ctx.db.prepare('SELECT * FROM bills WHERE id = ?').get(p.bill.id), entry_id: p.entryId };
  postInputVat(ctx, row, bill, p.userId ?? null);
}

// ---- simplified-regime turnover tax ESTIMATE ----------------------------------------------------------------
export function turnoverEstimate(ctx, user, q) {
  requirePerm(user, 'tax.vat_return');
  const { from, to } = period(q);
  const bands = JSON.parse(cfg(ctx.db, 'tax_turnover_bands'));
  const turnover = sums(ctx.db, '4000', from, to);
  const t = turnover.c - turnover.d;
  const band = bands.find((b) => b.upTo == null || t <= b.upTo);
  const tax = band ? band.fixed + Math.round((t * band.rateBp) / 10000) : 0;
  return {
    from, to, turnover: t, band: band ?? null, estimatedTax: tax, estimate: true,
    notice: 'ESTIMATE ONLY. Bands are placeholders and UNVERIFIED. Verify with a tax adviser before relying on this figure.',
    noticeAr: 'تقدير فقط. الشرائح افتراضية وغير موثقة. تحقق من مستشار ضرائب قبل الاعتماد على هذا الرقم.',
    bands,
  };
}

export function setTurnoverBands(ctx, user, bands) {
  requirePerm(user, 'tax.configure');
  if (!Array.isArray(bands) || !bands.length) throw new AppError(400, 'BAD_INPUT', 'bands must be a non-empty list');
  let last = -1;
  bands.forEach((b, i) => {
    if (!Number.isInteger(b.rateBp) || b.rateBp < 0 || b.rateBp > 10000) throw new AppError(400, 'BAD_INPUT', 'Each band needs a rateBp between 0 and 10000');
    if (b.fixed !== undefined && (!Number.isInteger(b.fixed) || b.fixed < 0)) throw new AppError(400, 'BAD_INPUT', 'fixed must be a whole number of piastres');
    if (b.upTo == null) { if (i !== bands.length - 1) throw new AppError(400, 'BAD_INPUT', 'Only the last band may have no upper limit'); return; }
    if (!Number.isInteger(b.upTo) || b.upTo <= last) throw new AppError(400, 'BAD_INPUT', 'Band limits (upTo) must be increasing whole numbers');
    last = b.upTo;
  });
  const clean = bands.map((b) => ({ upTo: b.upTo ?? null, rateBp: b.rateBp, fixed: b.fixed ?? 0 }));
  tx(ctx.db, () => {
    ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('tax_turnover_bands', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(clean));
    audit(ctx, { userId: user.id, action: 'tax.turnover_bands', type: 'tax_settings', newValue: clean });
  });
  return clean;
}

// ---- withholding tax PLACEHOLDER ----------------------------------------------------------------------------
export function withholding(ctx, user) {
  requirePerm(user, 'tax.view');
  return { placeholder: true, rates: JSON.parse(cfg(ctx.db, 'tax_withholding_rates')), notice: 'Withholding tax is a PLACEHOLDER: nothing is withheld or posted automatically. Rates are yours to configure and UNVERIFIED.' };
}
export function setWithholding(ctx, user, rates) {
  requirePerm(user, 'tax.configure');
  if (!rates || typeof rates !== 'object' || Array.isArray(rates)) throw new AppError(400, 'BAD_INPUT', 'rates must be an object of category -> basis points');
  for (const [k, v] of Object.entries(rates)) if (!Number.isInteger(v) || v < 0 || v > 10000) throw new AppError(400, 'BAD_INPUT', `Rate for ${k} must be whole basis points between 0 and 10000`);
  tx(ctx.db, () => {
    ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('tax_withholding_rates', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(rates));
    audit(ctx, { userId: user.id, action: 'tax.withholding_rates', type: 'tax_settings', newValue: rates });
  });
  return withholding(ctx, user);
}
export function withholdingFor(db, category, amount) {
  const bp = JSON.parse(cfg(db, 'tax_withholding_rates'))[category] ?? 0;
  return { rateBp: bp, amount: Math.round((amount * bp) / 10000), placeholder: true };
}
