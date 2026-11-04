// Inventory: stock list with low-stock chips, receive, adjust/transfer, stocktake, setup, valuation.
// All user text is escaped; write controls only show when the user holds the write permission.
export default function register(App) {
  const { t, esc, money, has, api, run, toast, state } = App;

  App.i18n.add('en', {
    invPage: 'Inventory', invStock: 'Stock on hand', invLow: 'Low stock', invReceive: 'Receive stock', invAdjust: 'Adjust or transfer stock',
    invCount: 'Stocktake', invSetup: 'Stock setup', invValuation: 'Stock valuation',
    invItem: 'Item', invQty: 'Qty', invAvg: 'Avg cost', invValue: 'Value', invWarehouse: 'Warehouse', invAllWh: 'All warehouses',
    invBarcode: 'Barcode', invFind: 'Find', invFound: 'Found', invNoStock: 'No stock items yet. Receive stock to start tracking an item.',
    invChipLow: 'Low', invChipOut: 'Out of stock', invChipNeg: 'Negative stock', invReorderAt: 'reorder at',
    invAllGood: 'No item is below its reorder level.', invNegWarn: 'items have negative stock', invCostWarn: 'movements have an unknown cost',
    invSupplier: 'Supplier', invUnitCost: 'Unit cost (EGP)', invDoReceive: 'Receive', invReceived: 'Stock received.',
    invChange: 'Change (+ in, - out)', invReason: 'Reason (required)', invDoAdjust: 'Adjust', invAdjusted: 'Stock adjusted.',
    invTransfer: 'Transfer', invFrom: 'From', invTo: 'To', invDoTransfer: 'Transfer', invTransferred: 'Stock transferred.',
    invStartCount: 'Start count sheet', invOpenCount: 'Open', invSheet: 'Count sheet', invExpected: 'Expected', invCounted: 'Counted', invVariance: 'Diff',
    invPostCount: 'Post variances', invCancelCount: 'Cancel sheet', invCountPosted: 'Stocktake posted.', invCountStarted: 'Count sheet started.', invClose: 'Close',
    invStatus_open: 'open', invStatus_posted: 'posted', invStatus_cancelled: 'cancelled',
    invTrack: 'Track stock', invUnit: 'Unit', invReorderLevel: 'Reorder level', invReorderQty: 'Reorder qty', invSave: 'Save', invSaved: 'Saved.',
    invAllowNeg: 'Allow selling below zero stock', invNewWh: 'New warehouse (code and name)', invAddWh: 'Add warehouse',
    invTotal: 'Total value', invGl: 'Account 1300 balance', invDiff: 'Difference', invMatches: 'Matches the books', invMismatch: 'Does not match the books',
    invOtherPosted: 'posted to 1300 outside inventory', invUnknown: 'unknown', invPickItem: 'Choose an item', invChg: '+ / -', invLvl: 'Level', invRq: 'Qty',
  });
  App.i18n.add('ar', {
    invPage: 'المخزون', invStock: 'الرصيد المتاح', invLow: 'مخزون منخفض', invReceive: 'استلام بضاعة', invAdjust: 'تسوية أو تحويل مخزون',
    invCount: 'الجرد', invSetup: 'إعداد المخزون', invValuation: 'تقييم المخزون',
    invItem: 'الصنف', invQty: 'الكمية', invAvg: 'متوسط التكلفة', invValue: 'القيمة', invWarehouse: 'المخزن', invAllWh: 'كل المخازن',
    invBarcode: 'الباركود', invFind: 'بحث', invFound: 'تم العثور', invNoStock: 'لا توجد أصناف مخزنية بعد. استلم بضاعة لبدء تتبع صنف.',
    invChipLow: 'منخفض', invChipOut: 'نفد', invChipNeg: 'رصيد سالب', invReorderAt: 'إعادة الطلب عند',
    invAllGood: 'لا يوجد صنف تحت حد إعادة الطلب.', invNegWarn: 'أصناف برصيد سالب', invCostWarn: 'حركات بتكلفة غير معروفة',
    invSupplier: 'المورد', invUnitCost: 'تكلفة الوحدة (ج.م)', invDoReceive: 'استلام', invReceived: 'تم استلام البضاعة.',
    invChange: 'التغيير (+ إضافة، - خصم)', invReason: 'السبب (مطلوب)', invDoAdjust: 'تسوية', invAdjusted: 'تمت تسوية المخزون.',
    invTransfer: 'تحويل', invFrom: 'من', invTo: 'إلى', invDoTransfer: 'تحويل', invTransferred: 'تم تحويل المخزون.',
    invStartCount: 'بدء ورقة جرد', invOpenCount: 'فتح', invSheet: 'ورقة الجرد', invExpected: 'المتوقع', invCounted: 'المعدود', invVariance: 'الفرق',
    invPostCount: 'ترحيل الفروقات', invCancelCount: 'إلغاء الورقة', invCountPosted: 'تم ترحيل الجرد.', invCountStarted: 'بدأت ورقة الجرد.', invClose: 'إغلاق',
    invStatus_open: 'مفتوحة', invStatus_posted: 'مرحّلة', invStatus_cancelled: 'ملغاة',
    invTrack: 'تتبع المخزون', invUnit: 'الوحدة', invReorderLevel: 'حد إعادة الطلب', invReorderQty: 'كمية إعادة الطلب', invSave: 'حفظ', invSaved: 'تم الحفظ.',
    invAllowNeg: 'السماح بالبيع تحت الصفر', invNewWh: 'مخزن جديد (الكود والاسم)', invAddWh: 'إضافة مخزن',
    invTotal: 'إجمالي القيمة', invGl: 'رصيد حساب 1300', invDiff: 'الفرق', invMatches: 'مطابق للدفاتر', invMismatch: 'غير مطابق للدفاتر',
    invOtherPosted: 'مسجل على 1300 خارج المخزون', invUnknown: 'غير معروف', invPickItem: 'اختر صنفاً', invChg: '+ / -', invLvl: 'الحد', invRq: 'الكمية',
  });

  // Module state (reloaded on every home load)
  let stock = null, items = [], warehouses = [], units = [], counts = [], warnings = null, valuation = null, settings = null;
  let sheet = null, found = null, whFilter = '';
  const val = (id) => document.getElementById(id)?.value ?? '';
  const name = (r) => esc(state.lang === 'ar' ? (r.name_ar || r.name) : r.name);
  const whName = (w) => esc(state.lang === 'ar' ? (w.name_ar || w.name) : w.name);
  const unitName = (code) => { const u = units.find((x) => x.code === code); return esc(u ? (state.lang === 'ar' ? u.name_ar : u.name) : code ?? ''); };
  const whOptions = (sel) => warehouses.filter((w) => w.active).map((w) => `<option value="${w.id}" ${String(sel) === String(w.id) ? 'selected' : ''}>${whName(w)}</option>`).join('');
  const itemOptions = (list, placeholder = true) => `${placeholder ? `<option value="">${t('invPickItem')}</option>` : ''}${list.map((i) => `<option value="${esc(i.sku)}">${esc(i.sku)} - ${name(i)}</option>`).join('')}`;
  const chips = (r) => [
    r.negative ? `<span class="chip bad">${t('invChipNeg')}</span>` : r.outOfStock ? `<span class="chip bad">${t('invChipOut')}</span>` : '',
    r.low && !r.negative && !r.outOfStock ? `<span class="chip warn">${t('invChipLow')}</span>` : '',
  ].join(' ');

  let loadingFor = null; // user id the current load belongs to; a stale load (user switched meanwhile) must not call the API
  async function safe(fn) { if (loadingFor !== state.userId) return null; try { return await fn(); } catch (e) { console.error('inventory load', e); return null; } }
  const loadSheet = (id) => safe(async () => { sheet = await api('GET', `/api/inventory/counts/${id}`); });

  App.onLoad(async (home) => {
    stock = items = warehouses = units = counts = warnings = valuation = settings = null;
    items = []; warehouses = []; units = []; counts = [];
    loadingFor = home.user.id;
    const can = (a) => home.permissions.includes(a);
    if (!can('inventory.view')) return;
    // One request for everything keeps the dashboard responsive (the warehouse filter refetches the stock list only).
    const o = await safe(() => api('GET', '/api/inventory/overview'));
    stock = o?.stock ?? null; items = o?.items; units = o?.units; counts = o?.counts; warnings = o?.warnings ?? null; settings = o?.settings ?? null; valuation = o?.valuation ?? null;
    if (o && whFilter) stock = await safe(() => api('GET', `/api/inventory/stock?warehouse=${encodeURIComponent(whFilter)}`));
    warehouses = stock?.warehouses ?? [];
    items = items ?? []; units = units ?? []; counts = counts ?? [];
    if (sheet) await loadSheet(sheet.id);
  });
  App.onUserChange(() => { sheet = null; found = null; whFilter = ''; });

  const page = { page: 'inventory', pageTitleKey: 'invPage' };

  // Low-stock alerts (home widget)
  App.addCard({ id: 'inventory.low', area: 'main', order: 115, ...page, render: ({ widgets: w }) => {
    const x = w.inventory;
    if (!x) return '';
    const neg = x.negativeCount ? `<div class="note bad">${x.negativeCount} ${t('invNegWarn')}</div>` : '';
    const unk = warnings?.flagged?.some((f) => f.flags.includes('cost_unknown')) ? `<div class="note warn">${warnings.flagged.filter((f) => f.flags.includes('cost_unknown')).length} ${t('invCostWarn')}</div>` : '';
    return `<div class="card"><h2>${t('invLow')}</h2>${x.low.length ? `<table>${x.low.map((r) => `<tr><td>${name(r)}<div class="sub">${esc(r.sku)} · ${t('invReorderAt')} ${r.reorder_level}</div></td>
      <td class="num">${r.qty}</td><td class="num">${chips({ ...r, outOfStock: r.qty <= 0, low: true })}</td></tr>`).join('')}</table>` : `<div class="empty">${t('invAllGood')}</div>`}${neg}${unk}</div>`;
  } });

  // Stock list
  App.addCard({ id: 'inventory.stock', area: 'main', order: 116, permission: 'inventory.view', ...page, render: () => {
    const costs = has('inventory.costs');
    const rows = stock?.items ?? [];
    return `<div class="card"><h2>${t('invStock')}</h2>
    <div class="row"><select id="inv-wh" data-act="inv-filter"><option value="">${t('invAllWh')}</option>${whOptions(whFilter)}</select>
    <input type="text" id="inv-barcode" placeholder="${t('invBarcode')}"><button class="small" data-act="inv-find">${t('invFind')}</button></div>
    ${found ? `<div class="note good">${t('invFound')}: ${name(found)} · ${esc(found.sku)} · ${t('invQty')} ${found.qty}</div>` : ''}
    ${rows.length ? `<table><tr><th>${t('invItem')}</th><th class="num">${t('invQty')}</th>${costs ? `<th class="num">${t('invAvg')}</th><th class="num">${t('invValue')}</th>` : ''}</tr>${rows.map((r) => `
    <tr><td>${name(r)}<div class="sub">${esc(r.sku)}${r.barcode ? ` · ${esc(r.barcode)}` : ''}</div>${chips(r)}</td><td class="num">${r.qty} ${unitName(r.unit)}</td>
    ${costs ? `<td class="num">${r.avgCost == null ? `<span class="chip mute">${t('invUnknown')}</span>` : money(r.avgCost)}</td><td class="num">${money(r.value)}</td>` : ''}</tr>`).join('')}</table>`
      : `<div class="empty">${t('invNoStock')}</div>`}</div>`;
  } });
  App.onChange('inv-filter', (el) => { whFilter = el.value; App.reload(); });
  App.on('inv-find', () => run(async () => {
    found = null;
    const code = val('inv-barcode').trim();
    if (!code) return;
    try { found = await api('GET', `/api/inventory/barcode/${encodeURIComponent(code)}`); } catch (e) { toast(e.message); }
  }));

  // Receive
  App.addCard({ id: 'inventory.receive', area: 'main', order: 117, permission: 'inventory.receive', ...page, render: () => `<div class="card"><h2>${t('invReceive')}</h2>
    <div class="row"><input type="text" id="inv-supplier" placeholder="${t('invSupplier')}"><select id="inv-r-wh">${whOptions(warehouses.find((w) => w.is_default)?.id)}</select></div>
    <div class="row"><select id="inv-r-sku">${itemOptions(items)}</select><input class="qty" type="number" min="1" step="1" id="inv-r-qty" placeholder="${t('invQty')}" title="${t('invQty')}">
    <input class="qty" type="number" min="0" step="0.01" id="inv-r-cost" placeholder="${t('invUnitCost').split(' ')[0]}" title="${t('invUnitCost')}"></div>
    <div class="row"><button class="primary" data-act="inv-receive">${t('invDoReceive')}</button></div></div>` });
  App.on('inv-receive', () => run(() => api('POST', '/api/inventory/receive', {
    supplier: val('inv-supplier'), sku: val('inv-r-sku'), qty: Number(val('inv-r-qty')), unitCost: App.toPiastres(val('inv-r-cost')), warehouseId: Number(val('inv-r-wh')),
  }), t('invReceived')));

  // Adjust and transfer
  App.addCard({ id: 'inventory.adjust', area: 'main', order: 118, permission: 'inventory.adjust', ...page, render: () => {
    const tracked = (stock?.items ?? []);
    return `<div class="card"><h2>${t('invAdjust')}</h2>
    <div class="row"><select id="inv-a-sku">${itemOptions(tracked)}</select><select id="inv-a-wh">${whOptions(warehouses.find((w) => w.is_default)?.id)}</select>
    <input class="qty" type="number" step="1" id="inv-a-qty" placeholder="${t('invChg')}" title="${t('invChange')}"></div>
    <div class="row"><input type="text" id="inv-a-reason" placeholder="${t('invReason')}"><button class="primary" data-act="inv-adjust">${t('invDoAdjust')}</button></div>
    <h2 style="margin-top:14px">${t('invTransfer')}</h2>
    <div class="row"><select id="inv-t-sku">${itemOptions(tracked)}</select><select id="inv-t-from" title="${t('invFrom')}">${whOptions(warehouses.find((w) => w.is_default)?.id)}</select>
    <select id="inv-t-to" title="${t('invTo')}">${whOptions(warehouses.filter((w) => !w.is_default)[0]?.id)}</select>
    <input class="qty" type="number" min="1" step="1" id="inv-t-qty" placeholder="${t('invQty')}"><button data-act="inv-transfer">${t('invDoTransfer')}</button></div></div>`;
  } });
  App.on('inv-adjust', () => run(() => api('POST', '/api/inventory/adjust', {
    sku: val('inv-a-sku'), warehouseId: Number(val('inv-a-wh')), qty: Number(val('inv-a-qty')), reason: val('inv-a-reason'),
  }), t('invAdjusted')));
  App.on('inv-transfer', () => run(() => api('POST', '/api/inventory/transfer', {
    sku: val('inv-t-sku'), fromWarehouseId: Number(val('inv-t-from')), toWarehouseId: Number(val('inv-t-to')), qty: Number(val('inv-t-qty')),
  }), t('invTransferred')));

  // Stocktake
  App.addCard({ id: 'inventory.count', area: 'main', order: 119, permission: 'inventory.view', ...page, render: () => {
    const edit = has('inventory.adjust');
    const list = counts.length ? `<table>${counts.slice(0, 5).map((c) => `<tr><td>#${c.id} ${esc(c.warehouse)}<div class="sub">${esc(c.note ?? '')}</div></td>
      <td class="num">${c.counted}/${c.total}</td><td class="num"><span class="chip ${c.status === 'posted' ? 'good' : c.status === 'open' ? 'warn' : 'mute'}">${t('invStatus_' + c.status)}</span></td>
      <td class="num"><button class="small" data-act="inv-count-open" data-id="${c.id}">${t('invOpenCount')}</button></td></tr>`).join('')}</table>` : '';
    const open = sheet ? `<h2 style="margin-top:14px">${t('invSheet')} #${sheet.id}</h2><table><tr><th>${t('invItem')}</th><th class="num">${t('invExpected')}</th><th class="num">${t('invCounted')}</th><th class="num">${t('invVariance')}</th></tr>
      ${sheet.lines.map((l) => `<tr><td>${name(l)}<div class="sub">${esc(l.sku)}</div></td><td class="num">${l.expected_qty}</td>
      <td class="num">${edit && sheet.status === 'open' ? `<input class="qty" type="number" min="0" step="1" data-act="inv-count-qty" data-sku="${esc(l.sku)}" value="${l.counted_qty ?? ''}">` : (l.counted_qty ?? '')}</td>
      <td class="num">${l.variance_qty ?? (l.counted_qty == null ? '' : l.counted_qty - l.expected_qty)}</td></tr>`).join('')}</table>
      <div class="row">${edit && sheet.status === 'open' ? `<button class="primary" data-act="inv-count-post">${t('invPostCount')}</button><input type="text" id="inv-c-reason" placeholder="${t('invReason')}"><button class="small" data-act="inv-count-cancel">${t('invCancelCount')}</button>` : ''}
      <button class="small" data-act="inv-count-close">${t('invClose')}</button></div>` : '';
    return `<div class="card"><h2>${t('invCount')}</h2>${list}${edit ? `<div class="row"><select id="inv-c-wh">${whOptions(warehouses.find((w) => w.is_default)?.id)}</select><button data-act="inv-count-start">${t('invStartCount')}</button></div>` : ''}${open}</div>`;
  } });
  App.on('inv-count-start', () => run(async () => { sheet = await api('POST', '/api/inventory/counts', { warehouseId: Number(val('inv-c-wh')) }); }, t('invCountStarted')));
  App.on('inv-count-open', (b) => run(async () => { await loadSheet(b.dataset.id); }));
  App.on('inv-count-close', () => { sheet = null; App.render(); });
  // Save each counted quantity as soon as it is entered, without re-rendering the sheet under the user's fingers.
  App.onChange('inv-count-qty', async (el) => {
    try {
      const v = el.value === '' ? null : Number(el.value);
      await api('PUT', `/api/inventory/counts/${sheet.id}`, { lines: [{ sku: el.dataset.sku, countedQty: v }] });
      const l = sheet.lines.find((x) => x.sku === el.dataset.sku);
      l.counted_qty = v;
      el.closest('tr').lastElementChild.textContent = v == null ? '' : v - l.expected_qty;
    } catch (e) { toast(e.message); }
  });
  App.on('inv-count-post', () => run(async () => { await api('POST', `/api/inventory/counts/${sheet.id}/post`, {}); await loadSheet(sheet.id); }, t('invCountPosted')));
  App.on('inv-count-cancel', () => run(async () => { await api('POST', `/api/inventory/counts/${sheet.id}/cancel`, { reason: val('inv-c-reason') }); sheet = null; }, t('saved')));

  // Setup: per-item barcode, unit and reorder levels; warehouses; negative-stock switch
  App.addCard({ id: 'inventory.setup', area: 'main', order: 121, permission: 'inventory.manage', ...page, render: () => `<div class="card"><h2>${t('invSetup')}</h2>
    <div class="row"><select id="inv-s-sku" data-act="inv-s-pick">${itemOptions(items ?? [])}</select><label><input type="checkbox" id="inv-s-track" checked> ${t('invTrack')}</label></div>
    <div class="row"><input type="text" id="inv-s-barcode" placeholder="${t('invBarcode')}"><select id="inv-s-unit">${(units ?? []).map((u) => `<option value="${esc(u.code)}">${unitName(u.code)}</option>`).join('')}</select></div>
    <div class="row"><input class="qty" type="number" min="0" step="1" id="inv-s-level" placeholder="${t('invLvl')}" title="${t('invReorderLevel')}"><input class="qty" type="number" min="0" step="1" id="inv-s-rqty" placeholder="${t('invRq')}" title="${t('invReorderQty')}">
    <button class="primary" data-act="inv-s-save">${t('invSave')}</button></div>
    <div class="row"><label><input type="checkbox" id="inv-s-neg" data-act="inv-s-neg" ${settings?.allowNegative ? 'checked' : ''}> ${t('invAllowNeg')}</label></div>
    <div class="row"><input type="text" id="inv-w-code" placeholder="${t('invNewWh')}" style="max-width:120px"><input type="text" id="inv-w-name" placeholder="${t('invWarehouse')}"><button class="small" data-act="inv-w-add">${t('invAddWh')}</button></div></div>` });
  App.onChange('inv-s-pick', (el) => {
    const it = items.find((i) => i.sku === el.value);
    if (!it) return;
    document.getElementById('inv-s-track').checked = it.track === 1 || it.track === true;
    document.getElementById('inv-s-barcode').value = it.barcode ?? '';
    if (it.unit) document.getElementById('inv-s-unit').value = it.unit;
    document.getElementById('inv-s-level').value = it.reorder_level ?? 0;
    document.getElementById('inv-s-rqty').value = it.reorder_qty ?? 0;
  });
  App.on('inv-s-save', () => run(() => api('PUT', `/api/inventory/items/${encodeURIComponent(val('inv-s-sku'))}`, {
    track: document.getElementById('inv-s-track').checked, barcode: val('inv-s-barcode').trim() || null, unit: val('inv-s-unit'),
    reorderLevel: Number(val('inv-s-level') || 0), reorderQty: Number(val('inv-s-rqty') || 0),
  }), t('invSaved')));
  App.onChange('inv-s-neg', (el) => run(() => api('PUT', '/api/inventory/settings', { allowNegative: el.checked }), t('invSaved')));
  App.on('inv-w-add', () => run(() => api('POST', '/api/inventory/warehouses', { code: val('inv-w-code'), name: val('inv-w-name') }), t('invSaved')));

  // Valuation (needs inventory.costs)
  App.addCard({ id: 'inventory.valuation', area: 'main', order: 122, permission: 'inventory.costs', ...page, render: () => {
    const v = valuation;
    if (!v) return '';
    return `<div class="card"><h2>${t('invValuation')}</h2>
    <table><tr><th>${t('invItem')}</th><th class="num">${t('invQty')}</th><th class="num">${t('invAvg')}</th><th class="num">${t('invValue')}</th></tr>${v.items.map((i) => `
      <tr><td>${name(i)}<div class="sub">${esc(i.sku)}</div></td><td class="num">${i.qty}</td><td class="num">${i.avgCost == null ? `<span class="chip mute">${t('invUnknown')}</span>` : money(i.avgCost)}</td><td class="num">${money(i.value)}</td></tr>`).join('')}
    <tr><td><b>${t('invTotal')}</b></td><td></td><td></td><td class="num"><b>${money(v.total)}</b></td></tr>
    <tr><td>${t('invGl')}</td><td></td><td></td><td class="num">${money(v.ledgerBalance)}</td></tr></table>
    <div class="note ${v.reconciled ? 'good' : 'bad'}">${v.reconciled ? t('invMatches') : `${t('invMismatch')}: ${t('invDiff')} ${money(v.difference)}${v.ledgerOther ? ` (${money(v.ledgerOther)} ${t('invOtherPosted')})` : ''}`}</div></div>`;
  } });
}
