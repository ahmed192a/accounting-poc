// Shell actions: language, nav drawer, install, sign-out, and the data-sh action table.
import { store, state } from '/core/state.js';
import { App, view, $ } from '/core/host.js';
import { toast, load } from '/core/load.js';
import { render } from '/core/router.js';
import { toggleTheme, syncNavToggle } from '/ui/chrome.js';
import { openPalette } from '/ui/palette.js';

export function toggleLang() { state.lang = state.lang === 'en' ? 'ar' : 'en'; store.set('acct.lang', state.lang); render(); }
export function toggleNav() {
  if (matchMedia('(max-width:767px)').matches) document.body.classList.toggle('nav-open');
  else if (matchMedia('(max-width:1023px)').matches) document.body.classList.toggle('nav-open');
  else { document.body.classList.toggle('nav-collapsed'); store.set('acct.nav', document.body.classList.contains('nav-collapsed') ? 'collapsed' : 'open'); }
  syncNavToggle();
}
export async function doInstall() { const p = view.installPrompt; view.installPrompt = null; if (!p) return; p.prompt(); await p.userChoice.catch(() => {}); render(); }
export async function doSignOut() { try { await App.signOut(); } catch (e) { toast(e.message); } state.home = null; try { await load(); } catch { /* login screen or error state shows */ } }
export function closeUserMenu() { const m = $('userMenu'); if (!m.hidden) { m.hidden = true; $('userMenuBtn').setAttribute('aria-expanded', 'false'); } }

export const shellActions = {
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
