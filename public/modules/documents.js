// Documents UI: attachment screen for bills and purchase orders, and receipt capture on bill entry.
// Backend: src/modules/documents. Camera: <input capture> first, getUserMedia overlay as the fallback (desktop browsers).
// Photos are shrunk in the browser to fit the server's size limit. The "has valid e-document" rule is UNVERIFIED.
export default function register(App) {
  const { t, esc, has, api, run, toast } = App;

  App.i18n.add('en', {
    docTitle: 'Documents', docEntity: 'Attach to', docBill: 'Bill', docPo: 'Purchase order', docPick: 'Choose one', docNone: 'No documents yet.',
    docUpload: 'Upload a file', docKind: 'Type', docKindAttachment: 'Attachment', docKindSource: 'Source file (e-invoice JSON or XML)',
    docCamera: 'Take a photo', docLive: 'Use the camera on this device', docSnap: 'Snap', docCancel: 'Cancel', docDownload: 'Download', docRemove: 'Remove',
    docRemoveWhy: 'Reason for removing this document?', docLimits: 'Up to {n} files per record, {kb} KB each. PDF, PNG, JPEG, WebP, text, CSV, JSON, XML.',
    docEdoc: 'Has valid e-document', docEdocYes: 'Yes', docEdocNo: 'No', docEdocUnknown: 'Unknown', docEdocNote: 'Note (optional)', docEdocSave: 'Save',
    docUnverified: 'UNVERIFIED rule: whether a valid e-invoice or e-receipt is needed for tax is not confirmed with the ETA. This is a manual note, not a check.',
    docCaptureTitle: 'Receipt photo for the next bill', docCaptureHint: 'Optional. The photo is attached when you press Create.',
    docCaptured: 'Photo ready', docCaptureClear: 'Discard photo', docAttached: 'Receipt attached', docAttachFailed: 'The bill was saved but the receipt was not attached',
    docOfflinePhoto: 'Photo kept. Attach it from the Documents card once the bill is saved.', docTooBig: 'The file is too large even after shrinking.', docNoCamera: 'No camera is available here; choose a file instead.',
    docSaved: 'Saved', docBy: 'by user',
  });
  App.i18n.add('ar', {
    docTitle: 'المستندات', docEntity: 'إرفاق بـ', docBill: 'فاتورة مورد', docPo: 'أمر شراء', docPick: 'اختر', docNone: 'لا توجد مستندات بعد.',
    docUpload: 'رفع ملف', docKind: 'النوع', docKindAttachment: 'مرفق', docKindSource: 'ملف مصدر (فاتورة إلكترونية JSON أو XML)',
    docCamera: 'التقاط صورة', docLive: 'استخدام كاميرا هذا الجهاز', docSnap: 'التقاط', docCancel: 'إلغاء', docDownload: 'تنزيل', docRemove: 'إزالة',
    docRemoveWhy: 'سبب إزالة هذا المستند؟', docLimits: 'حتى {n} ملفات لكل سجل، {kb} كيلوبايت للملف. PDF وPNG وJPEG وWebP ونص وCSV وJSON وXML.',
    docEdoc: 'لديه مستند إلكتروني صالح', docEdocYes: 'نعم', docEdocNo: 'لا', docEdocUnknown: 'غير معروف', docEdocNote: 'ملاحظة (اختياري)', docEdocSave: 'حفظ',
    docUnverified: 'قاعدة غير مؤكدة: لم يتم التأكد من مصلحة الضرائب هل يلزم فاتورة أو إيصال إلكتروني صالح. هذه ملاحظة يدوية وليست فحصا.',
    docCaptureTitle: 'صورة الإيصال للفاتورة القادمة', docCaptureHint: 'اختياري. تُرفق الصورة عند الضغط على إنشاء.',
    docCaptured: 'الصورة جاهزة', docCaptureClear: 'تجاهل الصورة', docAttached: 'تم إرفاق الإيصال', docAttachFailed: 'تم حفظ الفاتورة لكن لم يتم إرفاق الإيصال',
    docOfflinePhoto: 'تم الاحتفاظ بالصورة. أرفقها من بطاقة المستندات بعد حفظ الفاتورة.', docTooBig: 'الملف كبير جدا حتى بعد التصغير.', docNoCamera: 'لا توجد كاميرا هنا؛ اختر ملفا.',
    docSaved: 'تم الحفظ', docBy: 'بواسطة مستخدم',
  });

  const P = { page: 'purchases', pageTitleKey: 'purchasesPage' };
  let limits = { maxBytes: 512 * 1024, maxPerEntity: 10 };
  let lists = { bill: [], purchase_order: [] };
  let sel = { type: 'bill', id: null };
  let docs = [];
  let edoc = null;
  let pending = null;       // { blob, name, mime, url } photo waiting for the next bill
  let pendingEdoc = 'unknown';

  // ---- helpers -----------------------------------------------------------------------------------------
  const readB64 = (blob) => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1] ?? '');
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
  const toBlob = (canvas, q) => new Promise((res) => canvas.toBlob(res, 'image/jpeg', q));

  /** Shrink an image to fit maxBytes (JPEG, longest side 1600 px, quality steps down). Other files pass through. */
  async function fit(file) {
    if (file.size <= limits.maxBytes && !/^image\/(png|webp)$/.test(file.type) && !(file.type === 'image/jpeg' && file.size > 300 * 1024)) return file;
    if (!file.type.startsWith('image/') || typeof createImageBitmap !== 'function') return file;
    const bmp = await createImageBitmap(file);
    let side = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    for (let round = 0; round < 4; round++) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * side)); c.height = Math.max(1, Math.round(bmp.height * side));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      for (const q of [0.85, 0.7, 0.55]) {
        const b = await toBlob(c, q);
        if (b && b.size <= limits.maxBytes) return new File([b], (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
      }
      side *= 0.7;
    }
    throw new Error(t('docTooBig'));
  }

  const ENTITY_LABEL = { bill: (b) => `#${b.id} ${b.supplier ?? ''}`, purchase_order: (o) => `${o.number ?? '#' + o.id} ${o.supplier ?? ''}` };
  const typeLabel = (k) => (k === 'bill' ? t('docBill') : t('docPo'));

  async function refreshLists() {
    if (!has('purchases.view')) return;
    const [b, o] = await Promise.all([api('GET', '/api/bills').catch(() => []), api('GET', '/api/purchase-orders').catch(() => [])]);
    lists = { bill: b.slice(0, 60), purchase_order: o.slice(0, 60) };
  }
  async function refreshDocs() {
    docs = []; edoc = null;
    if (!sel.id || !has('documents.view')) return;
    docs = await api('GET', `/api/documents?entityType=${sel.type}&entityId=${sel.id}`).catch(() => []);
    if (sel.type === 'bill') edoc = await api('GET', `/api/documents/edoc?entityType=bill&entityId=${sel.id}`).catch(() => null);
  }

  /** Upload one file (blob) to an entity. */
  async function upload(file, entityType, entityId, kind = 'attachment') {
    const f = await fit(file);
    return api('POST', '/api/documents', { entityType, entityId, kind, filename: f.name || 'photo.jpg', mime: f.type || 'application/octet-stream', contentBase64: await readB64(f) });
  }

  // ---- camera: <input capture> is the normal path, getUserMedia the fallback --------------------------
  let overlay = null, stream = null;
  function closeLive() {
    stream?.getTracks().forEach((tr) => tr.stop()); stream = null;
    overlay?.remove(); overlay = null;
  }
  async function openLive(onPhoto) {
    if (!navigator.mediaDevices?.getUserMedia) { toast(t('docNoCamera')); return; }
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }); } catch { toast(t('docNoCamera')); return; }
    overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;z-index:1000';
    overlay.innerHTML = `<video autoplay playsinline muted style="max-inline-size:92vw;max-block-size:70vh"></video>
      <div class="row"><button class="primary" id="doc-snap">${esc(t('docSnap'))}</button><button id="doc-live-cancel">${esc(t('docCancel'))}</button></div>`;
    document.body.appendChild(overlay);
    const video = overlay.querySelector('video');
    video.srcObject = stream;
    overlay.querySelector('#doc-live-cancel').onclick = closeLive;
    overlay.querySelector('#doc-snap').onclick = async () => {
      const c = document.createElement('canvas');
      c.width = video.videoWidth || 1280; c.height = video.videoHeight || 720;
      c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
      const blob = await toBlob(c, 0.9);
      closeLive();
      if (blob) onPhoto(new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' }));
    };
  }

  // The page CSP allows img-src 'self' data: only, so the preview is a data URL, not a blob URL.
  async function setPending(file) {
    pending = file ? { file, url: `data:${file.type};base64,${await readB64(file)}` } : null;
    App.render();
  }

  // ---- cards: attachment screen (bills and purchase orders) -------------------------------------------
  const kb = () => Math.round(limits.maxBytes / 1024);
  const edocChip = (s) => `<span class="chip ${s === 'yes' ? 'good' : s === 'no' ? 'bad' : 'mute'}">${t('docEdoc' + s[0].toUpperCase() + s.slice(1))}</span>`;
  const edocOptions = (cur) => ['yes', 'no', 'unknown'].map((v) => `<option value="${v}"${cur === v ? ' selected' : ''}>${t('docEdoc' + v[0].toUpperCase() + v.slice(1))}</option>`).join('');

  App.addCard({
    id: 'documents.panel', area: 'main', order: 69, ...P, permission: 'documents.view',
    render: () => {
      const items = lists[sel.type] ?? [];
      const canUp = has('documents.upload');
      return `<div class="card"><h2>${t('docTitle')}</h2>
      <div class="row"><select id="doc-type" data-act="doc-type" aria-label="${t('docEntity')}">${['bill', 'purchase_order'].map((k) => `<option value="${k}"${sel.type === k ? ' selected' : ''}>${typeLabel(k)}</option>`).join('')}</select>
      <select id="doc-id" data-act="doc-id" aria-label="${t('docPick')}"><option value="">${t('docPick')}</option>${items.map((e) => `<option value="${e.id}"${sel.id === e.id ? ' selected' : ''}>${esc(ENTITY_LABEL[sel.type](e))}</option>`).join('')}</select></div>
      ${sel.id ? (docs.length ? `<table>${docs.map((d) => `<tr><td>${esc(d.filename)}<div class="sub">${esc(d.mime)} · ${Math.max(1, Math.round(d.size / 1024))} KB${d.kind === 'source' ? ' · ' + t('docKindSource').split(' (')[0] : ''}</div></td>
        <td class="num"><button class="small" data-act="doc-open" data-id="${d.id}">${t('docDownload')}</button>
        ${has('documents.manage') ? `<button class="small" data-act="doc-remove" data-id="${d.id}">${t('docRemove')}</button>` : ''}</td></tr>`).join('')}</table>` : `<div class="empty">${t('docNone')}</div>`) : ''}
      ${sel.id && canUp ? `<div class="row"><input type="file" id="doc-file" data-act="doc-file" accept="image/*,.pdf,.txt,.csv,.json,.xml">
        <select id="doc-kind"><option value="attachment">${t('docKindAttachment')}</option><option value="source">${t('docKindSource')}</option></select>
        <input type="file" id="doc-cam" data-act="doc-cam" accept="image/*" capture="environment" hidden><button class="small primary" data-act="doc-cam-open">${t('docCamera')}</button>
        ${navigator.mediaDevices?.getUserMedia ? `<button class="small" data-act="doc-live-attach">${t('docLive')}</button>` : ''}</div>` : ''}
      ${sel.id && sel.type === 'bill' && edoc ? `<div class="row"><b>${t('docEdoc')}</b> ${edocChip(edoc.status)}
        ${canUp ? `<select id="doc-edoc">${edocOptions(edoc.status)}</select><input type="text" id="doc-edoc-note" maxlength="300" placeholder="${t('docEdocNote')}" value="${esc(edoc.note ?? '')}"><button class="small" data-act="doc-edoc-save">${t('docEdocSave')}</button>` : ''}</div>
        <div class="note">${t('docUnverified')}</div>` : ''}
      <div class="sub">${t('docLimits').replace('{n}', limits.maxPerEntity).replace('{kb}', kb())}</div></div>`;
    },
  });

  // ---- card: receipt capture on bill entry (sits right under the New bill card) ------------------------
  App.addCard({
    id: 'documents.capture', area: 'main', order: 61, ...P,
    permission: (home) => home.permissions.includes('documents.upload') && home.permissions.includes('purchases.create'),
    render: () => `<div class="card"><h2>${t('docCaptureTitle')}</h2><div class="sub">${t('docCaptureHint')}</div>
      ${pending ? `<div class="row"><img src="${pending.url}" alt="${t('docCaptured')}" style="max-inline-size:140px;max-block-size:140px;border-radius:6px"><div><span class="chip good">${t('docCaptured')}</span><div class="sub">${Math.round(pending.file.size / 1024)} KB</div>
        <button class="small" data-act="doc-pending-clear">${t('docCaptureClear')}</button></div></div>` : ''}
      <div class="row"><input type="file" id="doc-pending-cam" data-act="doc-pending" accept="image/*" capture="environment" hidden><button class="small primary" data-act="doc-pending-open">${t('docCamera')}</button>
      ${navigator.mediaDevices?.getUserMedia ? `<button class="small" data-act="doc-live-pending">${t('docLive')}</button>` : ''}</div>
      <div class="row"><b>${t('docEdoc')}</b><select id="doc-pending-edoc" data-act="doc-pending-edoc">${edocOptions(pendingEdoc)}</select></div>
      <div class="note">${t('docUnverified')}</div></div>`,
  });

  // ---- actions -----------------------------------------------------------------------------------------
  const el = (id) => document.getElementById(id);
  const reloadDocs = async () => { await refreshDocs(); App.render(); };
  const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

  App.onChange('doc-type', guard(async (s) => { sel = { type: s.value, id: null }; docs = []; edoc = null; App.render(); }));
  App.onChange('doc-id', guard(async (s) => { sel.id = Number(s.value) || null; await reloadDocs(); }));
  App.onChange('doc-file', guard(async (inp) => {
    const f = inp.files?.[0]; if (!f) return;
    await upload(f, sel.type, sel.id, el('doc-kind')?.value ?? 'attachment');
    toast(t('docSaved'), true); await reloadDocs();
  }));
  App.on('doc-cam-open', () => el('doc-cam')?.click());
  App.onChange('doc-cam', guard(async (inp) => {
    const f = inp.files?.[0]; if (!f) return;
    await upload(f, sel.type, sel.id); toast(t('docSaved'), true); await reloadDocs();
  }));
  App.on('doc-live-attach', () => openLive(guard(async (f) => { await upload(f, sel.type, sel.id); toast(t('docSaved'), true); await reloadDocs(); })));
  App.on('doc-open', guard(async (b) => {
    const d = await api('GET', `/api/documents/${b.dataset.id}/content`);
    const bin = atob(d.contentBase64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // A download link: a blob tab would inherit the page CSP and may not render PDFs.
    const url = URL.createObjectURL(new Blob([bytes], { type: d.mime }));
    const a = document.createElement('a');
    a.href = url; a.download = d.filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }));
  App.on('doc-remove', (b) => {
    const reason = window.prompt(t('docRemoveWhy'));
    if (reason) run(async () => { await api('POST', `/api/documents/${b.dataset.id}/remove`, { reason }); await refreshDocs(); }, t('saved'));
  });
  App.on('doc-edoc-save', guard(async () => {
    await api('POST', '/api/documents/edoc', { entityType: 'bill', entityId: sel.id, status: el('doc-edoc').value, note: el('doc-edoc-note').value });
    toast(t('docSaved'), true); await reloadDocs();
  }));

  App.on('doc-pending-open', () => el('doc-pending-cam')?.click());
  App.onChange('doc-pending', guard(async (inp) => { const f = inp.files?.[0]; if (f) setPending(await fit(f)); }));
  App.on('doc-live-pending', () => openLive(guard(async (f) => setPending(await fit(f)))));
  App.on('doc-pending-clear', () => setPending(null));
  App.onChange('doc-pending-edoc', (s) => { pendingEdoc = s.value; });

  // purchases.js announces a saved bill: attach the waiting photo and e-document flag before the screen reloads.
  document.addEventListener('purchases:bill-created', (e) => {
    const { bill, waitFor } = e.detail ?? {};
    if (!bill?.id || !waitFor) { if (pending) toast(t('docOfflinePhoto')); return; }
    const job = (async () => {
      try {
        if (pending) { await upload(pending.file, 'bill', bill.id); toast(t('docAttached'), true); setPending(null); }
        if (pendingEdoc !== 'unknown' && has('documents.upload')) await api('POST', '/api/documents/edoc', { entityType: 'bill', entityId: bill.id, status: pendingEdoc });
        pendingEdoc = 'unknown';
      } catch (err) { toast(`${t('docAttachFailed')}: ${err.message}`); }
    })();
    waitFor.push(job);
  });

  App.onLoad(async () => {
    if (!has('documents.view')) return;
    try { limits = await api('GET', '/api/documents/limits'); } catch { /* keep defaults */ }
    await refreshLists();
    await refreshDocs();
  });
  App.onUserChange(() => { sel = { type: 'bill', id: null }; docs = []; edoc = null; pending = null; pendingEdoc = 'unknown'; });
}
