// render(): rebuilds chrome and the current page from state, keeping scroll, focus and selection.
import { resolveRoute, parseHash } from '/lib/router.js';
import { enhanceTables } from '/lib/ui.js';
import { state } from '/core/state.js';
import { t } from '/core/i18n.js';
import { view, $ } from '/core/host.js';
import { isLoginVisible } from '/core/login.js';
import { computeEntries, computePages } from '/core/view.js';
import { renderChrome } from '/ui/chrome.js';
import { mainHtml } from '/ui/pages.js';

let lastRouteKey = null;
export const routeNow = () => parseHash(location.hash);

export function render() {
  if (isLoginVisible()) return;
  const route = routeNow();
  const main = $('main');
  const y = window.scrollY;
  const active = document.activeElement;
  const activeId = active && main.contains(active) ? active.id : '';
  const sel = activeId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  if (state.home) { view.entries = computeEntries(state.home); view.pages = computePages(state.home); } else { view.entries = []; view.pages = []; }
  const resolved = resolveRoute(route, view.pages.map((p) => p.id));
  renderChrome(resolved.kind === 'home' ? 'home' : resolved.kind === 'page' ? resolved.id : '');
  main.innerHTML = mainHtml(route);
  enhanceTables(main);
  const key = location.hash;
  const navigated = lastRouteKey !== null && lastRouteKey !== key;
  const first = lastRouteKey === null;
  lastRouteKey = key;
  document.documentElement.dataset.route = key || '#/'; // tests wait on this after navigating
  const h1 = $('page-h1');
  document.title = `${h1 ? h1.textContent + ' - ' : ''}${t('title')}`;
  if (navigated) { window.scrollTo(0, 0); h1?.focus({ preventScroll: true }); document.body.classList.remove('nav-open'); }
  else {
    window.scrollTo(0, first ? 0 : y);
    if (activeId) { const el = document.getElementById(activeId); if (el && el !== document.activeElement) { el.focus({ preventScroll: true }); if (sel && 'setSelectionRange' in el) try { el.setSelectionRange(...sel); } catch { /* not selectable */ } } }
  }
  if (view.pendingCard) { const slot = main.querySelector(`[data-card-id="${CSS.escape(view.pendingCard)}"]`); view.pendingCard = null; const c = slot?.firstElementChild; if (c) { c.scrollIntoView({ block: 'center' }); c.classList.add('card-flash'); setTimeout(() => c.classList.remove('card-flash'), 1800); } }
}
