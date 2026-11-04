// Sales UI: quick sale (discount, park), receivables, invoices, customers, aging, quotes, payments, catalogue.
export default function register(App) {
  const { t, esc, money, has, api, run, toast, state } = App;
  const P = { page: 'sales', pageTitleKey: 'salesPage' };

  App.i18n.add('en', {
    salesPage: 'Sales',
    receivables: 'Receivables', pay: 'Mark paid',
    quickSale: 'Quick sale', total: 'Total incl. VAT', complete: 'Complete sale', codeMissing: 'no item code', saleDone: 'Sale posted.',
    receiptStatus: 'Receipt', chooseItems: 'Add a quantity to at least one item.',
    st_submitted: 'Submitted', st_queued: 'Queued', st_rejected: 'Rejected',
    invoice: 'New invoice', customer: 'Customer', desc: 'Description', qty: 'Qty', unitPrice: 'Unit price (EGP)',
    salesDiscount: 'Discount', salesPercent: 'Percent', salesFixed: 'Fixed (EGP)', salesPark: 'Hold sale', salesHeld: 'Held sales', salesResume: 'Complete', salesDiscard: 'Discard',
    salesDraft: 'Save as draft', salesOverride: 'Credit-limit override reason', salesIssue: 'Issue',
    salesInvoices: 'Invoices', salesStatus: 'Status', salesBalance: 'Balance', salesPrint: 'Print', salesCredit: 'Credit note', salesVoid: 'Void', salesReason: 'Reason',
    salesCreditAmt: 'Credit amount before VAT (EGP)',
    st_draft: 'Draft', st_issued: 'Issued', st_partially_paid: 'Partly paid', st_paid: 'Paid', st_void: 'Void', st_open: 'Open', st_accepted: 'Accepted', st_declined: 'Declined', st_converted: 'Converted', st_expired: 'Expired',
    salesCustomers: 'Customers', salesName: 'Name', salesPhone: 'Phone', salesTaxId: 'Tax id', salesAddress: 'Address', salesLimit: 'Credit limit (EGP, 0 = none)', salesNotes: 'Notes',
    salesAdd: 'Add', salesStatement: 'Statement', salesRemind: 'WhatsApp reminder', salesRemindAr: 'Arabic', salesRemindEn: 'English', salesOpenWa: 'Open WhatsApp',
    salesAging: 'Receivables aging', salesCurrent: 'Current', salesD1: '1-30', salesD2: '31-60', salesD3: '61+', salesOnlyView: 'View only',
    salesQuotes: 'Quotes', salesValid: 'Valid until', salesConvert: 'Convert to invoice', salesNewQuote: 'New quote',
    salesPayments: 'Customer payment', salesPayAmt: 'Amount (EGP)', salesMethod: 'Method', salesCounter: 'Counter', salesBank: 'Bank transfer', salesWallet: 'Mobile wallet', salesRecord: 'Record payment', salesOldest: 'Allocated oldest invoice first.',
    salesCatalogue: 'Item catalogue', salesSku: 'SKU', salesPrice: 'Price (EGP)', salesActive: 'Active', salesRefund: 'Refund', salesRecent: 'Recent till sales', salesRefunded: 'Refunded',
    salesClose: 'Close', salesDebit: 'Debit', salesCreditCol: 'Credit', salesNoPhone: 'No phone number',
  });
  App.i18n.add('ar', {
    salesPage: 'المبيعات',
    receivables: 'مستحقات العملاء', pay: 'تسجيل السداد',
    quickSale: 'بيع سريع', total: 'الإجمالي شامل الضريبة', complete: 'إتمام البيع', codeMissing: 'بدون كود صنف', saleDone: 'تم تسجيل البيع.',
    receiptStatus: 'الإيصال', chooseItems: 'أضف كمية لصنف واحد على الأقل.',
    st_submitted: 'تم الإرسال', st_queued: 'في الانتظار', st_rejected: 'مرفوض',
    invoice: 'فاتورة جديدة', customer: 'العميل', desc: 'الوصف', qty: 'الكمية', unitPrice: 'سعر الوحدة (ج.م)',
    salesDiscount: 'خصم', salesPercent: 'نسبة مئوية', salesFixed: 'مبلغ ثابت (ج.م)', salesPark: 'تعليق البيع', salesHeld: 'مبيعات معلقة', salesResume: 'إتمام', salesDiscard: 'إلغاء',
    salesDraft: 'حفظ كمسودة', salesOverride: 'سبب تجاوز حد الائتمان', salesIssue: 'إصدار',
    salesInvoices: 'الفواتير', salesStatus: 'الحالة', salesBalance: 'المتبقي', salesPrint: 'طباعة', salesCredit: 'إشعار دائن', salesVoid: 'إلغاء', salesReason: 'السبب',
    salesCreditAmt: 'مبلغ الإشعار قبل الضريبة (ج.م)',
    st_draft: 'مسودة', st_issued: 'صادرة', st_partially_paid: 'مدفوعة جزئيا', st_paid: 'مدفوعة', st_void: 'ملغاة', st_open: 'مفتوح', st_accepted: 'مقبول', st_declined: 'مرفوض', st_converted: 'تم التحويل', st_expired: 'منتهي',
    salesCustomers: 'العملاء', salesName: 'الاسم', salesPhone: 'الهاتف', salesTaxId: 'الرقم الضريبي', salesAddress: 'العنوان', salesLimit: 'حد الائتمان (ج.م، 0 = بلا حد)', salesNotes: 'ملاحظات',
    salesAdd: 'إضافة', salesStatement: 'كشف الحساب', salesRemind: 'تذكير واتساب', salesRemindAr: 'عربي', salesRemindEn: 'إنجليزي', salesOpenWa: 'فتح واتساب',
    salesAging: 'أعمار الديون', salesCurrent: 'غير مستحق', salesD1: '١-٣٠', salesD2: '٣١-٦٠', salesD3: '+٦١', salesOnlyView: 'عرض فقط',
    salesQuotes: 'عروض الأسعار', salesValid: 'صالح حتى', salesConvert: 'تحويل إلى فاتورة', salesNewQuote: 'عرض سعر جديد',
    salesPayments: 'دفعة عميل', salesPayAmt: 'المبلغ (ج.م)', salesMethod: 'الطريقة', salesCounter: 'عند الكاشير', salesBank: 'تحويل بنكي', salesWallet: 'محفظة إلكترونية', salesRecord: 'تسجيل الدفعة', salesOldest: 'تم التوزيع على الأقدم أولا.',
    salesCatalogue: 'كتالوج الأصناف', salesSku: 'الكود', salesPrice: 'السعر (ج.م)', salesActive: 'مفعل', salesRefund: 'استرداد', salesRecent: 'آخر مبيعات الكاشير', salesRefunded: 'مسترد',
    salesClose: 'إغلاق', salesDebit: 'مدين', salesCreditCol: 'دائن', salesNoPhone: 'لا يوجد رقم هاتف',
  });

  let items = [], customers = [], aging = null, quotes = [], parked = [], invoices = [], recent = [];
  let saleMsg = null, statement = null, reminder = null;
  const val = (i) => document.getElementById(i)?.value ?? '';
  const chip = (s) => `<span class="chip ${s === 'paid' || s === 'converted' || s === 'accepted' ? 'good' : s === 'void' || s === 'declined' || s === 'expired' ? 'mute' : s === 'draft' ? '' : 'warn'}">${t('st_' + s)}</span>`;
  const name = (i) => (state.lang === 'ar' ? i.name_ar : i.name);

  // All card data arrives with /api/home (widget salesDesk): no extra requests, nothing stale after a user switch.
  App.onLoad(async (home) => {
    const d = home.widgets.salesDesk ?? {};
    ({ items = [], customers = [], aging = null, quotes = [], parked = [], invoices = [], recent = [] } = d);
  });
  App.onUserChange(() => { saleMsg = null; statement = null; reminder = null; });

  const sellable = () => items.filter((i) => i.active !== false);

  App.addCard({ id: 'sales.quick', area: 'main', order: 10, permission: 'sales.create', ...P, render: () => `<div class="card"><h2>${t('quickSale')}</h2>
  <table>${sellable().map((i) => `<tr><td>${esc(name(i))}${i.eta_code ? '' : ` <span class="chip warn">${t('codeMissing')}</span>`}</td>
  <td class="num">${money(i.price)}</td><td class="num"><input class="qty" type="number" min="0" value="0" data-act="qty" data-sku="${esc(i.sku)}" data-price="${i.price}"></td></tr>`).join('')}</table>
  ${has('sales.discount') ? `<div class="row"><label>${t('salesDiscount')}</label><select id="sale-dtype"><option value="">-</option><option value="percent">${t('salesPercent')}</option><option value="fixed">${t('salesFixed')}</option></select><input class="qty" type="number" min="0" step="0.01" id="sale-dval"></div>` : ''}
  <div class="row"><span>${t('total')}: <b id="saleTotal">${money(0)}</b></span><button class="primary" data-act="sale">${t('complete')}</button><button data-act="sales-park">${t('salesPark')}</button></div>
  ${saleMsg ? `<div class="note ${saleMsg.cls}">${esc(saleMsg.text)}</div>` : ''}</div>` });

  App.addCard({ id: 'sales.parked', area: 'main', order: 12, permission: 'sales.create', ...P, render: () => !parked.length ? '' : `<div class="card"><h2>${t('salesHeld')}</h2><table>${parked.map((p) => `
  <tr><td>${esc(p.label)}<div class="sub">${p.items.map((i) => `${esc(i.sku)} x${i.qty}`).join(', ')}</div></td>
  <td class="num"><button class="small" data-act="sales-pk-go" data-id="${p.id}">${t('salesResume')}</button> <button class="small" data-act="sales-pk-del" data-id="${p.id}">${t('salesDiscard')}</button></td></tr>`).join('')}</table></div>` });

  App.addCard({ id: 'sales.receivables', area: 'main', order: 40, ...P, render: ({ widgets: w }) => !w.receivables || !w.receivables.invoices.length ? '' : `<div class="card"><h2>${t('receivables')}</h2><table>${w.receivables.invoices.map((i) => `
  <tr><td>${esc(i.number)} ${esc(i.customer)}<div class="sub">${esc(i.due_date)}</div></td><td class="num">${money(i.total)}</td>
  <td class="num">${has('sales.create') ? `<button class="small" data-act="pay" data-id="${i.id}">${t('pay')}</button>` : ''}</td></tr>`).join('')}</table></div>` });

  App.addCard({ id: 'sales.invoice', area: 'main', order: 50, permission: 'sales.create', ...P, render: () => `<div class="card"><h2>${t('invoice')}</h2>
  <div class="row"><input type="text" id="inv-customer" list="sales-cust-list" placeholder="${t('customer')}"><datalist id="sales-cust-list">${customers.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist></div>
  <div class="row"><input type="text" id="inv-desc" placeholder="${t('desc')}"><input class="qty" type="number" min="1" value="1" id="inv-qty" title="${t('qty')}"><input class="qty" type="number" min="0" step="0.01" id="inv-price" placeholder="${t('unitPrice')}" title="${t('unitPrice')}"></div>
  ${has('sales.credit') ? `<div class="row"><input type="text" id="inv-override" placeholder="${t('salesOverride')}"></div>` : ''}
  <div class="row"><button class="primary" data-act="invoice">${t('create')}</button><button data-act="sales-draft">${t('salesDraft')}</button></div></div>` });

  const invActions = (i) => [
    i.status === 'draft' && has('sales.create') ? `<button class="small" data-act="sales-issue" data-id="${i.id}">${t('salesIssue')}</button>` : '',
    `<button class="small" data-act="sales-print" data-id="${i.id}">${t('salesPrint')}</button>`,
    ['issued', 'partially_paid', 'paid'].includes(i.status) && has('sales.credit') ? `<button class="small" data-act="sales-cn" data-id="${i.id}">${t('salesCredit')}</button>` : '',
    ['draft', 'issued'].includes(i.status) && has(i.status === 'draft' ? 'sales.create' : 'sales.credit') ? `<button class="small" data-act="sales-void" data-id="${i.id}">${t('salesVoid')}</button>` : '',
  ].join(' ');
  App.addCard({ id: 'sales.invoices', area: 'main', order: 52, permission: 'sales.view', ...P, render: () => !invoices.length ? '' : `<div class="card"><h2>${t('salesInvoices')}</h2>
  <table>${invoices.slice(0, 12).map((i) => `<tr><td>${esc(i.number ?? '-')} ${esc(i.customer)}<div class="sub">${esc(i.due_date)}</div></td><td>${chip(i.status)}</td><td class="num">${money(i.balance)}</td><td>${invActions(i)}</td></tr>`).join('')}</table>
  ${has('sales.credit') ? `<div class="row"><input type="text" id="sales-reason" placeholder="${t('salesReason')}"><input class="qty" type="number" min="0" step="0.01" id="sales-cn-amt" placeholder="${t('salesCreditAmt')}" title="${t('salesCreditAmt')}"></div>` : ''}</div>` });

  App.addCard({ id: 'sales.recent', area: 'main', order: 54, permission: 'sales.view', ...P, render: () => !recent.length ? '' : `<div class="card"><h2>${t('salesRecent')}</h2><table>${recent.slice(0, 8).map((s) => `
  <tr><td>#${s.id}</td><td class="num">${money(s.total)}</td><td>${s.refunded ? `<span class="chip mute">${t('salesRefunded')}</span>` : has('sales.credit') ? `<button class="small" data-act="sales-refund" data-id="${s.id}">${t('salesRefund')}</button>` : ''}</td></tr>`).join('')}</table></div>` });

  const reminderBox = () => !reminder ? '' : `<div class="note ${reminder.error ? 'warn' : 'good'}">${reminder.error ? esc(reminder.error) : `<div style="white-space:pre-wrap">${esc(reminder.message)}</div><a href="${esc(reminder.link)}" target="_blank" rel="noopener noreferrer">${t('salesOpenWa')}</a>`}</div>`;
  const statementBox = () => !statement ? '' : `<div class="note"><b>${esc(statement.customer.name)}</b> <button class="small" data-act="sales-st-close">${t('salesClose')}</button>
  <table><tr><th></th><th class="num">${t('salesDebit')}</th><th class="num">${t('salesCreditCol')}</th><th class="num">${t('salesBalance')}</th></tr>${statement.lines.map((l) => `<tr><td>${esc(l.date)} ${esc(l.number)}</td><td class="num">${l.debit ? money(l.debit) : ''}</td><td class="num">${l.credit ? money(l.credit) : ''}</td><td class="num">${money(l.balance)}</td></tr>`).join('')}</table></div>`;
  App.addCard({ id: 'sales.customers', area: 'main', order: 56, permission: 'sales.view', ...P, render: () => `<div class="card"><h2>${t('salesCustomers')}</h2>
  <table>${customers.map((c) => `<tr><td>${esc(c.name)}<div class="sub">${esc(c.phone || t('salesNoPhone'))}${c.creditLimit ? ` · ${money(c.creditLimit)}` : ''}</div></td><td class="num">${money(c.balance)}</td>
  <td><button class="small" data-act="sales-st" data-id="${c.id}">${t('salesStatement')}</button> <button class="small" data-act="sales-wa" data-id="${c.id}" data-lang="${state.lang === 'ar' ? 'ar' : 'en'}">${t('salesRemind')}</button></td></tr>`).join('')}</table>
  ${statementBox()}${reminderBox()}
  ${has('customers.manage') ? `<div class="row"><input type="text" id="cus-name" placeholder="${t('salesName')}"><input type="text" id="cus-phone" placeholder="${t('salesPhone')}"></div>
  <div class="row"><input type="text" id="cus-tax" placeholder="${t('salesTaxId')}"><input type="number" min="0" step="0.01" id="cus-limit" placeholder="${t('salesLimit')}" title="${t('salesLimit')}"></div>
  <div class="row"><input type="text" id="cus-addr" placeholder="${t('salesAddress')}"><button class="primary" data-act="sales-cus-add">${t('salesAdd')}</button></div>` : ''}</div>` });

  App.addCard({ id: 'sales.aging', area: 'main', order: 58, permission: 'sales.view', ...P, render: () => !aging || !aging.rows.length ? '' : `<div class="card"><h2>${t('salesAging')}</h2>
  <table><tr><th>${t('customer')}</th><th class="num">${t('salesCurrent')}</th><th class="num">${t('salesD1')}</th><th class="num">${t('salesD2')}</th><th class="num">${t('salesD3')}</th></tr>
  ${aging.rows.map((r) => `<tr><td>${esc(r.customer)}</td><td class="num">${money(r.current)}</td><td class="num">${money(r.d1_30)}</td><td class="num">${money(r.d31_60)}</td><td class="num">${money(r.d61_plus)}</td></tr>`).join('')}
  <tr><th>${t('total')}</th><th class="num">${money(aging.totals.current)}</th><th class="num">${money(aging.totals.d1_30)}</th><th class="num">${money(aging.totals.d31_60)}</th><th class="num">${money(aging.totals.d61_plus)}</th></tr></table></div>` });

  App.addCard({ id: 'sales.quotes', area: 'main', order: 60, permission: 'sales.view', ...P, render: () => `<div class="card"><h2>${t('salesQuotes')}</h2>
  <table>${quotes.slice(0, 8).map((q) => `<tr><td>${esc(q.number)} ${esc(q.customer)}<div class="sub">${t('salesValid')} ${esc(q.valid_until)}</div></td><td class="num">${money(q.total)}</td><td>${chip(q.status)}</td>
  <td>${has('quotes.manage') && has('sales.create') && ['open', 'accepted'].includes(q.status) ? `<button class="small" data-act="sales-q-conv" data-id="${q.id}">${t('salesConvert')}</button>` : ''}</td></tr>`).join('')}</table>
  ${has('quotes.manage') ? `<div class="row"><input type="text" id="q-customer" list="sales-cust-list" placeholder="${t('customer')}"><input type="text" id="q-desc" placeholder="${t('desc')}"><input class="qty" type="number" min="1" value="1" id="q-qty"><input class="qty" type="number" min="0" step="0.01" id="q-price" placeholder="${t('unitPrice')}"></div>
  <div class="row"><label>${t('salesValid')}</label><input type="date" id="q-valid"><button class="primary" data-act="sales-q-add">${t('salesNewQuote')}</button></div>` : ''}</div>` });

  App.addCard({ id: 'sales.payments', area: 'main', order: 62, permission: 'sales.create', ...P, render: () => `<div class="card"><h2>${t('salesPayments')}</h2>
  <div class="row"><select id="pay-cust">${customers.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><input class="qty" type="number" min="0" step="0.01" id="pay-amt" placeholder="${t('salesPayAmt')}" title="${t('salesPayAmt')}">
  <select id="pay-method"><option value="cash">${t('salesCounter')}</option><option value="bank">${t('salesBank')}</option><option value="wallet">${t('salesWallet')}</option></select></div>
  <div class="row"><span class="sub">${t('salesOldest')}</span><button class="primary" data-act="sales-pay-add">${t('salesRecord')}</button></div></div>` });

  App.addCard({ id: 'sales.catalogue', area: 'main', order: 64, permission: 'sales.configure', ...P, render: () => `<div class="card"><h2>${t('salesCatalogue')}</h2>
  <table>${items.map((i) => `<tr><td>${esc(i.sku)}<div class="sub">${esc(name(i))}</div></td><td class="num"><input class="qty" type="number" min="0" step="0.01" value="${(i.price / 100).toFixed(2)}" data-act="sales-price" data-sku="${esc(i.sku)}"></td>
  <td><label><input type="checkbox" data-act="sales-active" data-sku="${esc(i.sku)}" ${i.active !== false ? 'checked' : ''}> ${t('salesActive')}</label></td></tr>`).join('')}</table>
  <div class="row"><input type="text" id="it-sku" placeholder="${t('salesSku')}"><input type="text" id="it-name" placeholder="${t('salesName')}"><input class="qty" type="number" min="0" step="0.01" id="it-price" placeholder="${t('salesPrice')}"><button class="primary" data-act="sales-it-add">${t('salesAdd')}</button></div></div>` });

  const cart = () => [...document.querySelectorAll('input[data-sku][data-price]')].filter((i) => Number(i.value) > 0).map((i) => ({ sku: i.dataset.sku, qty: Number(i.value) }));
  const discount = () => {
    const type = val('sale-dtype'), v = Number(val('sale-dval'));
    if (!type || !v) return undefined;
    return { type, value: type === 'fixed' ? App.toPiastres(val('sale-dval')) : v };
  };

  App.onInput('qty', () => {
    const sum = [...document.querySelectorAll('input[data-sku][data-price]')].reduce((s, i) => s + Number(i.value || 0) * Number(i.dataset.price), 0);
    const vat = Math.round((sum * state.home.vatRateBp) / 10000);
    document.getElementById('saleTotal').textContent = money(sum + vat);
  });

  App.on('pay', (b) => run(() => api('POST', `/api/invoices/${b.dataset.id}/pay`), t('saved')));

  App.on('sale', () => {
    const picked = cart();
    if (!picked.length) return toast(t('chooseItems'));
    run(async () => {
      const r = await api('POST', '/api/sales/quick', { items: picked, discount: discount() });
      const rej = r.receipt.status === 'rejected';
      saleMsg = { cls: rej ? 'bad' : r.receipt.status === 'queued' ? 'warn' : 'good', text: `${t('saleDone')} ${money(r.sale.total)} · ${t('receiptStatus')}: ${t('st_' + r.receipt.status)}` };
    });
  });
  App.on('sales-park', () => { const picked = cart(); if (!picked.length) return toast(t('chooseItems')); run(() => api('POST', '/api/sales/parked', { items: picked, discount: discount() }), t('saved')); });
  App.on('sales-pk-go', (b) => run(() => api('POST', `/api/sales/parked/${b.dataset.id}/checkout`), t('saleDone')));
  App.on('sales-pk-del', (b) => run(() => api('DELETE', `/api/sales/parked/${b.dataset.id}`), t('saved')));

  const invBody = (draft) => {
    const o = has('sales.credit') ? val('inv-override').trim() : '';
    return { customer: val('inv-customer'), draft, creditOverride: o ? { reason: o } : undefined, lines: [{ description: val('inv-desc'), qty: Number(val('inv-qty')), unitPrice: App.toPiastres(val('inv-price')) }] };
  };
  App.on('invoice', () => run(() => api('POST', '/api/invoices', invBody(false)), t('saved')));
  App.on('sales-draft', () => run(() => api('POST', '/api/invoices', invBody(true)), t('saved')));
  App.on('sales-issue', (b) => run(() => api('POST', `/api/invoices/${b.dataset.id}/issue`, {}), t('saved')));
  App.on('sales-void', (b) => run(() => api('POST', `/api/invoices/${b.dataset.id}/void`, { reason: val('sales-reason') }), t('saved')));
  App.on('sales-cn', (b) => run(() => api('POST', `/api/invoices/${b.dataset.id}/credit-notes`, { amount: App.toPiastres(val('sales-cn-amt')), reason: val('sales-reason') }), t('saved')));
  App.on('sales-refund', (b) => run(() => api('POST', `/api/sales/${b.dataset.id}/refund`, { reason: val('sales-reason') || prompt(t('salesReason')) || '' }), t('saved')));

  // Printing: the API answers JSON { html }; open it in a new window and call print.
  App.on('sales-print', async (b) => {
    try {
      const r = await api('GET', `/api/invoices/${b.dataset.id}/print?lang=${state.lang === 'ar' ? 'ar' : 'en'}`);
      const w = window.open('', '_blank');
      if (!w) return toast('Popup blocked');
      w.document.open(); w.document.write(r.html); w.document.close(); w.focus();
      setTimeout(() => w.print(), 300);
    } catch (e) { toast(e.message); }
  });

  App.on('sales-st', async (b) => { try { statement = await api('GET', `/api/customers/${b.dataset.id}/statement`); reminder = null; App.render(); } catch (e) { toast(e.message); } });
  App.on('sales-st-close', () => { statement = null; App.render(); });
  App.on('sales-wa', async (b) => {
    try { reminder = await api('GET', `/api/customers/${b.dataset.id}/reminder?lang=${b.dataset.lang}`); } catch (e) { reminder = { error: e.message }; }
    statement = null; App.render();
  });
  App.on('sales-cus-add', () => run(() => api('POST', '/api/customers', { name: val('cus-name'), phone: val('cus-phone') || null, taxId: val('cus-tax') || null, address: val('cus-addr') || null, creditLimit: val('cus-limit') ? App.toPiastres(val('cus-limit')) : 0 }), t('saved')));

  App.on('sales-q-add', () => run(() => api('POST', '/api/quotes', { customer: val('q-customer'), validUntil: val('q-valid') || undefined, lines: [{ description: val('q-desc'), qty: Number(val('q-qty')), unitPrice: App.toPiastres(val('q-price')) }] }), t('saved')));
  App.on('sales-q-conv', (b) => run(() => api('POST', `/api/quotes/${b.dataset.id}/convert`, {}), t('saved')));

  App.on('sales-pay-add', () => run(() => api('POST', '/api/payments', { customerId: Number(val('pay-cust')), amount: App.toPiastres(val('pay-amt')), method: val('pay-method') }), t('saved')));

  App.on('sales-it-add', () => run(() => api('POST', '/api/items', { sku: val('it-sku'), name: val('it-name'), price: App.toPiastres(val('it-price')) }), t('saved')));
  App.onChange('sales-price', (el) => run(() => api('PATCH', `/api/items/${encodeURIComponent(el.dataset.sku)}`, { price: App.toPiastres(el.value) }), t('saved')));
  App.onChange('sales-active', (el) => run(() => api('PATCH', `/api/items/${encodeURIComponent(el.dataset.sku)}`, { active: el.checked }), t('saved')));
}
