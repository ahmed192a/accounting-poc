import { randomUUID } from 'node:crypto';
import { AppError, posInt } from '../../errors.js';
import { audit, tx } from '../../ledger.js';
import { emit } from '../../hooks.js';
import { requirePerm } from '../../permissions.js';
import { setting } from '../../db.js';
import { adapterById, activeAdapter } from './adapters/index.js';
import { cfg, cfgInt, hoursMs } from './config.js';
import { resolveCode, skuForLine, buyerTaxId } from './codes.js';
import { canonical, sha256, GENESIS } from './util.js';

// E-invoice documents (all submission is to a MOCK authority). Each document is chained to the previous one:
//   hash = sha256(seq|kind|number|uuid|total|vat|prev_hash|canonical(payload))
// so editing or removing any stored document breaks verification from that point on.

// State machine. queued -> submitted -> valid | rejected ; rejected -> queued (retry) ; cancel from most states.
export const TRANSITIONS = {
  queued: ['submitted', 'cancelled'],
  submitted: ['valid', 'rejected', 'cancelled'],
  valid: ['cancelled'],
  rejected: ['queued', 'cancelled'],
  cancelled: [],
};
export const WARN_MS = 4 * 3600 * 1000;

const KIND_PREFIX = { credit_note: 'CN', debit_note: 'DN' };

function move(ctx, doc, to, fields = {}, reason = null, userId = null) {
  if (!TRANSITIONS[doc.status].includes(to)) throw new AppError(409, 'BAD_TRANSITION', `A ${doc.status} document cannot become ${to}`);
  const sets = ['status = ?', ...Object.keys(fields).map((k) => `${k} = ?`)];
  ctx.db.prepare(`UPDATE tax_documents SET ${sets.join(', ')} WHERE id = ?`).run(to, ...Object.values(fields), doc.id);
  audit(ctx, { userId, action: `tax.document_${to}`, type: 'tax_document', id: doc.id, oldValue: { status: doc.status }, newValue: { status: to }, reason });
  emit(ctx, 'tax.document_status', { id: doc.id, from: doc.status, to, reason });
}
const get = (db, id) => {
  const d = db.prepare('SELECT * FROM tax_documents WHERE id = ?').get(id);
  if (!d) throw new AppError(404, 'NOT_FOUND', 'Tax document not found');
  return d;
};

export function hashOf(row, prev, payload) {
  return sha256(`${row.seq}|${row.kind}|${row.number}|${row.uuid}|${row.total}|${row.vat}|${prev}|${canonical(payload)}`);
}

function normaliseLines(db, rawLines, vatTotal, rateBp) {
  const base = rawLines.map((l) => {
    if (!l || !l.description) throw new AppError(400, 'BAD_INPUT', 'Each document line needs a description');
    const qty = posInt(l.qty, 'qty'), unitPrice = posInt(l.unitPrice, 'unitPrice');
    const sku = skuForLine(db, l), code = resolveCode(db, sku);
    return { sku, description: l.description, qty, unitPrice, net: qty * unitPrice, code: code?.code ?? null, codeType: code?.type ?? null };
  });
  const net = base.reduce((s, l) => s + l.net, 0);
  // Spread the VAT over the lines in proportion to their net value; the last line absorbs rounding so the sum is exact.
  let used = 0;
  const lines = base.map((l, i) => {
    const vat = i === base.length - 1 ? vatTotal - used : Math.round((l.net * vatTotal) / net);
    used += vat;
    return { ...l, vat };
  });
  return { lines, net, vat: vatTotal, total: net + vatTotal, rateBp };
}

