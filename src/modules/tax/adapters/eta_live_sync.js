import { AppError } from '../../../errors.js';
import { audit, tx } from '../../../ledger.js';
import { requirePerm } from '../../../permissions.js';
import { setting } from '../../../db.js';
import { createEtaClient, liveCfg, checkUrl, LIVE_DEFAULTS } from './eta_client.js';
import { canonicalString, resolveSigner } from './eta_sign.js';
import { moveDocument, getDocumentRow } from '../documents.js';

// The asynchronous side of the live ETA adapter. Network calls happen here, never inside a database transaction; the result is
// then applied with the normal document state machine (documents.js). UNVERIFIED against the real service.
const LIVE = 'eta_live';
const busy = new WeakSet(); // one pump at a time per database (a second concurrent call returns { busy: true })

const log = (ctx, op, documentId, outcome, code = null, detail = null) =>
  ctx.db.prepare('INSERT INTO tax_live_log (at, op, document_id, outcome, code, detail) VALUES (?,?,?,?,?,?)').run(ctx.now(), op, documentId, outcome, code, detail ? String(detail).slice(0, 300) : null);
const liveRow = (ctx, id, patch) => {
  const cur = ctx.db.prepare('SELECT * FROM tax_live_docs WHERE document_id = ?').get(id);
  const n = { long_id: cur?.long_id ?? null, share_url: cur?.share_url ?? null, attempts: cur?.attempts ?? 0, last_http_status: cur?.last_http_status ?? null, last_error: cur?.last_error ?? null, cancel_confirmed: cur?.cancel_confirmed ?? 0, ...patch };
  ctx.db.prepare(`INSERT INTO tax_live_docs (document_id, long_id, share_url, attempts, last_http_status, last_error, cancel_confirmed, updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(document_id) DO UPDATE SET long_id=excluded.long_id, share_url=excluded.share_url, attempts=excluded.attempts, last_http_status=excluded.last_http_status, last_error=excluded.last_error, cancel_confirmed=excluded.cancel_confirmed, updated_at=excluded.updated_at`)
    .run(id, n.long_id, n.share_url, n.attempts, n.last_http_status, n.last_error, n.cancel_confirmed, ctx.now());
};
const HINT = 'Fix the cause shown, then reissue the document (a new document is chained; the rejected one stays as history). Check the format notes in docs/eta-live.md.';

async function signedCopy(ctx, signer, cfg, doc) {
  const body = { ...JSON.parse(doc.payload) };
  delete body.format; // our own marker, not part of the authority document
  body.documentTypeVersion = cfg.tax_eta_document_version;
  body.taxpayerActivityCode = setting(ctx.db, 'tax_eta_activity_code') ?? '';
  const value = await signer.sign({ canonical: canonicalString(body), now: ctx.now(), detached: cfg.tax_eta_cms_detached === '1' });
  body.signatures = [{ signatureType: 'I', value }];
  return body;
}

function applySubmitResult(ctx, userId, doc, outcome) {
  tx(ctx.db, () => {
    const cur = getDocumentRow(ctx.db, doc.id);
    if (cur.status !== 'queued') return; // changed while we were on the network (cancelled, or another sync won)
    ctx.db.prepare('UPDATE tax_documents SET attempts = attempts + 1 WHERE id = ?').run(doc.id);
    const sub = { submission_id: outcome.submissionId ?? null, submitted_at: ctx.now(), reject_code: null, reject_reason: null, fix_hint: null };
    moveDocument(ctx, cur, 'submitted', sub, null, userId);
    if (outcome.rejected) {
      moveDocument(ctx, getDocumentRow(ctx.db, doc.id), 'rejected', { reject_code: outcome.rejected.code, reject_reason: outcome.rejected.reason, fix_hint: HINT }, outcome.rejected.reason, userId);
    }
    liveRow(ctx, doc.id, { long_id: outcome.longId ?? null, last_error: null, last_http_status: 200, attempts: (ctx.db.prepare('SELECT attempts FROM tax_live_docs WHERE document_id = ?').get(doc.id)?.attempts ?? 0) + 1 });
    log(ctx, 'submit', doc.id, outcome.rejected ? 'rejected' : 'ok', outcome.rejected?.code ?? null, outcome.rejected?.reason ?? null);
  });
}

