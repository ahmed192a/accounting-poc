// Offline-first client: queue writes made without a connection, show them, replay them in order when back online.
// Logic lives in /offline-queue.js (pure, unit-tested); this file is the browser wiring and the UI.
// What works offline (honest list, also shown on the Offline page):
//   - the app shell and every card, from the service worker cache
//   - reading items, customers, recent sales and the home figures AS LAST SEEN (stale-while-revalidate; may be out of date)
//   - saving a quick sale, an invoice, a bill or a new customer: kept in IndexedDB on THIS device, sent in order on reconnect
// What does NOT work offline: everything else (voids, credit notes, approvals, payments, reports with fresh data, sign-in, admin).
import { createQueue, idbStorage, memoryStorage, queueKind, newKey, backoffMs } from '/offline-queue.js';

export default function register(App) {
  const { t, esc, state } = App;
  const P = { page: 'offline', pageTitleKey: 'offlinePage' };

  App.i18n.add('en', {
    offlinePage: 'Offline', offlineWhatTitle: 'Working offline', offlineStatus: 'Connection', offlineOnline: 'Online', offlineOffline: 'Offline',
    offlineWorks: 'Works offline', offlineWorksList: 'The app itself; items, customers, recent sales and home figures as last seen (they may be out of date); saving a quick sale, an invoice, a bill or a new customer.',
    offlineNot: 'Needs a connection', offlineNotList: 'Everything else: voids, credit notes, approvals, payments, fresh reports, e-receipt submission, sign-in and administration.',
    offlinePending: 'Waiting to send', offlineEmpty: 'Nothing is waiting. Changes made without a connection appear here until they are sent.',
    offlineSyncNow: 'Send now', offlineSyncing: 'Sending...', offlineRetry: 'Try again', offlineEdit: 'Edit', offlineDiscard: 'Discard',
    offlineStPending: 'Pending', offlineStFailed: 'Not accepted', offlineSaved: 'Saved on this device. It will be sent when you are back online.',
    offlineSent: 'Sync finished', offlineSentN: 'sent', offlineFailedN: 'not accepted', offlineStill: 'still waiting',
    offlineReason: 'Server reason', offlineAttempts: 'Attempts', offlineCreated: 'Saved at', offlineNoStore: 'This browser cannot store offline changes; saving needs a connection.',
    offlineEditTitle: 'Edit the request', offlineEditHint: 'JSON body as it will be sent. Fix what the server complained about.', offlineBadJson: 'Not valid JSON.', offlineSave: 'Save',
    offlineDiscardQ: 'Discard this change? It was never sent and will be lost.', offlineDiscarded: 'Discarded.',
    offlineChipPending: 'pending', offlineChipFailed: 'not accepted', offlineNewer: 'Newer data available. Refresh', offlineEstimate: 'estimated total',
    offlineKindSale: 'Quick sale', offlineKindInvoice: 'Invoice', offlineKindBill: 'Bill', offlineKindCustomer: 'New customer',
    offlineAuth: 'Sign in again to send waiting changes.', offlineRetrying: 'Server busy or unreachable; will retry automatically.',
  });
  App.i18n.add('ar', {
    offlinePage: 'دون اتصال', offlineWhatTitle: 'العمل دون اتصال', offlineStatus: 'الاتصال', offlineOnline: 'متصل', offlineOffline: 'غير متصل',
    offlineWorks: 'يعمل دون اتصال', offlineWorksList: 'التطبيق نفسه؛ الأصناف والعملاء وآخر المبيعات وأرقام الصفحة الرئيسية كما شوهدت آخر مرة (قد تكون قديمة)؛ حفظ بيع سريع أو فاتورة أو فاتورة مورد أو عميل جديد.',
    offlineNot: 'يحتاج إلى اتصال', offlineNotList: 'كل ما عدا ذلك: الإلغاء وإشعارات الدائن والموافقات والمدفوعات والتقارير الحديثة وإرسال الإيصالات الإلكترونية وتسجيل الدخول والإدارة.',
    offlinePending: 'في انتظار الإرسال', offlineEmpty: 'لا شيء في الانتظار. تظهر هنا التغييرات التي تتم دون اتصال إلى حين إرسالها.',
    offlineSyncNow: 'إرسال الآن', offlineSyncing: 'جار الإرسال...', offlineRetry: 'حاول مرة أخرى', offlineEdit: 'تعديل', offlineDiscard: 'حذف',
    offlineStPending: 'قيد الانتظار', offlineStFailed: 'لم يُقبل', offlineSaved: 'تم الحفظ على هذا الجهاز. سيُرسل عند عودة الاتصال.',
    offlineSent: 'اكتملت المزامنة', offlineSentN: 'أُرسل', offlineFailedN: 'لم يُقبل', offlineStill: 'ما زال في الانتظار',
    offlineReason: 'سبب الخادم', offlineAttempts: 'المحاولات', offlineCreated: 'وقت الحفظ', offlineNoStore: 'لا يستطيع هذا المتصفح تخزين التغييرات دون اتصال؛ الحفظ يحتاج إلى اتصال.',
    offlineEditTitle: 'تعديل الطلب', offlineEditHint: 'محتوى JSON كما سيُرسل. صحّح ما اعترض عليه الخادم.', offlineBadJson: 'JSON غير صالح.', offlineSave: 'حفظ',
    offlineDiscardQ: 'حذف هذا التغيير؟ لم يُرسل أبدا وسيضيع.', offlineDiscarded: 'تم الحذف.',
    offlineChipPending: 'قيد الانتظار', offlineChipFailed: 'لم يُقبل', offlineNewer: 'توجد بيانات أحدث. حدّث', offlineEstimate: 'الإجمالي التقديري',
    offlineKindSale: 'بيع سريع', offlineKindInvoice: 'فاتورة', offlineKindBill: 'فاتورة مورد', offlineKindCustomer: 'عميل جديد',
    offlineAuth: 'سجّل الدخول مرة أخرى لإرسال التغييرات المنتظرة.', offlineRetrying: 'الخادم مشغول أو غير متاح؛ ستُعاد المحاولة تلقائيا.',
  });

  // ---- storage and queue ----
  let storageOk = true;
  let storage;
  try { storage = typeof indexedDB !== 'undefined' ? idbStorage(indexedDB) : null; } catch { storage = null; }
  if (!storage) { storage = memoryStorage(); storageOk = false; }
  const identity = () => (state.users.length ? `demo:${state.userId}` : 'session');
  const authHeaders = () => ({ ...(state.users.length ? { 'x-user-id': String(state.userId) } : {}), ...(App.csrfToken ? { 'x-csrf-token': App.csrfToken } : {}) });
  const queue = createQueue({ storage, fetch: (...a) => fetch(...a), getHeaders: authHeaders, getIdentity: identity, onChange: () => { refresh(); } });

  let view = { items: [], counts: { pending: 0, failed: 0, total: 0 } };
  let syncing = false, lastNote = null, newer = false, timer = null, attemptsInRun = 0;
  const online = () => navigator.onLine !== false;

  async function refresh() {
    try { view = { items: await queue.list(), counts: await queue.counts() }; } catch { /* storage unavailable */ }
    App.render();
  }

  // ---- hooks used by app.js api() ----
  App.offlineKey = (method, path) => (storageOk && queueKind(method, path) ? newKey() : null);

  const KIND = { sale: 'offlineKindSale', invoice: 'offlineKindInvoice', bill: 'offlineKindBill', customer: 'offlineKindCustomer' };
  function describe(kind, body) {
    try {
      if (kind === 'sale') return (body.items ?? []).map((i) => `${i.sku} x${i.qty}`).join(', ');
      if (kind === 'invoice') return [body.customer, ...(body.lines ?? []).map((l) => `${l.description ?? ''} x${l.qty ?? ''}`)].filter(Boolean).join(': ');
      if (kind === 'bill') return [body.supplier ?? body.supplierId, body.reference ?? body.number].filter(Boolean).join(' ');
      if (kind === 'customer') return body.name ?? '';
    } catch { /* fall through */ }
    return '';
  }
  /** Rough total for the receipt line in the UI; clearly labelled as an estimate. */
  function estimateSale(body) {
    const catalogue = state.home?.widgets?.salesDesk?.items ?? [];
    const sum = (body.items ?? []).reduce((s, i) => s + (catalogue.find((c) => c.sku === i.sku)?.price ?? 0) * Number(i.qty || 0), 0);
    const d = body.discount;
    const off = !d ? 0 : d.type === 'percent' ? Math.round((sum * d.value) / 100) : Math.min(sum, Number(d.value) || 0);
    return Math.round((sum - off) * (1 + (state.home?.vatRateBp ?? 0) / 10000));
  }

  App.offlineWrite = async (method, path, body, key) => {
    const kind = queueKind(method, path);
    if (!kind || !storageOk) return null;
    let item;
    try { item = await queue.enqueue({ method, path, body, key, label: `${t(KIND[kind])}: ${describe(kind, body ?? {})}` }); }
    catch (e) { App.toast(e.message); return null; }
    App.toast(t('offlineSaved'), true);
    schedule();
    // Shape the callers already read (sales.js reads r.sale.total and r.receipt.status); `queued: true` marks it as not yet on the server.
    return { queued: true, offlineId: item.id, id: null, estimated: true, note: t('offlineSaved'),
      ...(kind === 'sale' ? { sale: { id: null, total: estimateSale(body ?? {}) }, receipt: { status: 'queued' } } : {}) };
  };

  // ---- sync ----
  async function runSync() {
    if (syncing || !online()) return;
    syncing = true; App.render();
    let summary;
    const work = () => queue.sync();
    try { summary = navigator.locks ? await navigator.locks.request('acct-offline-sync', { ifAvailable: true }, (lock) => (lock ? work() : null)) : await work(); }
    catch { summary = null; }
    syncing = false;
    if (summary) {
      const bits = [];
      if (summary.synced.length) bits.push(`${summary.synced.length} ${t('offlineSentN')}`);
      if (summary.failed.length) bits.push(`${summary.failed.length} ${t('offlineFailedN')}`);
      if (summary.remaining) bits.push(`${summary.remaining} ${t('offlineStill')}`);
      lastNote = summary.stopped === 'auth' ? t('offlineAuth') : summary.stopped ? t('offlineRetrying') : null;
      if (bits.length) App.toast(`${t('offlineSent')}: ${bits.join(', ')}`, !summary.failed.length && !summary.remaining);
      attemptsInRun = summary.stopped ? attemptsInRun + 1 : 0;
      if (summary.synced.length) { try { await App.reload(); } catch { /* shown by the shell */ } }
      schedule(summary.retryAfterMs);
    }
    await refresh();
  }
  function schedule(retryAfterMs) {
    clearTimeout(timer);
    queue.counts().then((c) => {
      if (!c.pending) return;
      timer = setTimeout(runSync, retryAfterMs ?? (online() ? backoffMs(attemptsInRun) : 5000));
    }).catch(() => {});
  }
  window.addEventListener('online', () => { attemptsInRun = 0; runSync(); });
  window.addEventListener('offline', () => App.render());
  App.onUserChange(() => { refresh(); schedule(); warm(); });
  App.onLoad(async () => { await refresh(); if (online() && view.counts.pending && !syncing) schedule(0); });

  // ---- service worker messages and cache warm-up ----
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'acct-api-updated' && e.data.path === '/api/home') { newer = true; App.render(); } });
    navigator.serviceWorker.ready.then(() => warm()).catch(() => {});
  }
  /** The first page load happens before the worker controls the page, so fetch the read endpoints once more through it. */
  function warm() {
    if (!navigator.serviceWorker?.controller || !online() || !state.home) return;
    const h = authHeaders();
    for (const p of ['/api/home']) fetch(p, { headers: h, credentials: 'same-origin' }).catch(() => {});
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('controllerchange', () => setTimeout(warm, 500));

  // ---- UI ----
  const when = (ms) => { try { return new Date(ms).toLocaleString(App.loc()); } catch { return String(ms); } };
  const row = (i) => `<tr data-offline-id="${i.id}"><td>${esc(i.label)}<div class="sub">${esc(t('offlineCreated'))} ${esc(when(i.createdAt))}${i.attempts ? ` · ${esc(t('offlineAttempts'))}: ${i.attempts}` : ''}</div>
    ${i.status === 'failed' && i.error ? `<div class="note bad" role="alert">${esc(t('offlineReason'))}: ${esc(i.error.message)} <span class="sub">(${esc(i.error.code)})</span></div>` : ''}</td>
    <td><span class="chip ${i.status === 'failed' ? 'bad' : 'warn'}">${t(i.status === 'failed' ? 'offlineStFailed' : 'offlineStPending')}</span></td>
    <td class="num">${i.status === 'failed' ? `<button class="small" data-act="offline-retry" data-id="${i.id}">${t('offlineRetry')}</button> ` : ''}<button class="small" data-act="offline-edit" data-id="${i.id}">${t('offlineEdit')}</button> <button class="small" data-act="offline-discard" data-id="${i.id}">${t('offlineDiscard')}</button></td></tr>`;

  App.addCard({ id: 'offline.status', area: 'main', order: 5, wide: true, ...P, render: () => `<div class="card" id="offline-card"><h2>${t('offlineWhatTitle')}</h2>
    <div class="row"><span>${t('offlineStatus')}: <span class="chip ${online() ? 'good' : 'warn'}" id="offline-conn">${online() ? t('offlineOnline') : t('offlineOffline')}</span></span>
    <button data-act="offline-sync" ${!view.counts.pending || syncing || !online() ? 'disabled' : ''}>${syncing ? t('offlineSyncing') : t('offlineSyncNow')}</button></div>
    <p><b>${t('offlineWorks')}:</b> ${t('offlineWorksList')}</p><p><b>${t('offlineNot')}:</b> ${t('offlineNotList')}</p>
    ${storageOk ? '' : `<div class="note warn">${t('offlineNoStore')}</div>`}
    ${lastNote ? `<div class="note warn" role="status">${esc(lastNote)}</div>` : ''}
    <h3>${t('offlinePending')} (${view.counts.total})</h3>
    ${view.items.length ? `<table id="offline-list">${view.items.map(row).join('')}</table>` : `<p class="sub">${t('offlineEmpty')}</p>`}</div>` });

  App.addHeader({ id: 'offline.chip', order: 50, render: () => {
    const c = view.counts;
    const parts = [];
    if (c.pending) parts.push(`<a class="chip warn" id="offline-chip" href="#/offline">${c.pending} ${t('offlineChipPending')}</a>`);
    if (c.failed) parts.push(`<a class="chip bad" id="offline-chip-failed" href="#/offline">${c.failed} ${t('offlineChipFailed')}</a>`);
    if (newer) parts.push(`<button class="small" data-act="offline-refresh">${t('offlineNewer')}</button>`);
    return parts.join(' ');
  } });

  App.on('offline-sync', () => { attemptsInRun = 0; runSync(); });
  App.on('offline-refresh', async () => { newer = false; try { await App.reload(); } catch { /* shown by the shell */ } });
  App.on('offline-retry', async (b) => { try { await queue.retry(Number(b.dataset.id)); runSync(); } catch (e) { App.toast(e.message); } });
  App.on('offline-discard', async (b) => {
    if (!(await App.confirm({ title: t('offlineDiscard'), message: t('offlineDiscardQ'), danger: true }))) return;
    try { await queue.discard(Number(b.dataset.id)); App.toast(t('offlineDiscarded'), true); } catch (e) { App.toast(e.message); }
  });
  App.on('offline-edit', async (b) => {
    const it = view.items.find((i) => i.id === Number(b.dataset.id));
    if (!it) return;
    const ctl = App.modal({
      title: t('offlineEditTitle'),
      bodyHtml: `<p class="sub">${esc(t('offlineEditHint'))}</p><textarea id="offline-json" rows="10" style="width:100%;font-family:monospace" data-autofocus>${esc(JSON.stringify(it.body, null, 2))}</textarea><div id="offline-json-err" class="note bad" role="alert" hidden>${esc(t('offlineBadJson'))}</div>`,
      dismissValue: null,
      actions: [{ label: t('sh.cancel') === 'sh.cancel' ? 'Cancel' : t('sh.cancel'), value: null }, { label: t('offlineSave'), value: 'save', primary: true }],
      beforeClose(v, el) {
        if (v !== 'save') return true;
        try { JSON.parse(el.querySelector('#offline-json').value); return true; } catch { el.querySelector('#offline-json-err').hidden = false; return false; }
      },
    });
    const v = await ctl.promise;
    if (v !== 'save') return;
    try { await queue.edit(it.id, JSON.parse(ctl.el.querySelector('#offline-json')?.value ?? '{}')); runSync(); } catch (e) { App.toast(e.message); }
  });

  refresh();
}