/** Insert a chained document (queued). Must run inside the caller's transaction. */
export function createDocument(ctx, { kind, sourceType = null, sourceId = null, number, customer, lines, vat, refDocument = null, replaces = null, userId = null }) {
  const { db } = ctx;
  if (!Array.isArray(lines) || !lines.length) throw new AppError(400, 'BAD_INPUT', 'A document needs at least one line');
  const adapter = activeAdapter(db);
  const stdBp = Number(setting(db, 'vat_rate_bp') ?? 0);
  const rawNet = lines.reduce((s, l) => s + posInt(l.qty, 'qty') * posInt(l.unitPrice, 'unitPrice'), 0);
  const vatTotal = vat ?? Math.round((rawNet * stdBp) / 10000);
  if (!Number.isInteger(vatTotal) || vatTotal < 0) throw new AppError(400, 'BAD_INPUT', 'vat must be a whole number of piastres');
  const norm = normaliseLines(db, lines, vatTotal, vatTotal === 0 ? 0 : stdBp);
  const now = ctx.now();
  const uuid = randomUUID();
  const last = db.prepare('SELECT seq, hash FROM tax_documents ORDER BY seq DESC LIMIT 1').get();
  const seq = (last?.seq ?? 0) + 1, prev = last?.hash ?? GENESIS;
  const docNumber = number ?? `${KIND_PREFIX[kind]}-${String(seq).padStart(4, '0')}`;
  const neutral = {
    kind, number: docNumber, uuid, issuedAt: new Date(now).toISOString(),
    seller: { taxId: cfg(db, 'tax_reg_number') || null, name: cfg(db, 'tax_seller_name'), address: cfg(db, 'tax_seller_address') },
    buyer: { name: customer, taxId: buyerTaxId(db, customer) },
    lines: norm.lines, totals: { net: norm.net, vat: norm.vat, total: norm.total },
    vatRateBp: norm.rateBp, vatRateCode: norm.vat === 0 ? 'zero' : 'standard',
    refUuid: refDocument?.uuid ?? null,
  };
  const payload = adapter.buildDocument(neutral);
  const row = { seq, kind, number: docNumber, uuid, total: norm.total, vat: norm.vat };
  const hash = hashOf(row, prev, payload);
  const retain = new Date(now); retain.setUTCFullYear(retain.getUTCFullYear() + cfgInt(db, 'tax_retention_years'));
  const res = db.prepare(`INSERT INTO tax_documents (seq, kind, source_type, source_id, number, uuid, adapter, payload, source, qr, total, vat, prev_hash, hash,
      ref_document_id, replaces_id, status, created_by, created_at, deadline_at, retain_until) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'queued', ?,?,?,?)`)
    .run(seq, kind, sourceType, sourceId, docNumber, uuid, adapter.id, JSON.stringify(payload), JSON.stringify({ customer, lines, vat: vatTotal }), adapter.qr(payload, hash),
      norm.total, norm.vat, prev, hash, refDocument?.id ?? null, replaces?.id ?? null, userId, now, now + hoursMs(db, 'tax_submit_deadline_hours'), retain.toISOString().slice(0, 10));
  const id = Number(res.lastInsertRowid);
  audit(ctx, { userId, action: 'tax.document_created', type: 'tax_document', id, newValue: { kind, number: docNumber, uuid, adapter: adapter.id, total: norm.total } });
  emit(ctx, 'tax.document_created', { id, kind, number: docNumber, uuid, status: 'queued', adapter: adapter.id });
  return id;
}

/** One submission attempt. Returns the resulting status; an unreachable authority leaves the document queued. */
export function submitDocument(ctx, doc, userId = null) {
  if (doc.status !== 'queued') throw new AppError(409, 'BAD_TRANSITION', `Only queued documents can be submitted (this one is ${doc.status})`);
  const adapter = adapterById(doc.adapter);
  try {
    const r = adapter.submit(ctx, JSON.parse(doc.payload));
    ctx.db.prepare('UPDATE tax_documents SET attempts = attempts + 1 WHERE id = ?').run(doc.id);
    move(ctx, doc, 'submitted', { submission_id: r.submissionId, submitted_at: ctx.now(), reject_code: null, reject_reason: null, fix_hint: null }, null, userId);
    return 'submitted';
  } catch (e) {
    if (e.code !== 'TAX_UNREACHABLE') throw e;
    ctx.db.prepare('UPDATE tax_documents SET attempts = attempts + 1 WHERE id = ?').run(doc.id);
    return 'queued';
  }
}

