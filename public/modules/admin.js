// Users and roles: assign roles, create roles, separation-of-duties warnings, full export.
export default function register(App) {
  const { t, esc, has, api, run } = App;

  App.i18n.add('en', {
    admin: 'Users and roles', export: 'Export everything (JSON)', newRole: 'Create a role', roleName: 'Role name', sodWarn: 'Separation-of-duties warning',
  });
  App.i18n.add('ar', {
    admin: 'المستخدمون والأدوار', export: 'تصدير كل البيانات (JSON)', newRole: 'إنشاء دور', roleName: 'اسم الدور', sodWarn: 'تحذير فصل المهام',
  });

  let roleMsg = null;
  const val = (i) => document.getElementById(i)?.value ?? '';
  const sodMsg = (r) => (r.sodWarnings.length ? { cls: 'warn', text: `${t('sodWarn')}: ${r.sodWarnings.map((x) => x.reason).join('; ')}` } : { cls: 'good', text: t('saved') });

  App.onUserChange(() => { roleMsg = null; });

  App.addCard({ id: 'admin.users', area: 'main', order: 100, render: ({ widgets: w }) => !w.admin ? '' : `<div class="card"><h2>${t('admin')}</h2>
  <table>${w.admin.users.map((u) => `<tr><td>${esc(u.name)}</td><td><select data-act="setrole" data-id="${u.id}" ${has('users.manage') ? '' : 'disabled'}>${w.admin.roles.map((r) => `<option value="${r.id}" ${r.name === u.role ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></td></tr>`).join('')}</table>
  ${w.admin.roles.filter((r) => r.sodWarnings.length).map((r) => `<div class="note warn"><b>${esc(r.name)}</b>: ${r.sodWarnings.map((x) => esc(x.reason)).join('; ')}</div>`).join('')}
  ${roleMsg ? `<div class="note ${roleMsg.cls}">${esc(roleMsg.text)}</div>` : ''}
  ${has('roles.manage') ? `<h2 style="margin-top:14px">${t('newRole')}</h2><div class="row" style="margin-top:0"><input type="text" id="role-name" placeholder="${t('roleName')}"><button class="primary" data-act="role">${t('create')}</button></div>
   <div class="perm-grid">${Object.entries(w.admin.permissions).map(([k, d]) => `<label title="${esc(d)}"><input type="checkbox" class="perm" value="${k}"> ${k}</label>`).join('')}</div>` : ''}
  ${has('export.all') ? `<div class="row"><button data-act="export">${t('export')}</button></div>` : ''}</div>` });

  App.onChange('setrole', (sel) => run(async () => {
    roleMsg = sodMsg(await api('PATCH', '/api/users/' + sel.dataset.id, { roleId: Number(sel.value) }));
  }));

  App.on('role', () => run(async () => {
    const perms = [...document.querySelectorAll('input.perm:checked')].map((i) => i.value);
    roleMsg = sodMsg(await api('POST', '/api/roles', { name: val('role-name'), permissions: perms }));
  }));

  App.on('export', () => run(async () => {
    const data = await api('GET', '/api/export');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = 'accounting-export.json'; a.click();
  }));
}
