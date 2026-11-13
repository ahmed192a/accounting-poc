// Delegated DOM listeners: one per event type; modules register handlers by data-act name.
import { normalizeDigits } from '/lib/format.js';
import { createShortcuts } from '/lib/shortcuts.js';
import { modalDepth } from '/lib/ui.js';
import { state, store } from '/core/state.js';
import { t } from '/core/i18n.js';
import { view, $ } from '/core/host.js';
import { handlers, userChangeHooks } from '/core/registry.js';
import { run, toast } from '/core/load.js';
import { render } from '/core/router.js';
import { navItems } from '/core/view.js';
import { applyTheme, syncNavToggle } from '/ui/chrome.js';
import { shellActions, toggleNav, closeUserMenu } from '/ui/actions.js';
import { openPalette, showHelp } from '/ui/palette.js';

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
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); view.installPrompt = e; if (state.home) render(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
