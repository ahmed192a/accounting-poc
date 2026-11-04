import { requirePerm } from '../../permissions.js';
import { setting } from '../../db.js';
import { fmtMoney } from './common.js';
import { getInvoiceRow, balanceOf } from './invoices.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const L = {
  title: ['Tax invoice', 'فاتورة ضريبية'], draft: ['DRAFT - not issued', 'مسودة - غير مصدرة'], void: ['VOID', 'ملغاة'],
  number: ['Invoice no.', 'رقم الفاتورة'], date: ['Date', 'التاريخ'], due: ['Due date', 'تاريخ الاستحقاق'],
  customer: ['Customer', 'العميل'], taxId: ['Tax id', 'الرقم الضريبي'], phone: ['Phone', 'الهاتف'],
  desc: ['Description', 'الوصف'], qty: ['Qty', 'الكمية'], price: ['Unit price', 'سعر الوحدة'], amount: ['Amount', 'المبلغ'],
  subtotal: ['Subtotal (excl. VAT)', 'الإجمالي قبل الضريبة'], vat: ['VAT', 'ضريبة القيمة المضافة'], total: ['Total', 'الإجمالي'],
  credited: ['Credit notes', 'إشعارات دائنة'], paid: ['Paid', 'المدفوع'], balance: ['Balance due', 'المتبقي'],
  qrTitle: ['QR placeholder', 'مكان رمز الاستجابة السريعة'], qrNote: ['Not a valid e-invoice code (MOCK). Real ETA QR is not implemented.', 'ليس رمزا صالحا للفاتورة الإلكترونية (تجريبي). رمز مصلحة الضرائب الحقيقي غير منفذ.'],
  notes: ['Notes', 'ملاحظات'], hint: ['Use your browser print command (Ctrl+P) to print or save as PDF.', 'استخدم أمر الطباعة في المتصفح (Ctrl+P) للطباعة أو الحفظ بصيغة PDF.'],
};
const bi = (k) => `<span lang="en">${L[k][0]}</span> <span class="ar" lang="ar" dir="rtl">${L[k][1]}</span>`;

