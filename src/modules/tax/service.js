import { requirePerm } from '../../permissions.js';
import { cfg, hoursMs } from './config.js';
import { WARN_MS, verifyChainRaw } from './documents.js';
import { activeAdapter } from './adapters/index.js';
import { wizardView } from './wizard.js';
import { syncQueue } from '../eta/adapter.js';

export * from './config.js';
export * from './codes.js';
export * from './secrets.js';
export * from './vat.js';
export { wizardView, completeStep, resetWizard } from './wizard.js';
export { listDocuments, getDocument, verifyChain, retryDocument, cancelDocument, reissueDocument, createNote, exportDocuments, onInvoiceCreated, onCreditNoteCreated } from './documents.js';
import { syncAll } from './documents.js';

export const syncDocuments = (ctx, user) => syncAll(ctx, user, syncQueue);

/** Compliance dashboard: documents and the older e-receipt queue together. */
export function dashboard(ctx, user) {
  requirePerm(user, 'tax.view');
  const { db } = ctx, now = ctx.now();
  const docs = db.prepare("SELECT status, deadline_at FROM tax_documents WHERE superseded = 0 AND status IN ('queued','rejected')").all();
  const rec = db.prepare("SELECT status, deadline_at FROM receipts WHERE status IN ('queued','rejected')").all();
  const all = [...docs.map((d) => ({ ...d, src: 'invoice' })), ...rec.map((d) => ({ ...d, src: 'receipt' }))];
  const left = (r) => r.deadline_at - now;
  const last = Number(cfg(db, 'tax_last_sync')) || null;
  const missing = db.prepare('SELECT COUNT(*) AS n FROM items i WHERE i.eta_code IS NULL AND NOT EXISTS (SELECT 1 FROM tax_item_codes c WHERE c.sku = i.sku)').get().n;
  const chain = verifyChainRaw(db);
  return {
    mock: true,
    adapter: activeAdapter(db).id, adapterLabel: activeAdapter(db).label,
    queued: all.filter((r) => r.status === 'queued').length,
    dueSoon: all.filter((r) => r.status === 'queued' && left(r) >= 0 && left(r) <= WARN_MS).length,
    overdue: all.filter((r) => left(r) < 0).length,
    rejected: all.filter((r) => r.status === 'rejected').length,
    submittedAwaiting: db.prepare("SELECT COUNT(*) AS n FROM tax_documents WHERE status = 'submitted'").get().n,
    lastSync: last, itemsWithoutCodes: missing,
    chainOk: chain.ok, documents: chain.checked,
    wizardState: wizardView(ctx, user).state,
    cancelWindowHours: hoursMs(db, 'tax_cancel_window_hours') / 3600000,
  };
}

export function widgets(ctx, user) {
  return user.permissions.has('tax.view') ? { tax: dashboard(ctx, user) } : {};
}
