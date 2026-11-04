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

  const val = (i) => document.getElementById(i)?.value ?? '';

  App.addCard({ id: 'purchases.approvals', area: 'main', order: 30, render: ({ widgets: w }) => !w.approvals ? '' : `<div class="card"><h2>${t('approvals')}</h2>${w.approvals.length ? `<table>${w.approvals.map((b) => `
  <tr><td>#${b.id} ${esc(b.supplier)}<div class="sub">${t('cat_' + b.category)}</div></td><td class="num">${money(b.amount)}</td>
  <td class="num">${b.canApprove ? `<button class="small primary" data-act="approve" data-id="${b.id}">${t('approve')}</button>` :
    `<span class="chip mute">${b.created_by === state.home.user.id ? t('ownBill') : t('overLimit')}</span>`}</td></tr>`).join('')}</table>` : `<div class="empty">${t('nothing')}</div>`}</div>` });

  App.addCard({ id: 'purchases.bill', area: 'main', order: 60, permission: 'purchases.create', render: () => `<div class="card"><h2>${t('bill')}</h2>
  <div class="row"><input type="text" id="bill-supplier" placeholder="${t('supplier')}"><select id="bill-cat"><option value="rent">${t('cat_rent')}</option><option value="utilities">${t('cat_utilities')}</option><option value="purchases">${t('cat_purchases')}</option></select></div>
  <div class="row"><input type="number" min="0" step="0.01" id="bill-amount" placeholder="${t('amount')}"><button class="primary" data-act="bill">${t('create')}</button></div>
  <div class="sub">${t('yourLimit')}: ${state.home.limits['purchases.create'] == null ? t('unlimited') : money(state.home.limits['purchases.create'])}</div></div>` });

  App.on('approve', (b) => run(() => api('POST', `/api/bills/${b.dataset.id}/approve`), t('saved')));

  App.on('bill', () => run(async () => {
    const r = await api('POST', '/api/bills', { supplier: val('bill-supplier'), category: val('bill-cat'), amount: App.toPiastres(val('bill-amount')) });
    toast(t(r.status === 'approved' ? 'approved' : 'pending'), true);
  }));
}
