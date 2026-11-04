// Approvals: inbox (notifications and requests you can act on), rules, delegation.
export default function register(App) {
  const { t, esc, money, has, api, run } = App;

  App.i18n.add('en', {
    approvalsPage: 'Approvals', apInbox: 'Approval inbox', apUnread: 'unread', apNone: 'No requests need you.', apReject: 'Reject', apRejectWhy: 'Reason for rejecting?',
    apRules: 'Approval rules', apNewRule: 'New rule', apRuleName: 'Rule name', apMin: 'From amount (EGP)', apStep1: 'Step 1 role', apStep2: 'Step 2 role (optional)',
    apSequential: 'sequential', apParallel: 'parallel', apAdd: 'Add rule', apDelegate: 'Delegate while away', apTo: 'Delegate to', apFrom: 'From', apUntil: 'Until',
    apDelegations: 'Delegations', apEscalate: 'Run escalations', apNotes: 'Notifications', apRead: 'Mark all read', apDefault: 'default',
    apn_approval_needed: 'Approval needed', apn_approved: 'Approved', apn_rejected: 'Rejected', apn_escalated: 'Overdue: escalated', apn_delegated: 'Delegation',
  });
  App.i18n.add('ar', {
    approvalsPage: 'الموافقات', apInbox: 'صندوق الموافقات', apUnread: 'غير مقروء', apNone: 'لا توجد طلبات تنتظرك.', apReject: 'رفض', apRejectWhy: 'سبب الرفض؟',
    apRules: 'قواعد الموافقة', apNewRule: 'قاعدة جديدة', apRuleName: 'اسم القاعدة', apMin: 'من مبلغ (ج.م)', apStep1: 'دور الخطوة 1', apStep2: 'دور الخطوة 2 (اختياري)',
    apSequential: 'تتابعي', apParallel: 'متوازي', apAdd: 'إضافة قاعدة', apDelegate: 'تفويض أثناء الغياب', apTo: 'تفويض إلى', apFrom: 'من', apUntil: 'حتى',
    apDelegations: 'التفويضات', apEscalate: 'تشغيل التصعيد', apNotes: 'الإشعارات', apRead: 'تعليم الكل كمقروء', apDefault: 'افتراضية',
    apn_approval_needed: 'مطلوب اعتماد', apn_approved: 'تم الاعتماد', apn_rejected: 'مرفوض', apn_escalated: 'متأخر: تم التصعيد', apn_delegated: 'تفويض',
  });

  const inbox = (w) => w.approvalsInbox ?? { unread: 0, items: [], todo: [], rules: [], delegations: [] };
  const users = () => App.state.users ?? [];
  const val = (i) => document.getElementById(i)?.value ?? '';
  const card = (id, order, perm, render) => App.addCard({ id, area: 'main', order, page: 'approvals', pageTitleKey: 'approvalsPage', permission: perm, render });

  card('approvals.inbox', 32, 'approvals.view', ({ widgets: w }) => {
    const n = inbox(w), todo = n.todo;
    return `<div class="card"><h2>${t('apInbox')} <span class="chip ${n.unread ? 'warn' : 'mute'}">${n.unread} ${t('apUnread')}</span></h2>
    ${todo.length ? `<table>${todo.map((r) => `<tr><td>#${r.id} ${esc(r.doc_type)} ${r.doc_id}<div class="sub">${esc(r.rule_name ?? '')}</div></td><td class="num">${money(r.amount)}</td>
      <td class="num"><button class="small primary" data-act="apr-approve" data-id="${r.id}">${t('approve')}</button> <button class="small" data-act="apr-reject" data-id="${r.id}">${t('apReject')}</button></td></tr>`).join('')}</table>` : `<div class="empty">${t('apNone')}</div>`}
    ${n.items.length ? `<h3>${t('apNotes')}</h3><table>${n.items.map((i) => `<tr><td>${i.read_at ? '' : '<b>*</b> '}${t('apn_' + i.kind)}<div class="sub">${esc(i.body ?? '')}</div></td></tr>`).join('')}</table>
      <button class="small" data-act="apr-readall">${t('apRead')}</button>` : ''}
    ${has('approvals.configure') ? `<button class="small" data-act="apr-escalate">${t('apEscalate')}</button>` : ''}</div>`;
  });

  card('approvals.rules', 34, 'approvals.view', ({ widgets: w }) => { const rules = inbox(w).rules; return `<div class="card"><h2>${t('apRules')}</h2>
  <table>${rules.filter((r) => r.active).map((r) => `<tr><td>${esc(r.name)} ${r.is_default ? `<span class="chip mute">${t('apDefault')}</span>` : ''}
    <div class="sub">${r.min_amount ? money(r.min_amount) + '+' : ''} ${r.mode === 'parallel' ? t('apParallel') : t('apSequential')}: ${r.steps.map((s) => esc(s.approver_ref)).join(' → ')}</div></td></tr>`).join('')}</table>
  ${has('approvals.configure') ? `<h3>${t('apNewRule')}</h3><div class="row"><input type="text" id="apr-name" placeholder="${t('apRuleName')}"><input type="number" min="0" id="apr-min" placeholder="${t('apMin')}"></div>
  <div class="row"><input type="text" id="apr-r1" value="manager" placeholder="${t('apStep1')}"><input type="text" id="apr-r2" value="owner" placeholder="${t('apStep2')}">
  <select id="apr-mode"><option value="sequential">${t('apSequential')}</option><option value="parallel">${t('apParallel')}</option></select><button class="primary" data-act="apr-addrule">${t('apAdd')}</button></div>` : ''}</div>`; });

  card('approvals.delegate', 36, 'approvals.delegate', ({ widgets: w }) => { const delegations = inbox(w).delegations; return `<div class="card"><h2>${t('apDelegate')}</h2>
  <div class="row"><select id="apd-to">${users().filter((u) => u.id !== App.state.home?.user.id).map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>
  <input type="date" id="apd-from" aria-label="${t('apFrom')}"><input type="date" id="apd-until" aria-label="${t('apUntil')}"><button class="primary" data-act="apd-add">${t('create')}</button></div>
  ${delegations.length ? `<table>${delegations.slice(0, 6).map((d) => `<tr><td>${esc(d.from_name)} → ${esc(d.to_name)}<div class="sub">${esc(d.start_date)} – ${esc(d.end_date)}</div></td>
  <td><span class="chip ${d.active ? 'good' : 'mute'}">${d.active ? 'on' : 'off'}</span></td></tr>`).join('')}</table>` : ''}</div>`; });

  App.on('apr-approve', (b) => run(() => api('POST', `/api/approvals/${b.dataset.id}/approve`), t('saved')));
  App.on('apr-reject', (b) => { const reason = window.prompt(t('apRejectWhy')); if (reason) run(() => api('POST', `/api/approvals/${b.dataset.id}/reject`, { reason }), t('saved')); });
  App.on('apr-readall', () => run(() => api('POST', '/api/notifications/read-all')));
  App.on('apr-escalate', () => run(() => api('POST', '/api/approvals/escalations/run'), t('saved')));
  App.on('apr-addrule', () => run(() => {
    const steps = [val('apr-r1'), val('apr-r2')].filter(Boolean).map((r) => ({ approverType: 'role', approverRef: r }));
    return api('POST', '/api/approval-rules', { name: val('apr-name'), minAmount: App.toPiastres(val('apr-min') || '0'), mode: val('apr-mode'), priority: 10, steps });
  }, t('saved')));
  App.on('apd-add', () => run(() => api('POST', '/api/approval-delegations', { toUserId: Number(val('apd-to')), startDate: val('apd-from'), endDate: val('apd-until') }), t('saved')));
}
