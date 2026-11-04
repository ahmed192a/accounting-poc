// UI shell. Builds the App object (docs/ARCHITECTURE.md), imports every public/modules/*.js file listed
// by GET /api/ui-modules, and renders the cards they register. Owned by the UI shell owner: feature
// agents add a file under public/modules/ and never edit this one.

const T = {
  en: {
    title: 'Accounting PoC', user: 'Signed in as', role: 'Role', perms: 'permissions', nothing: 'Nothing here.',
    create: 'Create', amount: 'Amount (EGP)', date: 'Date', reason: 'Reason', saved: 'Done.', lang: 'العربية', ok: 'OK',
    noteBox: 'Proof of concept: demo identity switcher, mock ETA, in-memory data. Not for real accounting.',
  },
  ar: {
    title: 'نموذج أولي للمحاسبة', user: 'تسجيل الدخول باسم', role: 'الدور', perms: 'صلاحية', nothing: 'لا يوجد شيء.',
    create: 'إنشاء', amount: 'المبلغ (ج.م)', date: 'التاريخ', reason: 'السبب', saved: 'تم.', lang: 'English', ok: 'حسناً',
    noteBox: 'نموذج أولي: تبديل مستخدم تجريبي، ETA تجريبي، بيانات في الذاكرة. غير مخصص للمحاسبة الفعلية.',
  },
};

const state = { lang: 'en', userId: 3, users: [], home: null };

const t = (k) => T[state.lang][k] ?? T.en[k] ?? k;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const has = (p) => state.home.permissions.includes(p);
const loc = () => (state.lang === 'ar' ? 'ar-EG' : 'en-US');
const money = (p) => (p / 100).toLocaleString(loc(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (state.lang === 'ar' ? ' ج.م' : ' EGP');
const toPiastres = (v) => Math.round(Number(v) * 100);

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-user-id': String(state.userId) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) { const e = new Error(data.error?.message ?? 'Error'); e.code = data.error?.code; throw e; }
  return data;
}

let toastTimer;
function toast(msg, ok = false) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = ok ? 'ok' : 'err'; el.style.display = 'block';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.style.display = 'none'), 4500);
}

// Run an action; toast okMsg on success or the error message on failure; reload the home data and re-render.
async function run(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg, true); await load(); return r; }
  catch (e) { toast(e.message); }
}

// ---------- registries filled by the UI modules ----------
const cards = [];
const headerItems = [];
const footerItems = [];
const handlers = { click: {}, change: {}, input: {} };
const loadHooks = [];
const userChangeHooks = [];

