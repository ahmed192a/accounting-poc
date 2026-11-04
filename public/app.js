// UI shell. Builds the App object (docs/ARCHITECTURE.md), imports every public/modules/*.js file listed
// by GET /api/ui-modules, and renders the navigation, pages and cards they register.
// Owned by the UI shell owner: feature agents add a file under public/modules/ and never edit this one.
// Pure logic lives in /lib/*.js (unit tested without a DOM); DOM primitives in /lib/ui.js.
import { esc, field, chip, emptyState, errorState, skeleton, table, cardTitle } from '/lib/html.js';
import { icon } from '/lib/icons.js';
import { formatMoney, formatNumber, formatDate, localeTag, parseAmountToPiastres, normalizeDigits } from '/lib/format.js';
import { parseHash, buildHash, resolveRoute } from '/lib/router.js';
import { buildPages, homeCards, fallbackTitle, splitBottomNav, isPageId } from '/lib/nav.js';
import { resolveTheme, nextPref, normalizePref } from '/lib/theme.js';
import { rank } from '/lib/search.js';
import { createShortcuts } from '/lib/shortcuts.js';
import { nextIndex } from '/lib/focus.js';
import { createToaster, openModal, confirmDialog, promptDialog, enhanceTables, modalDepth } from '/lib/ui.js';
import { registerDesignPage } from '/lib/design-page.js';

