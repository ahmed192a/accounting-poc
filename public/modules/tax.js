// Tax and compliance UI. EVERYTHING here talks to a MOCK tax authority; formats, rates and windows are UNVERIFIED.
export default function register(App) {
  const { t, esc, has, api, run, toast } = App;

  App.i18n.add('en', {
    taxPage: 'Tax', taxMock: 'MOCK authority. Formats, rates and windows are UNVERIFIED and configurable.',
    taxCompliance: 'Tax compliance (MOCK)', taxQueued: 'queued', taxDueSoon: 'due soon (<4h)', taxOverdue: 'overdue', taxRejected: 'rejected',
    taxLastSync: 'Last sync', taxNever: 'never', taxSync: 'Submit and sync now', taxChainOk: 'Document chain intact', taxChainBad: 'Document chain BROKEN',
    taxNoCodes: 'items without a tax code', taxWizardState: 'Registration', taxAdapter: 'Adapter',
    taxDocs: 'E-invoices (MOCK)', taxRetry: 'Retry', taxCancel: 'Cancel', taxReissue: 'Reissue', taxCreditNote: 'Credit note', taxFix: 'Fix', taxExport: 'Export JSON',
    taxCancelReason: 'Reason for cancelling this document?', taxCreditReason: 'Reason for the credit note?', taxNoDocs: 'No tax documents yet.',
    taxst_queued: 'Queued', taxst_submitted: 'Submitted', taxst_valid: 'Valid', taxst_rejected: 'Rejected', taxst_cancelled: 'Cancelled', taxst_overdue: 'Overdue', taxst_due_soon: 'Due soon',
    taxItems: 'Item codes (GS1 / EGS)', taxMissing: 'No code', taxSave: 'Save', taxCsv: 'Bulk import: CSV with columns sku,code', taxImport: 'Import CSV', taxCodePh: 'GS1 or EG-...-...',
    taxWizard: 'ETA registration wizard (MOCK)', taxRegNo: 'Tax registration number', taxConfirm: 'I confirm the ERP is registered on the portal',
    taxClientId: 'Client id', taxClientSecret: 'Client secret', taxSecretNote: 'Credentials are stored encrypted and are never shown again.', taxSecretSet: 'saved',
    taxStep_tax_number: 'Tax registration number', taxStep_erp_registered: 'ERP registered on the portal', taxStep_secrets: 'Secret keys saved', taxStep_sandbox_test: 'Sandbox test submission', taxStep_go_live: 'Go live',
    taxDo: 'Do it', taxDone: 'Done', taxBlocked: 'Finish earlier steps first',
    taxVat: 'VAT (rates and return)', taxFrom: 'From', taxTo: 'To', taxRun: 'Prepare return', taxOutput: 'Output VAT (2100)', taxInput: 'Input VAT (1400)', taxNet: 'Net payable', taxRefund: 'Refund due', taxNoVatInfo: 'approved bills without VAT info',
    taxEstimate: 'Turnover tax estimate', taxEstimateWarn: 'ESTIMATE ONLY. Verify with a tax adviser before relying on it.', taxUnverified: 'unverified',
    taxSettings: 'Tax settings', taxCancelHours: 'Cancellation window (hours)', taxSaved: 'Saved',
  });
  App.i18n.add('ar', {
    taxPage: 'الضرائب', taxMock: 'جهة ضريبية تجريبية (MOCK). الصيغ والنسب والمهل غير موثقة وقابلة للضبط.',
    taxCompliance: 'الالتزام الضريبي (تجريبي)', taxQueued: 'في الانتظار', taxDueSoon: 'قريبة الاستحقاق (أقل من 4 ساعات)', taxOverdue: 'متأخرة', taxRejected: 'مرفوضة',
    taxLastSync: 'آخر مزامنة', taxNever: 'لم تتم', taxSync: 'إرسال ومزامنة الآن', taxChainOk: 'سلسلة المستندات سليمة', taxChainBad: 'سلسلة المستندات تالفة',
    taxNoCodes: 'أصناف بدون كود ضريبي', taxWizardState: 'التسجيل', taxAdapter: 'المحول',
    taxDocs: 'الفواتير الإلكترونية (تجريبي)', taxRetry: 'إعادة المحاولة', taxCancel: 'إلغاء', taxReissue: 'إعادة إصدار', taxCreditNote: 'إشعار دائن', taxFix: 'الحل', taxExport: 'تصدير JSON',
    taxCancelReason: 'سبب إلغاء هذا المستند؟', taxCreditReason: 'سبب الإشعار الدائن؟', taxNoDocs: 'لا توجد مستندات ضريبية بعد.',
    taxst_queued: 'في الانتظار', taxst_submitted: 'تم الإرسال', taxst_valid: 'صالح', taxst_rejected: 'مرفوض', taxst_cancelled: 'ملغى', taxst_overdue: 'متأخر', taxst_due_soon: 'قريب الاستحقاق',
    taxItems: 'أكواد الأصناف (GS1 / EGS)', taxMissing: 'بدون كود', taxSave: 'حفظ', taxCsv: 'استيراد جماعي: ملف CSV بالأعمدة sku,code', taxImport: 'استيراد CSV', taxCodePh: 'GS1 أو EG-...-...',
    taxWizard: 'معالج التسجيل في ETA (تجريبي)', taxRegNo: 'رقم التسجيل الضريبي', taxConfirm: 'أؤكد أن النظام مسجل على البوابة',
    taxClientId: 'معرف العميل', taxClientSecret: 'السر', taxSecretNote: 'تحفظ البيانات مشفرة ولا تعرض مرة أخرى.', taxSecretSet: 'محفوظ',
    taxStep_tax_number: 'رقم التسجيل الضريبي', taxStep_erp_registered: 'تسجيل النظام على البوابة', taxStep_secrets: 'حفظ مفاتيح السر', taxStep_sandbox_test: 'إرسال تجريبي في بيئة الاختبار', taxStep_go_live: 'بدء التشغيل الفعلي',
    taxDo: 'تنفيذ', taxDone: 'تم', taxBlocked: 'أكمل الخطوات السابقة أولا',
    taxVat: 'ضريبة القيمة المضافة (النسب والإقرار)', taxFrom: 'من', taxTo: 'إلى', taxRun: 'إعداد الإقرار', taxOutput: 'ضريبة المخرجات (2100)', taxInput: 'ضريبة المدخلات (1400)', taxNet: 'صافي المستحق', taxRefund: 'مبلغ مسترد', taxNoVatInfo: 'فواتير موردين معتمدة بدون بيانات ضريبة',
    taxEstimate: 'تقدير ضريبة حجم الأعمال', taxEstimateWarn: 'تقدير فقط. تحقق من مستشار ضرائب قبل الاعتماد عليه.', taxUnverified: 'غير موثقة',
    taxSettings: 'إعدادات الضرائب', taxCancelHours: 'مهلة الإلغاء (ساعات)', taxSaved: 'تم الحفظ',
  });

  let docs = [], items = null, wizard = null, rates = [], settings = null, secrets = [], vat = null, est = null;
  const today = () => new Date().toISOString().slice(0, 10);
  let from = today().slice(0, 4) + '-01-01', to = today();

  const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };
  App.onLoad(async () => {
    if (has('tax.view')) {
      [docs, items, wizard, rates, settings] = await Promise.all([
        safe(() => api('GET', '/api/tax/documents'), []), safe(() => api('GET', '/api/tax/items'), null), safe(() => api('GET', '/api/tax/wizard'), null),
        safe(() => api('GET', '/api/tax/vat/rates'), []), safe(() => api('GET', '/api/tax/settings'), null),
      ]);
    }
    secrets = has('tax.configure') ? await safe(() => api('GET', '/api/tax/secrets'), []) : [];
  });
  App.onUserChange(() => { vat = null; est = null; });

  const mock = () => `<p class="note warn">${t('taxMock')}</p>`;
  const stateChip = (d) => `<span class="chip ${{ valid: 'good', submitted: '', queued: '', due_soon: 'warn', overdue: 'bad', rejected: 'bad', cancelled: 'mute' }[d.state] ?? ''}">${t('taxst_' + d.state)}</span>`;
  const when = (ms) => (ms ? new Date(ms).toLocaleString(App.loc()) : t('taxNever'));
  const val = (id) => document.getElementById(id)?.value ?? '';

  App.addCard({ id: 'tax.compliance', area: 'main', order: 120, page: 'tax', pageTitleKey: 'taxPage', permission: 'tax.view',
    render: ({ widgets: w }) => !w.tax ? '' : `<div class="card"><h2>${t('taxCompliance')}</h2>${mock()}
      <div class="row" style="margin-top:0"><span class="chip">${w.tax.queued} ${t('taxQueued')}</span><span class="chip warn">${w.tax.dueSoon} ${t('taxDueSoon')}</span>
      <span class="chip bad">${w.tax.overdue} ${t('taxOverdue')}</span><span class="chip bad">${w.tax.rejected} ${t('taxRejected')}</span></div>
      <p class="sub">${t('taxLastSync')}: ${esc(when(w.tax.lastSync))} · ${t('taxAdapter')}: ${esc(w.tax.adapterLabel)} · ${t('taxWizardState')}: ${esc(w.tax.wizardState)}</p>
      <p><span class="chip ${w.tax.chainOk ? 'good' : 'bad'}">${t(w.tax.chainOk ? 'taxChainOk' : 'taxChainBad')}</span>
      ${w.tax.itemsWithoutCodes ? `<span class="chip warn">${w.tax.itemsWithoutCodes} ${t('taxNoCodes')}</span>` : ''}</p>
      <div class="row">${has('tax.submit') ? `<button class="primary" data-act="tax-sync">${t('taxSync')}</button>` : ''}<button data-act="tax-export">${t('taxExport')}</button></div></div>` });

  App.addCard({ id: 'tax.documents', area: 'main', order: 121, page: 'tax', pageTitleKey: 'taxPage', permission: 'tax.view',
    render: () => `<div class="card"><h2>${t('taxDocs')}</h2>${docs.length ? `<table>${docs.slice(0, 10).map((d) => `<tr>
      <td>${esc(d.number)}<div class="sub">${esc(d.kind)}</div>${d.status === 'rejected' && !d.superseded ? `<div class="sub">${esc(d.reject_reason)} ${t('taxFix')}: ${esc(d.fix_hint)}</div>` : ''}</td><td>${stateChip(d)}</td>
      <td class="num">${App.money(d.total)}</td>
      <td>${has('tax.submit') ? [
        d.status === 'queued' || (d.status === 'rejected' && !d.superseded) ? `<button class="small" data-act="tax-retry" data-id="${d.id}">${t('taxRetry')}</button>` : '',
        d.status === 'rejected' && !d.superseded ? `<button class="small" data-act="tax-reissue" data-id="${d.id}">${t('taxReissue')}</button>` : '',
        d.canCancel && d.status !== 'cancelled' ? `<button class="small" data-act="tax-cancel" data-id="${d.id}">${t('taxCancel')}</button>` : '',
        d.kind === 'invoice' && (d.status === 'valid' || d.status === 'submitted') ? `<button class="small" data-act="tax-credit" data-id="${d.id}">${t('taxCreditNote')}</button>` : '',
      ].join('') : ''}</td></tr>`).join('')}</table>` : `<p class="empty">${t('taxNoDocs')}</p>`}</div>` });

  App.addCard({ id: 'tax.items', area: 'main', order: 122, page: 'tax', pageTitleKey: 'taxPage', permission: 'tax.view',
    render: () => !items ? '' : `<div class="card"><h2>${t('taxItems')}</h2><table>${items.items.map((i) => `<tr><td>${esc(i.sku)}<div class="sub">${esc(i.name)}</div></td>
      <td>${i.missing ? `<span class="chip warn">${t('taxMissing')}</span>` : `<span class="chip good">${esc(i.codeType)}</span> ${esc(i.code)}`}</td>
      <td>${has('tax.configure') ? `<input type="text" id="tax-code-${esc(i.sku)}" placeholder="${t('taxCodePh')}"><button class="small" data-act="tax-setcode" data-sku="${esc(i.sku)}">${t('taxSave')}</button>` : ''}</td></tr>`).join('')}</table>
      ${has('tax.configure') ? `<p class="sub">${t('taxCsv')}</p><textarea id="tax-csv" rows="3" style="width:100%">sku,code\n</textarea><div class="row"><button data-act="tax-import">${t('taxImport')}</button></div>` : ''}</div>` });

  App.addCard({ id: 'tax.wizard', area: 'main', order: 123, page: 'tax', pageTitleKey: 'taxPage', permission: 'tax.view',
    render: () => !wizard ? '' : `<div class="card"><h2>${t('taxWizard')}</h2>${mock()}<table>${wizard.steps.map((s) => `<tr><td><span class="chip ${s.done ? 'good' : s.blocked ? 'mute' : 'warn'}">${s.done ? t('taxDone') : s.blocked ? '…' : '•'}</span></td><td>${t('taxStep_' + s.step)}</td>
      <td>${has('tax.configure') && !s.blocked ? `<button class="small" data-act="tax-step" data-step="${s.step}">${t('taxDo')}</button>` : s.blocked ? `<span class="sub">${t('taxBlocked')}</span>` : ''}</td></tr>`).join('')}</table>
      ${has('tax.configure') ? `<div class="row"><input type="text" id="tax-regno" placeholder="${t('taxRegNo')}"><label><input type="checkbox" id="tax-erp"> ${t('taxConfirm')}</label></div>
      <p class="sub">${t('taxSecretNote')}</p><div class="row"><input type="text" id="tax-cid" autocomplete="off" placeholder="${t('taxClientId')}"><input type="password" id="tax-csec" autocomplete="new-password" placeholder="${t('taxClientSecret')}">
      <button data-act="tax-secrets">${t('taxSave')}</button></div><p class="sub">${secrets.map((s) => `${esc(s.name)}: ${s.set ? t('taxSecretSet') : '-'}`).join(' · ')}</p>` : ''}</div>` });

  App.addCard({ id: 'tax.vat', area: 'main', order: 124, page: 'tax', pageTitleKey: 'taxPage', permission: 'tax.view',
    render: () => `<div class="card"><h2>${t('taxVat')}</h2><p class="sub">${rates.map((r) => `${esc(r.code)} ${r.rateBp / 100}%${r.unverified ? ` (${t('taxUnverified')})` : ''}`).join(' · ')}</p>
      ${has('tax.vat_return') ? `<div class="row"><label>${t('taxFrom')} <input type="date" id="tax-from" value="${from}"></label><label>${t('taxTo')} <input type="date" id="tax-to" value="${to}"></label><button class="primary" data-act="tax-vatrun">${t('taxRun')}</button></div>` : ''}
      ${vat ? `<table><tr><td>${t('taxOutput')}</td><td class="num">${App.money(vat.outputVat)}</td></tr><tr><td>${t('taxInput')}</td><td class="num">${App.money(vat.inputVat)}</td></tr>
      <tr><td><b>${vat.refund ? t('taxRefund') : t('taxNet')}</b></td><td class="num"><b>${App.money(Math.abs(vat.netPayable))}</b></td></tr></table>
      ${vat.billsWithoutVatInfo.length ? `<p class="note warn">${vat.billsWithoutVatInfo.length} ${t('taxNoVatInfo')}</p>` : ''}<p class="note warn">${esc(vat.notice)}</p>` : ''}
      ${est ? `<h3>${t('taxEstimate')}</h3><p class="note warn"><b>${t('taxEstimateWarn')}</b></p><p class="big">${App.money(est.estimatedTax)}</p>` : ''}</div>` });

  App.addCard({ id: 'tax.settings', area: 'main', order: 125, page: 'tax', pageTitleKey: 'taxPage', permission: 'tax.configure',
    render: () => !settings ? '' : `<div class="card"><h2>${t('taxSettings')}</h2><div class="row"><label>${t('taxAdapter')} <select id="tax-adapter">${settings.adapters.map((a) => `<option value="${esc(a.id)}"${a.id === settings.adapter ? ' selected' : ''}>${esc(a.label)}</option>`).join('')}</select></label>
      <label>${t('taxCancelHours')} <input type="number" id="tax-hours" min="0" value="${settings.cancelWindowHours}"></label><button data-act="tax-savesettings">${t('taxSave')}</button></div></div>` });

  const idOf = (b) => Number(b.dataset.id);
  App.on('tax-sync', () => run(() => api('POST', '/api/tax/sync'), t('saved')));
  App.on('tax-retry', (b) => run(() => api('POST', `/api/tax/documents/${idOf(b)}/retry`), t('saved')));
  App.on('tax-reissue', (b) => run(() => api('POST', `/api/tax/documents/${idOf(b)}/reissue`), t('saved')));
  App.on('tax-cancel', (b) => { const reason = prompt(t('taxCancelReason')); if (reason) run(() => api('POST', `/api/tax/documents/${idOf(b)}/cancel`, { reason }), t('saved')); });
  App.on('tax-credit', (b) => { const reason = prompt(t('taxCreditReason')); if (reason) run(() => api('POST', `/api/tax/documents/${idOf(b)}/notes`, { kind: 'credit_note', reason }), t('saved')); });
  App.on('tax-export', async () => {
    const data = await api('GET', '/api/tax/export');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); a.download = 'tax-documents.json'; a.click();
  });
  App.on('tax-setcode', (b) => run(() => api('PUT', `/api/tax/items/${encodeURIComponent(b.dataset.sku)}/code`, { code: val('tax-code-' + b.dataset.sku) }), t('saved')));
  App.on('tax-import', () => run(() => api('POST', '/api/tax/items/import', { csv: val('tax-csv') }), t('saved')));
  App.on('tax-step', (b) => {
    const step = b.dataset.step;
    const body = step === 'tax_number' ? { registrationNumber: val('tax-regno') } : step === 'erp_registered' ? { confirm: !!document.getElementById('tax-erp')?.checked } : {};
    return run(() => api('POST', `/api/tax/wizard/${step}`, body), t('saved'));
  });
  App.on('tax-secrets', () => run(async () => {
    if (val('tax-cid')) await api('PUT', '/api/tax/secrets/eta_client_id', { value: val('tax-cid') });
    if (val('tax-csec')) await api('PUT', '/api/tax/secrets/eta_client_secret', { value: val('tax-csec') });
  }, t('saved')));
  App.on('tax-vatrun', async () => {
    from = val('tax-from'); to = val('tax-to');
    try { vat = await api('GET', `/api/tax/vat/return?from=${from}&to=${to}`); est = await api('GET', `/api/tax/turnover-estimate?from=${from}&to=${to}`); App.render(); } catch (e) { toast(e.message); }
  });
  App.on('tax-savesettings', () => run(() => api('PUT', '/api/tax/settings', { adapter: val('tax-adapter'), cancelWindowHours: Number(val('tax-hours')) }), t('taxSaved')));
}
