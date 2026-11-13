// Simple mode shell (DESIGN_PLAN 4.1). Vanilla ES modules, no build step, no dependencies.
// Reads and writes only through the existing API; every posting goes through the same sales services as full mode.
import { esc } from '/lib/html.js';
import { formatMoney, normalizeDigits, parseAmountToPiastres } from '/lib/format.js';
import { init, session, setUser, get, post, call, newKey, ApiError, store, queue } from './api.js';
import { STRINGS, GLOSSARY } from './glossary.js';
import * as L from './logic.js';
import { scanSupported, startScan } from './barcode.js';

const $ = (id) => document.getElementById(id);
const S = {
  lang: store.get('acct.lang') === 'ar' || (!store.get('acct.lang') && (navigator.language ?? '').toLowerCase().startsWith('ar')) ? 'ar' : 'en',
  digits: normalizeDigits(store.get('acct.digits')),
  route: 'today', home: null, items: [], customers: [], aging: [], invoices: [], business: '',
  cart: [], q: '', method: 'cash', customerId: '', busy: false, authNeeded: false, loaded: false, wordsQ: '', pending: 0,
};
const t = (k) => STRINGS[S.lang][k] ?? STRINGS.en[k] ?? k;
const money = (p) => formatMoney(p, S.lang, S.digits);
const can = (p) => S.home?.permissions.includes(p) ?? false;
const name = (i) => (S.lang === 'ar' ? i.name_ar || i.name : i.name);
const WALK_IN = 'Walk-in'; // stored in the books as written; shown translated on screen
const modeKey = () => `acct.ui.mode.${session.users.length ? session.userId : 'session'}`;
let saleKey = null; // idempotency key of the sale being confirmed; reset when the basket changes
let scanner = null;

function toast(msg, ok = false) {
  const el = $('toast'); el.textContent = msg; el.className = ok ? 'toast ok' : 'toast bad'; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 5000);
}
const errMsg = (e) => (e.code === 'NETWORK' ? t('offline') : e.code === 'FORBIDDEN' ? t('noPerm') : e.message);

// ---------- data ----------
async function loadAll() {
  S.authNeeded = false;
  try { S.home = await get('/api/home'); }
  catch (e) { if (e.code === 'AUTH_REQUIRED') { S.authNeeded = true; S.loaded = true; return render(); } toast(errMsg(e)); S.loaded = true; return render(); }
  const tryGet = async (path, fallback) => { try { return await get(path); } catch { return fallback; } };
  const [items, customers, aging, invoices, settings] = await Promise.all([
    can('sales.view') || can('sales.create') ? tryGet('/api/items', []) : [],
    can('sales.view') ? tryGet('/api/customers', []) : [],
    can('sales.view') ? tryGet('/api/customers/aging', { rows: [] }) : { rows: [] },
    can('sales.view') ? tryGet('/api/invoices', []) : [],
    can('sales.view') ? tryGet('/api/sales/settings', {}) : {},
  ]);
  Object.assign(S, { items, customers, aging: L.rankOwed(aging.rows ?? []), invoices, business: settings.businessName ?? '', countryCode: settings.countryCode || '20', loaded: true });
  render();
}

// ---------- chrome ----------
function chrome() {
  document.documentElement.lang = S.lang; document.documentElement.dir = S.lang === 'ar' ? 'rtl' : 'ltr';
  document.title = t('appName');
  $('brand').textContent = t('appName');
  $('lang').textContent = t('lang');
  $('full').textContent = t('fullMode');
  const sel = $('user'); sel.hidden = !session.users.length; sel.setAttribute('aria-label', t('user'));
  sel.innerHTML = session.users.map((u) => `<option value="${u.id}"${u.id === session.userId ? ' selected' : ''}>${esc(u.name)}</option>`).join('');
  const tabs = [['today', 'tabToday', '●'], ['sell', 'tabSell', '+'], ['owed', 'tabOwed', '₤'], ['words', 'tabWords', '?']];
  $('tabs').innerHTML = tabs.map(([r, k, g]) => `<a href="#/${r}" data-tab="${r}" ${S.route === r ? 'aria-current="page"' : ''}><span class="g" aria-hidden="true">${g}</span>${esc(t(k))}</a>`).join('');
  $('conn').hidden = navigator.onLine !== false && !S.pending;
  $('conn').textContent = navigator.onLine === false ? t('offline') : S.pending ? `${S.pending} ${t('queued')}` : '';
}