const T = {
  en: {
    title: 'Accounting PoC', user: 'Signed in as', role: 'Role', perms: 'permissions', nothing: 'Nothing here.',
    create: 'Create', amount: 'Amount (EGP)', date: 'Date', reason: 'Reason', saved: 'Done.', lang: 'العربية', ok: 'OK',
    noteBox: 'Proof of concept: demo identity switcher, mock ETA, in-memory data. Not for real accounting.',
    'sh.home': 'Home', 'sh.skip': 'Skip to content', 'sh.menu': 'Menu', 'sh.nav': 'Main navigation', 'sh.quickNav': 'Quick navigation',
    'sh.searchBtn': 'Search…', 'sh.searchLabel': 'Search pages, actions and cards', 'sh.searchHint': 'Type to search', 'sh.noResults': 'No results',
    'sh.themeToDark': 'Switch to dark theme', 'sh.themeToLight': 'Switch to light theme', 'sh.language': 'Language',
    'sh.account': 'Account menu', 'sh.signOut': 'Sign out', 'sh.digits': 'Digits', 'sh.digitsAuto': 'Automatic', 'sh.digitsLatn': 'Western (0123)', 'sh.digitsArab': 'Arabic-Indic (٠١٢٣)',
    'sh.close': 'Close', 'sh.dismiss': 'Dismiss', 'sh.cancel': 'Cancel', 'sh.confirm': 'Please confirm', 'sh.required': 'This field is required.',
    'sh.loadFailed': 'Could not load the data', 'sh.retry': 'Try again', 'sh.offline': 'You are offline. New quick sales, invoices, bills and customers are saved on this device and sent when you reconnect; everything else needs a connection. Figures shown may be out of date.',
    'sh.offlineShort': 'No connection. Nothing was saved.', 'sh.online': 'Back online.',
    'sh.notFound': 'Page not found', 'sh.notFoundText': 'This address does not match any page.', 'sh.noAccess': 'This page is not available for your role.',
    'sh.goHome': 'Go to Home', 'sh.homeEmpty': 'Nothing to show yet', 'sh.homeEmptyText': 'No cards are available for your role. Ask an administrator to review your permissions.',
    'sh.pageEmpty': 'This page has no content for your role.',
    'sh.authTitle': 'Sign-in required', 'sh.authNone': 'Your session needs a sign-in, but this build has no sign-in screen installed yet. Pick a demo user from the switcher or ask the administrator.',
    'sh.workspaces': 'Your workspaces',
    'sh.gPages': 'Pages', 'sh.gActions': 'Actions', 'sh.gCards': 'Cards', 'sh.go': 'Go to', 'sh.navigate': 'navigate', 'sh.select': 'select', 'sh.toClose': 'close',
    'sh.cmdTheme': 'Toggle light / dark theme', 'sh.cmdThemeSystem': 'Use the system theme', 'sh.cmdLang': 'Switch language (English / العربية)', 'sh.cmdNav': 'Collapse or expand the side menu',
    'sh.cmdHelp': 'Show keyboard shortcuts', 'sh.cmdReload': 'Reload data', 'sh.cmdInstall': 'Install the app', 'sh.cmdSignOut': 'Sign out',
    'sh.helpTitle': 'Keyboard shortcuts', 'sh.kPalette': 'Open the command palette', 'sh.kSearch': 'Search (same palette)', 'sh.kGo': 'Go to the Nth menu item (g then 1-9, g then h for Home)',
    'sh.kNav': 'Collapse or expand the side menu', 'sh.kHelp': 'Show this help', 'sh.kEsc': 'Close dialogs and menus',
    'sh.onTitle': 'Welcome, here is a quick start', 'sh.onHide': 'Hide this guide',
    'sh.on1': 'Use the menu to move between areas. Press Ctrl+K (or Cmd+K) to search pages, actions and cards.',
    'sh.onSales': 'Record your first sale or invoice in the Sales area.', 'sh.onTeam': 'Add your team and give each person only the access they need.',
    'sh.onInstall': 'Install this app on your phone or desktop for faster access.', 'sh.onInstallBtn': 'Install',
    'sh.onPhone': 'It works on phones: use the menu button at the top or the bar at the bottom.',
    'sh.onExport': 'Your data is yours: a full export is always available.',
    'sh.designTitle': 'Design system', 'sh.install': 'Install',
  },
  ar: {
    title: 'نموذج أولي للمحاسبة', user: 'تسجيل الدخول باسم', role: 'الدور', perms: 'صلاحية', nothing: 'لا يوجد شيء.',
    create: 'إنشاء', amount: 'المبلغ (ج.م)', date: 'التاريخ', reason: 'السبب', saved: 'تم.', lang: 'English', ok: 'حسناً',
    noteBox: 'نموذج أولي: تبديل مستخدم تجريبي، ETA تجريبي، بيانات في الذاكرة. غير مخصص للمحاسبة الفعلية.',
    'sh.home': 'الرئيسية', 'sh.skip': 'تخطَّ إلى المحتوى', 'sh.menu': 'القائمة', 'sh.nav': 'التنقل الرئيسي', 'sh.quickNav': 'تنقل سريع',
    'sh.searchBtn': 'بحث…', 'sh.searchLabel': 'ابحث في الصفحات والإجراءات والبطاقات', 'sh.searchHint': 'اكتب للبحث', 'sh.noResults': 'لا توجد نتائج',
    'sh.themeToDark': 'التبديل إلى المظهر الداكن', 'sh.themeToLight': 'التبديل إلى المظهر الفاتح', 'sh.language': 'اللغة',
    'sh.account': 'قائمة الحساب', 'sh.signOut': 'تسجيل الخروج', 'sh.digits': 'الأرقام', 'sh.digitsAuto': 'تلقائي', 'sh.digitsLatn': 'غربية (0123)', 'sh.digitsArab': 'عربية هندية (٠١٢٣)',
    'sh.close': 'إغلاق', 'sh.dismiss': 'إخفاء', 'sh.cancel': 'إلغاء', 'sh.confirm': 'يرجى التأكيد', 'sh.required': 'هذا الحقل مطلوب.',
    'sh.loadFailed': 'تعذّر تحميل البيانات', 'sh.retry': 'حاول مرة أخرى', 'sh.offline': 'أنت غير متصل. تُحفظ على هذا الجهاز عمليات البيع السريع والفواتير وفواتير الموردين والعملاء الجدد وتُرسل عند عودة الاتصال؛ أما بقية العمليات فتحتاج إلى اتصال. قد تكون الأرقام المعروضة قديمة.',
    'sh.offlineShort': 'لا يوجد اتصال. لم يتم حفظ شيء.', 'sh.online': 'عاد الاتصال.',
    'sh.notFound': 'الصفحة غير موجودة', 'sh.notFoundText': 'هذا العنوان لا يطابق أي صفحة.', 'sh.noAccess': 'هذه الصفحة غير متاحة لدورك.',
    'sh.goHome': 'الذهاب إلى الرئيسية', 'sh.homeEmpty': 'لا شيء لعرضه بعد', 'sh.homeEmptyText': 'لا توجد بطاقات متاحة لدورك. اطلب من المسؤول مراجعة صلاحياتك.',
    'sh.pageEmpty': 'لا يوجد محتوى لهذه الصفحة لدورك.',
    'sh.authTitle': 'تسجيل الدخول مطلوب', 'sh.authNone': 'جلستك تحتاج إلى تسجيل الدخول، لكن لا توجد شاشة دخول في هذا الإصدار بعد. اختر مستخدماً تجريبياً أو اطلب من المسؤول.',
    'sh.workspaces': 'مساحات عملك',
    'sh.gPages': 'الصفحات', 'sh.gActions': 'الإجراءات', 'sh.gCards': 'البطاقات', 'sh.go': 'الانتقال إلى', 'sh.navigate': 'تنقل', 'sh.select': 'اختيار', 'sh.toClose': 'إغلاق',
    'sh.cmdTheme': 'تبديل المظهر الفاتح / الداكن', 'sh.cmdThemeSystem': 'استخدام مظهر النظام', 'sh.cmdLang': 'تبديل اللغة (English / العربية)', 'sh.cmdNav': 'طيّ القائمة الجانبية أو توسيعها',
    'sh.cmdHelp': 'عرض اختصارات لوحة المفاتيح', 'sh.cmdReload': 'إعادة تحميل البيانات', 'sh.cmdInstall': 'تثبيت التطبيق', 'sh.cmdSignOut': 'تسجيل الخروج',
    'sh.helpTitle': 'اختصارات لوحة المفاتيح', 'sh.kPalette': 'فتح لوحة الأوامر', 'sh.kSearch': 'بحث (اللوحة نفسها)', 'sh.kGo': 'الانتقال إلى العنصر رقم N في القائمة (g ثم 1-9، وg ثم h للرئيسية)',
    'sh.kNav': 'طيّ القائمة الجانبية أو توسيعها', 'sh.kHelp': 'عرض هذه المساعدة', 'sh.kEsc': 'إغلاق النوافذ والقوائم',
    'sh.onTitle': 'مرحباً، إليك بداية سريعة', 'sh.onHide': 'إخفاء هذا الدليل',
    'sh.on1': 'استخدم القائمة للتنقل بين الأقسام. اضغط Ctrl+K (أو Cmd+K) للبحث في الصفحات والإجراءات والبطاقات.',
    'sh.onSales': 'سجّل أول عملية بيع أو فاتورة من قسم المبيعات.', 'sh.onTeam': 'أضف فريقك وامنح كل شخص الصلاحيات التي يحتاجها فقط.',
    'sh.onInstall': 'ثبّت التطبيق على هاتفك أو حاسوبك للوصول الأسرع.', 'sh.onInstallBtn': 'تثبيت',
    'sh.onPhone': 'يعمل على الهاتف: استخدم زر القائمة في الأعلى أو الشريط في الأسفل.',
    'sh.onExport': 'بياناتك ملكك: التصدير الكامل متاح دائماً.',
    'sh.designTitle': 'نظام التصميم', 'sh.install': 'تثبيت',
  },
};

