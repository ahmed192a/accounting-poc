// Chrome: theme, top bar, side and bottom navigation, account menu.
import { esc } from '/lib/html.js';
import { icon } from '/lib/icons.js';
import { splitBottomNav } from '/lib/nav.js';
import { resolveTheme, nextPref, normalizePref } from '/lib/theme.js';
import { state, store } from '/core/state.js';
import { t } from '/core/i18n.js';
import { App, view, $ } from '/core/host.js';
import { headerItems, footerItems, byOrder, permOk } from '/core/registry.js';
import { navItems } from '/core/view.js';

export function applyTheme() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = resolveTheme(state.themePref, dark);
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme === 'dark' ? '#161d27' : '#ffffff');
  const b = $('theme');
  if (b) { b.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon'); const l = t(theme === 'dark' ? 'sh.themeToLight' : 'sh.themeToDark'); b.setAttribute('aria-label', l); b.title = l; }
}
export function setThemePref(pref) { state.themePref = normalizePref(pref); store.set('acct.theme', state.themePref); applyTheme(); }
export function toggleTheme() { setThemePref(nextPref(state.themePref, matchMedia('(prefers-color-scheme: dark)').matches)); }

export function renderChrome(current) {
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
export function renderListSafe(list, home) {
  if (!home) return "";
  return list.filter((c) => permOk(c.permission, home)).sort(byOrder).map((c) => { try { return c.render(home); } catch (e) { console.error(`${c.id} failed:`, e); return ''; } }).join('');
}
export function renderUserMenu() {
  const u = state.home?.user;
  $('userMenu').innerHTML = `<div class="menu-head"><b>${esc(u?.name ?? '')}</b><span class="sub">${esc(u?.role ?? '')}</span></div>
    <label>${esc(t('sh.digits'))} <select data-sh-change="digits" aria-label="${esc(t('sh.digits'))}"><option value="auto">${esc(t('sh.digitsAuto'))}</option><option value="latn">${esc(t('sh.digitsLatn'))}</option><option value="arab">${esc(t('sh.digitsArab'))}</option></select></label>
    ${view.installPrompt ? `<button type="button" data-sh="install">${icon('download')}${esc(t('sh.install'))}</button>` : ''}
    ${typeof App.signOut === 'function' ? `<button type="button" data-sh="signout">${esc(t('sh.signOut'))}</button>` : ''}`;
  const d = $('userMenu').querySelector('select'); if (d) d.value = state.digits;
}
export function syncNavToggle() {
  const phone = matchMedia('(max-width:767px)').matches;
  const open = phone ? document.body.classList.contains('nav-open') : !document.body.classList.contains('nav-collapsed');
  $('navToggle').setAttribute('aria-expanded', String(open));
}