function render() {
  chrome();
  const v = $('view');
  if (S.authNeeded) { v.innerHTML = `<section class="card"><h2>${esc(t('signIn'))}</h2><a class="btn primary" href="/">${esc(t('signInGo'))}</a></section>`; return; }
  if (!S.loaded) { v.innerHTML = `<p class="muted" role="status">${esc(t('loading'))}</p>`; return; }
  v.dataset.ready = '1';
  v.innerHTML = ({ today: viewToday, sell: viewSell, owed: viewOwed, words: viewWords }[S.route] ?? viewToday)();
  if (S.route === 'sell') { paintGrid(); paintBasket(); }
  if (S.route === 'words') paintWords();
}

// ---------- today ----------
function viewToday() {
  const w = S.home.widgets ?? {};
  const sold = L.soldToday(w.todaySales ?? {}, S.invoices, L.isoToday());
  const owedTotal = S.aging.reduce((s, r) => s + r.total, 0);
  const top = S.aging.slice(0, 3);
  return `<section class="card hero" aria-labelledby="h-sold">
    <div class="big" id="sold-total" data-testid="sold-total">${esc(money(sold.total))}</div>
    <div class="muted" id="h-sold">${esc(t('soldToday'))} · ${sold.count} ${esc(t('sales'))}</div>
    <div class="row sub">${w.cash ? `<span>${esc(t('drawer'))} <b data-testid="drawer">${esc(money(w.cash.balance))}</b> <small class="muted">(${esc(t('drawerNote'))})</small></span>` : `<small class="muted">${esc(t('noDrawer'))}</small>`}</div>
  </section>
  <section class="card" aria-labelledby="h-owed">
    <h2 id="h-owed">${esc(t('owedToYou'))} <span class="amt" data-testid="owed-total">${esc(money(owedTotal))}</span></h2>
    ${top.length ? `<div class="muted small">${esc(t('oldest'))}</div><ul class="list">${top.map((r) => `<li><a href="#/owed"><span>${esc(r.name === WALK_IN ? t('walkIn') : r.name)}</span><span class="num">${esc(money(r.total))}</span><span class="late${r.daysLate ? ' bad' : ''}">${r.daysLate ? `${r.daysLate} ${esc(t('daysLate'))}` : esc(t('notDue'))}</span></a></li>`).join('')}</ul>`
      : `<p class="muted">${esc(t('nobodyOwes'))}</p>`}
  </section>
  <section class="card" aria-labelledby="h-comp"><h2 id="h-comp">${esc(t('compliance'))} <span class="chip" data-testid="compliance">${esc(t('complianceNone'))}</span></h2><p class="muted small">${esc(t('complianceNote'))}</p></section>
  <div class="actions"><a class="btn primary big-btn" href="#/sell">${esc(t('sell'))}</a><a class="btn big-btn" href="#/owed">${esc(t('paid'))}</a></div>
  <p class="muted small">${esc(t('readyNote'))}</p>`;
}