// ---------- persisted preferences (storage may be blocked: fall back silently) ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const state = {
  lang: store.get('acct.lang') ?? ((globalThis.navigator?.language ?? 'en').toLowerCase().startsWith('ar') ? 'ar' : 'en'),
  userId: 3, users: [], home: null,
  digits: normalizeDigits(store.get('acct.digits')),
  themePref: normalizePref(store.get('acct.theme')),
};
if (state.lang !== 'ar') state.lang = 'en';

const t = (k) => T[state.lang][k] ?? T.en[k] ?? k;
const has = (p) => state.home?.permissions.includes(p) ?? false;
const loc = () => localeTag(state.lang, state.digits);
const money = (p) => formatMoney(p, state.lang, state.digits);
const toPiastres = (v) => parseAmountToPiastres(v);

// ---------- api: same-origin credentials, optional CSRF token, 401 AUTH_REQUIRED -> login screen ----------
async function api(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (state.users.length) headers['x-user-id'] = String(state.userId); // demo identity switcher only
  if (App.csrfToken && method !== 'GET' && method !== 'HEAD') headers['x-csrf-token'] = App.csrfToken;
  const idemKey = App.offlineKey?.(method, path); // offline module: Idempotency-Key for queueable writes, so a retry/replay never double-posts
  if (idemKey) headers['idempotency-key'] = idemKey;
  let res;
  try {
    res = await fetch(path, { method, headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined });
  } catch {
    const queued = idemKey && App.offlineWrite ? await App.offlineWrite(method, path, body, idemKey) : null; // saved on this device, sent when back online
    if (queued) return queued;
    const e = new Error(t('sh.offlineShort')); e.code = 'NETWORK'; throw e;
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!res.ok) {
    const e = new Error(data.error?.message ?? `Error ${res.status}`); e.code = data.error?.code; e.status = res.status;
    if (res.status === 401 && e.code === 'AUTH_REQUIRED') showLogin();
    throw e;
  }
  return data;
}

const toastEl = () => document.getElementById('toast');
let toaster;
function toast(msg, ok = false) { (toaster ??= createToaster(toastEl(), { dismissLabel: () => t('sh.dismiss') }))(msg, ok); }

// Run an action; toast okMsg on success or the error message on failure; reload the home data and re-render.
async function run(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg, true); await load(); return r; }
  catch (e) { if (e.code !== 'AUTH_REQUIRED') toast(e.message); }
}

// ---------- registries filled by the UI modules ----------
const cards = [];
const headerItems = [];
const footerItems = [];
const fullPages = [];
const commands = [];
const handlers = { click: {}, change: {}, input: {} };
const loadHooks = [];
const userChangeHooks = [];
let loginFn = null;

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
const permOk = (perm, home) => perm == null || (typeof perm === 'string' ? home.permissions.includes(perm) : !!perm(home));

