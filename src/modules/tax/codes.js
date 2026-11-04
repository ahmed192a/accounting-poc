import { AppError } from '../../errors.js';
import { audit, tx } from '../../ledger.js';
import { requirePerm } from '../../permissions.js';

// Item code management. GS1 = GTIN (8/12/13/14 digits, mod-10 check digit, a published GS1 rule).
// EGS = "EG-<registration number>-<internal code>" style. The EGS format is UNVERIFIED: adjust to the
// authority's current specification. The mapping lives in tax_item_codes keyed by sku (sales owns items).
const EGS = /^(EGS-)?EG-\d{3,12}-[A-Za-z0-9_-]{1,40}$/;

export function gs1CheckDigitOk(code) {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  const d = code.split('').map(Number), check = d.pop();
  const sum = d.reverse().reduce((s, n, i) => s + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** Returns { type, code } or throws BAD_CODE. Type is inferred: all digits = GS1, otherwise EGS. */
export function validateCode(raw) {
  const code = String(raw ?? '').trim();
  if (!code) throw new AppError(400, 'BAD_CODE', 'Item code is empty');
  if (/^\d+$/.test(code)) {
    if (!gs1CheckDigitOk(code)) throw new AppError(400, 'BAD_CODE', `"${code}" is not a valid GS1 GTIN (8, 12, 13 or 14 digits with a correct check digit)`);
    return { type: 'GS1', code };
  }
  if (!EGS.test(code)) throw new AppError(400, 'BAD_CODE', `"${code}" does not look like an EGS code (expected EG-<registration number>-<item>) [format UNVERIFIED]`);
  return { type: 'EGS', code };
}

/** sku for an invoice line: explicit sku, else the catalogue item whose name matches the description. */
export function skuForLine(db, line) {
  if (line.sku) return line.sku;
  const r = db.prepare('SELECT sku FROM items WHERE name = ? OR name_ar = ?').get(line.description, line.description);
  return r?.sku ?? null;
}

/** Resolve the code for a sku: own mapping first, then the code stored on the sales item. */
export function resolveCode(db, sku) {
  if (!sku) return null;
  const m = db.prepare('SELECT code_type, code FROM tax_item_codes WHERE sku = ?').get(sku);
  if (m) return { type: m.code_type, code: m.code, source: 'mapping' };
  const it = db.prepare('SELECT eta_code FROM items WHERE sku = ?').get(sku);
  if (it?.eta_code) return { type: /^\d+$/.test(it.eta_code) ? 'GS1' : 'EGS', code: it.eta_code, source: 'sales' };
  return null;
}

export function listItemCodes(ctx, user) {
  requirePerm(user, 'tax.view');
  const rows = ctx.db.prepare('SELECT sku, name, name_ar FROM items ORDER BY id').all().map((i) => {
    const c = resolveCode(ctx.db, i.sku);
    return { ...i, code: c?.code ?? null, codeType: c?.type ?? null, source: c?.source ?? null, missing: !c };
  });
  return { items: rows, missing: rows.filter((r) => r.missing).length };
}

export function setItemCode(ctx, user, sku, rawCode) {
  requirePerm(user, 'tax.configure');
  if (!ctx.db.prepare('SELECT 1 FROM items WHERE sku = ?').get(sku)) throw new AppError(404, 'UNKNOWN_ITEM', `Unknown item ${sku}`);
  const { type, code } = validateCode(rawCode);
  tx(ctx.db, () => {
    const old = ctx.db.prepare('SELECT code FROM tax_item_codes WHERE sku = ?').get(sku);
    ctx.db.prepare('INSERT INTO tax_item_codes (sku, code_type, code, updated_by, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(sku) DO UPDATE SET code_type=excluded.code_type, code=excluded.code, updated_by=excluded.updated_by, updated_at=excluded.updated_at')
      .run(sku, type, code, user.id, ctx.now());
    audit(ctx, { userId: user.id, action: 'tax.item_code', type: 'item', oldValue: old ?? null, newValue: { sku, type, code } });
  });
  return { sku, type, code };
}

/** Minimal CSV parser (quotes, commas). Returns array of arrays. */
export function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((c) => c.trim())) rows.push(row); row = []; }
    else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

/**
 * Bulk CSV import "sku,code" (header optional). All-or-nothing: if any row is invalid nothing is written and the
 * error lists every bad row, so a long file can be fixed in one pass.
 */
export function importItemCodes(ctx, user, csv) {
  requirePerm(user, 'tax.configure');
  if (typeof csv !== 'string' || !csv.trim()) throw new AppError(400, 'BAD_INPUT', 'csv text is required');
  if (csv.length > 500000) throw new AppError(413, 'TOO_LARGE', 'CSV is too large');
  let rows = parseCsv(csv);
  if (rows[0] && /^sku$/i.test(rows[0][0].trim())) rows = rows.slice(1);
  if (!rows.length) throw new AppError(400, 'BAD_INPUT', 'CSV has no data rows');
  const errors = [], ok = [];
  rows.forEach((r, i) => {
    const line = i + 1, sku = (r[0] ?? '').trim();
    try {
      if (!sku) throw new AppError(400, 'BAD_CODE', 'sku is empty');
      if (!ctx.db.prepare('SELECT 1 FROM items WHERE sku = ?').get(sku)) throw new AppError(404, 'UNKNOWN_ITEM', `unknown sku ${sku}`);
      ok.push({ sku, ...validateCode(r[1]) });
    } catch (e) { errors.push({ line, sku, error: e.message }); }
  });
  if (errors.length) throw new AppError(400, 'IMPORT_INVALID', `${errors.length} of ${rows.length} rows are invalid; nothing was imported`, { errors });
  tx(ctx.db, () => {
    for (const r of ok) setItemCode(ctx, user, r.sku, r.code);
    audit(ctx, { userId: user.id, action: 'tax.item_codes_imported', type: 'item', newValue: { rows: ok.length } });
  });
  return { imported: ok.length };
}

export function setParty(ctx, user, name, taxId) {
  requirePerm(user, 'tax.configure');
  if (typeof name !== 'string' || !name.trim()) throw new AppError(400, 'BAD_INPUT', 'Customer name is required');
  if (typeof taxId !== 'string' || !/^[A-Za-z0-9-]{5,20}$/.test(taxId)) throw new AppError(400, 'BAD_INPUT', 'taxId must be 5 to 20 letters, digits or dashes');
  tx(ctx.db, () => {
    ctx.db.prepare('INSERT INTO tax_parties (name, tax_id, updated_by, updated_at) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET tax_id=excluded.tax_id, updated_by=excluded.updated_by, updated_at=excluded.updated_at').run(name.trim(), taxId, user.id, ctx.now());
    audit(ctx, { userId: user.id, action: 'tax.party', type: 'tax_party', newValue: { name: name.trim() } });
  });
  return { name: name.trim(), taxId };
}
export const listParties = (ctx, user) => {
  requirePerm(user, 'tax.view');
  return ctx.db.prepare('SELECT name, tax_id AS taxId FROM tax_parties ORDER BY name').all();
};
export const buyerTaxId = (db, name) => db.prepare('SELECT tax_id FROM tax_parties WHERE name = ?').get(name)?.tax_id ?? null;
