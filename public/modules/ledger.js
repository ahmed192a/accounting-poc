// Ledger: recent entries with reversal (reason required), trial-balance status, period lock.
export default function register(App) {
  const { t, esc, money, has, api, run } = App;

  App.i18n.add('en', {
    ledger: 'Ledger', balanced: 'Trial balance balanced', unbalanced: 'Trial balance NOT balanced', lock: 'Period lock', lockNone: 'No lock set',
    soft: 'soft', hard: 'hard', none: 'none', apply: 'Apply', reverse: 'Reverse', reversed: 'reversed', reversal: 'reversal', memo: 'Memo',
    reasonFor: 'Reason for reversal',
  });
  App.i18n.add('ar', {
    ledger: 'دفتر اليومية', balanced: 'ميزان المراجعة متوازن', unbalanced: 'ميزان المراجعة غير متوازن', lock: 'إقفال الفترة', lockNone: 'لا يوجد إقفال',
    soft: 'مرن', hard: 'نهائي', none: 'إلغاء', apply: 'تطبيق', reverse: 'عكس القيد', reversed: 'معكوس', reversal: 'قيد عكسي', memo: 'البيان',
    reasonFor: 'سبب عكس القيد',
  });

  const val = (i) => document.getElementById(i)?.value ?? '';

  const lockControls = (lock) => `<div class="sub">${t('lock')}: ${lock?.through_date ? `${esc(lock.through_date)} (${t(lock.mode)})` : t('lockNone')}</div>
  ${has('period.lock') ? `<div class="row"><input type="date" id="lock-date" value="${lock?.through_date ?? ''}"><select id="lock-mode"><option value="soft">${t('soft')}</option><option value="hard">${t('hard')}</option><option value="none">${t('none')}</option></select><input type="text" id="lock-reason" placeholder="${t('reason')}"><button data-act="lock">${t('apply')}</button></div>` : ''}`;

  App.addCard({ id: 'ledger.main', area: 'main', order: 80, render: ({ widgets: w }) => !w.ledger ? (w.lock !== undefined ? `<div class="card"><h2>${t('lock')}</h2>${lockControls(w.lock)}</div>` : '') : `<div class="card"><h2>${t('ledger')}</h2>
  <span class="chip ${w.ledger.balanced ? 'good' : 'bad'}">${t(w.ledger.balanced ? 'balanced' : 'unbalanced')}</span>
  ${has('ledger.reverse') ? `<div class="row"><input type="text" id="rev-reason" placeholder="${t('reasonFor')}"></div>` : ''}
  <table style="margin-top:8px"><tr><th>#</th><th>${t('date')}</th><th>${t('memo')}</th><th class="num">${t('amount')}</th><th></th></tr>${w.ledger.entries.map((e) => `<tr>
   <td>${e.id}</td><td>${esc(e.entry_date)}</td><td>${esc(e.memo)}</td><td class="num">${money(e.amount)}</td>
   <td>${e.reversed ? `<span class="chip mute">${t('reversed')}</span>` : e.reverses_id ? `<span class="chip mute">${t('reversal')}</span>` : has('ledger.reverse') ? `<button class="small" data-act="reverse" data-id="${e.id}">${t('reverse')}</button>` : ''}</td></tr>`).join('')}</table>
  <div style="margin-top:10px">${lockControls(w.ledger.lock)}</div></div>` });

  App.on('reverse', (b) => run(() => api('POST', `/api/entries/${b.dataset.id}/reverse`, { reason: val('rev-reason') }), t('saved')));
  App.on('lock', () => run(() => api('POST', '/api/period-lock', { through: val('lock-date'), mode: val('lock-mode'), reason: val('lock-reason') }), t('saved')));
}