const App = {
  state, api, run, toast, money, esc, has, t, loc, toPiastres,
  /** Set by the security module after sign-in: sent as x-csrf-token on non-GET requests. */
  csrfToken: null,
  /** Register a dashboard card. area: 'stats' (top row) or 'main' (grid). Optional page / pageTitleKey group it on page #/<page>; wide:true spans the grid. */
  addCard(card) {
    if (!['stats', 'main'].includes(card?.area)) throw new Error(`Card "${card?.id}" needs area 'stats' or 'main'`);
    if (card.permission != null && typeof card.permission !== 'string' && typeof card.permission !== 'function') throw new Error(`Card "${card.id}": permission must be a string or a function`);
    if (card.page != null && !isPageId(String(card.page))) throw new Error(`Card "${card.id}": page must be lowercase letters, digits, - or _`);
    addItem(cards, 'Card', card);
  },
  /** Register a full page at #/<id>. render(home) returns HTML. Optional: permission, nav:false (hide from menu), icon. */
  addPage(page) {
    if (!page || !isPageId(page.id) || typeof page.render !== 'function' || !page.titleKey) throw new Error('Page needs { id, titleKey, render } (id: lowercase letters, digits, - or _)');
    if (page.id === 'home') throw new Error('Page id "home" is reserved');
    if (page.permission != null && typeof page.permission !== 'string' && typeof page.permission !== 'function') throw new Error(`Page "${page.id}": permission must be a string or a function`);
    addItem(fullPages, 'Page', page);
  },
  /** Command palette entry: { id, title | titleKey, keywords?, hint?, icon?, permission?, run() }. */
  addCommand(cmd) {
    if (!cmd || typeof cmd.id !== 'string' || typeof cmd.run !== 'function' || !(cmd.title || cmd.titleKey)) throw new Error('Command needs { id, title|titleKey, run }');
    if (commands.some((c) => c.id === cmd.id)) throw new Error(`Command id "${cmd.id}" is already registered`);
    commands.push({ order: 100, ...cmd });
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
  // ----- navigation, dialogs, auth plumbing, design-system helpers -----
  /** Go to a page id ('home' or a registered page): sets the hash so back/forward work. */
  navigate: (id, rest = []) => { location.hash = buildHash(id, rest); },
  /** Replaces window.confirm. confirm({ title, message, confirmLabel, cancelLabel, danger }) -> Promise<boolean>. */
  confirm: (opts = {}) => confirmDialog(opts, dialogLabels()),
  /** Replaces window.prompt. prompt({ title, message, label, value, type, required, validate(v)->error|'' }) -> Promise<string|null>. */
  prompt: (opts = {}) => promptDialog(opts, dialogLabels()),
  /** Open a custom accessible modal (focus trap, Escape, restores focus). See /lib/ui.js openModal. */
  modal: (opts) => openModal(opts),
  /** Register the sign-in screen: fn(App) returns HTML. Shown on 401 AUTH_REQUIRED. */
  setLoginScreen(fn) { if (typeof fn !== 'function') throw new Error('setLoginScreen(fn) needs a function'); loginFn = fn; if (loginVisible) showLogin(true); },
  /** Call after a successful sign-in: hides the login screen and reloads the data. */
  async loginDone() { hideLogin(); state.home = null; await load(); },
  showLogin: () => showLogin(true),
  /** Optional: the auth module may set App.signOut = async () => {...}; the account menu then offers "Sign out". */
  signOut: undefined,
  ui: { field, chip, emptyState, errorState, skeleton, table, icon },
  fmt: { number: (n, o) => formatNumber(n, state.lang, state.digits, o), date: (d, o) => formatDate(d, state.lang, state.digits, o) },
};
const dialogLabels = () => ({ ok: t('ok'), cancel: t('sh.cancel'), confirm: t('sh.confirm'), required: t('sh.required') });

// ---------- login screen ----------
let loginVisible = false;
function showLogin(force = false) {
  if (loginVisible && !force) return;
  loginVisible = true;
  const root = document.getElementById('login');
  let html;
  try { html = loginFn ? loginFn(App) : ''; } catch (e) { console.error('Login screen failed to render:', e); html = ''; }
  root.innerHTML = `<div class="login-screen"><div class="login-box">${html || `<h1>${esc(t('sh.authTitle'))}</h1><p>${esc(t('sh.authNone'))}</p>`}</div></div>`;
  root.hidden = false; document.getElementById('app').hidden = true;
  if (!force || !root.contains(document.activeElement)) (root.querySelector('input,button,a[href]') ?? root).focus?.();
}
function hideLogin() { loginVisible = false; document.getElementById('login').hidden = true; document.getElementById('login').innerHTML = ''; document.getElementById('app').hidden = false; }

// ---------- derived view model ----------
let entries = []; // visible, non-empty cards with their html
let pages = [];   // built from entries + full pages
let installPrompt = null;

function computeEntries(home) {
  const out = [];
  for (const c of [...cards].sort(byOrder)) {
    if (!permOk(c.permission, home)) continue;
    let html;
    try { html = c.render(home); }
    catch (err) { console.error(`Card ${c.id} failed to render:`, err); html = `<div class="card card-error"><h2>${esc(c.id)}</h2><div class="note bad">${esc(String(err?.message ?? err))}</div></div>`; }
    if (typeof html !== 'string' || !html.trim()) continue;
    out.push({ card: c, html, title: cardTitle(html) });
  }
  return out;
}
function computePages(home) {
  const fp = fullPages.map((p) => ({ id: p.id, titleKey: p.titleKey, order: p.order, nav: p.nav, allowed: permOk(p.permission, home) }));
  return buildPages(entries.map((e) => ({ id: e.card.id, page: e.card.page, pageTitleKey: e.card.pageTitleKey, order: e.card.order })), fp);
}
const pageTitle = (p) => (p.titleKey ? t(p.titleKey) : fallbackTitle(p.id));
const routeNow = () => parseHash(location.hash);

// ---------- rendering ----------
const $ = (id) => document.getElementById(id);
const navItems = () => [{ id: 'home', title: t('sh.home'), href: '#/' }, ...pages.filter((p) => p.nav).map((p) => ({ id: p.id, title: pageTitle(p), href: buildHash(p.id) }))];

function applyTheme() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = resolveTheme(state.themePref, dark);
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme === 'dark' ? '#161d27' : '#ffffff');
  const b = $('theme');
  if (b) { b.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon'); const l = t(theme === 'dark' ? 'sh.themeToLight' : 'sh.themeToDark'); b.setAttribute('aria-label', l); b.title = l; }
}
function setThemePref(pref) { state.themePref = normalizePref(pref); store.set('acct.theme', state.themePref); applyTheme(); }
function toggleTheme() { setThemePref(nextPref(state.themePref, matchMedia('(prefers-color-scheme: dark)').matches)); }

