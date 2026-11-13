// Purchases: approval queue and new bill (amount-limited, separation of duties).
export default function register(App) {
  const { t, esc, money, has, api, run, toast, state } = App;

  App.i18n.add('en', {
    approvals: 'Approval queue', approve: 'Approve', ownBill: 'your bill', overLimit: 'over your limit',
    bill: 'New bill', supplier: 'Supplier', category: 'Category', yourLimit: 'Your limit', unlimited: 'no limit',
    cat_purchases: 'Purchases', cat_rent: 'Rent', cat_utilities: 'Utilities', approved: 'approved', pending: 'pending approval',
  });
  App.i18n.add('ar', {
    approvals: 'طلبات الموافقة', approve: 'موافقة', ownBill: 'فاتورتك', overLimit: 'فوق حدك',
    bill: 'فاتورة مورد جديدة', supplier: 'المورد', category: 'التصنيف', yourLimit: 'حدك الأقصى', unlimited: 'بدون حد',
    cat_purchases: 'مشتريات', cat_rent: 'إيجار', cat_utilities: 'مرافق', approved: 'معتمدة', pending: 'بانتظار الموافقة',
  });

  App.i18n.add('en', {
    purchasesPage: 'Purchases', pSuppliers: 'Suppliers', pTaxId: 'Tax id', pTerms: 'Terms (days)', pOwed: 'We owe', pAddSupplier: 'Add supplier',
    pPay: 'Pay a supplier', pPayBtn: 'Pay', pAging: 'Payables aging', pCurrent: 'Not due', pBills: 'Recent bills', pVoid: 'Void',
    pVoidWhy: 'Reason for voiding?', pRecurringRun: 'Generate due recurring bills', pName: 'Name',
    pst_draft: 'draft', pst_pending_approval: 'pending approval', pst_approved: 'approved', pst_partially_paid: 'partly paid', pst_paid: 'paid', pst_rejected: 'rejected', pst_void: 'void',
  });
  App.i18n.add('ar', {
    purchasesPage: 'المشتريات', pSuppliers: 'الموردون', pTaxId: 'الرقم الضريبي', pTerms: 'مدة السداد (يوم)', pOwed: 'المستحق لهم', pAddSupplier: 'إضافة مورد',
    pPay: 'سداد لمورد', pPayBtn: 'سداد', pAging: 'أعمار الموردين', pCurrent: 'غير مستحق', pBills: 'أحدث الفواتير', pVoid: 'إلغاء',
    pVoidWhy: 'سبب الإلغاء؟', pRecurringRun: 'إنشاء الفواتير المتكررة المستحقة', pName: 'الاسم',
    pst_draft: 'مسودة', pst_pending_approval: 'بانتظار الموافقة', pst_approved: 'معتمدة', pst_partially_paid: 'مدفوعة جزئيا', pst_paid: 'مدفوعة', pst_rejected: 'مرفوضة', pst_void: 'ملغاة',
  });
  const data = (w) => w.purchasesData ?? { suppliers: [], aging: null, bills: [] };
  const card = (id, order, perm, render) => App.addCard({ id, area: 'main', order, page: 'purchases', pageTitleKey: 'purchasesPage', permission: perm, render });

  card('purchases.suppliers', 62, 'purchases.view', ({ widgets: w }) => { const { suppliers } = data(w); return `<div class="card"><h2>${t('pSuppliers')}</h2>
  ${suppliers.length ? `<table>${suppliers.map((s) => `<tr><td>${esc(s.name)}<div class="sub">${esc(s.tax_id ?? '')}</div></td><td class="num">${s.payment_terms_days}d</td><td class="num">${money(s.outstanding)}</td></tr>`).join('')}</table>` : `<div class="empty">${t('nothing')}</div>`}
  ${has('suppliers.manage') ? `<div class="row"><input type="text" id="psup-name" placeholder="${t('pName')}"><input type="text" id="psup-tax" placeholder="${t('pTaxId')}"><input type="number" min="0" id="psup-terms" placeholder="${t('pTerms')}"><button class="primary" data-act="psup-add">${t('pAddSupplier')}</button></div>` : ''}</div>`; });

  card('purchases.pay', 64, 'purchases.pay', ({ widgets: w }) => { const { suppliers } = data(w); return `<div class="card"><h2>${t('pPay')}</h2>
  <div class="row"><select id="ppay-sup">${suppliers.filter((s) => s.outstanding > 0).map((s) => `<option value="${s.id}">${esc(s.name)} (${money(s.outstanding)})</option>`).join('')}</select>
  <input type="number" min="0" step="0.01" id="ppay-amount" placeholder="${t('amount')}"><button class="primary" data-act="ppay-go">${t('pPayBtn')}</button></div></div>`; });

  card('purchases.aging', 66, 'purchases.view', ({ widgets: w }) => { const aging = data(w).aging; return !aging ? '' : `<div class="card"><h2>${t('pAging')}</h2>
  ${aging.suppliers.length ? `<table><tr><th></th><th class="num">${t('pCurrent')}</th><th class="num">1-30</th><th class="num">31-60</th><th class="num">61-90</th><th class="num">90+</th></tr>${aging.suppliers.map((s) => `<tr><td>${esc(s.supplier)}</td>
  ${['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'].map((k) => `<td class="num">${money(s[k])}</td>`).join('')}</tr>`).join('')}</table>` : `<div class="empty">${t('nothing')}</div>`}</div>`; });

  card('purchases.bills', 68, 'purchases.view', ({ widgets: w }) => { const { bills } = data(w); return `<div class="card"><h2>${t('pBills')}</h2>
  ${bills.length ? `<table>${bills.slice(0, 8).map((b) => `<tr><td>#${b.id} ${esc(b.supplier)}<div class="sub">${esc(b.source)}</div></td><td class="num">${money(b.amount)}</td>
  <td><span class="chip ${b.status === 'paid' || b.status === 'approved' ? 'good' : b.status === 'rejected' || b.status === 'void' ? 'bad' : 'warn'}">${t('pst_' + b.status)}</span></td>
  <td class="num">${has('purchases.approve') && ['pending_approval', 'approved'].includes(b.status) ? `<button class="small" data-act="pbill-void" data-id="${b.id}">${t('pVoid')}</button>` : ''}</td></tr>`).join('')}</table>` : `<div class="empty">${t('nothing')}</div>`}
  ${has('purchases.create') ? `<button class="small" data-act="prec-run">${t('pRecurringRun')}</button>` : ''}</div>`; });

  App.on('psup-add', () => run(() => api('POST', '/api/suppliers', { name: val('psup-name'), taxId: val('psup-tax') || null, paymentTermsDays: Number(val('psup-terms') || 0) }), t('saved')));
  App.on('ppay-go', () => run(() => api('POST', '/api/supplier-payments', { supplierId: Number(val('ppay-sup')), amount: App.toPiastres(val('ppay-amount')) }), t('saved')));
  App.on('pbill-void', (b) => { const reason = window.prompt(t('pVoidWhy')); if (reason) run(() => api('POST', `/api/bills/${b.dataset.id}/void`, { reason }), t('saved')); });
  App.on('prec-run', () => run(() => api('POST', '/api/recurring-bills/run'), t('saved')));

  const val = (i) => document.getElementById(i)?.value ?? '';

  App.addCard({ id: 'purchases.approvals', area: 'main', order: 30, page: 'purchases', pageTitleKey: 'purchasesPage', render: ({ widgets: w }) => !w.approvals ? '' : `<div class="card"><h2>${t('approvals')}</h2>${w.approvals.length ? `<table>${w.approvals.map((b) => `
  <tr><td>#${b.id} ${esc(b.supplier)}<div class="sub">${t('cat_' + b.category)}</div></td><td class="num">${money(b.amount)}</td>
  <td class="num">${b.canApprove ? `<button class="small primary" data-act="approve" data-id="${b.id}">${t('approve')}</button>` :
    `<span class="chip mute">${b.created_by === state.home.user.id ? t('ownBill') : t('overLimit')}</span>`}</td></tr>`).join('')}</table>` : `<div class="empty">${t('nothing')}</div>`}</div>` });

  App.addCard({ id: 'purchases.bill', area: 'main', order: 60, page: 'purchases', pageTitleKey: 'purchasesPage', permission: 'purchases.create', render: () => `<div class="card"><h2>${t('bill')}</h2>
  <div class="row"><input type="text" id="bill-supplier" placeholder="${t('supplier')}"><select id="bill-cat"><option value="rent">${t('cat_rent')}</option><option value="utilities">${t('cat_utilities')}</option><option value="purchases">${t('cat_purchases')}</option></select></div>
  <div class="row"><input type="number" min="0" step="0.01" id="bill-amount" placeholder="${t('amount')}"><button class="primary" data-act="bill">${t('create')}</button></div>
  <div class="sub">${t('yourLimit')}: ${state.home.limits['purchases.create'] == null ? t('unlimited') : money(state.home.limits['purchases.create'])}</div></div>` });

  App.on('approve', (b) => run(() => api('POST', `/api/bills/${b.dataset.id}/approve`), t('saved')));

  App.on('bill', () => run(async () => {
    const r = await api('POST', '/api/bills', { supplier: val('bill-supplier'), category: val('bill-cat'), amount: App.toPiastres(val('bill-amount')) });
    const ev = { bill: r, waitFor: [] }; // lets the documents module attach a captured receipt photo
    document.dispatchEvent(new CustomEvent('purchases:bill-created', { detail: ev }));
    await Promise.all(ev.waitFor);
    toast(t(r.status === 'approved' ? 'approved' : 'pending'), true);
  }));
}
