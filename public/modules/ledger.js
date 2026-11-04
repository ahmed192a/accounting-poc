// Ledger: recent entries with reversal (reason required), trial-balance status, period lock.
export default function register(App) {
  const { t, esc, money, has, api, run } = App;

  App.i18n.add('en', {
    ledger: 'Ledger', balanced: 'Trial balance balanced', unbalanced: 'Trial balance NOT balanced', lock: 'Period lock', lockNone: 'No lock set',
    soft: 'soft', hard: 'hard', none: 'none', apply: 'Apply', reverse: 'Reverse', reversed: 'reversed', reversal: 'reversal', memo: 'Memo',
    reasonFor: 'Reason for reversal',
    jeTitle: 'Manual journal entry', jeAccount: 'Account', jeAddLine: 'Add line', jePost: 'Post entry', jeDiff: 'Difference', jeCur: 'Currency', jeFx: 'Foreign amount',
    jeSoft: 'This date is in a soft-locked period: tick to confirm and give a reason.', jeHard: 'This date is in a hard-locked period: posting is blocked.', jeConfirm: 'Confirm posting into the locked period',
    jeRemove: 'Remove', debit: 'Debit', credit: 'Credit',
    closeTitle: 'Year-end closing', closeYear: 'Fiscal year (ending)', closeDo: 'Close year', closeReopen: 'Reopen (reverse)', closeProfit: 'Net profit', closeStatus: 'Status', closeDone: 'closed',
  });
  App.i18n.add('ar', {
    ledger: 'دفتر اليومية', balanced: 'ميزان المراجعة متوازن', unbalanced: 'ميزان المراجعة غير متوازن', lock: 'إقفال الفترة', lockNone: 'لا يوجد إقفال',
    soft: 'مرن', hard: 'نهائي', none: 'إلغاء', apply: 'تطبيق', reverse: 'عكس القيد', reversed: 'معكوس', reversal: 'قيد عكسي', memo: 'البيان',
    reasonFor: 'سبب عكس القيد',
    jeTitle: 'قيد يومية يدوي', jeAccount: 'الحساب', jeAddLine: 'إضافة سطر', jePost: 'ترحيل القيد', jeDiff: 'الفرق', jeCur: 'العملة', jeFx: 'المبلغ بالعملة الأجنبية',
    jeSoft: 'هذا التاريخ في فترة مقفلة مرنة: أكد وأدخل السبب.', jeHard: 'هذا التاريخ في فترة مقفلة نهائياً: الترحيل ممنوع.', jeConfirm: 'تأكيد الترحيل في الفترة المقفلة',
    jeRemove: 'حذف', debit: 'مدين', credit: 'دائن',
    closeTitle: 'إقفال السنة المالية', closeYear: 'السنة المالية (تنتهي في)', closeDo: 'إقفال السنة', closeReopen: 'إعادة فتح (عكس)', closeProfit: 'صافي الربح', closeStatus: 'الحالة', closeDone: 'مقفلة',
  });

  const val = (i) => document.getElementById(i)?.value ?? '';
  const eid = () => App.state.entityId ?? 1;
  const ex = { accounts: [], currencies: [], closings: [], entries: null, lines: [{}, {}], date: '' };

  App.onLoad(async (home) => {
    const jobs = [];
    if (has('ledger.post')) {
      jobs.push(api('GET', '/api/coa').then((r) => { ex.accounts = r.filter((a) => a.active); }).catch(() => {}));
      jobs.push(api('GET', '/api/currencies').then((r) => { ex.currencies = r.filter((c) => c.active); }).catch(() => { ex.currencies = []; }));
    }
    if (has('ledger.view')) {
      jobs.push(api('GET', `/api/ledger/closings?entityId=${eid()}`).then((r) => { ex.closings = r; }).catch(() => { ex.closings = []; }));
      // The home widget shows entity 1; for another entity fetch that entity's entries.
      jobs.push((eid() === 1 ? Promise.resolve(null) : api('GET', `/api/entries?entityId=${eid()}`)).then((r) => { ex.entries = r; }).catch(() => { ex.entries = null; }));
    }
    await Promise.all(jobs);
  });

  const lockControls = (lock) => `<div class="sub">${t('lock')}: ${lock?.through_date ? `${esc(lock.through_date)} (${t(lock.mode)})` : t('lockNone')}</div>
  ${has('period.lock') ? `<div class="row"><input type="date" id="lock-date" value="${lock?.through_date ?? ''}"><select id="lock-mode"><option value="soft">${t('soft')}</option><option value="hard">${t('hard')}</option><option value="none">${t('none')}</option></select><input type="text" id="lock-reason" placeholder="${t('reason')}"><button data-act="lock">${t('apply')}</button></div>` : ''}`;

  App.addCard({ id: 'ledger.main', area: 'main', order: 80, page: 'ledger', pageTitleKey: 'ledger', render: ({ widgets: w }) => !w.ledger ? (w.lock !== undefined ? `<div class="card"><h2>${t('lock')}</h2>${lockControls(w.lock)}</div>` : '') : `<div class="card"><h2>${t('ledger')}</h2>
  <span class="chip ${w.ledger.balanced ? 'good' : 'bad'}">${t(w.ledger.balanced ? 'balanced' : 'unbalanced')}</span>
  ${has('ledger.reverse') ? `<div class="row"><input type="text" id="rev-reason" placeholder="${t('reasonFor')}"></div>` : ''}
  <table style="margin-top:8px"><tr><th>#</th><th>${t('date')}</th><th>${t('memo')}</th><th class="num">${t('amount')}</th><th></th></tr>${(eid() === 1 || !ex.entries ? w.ledger.entries : ex.entries).map((e) => `<tr>
   <td>${e.id}</td><td>${esc(e.entry_date)}</td><td>${esc(e.memo)}</td><td class="num">${money(e.amount)}</td>
   <td>${e.reversed ? `<span class="chip mute">${t('reversed')}</span>` : e.reverses_id ? `<span class="chip mute">${t('reversal')}</span>` : has('ledger.reverse') ? `<button class="small" data-act="reverse" data-id="${e.id}">${t('reverse')}</button>` : ''}</td></tr>`).join('')}</table>
  <div style="margin-top:10px">${lockControls(w.ledger.lock)}</div></div>` });

  App.on('reverse', (b) => run(() => api('POST', `/api/entries/${b.dataset.id}/reverse`, { reason: val('rev-reason') }), t('saved')));
  App.on('lock', () => run(() => api('POST', '/api/period-lock', { through: val('lock-date'), mode: val('lock-mode'), reason: val('lock-reason') }), t('saved')));

  // ---------- manual journal entry: multi-line, live balance, lock warnings ----------
  const readLines = () => ex.lines.map((_, i) => ({
    account: val(`je-acc-${i}`), debit: val(`je-dr-${i}`), credit: val(`je-cr-${i}`), currency: val(`je-cur-${i}`), fx: val(`je-fx-${i}`),
  }));
  const sums = () => {
    const l = readLines();
    const d = l.reduce((a, x) => a + (x.fx && x.currency ? 0 : App.toPiastres(x.debit || 0)), 0);
    const c = l.reduce((a, x) => a + (x.fx && x.currency ? 0 : App.toPiastres(x.credit || 0)), 0);
    return { d, c, hasFx: l.some((x) => x.fx && x.currency) };
  };
  const lockState = (lock, date) => (!lock?.through_date || !date || date > lock.through_date ? null : lock.mode);
  const refreshLive = () => {
    const { d, c, hasFx } = sums();
    const el = document.getElementById('je-live'); if (!el) return;
    const ok = d === c && d > 0;
    el.className = `chip ${ok ? 'good' : 'bad'}`;
    el.textContent = hasFx ? `${t('jeDiff')}: ?` : `${t('debit')} ${money(d)} / ${t('credit')} ${money(c)} · ${t('jeDiff')} ${money(Math.abs(d - c))}`;
    const st = lockState(App.state.home?.widgets?.ledger?.lock ?? App.state.home?.widgets?.lock, val('je-date'));
    const warn = document.getElementById('je-warn');
    if (warn) warn.innerHTML = st === 'hard' ? `<span class="chip bad">${t('jeHard')}</span>` : st === 'soft' ? `<span class="chip mute">${t('jeSoft')}</span>` : '';
    const btn = document.getElementById('je-post'); if (btn) btn.disabled = st === 'hard' || (!hasFx && !ok);
  };
  App.onInput('je-field', refreshLive);
  App.onChange('je-field', refreshLive);

  App.addCard({
    id: 'ledger.entry', area: 'main', order: 81, page: 'ledger', pageTitleKey: 'ledger', permission: 'ledger.post',
    render: ({ widgets: w }) => {
      const accOpts = (sel) => `<option value=""></option>${ex.accounts.map((a) => `<option value="${esc(a.code)}" ${a.code === sel ? 'selected' : ''}>${esc(a.code)} ${esc(App.state.lang === 'ar' ? a.nameAr : a.name)}</option>`).join('')}`;
      const curOpts = (sel) => `<option value=""></option>${ex.currencies.filter((c) => c.code !== 'EGP').map((c) => `<option ${c.code === sel ? 'selected' : ''}>${esc(c.code)}</option>`).join('')}`;
      return `<div class="card"><h2>${t('jeTitle')}</h2>
      <div class="row"><input type="date" id="je-date" data-act="je-field" value="${esc(ex.date)}"><input type="text" id="je-memo" placeholder="${t('memo')}" style="flex:1"></div>
      <table style="margin-top:8px"><tr><th>${t('jeAccount')}</th><th class="num">${t('debit')}</th><th class="num">${t('credit')}</th><th>${t('jeCur')}</th><th>${t('jeFx')}</th><th></th></tr>
      ${ex.lines.map((l, i) => `<tr><td><select id="je-acc-${i}">${accOpts(l.account)}</select></td>
        <td><input type="number" step="0.01" min="0" id="je-dr-${i}" data-act="je-field" value="${esc(l.debit ?? '')}" style="width:100px"></td>
        <td><input type="number" step="0.01" min="0" id="je-cr-${i}" data-act="je-field" value="${esc(l.credit ?? '')}" style="width:100px"></td>
        <td><select id="je-cur-${i}" data-act="je-field">${curOpts(l.currency)}</select></td>
        <td><input type="number" step="0.01" min="0" id="je-fx-${i}" data-act="je-field" value="${esc(l.fx ?? '')}" style="width:100px"></td>
        <td>${ex.lines.length > 2 ? `<button class="small" data-act="je-del" data-i="${i}">${t('jeRemove')}</button>` : ''}</td></tr>`).join('')}</table>
      <div class="row" style="margin-top:8px"><button class="small" data-act="je-add">${t('jeAddLine')}</button><span id="je-live" class="chip mute"></span></div>
      <div id="je-warn"></div>
      <div class="row"><input type="text" id="je-reason" placeholder="${t('reason')}"><label><input type="checkbox" id="je-confirm"> ${t('jeConfirm')}</label>
        <button class="primary" id="je-post" data-act="je-post">${t('jePost')}</button></div></div>`;
    },
  });
  App.onLoad(() => { setTimeout(refreshLive, 0); });
  const keep = () => { ex.date = val('je-date'); ex.lines = readLines(); };
  App.on('je-add', () => { keep(); ex.lines.push({}); App.render(); });
  App.on('je-del', (b) => { keep(); ex.lines.splice(Number(b.dataset.i), 1); App.render(); });
  App.on('je-post', () => {
    const lines = readLines().filter((l) => l.account).map((l) => {
      if (l.fx && l.currency) {
        // Foreign line: the server converts with the stored rate; side is the column the user filled.
        return { account: l.account, currency: l.currency, fxAmount: App.toPiastres(l.fx), side: Number(l.credit) > 0 ? 'credit' : 'debit' };
      }
      return { account: l.account, ...(Number(l.debit) > 0 ? { debit: App.toPiastres(l.debit) } : { credit: App.toPiastres(l.credit) }) };
    });
    const body = {
      entityId: eid(), date: val('je-date') || undefined, memo: val('je-memo'), lines, allowRounding: true,
      confirmSoftLock: document.getElementById('je-confirm')?.checked || undefined, reason: val('je-reason') || undefined,
    };
    run(async () => { await api('POST', '/api/entries', body); ex.lines = [{}, {}]; ex.date = ''; }, t('saved'));
  });

  // ---------- year-end closing ----------
  App.addCard({
    id: 'ledger.close', area: 'main', order: 82, page: 'ledger', pageTitleKey: 'ledger', permission: 'ledger.close',
    render: () => `<div class="card"><h2>${t('closeTitle')}</h2>
      <div class="row"><input type="number" id="close-fy" placeholder="${t('closeYear')}" style="width:120px"><input type="text" id="close-reason" placeholder="${t('reason')}"><button data-act="close-year">${t('closeDo')}</button></div>
      <table style="margin-top:8px"><tr><th>${t('closeYear')}</th><th class="num">${t('closeProfit')}</th><th>${t('closeStatus')}</th><th></th></tr>${ex.closings.map((c) => `<tr>
        <td>${c.fiscalYear} (${esc(c.periodStart)} - ${esc(c.periodEnd)})</td><td class="num">${money(c.netProfit)}</td>
        <td>${c.reversed ? `<span class="chip mute">${t('reversed')}</span>` : `<span class="chip good">${t('closeDone')}</span>`}</td>
        <td>${c.reversed ? '' : `<button class="small" data-act="close-reopen" data-id="${c.id}">${t('closeReopen')}</button>`}</td></tr>`).join('')}</table></div>`,
  });
  App.on('close-year', () => run(() => api('POST', '/api/ledger/close-year', { entityId: eid(), fiscalYear: Number(val('close-fy')) || undefined, reason: val('close-reason') || undefined }), t('saved')));
  App.on('close-reopen', (b) => run(() => api('POST', `/api/ledger/closings/${b.dataset.id}/reverse`, { reason: val('close-reason') }), t('saved')));
}
