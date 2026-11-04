import { AppError } from '../../../errors.js';
import { LIVE_DEFAULTS } from './eta_client.js';
import { fmtAmount } from '../util.js';

// Egypt ETA adapter, LIVE flavour: talks to a configurable base URL with OAuth2 client credentials, signs documents and polls
// their status. NEVER VERIFIED against the real ETA service (pre-production and production are unreachable from the build
// environment): every field name, endpoint, code and rule is UNVERIFIED. See docs/eta-live.md for the checklist.
//
// The adapter interface used by documents.js is synchronous and runs inside SQLite transactions, which cannot wait for the
// network. So buildDocument()/qr() are real and pure, while submit()/status() only report "unreachable": the document stays
// queued, and the asynchronous pump in eta_live_sync.js (POST /api/tax/sync, POST /api/tax/live/sync) does the network work
// outside any transaction and then applies the result with the normal state machine.
const money = (p) => Number(fmtAmount(p)); // integer piastres -> decimal pounds as ETA expects (UNVERIFIED: JSON numbers)
const addr = (street) => ({ branchId: '0', country: 'EG', governate: '', regionCity: '', street: street ?? '', buildingNumber: '' });

export default {
  id: 'eta_live',
  label: 'Egypt ETA (LIVE, UNVERIFIED against the real service)',
  mock: false,
  live: true,

  /** Pure. Signature, documentTypeVersion and taxpayerActivityCode are added at submission time (they are not part of the chained payload). */
  buildDocument(n) {
    const type = { invoice: 'I', credit_note: 'C', debit_note: 'D' }[n.kind];
    const iso = n.issuedAt.replace(/\.\d+Z$/, 'Z');
    return {
      format: 'ETA-LIVE-UNVERIFIED-1',
      issuer: { address: addr(n.seller.address), type: 'B', id: n.seller.taxId ?? '', name: n.seller.name },
      receiver: { address: addr(''), type: n.buyer.taxId ? 'B' : 'P', id: n.buyer.taxId ?? '', name: n.buyer.name },
      documentType: type, dateTimeIssued: iso, internalID: n.number, uuid: n.uuid,
      references: n.refUuid ? [n.refUuid] : [],
      invoiceLines: n.lines.map((l) => ({
        description: l.description, itemType: l.codeType ?? '', itemCode: l.code ?? '', unitType: 'EA', quantity: l.qty, internalCode: l.sku ?? '',
        salesTotal: money(l.net), total: money(l.net + l.vat), valueDifference: 0, totalTaxableFees: 0, netTotal: money(l.net), itemsDiscount: 0,
        unitValue: { currencySold: 'EGP', amountEGP: money(l.unitPrice) },
        taxableItems: [{ taxType: 'T1', amount: money(l.vat), subType: n.vatRateBp === 0 ? 'V001' : 'V009', rate: n.vatRateBp / 100 }], // sub-type codes UNVERIFIED
      })),
      totalDiscountAmount: 0, totalSalesAmount: money(n.totals.net), netAmount: money(n.totals.net),
      taxTotals: [{ taxType: 'T1', amount: money(n.totals.vat) }], totalAmount: money(n.totals.total),
      extraDiscountAmount: 0, totalItemsDiscountAmount: 0,
    };
  },

  submit() { throw new AppError(503, 'TAX_UNREACHABLE', 'Live ETA submission is asynchronous: the document stays queued until the next sync'); },
  status() { throw new AppError(503, 'TAX_UNREACHABLE', 'Live ETA status is polled asynchronously by the sync'); },
  cancel(ctx, doc) {
    // Only reached from cancelDocument() after the async call to ETA succeeded and was recorded (see eta_live_sync.js).
    const row = ctx.db.prepare('SELECT cancel_confirmed FROM tax_live_docs d JOIN tax_documents t ON t.id = d.document_id WHERE t.uuid = ?').get(doc.uuid);
    if (row?.cancel_confirmed) return { cancelled: true };
    throw new AppError(409, 'LIVE_ASYNC_REQUIRED', 'Cancelling a document that ETA already knows needs a live call: use POST /api/tax/documents/:id/cancel through the server, not the in-process service');
  },

  /** UNVERIFIED: the public share link needs the authority's long id, which only exists after validation (stored in tax_live_docs.share_url). */
  qr(doc) { return `${LIVE_DEFAULTS.tax_eta_share_base}/documents/${doc.uuid}/share/`; },
};