// ---------- sell ----------
function viewSell() {
  const credit = S.method === 'credit';
  return `<section class="card">
    <div class="searchrow"><input id="q" type="search" value="${esc(S.q)}" placeholder="${esc(t('search'))}" aria-label="${esc(t('search'))}" autocomplete="off" enterkeyhint="search">
    <button type="button" class="btn" data-act="scan" id="scanbtn">${esc(t('scan'))}</button></div>
    <div id="scanpanel" hidden></div>
    <div id="grid" class="grid" role="list"></div>
  </section>
  <section class="card" aria-labelledby="h-cart"><h2 id="h-cart">${esc(t('cart'))}</h2><div id="basket"></div>
    <fieldset class="pay"><legend>${esc(t('payHow'))}</legend>
      ${['cash', 'wallet', 'credit'].map((m) => `<label class="seg"><input type="radio" name="method" value="${m}"${S.method === m ? ' checked' : ''}><span>${esc(t(m))}</span></label>`).join('')}
    </fieldset>
    <div id="creditbox" ${credit ? '' : 'hidden'}>${creditBox()}</div>
    <button type="button" class="btn primary big-btn" id="confirm" data-act="confirm" disabled>${esc(t('confirmSale'))}</button>
  </section>`;
}
function creditBox() {
  return `<label class="stack">${esc(t('whoOwes'))}<select id="cust"><option value="">${esc(t('chooseCustomer'))}</option>${S.customers.map((c) => `<option value="${c.id}"${String(c.id) === String(S.customerId) ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
  ${can('customers.manage') ? `<details><summary>${esc(t('newCustomer'))}</summary><div class="stack"><input id="nc-name" placeholder="${esc(t('custName'))}" aria-label="${esc(t('custName'))}"><input id="nc-phone" inputmode="tel" placeholder="${esc(t('custPhone'))}" aria-label="${esc(t('custPhone'))}"><button type="button" class="btn" data-act="addcust">${esc(t('add'))}</button></div></details>` : ''}`;
}
function paintGrid() {
  const g = $('grid'); if (!g) return;
  const list = L.filterItems(S.items, S.q, S.lang);
  g.innerHTML = list.length ? list.map((i) => `<button type="button" role="listitem" class="tile" data-act="add" data-sku="${esc(i.sku)}"><span class="tn">${esc(name(i))}</span><span class="tp">${esc(money(i.price))}</span></button>`).join('')
    : `<p class="muted">${esc(t('codeNotFound'))}</p>`;
}
const lines = () => L.cartLines(S.cart, S.items);
function paintBasket() {
  const b = $('basket'); if (!b) return;
  const ls = lines(); const sub = L.cartSubtotal(ls); const vat = L.estimateVat(sub, S.home?.vatRateBp);
  b.innerHTML = ls.length ? `<ul class="list basket">${ls.map((l) => `<li data-sku="${esc(l.sku)}"><span class="ln">${esc(S.lang === 'ar' ? l.nameAr : l.name)}</span>
    <span class="step"><button type="button" class="btn sq" data-act="dec" data-sku="${esc(l.sku)}" aria-label="${esc(t('minus'))}">−</button><b class="qty" data-testid="qty-${esc(l.sku)}">${l.qty}</b><button type="button" class="btn sq" data-act="inc" data-sku="${esc(l.sku)}" aria-label="${esc(t('plus'))}">+</button></span>
    <span class="num">${esc(money(l.amount))}</span></li>`).join('')}</ul>
    <div class="row"><span>${esc(t('beforeTax'))}</span><b data-testid="subtotal">${esc(money(sub))}</b></div>
    ${vat ? `<div class="row"><span>${esc(t('tax'))}</span><span>${esc(money(vat))}</span></div>` : ''}
    <div class="row tot"><span>${esc(t('estTotal'))}</span><b data-testid="cart-total">${esc(money(sub + vat))}</b></div>` : `<p class="muted" data-testid="empty-cart">${esc(t('emptyCart'))}</p>`;
  const c = $('confirm'); if (c) c.disabled = !ls.length || S.busy;
}
function touchCart() { saleKey = null; paintBasket(); }

async function findCode(code) {
  const c = String(code ?? '').trim(); if (!c) return false;
  let item = null;
  if (can('inventory.view')) { try { const r = await get(`/api/inventory/barcode/${encodeURIComponent(c)}`); item = S.items.find((i) => i.sku === r.sku) ?? null; } catch { /* not found: try the sku */ } }
  item ??= L.matchCode(S.items, c);
  if (!item) { toast(t('codeNotFound')); return false; }
  S.cart = L.addOne(S.cart, item.sku); touchCart(); toast(`+1 ${name(item)}`, true); return true;
}
async function openScan() {
  const p = $('scanpanel'); if (!p) return;
  if (!p.hidden) return closeScan();
  p.hidden = false;
  p.innerHTML = `${scanSupported() ? `<video id="cam" class="cam" muted playsinline aria-label="${esc(t('scanning'))}"></video>` : `<p class="muted small" data-testid="scan-none">${esc(t('scanNone'))}</p>`}
    <div class="searchrow"><input id="code" inputmode="numeric" placeholder="${esc(t('typeCode'))}" aria-label="${esc(t('typeCode'))}" autocomplete="off"><button type="button" class="btn" data-act="findcode">${esc(t('find'))}</button><button type="button" class="btn" data-act="stopscan">${esc(t('stopScan'))}</button></div>`;
  if (scanSupported()) scanner = await startScan($('cam'), { onCode: (c) => findCode(c), onError: (k) => { toast(k === 'denied' ? t('scanDenied') : t('scanNone')); } });
}
function closeScan() { scanner?.stop(); scanner = null; const p = $('scanpanel'); if (p) { p.hidden = true; p.innerHTML = ''; } }

async function confirmSale() {
  const ls = lines(); if (!ls.length || S.busy) return;
  const method = S.method; const custId = Number(S.customerId) || null; const cust = S.customers.find((c) => c.id === custId);
  if (method === 'credit' && !cust) return toast(t('pickCustomer'));
  S.busy = true; paintBasket(); $('confirm').textContent = t('saving');
  saleKey ??= newKey();
  const key = saleKey;
  try {
    let r;
    if (method === 'cash') {
      const body = { items: L.quickItems(ls) };
      try { const res = await post('/api/sales/quick', body, key); r = { sub: res.sale.subtotal, vat: res.sale.vat, total: res.sale.total, number: `#${res.sale.id}` }; }
      catch (e) {
        if (e.code !== 'NETWORK') throw e;
        await queue(refreshPending).enqueue({ method: 'POST', path: '/api/sales/quick', body, key, label: 'Quick sale (simple mode)' }); // never lose a sale
        S.cart = []; saleKey = null; await refreshPending(); toast(t('savedDevice'), true); return;
      }
    } else if (method === 'credit') {
      const res = await post('/api/invoices', { customerId: cust.id, lines: L.invoiceLines(ls) }, key);
      r = { sub: res.subtotal, vat: res.vat, total: res.total, number: res.number };
    } else { // wallet: an invoice for Walk-in, then a wallet payment for the same amount; both through the existing sales services
      const inv = await post('/api/invoices', { customer: WALK_IN, lines: L.invoiceLines(ls) }, key);
      try { await post('/api/payments', { allocations: [{ invoiceId: inv.id, amount: inv.total }], method: 'wallet', amount: inv.total }, `${key}-pay`); }
      catch (e) { toast(t('walletPartial')); S.cart = []; saleKey = null; await loadAll(); return; }
      r = { sub: inv.subtotal, vat: inv.vat, total: inv.total, number: inv.number };
    }
    const receipt = { ...r, lines: ls, method, customer: cust?.name ?? '', phone: cust?.phone ?? '', date: L.isoToday() };
    S.cart = []; saleKey = null; S.customerId = ''; S.q = '';
    await loadAll(); openReceipt(receipt);
  } catch (e) { toast(errMsg(e)); }
  finally { S.busy = false; if ($('confirm')) { $('confirm').textContent = t('confirmSale'); paintBasket(); } }
}