function renderChrome(current) {
  const h = state.home;
  document.documentElement.lang = state.lang;
  document.documentElement.dir = state.lang === 'ar' ? 'rtl' : 'ltr';
  $('title').textContent = t('title');
  $('lbl-user').textContent = t('user');
  $('lang').textContent = t('lang'); $('lang').title = t('sh.language');
  $('skip').textContent = t('sh.skip');
  $('searchText').textContent = t('sh.searchBtn');
  $('search').setAttribute('aria-label', t('sh.searchLabel'));
  $('navToggle').setAttribute('aria-label', t('sh.menu'));
  $('nav').setAttribute('aria-label', t('sh.nav'));
  $('bottomnav').setAttribute('aria-label', t('sh.quickNav'));
  $('userMenuBtn').setAttribute('aria-label', t('sh.account'));
  $('userMenuBtn').innerHTML = icon('user');
  $('banner').textContent = navigator.onLine === false ? t('sh.offline') : '';
  $('banner').hidden = navigator.onLine !== false;
  const sel = $('user');
  sel.innerHTML = state.users.map((u) => `<option value="${u.id}" ${u.id === state.userId ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
  sel.closest('label').hidden = !state.users.length;
  $('header-extra').innerHTML = renderListSafe(headerItems, h);
  $('foot').innerHTML = `${esc(t('noteBox'))} ${renderListSafe(footerItems, h)}`;
  const items = navItems();
  $('nav').innerHTML = `<ul class="nav-list">${items.map((i) => `<li><a class="nav-link" href="${esc(i.href)}" title="${esc(i.title)}"${i.id === current ? ' aria-current="page"' : ''}>${icon(i.id === 'home' ? 'home' : i.id)}<span class="nav-label">${esc(i.title)}</span></a></li>`).join('')}</ul>`;
  const { bar, more } = splitBottomNav(items, 5);
  $('bottomnav').innerHTML = bar.map((i) => `<a href="${esc(i.href)}"${i.id === current ? ' aria-current="page"' : ''}>${icon(i.id === 'home' ? 'home' : i.id)}<span>${esc(i.title)}</span></a>`).join('')
    + (more.length ? `<button type="button" data-sh="nav-open" aria-label="${esc(t('sh.menu'))}">${icon('more')}<span>${esc(t('sh.menu'))}</span></button>` : '');
  renderUserMenu();
  syncNavToggle();
  applyTheme();
}
function renderListSafe(list, home) {
  if (!home) return "";
  return list.filter((c) => permOk(c.permission, home)).sort(byOrder).map((c) => { try { return c.render(home); } catch (e) { console.error(`${c.id} failed:`, e); return ''; } }).join('');
}
function renderUserMenu() {
  const u = state.home?.user;
  $('userMenu').innerHTML = `<div class="menu-head"><b>${esc(u?.name ?? '')}</b><span class="sub">${esc(u?.role ?? '')}</span></div>
    <label>${esc(t('sh.digits'))} <select data-sh-change="digits" aria-label="${esc(t('sh.digits'))}"><option value="auto">${esc(t('sh.digitsAuto'))}</option><option value="latn">${esc(t('sh.digitsLatn'))}</option><option value="arab">${esc(t('sh.digitsArab'))}</option></select></label>
    ${installPrompt ? `<button type="button" data-sh="install">${icon('download')}${esc(t('sh.install'))}</button>` : ''}
    ${typeof App.signOut === 'function' ? `<button type="button" data-sh="signout">${esc(t('sh.signOut'))}</button>` : ''}`;
  const d = $('userMenu').querySelector('select'); if (d) d.value = state.digits;
}
function syncNavToggle() {
  const phone = matchMedia('(max-width:767px)').matches;
  const open = phone ? document.body.classList.contains('nav-open') : !document.body.classList.contains('nav-collapsed');
  $('navToggle').setAttribute('aria-expanded', String(open));
}

const cardSlot = (e) => `<div class="card-slot${e.card.wide ? ' slot-wide' : ''}" data-card-id="${esc(e.card.id)}">${e.html}</div>`;
const section = (list, area) => list.filter((e) => e.card.area === area).map(cardSlot).join('');

function stepsHtml() {
  const link = (id, text) => (pages.some((p) => p.id === id) ? `<a href="${buildHash(id)}">${esc(text)}</a>` : esc(text));
  const steps = [esc(t('sh.on1'))];
  if (has('sales.create')) steps.push(link('sales', t('sh.onSales')));
  if (has('users.manage')) steps.push(link('admin', t('sh.onTeam')));
  steps.push(installPrompt ? `${esc(t('sh.onInstall'))} <button type="button" class="small" data-sh="install">${esc(t('sh.onInstallBtn'))}</button>` : esc(t('sh.onPhone')));
  if (has('export.all')) steps.push(esc(t('sh.onExport')));
  return steps.map((s) => `<li>${s}</li>`).join('');
}
function onboardingHtml() {
  if (store.get(`acct.onboard.${state.userId}`) === 'hidden') return '';
  return `<section class="card onboard" aria-label="${esc(t('sh.onTitle'))}"><div class="onboard-head">${icon('info')}<strong role="heading" aria-level="2">${esc(t('sh.onTitle'))}</strong>
    <button type="button" class="small ghost push-end" data-sh="onboard-hide" >${esc(t('sh.onHide'))}</button></div><ol>${stepsHtml()}</ol></section>`;
}

function mainHtml(route) {
  const h = state.home;
  if (!h) return skeleton({ cards: 4 });
  const resolved = resolveRoute(route, pages.map((p) => p.id));
  if (resolved.kind === 'home') {
    const list = entries.filter((e) => e.card.page == null);
    const tiles = pages.filter((p) => p.nav);
    const body = `<div class="role-line">${t('role')}: <b>${esc(h.user.role)}</b> · ${h.permissions.length} ${t('perms')}</div>
      ${onboardingHtml()}
      ${section(list, 'stats') ? `<div class="stats">${section(list, 'stats')}</div>` : ''}
      ${section(list, 'main') ? `<div class="grid">${section(list, 'main')}</div>` : (tiles.length ? '' : emptyState({ title: t('sh.homeEmpty'), text: t('sh.homeEmptyText') }))}
      ${tiles.length ? `<h2 class="section-title">${esc(t('sh.workspaces'))}</h2><nav class="tiles" aria-label="${esc(t('sh.workspaces'))}">${tiles.map((p) => `<a class="tile" href="${buildHash(p.id)}">${icon(p.id)}${esc(pageTitle(p))}</a>`).join('')}</nav>` : ''}`;
    return `<div class="page-head"><h1 tabindex="-1" id="page-h1">${esc(t('sh.home'))}</h1></div>${body}`;
  }
  if (resolved.kind === 'page') {
    const p = pages.find((x) => x.id === resolved.id);
    const fp = fullPages.find((x) => x.id === p.id);
    let custom = '';
    if (fp) { try { custom = fp.render(h) || ''; } catch (err) { console.error(`Page ${fp.id} failed to render:`, err); custom = errorState({ title: t('sh.loadFailed'), text: String(err?.message ?? err) }); } }
    const list = entries.filter((e) => e.card.page === p.id);
    const body = `${custom}${section(list, 'stats') ? `<div class="stats">${section(list, 'stats')}</div>` : ''}${section(list, 'main') ? `<div class="grid">${section(list, 'main')}</div>` : ''}`;
    return `<div class="page-head"><h1 tabindex="-1" id="page-h1">${esc(pageTitle(p))}</h1></div>${body || emptyState({ title: t('sh.pageEmpty') })}`;
  }
  // not a known page: distinguish "exists for others" is not knowable here; both are shown as unavailable
  const known = fullPages.some((p) => p.id === route.id) || cards.some((c) => String(c.page) === route.id);
  return `<div class="page-head"><h1 tabindex="-1" id="page-h1">${esc(t(known ? 'sh.noAccess' : 'sh.notFound'))}</h1></div>`
    + emptyState({ title: t(known ? 'sh.noAccess' : 'sh.notFound'), text: known ? '' : t('sh.notFoundText'), action: { href: '#/', label: t('sh.goHome') } });
}

let lastRouteKey = null;
let pendingCard = null;
let renderTimer = 0;

function render() {
  if (loginVisible) return;
  const route = routeNow();
  const main = $('main');
  const y = window.scrollY;
  const active = document.activeElement;
  const activeId = active && main.contains(active) ? active.id : '';
  const sel = activeId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  if (state.home) { entries = computeEntries(state.home); pages = computePages(state.home); } else { entries = []; pages = []; }
  const resolved = resolveRoute(route, pages.map((p) => p.id));
  renderChrome(resolved.kind === 'home' ? 'home' : resolved.kind === 'page' ? resolved.id : '');
  main.innerHTML = mainHtml(route);
  enhanceTables(main);
  const key = location.hash;
  const navigated = lastRouteKey !== null && lastRouteKey !== key;
  const first = lastRouteKey === null;
  lastRouteKey = key;
  const h1 = $('page-h1');
  document.title = `${h1 ? h1.textContent + ' - ' : ''}${t('title')}`;
  if (navigated) { window.scrollTo(0, 0); h1?.focus({ preventScroll: true }); document.body.classList.remove('nav-open'); }
  else {
    window.scrollTo(0, first ? 0 : y);
    if (activeId) { const el = document.getElementById(activeId); if (el && el !== document.activeElement) { el.focus({ preventScroll: true }); if (sel && 'setSelectionRange' in el) try { el.setSelectionRange(...sel); } catch { /* not selectable */ } } }
  }
  if (pendingCard) { const slot = main.querySelector(`[data-card-id="${CSS.escape(pendingCard)}"]`); pendingCard = null; const c = slot?.firstElementChild; if (c) { c.scrollIntoView({ block: 'center' }); c.classList.add('card-flash'); setTimeout(() => c.classList.remove('card-flash'), 1800); } }
}

async function load() {
  if (!state.home) { $('main').innerHTML = skeleton({ cards: 4 }); }
  try {
    const home = await api('GET', '/api/home');
    for (const hook of loadHooks) await hook(home);
    state.home = home;
    render();
  } catch (e) {
    if (e.code === 'AUTH_REQUIRED') return;
    if (!state.home) {
      $('main').innerHTML = errorState({ title: t('sh.loadFailed'), text: e.message, retryLabel: t('sh.retry'), retryAct: 'retry' });
    }
    throw e;
  }
}

// ---------- command palette + global search ----------
function paletteItems() {
  const items = [];
  for (const i of navItems().concat(pages.filter((p) => !p.nav).map((p) => ({ id: p.id, title: pageTitle(p), href: buildHash(p.id) })))) {
    items.push({ group: 'sh.gPages', id: 'page:' + i.id, title: i.title, hint: '', icon: i.id === 'home' ? 'home' : i.id, run: () => { location.hash = i.href; } });
  }
  const builtin = [
    { id: 'theme', title: t('sh.cmdTheme'), icon: 'moon', run: toggleTheme, keywords: ['dark', 'light', 'theme', 'مظهر', 'داكن'] },
    { id: 'theme-system', title: t('sh.cmdThemeSystem'), icon: 'sun', run: () => setThemePref('system'), keywords: ['system', 'auto'] },
    { id: 'lang', title: t('sh.cmdLang'), icon: 'generic', run: toggleLang, keywords: ['arabic', 'english', 'language', 'rtl', 'عربي'] },
    { id: 'nav', title: t('sh.cmdNav'), icon: 'menu', run: toggleNav, keywords: ['sidebar', 'menu'] },
    { id: 'help', title: t('sh.cmdHelp'), icon: 'keyboard', hint: '?', run: showHelp, keywords: ['keys', 'shortcuts'] },
    { id: 'reload', title: t('sh.cmdReload'), icon: 'download', run: () => run(async () => {}), keywords: ['refresh'] },
  ];
  if (installPrompt) builtin.push({ id: 'install', title: t('sh.cmdInstall'), icon: 'download', run: doInstall });
  if (typeof App.signOut === 'function') builtin.push({ id: 'signout', title: t('sh.cmdSignOut'), icon: 'user', run: doSignOut });
  for (const c of [...builtin, ...commands.filter((c) => permOk(c.permission, state.home ?? { permissions: [] })).sort(byOrder)]) {
    items.push({ group: 'sh.gActions', id: 'cmd:' + c.id, title: c.title ?? t(c.titleKey), keywords: c.keywords ?? [], hint: c.hint ?? '', icon: c.icon ?? 'generic', run: c.run });
  }
  for (const e of entries) {
    if (!e.title) continue;
    const pid = e.card.page != null ? String(e.card.page) : 'home';
    items.push({ group: 'sh.gCards', id: 'card:' + e.card.id, title: e.title, hint: pid === 'home' ? t('sh.home') : (pages.find((p) => p.id === pid) ? pageTitle(pages.find((p) => p.id === pid)) : ''), icon: pid === 'home' ? 'home' : pid,
      run: () => { pendingCard = e.card.id; if (location.hash === buildHash(pid)) render(); else location.hash = buildHash(pid); } });
  }
  return items;
}
function openPalette() {
  if (!state.home || loginVisible) return;
  const all = paletteItems();
  let shown = []; let sel = 0;
  const ctl = openModal({
    className: 'palette', raw: true, ariaLabel: t('sh.searchLabel'),
    bodyHtml: `<div class="palette-input">${icon('search')}<input id="sh-pal-in" type="text" role="combobox" aria-expanded="true" aria-controls="sh-pal-list" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="${esc(t('sh.searchLabel'))}" aria-label="${esc(t('sh.searchLabel'))}"></div>
      <ul class="palette-list" id="sh-pal-list" role="listbox" aria-label="${esc(t('sh.searchLabel'))}"></ul>
      <div class="palette-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> ${esc(t('sh.navigate'))}</span><span><kbd>Enter</kbd> ${esc(t('sh.select'))}</span><span><kbd>Esc</kbd> ${esc(t('sh.toClose'))}</span></div>`,
    onOpen(el) {
      const input = el.querySelector('input'); const list = el.querySelector('ul');
      const paint = () => {
        const q = input.value.trim();
        shown = q ? rank(all, q, (i) => [i.title, ...(i.keywords ?? [])]) : all.filter((i) => i.group !== 'sh.gCards');
        sel = Math.min(sel, Math.max(shown.length - 1, 0));
        let g = ''; let html = '';
        shown.slice(0, 40).forEach((i, n) => {
          if (i.group !== g) { g = i.group; html += `<li role="presentation" class="palette-group">${esc(t(g))}</li>`; }
          html += `<li role="option" id="sh-pal-${n}" class="palette-item" data-i="${n}" aria-selected="${n === sel}">${icon(i.icon, { size: 18 })}<span>${esc(i.title)}</span>${i.hint ? `<span class="hint">${esc(i.hint)}</span>` : ''}</li>`;
        });
        list.innerHTML = html || `<li role="presentation" class="palette-empty">${esc(t('sh.noResults'))}</li>`;
        input.setAttribute('aria-activedescendant', shown.length ? `sh-pal-${sel}` : '');
        list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
      };
      const choose = (n) => { const it = shown[n]; if (!it) return; ctl.close(); setTimeout(it.run, 0); };
      input.addEventListener('input', () => { sel = 0; paint(); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = nextIndex(sel, Math.min(shown.length, 40), e.key === 'ArrowUp'); paint(); }
        else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
        else if (e.key === 'Home' && !input.value) { sel = 0; paint(); }
      });
      list.addEventListener('mousemove', (e) => { const li = e.target.closest('[data-i]'); if (li && Number(li.dataset.i) !== sel) { sel = Number(li.dataset.i); paint(); } });
      list.addEventListener('click', (e) => { const li = e.target.closest('[data-i]'); if (li) choose(Number(li.dataset.i)); });
      paint();
    },
  });
}
function showHelp() {
  const k = (keys, text) => `<tr><td>${keys.map((x) => `<kbd>${x}</kbd>`).join(' ')}</td><td>${esc(text)}</td></tr>`;
  openModal({
    title: t('sh.helpTitle'), actions: [{ label: t('sh.close'), value: true, primary: true }],
    bodyHtml: `<table class="kbd-table">${k(['Ctrl/Cmd', 'K'], t('sh.kPalette'))}${k(['/'], t('sh.kSearch'))}${k(['g', '1-9'], t('sh.kGo'))}${k(['['], t('sh.kNav'))}${k(['?'], t('sh.kHelp'))}${k(['Esc'], t('sh.kEsc'))}</table>`,
  });
}

