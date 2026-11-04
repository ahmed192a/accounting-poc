// Sales: quick sale, new invoice, open invoices (receivables list).
export default function register(App) {
  const { t, esc, money, has, api, run, toast, state } = App;

  App.i18n.add('en', {
    receivables: 'Receivables', pay: 'Mark paid',
    quickSale: 'Quick sale', total: 'Total incl. VAT', complete: 'Complete sale', codeMissing: 'no item code', saleDone: 'Sale posted.',
    receiptStatus: 'Receipt', chooseItems: 'Add a quantity to at least one item.',
    st_submitted: 'Submitted', st_queued: 'Queued', st_rejected: 'Rejected',
    invoice: 'New invoice', customer: 'Customer', desc: 'Description', qty: 'Qty', unitPrice: 'Unit price (EGP)',
  });
  App.i18n.add('ar', {
    receivables: 'مستحقات العملاء', pay: 'تسجيل السداد',
    quickSale: 'بيع سريع', total: 'الإجمالي شامل الضريبة', complete: 'إتمام البيع', codeMissing: 'بدون كود صنف', saleDone: 'تم تسجيل البيع.',
    receiptStatus: 'الإيصال', chooseItems: 'أضف كمية لصنف واحد على الأقل.',
    st_submitted: 'تم الإرسال', st_queued: 'في الانتظار', st_rejected: 'مرفوض',
    invoice: 'فاتورة جديدة', customer: 'العميل', desc: 'الوصف', qty: 'الكمية', unitPrice: 'سعر الوحدة (ج.م)',
  });

  let items = [];
  let saleMsg = null;
  const val = (i) => document.getElementById(i)?.value ?? '';

  App.onLoad(async () => { items = has('sales.create') ? await api('GET', '/api/items') : []; });
  App.onUserChange(() => { saleMsg = null; });

  App.addCard({ id: 'sales.quick', area: 'main', order: 10, permission: 'sales.create', render: () => `<div class="card"><h2>${t('quickSale')}</h2>
  <table>${items.map((i) => `<tr><td>${esc(state.lang === 'ar' ? i.name_ar : i.name)}${i.eta_code ? '' : ` <span class="chip warn">${t('codeMissing')}</span>`}</td>
  <td class="num">${money(i.price)}</td><td class="num"><input class="qty" type="number" min="0" value="0" data-act="qty" data-sku="${esc(i.sku)}" data-price="${i.price}"></td></tr>`).join('')}</table>
  <div class="row"><span>${t('total')}: <b id="saleTotal">${money(0)}</b></span><button class="primary" data-act="sale">${t('complete')}</button></div>
  ${saleMsg ? `<div class="note ${saleMsg.cls}">${esc(saleMsg.text)}</div>` : ''}</div>` });

  App.addCard({ id: 'sales.receivables', area: 'main', order: 40, render: ({ widgets: w }) => !w.receivables || !w.receivables.invoices.length ? '' : `<div class="card"><h2>${t('receivables')}</h2><table>${w.receivables.invoices.map((i) => `
  <tr><td>${esc(i.number)} ${esc(i.customer)}<div class="sub">${esc(i.due_date)}</div></td><td class="num">${money(i.total)}</td>
  <td class="num">${has('sales.create') ? `<button class="small" data-act="pay" data-id="${i.id}">${t('pay')}</button>` : ''}</td></tr>`).join('')}</table></div>` });

  App.addCard({ id: 'sales.invoice', area: 'main', order: 50, permission: 'sales.create', render: () => `<div class="card"><h2>${t('invoice')}</h2>
  <div class="row"><input type="text" id="inv-customer" placeholder="${t('customer')}"></div>
  <div class="row"><input type="text" id="inv-desc" placeholder="${t('desc')}"><input class="qty" type="number" min="1" value="1" id="inv-qty" title="${t('qty')}"><input class="qty" type="number" min="0" step="0.01" id="inv-price" placeholder="${t('unitPrice')}" title="${t('unitPrice')}"></div>
  <div class="row"><button class="primary" data-act="invoice">${t('create')}</button></div></div>` });

  // Live total (incl. VAT) while typing quantities.
  App.onInput('qty', () => {
    const sum = [...document.querySelectorAll('input[data-sku]')].reduce((s, i) => s + Number(i.value || 0) * Number(i.dataset.price), 0);
    const vat = Math.round((sum * state.home.vatRateBp) / 10000);
    document.getElementById('saleTotal').textContent = money(sum + vat);
  });

  App.on('pay', (b) => run(() => api('POST', `/api/invoices/${b.dataset.id}/pay`), t('saved')));

  App.on('sale', () => {
    const picked = [...document.querySelectorAll('input[data-sku]')].filter((i) => Number(i.value) > 0).map((i) => ({ sku: i.dataset.sku, qty: Number(i.value) }));
    if (!picked.length) return toast(t('chooseItems'));
    run(async () => {
      const r = await api('POST', '/api/sales/quick', { items: picked });
      const rej = r.receipt.status === 'rejected';
      saleMsg = { cls: rej ? 'bad' : r.receipt.status === 'queued' ? 'warn' : 'good', text: `${t('saleDone')} ${money(r.sale.total)} · ${t('receiptStatus')}: ${t('st_' + r.receipt.status)}` };
    });
  });

  App.on('invoice', () => run(async () => {
    await api('POST', '/api/invoices', { customer: val('inv-customer'), lines: [{ description: val('inv-desc'), qty: Number(val('inv-qty')), unitPrice: App.toPiastres(val('inv-price')) }] });
  }, t('saved')));
}