/** Ask the authority how a submitted document is doing (the mock validates here, like an asynchronous check). */
export function pollDocument(ctx, doc) {
  if (doc.status !== 'submitted') return doc.status;
  const adapter = adapterById(doc.adapter);
  let r;
  try { r = adapter.status(ctx, JSON.parse(doc.payload)); } catch (e) { if (e.code === 'TAX_UNREACHABLE') return 'submitted'; throw e; }
  if (r.status === 'valid') { move(ctx, doc, 'valid', { validated_at: ctx.now() }); return 'valid'; }
  if (r.status === 'rejected') { move(ctx, doc, 'rejected', { reject_code: r.code, reject_reason: r.reason, fix_hint: r.fixHint }, r.reason); return 'rejected'; }
  return 'submitted';
}

export function documentSettled(ctx, id) { return get(ctx.db, id); }

function strip(ctx, d) {
  const now = ctx.now();
  const pending = (d.status === 'queued' || d.status === 'rejected') && !d.superseded;
  const msLeft = pending ? d.deadline_at - now : null;
  let state = d.status;
  if (pending && msLeft < 0) state = 'overdue';
  else if (d.status === 'queued' && msLeft <= WARN_MS) state = 'due_soon';
  const windowEnd = d.status === 'submitted' || d.status === 'valid' ? (d.validated_at ?? d.submitted_at) + hoursMs(ctx.db, 'tax_cancel_window_hours') : null;
  const { payload, source, ...rest } = d;
  return { ...rest, state, msLeft, cancelUntil: windowEnd, canCancel: d.status === 'queued' || d.status === 'rejected' || (windowEnd != null && now <= windowEnd), superseded: !!d.superseded };
}

export function listDocuments(ctx, user, { status } = {}) {
  requirePerm(user, 'tax.view');
  const rows = status
    ? ctx.db.prepare('SELECT * FROM tax_documents WHERE status = ? ORDER BY seq DESC LIMIT 100').all(status)
    : ctx.db.prepare('SELECT * FROM tax_documents ORDER BY seq DESC LIMIT 100').all();
  return rows.map((d) => strip(ctx, d));
}

export function getDocument(ctx, user, id) {
  requirePerm(user, 'tax.view');
  const d = get(ctx.db, id);
  return { ...strip(ctx, d), payload: JSON.parse(d.payload), mock: true };
}

/** Walk the chain from the first document; reports the first broken link. */
export function verifyChain(ctx, user) {
  requirePerm(user, 'tax.view');
  return verifyChainRaw(ctx.db);
}
export function verifyChainRaw(db) {
  const rows = db.prepare('SELECT * FROM tax_documents ORDER BY seq').all();
  let prev = GENESIS, expectSeq = 1;
  for (const r of rows) {
    const bad = (reason) => ({ ok: false, checked: rows.length, brokenAtSeq: r.seq, documentId: r.id, reason });
    if (r.seq !== expectSeq) return bad(`Sequence gap: expected ${expectSeq}, found ${r.seq} (a document was removed)`);
    if (r.prev_hash !== prev) return bad('prev_hash does not match the previous document hash');
    let payload;
    try { payload = JSON.parse(r.payload); } catch { return bad('payload is not valid JSON'); }
    if (hashOf(r, prev, payload) !== r.hash) return bad('stored hash does not match the document content (it was altered)');
    prev = r.hash; expectSeq++;
  }
  return { ok: true, checked: rows.length, head: prev };
}

export function retryDocument(ctx, user, id) {
  requirePerm(user, 'tax.submit');
  return tx(ctx.db, () => {
    let d = get(ctx.db, id);
    if (d.status === 'rejected') { move(ctx, d, 'queued', {}, 'retry', user.id); d = get(ctx.db, id); }
    if (d.status !== 'queued') throw new AppError(409, 'BAD_TRANSITION', `Only queued or rejected documents can be retried (this one is ${d.status})`);
    const s = submitDocument(ctx, d, user.id);
    return { id, status: s === 'submitted' ? pollDocument(ctx, get(ctx.db, id)) : s };
  });
}

