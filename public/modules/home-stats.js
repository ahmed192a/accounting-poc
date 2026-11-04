// Home statistics row (cash, receivables, payables, sales today) and the "my recent work" card.
// Data comes from the widgets other modules contribute to /api/home.
export default function register(App) {
  const { t, esc, money } = App;

  App.i18n.add('en', {
    cash: 'Cash', receivables: 'Receivables', payables: 'Payables', todaySales: 'Sales today', open: 'open', overdue: 'overdue', sales: 'sales',
    myWork: 'My recent work', invoices: 'Invoices', bills: 'Bills', paid: 'paid', approved: 'approved', pending: 'pending approval',
  });
  App.i18n.add('ar', {
    cash: 'النقدية', receivables: 'مستحقات العملاء', payables: 'مستحقات الموردين', todaySales: 'مبيعات اليوم', open: 'مفتوحة', overdue: 'متأخرة', sales: 'عمليات بيع',
    myWork: 'أعمالي الأخيرة', invoices: 'الفواتير', bills: 'فواتير الموردين', paid: 'مدفوعة', approved: 'معتمدة', pending: 'بانتظار الموافقة',
  });

  App.addCard({ id: 'stats.cash', area: 'stats', order: 10, render: ({ widgets: w }) => !w.cash ? '' :
    `<div class="card"><h2>${t('cash')}</h2><div class="big">${money(w.cash.balance)}</div></div>` });

  App.addCard({ id: 'stats.receivables', area: 'stats', order: 20, render: ({ widgets: w }) => !w.receivables ? '' :
    `<div class="card"><h2>${t('receivables')}</h2><div class="big">${money(w.receivables.total)}</div><div class="sub">${w.receivables.count} ${t('open')} · ${w.receivables.overdue} ${t('overdue')}</div></div>` });

  App.addCard({ id: 'stats.payables', area: 'stats', order: 30, render: ({ widgets: w }) => !w.payables ? '' :
    `<div class="card"><h2>${t('payables')}</h2><div class="big">${money(w.payables.total)}</div></div>` });

  App.addCard({ id: 'stats.todaySales', area: 'stats', order: 40, render: ({ widgets: w }) => !w.todaySales ? '' :
    `<div class="card"><h2>${t('todaySales')}</h2><div class="big">${money(w.todaySales.total)}</div><div class="sub">${w.todaySales.count} ${t('sales')}</div></div>` });

  App.addCard({ id: 'home.myWork', area: 'main', order: 70, render: ({ widgets: w }) => !w.myWork ? '' : `<div class="card"><h2>${t('myWork')}</h2>
  <div class="sub">${t('invoices')}</div>${w.myWork.invoices.length ? `<table>${w.myWork.invoices.map((i) => `<tr><td>${esc(i.number)} ${esc(i.customer)}</td><td class="num">${money(i.total)}</td><td><span class="chip ${i.paid ? 'good' : ''}">${i.paid ? t('paid') : t('open')}</span></td></tr>`).join('')}</table>` : `<div class="empty">${t('nothing')}</div>`}
  <div class="sub mt">${t('bills')}</div>${w.myWork.bills.length ? `<table>${w.myWork.bills.map((b) => `<tr><td>#${b.id} ${esc(b.supplier)}</td><td class="num">${money(b.amount)}</td><td><span class="chip ${b.status === 'approved' ? 'good' : 'warn'}">${t(b.status === 'approved' ? 'approved' : 'pending')}</span></td></tr>`).join('')}</table>` : `<div class="empty">${t('nothing')}</div>`}</div>` });
}
