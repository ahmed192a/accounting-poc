// Banking UI: accounts, CSV import wizard (preview -> commit), unreconciled queue with accept/reject,
// bank rules editor, reconciliation summary. Live bank feeds are NOT implemented (CSV import only).
export default function register(App) {
  const { t, esc, money, has, api, run } = App;

  const METHODS = ['cash', 'instapay', 'fawry', 'wallet', 'card', 'bank_transfer', 'other'];
  App.i18n.add('en', {
    bankPage: 'Banking', bankWidget: 'Bank reconciliation', bankUnrec: 'unreconciled', bankDiff: 'Statement vs ledger difference',
    bankNoFeed: 'Live bank feeds are not implemented (availability in Egypt is unverified). Import statements as CSV files.',
    bankAccounts: 'Bank, cash and wallet accounts', bankAccount: 'Account', bankType: 'Type', bankLedger: 'Ledger account', bankName: 'Name',
    bankT_bank: 'Bank', bankT_cash: 'Cash', bankT_wallet: 'Mobile wallet', bankAdd: 'Add account',
    bankImport: 'Import a statement (CSV)', bankStep1: '1. Choose the file', bankStep2: '2. Map the columns', bankStep3: '3. Preview and commit',
    bankPaste: 'Paste CSV text or choose a file', bankRead: 'Read file', bankPreview: 'Preview', bankCommit: 'Commit import', bankDiscard: 'Discard',
    bankSkipErr: 'Skip unreadable rows', bankBack: 'Start over', bankDateCol: 'Date column', bankDescCol: 'Description column', bankRefCol: 'Reference column',
    bankAmtCol: 'Amount column', bankDebitCol: 'Debit column (money out)', bankCreditCol: 'Credit column (money in)', bankBalCol: 'Balance column',
    bankDateFmt: 'Date format', bankDecimal: 'Decimal mark', bankAuto: 'Auto', bankInvert: 'Invert sign', bankSaveMap: 'Remember this mapping', bankNone: '(none)',
    bankRows: 'rows', bankNew: 'new', bankDup: 'duplicates', bankErrs: 'errors', bankRowNo: 'Row', bankMsg: 'Problem',
    bankBatches: 'Recent imports', bankRollback: 'Roll back', bankStatus_preview: 'preview', bankStatus_committed: 'committed', bankStatus_rolled_back: 'rolled back',
    bankQueue: 'Unreconciled statement lines', bankReconciled: 'Reconciled', bankShow: 'Show', bankSuggest: 'Suggested matches', bankNoSuggest: 'No suggestion',
    bankAccept: 'Accept', bankReject: 'Reject', bankConf: 'confidence', bankMethod: 'Method', bankPostEntry: 'Post entry', bankAcctCode: 'Account code',
    bankUnrecBtn: 'Unreconcile', bankReasonPh: 'Reason / soft-lock reason', bankManual: 'Manual reconcile (ledger line id)', bankEmpty: 'Nothing to reconcile.',
    bankRules: 'Bank rules', bankRuleName: 'Rule name', bankPriority: 'Priority (lower first)', bankContains: 'contains', bankRegex: 'regex', bankPattern: 'Text / pattern',
    bankDirection: 'Direction', bankIn: 'in', bankOut: 'out', bankAny: 'any', bankMin: 'Min EGP', bankMax: 'Max EGP', bankMemo: 'Memo', bankTest: 'Test rule',
    bankArchive: 'Archive', bankMatches: 'matching lines', bankSample: 'Sample text', bankRecon: 'Reconciliation summary', bankAsOf: 'As of', bankStmtBal: 'Statement balance',
    bankLedBal: 'Ledger balance', bankDifference: 'Difference', bankUnexplained: 'Unexplained', bankUnrecLines: 'Unreconciled statement lines', bankUnrecLedger: 'Unreconciled ledger items',
    bankSignoff: 'Sign off', bankNote: 'Note', bankNoStmt: 'No statement imported yet', bankClean: 'Reconciled', bankOpen: 'Open items',
    bankM_cash: 'Cash', bankM_instapay: 'InstaPay', bankM_fawry: 'Fawry', bankM_wallet: 'Wallet', bankM_card: 'Card', bankM_bank_transfer: 'Bank transfer', bankM_other: 'Other',
    bankM_none: '(no tag)', bankCreates: 'Effect',
  });
  App.i18n.add('ar', {
    bankPage: 'البنوك', bankWidget: 'مطابقة البنك', bankUnrec: 'غير مطابقة', bankDiff: 'الفرق بين كشف الحساب والدفتر',
    bankNoFeed: 'الربط المباشر مع البنوك غير مُنفَّذ (توفره في مصر غير مؤكد). استورد كشوف الحساب كملفات CSV.',
    bankAccounts: 'حسابات البنوك والنقدية والمحافظ', bankAccount: 'الحساب', bankType: 'النوع', bankLedger: 'حساب الأستاذ', bankName: 'الاسم',
    bankT_bank: 'بنك', bankT_cash: 'نقدية', bankT_wallet: 'محفظة إلكترونية', bankAdd: 'إضافة حساب',
    bankImport: 'استيراد كشف حساب (CSV)', bankStep1: '١. اختر الملف', bankStep2: '٢. حدّد الأعمدة', bankStep3: '٣. معاينة واعتماد',
    bankPaste: 'الصق نص CSV أو اختر ملفاً', bankRead: 'قراءة الملف', bankPreview: 'معاينة', bankCommit: 'اعتماد الاستيراد', bankDiscard: 'تجاهل',
    bankSkipErr: 'تخطي الصفوف غير المقروءة', bankBack: 'البدء من جديد', bankDateCol: 'عمود التاريخ', bankDescCol: 'عمود البيان', bankRefCol: 'عمود المرجع',
    bankAmtCol: 'عمود المبلغ', bankDebitCol: 'عمود المدين (خارج)', bankCreditCol: 'عمود الدائن (داخل)', bankBalCol: 'عمود الرصيد',
    bankDateFmt: 'صيغة التاريخ', bankDecimal: 'الفاصلة العشرية', bankAuto: 'تلقائي', bankInvert: 'عكس الإشارة', bankSaveMap: 'تذكّر هذا التعيين', bankNone: '(بدون)',
    bankRows: 'صف', bankNew: 'جديد', bankDup: 'مكرر', bankErrs: 'أخطاء', bankRowNo: 'الصف', bankMsg: 'المشكلة',
    bankBatches: 'آخر عمليات الاستيراد', bankRollback: 'تراجع', bankStatus_preview: 'معاينة', bankStatus_committed: 'معتمد', bankStatus_rolled_back: 'تم التراجع',
    bankQueue: 'بنود الكشف غير المطابقة', bankReconciled: 'المطابقة', bankShow: 'عرض', bankSuggest: 'المطابقات المقترحة', bankNoSuggest: 'لا يوجد اقتراح',
    bankAccept: 'قبول', bankReject: 'رفض', bankConf: 'الثقة', bankMethod: 'الطريقة', bankPostEntry: 'ترحيل قيد', bankAcctCode: 'كود الحساب',
    bankUnrecBtn: 'إلغاء المطابقة', bankReasonPh: 'السبب / سبب الإقفال المرن', bankManual: 'مطابقة يدوية (رقم بند الدفتر)', bankEmpty: 'لا يوجد ما يُطابَق.',
    bankRules: 'قواعد البنك', bankRuleName: 'اسم القاعدة', bankPriority: 'الأولوية (الأقل أولاً)', bankContains: 'يحتوي', bankRegex: 'تعبير نمطي', bankPattern: 'النص / النمط',
    bankDirection: 'الاتجاه', bankIn: 'داخل', bankOut: 'خارج', bankAny: 'أي', bankMin: 'أقل مبلغ', bankMax: 'أعلى مبلغ', bankMemo: 'البيان', bankTest: 'اختبار القاعدة',
    bankArchive: 'أرشفة', bankMatches: 'بند مطابق', bankSample: 'نص تجريبي', bankRecon: 'ملخص المطابقة', bankAsOf: 'حتى تاريخ', bankStmtBal: 'رصيد الكشف',
    bankLedBal: 'رصيد الدفتر', bankDifference: 'الفرق', bankUnexplained: 'فرق غير مفسَّر', bankUnrecLines: 'بنود الكشف غير المطابقة', bankUnrecLedger: 'بنود الدفتر غير المطابقة',
    bankSignoff: 'اعتماد المطابقة', bankNote: 'ملاحظة', bankNoStmt: 'لم يتم استيراد كشف بعد', bankClean: 'مطابق', bankOpen: 'بنود مفتوحة',
    bankM_cash: 'نقدي', bankM_instapay: 'إنستاباي', bankM_fawry: 'فوري', bankM_wallet: 'محفظة', bankM_card: 'بطاقة', bankM_bank_transfer: 'تحويل بنكي', bankM_other: 'أخرى',
    bankM_none: '(بدون وسم)', bankCreates: 'الأثر',
  });

  // ---- module state ----
  const S = { accounts: [], accountId: null, queue: [], reconciled: [], summary: null, report: null, rules: [], batches: [], show: 'unreconciled', asOf: '',
    csv: '', filename: '', inspect: null, map: {}, saveMap: false, preview: null, skipErrors: false, ruleTest: null, reason: '' };
  const val = (id) => document.getElementById(id)?.value ?? '';
  const methodLabel = (m) => t(m ? `bankM_${m}` : 'bankM_none');
  const lockOpts = () => (S.reason.trim() ? { confirmSoftLock: true, reason: S.reason.trim() } : {});
  const reasonOnly = () => ({ reason: S.reason.trim() });

  App.onUserChange(() => { Object.assign(S, { accounts: [], accountId: null, queue: [], reconciled: [], summary: null, report: null, rules: [], batches: [], preview: null, inspect: null, ruleTest: null }); });

  App.onLoad(async (home) => {
    // skip when the user switched while /api/home was loading (stale home): avoids a needless 403
    if (!home.permissions.includes('banking.view') || home.user.id !== App.state.userId) return;
    try {
      S.accounts = await api('GET', '/api/banking/accounts');
      if (!S.accounts.some((a) => a.id === S.accountId)) S.accountId = (S.accounts.find((a) => a.active) ?? S.accounts[0])?.id ?? null;
      S.rules = await api('GET', '/api/banking/rules');
      if (S.accountId) {
        const q = `accountId=${S.accountId}`;
        S.queue = S.show === 'unreconciled' ? await api('GET', `/api/banking/queue?${q}&limit=30`) : [];
        S.reconciled = S.show === 'reconciled' ? await api('GET', `/api/banking/lines?${q}&state=reconciled&limit=30`) : [];
        S.summary = await api('GET', `/api/banking/reconciliation?${q}${S.asOf ? `&date=${S.asOf}` : ''}`);
        S.report = await api('GET', `/api/banking/reconciliation/report?${q}${S.asOf ? `&date=${S.asOf}` : ''}`);
        S.batches = await api('GET', `/api/banking/imports?${q}`);
      }
    } catch (e) { if (e.code !== 'FORBIDDEN') console.error('banking load failed', e); } // FORBIDDEN: the user switched while loading
  });

  const acctSelect = () => `<select data-act="bank-account">${S.accounts.map((a) => `<option value="${a.id}" ${a.id === S.accountId ? 'selected' : ''}>${esc(a.name)} (${esc(a.ledgerCode)})</option>`).join('')}</select>`;
  const methodSelect = (id, cur, canEdit) => canEdit
    ? `<select data-act="bank-method" data-id="${id}"><option value="">${t('bankM_none')}</option>${METHODS.map((m) => `<option value="${m}" ${m === cur ? 'selected' : ''}>${t(`bankM_${m}`)}</option>`).join('')}</select>`
    : `<span class="chip mute">${esc(methodLabel(cur))}</span>`;
  const fee = (a) => `<span class="num">${money(a)}</span>`;

  // ---- widget (stats) ----
  App.addCard({ id: 'banking.widget', area: 'stats', order: 150, permission: 'banking.view',
    render: ({ widgets: w }) => !w.banking ? '' : `<div class="card"><h2>${t('bankWidget')}</h2>
      <div class="big">${w.banking.unreconciled} <span class="sub">${t('bankUnrec')}</span></div>
      <div class="sub">${t('bankDiff')}: <b class="${w.banking.difference ? '' : ''}">${money(w.banking.difference)}</b></div></div>`,
    page: 'banking', pageTitleKey: 'bankPage' });

  // ---- accounts ----
  App.addCard({ id: 'banking.accounts', area: 'main', order: 300, permission: 'banking.view', page: 'banking', pageTitleKey: 'bankPage',
    render: () => `<div class="card"><h2>${t('bankAccounts')}</h2>
      <div class="note warn">${esc(t('bankNoFeed'))}</div>
      <table style="margin-top:8px"><tr><th>${t('bankName')}</th><th>${t('bankType')}</th><th>${t('bankLedger')}</th></tr>${S.accounts.map((a) => `<tr><td>${esc(a.name)}</td><td>${t(`bankT_${a.type}`)}</td><td>${esc(a.ledgerCode)}</td></tr>`).join('')}</table>
      <div class="row"><label class="inline">${t('bankAccount')} ${acctSelect()}</label></div>
      ${has('banking.import') ? `<div class="row"><input type="text" id="bank-new-name" placeholder="${t('bankName')}"><select id="bank-new-type"><option value="bank">${t('bankT_bank')}</option><option value="cash">${t('bankT_cash')}</option><option value="wallet">${t('bankT_wallet')}</option></select>
        <button data-act="bank-add-account">${t('bankAdd')}</button></div>` : ''}</div>` });
  App.onChange('bank-account', (el) => { S.accountId = Number(el.value); S.preview = null; App.reload(); });
  App.on('bank-add-account', () => run(() => api('POST', '/api/banking/accounts', { name: val('bank-new-name'), type: val('bank-new-type') }), t('saved')));

  // ---- import wizard ----
  const MAPFIELDS = [['dateCol', 'bankDateCol', true], ['descriptionCol', 'bankDescCol'], ['referenceCol', 'bankRefCol'], ['amountCol', 'bankAmtCol'], ['debitCol', 'bankDebitCol'], ['creditCol', 'bankCreditCol'], ['balanceCol', 'bankBalCol']];
  const DATEFMT = ['YYYY-MM-DD', 'YYYY/MM/DD', 'DD/MM/YYYY', 'DD-MM-YYYY', 'DD.MM.YYYY', 'MM/DD/YYYY', 'MM-DD-YYYY', 'D/M/YYYY'];
  const colSelect = (key, headers) => `<select data-act="bank-map" data-key="${key}"><option value="">${t('bankNone')}</option>${headers.map((h) => `<option value="${esc(h)}" ${S.map[key] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select>`;

  const previewHtml = (p) => `<div class="sub">${p.totalRows} ${t('bankRows')} · <b>${p.goodRows}</b> ${t('bankNew')} · ${p.duplicateRows} ${t('bankDup')} · <b>${p.errorRows}</b> ${t('bankErrs')}</div>
    ${p.errors.length ? `<div class="note bad"><table>${p.errors.slice(0, 10).map((e) => `<tr><td>${t('bankRowNo')} ${e.row ?? '-'}</td><td>${esc(e.message)}</td></tr>`).join('')}</table></div>` : ''}
    <table style="margin-top:6px"><tr><th>${t('bankRowNo')}</th><th>${t('date')}</th><th>${t('bankName')}</th><th class="num">${t('amount')}</th><th></th></tr>${p.lines.slice(0, 12).map((l) => `<tr><td>${l.row}</td><td>${esc(l.date)}</td><td>${esc(l.description)}</td><td class="num">${money(l.amount)}</td><td>${l.status === 'duplicate' ? `<span class="chip warn">${t('bankDup')}</span>` : ''}</td></tr>`).join('')}</table>
    <div class="row">${p.status === 'preview' ? `<label class="inline"><input type="checkbox" data-act="bank-skip" ${S.skipErrors ? 'checked' : ''}> ${t('bankSkipErr')}</label>
      <button class="primary" data-act="bank-commit" data-id="${p.id}">${t('bankCommit')}</button><button data-act="bank-discard" data-id="${p.id}">${t('bankDiscard')}</button>` : `<span class="chip good">${t(`bankStatus_${p.status}`)}</span>`}</div>`;

  App.addCard({ id: 'banking.import', area: 'main', order: 310, permission: 'banking.import', page: 'banking', pageTitleKey: 'bankPage',
    render: () => `<div class="card"><h2>${t('bankImport')}</h2>
      ${S.preview ? `<h3 class="sub">${t('bankStep3')}</h3>${previewHtml(S.preview)}<div class="row"><button data-act="bank-reset">${t('bankBack')}</button></div>`
      : !S.inspect ? `<h3 class="sub">${t('bankStep1')}</h3><div class="row"><input type="file" accept=".csv,text/csv,text/plain" data-act="bank-file"></div>
        <textarea id="bank-csv" data-act="bank-csv" rows="5" style="width:100%;margin-top:8px" placeholder="${t('bankPaste')}">${esc(S.csv)}</textarea>
        <div class="row"><button class="primary" data-act="bank-inspect">${t('bankRead')}</button></div>`
      : `<h3 class="sub">${t('bankStep2')}</h3><table>${MAPFIELDS.map(([k, label]) => `<tr><td>${t(label)}</td><td>${colSelect(k, S.inspect.headers)}</td></tr>`).join('')}
        <tr><td>${t('bankDateFmt')}</td><td><select data-act="bank-map" data-key="dateFormat">${DATEFMT.map((f) => `<option ${S.map.dateFormat === f ? 'selected' : ''}>${f}</option>`).join('')}</select></td></tr>
        <tr><td>${t('bankDecimal')}</td><td><select data-act="bank-map" data-key="decimal"><option value="auto">${t('bankAuto')}</option><option value="." ${S.map.decimal === '.' ? 'selected' : ''}>.</option><option value="," ${S.map.decimal === ',' ? 'selected' : ''}>,</option></select></td></tr></table>
        <div class="row"><label class="inline"><input type="checkbox" data-act="bank-invert" ${S.map.invertSign ? 'checked' : ''}> ${t('bankInvert')}</label>
        <label class="inline"><input type="checkbox" data-act="bank-savemap" ${S.saveMap ? 'checked' : ''}> ${t('bankSaveMap')}</label></div>
        <div class="row"><button class="primary" data-act="bank-preview">${t('bankPreview')}</button><button data-act="bank-reset">${t('bankBack')}</button></div>`}
      <h2 style="margin-top:14px">${t('bankBatches')}</h2>
      <table>${S.batches.slice(0, 6).map((b) => `<tr><td>#${b.id}</td><td>${esc(b.filename ?? '')}</td><td>${b.goodRows}/${b.totalRows}</td><td><span class="chip ${b.status === 'committed' ? 'good' : b.status === 'preview' ? 'warn' : 'mute'}">${t(`bankStatus_${b.status}`)}</span></td>
        <td>${b.status !== 'rolled_back' ? `<button class="small" data-act="bank-rollback" data-id="${b.id}">${t('bankRollback')}</button>` : ''}</td></tr>`).join('')}</table>
      <div class="row"><input type="text" id="bank-reason-imp" data-act="bank-reason" value="${esc(S.reason)}" placeholder="${t('bankReasonPh')}"></div></div>` });

  App.onInput('bank-csv', (el) => { S.csv = el.value; });
  App.onInput('bank-reason', (el) => { S.reason = el.value; });
  App.onChange('bank-file', (el) => {
    const f = el.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { S.csv = String(r.result); S.filename = f.name; App.render(); };
    r.readAsText(f, 'utf-8');
  });
  App.onChange('bank-map', (el) => { S.map[el.dataset.key] = el.value || null; });
  App.onChange('bank-invert', (el) => { S.map.invertSign = el.checked; });
  App.onChange('bank-savemap', (el) => { S.saveMap = el.checked; });
  App.onChange('bank-skip', (el) => { S.skipErrors = el.checked; });
  App.on('bank-reset', () => { S.inspect = null; S.preview = null; S.csv = ''; S.map = {}; App.render(); });
  App.on('bank-inspect', async () => {
    try {
      S.csv = val('bank-csv') || S.csv;
      S.inspect = await api('POST', '/api/banking/csv/inspect', { csv: S.csv });
      S.map = { ...S.inspect.suggested };
      App.render();
    } catch (e) { App.toast(e.message); }
  });
  App.on('bank-preview', async () => {
    try {
      const mapping = Object.fromEntries(Object.entries(S.map).filter(([, v]) => v != null && v !== ''));
      S.preview = await api('POST', '/api/banking/imports', { accountId: S.accountId, csv: S.csv, filename: S.filename, mapping, saveMapping: S.saveMap });
      await App.reload();
    } catch (e) { App.toast(e.message); }
  });
  App.on('bank-commit', (el) => run(async () => { await api('POST', `/api/banking/imports/${el.dataset.id}/commit`, { skipErrors: S.skipErrors }); S.preview = null; S.inspect = null; S.csv = ''; }, t('saved')));
  App.on('bank-discard', (el) => run(async () => { await api('POST', `/api/banking/imports/${el.dataset.id}/rollback`, { reason: 'Discarded preview' }); S.preview = null; }, t('saved')));
  App.on('bank-rollback', (el) => run(() => api('POST', `/api/banking/imports/${el.dataset.id}/rollback`, reasonOnly()), t('saved')));

  // ---- queue ----
  const suggestionHtml = (lineId, s) => `<div class="note ${s.confidence >= 80 ? 'good' : 'warn'}" style="margin-top:4px">
      <b>${esc(s.title)}</b> <span class="chip ${s.confidence >= 80 ? 'good' : 'warn'}">${s.confidence}% ${t('bankConf')}</span>
      <ul style="margin:4px 0;padding-inline-start:18px">${s.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      <div class="sub">${t('bankCreates')}: ${esc(s.creates)}</div>
      ${has('banking.reconcile') ? `<div class="row"><button class="small primary" data-act="bank-accept" data-id="${lineId}" data-kind="${s.kind}" data-ref="${s.refId}">${t('bankAccept')}</button>
        <button class="small" data-act="bank-reject" data-id="${lineId}" data-kind="${s.kind}" data-ref="${s.refId}">${t('bankReject')}</button></div>` : ''}</div>`;

  App.addCard({ id: 'banking.queue', area: 'main', order: 320, permission: 'banking.view', page: 'banking', pageTitleKey: 'bankPage',
    render: () => {
      const canRec = has('banking.reconcile');
      const rows = S.show === 'unreconciled'
        ? S.queue.map(({ line: l, suggestions }) => `<tr><td>${esc(l.date)}</td><td>${esc(l.description)}<div class="sub">${esc(l.reference)}</div></td><td class="num">${money(l.amount)}</td><td>${methodSelect(l.id, l.method, canRec)}</td></tr>
          <tr><td colspan="4">${suggestions.length ? suggestions.map((s) => suggestionHtml(l.id, s)).join('') : `<span class="sub">${t('bankNoSuggest')}</span>`}
          ${canRec ? `<div class="row"><input type="text" id="bank-code-${l.id}" placeholder="${t('bankAcctCode')}" style="max-width:110px"><button class="small" data-act="bank-post" data-id="${l.id}">${t('bankPostEntry')}</button>
            <input type="text" id="bank-man-${l.id}" placeholder="${t('bankManual')}" style="max-width:150px"><button class="small" data-act="bank-manual" data-id="${l.id}">OK</button></div>` : ''}</td></tr>`).join('')
        : S.reconciled.map((l) => `<tr><td>${esc(l.date)}</td><td>${esc(l.description)}</td><td class="num">${money(l.amount)}</td><td><span class="chip good">${esc(l.matchKind ?? '')}</span> ${canRec ? `<button class="small" data-act="bank-unrec" data-id="${l.id}">${t('bankUnrecBtn')}</button>` : ''}</td></tr>`).join('');
      return `<div class="card"><h2>${S.show === 'unreconciled' ? t('bankQueue') : t('bankReconciled')}</h2>
        <div class="row"><select data-act="bank-show"><option value="unreconciled" ${S.show === 'unreconciled' ? 'selected' : ''}>${t('bankQueue')}</option><option value="reconciled" ${S.show === 'reconciled' ? 'selected' : ''}>${t('bankReconciled')}</option></select>
        ${canRec ? `<input type="text" data-act="bank-reason" id="bank-reason-q" value="${esc(S.reason)}" placeholder="${t('bankReasonPh')}">` : ''}</div>
        ${rows ? `<table style="margin-top:8px">${rows}</table>` : `<p class="empty">${t('bankEmpty')}</p>`}</div>`;
    } });
  App.onChange('bank-show', (el) => { S.show = el.value; App.reload(); });
  App.onChange('bank-method', (el) => run(() => api('POST', `/api/banking/lines/${el.dataset.id}/method`, { method: el.value }), t('saved')));
  App.on('bank-accept', (el) => run(() => api('POST', `/api/banking/lines/${el.dataset.id}/accept`, { kind: el.dataset.kind, refId: Number(el.dataset.ref), ...lockOpts() }), t('saved')));
  App.on('bank-reject', (el) => run(() => api('POST', `/api/banking/lines/${el.dataset.id}/reject`, { kind: el.dataset.kind, refId: Number(el.dataset.ref) }), t('saved')));
  App.on('bank-post', (el) => run(() => api('POST', `/api/banking/lines/${el.dataset.id}/create-entry`, { accountCode: val(`bank-code-${el.dataset.id}`) || undefined, ...lockOpts() }), t('saved')));
  App.on('bank-manual', (el) => run(() => api('POST', `/api/banking/lines/${el.dataset.id}/reconcile`, { journalLineId: Number(val(`bank-man-${el.dataset.id}`)), ...reasonOnly() }), t('saved')));
  App.on('bank-unrec', (el) => run(() => api('POST', `/api/banking/lines/${el.dataset.id}/unreconcile`, reasonOnly()), t('saved')));

  // ---- rules editor ----
  App.addCard({ id: 'banking.rules', area: 'main', order: 330, permission: 'banking.view', page: 'banking', pageTitleKey: 'bankPage',
    render: () => {
      const edit = has('banking.rules');
      return `<div class="card"><h2>${t('bankRules')}</h2>
      <table><tr><th>#</th><th>${t('bankRuleName')}</th><th>${t('bankPattern')}</th><th>${t('bankAcctCode')}</th><th></th></tr>${S.rules.map((r) => `<tr class="${r.active ? '' : 'sub'}"><td>${r.priority}</td><td>${esc(r.name)}</td>
        <td><span class="chip mute">${t(r.matchType === 'regex' ? 'bankRegex' : 'bankContains')}</span> ${esc(r.pattern)}${r.minAmount != null || r.maxAmount != null ? `<div class="sub">${r.minAmount != null ? money(r.minAmount) : ''} - ${r.maxAmount != null ? money(r.maxAmount) : ''}</div>` : ''}</td>
        <td>${esc(r.accountCode)}</td><td>${edit && r.active ? `<button class="small" data-act="bank-rule-archive" data-id="${r.id}">${t('bankArchive')}</button>` : ''}</td></tr>`).join('')}</table>
      ${edit ? `<div class="row"><input type="text" id="bank-r-name" placeholder="${t('bankRuleName')}"><input type="number" id="bank-r-prio" value="100" style="width:80px" title="${t('bankPriority')}">
        <select id="bank-r-type"><option value="contains">${t('bankContains')}</option><option value="regex">${t('bankRegex')}</option></select><input type="text" id="bank-r-pattern" placeholder="${t('bankPattern')}"></div>
        <div class="row"><select id="bank-r-dir"><option value="any">${t('bankAny')}</option><option value="in">${t('bankIn')}</option><option value="out">${t('bankOut')}</option></select>
        <input type="number" id="bank-r-min" placeholder="${t('bankMin')}" style="width:90px"><input type="number" id="bank-r-max" placeholder="${t('bankMax')}" style="width:90px">
        <input type="text" id="bank-r-code" placeholder="${t('bankAcctCode')}" style="max-width:100px"><input type="text" id="bank-r-memo" placeholder="${t('bankMemo')}"></div>
        <div class="row"><input type="text" id="bank-r-sample" placeholder="${t('bankSample')}"><button data-act="bank-rule-test">${t('bankTest')}</button><button class="primary" data-act="bank-rule-add">${t('bankAdd')}</button></div>
        ${S.ruleTest ? `<div class="note ${S.ruleTest.sample?.matches ? 'good' : 'warn'}">${S.ruleTest.matchCount} ${t('bankMatches')}${S.ruleTest.sample ? ` · ${esc(S.ruleTest.sample.reasons.join('; ') || '-')}` : ''}</div>` : ''}` : ''}</div>`;
    } });
  const ruleBody = () => {
    const num = (id) => (val(id) === '' ? null : App.toPiastres(val(id)));
    return { name: val('bank-r-name'), priority: Number(val('bank-r-prio')), matchType: val('bank-r-type'), pattern: val('bank-r-pattern'), direction: val('bank-r-dir'),
      minAmount: num('bank-r-min'), maxAmount: num('bank-r-max'), accountCode: val('bank-r-code'), memo: val('bank-r-memo') };
  };
  App.on('bank-rule-add', () => run(() => api('POST', '/api/banking/rules', ruleBody()), t('saved')));
  App.on('bank-rule-archive', (el) => run(() => api('DELETE', `/api/banking/rules/${el.dataset.id}`), t('saved')));
  App.on('bank-rule-test', async () => {
    try {
      const sample = val('bank-r-sample');
      const rule = { ...ruleBody(), name: val('bank-r-name') || 'test' };
      S.ruleTest = await api('POST', '/api/banking/rules/test', { rule, accountId: S.accountId, ...(sample ? { sample: { description: sample, amount: -10000 } } : {}) });
      App.render();
    } catch (e) { App.toast(e.message); }
  });

  // ---- reconciliation summary ----
  App.addCard({ id: 'banking.recon', area: 'main', order: 340, permission: 'banking.view', page: 'banking', pageTitleKey: 'bankPage',
    render: () => {
      const s = S.summary;
      if (!s) return '';
      const r = S.report;
      return `<div class="card"><h2>${t('bankRecon')}</h2>
        <div class="row"><label class="inline">${t('bankAsOf')} <input type="date" id="bank-asof" data-act="bank-asof" value="${esc(S.asOf || s.asOf)}"></label></div>
        ${s.statementBalance == null ? `<p class="empty">${t('bankNoStmt')}</p>` : `<table>
          <tr><td>${t('bankStmtBal')}</td><td class="num">${money(s.statementBalance)}</td></tr><tr><td>${t('bankLedBal')}</td><td class="num">${money(s.ledgerBalance)}</td></tr>
          <tr><td><b>${t('bankDifference')}</b></td><td class="num"><b>${money(s.difference)}</b></td></tr><tr><td>${t('bankUnexplained')}</td><td class="num">${money(s.unexplained)}</td></tr>
          <tr><td>${t('bankUnrecLines')}</td><td class="num">${s.unreconciledLines.count} · ${money(s.unreconciledLines.total)}</td></tr>
          <tr><td>${t('bankUnrecLedger')}</td><td class="num">${s.unreconciledLedger.count} · ${money(s.unreconciledLedger.total)}</td></tr></table>
          <span class="chip ${s.reconciled ? 'good' : 'warn'}">${t(s.reconciled ? 'bankClean' : 'bankOpen')}</span>`}
        ${r && r.unreconciledLedger.length ? `<table style="margin-top:8px">${r.unreconciledLedger.slice(0, 6).map((e) => `<tr><td>#${e.journalLineId}</td><td>${esc(e.date)}</td><td>${esc(e.memo)}</td><td class="num">${money(e.amount)}</td></tr>`).join('')}</table>` : ''}
        ${has('banking.reconcile') && s.statementBalance != null ? `<div class="row"><input type="text" id="bank-note" placeholder="${t('bankNote')}"><button data-act="bank-signoff">${t('bankSignoff')}</button></div>` : ''}
        ${r?.signoffs?.length ? `<div class="sub" style="margin-top:6px">${t('bankSignoff')}: ${esc(r.signoffs[0].asOf)} · ${money(r.signoffs[0].difference)}</div>` : ''}</div>`;
    } });
  App.onChange('bank-asof', (el) => { S.asOf = el.value; App.reload(); });
  App.on('bank-signoff', () => run(() => api('POST', '/api/banking/reconciliation/signoff', { accountId: S.accountId, date: S.asOf || undefined, note: val('bank-note') }), t('saved')));
}