/** Submit everything queued, poll everything submitted, and run the existing e-receipt sync. */
export function syncAll(ctx, user, receiptSync) {
  requirePerm(user, 'tax.submit');
  return tx(ctx.db, () => {
    const out = { submitted: 0, valid: 0, rejected: 0, stillQueued: 0, receipts: null };
    for (const d of ctx.db.prepare("SELECT * FROM tax_documents WHERE status = 'queued' ORDER BY seq").all()) {
      if (submitDocument(ctx, d, user.id) === 'queued') out.stillQueued++; else out.submitted++;
    }
    for (const d of ctx.db.prepare("SELECT * FROM tax_documents WHERE status = 'submitted' ORDER BY seq").all()) {
      const s = pollDocument(ctx, d);
      if (s === 'valid') out.valid++; else if (s === 'rejected') out.rejected++;
    }
    out.receipts = receiptSync(ctx);
    ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('tax_last_sync', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(ctx.now()));
    audit(ctx, { userId: user.id, action: 'tax.sync', type: 'tax_document', newValue: out });
    return out;
  });
}

export function cancelDocument(ctx, user, id, reason) {
  requirePerm(user, 'tax.submit');
  if (typeof reason !== 'string' || !reason.trim()) throw new AppError(400, 'REASON_REQUIRED', 'Cancelling a document needs a reason');
  return tx(ctx.db, () => {
    const d = get(ctx.db, id);
    if (d.status === 'cancelled') throw new AppError(409, 'BAD_TRANSITION', 'Document is already cancelled');
    if (d.status === 'submitted' || d.status === 'valid') {
      const until = (d.validated_at ?? d.submitted_at) + hoursMs(ctx.db, 'tax_cancel_window_hours');
      if (ctx.now() > until) {
        throw new AppError(409, 'CANCEL_WINDOW_CLOSED', `The cancellation window (${cfgInt(ctx.db, 'tax_cancel_window_hours')} h, configurable, UNVERIFIED) has passed; issue a credit note instead`);
      }
      adapterById(d.adapter).cancel(ctx, JSON.parse(d.payload), reason);
    }
    move(ctx, d, 'cancelled', { cancelled_at: ctx.now(), cancel_reason: reason.trim() }, reason.trim(), user.id);
    return { id, status: 'cancelled' };
  });
}

/** Rejected document: chain a new document built from the same source with the current codes and settings. */
export function reissueDocument(ctx, user, id) {
  requirePerm(user, 'tax.submit');
  return tx(ctx.db, () => {
    const d = get(ctx.db, id);
    if (d.status !== 'rejected') throw new AppError(409, 'BAD_TRANSITION', 'Only a rejected document can be reissued');
    if (d.superseded) throw new AppError(409, 'ALREADY_REISSUED', 'This document was already reissued');
    const src = JSON.parse(d.source);
    const ref = d.ref_document_id ? get(ctx.db, d.ref_document_id) : null;
    const newId = createDocument(ctx, { kind: d.kind, sourceType: d.source_type, sourceId: d.source_id, number: d.kind === 'invoice' ? d.number : null, customer: src.customer, lines: src.lines, vat: src.vat, refDocument: ref, replaces: d, userId: user.id });
    ctx.db.prepare('UPDATE tax_documents SET superseded = 1 WHERE id = ?').run(id);
    audit(ctx, { userId: user.id, action: 'tax.document_reissued', type: 'tax_document', id, newValue: { newId } });
    const s = submitDocument(ctx, get(ctx.db, newId), user.id);
    return { id: newId, replaces: id, status: s };
  });
}

/** Credit or debit note against an existing document. Full reversal when no lines are given. */
export function createNote(ctx, user, { documentId, kind, lines, reason, vat }) {
  requirePerm(user, 'tax.submit');
  if (!['credit_note', 'debit_note'].includes(kind)) throw new AppError(400, 'BAD_INPUT', 'kind must be credit_note or debit_note');
  if (typeof reason !== 'string' || !reason.trim()) throw new AppError(400, 'REASON_REQUIRED', 'A credit or debit note needs a reason');
  return tx(ctx.db, () => {
    const orig = get(ctx.db, documentId);
    if (orig.kind !== 'invoice') throw new AppError(400, 'BAD_INPUT', 'Notes can only refer to an invoice document');
    if (orig.status === 'cancelled' || orig.status === 'rejected') throw new AppError(409, 'BAD_TRANSITION', `A ${orig.status} invoice cannot be corrected with a note`);
    const src = JSON.parse(orig.source);
    const noteLines = lines ?? src.lines;
    const noteVat = lines ? vat : src.vat;
    const id = createDocument(ctx, { kind, sourceType: 'tax_note', sourceId: orig.id, customer: src.customer, lines: noteLines, vat: noteVat, refDocument: orig, userId: user.id });
    const note = get(ctx.db, id);
    if (kind === 'credit_note') {
      const credited = ctx.db.prepare("SELECT COALESCE(SUM(total),0) AS t FROM tax_documents WHERE kind = 'credit_note' AND ref_document_id = ? AND status != 'cancelled'").get(orig.id).t;
      if (credited > orig.total) throw new AppError(409, 'OVER_CREDIT', 'Credit notes would exceed the invoice total');
    }
    audit(ctx, { userId: user.id, action: 'tax.note_reason', type: 'tax_document', id, reason: reason.trim() });
    submitDocument(ctx, note, user.id);
    return { id, number: note.number, status: get(ctx.db, id).status };
  });
}

