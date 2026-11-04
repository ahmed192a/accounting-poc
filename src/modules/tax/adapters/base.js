import { setting } from '../../../db.js';

// Tax-authority adapter interface (everything here is a MOCK; no real network call is ever made):
//   id, label, mock: true
//   buildDocument(neutral)      -> authority-shaped document object (pure; uuid and dates come from `neutral`)
//   submit(ctx, doc, meta)      -> { accepted: true, submissionId } ; throws AppError 503 TAX_UNREACHABLE when offline
//   status(ctx, doc, meta)      -> { status: 'submitted' | 'valid' | 'rejected', code?, reason? }
//   cancel(ctx, doc, reason)    -> { cancelled: true } ; throws 503 TAX_UNREACHABLE when offline
//   qr(doc, hash)               -> string payload for a QR code
// `neutral` is built by the tax service: { kind, number, uuid, issuedAt, seller, buyer, lines, totals, refUuid }.
// Real ETA / ZATCA schemas, signing, auth and endpoints are UNVERIFIED and NOT implemented.

// The mock connection switch is shared with the existing e-receipt mock (settings.eta_online).
export const isUp = (db) => setting(db, 'eta_online') === '1';

// Rejection catalogue: code -> hint (en/ar). Hints are advice for the mock, not official guidance.
export const REJECTIONS = {
  SELLER_TAX_ID_MISSING: { en: 'Seller tax registration number is missing.', ar: 'الرقم الضريبي للبائع مفقود.', hintEn: 'Open the registration wizard and enter the tax registration number, then reissue the document.', hintAr: 'افتح معالج التسجيل وأدخل الرقم الضريبي ثم أعد إصدار المستند.' },
  SELLER_TAX_ID_FORMAT: { en: 'Seller tax id has an invalid format.', ar: 'صيغة الرقم الضريبي للبائع غير صحيحة.', hintEn: 'Check the number against your registration certificate, correct it in settings, then reissue.', hintAr: 'راجع الرقم في شهادة التسجيل وصححه في الإعدادات ثم أعد الإصدار.' },
  BUYER_TAX_ID_REQUIRED: { en: 'Buyer tax id is required above the configured threshold.', ar: 'الرقم الضريبي للمشتري مطلوب فوق الحد المحدد.', hintEn: 'Record the customer tax id (Item codes and parties) and reissue the document.', hintAr: 'سجل الرقم الضريبي للعميل ثم أعد إصدار المستند.' },
  ITEM_CODE_MISSING: { en: 'One or more lines have no GS1/EGS item code.', ar: 'بعض البنود بدون كود GS1/EGS.', hintEn: 'Map the items to codes in Item codes, then reissue the document (a new document is chained; the rejected one stays as history).', hintAr: 'اربط الأصناف بأكوادها ثم أعد إصدار المستند (يُضاف مستند جديد والمرفوض يبقى في السجل).' },
  TOTALS_MISMATCH: { en: 'Line totals do not add up to the document totals.', ar: 'مجاميع البنود لا تطابق إجمالي المستند.', hintEn: 'Recreate the source invoice; totals must equal the sum of the lines.', hintAr: 'أعد إنشاء الفاتورة؛ يجب أن تساوي المجاميع مجموع البنود.' },
  SELLER_VAT_FORMAT_ZATCA: { en: 'Seller VAT number must be 15 digits (MOCK rule, UNVERIFIED).', ar: 'رقم ضريبة القيمة المضافة للبائع يجب أن يكون 15 رقما (قاعدة تجريبية).', hintEn: 'Correct the registration number in settings and reissue.', hintAr: 'صحح الرقم في الإعدادات ثم أعد الإصدار.' },
};

export function rejection(code) {
  const r = REJECTIONS[code];
  return { code, reason: r.en, fixHint: r.hintEn, reasonAr: r.ar, fixHintAr: r.hintAr };
}

/** Rules shared by both mock adapters: they run when status() is polled, like an asynchronous validation. */
export function commonChecks(ctx, doc, { sellerId, buyerId, lines, total, sumTotal }) {
  if (!sellerId) return rejection('SELLER_TAX_ID_MISSING');
  const missing = lines.filter((l) => !l.itemCode);
  if (missing.length) return { ...rejection('ITEM_CODE_MISSING'), reason: `${REJECTIONS.ITEM_CODE_MISSING.en} (${missing.map((l) => l.description).join(', ')})` };
  const threshold = Number(setting(ctx.db, 'tax_buyer_id_threshold') ?? 0);
  if (threshold > 0 && total >= threshold && !buyerId) return rejection('BUYER_TAX_ID_REQUIRED');
  if (sumTotal !== total) return rejection('TOTALS_MISMATCH');
  return null;
}