/** Printable bilingual invoice. Every piece of user text goes through esc(). Returned as JSON { html }: the server only speaks JSON. */
export function printInvoice(ctx, user, id, query = {}) {
  requirePerm(user, 'sales.view');
  const { db } = ctx;
  const inv = getInvoiceRow(db, id);
  const lang = query.lang === 'ar' ? 'ar' : 'en';
  const cust = inv.customer_id ? db.prepare('SELECT phone, tax_id, address FROM sales_customers WHERE id = ?').get(inv.customer_id) : null;
  const lines = JSON.parse(inv.lines);
  const biz = {
    name: setting(db, 'sales_business_name'), taxId: setting(db, 'sales_business_tax_id'), address: setting(db, 'sales_business_address'),
  };
  const rate = inv.subtotal ? Math.round((inv.vat / inv.subtotal) * 1000) / 10 : 0;
  const mark = inv.status === 'draft' ? bi('draft') : inv.status === 'void' ? bi('void') : '';
  const row = (l) => `<tr><td><bdi>${esc(l.description)}</bdi></td><td class="n">${esc(l.qty)}</td><td class="n">${fmtMoney(l.unitPrice)}</td><td class="n">${fmtMoney(l.qty * l.unitPrice)}</td></tr>`;
  const html = `<!doctype html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${esc(inv.number ?? 'Draft')} - ${esc(inv.customer)}</title>
<style>
body{font:14px/1.5 system-ui,"Segoe UI",Tahoma,sans-serif;color:#111;margin:0;padding:24px;background:#fff}
.sheet{max-width:780px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px} .ar{unicode-bidi:isolate;color:#444}
.top{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}
.mark{display:inline-block;border:2px solid #b42318;color:#b42318;padding:2px 10px;margin:8px 0;font-weight:700}
table{width:100%;border-collapse:collapse;margin-top:14px} th,td{padding:6px 8px;border-bottom:1px solid #ccc;text-align:start}
th{background:#f2f4f7;font-size:12px} td.n,th.n{text-align:end;font-variant-numeric:tabular-nums}
.meta td{border:0;padding:2px 8px 2px 0}
.totals{margin-inline-start:auto;width:60%} .totals td{border:0} .totals tr.g td{border-top:2px solid #111;font-weight:700}
.qr{width:150px;height:150px;border:2px dashed #666;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;font-size:11px;padding:6px;color:#444}
.foot{display:flex;gap:16px;align-items:flex-start;margin-top:22px} .hint{color:#667085;font-size:12px;margin-top:18px}
@page{size:A4;margin:14mm}
@media print{body{padding:0}.hint{display:none}.qr{border-color:#000}}
</style>
</head>
<body><div class="sheet">
<div class="top">
 <div><h1>${bi('title')}</h1>${biz.name ? `<div><b><bdi>${esc(biz.name)}</bdi></b></div>` : ''}${biz.taxId ? `<div>${bi('taxId')}: <bdi>${esc(biz.taxId)}</bdi></div>` : ''}${biz.address ? `<div><bdi>${esc(biz.address)}</bdi></div>` : ''}</div>
 <table class="meta" style="width:auto"><tr><td>${bi('number')}</td><td><b><bdi>${esc(inv.number ?? '-')}</bdi></b></td></tr>
 <tr><td>${bi('date')}</td><td>${esc(inv.issue_date)}</td></tr><tr><td>${bi('due')}</td><td>${esc(inv.due_date)}</td></tr></table>
</div>
${mark ? `<div class="mark">${mark}</div>` : ''}
<div style="margin-top:12px"><b>${bi('customer')}:</b> <bdi>${esc(inv.customer)}</bdi>${cust?.tax_id ? `<br>${bi('taxId')}: <bdi>${esc(cust.tax_id)}</bdi>` : ''}${cust?.phone ? `<br>${bi('phone')}: <bdi dir="ltr">${esc(cust.phone)}</bdi>` : ''}${cust?.address ? `<br><bdi>${esc(cust.address)}</bdi>` : ''}</div>
<table><thead><tr><th>${bi('desc')}</th><th class="n">${bi('qty')}</th><th class="n">${bi('price')}</th><th class="n">${bi('amount')}</th></tr></thead>
<tbody>${lines.map(row).join('')}</tbody></table>
<table class="totals">
<tr><td>${bi('subtotal')}</td><td class="n">${fmtMoney(inv.subtotal)}</td></tr>
<tr><td>${bi('vat')} (${esc(rate)}%)</td><td class="n">${fmtMoney(inv.vat)}</td></tr>
<tr class="g"><td>${bi('total')} (EGP)</td><td class="n">${fmtMoney(inv.total)}</td></tr>
${inv.amount_credited ? `<tr><td>${bi('credited')}</td><td class="n">-${fmtMoney(inv.amount_credited)}</td></tr>` : ''}
${inv.amount_paid ? `<tr><td>${bi('paid')}</td><td class="n">-${fmtMoney(inv.amount_paid)}</td></tr>` : ''}
${inv.status !== 'draft' && inv.status !== 'void' ? `<tr class="g"><td>${bi('balance')}</td><td class="n">${fmtMoney(balanceOf(inv))}</td></tr>` : ''}
</table>
<div class="foot"><div class="qr" role="img" aria-label="QR placeholder"><b>${bi('qrTitle')}</b><span>${bi('qrNote')}</span></div>
${inv.notes ? `<div><b>${bi('notes')}</b><br><bdi>${esc(inv.notes)}</bdi></div>` : ''}</div>
<div class="hint">${bi('hint')}</div>
</div></body></html>`;
  return { id: inv.id, number: inv.number, contentType: 'text/html; charset=utf-8', html };
}