const noteFailure = (ctx, doc, e) => tx(ctx.db, () => {
  ctx.db.prepare('UPDATE tax_documents SET attempts = attempts + 1 WHERE id = ? AND status = ?').run(doc.id, 'queued');
  liveRow(ctx, doc.id, { last_error: `${e.code}: ${e.message}`.slice(0, 300), last_http_status: e.extra?.httpStatus ?? null, attempts: (ctx.db.prepare('SELECT attempts FROM tax_live_docs WHERE document_id = ?').get(doc.id)?.attempts ?? 0) + 1 });
  log(ctx, 'submit', doc.id, 'error', e.code, e.message);
});

async function submitBatch(ctx, userId, client, signer, cfg, docs, out) {
  const signed = [];
  for (const d of docs) signed.push(await signedCopy(ctx, signer, cfg, d));
  const res = await client.submit(signed);
  if (res.batchError) {
    if (docs.length > 1) { // cannot tell which document was refused: send them one by one
      for (const d of docs) await submitBatch(ctx, userId, client, signer, cfg, [d], out);
      return;
    }
    const [d] = docs, code = res.batchError.code;
    if (/duplicate/i.test(code)) { applySubmitResult(ctx, userId, d, { submissionId: null }); out.submitted++; return; }
    applySubmitResult(ctx, userId, d, { submissionId: null, rejected: { code, reason: res.batchError.message || `ETA refused the submission (HTTP ${res.batchError.httpStatus})` } });
    out.rejected++;
    return;
  }
  const byInternal = new Map(docs.map((d) => [JSON.parse(d.payload).internalID, d]));
  for (const a of res.accepted) {
    const d = byInternal.get(a.internalId); if (!d) continue;
    byInternal.delete(a.internalId);
    applySubmitResult(ctx, userId, d, { submissionId: res.submissionId, longId: a.longId }); out.submitted++;
  }
  for (const r of res.rejected) {
    const d = byInternal.get(r.internalId); if (!d) continue;
    byInternal.delete(r.internalId);
    if (/duplicate/i.test(r.code)) { applySubmitResult(ctx, userId, d, { submissionId: res.submissionId }); out.submitted++; continue; } // already at ETA (lost response on an earlier try): the poll settles it
    applySubmitResult(ctx, userId, d, { submissionId: res.submissionId, rejected: { code: r.code, reason: [r.message, ...r.details].filter(Boolean).join('; ') || 'Rejected by ETA' } }); out.rejected++;
  }
  for (const d of byInternal.values()) { out.stillQueued++; noteFailure(ctx, d, new AppError(502, 'ETA_BAD_RESPONSE', 'ETA response did not mention this document')); } // neither accepted nor rejected
}

function applyPoll(ctx, userId, doc, r, cfg) {
  tx(ctx.db, () => {
    const cur = getDocumentRow(ctx.db, doc.id);
    if (cur.status !== 'submitted') return 'skip';
    const st = String(r.status).toLowerCase();
    if (st === 'valid') {
      moveDocument(ctx, cur, 'valid', { validated_at: ctx.now() }, null, userId);
      liveRow(ctx, doc.id, { long_id: r.longId, share_url: r.longId ? `${cfg.tax_eta_share_base}/documents/${doc.uuid}/share/${r.longId}` : null, last_error: null });
      log(ctx, 'poll', doc.id, 'valid');
      return 'valid';
    }
    if (st === 'invalid' || st === 'rejected') {
      const first = r.errors[0];
      const code = st === 'rejected' ? 'RECEIVER_REJECTED' : (first?.code ?? 'INVALID');
      const reason = st === 'rejected' ? 'The buyer rejected the document at the authority' : (r.errors.map((e) => [e.step, e.message].filter(Boolean).join(': ')).join('; ') || 'Invalid according to ETA');
      moveDocument(ctx, cur, 'rejected', { reject_code: code, reject_reason: reason, fix_hint: HINT }, reason, userId);
      log(ctx, 'poll', doc.id, 'rejected', code, reason);
      return 'rejected';
    }
    if (st === 'cancelled') {
      moveDocument(ctx, cur, 'cancelled', { cancelled_at: ctx.now(), cancel_reason: 'cancelled at the authority' }, 'cancelled at the authority', userId);
      log(ctx, 'poll', doc.id, 'cancelled');
      return 'cancelled';
    }
    return 'submitted'; // Submitted / Unknown: ask again next sync
  });
}