const byOrder = (a, b) => (a.order - b.order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function addItem(list, kind, item) {
  if (!item || typeof item.id !== 'string' || typeof item.render !== 'function') throw new Error(`${kind} needs { id, render }`);
  if (list.some((c) => c.id === item.id)) throw new Error(`${kind} id "${item.id}" is already registered`);
  list.push({ order: 100, ...item });
}
function addHandler(kind, action, fn) {
  if (typeof action !== 'string' || typeof fn !== 'function') throw new Error(`App.${kind}(action, handler) needs a string and a function`);
  if (handlers[kind][action]) throw new Error(`data-act "${action}" already has a ${kind} handler`);
  handlers[kind][action] = fn;
}

const App = {
  state, api, run, toast, money, esc, has, t, loc, toPiastres,
  /** Register a dashboard card. area: 'stats' (top row) or 'main' (grid). render(home) returns an HTML string, '' to hide. */
  addCard(card) {
    if (!['stats', 'main'].includes(card?.area)) throw new Error(`Card "${card?.id}" needs area 'stats' or 'main'`);
    if (card.permission != null && typeof card.permission !== 'string' && typeof card.permission !== 'function') throw new Error(`Card "${card.id}": permission must be a string or a function`);
    addItem(cards, 'Card', card);
  },
  /** Items shown in the header after the language button / in the footer after the note. render(home) returns HTML. */
  addHeader: (item) => addItem(headerItems, 'Header item', item),
  addFooter: (item) => addItem(footerItems, 'Footer item', item),
  i18n: {
    /** Add strings for 'en' or 'ar'. Re-adding a key with different text is an error; identical text is fine. */
    add(lang, dict) {
      if (!T[lang]) throw new Error(`Unknown language "${lang}" (use 'en' or 'ar')`);
      for (const [k, v] of Object.entries(dict)) {
        if (k in T[lang] && T[lang][k] !== v) throw new Error(`i18n key "${k}" (${lang}) is already defined with different text`);
        T[lang][k] = v;
      }
    },
  },
  /** Click on an element with data-act="action". handler(element, event). */
  on: (action, fn) => addHandler('click', action, fn),
  /** 'change' event on an element with data-act="action". handler(element, event). */
  onChange: (action, fn) => addHandler('change', action, fn),
  /** 'input' event on an element with data-act="action". handler(element, event). */
  onInput: (action, fn) => addHandler('input', action, fn),
  /** After /api/home loads and before rendering: async hook(home) for fetching extra data. */
  onLoad: (fn) => loadHooks.push(fn),
  /** When the user switcher changes: hook() to reset per-user UI state. */
  onUserChange: (fn) => userChangeHooks.push(fn),
  reload: () => load(),
  render: () => render(),
};

// ---------- rendering ----------
const visible = (c, home) => c.permission == null || (typeof c.permission === 'string' ? home.permissions.includes(c.permission) : !!c.permission(home));
const renderList = (list, home) => list.filter((c) => visible(c, home)).sort(byOrder).map((c) => c.render(home)).join('');

function render() {
  const h = state.home;
  document.documentElement.lang = state.lang;
  document.documentElement.dir = state.lang === 'ar' ? 'rtl' : 'ltr';
  document.getElementById('title').textContent = t('title');
  document.getElementById('lbl-user').textContent = t('user');
  document.getElementById('lang').textContent = t('lang');
  document.getElementById('foot').innerHTML = `${esc(t('noteBox'))} ${renderList(footerItems, h)}`;
  const sel = document.getElementById('user');
  sel.innerHTML = state.users.map((u) => `<option value="${u.id}" ${u.id === state.userId ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
  document.getElementById('header-extra').innerHTML = renderList(headerItems, h);
  const stats = renderList(cards.filter((c) => c.area === 'stats'), h);
  const main = renderList(cards.filter((c) => c.area === 'main'), h);
  document.getElementById('main').innerHTML = `<div class="role-line">${t('role')}: <b>${esc(h.user.role)}</b> · ${h.permissions.length} ${t('perms')}</div>
    ${stats ? `<div class="stats">${stats}</div>` : ''}
    <div class="grid">${main}</div>`;
}

async function load() {
  state.home = await api('GET', '/api/home');
  for (const hook of loadHooks) await hook(state.home);
  render();
}

// ---------- events: one delegated listener per type; modules register by data-act name ----------
function dispatch(kind, e) {
  const el = e.target.closest?.('[data-act]');
  const fn = el && handlers[kind][el.dataset.act];
  if (fn) fn(el, e);
}
document.addEventListener('input', (e) => dispatch('input', e));
document.addEventListener('change', (e) => {
  if (e.target.id === 'user') {
    state.userId = Number(e.target.value);
    userChangeHooks.forEach((fn) => fn());
    run(async () => {});
    return;
  }
  dispatch('change', e);
});
document.addEventListener('click', (e) => {
  if (e.target.id === 'lang') { state.lang = state.lang === 'en' ? 'ar' : 'en'; return render(); }
  const b = e.target.closest('[data-act]');
  if (!b || b.tagName === 'SELECT') return;
  dispatch('click', e);
});

// ---------- boot ----------
(async () => {
  state.users = await (await fetch('/api/demo-users')).json();
  const files = await (await fetch('/api/ui-modules')).json();
  const loaded = await Promise.all(files.filter((f) => /^[\w.-]+\.js$/.test(f)).map(async (f) => {
    try { return { f, mod: await import('/modules/' + f) }; }
    catch (err) { console.error(`UI module ${f} failed to load:`, err); return null; }
  }));
  for (const m of loaded) {
    if (!m) continue;
    try { m.mod.default(App); } catch (err) { console.error(`UI module ${m.f} failed to register:`, err); }
  }
  await load();
})();
