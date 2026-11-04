// Entities, currencies and exchange rates, chart of accounts, consolidation. Backend: src/modules/entities.
// Cards carry page:'entities' for the shell's tabbed navigation; they also work as plain cards.
export default function register(App) {
  const { t, esc, has, api, run, money } = App;

  App.i18n.add('en', {
    entities: 'Entities', entEntity: 'Entity', entAdd: 'Add entity', entCode: 'Code', entName: 'Name', entNameAr: 'Arabic name', entCurrency: 'Currency',
    entFiscal: 'Fiscal year starts (month)', entKind: 'Type', entBranch: 'branch', entCompany: 'company',
    entFx: 'Currencies and rates', entRate: 'Rate (EGP per 1)', entRateDate: 'Rate date', entSetRate: 'Save rate', entFetch: 'Fetch rates (MOCK provider)',
    entReval: 'Revalue foreign balances', entRevalDone: 'Revaluation posted', entRevalNone: 'Nothing to revalue',
    entCoa: 'Chart of accounts', entAcct: 'Account', entType: 'Type', entParent: 'Parent', entActive: 'Active', entAddAcct: 'Add account', entRename: 'Rename',
    entDeactivate: 'Deactivate', entActivate: 'Activate', entDelete: 'Delete', entImport: 'Import CSV', entTemplate: 'Add Egyptian starter chart', entCsvHint: 'code,name,name_ar,type,parent_code',
    entHistory: 'has history', entSystem: 'system', entNewName: 'New English name', entNewNameAr: 'New Arabic name',
    entConsol: 'Consolidation', entRun: 'Run consolidated report', entElim: 'Intercompany eliminated', entDiff: 'Unmatched', entAdj: 'Translation adjustment (3100)',
    entIc: 'Intercompany transaction', entFrom: 'From entity', entTo: 'To entity', entPost: 'Post', debit: 'Debit', credit: 'Credit',
  });
  App.i18n.add('ar', {
    entities: 'الكيانات', entEntity: 'الكيان', entAdd: 'إضافة كيان', entCode: 'الرمز', entName: 'الاسم', entNameAr: 'الاسم بالعربية', entCurrency: 'العملة',
    entFiscal: 'بداية السنة المالية (الشهر)', entKind: 'النوع', entBranch: 'فرع', entCompany: 'شركة',
    entFx: 'العملات وأسعار الصرف', entRate: 'السعر (ج.م لكل 1)', entRateDate: 'تاريخ السعر', entSetRate: 'حفظ السعر', entFetch: 'جلب الأسعار (مزود تجريبي)',
    entReval: 'إعادة تقييم الأرصدة الأجنبية', entRevalDone: 'تم قيد إعادة التقييم', entRevalNone: 'لا شيء لإعادة تقييمه',
    entCoa: 'دليل الحسابات', entAcct: 'الحساب', entType: 'النوع', entParent: 'الحساب الأب', entActive: 'نشط', entAddAcct: 'إضافة حساب', entRename: 'تعديل الاسم',
    entDeactivate: 'إيقاف', entActivate: 'تفعيل', entDelete: 'حذف', entImport: 'استيراد CSV', entTemplate: 'إضافة الدليل المصري المبدئي', entCsvHint: 'code,name,name_ar,type,parent_code',
    entHistory: 'له حركة', entSystem: 'نظام', entNewName: 'الاسم الإنجليزي الجديد', entNewNameAr: 'الاسم العربي الجديد',
    entConsol: 'القوائم المجمعة', entRun: 'تشغيل التقرير المجمع', entElim: 'مستبعد بين شركات المجموعة', entDiff: 'غير متطابق', entAdj: 'فروق الترجمة (3100)',
    entIc: 'معاملة بين شركات المجموعة', entFrom: 'من كيان', entTo: 'إلى كيان', entPost: 'ترحيل', debit: 'مدين', credit: 'دائن',
  });

  const val = (i) => document.getElementById(i)?.value ?? '';
  const data = { currencies: [], latest: {}, accounts: [], consol: null };
  const eid = () => App.state.entityId ?? 1;
  const nameOf = (e) => (App.state.lang === 'ar' && e.nameAr ? e.nameAr : e.name);
  const acctName = (a) => (App.state.lang === 'ar' ? a.nameAr : a.name);

  App.onLoad(async (home) => {
    const tasks = [];
    if (has('currency.manage') || has('entities.view')) {
      tasks.push(api('GET', '/api/fx/latest').then((r) => { data.latest = r; }).catch(() => {}));
      tasks.push(api('GET', '/api/currencies').then((r) => { data.currencies = r; }).catch(() => {}));
    }
    if (has('coa.manage')) tasks.push(api('GET', '/api/coa').then((r) => { data.accounts = r; }).catch(() => {}));
    await Promise.all(tasks);
    const list = home.widgets.entities?.list ?? [];
    if (list.length && !list.some((e) => e.id === App.state.entityId)) App.state.entityId = list[0].id;
  });
  App.onUserChange(() => { data.consol = null; });

  const opts = (items, sel) => items.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(sel) ? 'selected' : ''}>${esc(l)}</option>`).join('');

  App.addCard({
    id: 'entities.switch', area: 'main', order: 20, page: 'entities', pageTitleKey: 'entities',
    render: ({ widgets: w }) => {
      const list = w.entities?.list;
      if (!list) return '';
      return `<div class="card"><h2>${t('entities')}</h2>
      <div class="row"><label>${t('entEntity')}</label><select id="ent-sel" data-act="ent-select">${opts(list.map((e) => [e.id, `${e.code} - ${nameOf(e)} (${e.currency})`]), eid())}</select></div>
      ${has('entities.manage') ? `<div class="row" style="margin-top:8px">
        <input type="text" id="ent-code" placeholder="${t('entCode')}" size="8"><input type="text" id="ent-name" placeholder="${t('entName')}"><input type="text" id="ent-name-ar" placeholder="${t('entNameAr')}">
        <select id="ent-kind"><option value="branch">${t('entBranch')}</option><option value="company">${t('entCompany')}</option></select>
        <select id="ent-cur">${opts(data.currencies.filter((c) => c.active).map((c) => [c.code, c.code]), 'EGP')}</select>
        <input type="number" id="ent-fy" min="1" max="12" value="1" title="${t('entFiscal')}" style="width:70px">
        <button data-act="ent-add">${t('entAdd')}</button></div>` : ''}</div>`;
    },
  });
  App.onChange('ent-select', (el) => { App.state.entityId = Number(el.value); App.reload(); });
  App.on('ent-add', () => run(() => api('POST', '/api/entities', {
    code: val('ent-code'), name: val('ent-name'), nameAr: val('ent-name-ar'), kind: val('ent-kind'), currency: val('ent-cur'), fiscalYearStartMonth: Number(val('ent-fy')) || 1,
  }), t('saved')));

  // ----- currencies and rates -----
  App.addCard({
    id: 'entities.fx', area: 'main', order: 21, page: 'entities', pageTitleKey: 'entities', permission: (h) => h.permissions.includes('currency.manage') || h.permissions.includes('entities.view'),
    render: () => `<div class="card"><h2>${t('entFx')}</h2>
      <table><tr><th>${t('entCurrency')}</th><th class="num">${t('entRate')}</th></tr>${Object.entries(data.latest).map(([c, r]) => `<tr><td>${esc(c)}</td><td class="num">${esc(r.rate)}</td></tr>`).join('')}</table>
      ${has('currency.manage') ? `<div class="row" style="margin-top:8px"><select id="fx-cur">${opts(data.currencies.filter((c) => c.code !== 'EGP').map((c) => [c.code, c.code]))}</select>
        <input type="date" id="fx-date" title="${t('entRateDate')}"><input type="text" id="fx-rate" placeholder="${t('entRate')}" size="10"><button data-act="fx-set">${t('entSetRate')}</button>
        <button class="small" data-act="fx-fetch">${t('entFetch')}</button></div>
        <div class="row"><input type="date" id="fx-asof"><button data-act="fx-reval">${t('entReval')}</button></div>` : ''}</div>`,
  });
  App.on('fx-set', () => run(() => api('POST', '/api/fx/rates', { currency: val('fx-cur'), date: val('fx-date'), rate: val('fx-rate') }), t('saved')));
  App.on('fx-fetch', () => run(() => api('POST', '/api/fx/rates/fetch', { date: val('fx-date') || undefined }), t('saved')));
  App.on('fx-reval', () => run(async () => {
    const r = await api('POST', '/api/fx/revalue', { entityId: eid(), asOf: val('fx-asof') || undefined });
    App.toast(r.entryId ? t('entRevalDone') : t('entRevalNone'), true);
  }));

  // ----- chart of accounts -----
  App.addCard({
    id: 'entities.coa', area: 'main', order: 22, page: 'entities', pageTitleKey: 'entities', permission: 'coa.manage',
    render: () => `<div class="card"><h2>${t('entCoa')}</h2>
      <div class="row"><input type="text" id="coa-code" placeholder="${t('entCode')}" size="8"><input type="text" id="coa-name" placeholder="${t('entName')}"><input type="text" id="coa-name-ar" placeholder="${t('entNameAr')}">
        <select id="coa-type">${['asset', 'liability', 'equity', 'revenue', 'expense'].map((x) => `<option>${x}</option>`).join('')}</select>
        <input type="text" id="coa-parent" placeholder="${t('entParent')}" size="8"><button data-act="coa-add">${t('entAddAcct')}</button></div>
      <table style="margin-top:8px"><tr><th>${t('entCode')}</th><th>${t('entAcct')}</th><th>${t('entType')}</th><th>${t('entParent')}</th><th></th></tr>${data.accounts.map((a) => `<tr class="${a.active ? '' : 'mute'}">
        <td>${esc(a.code)}</td><td>${esc(acctName(a))}${a.hasHistory ? ` <span class="chip mute">${t('entHistory')}</span>` : ''}${a.system ? ` <span class="chip mute">${t('entSystem')}</span>` : ''}</td>
        <td>${esc(a.type)}</td><td>${esc(a.parentCode ?? '')}</td>
        <td><button class="small" data-act="coa-rename" data-code="${esc(a.code)}">${t('entRename')}</button>
        ${a.system ? '' : `<button class="small" data-act="coa-toggle" data-code="${esc(a.code)}" data-active="${a.active ? 1 : 0}">${a.active ? t('entDeactivate') : t('entActivate')}</button>`}
        ${!a.system && !a.hasHistory && !a.hasChildren ? `<button class="small" data-act="coa-delete" data-code="${esc(a.code)}">${t('entDelete')}</button>` : ''}</td></tr>`).join('')}</table>
      <div style="margin-top:8px"><textarea id="coa-csv" rows="3" style="width:100%" placeholder="${t('entCsvHint')}"></textarea>
        <div class="row"><button data-act="coa-import">${t('entImport')}</button><button data-act="coa-template">${t('entTemplate')}</button></div></div></div>`,
  });
  App.on('coa-add', () => run(() => api('POST', '/api/coa', { code: val('coa-code'), name: val('coa-name'), nameAr: val('coa-name-ar'), type: val('coa-type'), parentCode: val('coa-parent') || null }), t('saved')));
  App.on('coa-rename', (b) => {
    const name = window.prompt(t('entNewName'));
    if (!name) return;
    const nameAr = window.prompt(t('entNewNameAr')) || name;
    run(() => api('PATCH', `/api/coa/${encodeURIComponent(b.dataset.code)}`, { name, nameAr }), t('saved'));
  });
  App.on('coa-toggle', (b) => run(() => api('PATCH', `/api/coa/${encodeURIComponent(b.dataset.code)}`, { active: b.dataset.active !== '1' }), t('saved')));
  App.on('coa-delete', (b) => run(() => api('DELETE', `/api/coa/${encodeURIComponent(b.dataset.code)}`), t('saved')));
  App.on('coa-import', () => run(() => api('POST', '/api/coa/import', { csv: val('coa-csv') }), t('saved')));
  App.on('coa-template', () => run(() => api('POST', '/api/coa/template/apply', {}), t('saved')));

  // ----- consolidation and intercompany -----
  App.addCard({
    id: 'entities.consol', area: 'main', order: 23, page: 'entities', pageTitleKey: 'entities', permission: (h) => h.permissions.includes('entities.view') && h.permissions.includes('reports.view'),
    render: ({ widgets: w }) => {
      const c = data.consol, list = w.entities?.list ?? [];
      return `<div class="card"><h2>${t('entConsol')}</h2>
      <div class="row"><input type="date" id="con-asof"><button data-act="con-run">${t('entRun')}</button></div>
      ${c ? `<span class="chip ${c.balanced ? 'good' : 'bad'}">${t(c.balanced ? 'balanced' : 'unbalanced')}</span>
        <div class="sub">${t('entElim')}: ${money(c.eliminations.receivable)} / ${money(c.eliminations.payable)} · ${t('entDiff')}: ${money(c.eliminations.difference)} · ${t('entAdj')}: ${money(c.translationAdjustment)}</div>
        <table><tr><th>${t('entCode')}</th><th>${t('entAcct')}</th><th class="num">${t('debit')}</th><th class="num">${t('credit')}</th></tr>${c.rows.map((r) => `<tr><td>${esc(r.code)}</td><td>${esc(App.state.lang === 'ar' ? r.name_ar : r.name)}</td><td class="num">${r.debit ? money(r.debit) : ''}</td><td class="num">${r.credit ? money(r.credit) : ''}</td></tr>`).join('')}</table>` : ''}
      ${has('ledger.post') && list.length > 1 ? `<h3 style="margin-top:12px">${t('entIc')}</h3><div class="row">
        <select id="ic-from">${opts(list.map((e) => [e.id, e.code]), 1)}</select><select id="ic-to">${opts(list.map((e) => [e.id, e.code]), list[1].id)}</select>
        <input type="number" step="0.01" id="ic-amt" placeholder="${t('amount')}"><button data-act="ic-post">${t('entPost')}</button></div>` : ''}</div>`;
    },
  });
  App.on('con-run', async () => {
    try { data.consol = await api('GET', `/api/entities/consolidation${val('con-asof') ? `?asOf=${val('con-asof')}` : ''}`); App.render(); } catch (e) { App.toast(e.message); }
  });
  App.on('ic-post', () => run(() => api('POST', '/api/entities/intercompany', { fromEntityId: Number(val('ic-from')), toEntityId: Number(val('ic-to')), amount: App.toPiastres(val('ic-amt')) }), t('saved')));
}