/** Submit queued live documents and poll submitted ones. Network failures leave documents where they are. */
export async function liveSync(ctx, user, { onlyId = null } = {}) {
  requirePerm(user, 'tax.submit');
  const { db } = ctx;
  const pick = (status) => db.prepare(`SELECT * FROM tax_documents WHERE adapter = ? AND status = ? ${onlyId ? 'AND id = ?' : ''} ORDER BY seq`).all(LIVE, status, ...(onlyId ? [onlyId] : []));
  const queued = pick('queued'), submitted = pick('submitted');
  const out = { submitted: 0, valid: 0, rejected: 0, stillQueued: 0, polled: submitted.length, error: null, busy: false };
  if (!queued.length && !submitted.length) return out;
  if (busy.has(db)) return { ...out, stillQueued: queued.length, busy: true };
  busy.add(db);
  try {
    const client = createEtaClient(ctx), cfg = client.cfg;
    const signer = queued.length ? await resolveSigner(ctx, cfg.tax_eta_signer) : null;
    const size = Math.max(1, Number(cfg.tax_eta_batch_size) || 1);
    let rest = queued;
    try {
      while (rest.length) {
        const seen = new Set(), batch = [], next = [];
        for (const d of rest) {
          const iid = JSON.parse(d.payload).internalID;
          if (batch.length < size && !seen.has(iid)) { seen.add(iid); batch.push(d); } else next.push(d);
        }
        await submitBatch(ctx, user.id, client, signer, cfg, batch, out);
        rest = next;
      }
      for (const d of submitted) {
        const cur = getDocumentRow(db, d.id);
        if (cur.status !== 'submitted') continue;
        const s = applyPoll(ctx, user.id, d, await client.details(d.uuid), cfg);
        if (s === 'valid') out.valid++; else if (s === 'rejected') out.rejected++;
      }
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      out.error = { code: e.code, message: e.message };
      for (const d of queued) if (getDocumentRow(db, d.id).status === 'queued') { out.stillQueued++; noteFailure(ctx, d, e); }
    }
    out.stillQueued = db.prepare("SELECT COUNT(*) AS n FROM tax_documents WHERE adapter = ? AND status = 'queued'").get(LIVE).n;
    audit(ctx, { userId: user.id, action: 'tax.live_sync', type: 'tax_document', newValue: { submitted: out.submitted, valid: out.valid, rejected: out.rejected, stillQueued: out.stillQueued, error: out.error?.code ?? null } });
    return out;
  } finally { busy.delete(db); }
}

/** Cancel a document at the authority (issuer), then locally through the normal cancellation path (window, reason, audit). */
export async function liveCancel(ctx, user, id, reason, localCancel) {
  requirePerm(user, 'tax.submit');
  if (typeof reason !== 'string' || !reason.trim()) throw new AppError(400, 'REASON_REQUIRED', 'Cancelling a document needs a reason');
  const d = getDocumentRow(ctx.db, id);
  if (d.adapter === LIVE && (d.status === 'submitted' || d.status === 'valid')) {
    const hours = Number(setting(ctx.db, 'tax_cancel_window_hours') ?? 72);
    if (ctx.now() > (d.validated_at ?? d.submitted_at) + hours * 3600000) {
      throw new AppError(409, 'CANCEL_WINDOW_CLOSED', `The cancellation window (${hours} h, configurable, UNVERIFIED) has passed; issue a credit note instead`);
    }
    const client = createEtaClient(ctx);
    await client.changeState(d.uuid, 'cancelled', reason.trim());
    tx(ctx.db, () => { liveRow(ctx, id, { cancel_confirmed: 1 }); log(ctx, 'cancel', id, 'ok'); });
  }
  return localCancel();
}

