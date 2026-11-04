import { randomUUID } from 'node:crypto';
import { AppError } from '../../../errors.js';
import { setting } from '../../../db.js';
import { isUp, commonChecks, rejection } from './base.js';
import { buildReceipt, mockSubmit } from '../../eta/adapter.js';

// Egypt ETA adapter: MOCK. The e-invoice document shape below is an UNVERIFIED sketch inspired by public
// descriptions of the ETA invoice JSON; it is NOT the official schema and is never sent anywhere.
// E-receipts wrap the existing receipt flow (src/modules/eta/adapter.js).
export default {
  id: 'eta_mock',
  label: 'Egypt ETA (MOCK, UNVERIFIED format)',
  mock: true,

  buildDocument(n) {
    const type = { invoice: 'I', credit_note: 'C', debit_note: 'D' }[n.kind];
    return {
      mock: true, format: 'ETA-MOCK-UNVERIFIED-1',
      documentType: type, internalID: n.number, uuid: n.uuid, dateTimeIssued: n.issuedAt,
      issuer: { type: 'B', id: n.seller.taxId ?? '', name: n.seller.name, address: n.seller.address },
      receiver: { type: n.buyer.taxId ? 'B' : 'P', id: n.buyer.taxId ?? '', name: n.buyer.name },
      currency: 'EGP',
      references: n.refUuid ? [n.refUuid] : [],
      invoiceLines: n.lines.map((l) => ({
        internalCode: l.sku ?? '', description: l.description, itemType: l.codeType ?? '', itemCode: l.code ?? '',
        quantity: l.qty, unitValue: l.unitPrice, netTotal: l.net,
        taxableItems: [{ taxType: 'T1', subType: n.vatRateCode, rateBp: n.vatRateBp, amount: l.vat }], total: l.net + l.vat,
      })),
      totalSalesAmount: n.totals.net, netAmount: n.totals.net,
      taxTotals: [{ taxType: 'T1', amount: n.totals.vat }], totalAmount: n.totals.total,
    };
  },

  submit(ctx, doc) {
    if (!isUp(ctx.db)) throw new AppError(503, 'TAX_UNREACHABLE', 'The (mock) tax authority is unreachable');
    return { accepted: true, submissionId: `MOCK-SUB-${randomUUID()}` };
  },

  status(ctx, doc) {
    if (!isUp(ctx.db)) throw new AppError(503, 'TAX_UNREACHABLE', 'The (mock) tax authority is unreachable');
    const lines = doc.invoiceLines;
    const bad = commonChecks(ctx, doc, {
      sellerId: doc.issuer.id, buyerId: doc.receiver.id,
      lines: lines.map((l) => ({ itemCode: l.itemCode, description: l.description })),
      total: doc.totalAmount, sumTotal: lines.reduce((s, l) => s + l.total, 0),
    });
    if (bad) return { status: 'rejected', ...bad };
    const pattern = setting(ctx.db, 'tax_regnum_pattern');
    if (pattern && !new RegExp(pattern).test(doc.issuer.id)) return { status: 'rejected', ...rejection('SELLER_TAX_ID_FORMAT') };
    return { status: 'valid' };
  },

  cancel(ctx) {
    if (!isUp(ctx.db)) throw new AppError(503, 'TAX_UNREACHABLE', 'The (mock) tax authority is unreachable');
    return { cancelled: true };
  },

  qr(doc, hash) {
    // UNVERIFIED placeholder payload, not the official ETA QR content.
    return `ETA-MOCK|${doc.uuid}|${doc.totalAmount}|${hash.slice(0, 16)}`;
  },

  // E-receipts wrap the existing receipt flow unchanged.
  receipt: { build: buildReceipt, submit: mockSubmit },
};