// ---------- shell actions ----------
function toggleLang() { state.lang = state.lang === 'en' ? 'ar' : 'en'; store.set('acct.lang', state.lang); render(); }
function toggleNav() {
  if (matchMedia('(max-width:767px)').matches) document.body.classList.toggle('nav-open');
  else if (matchMedia('(max-width:1023px)').matches) document.body.classList.toggle('nav-open');
  else { document.body.classList.toggle('nav-collapsed'); store.set('acct.nav', document.body.classList.contains('nav-collapsed') ? 'collapsed' : 'open'); }
  syncNavToggle();
}
async function doInstall() { const p = installPrompt; installPrompt = null; if (!p) return; p.prompt(); await p.userChoice.catch(() => {}); render(); }
async function doSignOut() { try { await App.signOut(); } catch (e) { toast(e.message); } state.home = null; try { await load(); } catch { /* login screen or error state shows */ } }
function closeUserMenu() { const m = $('userMenu'); if (!m.hidden) { m.hidden = true; $('userMenuBtn').setAttribute('aria-expanded', 'false'); } }

const shellActions = {
  lang: toggleLang,
  theme: toggleTheme,
  palette: openPalette,
  'nav-toggle': toggleNav,
  'nav-open': () => { document.body.classList.add('nav-open'); syncNavToggle(); $('nav').querySelector('a')?.focus(); },
  'nav-close': () => { document.body.classList.remove('nav-open'); syncNavToggle(); },
  'user-menu': () => { const m = $('userMenu'); m.hidden = !m.hidden; $('userMenuBtn').setAttribute('aria-expanded', String(!m.hidden)); if (!m.hidden) m.querySelector('select,button')?.focus(); },
  signout: () => { closeUserMenu(); doSignOut(); },
  install: () => { closeUserMenu(); doInstall(); },
  retry: () => load().catch(() => {}),
  'onboard-hide': () => { store.set(`acct.onboard.${state.userId}`, 'hidden'); render(); },
  skip: (el, e) => { e.preventDefault(); $('page-h1')?.focus(); $('main').focus(); },
};
App.shellActions = shellActions; // design page registers its demo actions here (internal)

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
  if (e.target.dataset?.shChange === 'digits') { state.digits = normalizeDigits(e.target.value); store.set('acct.digits', state.digits); render(); return; }
  dispatch('change', e);
});
document.addEventListener('click', (e) => {
  const sh = e.target.closest?.('[data-sh]');
  if (sh && shellActions[sh.dataset.sh]) { shellActions[sh.dataset.sh](sh, e); return; }
  if (!e.target.closest('.menu-wrap')) closeUserMenu();
  if (e.target.closest('.sidenav a') || e.target.closest('.drawer-scrim')) document.body.classList.remove('nav-open');
  const b = e.target.closest('[data-act]');
  if (!b || b.tagName === 'SELECT') return;
  dispatch('click', e);
});
const shortcuts = createShortcuts();
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('userMenu').hidden) { closeUserMenu(); $('userMenuBtn').focus(); return; }
    if (document.body.classList.contains('nav-open')) { document.body.classList.remove('nav-open'); syncNavToggle(); return; }
  }
  const tg = e.target;
  const typing = !!tg && (tg.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName));
  const r = shortcuts.handle({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, typing }, performance.now());
  if (!r) return;
  if (r.action === 'palette') {
    e.preventDefault();
    if (modalDepth() && e.target.closest?.('.palette')) document.querySelector('.palette')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    else if (!modalDepth()) openPalette();
    return;
  }
  if (modalDepth()) return;
  if (r.action === 'help') showHelp();
  else if (r.action === 'toggleNav') toggleNav();
  else if (r.action === 'goto') { const it = navItems()[r.index]; if (it) location.hash = it.href; }
});
window.addEventListener('hashchange', () => { if (state.home) render(); });
window.addEventListener('online', () => { $('banner').hidden = true; toast(t('sh.online'), true); });
window.addEventListener('offline', () => { $('banner').textContent = t('sh.offline'); $('banner').hidden = false; });
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; if (state.home) render(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---------- boot ----------
registerDesignPage(App, { t });
(async () => {
  document.body.classList.toggle('nav-collapsed', store.get('acct.nav') === 'collapsed');
  renderChrome('');
  try { const r = await fetch('/api/demo-users', { credentials: 'same-origin' }); state.users = r.ok ? await r.json() : []; } catch { state.users = []; }
  if (!Array.isArray(state.users)) state.users = [];
  let files = [];
  try { files = await (await fetch('/api/ui-modules', { credentials: 'same-origin' })).json(); } catch (err) { console.warn('Could not list UI modules:', err); }
  const loaded = await Promise.all(files.filter((f) => /^[\w.-]+\.js$/.test(f)).map(async (f) => {
    try { return { f, mod: await import('/modules/' + f) }; }
    catch (err) { console.error(`UI module ${f} failed to load:`, err); return null; }
  }));
  for (const m of loaded) {
    if (!m) continue;
    try { m.mod.default(App); } catch (err) { console.error(`UI module ${m.f} failed to register:`, err); }
  }
  try { await load(); } catch { /* error state is on screen */ }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker not registered:', err.message));
})();
