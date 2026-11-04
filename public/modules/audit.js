// Audit log: recent entries with search.
export default function register(App) {
  const { t, esc, api, run, state } = App;

  App.i18n.add('en', { audit: 'Audit log', search: 'Search', auditPage: 'Audit', auditVerify: 'Verify integrity', auditIntact: 'Hash chain intact', auditBroken: 'TAMPERING DETECTED' });
  App.i18n.add('ar', { audit: 'سجل التدقيق', search: 'بحث', auditPage: 'التدقيق', auditVerify: 'التحقق من السلامة', auditIntact: 'سلسلة الهاش سليمة', auditBroken: 'تم اكتشاف تلاعب' });

  let q = '', verdict = null;

  App.onLoad(async (home) => {
    if (home.widgets.audit && q) home.widgets.audit = await api('GET', '/api/audit?q=' + encodeURIComponent(q));
  });

  App.addCard({ id: 'audit.log', area: 'main', order: 90, page: 'audit', pageTitleKey: 'auditPage', render: ({ widgets: w }) => !w.audit ? '' : `<div class="card"><h2>${t('audit')}</h2>
  <div class="row" style="margin-top:0"><input type="text" id="audit-q" value="${esc(q)}" placeholder="${t('search')}"><button data-act="audit">${t('search')}</button>${App.has('security.view') ? `<button data-act="audit-verify">${t('auditVerify')}</button>` : ''}</div>
  ${verdict ? `<div class="note ${verdict.ok ? 'good' : 'bad'}">${verdict.ok ? t('auditIntact') : t('auditBroken') + ': ' + verdict.problems.map((p) => '#' + p.auditId + ' ' + esc(p.kind)).join(', ')} (${verdict.sealed})</div>` : ''}
  <table style="margin-top:8px">${w.audit.map((a) => `<tr><td class="sub">${new Date(a.ts).toLocaleTimeString(App.loc())}</td><td>${esc(a.user_name)}</td><td>${esc(a.action)}</td><td class="sub">${esc(a.reason ?? (a.new_value ? a.new_value.slice(0, 40) : ''))}</td></tr>`).join('')}</table></div>` });

  App.on('audit', () => { q = document.getElementById('audit-q')?.value ?? ''; run(async () => {}); });
  App.on('audit-verify', () => run(async () => { verdict = await api('GET', '/api/audit/verify'); }));
}
