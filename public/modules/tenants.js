// Multi-tenancy (operator view): the companies hosted on this server, each in its own SQLite file.
// Shown only to users holding tenants.view; the server additionally refuses anyone who is not signed in to the DEFAULT tenant.
// Every control is shown from a permission, never from a role name.
export default function register(App) {
  const { t, esc, has, api, run } = App;

  App.i18n.add('en', {
    tenPage: 'Companies', tenTitle: 'Companies on this server', tenCurrent: 'You are signed in to', tenDisabled: 'Multi-tenancy is off. Start the server with TENANTS_DIR to host several companies, each in its own database file.',
    tenOperatorOnly: 'Only the operator company can manage tenants.', tenSlug: 'Short name (a-z, 0-9, -)', tenName: 'Company name', tenOwnerEmail: 'Owner e-mail', tenOwnerPw: 'Owner password (12+ characters)',
    tenCreate: 'Create company', tenSuspend: 'Suspend', tenResume: 'Resume', tenExport: 'Export JSON', tenBackup: 'Back up file', tenActive: 'Active', tenSuspended: 'Suspended',
    tenUsers: 'active users', tenEntries: 'journal entries', tenCreated: 'Company created. The owner can now sign in with the e-mail and password you set.', tenBackedUp: 'Backup written',
    tenNote: 'Each company has its own database file: users, roles, sessions, keys, ledger and audit log are never shared. Provisioned companies always require sign-in; the demo user switcher only works for the default company.',
  });
  App.i18n.add('ar', {
    tenPage: 'الشركات', tenTitle: 'الشركات على هذا الخادم', tenCurrent: 'أنت مسجل الدخول في', tenDisabled: 'تعدد الشركات متوقف. شغّل الخادم مع TENANTS_DIR لاستضافة عدة شركات، كل واحدة في ملف قاعدة بيانات مستقل.',
    tenOperatorOnly: 'الشركة المشغّلة فقط يمكنها إدارة الشركات.', tenSlug: 'الاسم المختصر (a-z و 0-9 و -)', tenName: 'اسم الشركة', tenOwnerEmail: 'بريد المالك', tenOwnerPw: 'كلمة مرور المالك (١٢ حرفاً فأكثر)',
    tenCreate: 'إنشاء شركة', tenSuspend: 'إيقاف', tenResume: 'استئناف', tenExport: 'تصدير JSON', tenBackup: 'نسخة احتياطية', tenActive: 'نشطة', tenSuspended: 'موقوفة',
    tenUsers: 'مستخدمين', tenEntries: 'قيود يومية', tenCreated: 'تم إنشاء الشركة. يمكن للمالك الآن تسجيل الدخول بالبريد وكلمة المرور اللذين حددتهما.', tenBackedUp: 'تم حفظ النسخة الاحتياطية',
    tenNote: 'لكل شركة ملف قاعدة بيانات خاص بها: المستخدمون والأدوار والجلسات والمفاتيح ودفتر الأستاذ وسجل التدقيق لا تُشارك أبداً. الشركات المنشأة تتطلب تسجيل الدخول دائماً؛ مبدّل المستخدم التجريبي يعمل للشركة الافتراضية فقط.',
  });

  let current = null, list = null, state = null, msg = null; // state: 'ok' | 'disabled' | 'operator'
  const val = (id) => document.getElementById(id)?.value ?? '';
  const input = (id, ph, type = 'text') => `<input type="${type}" id="${id}" placeholder="${esc(ph)}" autocomplete="off">`;

  App.onUserChange(() => { current = null; list = null; state = null; msg = null; });
  App.onLoad(async (home) => {
    if (!home.permissions.includes('tenants.view')) return;
    try { current = await api('GET', '/api/tenant'); } catch { current = null; }
    try {
      list = (await api('GET', '/api/tenants')).tenants;
      state = 'ok';
      const stats = await Promise.all(list.map((x) => api('GET', '/api/tenants/' + encodeURIComponent(x.slug)).then((r) => r.stats).catch(() => null)));
      list = list.map((x, i) => ({ ...x, stats: stats[i] }));
    } catch (e) { list = null; state = e.code === 'TENANCY_DISABLED' ? 'disabled' : e.code === 'OPERATOR_ONLY' ? 'operator' : null; }
    if (home === App.state.home) App.render();
  });

  App.addCard({
    id: 'tenants.list', area: 'main', order: 300, page: 'tenants', pageTitleKey: 'tenPage', permission: 'tenants.view', wide: true,
    render: () => {
      if (!state) return '';
      const head = `<h2>${t('tenTitle')}</h2>${current ? `<p class="sub">${t('tenCurrent')} <b>${esc(current.tenant.name)}</b> (${esc(current.tenant.slug)})</p>` : ''}`;
      if (state === 'disabled') return `<div class="card">${head}<div class="note warn">${t('tenDisabled')}</div></div>`;
      if (state === 'operator') return `<div class="card">${head}<div class="note warn">${t('tenOperatorOnly')}</div></div>`;
      return `<div class="card">${head}<table>${(list ?? []).map((x) => `<tr>
        <td><b>${esc(x.name)}</b><div class="sub">${esc(x.slug)}${x.isDefault ? ' · default' : ''}</div></td>
        <td><span class="chip ${x.status === 'active' ? 'good' : 'warn'}">${x.status === 'active' ? t('tenActive') : t('tenSuspended')}</span></td>
        <td class="sub">${x.stats ? `${x.stats.activeUsers} ${t('tenUsers')} · ${x.stats.journalEntries} ${t('tenEntries')}` : ''}</td>
        <td>${!x.isDefault && has('tenants.manage') ? `<button class="small" data-act="tenants-toggle" data-slug="${esc(x.slug)}" data-status="${x.status}">${x.status === 'active' ? t('tenSuspend') : t('tenResume')}</button>` : ''}
          ${has('tenants.export') ? `<button class="small" data-act="tenants-export" data-slug="${esc(x.slug)}">${t('tenExport')}</button> <button class="small" data-act="tenants-backup" data-slug="${esc(x.slug)}">${t('tenBackup')}</button>` : ''}</td></tr>`).join('')}</table>
        ${msg ? `<div class="note ${msg.cls}">${esc(msg.text)}</div>` : ''}
        ${has('tenants.manage') ? `<h2 style="margin-top:14px">${t('tenCreate')}</h2>
        <div class="row">${input('tenants-slug', t('tenSlug'))}${input('tenants-name', t('tenName'))}${input('tenants-email', t('tenOwnerEmail'), 'email')}${input('tenants-pw', t('tenOwnerPw'), 'password')}
        <button class="primary" data-act="tenants-create">${t('tenCreate')}</button></div>` : ''}
        <p class="sub">${t('tenNote')}</p></div>`;
    },
  });

  const act = (fn, ok) => run(async () => { msg = null; try { await fn(); msg = { cls: 'good', text: ok }; } catch (e) { msg = { cls: 'warn', text: e.message }; } await reload(); });
  async function reload() {
    try {
      list = (await api('GET', '/api/tenants')).tenants;
      const stats = await Promise.all(list.map((x) => api('GET', '/api/tenants/' + encodeURIComponent(x.slug)).then((r) => r.stats).catch(() => null)));
      list = list.map((x, i) => ({ ...x, stats: stats[i] }));
    } catch { /* keep the old list */ }
  }
  App.on('tenants-create', () => act(async () => {
    await api('POST', '/api/tenants', { slug: val('tenants-slug'), name: val('tenants-name'), ownerEmail: val('tenants-email'), ownerPassword: val('tenants-pw') });
  }, t('tenCreated')));
  App.on('tenants-toggle', (b) => act(() => api('POST', `/api/tenants/${encodeURIComponent(b.dataset.slug)}/${b.dataset.status === 'active' ? 'suspend' : 'resume'}`), 'OK'));
  App.on('tenants-backup', (b) => act(async () => { const r = await api('POST', `/api/tenants/${encodeURIComponent(b.dataset.slug)}/backup`); msg = null; App.toast(`${t('tenBackedUp')}: ${r.file}`, true); }, t('tenBackedUp')));
  App.on('tenants-export', (b) => run(async () => {
    const data = await api('GET', `/api/tenants/${encodeURIComponent(b.dataset.slug)}/export`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `export-${b.dataset.slug}.json`; a.click();
  }));
}
