import { randomUUID } from 'node:crypto';
import { AppError } from '../../../errors.js';
import { isUp, commonChecks, rejection } from './base.js';
import { fmtAmount } from '../util.js';

// ZATCA (Saudi Arabia) adapter: MOCK. The QR below follows the commonly documented Phase 1 simplified-invoice
// TLV layout (tags 1-5, base64). That layout is UNVERIFIED here: check the official ZATCA specification
// before relying on it. Phase 2 (signing, clearance, reporting APIs) is NOT implemented.
export function tlv(fields) {
  const parts = fields.map(([tag, value]) => {
    const v = Buffer.from(String(value), 'utf8');
    if (v.length > 255) throw new AppError(400, 'QR_FIELD_TOO_LONG', `QR field ${tag} is longer than 255 bytes`);
    return Buffer.concat([Buffer.from([tag, v.length]), v]);
  });
  return Buffer.concat(parts).toString('base64');
}

export function decodeTlv(b64) {
  const buf = Buffer.from(b64, 'base64'), out = {};
  for (let i = 0; i < buf.length;) {
    const tag = buf[i], len = buf[i + 1];
    out[tag] = buf.subarray(i + 2, i + 2 + len).toString('utf8');
    i += 2 + len;
  }
  return out;
}

export default {
  id: 'zatca_mock',
  label: 'ZATCA (MOCK, UNVERIFIED Phase 1 QR)',
  mock: true,

  buildDocument(n) {
    return {
      mock: true, format: 'ZATCA-MOCK-UNVERIFIED-1',
      invoiceTypeCode: { invoice: '388', credit_note: '381', debit_note: '383' }[n.kind],
      id: n.number, uuid: n.uuid, issueDateTime: n.issuedAt, currency: 'EGP', billingReference: n.refUuid ?? null,
      seller: { name: n.seller.name, vatNumber: n.seller.taxId ?? '', address: n.seller.address },
      buyer: { name: n.buyer.name, vatNumber: n.buyer.taxId ?? '' },
      lines: n.lines.map((l) => ({
        id: l.sku ?? '', name: l.description, itemCode: l.code ?? '', itemScheme: l.codeType ?? '', quantity: l.qty, unitPrice: l.unitPrice,
        net: l.net, vatRateBp: n.vatRateBp, vat: l.vat, total: l.net + l.vat,
      })),
      totals: { net: n.totals.net, vat: n.totals.vat, total: n.totals.total },
    };
  },

  submit(ctx) {
    if (!isUp(ctx.db)) throw new AppError(503, 'TAX_UNREACHABLE', 'The (mock) tax authority is unreachable');
    return { accepted: true, submissionId: `MOCK-ZATCA-${randomUUID()}` };
  },

  status(ctx, doc) {
    if (!isUp(ctx.db)) throw new AppError(503, 'TAX_UNREACHABLE', 'The (mock) tax authority is unreachable');
    const bad = commonChecks(ctx, doc, {
      sellerId: doc.seller.vatNumber, buyerId: doc.buyer.vatNumber,
      lines: doc.lines.map((l) => ({ itemCode: l.itemCode, description: l.name })),
      total: doc.totals.total, sumTotal: doc.lines.reduce((s, l) => s + l.total, 0),
    });
    if (bad) return { status: 'rejected', ...bad };
    if (!/^\d{15}$/.test(doc.seller.vatNumber)) return { status: 'rejected', ...rejection('SELLER_VAT_FORMAT_ZATCA') };
    return { status: 'valid' };
  },

  cancel(ctx) {
    if (!isUp(ctx.db)) throw new AppError(503, 'TAX_UNREACHABLE', 'The (mock) tax authority is unreachable');
    return { cancelled: true };
  },

  // Phase 1 fields (UNVERIFIED): 1 seller name, 2 VAT number, 3 timestamp, 4 total with VAT, 5 VAT amount.
  qr(doc) {
    return tlv([[1, doc.seller.name], [2, doc.seller.vatNumber], [3, doc.issueDateTime], [4, fmtAmount(doc.totals.total)], [5, fmtAmount(doc.totals.vat)]]);
  },
};