// ---------- receipt ----------
function receiptOf(r) {
  return L.receiptText({ business: S.business, number: r.number, date: r.date, lines: r.lines, subtotal: r.sub, vat: r.vat, total: r.total, method: r.method, customer: r.customer, labels: STRINGS[S.lang], fmt: money, lang: S.lang });
}
function openReceipt(r) {
  const text = receiptOf(r);
  $('print-area').textContent = text;
  sheet(`<h2>${esc(t('saleSaved'))}</h2><pre class="receipt" data-testid="receipt">${esc(text)}</pre><p class="muted small">${esc(t('notLegal'))}</p>
    <div class="actions"><button type="button" class="btn primary" data-act="share" data-text="${esc(text)}">${esc(t('share'))}</button>
    <a class="btn" id="wa" target="_blank" rel="noopener noreferrer" href="${esc(L.whatsappLink(text, r.phone, S.countryCode))}">${esc(t('whatsapp'))}</a>
    <button type="button" class="btn" data-act="print">${esc(t('print'))}</button><button type="button" class="btn" data-act="closesheet">${esc(t('newSale'))}</button></div>`);
}

// ---------- owed ----------
function viewOwed() {
  return `<section class="card"><h2>${esc(t('owedToYou'))}</h2>${S.aging.length ? `<ul class="list owed">${S.aging.map((r, i) => `<li data-testid="owed-row" data-name="${esc(r.name)}"><div class="who"><b>${esc(r.name === WALK_IN ? t('walkIn') : r.name)}</b>
    <span class="late${r.daysLate ? ' bad' : ''}">${r.daysLate ? `${r.daysLate} ${esc(t('daysLate'))}` : esc(t('notDue'))}</span></div>
    <div class="num">${esc(money(r.total))}</div>
    <div class="btns"><button type="button" class="btn" data-act="remind" data-i="${i}"${r.customerId ? '' : ' disabled'}>${esc(t('remind'))}</button><button type="button" class="btn primary" data-act="pay" data-i="${i}">${esc(t('gotPaid'))}</button></div></li>`).join('')}</ul>` : `<p class="muted">${esc(t('nobodyOwes'))}</p>`}</section>`;
}
async function remind(i) {
  const r = S.aging[i];
  try {
    const x = await get(`/api/customers/${r.customerId}/reminder?lang=${S.lang}`);
    sheet(`<h2>${esc(t('reminderTitle'))}: ${esc(r.name)}</h2><pre class="receipt" data-testid="reminder-text">${esc(x.message)}</pre><p class="muted small">${esc(t('reminderNote'))}</p>
      <div class="actions"><a class="btn primary" id="wa-remind" target="_blank" rel="noopener noreferrer" href="${esc(x.link)}">${esc(t('openWhatsapp'))}</a><button type="button" class="btn" data-act="share" data-text="${esc(x.message)}">${esc(t('copy'))}</button><button type="button" class="btn" data-act="closesheet">${esc(t('close'))}</button></div>`);
  } catch (e) { toast(errMsg(e)); }
}
let payFor = null;
function payDialog(i) {
  const r = S.aging[i]; payFor = { r, key: newKey() };
  sheet(`<h2>${esc(t('gotPaid'))}: ${esc(r.name === WALK_IN ? t('walkIn') : r.name)}</h2>
    <label class="stack">${esc(t('amount'))}<input id="pay-amt" inputmode="decimal" value="${esc((r.total / 100).toFixed(2))}" data-testid="pay-amount"></label>
    <button type="button" class="btn small" data-act="payfull">${esc(t('fullBalance'))}: ${esc(money(r.total))}</button>
    <fieldset class="pay"><legend>${esc(t('howPaid'))}</legend>${['cash', 'wallet'].map((m, n) => `<label class="seg"><input type="radio" name="paym" value="${m}"${n ? '' : ' checked'}><span>${esc(t(m))}</span></label>`).join('')}</fieldset>
    <p class="muted" id="pay-left" data-testid="pay-left"></p><p class="bad" id="pay-err" role="alert"></p>
    <div class="actions"><button type="button" class="btn primary" data-act="paysave" id="paysave">${esc(t('payConfirm'))}</button><button type="button" class="btn" data-act="closesheet">${esc(t('cancel'))}</button></div>`);
  payPreview();
}
function payAmount() { const p = parseAmountToPiastres($('pay-amt').value); return Number.isInteger(p) && p > 0 ? p : NaN; }
function payPreview() {
  const a = payAmount(), total = payFor.r.total;
  $('pay-err').textContent = Number.isNaN(a) ? t('badAmount') : a > total ? t('tooMuch') : '';
  $('pay-left').textContent = !Number.isNaN(a) && a <= total ? `${t('leftOver')}: ${money(total - a)}` : '';
  $('paysave').disabled = Number.isNaN(a) || a > total;
}
async function paySave() {
  const a = payAmount(); if (Number.isNaN(a)) return;
  const { r, key } = payFor; const method = document.querySelector('input[name="paym"]:checked')?.value ?? 'cash';
  try {
    const plan = L.planAllocations(r.invoices.map((x) => ({ id: x.id, balance: x.balance })), a);
    if (plan.left > 0) throw new ApiError(t('tooMuch'));
    $('paysave').disabled = true;
    await post('/api/payments', { allocations: plan.allocations, method, amount: a }, `${key}-${a}-${method}`);
    await loadAll(); closeSheet(); toast(t('paymentSaved'), true);
  } catch (e) { $('pay-err').textContent = errMsg(e); $('paysave').disabled = false; }
}

