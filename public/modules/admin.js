// Administration: users and roles (role editor with live separation-of-duties warnings, permission matrix),
// sign-in management (invite, deactivate, reset password / MFA, unlock), API keys, webhooks with delivery log,
// and the security overview. Every control is shown from a permission, never from a role name.
export default function register(App) {
  const { t, esc, has, api, run, toast } = App;

  App.i18n.add('en', {
    admin: 'Users and roles', export: 'Export everything (JSON)', newRole: 'Create a role', roleName: 'Role name', sodWarn: 'Separation-of-duties warning',
    adminPage: 'Admin', admMatrix: 'Permission matrix', admEditRole: 'Edit custom role', admSave: 'Save role', admPick: 'Choose a custom role',
    admAccounts: 'Accounts and sign-in', admInvite: 'Invite', admEmail: 'E-mail', admActive: 'Active', admOff: 'Deactivated', admLocked: 'Locked', admPending: 'Invite pending',
    admDeactivate: 'Deactivate', admReactivate: 'Reactivate', admResetPw: 'Reset password', admResetMfa: 'Reset MFA', admUnlock: 'Unlock', admReason: 'Reason',
    admShownOnce: 'Shown once. Copy it now:', admKeys: 'API keys', admKeyName: 'Key name', admScopes: 'Scopes (permissions)', admCreateKey: 'Create key', admRevoke: 'Revoke', admLastUsed: 'Last used', admNever: 'never',
    admHooks: 'Webhooks', admUrl: 'HTTPS URL', admEvents: 'Events (comma separated, or *)', admAdd: 'Add', admPause: 'Pause', admResume: 'Resume', admTest: 'Send test', admDelete: 'Delete',
    admDeliveries: 'Delivery log', admProcess: 'Deliver due now', admRetry: 'Retry', admSecurity: 'Security overview', admVerify: 'Verify audit-log integrity',
    admVerifyOk: 'Audit log intact', admVerifyBad: 'TAMPERING DETECTED', admMfaCover: 'Users with MFA', admSessions: 'Active sessions', admDemo: 'Demo credentials active',
  });
  App.i18n.add('ar', {
    admin: 'المستخدمون والأدوار', export: 'تصدير كل البيانات (JSON)', newRole: 'إنشاء دور', roleName: 'اسم الدور', sodWarn: 'تحذير فصل المهام',
    adminPage: 'الإدارة', admMatrix: 'مصفوفة الصلاحيات', admEditRole: 'تعديل دور مخصص', admSave: 'حفظ الدور', admPick: 'اختر دوراً مخصصاً',
    admAccounts: 'الحسابات وتسجيل الدخول', admInvite: 'دعوة', admEmail: 'البريد الإلكتروني', admActive: 'نشط', admOff: 'موقوف', admLocked: 'مقفل', admPending: 'دعوة معلقة',
    admDeactivate: 'إيقاف', admReactivate: 'إعادة تفعيل', admResetPw: 'إعادة تعيين كلمة المرور', admResetMfa: 'إعادة تعيين المصادقة', admUnlock: 'فتح القفل', admReason: 'السبب',
    admShownOnce: 'يظهر مرة واحدة. انسخه الآن:', admKeys: 'مفاتيح API', admKeyName: 'اسم المفتاح', admScopes: 'النطاقات (الصلاحيات)', admCreateKey: 'إنشاء مفتاح', admRevoke: 'إلغاء', admLastUsed: 'آخر استخدام', admNever: 'أبداً',
    admHooks: 'ويب هوكس', admUrl: 'رابط HTTPS', admEvents: 'الأحداث (مفصولة بفاصلة أو *)', admAdd: 'إضافة', admPause: 'إيقاف مؤقت', admResume: 'استئناف', admTest: 'إرسال تجربة', admDelete: 'حذف',
    admDeliveries: 'سجل التسليم', admProcess: 'تسليم المستحق الآن', admRetry: 'إعادة', admSecurity: 'نظرة عامة على الأمان', admVerify: 'التحقق من سلامة سجل التدقيق',
    admVerifyOk: 'سجل التدقيق سليم', admVerifyBad: 'تم اكتشاف تلاعب', admMfaCover: 'مستخدمون بالمصادقة', admSessions: 'جلسات نشطة', admDemo: 'بيانات دخول تجريبية فعالة',
  });

  let roleMsg = null, secret = null, accounts = [], keys = [], hooksData = null, deliveries = [], overview = null, verifyResult = null, editId = '';
  const val = (i) => document.getElementById(i)?.value ?? '';
  const sodMsg = (r) => (r.sodWarnings.length ? { cls: 'warn', text: `${t('sodWarn')}: ${r.sodWarnings.map((x) => x.reason).join('; ')}` } : { cls: 'good', text: t('saved') });
  const when = (ms) => (ms ? new Date(ms).toLocaleString(App.loc()) : t('admNever'));
  const input = (id, ph, type = 'text') => `<input type="${type}" id="${id}" placeholder="${esc(ph)}" >`;
  const secretNote = () => (secret ? `<div class="note warn"><b>${t('admShownOnce')}</b><br><code style="word-break:break-all">${esc(secret)}</code></div>` : '');
  const area = (home) => home.widgets.admin;

  App.onUserChange(() => { roleMsg = null; secret = null; accounts = []; keys = []; hooksData = null; deliveries = []; overview = null; verifyResult = null; });

  App.onLoad(async (home) => {
    const has = (p) => home.permissions.includes(p); // App.has reads state.home, which is set only after the hooks ran
    const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };
    if (has('users.invite')) accounts = await safe(() => api('GET', '/api/auth/users'), []);
    if (has('apikeys.manage')) keys = await safe(() => api('GET', '/api/apikeys'), []);
    if (has('webhooks.manage')) {
      hooksData = await safe(() => api('GET', '/api/webhooks'), null);
      deliveries = await safe(() => api('GET', '/api/webhooks/deliveries'), []);
    }
    if (has('security.view')) overview = await safe(() => api('GET', '/api/security/overview'), null);
  });

  // ---- existing card: assign roles, create roles ----
  App.addCard({ id: 'admin.users', area: 'main', order: 100, page: 'admin', pageTitleKey: 'adminPage', render: ({ widgets: w }) => !w.admin ? '' : `<div class="card"><h2>${t('admin')}</h2>
  <table>${w.admin.users.map((u) => `<tr><td>${esc(u.name)}</td><td><select data-act="setrole" data-id="${u.id}" ${has('users.manage') ? '' : 'disabled'}>${w.admin.roles.map((r) => `<option value="${r.id}" ${r.name === u.role ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></td></tr>`).join('')}</table>
  ${w.admin.roles.filter((r) => r.sodWarnings.length).map((r) => `<div class="note warn"><b>${esc(r.name)}</b>: ${r.sodWarnings.map((x) => esc(x.reason)).join('; ')}</div>`).join('')}
  ${roleMsg ? `<div class="note ${roleMsg.cls}">${esc(roleMsg.text)}</div>` : ''}
  ${has('roles.manage') ? `<h2 style="margin-top:14px">${t('newRole')}</h2><div class="row" style="margin-top:0"><input type="text" id="role-name" placeholder="${t('roleName')}"><button class="primary" data-act="role">${t('create')}</button></div>
   <div class="perm-grid">${Object.entries(w.admin.permissions).map(([k, d]) => `<label title="${esc(d)}"><input type="checkbox" class="perm" data-act="adm-sod" value="${k}"> ${k}</label>`).join('')}</div><div id="adm-sod-live"></div>` : ''}
  ${has('export.all') ? `<div class="row"><button data-act="export">${t('export')}</button></div>` : ''}</div>` });

  App.onChange('setrole', (sel) => run(async () => {
    roleMsg = sodMsg(await api('PATCH', '/api/users/' + sel.dataset.id, { roleId: Number(sel.value) }));
  }));
  App.on('role', () => run(async () => {
    const perms = [...document.querySelectorAll('input.perm:checked:not(.permedit)')].map((i) => i.value);
    roleMsg = sodMsg(await api('POST', '/api/roles', { name: val('role-name'), permissions: perms }));
  }));
  App.on('export', () => run(async () => {
    const data = await api('GET', '/api/export');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = 'accounting-export.json'; a.click();
  }));

  // live SoD warning while ticking boxes (create form or role editor)
  App.onChange('adm-sod', (box) => {
    const w = area(App.state.home);
    const grid = box.closest('.perm-grid');
    const picked = new Set([...grid.querySelectorAll('input.perm:checked')].map((i) => i.value));
    const hits = (w.sod ?? []).filter((x) => x.pair.every((p) => picked.has(p)));
    const el = grid.nextElementSibling;
    if (el) el.innerHTML = hits.map((h) => `<div class="note warn">${t('sodWarn')}: ${esc(h.reason)}</div>`).join('');
  });

  // ---- permission matrix + custom role editor ----
  App.addCard({ id: 'admin.matrix', area: 'main', order: 101, page: 'admin', pageTitleKey: 'adminPage', permission: (h) => !!h.widgets.admin, render: ({ widgets: w }) => {
    const roles = w.admin.roles, atoms = Object.keys(w.admin.permissions);
    const custom = roles.filter((r) => !r.builtin);
    const cur = custom.find((r) => String(r.id) === editId);
    return `<div class="card"><h2>${t('admMatrix')}</h2><div style="overflow:auto;max-height:340px"><table>
      <tr><th></th>${roles.map((r) => `<th>${esc(r.name)}</th>`).join('')}</tr>
      ${atoms.map((a) => `<tr><td title="${esc(w.admin.permissions[a])}">${esc(a)}</td>${roles.map((r) => `<td>${r.permissions.includes(a) ? '&#10003;' : ''}</td>`).join('')}</tr>`).join('')}</table></div>
      ${has('roles.manage') && custom.length ? `<h2 style="margin-top:14px">${t('admEditRole')}</h2>
        <div class="row"><select data-act="adm-pick"><option value="">${t('admPick')}</option>${custom.map((r) => `<option value="${r.id}" ${String(r.id) === editId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>
        ${cur ? `<div class="perm-grid">${atoms.map((a) => `<label><input type="checkbox" class="perm permedit" data-act="adm-sod" value="${a}" ${cur.permissions.includes(a) ? 'checked' : ''}> ${esc(a)}</label>`).join('')}</div>
          <div id="adm-sod-live">${cur.sodWarnings.map((x) => `<div class="note warn">${t('sodWarn')}: ${esc(x.reason)}</div>`).join('')}</div>
          <div class="row"><button class="primary" data-act="adm-save-role">${t('admSave')}</button></div>` : ''}` : ''}</div>`;
  } });
  App.onChange('adm-pick', (sel) => { editId = sel.value; App.render(); });
  App.on('adm-save-role', () => run(async () => {
    const perms = [...document.querySelectorAll('input.permedit:checked')].map((i) => i.value);
    roleMsg = sodMsg(await api('PATCH', '/api/roles/' + editId, { permissions: perms }));
    toast(roleMsg.text, roleMsg.cls === 'good');
  }));

  // ---- accounts ----
  const chips = (u) => `${u.active ? '' : `<span class="chip bad">${t('admOff')}</span> `}${u.locked ? `<span class="chip warn">${t('admLocked')}</span> ` : ''}${u.invitePending ? `<span class="chip mute">${t('admPending')}</span> ` : ''}${u.mfaEnabled ? '<span class="chip good">MFA</span>' : ''}`;
  App.addCard({ id: 'admin.accounts', area: 'main', order: 102, page: 'admin', pageTitleKey: 'adminPage', permission: 'users.invite', render: (h) => {
    const roles = area(h)?.roles ?? [];
    return `<div class="card"><h2>${t('admAccounts')}</h2>${secretNote()}
    <table>${accounts.map((u) => `<tr><td>${esc(u.name)}<div class="sub">${esc(u.email ?? '')}</div></td><td>${esc(u.role)}</td><td>${chips(u)}</td>
      <td>${has('users.manage') ? `${u.active ? `<button class="small" data-act="adm-deact" data-id="${u.id}">${t('admDeactivate')}</button>` : `<button class="small" data-act="adm-react" data-id="${u.id}">${t('admReactivate')}</button>`}
        <button class="small" data-act="adm-reset" data-id="${u.id}">${t('admResetPw')}</button>${u.mfaEnabled ? ` <button class="small" data-act="adm-mfa" data-id="${u.id}">${t('admResetMfa')}</button>` : ''}${u.locked ? ` <button class="small" data-act="adm-unlock" data-id="${u.id}">${t('admUnlock')}</button>` : ''}` : ''}</td></tr>`).join('')}</table>
    <div class="row">${input('adm-i-name', t('authName'))}${input('adm-i-email', t('admEmail'), 'email')}
      <select id="adm-i-role">${roles.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select><button class="primary" data-act="adm-invite">${t('admInvite')}</button></div>
    ${has('users.manage') ? `<div class="row">${input('adm-reason', t('admReason'))}</div>` : ''}</div>`;
  } });
  const accountAct = (fn) => run(async () => { secret = null; await fn(); });
  App.on('adm-invite', () => accountAct(async () => { const r = await api('POST', '/api/auth/users', { name: val('adm-i-name'), email: val('adm-i-email'), roleId: Number(val('adm-i-role')) }); secret = r.inviteToken; }));
  App.on('adm-deact', (b) => accountAct(() => api('POST', `/api/auth/users/${b.dataset.id}/deactivate`, { reason: val('adm-reason') })));
  App.on('adm-react', (b) => accountAct(() => api('POST', `/api/auth/users/${b.dataset.id}/reactivate`)));
  App.on('adm-reset', (b) => accountAct(async () => { secret = (await api('POST', `/api/auth/users/${b.dataset.id}/reset-password`)).temporaryPassword; }));
  App.on('adm-mfa', (b) => accountAct(() => api('POST', `/api/auth/users/${b.dataset.id}/reset-mfa`)));
  App.on('adm-unlock', (b) => accountAct(() => api('POST', `/api/auth/users/${b.dataset.id}/unlock`)));

  // ---- API keys ----
  App.addCard({ id: 'admin.apikeys', area: 'main', order: 103, page: 'admin', pageTitleKey: 'adminPage', permission: 'apikeys.manage', render: ({ permissions }) => `<div class="card"><h2>${t('admKeys')}</h2>${secretNote()}
    <table>${keys.map((k) => `<tr><td>${esc(k.name)}<div class="sub">${esc(k.prefix)}</div></td><td class="sub">${k.permissions.map(esc).join(', ')}</td><td class="sub">${t('admLastUsed')}: ${when(k.lastUsedAt)}</td>
      <td>${k.active ? `<button class="small" data-act="adm-key-revoke" data-id="${k.id}">${t('admRevoke')}</button>` : `<span class="chip mute">${t('admRevoke')}</span>`}</td></tr>`).join('')}</table>
    <div class="row">${input('adm-k-name', t('admKeyName'))}<button class="primary" data-act="adm-key-new">${t('admCreateKey')}</button></div>
    <div class="perm-grid">${permissions.map((p) => `<label><input type="checkbox" class="key-scope" value="${esc(p)}"> ${esc(p)}</label>`).join('')}</div></div>` });
  App.on('adm-key-new', () => accountAct(async () => {
    const scopes = [...document.querySelectorAll('input.key-scope:checked')].map((i) => i.value);
    secret = (await api('POST', '/api/apikeys', { name: val('adm-k-name'), permissions: scopes })).key;
  }));
  App.on('adm-key-revoke', (b) => accountAct(() => api('DELETE', '/api/apikeys/' + b.dataset.id)));

  // ---- webhooks ----
  App.addCard({ id: 'admin.webhooks', area: 'main', order: 104, page: 'admin', pageTitleKey: 'adminPage', permission: 'webhooks.manage', render: () => `<div class="card"><h2>${t('admHooks')}</h2>${secretNote()}
    <table>${(hooksData?.webhooks ?? []).map((w) => `<tr><td class="sub" style="max-width:240px">${esc(w.url)}<div>${w.events.map(esc).join(', ')}</div></td>
      <td>${w.active ? '<span class="chip good">on</span>' : '<span class="chip mute">off</span>'}${w.dead ? ` <span class="chip bad">${w.dead}</span>` : ''}</td>
      <td><button class="small" data-act="adm-hook-test" data-id="${w.id}">${t('admTest')}</button> <button class="small" data-act="adm-hook-toggle" data-id="${w.id}" data-on="${w.active ? 1 : 0}">${w.active ? t('admPause') : t('admResume')}</button>
        <button class="small" data-act="adm-hook-del" data-id="${w.id}">${t('admDelete')}</button></td></tr>`).join('')}</table>
    <div class="row">${input('adm-h-url', t('admUrl'))}${input('adm-h-events', t('admEvents'))}<button class="primary" data-act="adm-hook-add">${t('admAdd')}</button></div>
    <h2 style="margin-top:14px">${t('admDeliveries')} <button class="small" data-act="adm-hook-process">${t('admProcess')}</button></h2>
    <table>${deliveries.slice(0, 12).map((d) => `<tr><td class="sub">#${d.id}</td><td>${esc(d.event)}</td><td><span class="chip ${d.status === 'delivered' ? 'good' : d.status === 'dead' ? 'bad' : 'warn'}">${esc(d.status)}</span></td>
      <td class="sub">${d.attempts}x ${esc(d.lastError ?? '')}</td><td>${d.status === 'dead' ? `<button class="small" data-act="adm-hook-retry" data-id="${d.id}">${t('admRetry')}</button>` : ''}</td></tr>`).join('')}</table></div>` });
  App.on('adm-hook-add', () => accountAct(async () => {
    const events = val('adm-h-events').split(',').map((s) => s.trim()).filter(Boolean);
    secret = (await api('POST', '/api/webhooks', { url: val('adm-h-url'), ...(events.length ? { events } : {}) })).secret;
  }));
  App.on('adm-hook-test', (b) => accountAct(() => api('POST', `/api/webhooks/${b.dataset.id}/test`)));
  App.on('adm-hook-toggle', (b) => accountAct(() => api('PATCH', '/api/webhooks/' + b.dataset.id, { active: b.dataset.on !== '1' })));
  App.on('adm-hook-del', (b) => accountAct(() => api('DELETE', '/api/webhooks/' + b.dataset.id)));
  App.on('adm-hook-process', () => accountAct(() => api('POST', '/api/webhooks/deliveries/process')));
  App.on('adm-hook-retry', (b) => accountAct(() => api('POST', `/api/webhooks/deliveries/${b.dataset.id}/retry`)));

  // ---- security overview + integrity check ----
  App.addCard({ id: 'admin.security', area: 'main', order: 105, page: 'admin', pageTitleKey: 'adminPage', permission: 'security.view', render: () => !overview ? '' : `<div class="card"><h2>${t('admSecurity')}</h2>
    <div class="row" style="margin-top:0"><span class="chip ${overview.authRequired ? 'good' : 'warn'}">${overview.authRequired ? 'AUTH_REQUIRED' : 'demo identity'}</span>
      <span class="chip">${t('admMfaCover')}: ${overview.users.mfaEnabled}/${overview.users.withPassword}</span><span class="chip">${t('admSessions')}: ${overview.sessions.active}</span>
      ${overview.users.demoCredentials ? `<span class="chip warn">${t('admDemo')}: ${overview.users.demoCredentials}</span>` : ''}</div>
    <p class="sub">${overview.rateLimit.capacity} / min &middot; lockout after ${overview.lockout.afterFailures} failures &middot; session ${overview.session.idleMinutes} min idle, ${overview.session.absoluteHours} h max</p>
    <div class="row"><button data-act="adm-verify">${t('admVerify')}</button></div>
    ${verifyResult ? `<div class="note ${verifyResult.ok ? 'good' : 'bad'}">${verifyResult.ok ? t('admVerifyOk') : t('admVerifyBad')}: ${verifyResult.sealed} sealed, ${verifyResult.problems.map((p) => `#${p.auditId} ${esc(p.kind)}`).join(', ')}</div>` : ''}</div>` });
  App.on('adm-verify', () => run(async () => { verifyResult = await api('GET', '/api/audit/verify'); }));
}
