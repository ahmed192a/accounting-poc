// E-receipts (mock ETA): connection pill in the header, queue card, and the demo clock button in the footer.
export default function register(App) {
  const { t, esc, has, api, run } = App;

  App.i18n.add('en', {
    eta: 'E-receipts (mock ETA)', online: 'ETA online', offline: 'ETA offline', goOffline: 'Simulate offline', goOnline: 'Go online', sync: 'Sync queue now',
    waiting: 'waiting', submitted: 'submitted', dueSoon: 'due soon', overdue: 'overdue', receipt: 'Receipt', hoursLeft: 'h left', overdueBy: 'h late',
    st_submitted: 'Submitted', st_queued: 'Queued', st_due_soon: 'Due soon', st_overdue: 'Overdue', st_rejected: 'Rejected',
    advance: 'Advance clock +6 hours (demo)',
  });
  App.i18n.add('ar', {
    eta: 'الإيصالات الإلكترونية (ETA تجريبي)', online: 'ETA متصل', offline: 'ETA غير متصل', goOffline: 'محاكاة انقطاع الاتصال', goOnline: 'عودة الاتصال', sync: 'مزامنة الآن',
    waiting: 'في الانتظار', submitted: 'تم الإرسال', dueSoon: 'قريبة الاستحقاق', overdue: 'متأخرة', receipt: 'إيصال', hoursLeft: 'ساعة متبقية', overdueBy: 'ساعة تأخير',
    st_submitted: 'تم الإرسال', st_queued: 'في الانتظار', st_due_soon: 'قريب الاستحقاق', st_overdue: 'متأخر', st_rejected: 'مرفوض',
    advance: 'تقديم الساعة 6 ساعات (للتجربة)',
  });

  const stateChip = (r) => {
    const cls = { submitted: 'good', queued: '', due_soon: 'warn', overdue: 'bad', rejected: 'bad' }[r.state];
    return `<span class="chip ${cls}">${t('st_' + r.state)}</span>`;
  };
  const hoursText = (ms) => (ms == null ? '' : ms >= 0 ? `${Math.floor(ms / 3600000)} ${t('hoursLeft')}` : `${Math.ceil(-ms / 3600000)} ${t('overdueBy')}`);

  App.addHeader({ id: 'eta.pill', order: 10, render: ({ widgets: w }) => !w.eta ? '' :
    `<span id="etaPill" class="chip ${w.eta.online ? 'good' : 'bad'}">${t(w.eta.online ? 'online' : 'offline')}</span>` });

  // The demo clock endpoint exists to show the 24-hour receipt deadline, so its button lives here.
  App.addFooter({ id: 'eta.advance', order: 10, render: () => `<button class="small" data-act="advance">${t('advance')}</button>` });

  App.addCard({ id: 'eta.queue', area: 'main', order: 20, render: ({ widgets: w }) => !w.eta ? '' : `<div class="card"><h2>${t('eta')}</h2>
  <div class="row" style="margin-top:0"><span class="chip ${w.eta.online ? 'good' : 'bad'}">${t(w.eta.online ? 'online' : 'offline')}</span>
   <span class="sub">${w.eta.counts.submitted} ${t('submitted')} · ${w.eta.counts.waiting} ${t('waiting')} · ${w.eta.counts.dueSoon} ${t('dueSoon')} · ${w.eta.counts.overdue} ${t('overdue')}</span></div>
  <div class="row">${has('eta.manage') ? `<button data-act="online" data-on="${w.eta.online ? 0 : 1}">${t(w.eta.online ? 'goOffline' : 'goOnline')}</button>` : ''}${has('sales.create') || has('eta.manage') ? `<button class="primary" data-act="sync">${t('sync')}</button>` : ''}</div>
  ${w.eta.receipts.length ? `<table style="margin-top:8px">${w.eta.receipts.slice(0, 8).map((r) => `<tr><td>${t('receipt')} R-${r.sale_id}</td><td>${stateChip(r)}</td><td class="sub">${esc(r.status === 'rejected' ? r.reject_reason : hoursText(r.msLeft))}</td></tr>`).join('')}</table>` : ''}</div>` });

  App.on('sync', () => run(() => api('POST', '/api/eta/sync'), t('saved')));
  App.on('online', (b) => run(() => api('POST', '/api/eta/online', { online: b.dataset.on === '1' })));
  App.on('advance', () => run(() => api('POST', '/api/dev/advance-clock', { hours: 6 }), t('saved')));
}