// ---------- words ----------
function viewWords() {
  return `<section class="card"><h2>${esc(t('wordsTitle'))}</h2><p class="muted">${esc(t('wordsIntro'))}</p><p class="note">${esc(t('wordsDraft'))}</p>
    <input id="wq" type="search" value="${esc(S.wordsQ)}" placeholder="${esc(t('wordsSearch'))}" aria-label="${esc(t('wordsSearch'))}"><div id="wlist"></div></section>`;
}
function paintWords() {
  const q = S.wordsQ.trim().toLowerCase();
  const rows = GLOSSARY.filter((g) => !q || [g.en, g.ar, g.ledger, g.hint.en, g.hint.ar].some((v) => v.toLowerCase().includes(q)));
  $('wlist').innerHTML = `<dl class="words">${rows.map((g) => `<div data-term="${g.key}"><dt><b>${esc(S.lang === 'ar' ? g.ar : g.en)}</b> <span class="muted">/ ${esc(S.lang === 'ar' ? g.en : g.ar)}</span></dt><dd>${esc(g.hint[S.lang])} <small class="muted">${esc(t('ledgerTerm'))}: ${esc(g.ledger)}</small></dd></div>`).join('')}</dl>`;
}

// ---------- sheet (native dialog) ----------
function sheet(html) { const d = $('sheet'); d.innerHTML = `<div class="sheet-body">${html}</div>`; if (!d.open) d.showModal(); }
function closeSheet() { const d = $('sheet'); if (d.open) d.close(); d.innerHTML = ''; }