// ---- hooks ----------------------------------------------------------------------------------------------
export function onInvoiceCreated(ctx, p) {
  if (cfg(ctx.db, 'tax_einvoice_enabled') !== '1') return;
  const inv = p.invoice;
  if (ctx.db.prepare("SELECT 1 FROM tax_documents WHERE source_type = 'invoice' AND source_id = ? AND kind = 'invoice'").get(inv.id)) return; // idempotent
  const id = createDocument(ctx, { kind: 'invoice', sourceType: 'invoice', sourceId: inv.id, number: inv.number, customer: inv.customer, lines: inv.lines, vat: inv.vat, userId: p.userId ?? null });
  submitDocument(ctx, get(ctx.db, id), p.userId ?? null);
}

// Defensive: the sales module may or may not emit `credit_note.created` yet. Several payload shapes are accepted.
export function onCreditNoteCreated(ctx, payload) {
  if (cfg(ctx.db, 'tax_einvoice_enabled') !== '1') return null;
  const n = payload?.creditNote ?? payload?.credit_note ?? payload?.note ?? payload;
  const invoiceId = n?.invoiceId ?? n?.invoice_id ?? payload?.invoiceId;
  const lines = n?.lines;
  if (!Array.isArray(lines) || !lines.length || !n.customer && !invoiceId) return null; // cannot build a document from this payload
  const orig = invoiceId != null ? ctx.db.prepare("SELECT * FROM tax_documents WHERE kind = 'invoice' AND source_type = 'invoice' AND source_id = ? AND superseded = 0 ORDER BY seq DESC").get(invoiceId) : null;
  const customer = n.customer ?? (orig ? JSON.parse(orig.source).customer : 'Unknown customer');
  const clean = lines.map((l) => ({ description: l.description, qty: l.qty, unitPrice: l.unitPrice ?? l.unit_price, sku: l.sku }));
  const id = createDocument(ctx, { kind: 'credit_note', sourceType: 'credit_note', sourceId: n.id ?? null, number: n.number ?? null, customer, lines: clean, vat: Number.isInteger(n.vat) ? n.vat : undefined, refDocument: orig, userId: payload?.userId ?? null });
  submitDocument(ctx, get(ctx.db, id), payload?.userId ?? null);
  return id;
}

// ---- retention export -----------------------------------------------------------------------------------
export function exportDocuments(ctx, user) {
  requirePerm(user, 'tax.view');
  const docs = ctx.db.prepare('SELECT * FROM tax_documents WHERE submitted_at IS NOT NULL ORDER BY seq').all().map((d) => ({
    seq: d.seq, kind: d.kind, number: d.number, uuid: d.uuid, adapter: d.adapter, status: d.status, total: d.total, vat: d.vat,
    hash: d.hash, prevHash: d.prev_hash, qr: d.qr, submittedAt: d.submitted_at, validatedAt: d.validated_at, cancelledAt: d.cancelled_at,
    retainUntil: d.retain_until, payload: JSON.parse(d.payload),
  }));
  audit(ctx, { userId: user.id, action: 'tax.export', type: 'tax_document', newValue: { documents: docs.length } });
  return {
    mock: true, notice: 'Documents were submitted to a MOCK authority. Retention period is configurable and UNVERIFIED.',
    exportedAt: new Date(ctx.now()).toISOString(), retentionYears: cfgInt(ctx.db, 'tax_retention_years'),
    chain: verifyChainRaw(ctx.db), documents: docs,
  };
}