/** Receiver side: reject a document someone issued to us. Only calls the authority; we keep no table of received documents. */
export async function liveReject(ctx, user, { uuid, reason }) {
  requirePerm(user, 'tax.submit');
  if (typeof uuid !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(uuid)) throw new AppError(400, 'BAD_INPUT', 'uuid must be the authority document uuid');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 300) throw new AppError(400, 'REASON_REQUIRED', 'Rejecting a document needs a reason (at most 300 characters)');
  const client = createEtaClient(ctx);
  await client.changeState(uuid, 'rejected', reason.trim());
  tx(ctx.db, () => {
    audit(ctx, { userId: user.id, action: 'tax.live_reject', type: 'tax_document', reason: reason.trim(), newValue: { uuid } });
    log(ctx, 'reject', null, 'ok', null, uuid);
  });
  return { uuid, status: 'rejected' };
}

/** Connection test: token + signer probe. A success is remembered so the registration wizard can pass its sandbox step. */
export async function liveTest(ctx, user) {
  requirePerm(user, 'tax.configure');
  const set = (v) => ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('tax_eta_test_ok', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(v);
  try {
    const client = createEtaClient(ctx);
    await client.token(true);
    const signer = await resolveSigner(ctx, client.cfg.tax_eta_signer);
    await signer.sign({ canonical: canonicalString({ probe: 'connection-test' }), now: ctx.now(), detached: false });
    tx(ctx.db, () => { set(String(ctx.now())); audit(ctx, { userId: user.id, action: 'tax.live_test', type: 'tax_settings', newValue: { ok: true } }); log(ctx, 'test', null, 'ok'); });
    return { ok: true, token: true, signer: client.cfg.tax_eta_signer };
  } catch (e) {
    tx(ctx.db, () => { set('0'); audit(ctx, { userId: user.id, action: 'tax.live_test', type: 'tax_settings', newValue: { ok: false, code: e.code ?? 'ERROR' } }); log(ctx, 'test', null, 'error', e.code ?? 'ERROR', e.message); });
    throw e;
  }
}

// ---- configuration (no secrets here; credentials go through PUT /api/tax/secrets/:name) ----
const intIn = (v, lo, hi, f) => { if (!Number.isInteger(v) || v < lo || v > hi) throw new AppError(400, 'BAD_INPUT', `${f} must be a whole number between ${lo} and ${hi}`); return String(v); };
const FIELDS = {
  idUrl: ['tax_eta_id_url', (v) => checkUrl(v, 'idUrl')],
  apiUrl: ['tax_eta_api_url', (v) => checkUrl(v, 'apiUrl')],
  scope: ['tax_eta_scope', (v) => { if (typeof v !== 'string' || !/^[\w .:-]{1,100}$/.test(v)) throw new AppError(400, 'BAD_INPUT', 'scope is not valid'); return v; }],
  signer: ['tax_eta_signer', (v) => { if (typeof v !== 'string' || !/^[a-z][a-z0-9_]{0,30}$/.test(v)) throw new AppError(400, 'BAD_INPUT', 'signer must be a registered signer id'); return v; }],
  cmsDetached: ['tax_eta_cms_detached', (v) => { if (typeof v !== 'boolean') throw new AppError(400, 'BAD_INPUT', 'cmsDetached must be true or false'); return v ? '1' : '0'; }],
  batchSize: ['tax_eta_batch_size', (v) => intIn(v, 1, 100, 'batchSize')],
  maxRetries: ['tax_eta_max_retries', (v) => intIn(v, 0, 10, 'maxRetries')],
  backoffMs: ['tax_eta_backoff_ms', (v) => intIn(v, 0, 60000, 'backoffMs')],
  maxWaitMs: ['tax_eta_max_wait_ms', (v) => intIn(v, 0, 600000, 'maxWaitMs')],
  timeoutMs: ['tax_eta_timeout_ms', (v) => intIn(v, 100, 120000, 'timeoutMs')],
  onBehalfOf: ['tax_eta_onbehalfof', (v) => { if (typeof v !== 'string' || !/^[A-Za-z0-9-]{0,30}$/.test(v)) throw new AppError(400, 'BAD_INPUT', 'onBehalfOf must be a registration number'); return v; }],
  documentVersion: ['tax_eta_document_version', (v) => { if (typeof v !== 'string' || !/^\d+\.\d+$/.test(v)) throw new AppError(400, 'BAD_INPUT', 'documentVersion must look like 1.0'); return v; }],
  activityCode: ['tax_eta_activity_code', (v) => { if (typeof v !== 'string' || !/^[0-9]{0,10}$/.test(v)) throw new AppError(400, 'BAD_INPUT', 'activityCode must be digits'); return v; }],
};
export function getLiveConfig(ctx, user) {
  requirePerm(user, 'tax.view');
  const c = liveCfg(ctx.db);
  return {
    unverified: true, notice: 'LIVE ETA adapter: never verified against the real service. Check docs/eta-live.md before relying on it.',
    adapterActive: setting(ctx.db, 'tax_adapter') === LIVE,
    idUrl: c.tax_eta_id_url, apiUrl: c.tax_eta_api_url, scope: c.tax_eta_scope, signer: c.tax_eta_signer, cmsDetached: c.tax_eta_cms_detached === '1',
    batchSize: Number(c.tax_eta_batch_size), maxRetries: Number(c.tax_eta_max_retries), backoffMs: Number(c.tax_eta_backoff_ms), maxWaitMs: Number(c.tax_eta_max_wait_ms), timeoutMs: Number(c.tax_eta_timeout_ms),
    onBehalfOf: c.tax_eta_onbehalfof, documentVersion: c.tax_eta_document_version, activityCode: setting(ctx.db, 'tax_eta_activity_code') ?? '',
    lastTestOkAt: Number(c.tax_eta_test_ok) || null,
  };
}
export function updateLiveConfig(ctx, user, body) {
  requirePerm(user, 'tax.configure');
  const keys = Object.keys(body ?? {});
  if (!keys.length) throw new AppError(400, 'BAD_INPUT', 'Nothing to change');
  for (const k of keys) if (!FIELDS[k]) throw new AppError(400, 'BAD_INPUT', `Unknown setting "${k}"`);
  const next = Object.fromEntries(keys.map((k) => [FIELDS[k][0], FIELDS[k][1](body[k])]));
  tx(ctx.db, () => {
    const old = {};
    for (const [k, v] of Object.entries(next)) {
      old[k] = setting(ctx.db, k) ?? LIVE_DEFAULTS[k] ?? '';
      ctx.db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
    }
    if (next.tax_eta_id_url !== undefined || next.tax_eta_api_url !== undefined || next.tax_eta_signer !== undefined) ctx.db.prepare("UPDATE settings SET value = '0' WHERE key = 'tax_eta_test_ok'").run(); // a changed target needs a new test
    audit(ctx, { userId: user.id, action: 'tax.live_config', type: 'tax_settings', oldValue: old, newValue: next });
  });
  return getLiveConfig(ctx, user);
}

export function liveLog(ctx, user) {
  requirePerm(user, 'tax.view');
  return ctx.db.prepare('SELECT * FROM tax_live_log ORDER BY id DESC LIMIT 100').all();
}
export function liveDocument(ctx, user, id) {
  requirePerm(user, 'tax.view');
  return ctx.db.prepare('SELECT * FROM tax_live_docs WHERE document_id = ?').get(id) ?? null;
}

export const isLiveDoc = (db, id) => db.prepare('SELECT adapter FROM tax_documents WHERE id = ?').get(id)?.adapter === LIVE;