async function refreshPending() { try { S.pending = (await queue(refreshPending).counts()).pending; } catch { S.pending = 0; } chrome(); }
let syncTries = 0, syncTimer = null;
async function syncQueue() {
  clearTimeout(syncTimer);
  try {
    const r = await queue(refreshPending).sync(); await refreshPending();
    if (r.synced.length) { toast(`${r.synced.length} ${t('synced')}`, true); await loadAll(); }
    if (r.stopped && r.stopped !== 'auth' && S.pending) { syncTries += 1; syncTimer = setTimeout(syncQueue, Math.min(30_000, 2000 * syncTries)); } else syncTries = 0; // retry with backoff; items stay safely queued
  } catch { syncTimer = setTimeout(syncQueue, 5000); }
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, sku = el.dataset.sku;
  if (act === 'add' || act === 'inc') { S.cart = L.addOne(S.cart, sku); touchCart(); }
  else if (act === 'dec') { S.cart = L.addOne(S.cart, sku, -1); touchCart(); }
  else if (act === 'scan') openScan();
  else if (act === 'stopscan') closeScan();
  else if (act === 'findcode') { if (await findCode($('code').value)) $('code').value = ''; }
  else if (act === 'confirm') confirmSale();
  else if (act === 'addcust') {
    try { const c = await post('/api/customers', { name: $('nc-name').value, phone: $('nc-phone').value || undefined }); S.customers = [...S.customers, c]; S.customerId = String(c.id); $('creditbox').innerHTML = creditBox(); saleKey = null; }
    catch (err) { toast(errMsg(err)); }
  }
  else if (act === 'remind') remind(Number(el.dataset.i));
  else if (act === 'pay') payDialog(Number(el.dataset.i));
  else if (act === 'payfull') { $('pay-amt').value = (payFor.r.total / 100).toFixed(2); payPreview(); }
  else if (act === 'paysave') paySave();
  else if (act === 'closesheet') closeSheet();
  else if (act === 'print') window.print();
  else if (act === 'share') {
    const text = el.dataset.text;
    if (navigator.share) { try { await navigator.share({ title: t('receipt'), text }); } catch { /* cancelled */ } }
    else { try { await navigator.clipboard.writeText(text); toast(t('copied'), true); } catch { toast(t('copied')); } }
  }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'q') { S.q = e.target.value; paintGrid(); }
  else if (e.target.id === 'wq') { S.wordsQ = e.target.value; paintWords(); }
  else if (e.target.id === 'pay-amt') payPreview();
});
document.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'q') { e.preventDefault(); const exact = await findCode(e.target.value); if (exact) { S.q = ''; e.target.value = ''; paintGrid(); } }
  else if (e.target.id === 'code') { e.preventDefault(); if (await findCode(e.target.value)) e.target.value = ''; }
});
document.addEventListener('change', (e) => {
  if (e.target.name === 'method') { S.method = e.target.value; $('creditbox').hidden = S.method !== 'credit'; saleKey = null; }
  else if (e.target.id === 'cust') { S.customerId = e.target.value; saleKey = null; }
  else if (e.target.name === 'paym') payFor.key = newKey();
});
$('lang').addEventListener('click', () => { S.lang = S.lang === 'ar' ? 'en' : 'ar'; store.set('acct.lang', S.lang); render(); });
$('user').addEventListener('change', (e) => { setUser(e.target.value); store.set(modeKey(), 'simple'); S.cart = []; S.loaded = false; render(); loadAll(); });
$('full').addEventListener('click', () => { store.set(modeKey(), 'full'); });
$('sheet').addEventListener('close', () => { $('sheet').innerHTML = ''; });
window.addEventListener('hashchange', route);
window.addEventListener('online', () => { chrome(); syncQueue(); });
window.addEventListener('offline', chrome);

function route() {
  closeScan();
  const r = location.hash.replace(/^#\/?/, '') || 'today';
  S.route = ['today', 'sell', 'owed', 'words'].includes(r) ? r : 'today';
  render();
}

(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {}); // same worker as full mode: shell and API reads work offline
  await init();
  store.set(modeKey(), 'simple'); // this user's ui.mode: opens here next time (see public/modules/simple-mode.js)
  route();
  await loadAll();
  await refreshPending(); if (navigator.onLine !== false && S.pending) syncQueue();
  document.body.dataset.ready = '1';
})();
