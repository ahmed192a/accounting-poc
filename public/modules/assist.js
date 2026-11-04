// Assist (MOCK AI): paste receipt text, review the suggestion, accept / edit / reject. Nothing posts by itself.
export default function register(App) {
  const { t, esc, money, has, api, run, toast } = App;

  App.i18n.add('en', {
    assistPage: 'Assist', asIntake: 'Smart intake (MOCK, no real OCR)', asPaste: 'Paste receipt or OCR text here', asSubmit: 'Get suggestion',
    asQueue: 'Review queue', asAccept: 'Accept', asReject: 'Reject', asUndo: 'Undo', asWhy: 'Reason?', asStats: 'Suggestion accuracy', asSample: 'reviewed',
    asUnchanged: 'accepted unchanged', asEdited: 'accepted after edits', asRejected: 'rejected', asNote: 'A suggestion never posts. Accepting creates a bill that still needs approval.',
    asSupplier: 'Supplier', asDate: 'Date', asTotal: 'Total (EGP)', asVat: 'VAT (EGP)', asCategory: 'Category', asConf: 'confidence', asAccepted: 'Accepted',
  });
  App.i18n.add('ar', {
    assistPage: 'المساعد', asIntake: 'إدخال ذكي (تجريبي، بدون OCR حقيقي)', asPaste: 'الصق نص الإيصال أو نتيجة OCR هنا', asSubmit: 'اقتراح',
    asQueue: 'قائمة المراجعة', asAccept: 'قبول', asReject: 'رفض', asUndo: 'تراجع', asWhy: 'السبب؟', asStats: 'دقة الاقتراحات', asSample: 'تمت مراجعتها',
    asUnchanged: 'قُبلت كما هي', asEdited: 'قُبلت بعد تعديل', asRejected: 'مرفوضة', asNote: 'الاقتراح لا يُرحَّل أبدا. القبول ينشئ فاتورة تحتاج إلى اعتماد.',
    asSupplier: 'المورد', asDate: 'التاريخ', asTotal: 'الإجمالي (ج.م)', asVat: 'الضريبة (ج.م)', asCategory: 'التصنيف', asConf: 'الثقة', asAccepted: 'مقبول',
  });

  const card = (id, order, perm, render) => App.addCard({ id, area: 'main', order, page: 'assist', pageTitleKey: 'assistPage', permission: perm, render });
  const val = (i) => document.getElementById(i)?.value ?? '';
  const chip = (c) => `<span class="chip ${c >= 0.8 ? 'good' : c >= 0.5 ? 'warn' : 'bad'}" title="${t('asConf')}">${Math.round(c * 100)}%</span>`;
  const eg = (p) => (p == null ? '' : (p / 100).toFixed(2));

  card('assist.intake', 120, 'assist.use', () => `<div class="card"><h2>${t('asIntake')}</h2><div class="sub">${t("asNote")}</div>
  <textarea id="as-text" rows="5" style="width:100%" placeholder="${t('asPaste')}"></textarea><button class="primary" data-act="as-submit">${t('asSubmit')}</button></div>`);

  card('assist.queue', 122, 'assist.review', ({ widgets: w }) => {
    const items = w.assist?.items ?? [];
    const pending = items.filter((i) => i.status === 'pending'), accepted = items.filter((i) => i.status === 'accepted').slice(0, 5);
    const field = (i, k, label, v) => `<label class="sub">${label} ${i.confidence[k] != null ? chip(i.confidence[k]) : ''}<input type="text" id="as-${k}-${i.id}" value="${esc(v ?? '')}" title="${esc(i.reasons[k] ?? '')}"></label><div class="sub">${esc(i.reasons[k] ?? '')}</div>`;
    return `<div class="card"><h2>${t('asQueue')}</h2>${pending.length ? pending.map((i) => `<div class="row" style="flex-direction:column;align-items:stretch">
      ${field(i, 'supplier', t('asSupplier'), i.suggestion.supplier)}${field(i, 'date', t('asDate'), i.suggestion.date)}${field(i, 'total', t('asTotal'), eg(i.suggestion.total))}
      ${field(i, 'vat', t('asVat'), eg(i.suggestion.vat))}${field(i, 'category', t('asCategory'), i.suggestion.category)}
      <div><button class="small primary" data-act="as-accept" data-id="${i.id}">${t('asAccept')}</button> <button class="small" data-act="as-reject" data-id="${i.id}">${t('asReject')}</button></div></div><hr>`).join('') : `<div class="empty">${t('nothing')}</div>`}
    ${accepted.length ? `<table>${accepted.map((i) => `<tr><td>${t('asAccepted')} #${i.id} ${esc(i.final_fields?.supplier ?? '')}</td><td class="num">${money(i.final_fields?.total ?? 0)}</td>
      <td class="num"><button class="small" data-act="as-undo" data-id="${i.id}">${t('asUndo')}</button></td></tr>`).join('')}</table>` : ''}</div>`;
  });

  card('assist.stats', 124, (h) => !!h.widgets.assist, ({ widgets: w }) => {
    const s = w.assist.stats;
    return `<div class="card"><h2>${t('asStats')}</h2><div class="big">${s.sampleSize} <span class="sub">${t('asSample')}</span></div>
    <table><tr><td>${t('asUnchanged')}</td><td class="num">${s.acceptedUnchanged}${s.acceptedUnchangedPct == null ? '' : ` (${s.acceptedUnchangedPct}%)`}</td></tr>
    <tr><td>${t('asEdited')}</td><td class="num">${s.acceptedEdited}${s.editedPct == null ? '' : ` (${s.editedPct}%)`}</td></tr>
    <tr><td>${t('asRejected')}</td><td class="num">${s.rejected}${s.rejectedPct == null ? '' : ` (${s.rejectedPct}%)`}</td></tr></table>
    ${s.caution ? `<div class="sub"><b>${esc(s.caution)}</b></div>` : ''}<div class="sub">MOCK</div></div>`;
  });

  App.on('as-submit', () => run(async () => { const r = await api('POST', '/api/assist/items', { text: val('as-text') }); toast(`#${r.id}`, true); }));
  App.on('as-accept', (b) => {
    const id = b.dataset.id, num = (k) => App.toPiastres(val(`as-${k}-${id}`));
    return run(() => api('POST', `/api/assist/items/${id}/accept`, { edits: { supplier: val(`as-supplier-${id}`), date: val(`as-date-${id}`), total: num('total'), vat: num('vat') || 0, category: val(`as-category-${id}`) } }), t('saved'));
  });
  App.on('as-reject', (b) => { const reason = window.prompt(t('asWhy')); if (reason) run(() => api('POST', `/api/assist/items/${b.dataset.id}/reject`, { reason }), t('saved')); });
  App.on('as-undo', (b) => { const reason = window.prompt(t('asWhy')); if (reason) run(() => api('POST', `/api/assist/items/${b.dataset.id}/undo`, { reason }), t('saved')); });
}
