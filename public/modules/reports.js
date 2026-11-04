// Reports: KPI + chart dashboard card and a report viewer (any statement, comparison period, CSV / print export,
// saved filters, drill-down from general-ledger rows to the journal entry).
export default function register(App) {
  const { t, esc, money, has, api, toast } = App;

  App.i18n.add('en', {
    reportsPage: 'Reports', reportsDash: 'Business dashboard', reportsViewer: 'Financial reports', reportsGross: 'Gross margin',
    reportsDso: 'Days sales outstanding (approx.)', reportsCurrent: 'Current ratio', reportsNA: 'n/a', reportsData: 'Show data as a table',
    reportsRun: 'Run report', reportsFrom: 'From', reportsTo: 'To / as of', reportsCompare: 'Compare with', reportsNone: 'No comparison',
    reportsPrev: 'Previous period', reportsYear: 'Same period last year', reportsAccount: 'Account code', reportsCsv: 'Download CSV',
    reportsPrint: 'Print / HTML', reportsSaveName: 'Filter name', reportsSave: 'Save filter', reportsLoad: 'Saved filters', reportsApply: 'Apply',
    reportsDelete: 'Delete', reportsEntry: 'Entry', reportsChecksOk: 'Check passed', reportsChecksBad: 'Check FAILED', reportsEmpty: 'No rows for this period.',
    reportsMore: 'More rows exist: narrow the dates or page with offset.', reportsLines: 'Lines of the entry', reportsKpiNote: 'Approximations from the ledger; see docs/reports.md',
    reportsPick: 'Report', reportsShared: 'Share with everyone who can see reports', reportsExportDone: 'Download started.',
  });
  App.i18n.add('ar', {
    reportsPage: 'التقارير', reportsDash: 'لوحة مؤشرات النشاط', reportsViewer: 'التقارير المالية', reportsGross: 'هامش الربح الإجمالي',
    reportsDso: 'متوسط أيام التحصيل (تقريبي)', reportsCurrent: 'نسبة التداول', reportsNA: 'غير متاح', reportsData: 'عرض البيانات كجدول',
    reportsRun: 'تشغيل التقرير', reportsFrom: 'من', reportsTo: 'إلى / كما في', reportsCompare: 'مقارنة مع', reportsNone: 'بدون مقارنة',
    reportsPrev: 'الفترة السابقة', reportsYear: 'نفس الفترة من العام الماضي', reportsAccount: 'كود الحساب', reportsCsv: 'تنزيل CSV',
    reportsPrint: 'طباعة / HTML', reportsSaveName: 'اسم المرشح', reportsSave: 'حفظ المرشح', reportsLoad: 'المرشحات المحفوظة', reportsApply: 'تطبيق',
    reportsDelete: 'حذف', reportsEntry: 'القيد', reportsChecksOk: 'المراجعة سليمة', reportsChecksBad: 'فشلت المراجعة', reportsEmpty: 'لا توجد صفوف لهذه الفترة.',
    reportsMore: 'توجد صفوف أخرى: ضيّق التواريخ أو استخدم الإزاحة.', reportsLines: 'بنود القيد', reportsKpiNote: 'قيم تقريبية من الدفتر؛ راجع docs/reports.md',
    reportsPick: 'التقرير', reportsShared: 'مشاركة مع كل من يرى التقارير', reportsExportDone: 'بدأ التنزيل.',
  });

  const today = new Date().toISOString().slice(0, 10);
  const S = { catalogue: null, dash: null, filters: [], name: 'profit-loss', from: `${today.slice(0, 4)}-01-01`, to: today, compare: 'none', account: '', result: null, error: '', entry: null, filterName: '', shared: false };
  const ar = () => App.state.lang === 'ar';
  const label = (o) => (ar() ? o.ar : o.en);
  const num = (v, d = 1) => (v == null ? t('reportsNA') : Number(v).toLocaleString(App.loc(), { maximumFractionDigits: d }));

  App.onLoad(async (home) => {
    // Use the home payload the hook receives and skip stale loads (user switched meanwhile): avoids needless 403s.
    if (!home.permissions.includes('reports.view') || home.user?.id !== App.state.userId) { S.dash = null; S.catalogue = null; return; }
    // Not awaited: the shell renders at once and the reports cards appear when their data arrives.
    const uid = App.state.userId;
    Promise.all([api('GET', '/api/reports/dashboard'), api('GET', '/api/report-catalogue'), api('GET', '/api/report-filters')]).then(([d, c, f]) => {
      if (uid !== App.state.userId) return;
      [S.dash, S.catalogue, S.filters] = [d, c, f];
      if (!c.reports.some((r) => r.name === S.name)) S.name = c.reports[0]?.name ?? 'profit-loss';
      App.render();
    }).catch((e) => { S.error = e.message; App.render(); });
  });
  App.onUserChange(() => { S.result = null; S.entry = null; S.error = ''; S.dash = null; S.catalogue = null; });

  const kpi = (title, v) => `<div><div class="sub">${esc(title)}</div><div class="big">${v}</div></div>`;
  const chartBlock = (c) => `<div role="group" aria-label="${esc(label(c.title))}">${c.svg[App.state.lang]}
    <details><summary class="sub">${t('reportsData')}</summary><table><tbody>${c.data.map((d) => `<tr><td>${esc(ar() && d.label_ar ? d.label_ar : d.label)}</td><td class="num">${money(d.value)}</td></tr>`).join('') || `<tr><td class="empty">${t('reportsEmpty')}</td></tr>`}</tbody></table></details></div>`;

  App.addCard({
    id: 'reports.dashboard', area: 'main', order: 140, permission: 'reports.view', page: 'reports', pageTitleKey: 'reportsPage',
    render: () => {
      if (!S.dash) return '';
      const k = S.dash.kpis;
      return `<div class="card" style="grid-column:1/-1"><h2>${t('reportsDash')}</h2>
        <div class="stats">${kpi(t('reportsGross'), k.grossMarginPct == null ? t('reportsNA') : `${num(k.grossMarginPct, 2)}%`)}${kpi(t('reportsDso'), num(k.dsoDays))}${kpi(t('reportsCurrent'), num(k.currentRatio, 2))}</div>
        <div class="sub">${t('reportsKpiNote')}</div>
        <div class="grid" style="margin-top:10px">${S.dash.charts.map(chartBlock).join('')}</div></div>`;
    },
  });

  const cell = (c, v) => {
    if (v == null) return '';
    if (c.type === 'money') return money(v);
    if (c.type === 'num') return Number(v).toLocaleString(App.loc());
    return esc(v);
  };
  const resultTable = (r) => {
    const head = r.columns.map((c) => `<th class="${c.type === 'money' || c.type === 'num' ? 'num' : ''}">${esc(label(c))}</th>`).join('');
    const drill = has('reports.advanced') && r.columns.some((c) => c.key === 'entryId');
    const body = r.rows.map((row) => `<tr${row.kind === 'total' || row.kind === 'header' || row.kind === 'subtotal' || row.kind === 'check' ? ' style="font-weight:600"' : ''}>${r.columns.map((c) => {
      if (c.key === 'entryId' && row.entryId != null && drill) return `<td class="num"><button class="small" data-act="reports-entry" data-id="${row.entryId}" aria-label="${t('reportsEntry')} ${row.entryId}">#${row.entryId}</button></td>`;
      return `<td class="${c.type === 'money' || c.type === 'num' ? 'num' : ''}">${cell(c, row[c.key])}</td>`;
    }).join('')}</tr>`).join('');
    return `<div style="overflow-x:auto"><table><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td class="empty">${t('reportsEmpty')}</td></tr>`}</tbody></table></div>`;
  };
  const entryBox = () => !S.entry ? '' : `<div class="note good"><b>${t('reportsEntry')} #${S.entry.entry.id}</b> ${esc(S.entry.entry.entry_date)} ${esc(S.entry.entry.memo)}
    <table>${S.entry.lines.map((l) => `<tr><td>${esc(l.code)} ${esc(ar() ? l.name_ar : l.name)}</td><td class="num">${l.debit ? money(l.debit) : ''}</td><td class="num">${l.credit ? money(l.credit) : ''}</td></tr>`).join('')}</table></div>`;

  const field = (f, type, value, extra = '') => `<input type="${type}" value="${esc(value)}" data-act="reports-field" data-f="${f}" ${extra}>`;
  App.addCard({
    id: 'reports.viewer', area: 'main', order: 141, permission: 'reports.view', page: 'reports', pageTitleKey: 'reportsPage',
    render: () => {
      if (!S.catalogue) return S.error ? `<div class="card"><h2>${t('reportsViewer')}</h2><div class="note bad">${esc(S.error)}</div></div>` : '';
      const cur = S.catalogue.reports.find((r) => r.name === S.name);
      const r = S.result;
      return `<div class="card" style="grid-column:1/-1"><h2>${t('reportsViewer')}</h2>
      <div class="row"><label>${t('reportsPick')} <select data-act="reports-field" data-f="name">${S.catalogue.reports.map((x) => `<option value="${esc(x.name)}" ${x.name === S.name ? 'selected' : ''}>${esc(label(x.title))}</option>`).join('')}</select></label>
        <label>${t('reportsFrom')} ${field('from', 'date', S.from)}</label><label>${t('reportsTo')} ${field('to', 'date', S.to)}</label>
        ${cur?.comparable ? `<label>${t('reportsCompare')} <select data-act="reports-field" data-f="compare"><option value="none">${t('reportsNone')}</option><option value="previous" ${S.compare === 'previous' ? 'selected' : ''}>${t('reportsPrev')}</option><option value="year" ${S.compare === 'year' ? 'selected' : ''}>${t('reportsYear')}</option></select></label>` : ''}
        ${['general-ledger', 'account-transactions'].includes(S.name) ? `<label>${t('reportsAccount')} ${field('account', 'text', S.account, 'size="6"')}</label>` : ''}
        <button data-act="reports-run">${t('reportsRun')}</button>
        ${has('reports.export') ? `<button data-act="reports-export" data-fmt="csv">${t('reportsCsv')}</button><button data-act="reports-export" data-fmt="html">${t('reportsPrint')}</button>` : ''}</div>
      <div class="row"><label>${t('reportsLoad')} <select id="reports-filter-pick">${S.filters.filter((f) => f.report === S.name).map((f) => `<option value="${f.id}">${esc(f.name)}${f.shared ? ' *' : ''}</option>`).join('')}</select></label>
        <button class="small" data-act="reports-apply">${t('reportsApply')}</button><button class="small" data-act="reports-delfilter">${t('reportsDelete')}</button>
        ${field('filterName', 'text', S.filterName, `placeholder="${esc(t('reportsSaveName'))}"`)}
        ${has('reports.advanced') ? `<label><input type="checkbox" data-act="reports-share" ${S.shared ? 'checked' : ''}> ${t('reportsShared')}</label>` : ''}
        <button class="small" data-act="reports-save">${t('reportsSave')}</button></div>
      ${S.error ? `<div class="note bad" role="alert">${esc(S.error)}</div>` : ''}
      ${r ? `<h3>${esc(label(r.title))}</h3>${r.checks.map((c) => `<span class="chip ${c.ok ? 'good' : 'bad'}">${t(c.ok ? 'reportsChecksOk' : 'reportsChecksBad')}: ${esc(label(c))}</span> `).join('')}
        ${r.summary?.hasMore ? `<div class="note warn">${t('reportsMore')}</div>` : ''}${resultTable(r)}${entryBox()}` : ''}</div>`;
    },
  });

  const params = () => {
    const q = new URLSearchParams({ from: S.from, to: S.to, lang: App.state.lang });
    if (S.compare !== 'none') q.set('compare', S.compare);
    if (S.account) q.set('account', S.account);
    return q;
  };
  const guard = async (fn) => { S.error = ''; try { await fn(); } catch (e) { S.error = e.message; toast(e.message); } App.render(); };

  App.onChange('reports-field', (el) => { S[el.dataset.f] = el.value; if (el.dataset.f === 'name') { S.result = null; S.entry = null; App.render(); } });
  App.onChange('reports-share', (el) => { S.shared = el.checked; });
  App.on('reports-run', () => guard(async () => { S.entry = null; S.result = await api('GET', `/api/reports/${S.name}?${params()}`); }));
  App.on('reports-entry', (el) => guard(async () => { S.entry = await api('GET', `/api/report-entries/${el.dataset.id}`); }));
  App.on('reports-save', () => guard(async () => {
    const p = Object.fromEntries(params()); delete p.lang;
    await api('POST', '/api/report-filters', { report: S.name, name: S.filterName, params: p, shared: S.shared });
    S.filters = await api('GET', '/api/report-filters'); S.filterName = ''; toast(t('saved'), true);
  }));
  App.on('reports-apply', () => guard(async () => {
    const f = S.filters.find((x) => String(x.id) === document.getElementById('reports-filter-pick')?.value);
    if (!f) return;
    Object.assign(S, { from: f.params.from ?? S.from, to: f.params.to ?? S.to, compare: f.params.compare ?? 'none', account: f.params.account ?? '' });
    S.result = await api('GET', `/api/reports/${S.name}?${params()}`);
  }));
  App.on('reports-delfilter', () => guard(async () => {
    const id = document.getElementById('reports-filter-pick')?.value;
    if (!id) return;
    await api('DELETE', `/api/report-filters/${id}`);
    S.filters = await api('GET', '/api/report-filters');
  }));
  App.on('reports-export', (el) => guard(async () => {
    const q = params(); q.set('format', el.dataset.fmt);
    const res = await fetch(`/api/reports/${S.name}?${q}`, { headers: { 'x-user-id': String(App.state.userId) } });
    const ctype = res.headers.get('content-type') ?? '';
    let body, type, filename;
    if (ctype.includes('application/json')) {
      const j = await res.json();
      if (!res.ok) throw new Error(j.error?.message ?? 'Error');
      ({ body, contentType: type, filename } = j.__raw); // the server wraps non-JSON output in a JSON envelope (see docs/reports.md)
    } else { body = await res.text(); type = ctype; filename = `${S.name}.${el.dataset.fmt}`; }
    if (el.dataset.fmt === 'html') {
      const w = window.open('', '_blank');
      if (w) { w.document.open(); w.document.write(body); w.document.close(); w.focus(); setTimeout(() => w.print(), 300); return; }
    }
    const url = URL.createObjectURL(new Blob([body], { type }));
    const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(t('reportsExportDone'), true);
  }));
}
