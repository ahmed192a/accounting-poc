// Audit log: recent entries with search.
export default function register(App) {
  const { t, esc, api, run, state } = App;

  App.i18n.add('en', { audit: 'Audit log', search: 'Search' });
  App.i18n.add('ar', { audit: 'سجل التدقيق', search: 'بحث' });

  let q = '';

  App.onLoad(async (home) => {
    if (home.widgets.audit && q) home.widgets.audit = await api('GET', '/api/audit?q=' + encodeURIComponent(q));
  });

  App.addCard({ id: 'audit.log', area: 'main', order: 90, render: ({ widgets: w }) => !w.audit ? '' : `<div class="card"><h2>${t('audit')}</h2>
  <div class="row" style="margin-top:0"><input type="text" id="audit-q" value="${esc(q)}" placeholder="${t('search')}"><button data-act="audit">${t('search')}</button></div>
  <table style="margin-top:8px">${w.audit.map((a) => `<tr><td class="sub">${new Date(a.ts).toLocaleTimeString(App.loc())}</td><td>${esc(a.user_name)}</td><td>${esc(a.action)}</td><td class="sub">${esc(a.reason ?? (a.new_value ? a.new_value.slice(0, 40) : ''))}</td></tr>`).join('')}</table></div>` });

  App.on('audit', () => { q = document.getElementById('audit-q')?.value ?? ''; run(async () => {}); });
}
