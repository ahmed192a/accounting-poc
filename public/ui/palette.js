// Command palette (Ctrl/Cmd+K) and the keyboard-shortcuts help.
import { esc } from '/lib/html.js';
import { icon } from '/lib/icons.js';
import { buildHash } from '/lib/router.js';
import { rank } from '/lib/search.js';
import { nextIndex } from '/lib/focus.js';
import { openModal } from '/lib/ui.js';
import { state } from '/core/state.js';
import { t } from '/core/i18n.js';
import { App, view } from '/core/host.js';
import { commands, byOrder, permOk } from '/core/registry.js';
import { isLoginVisible } from '/core/login.js';
import { run } from '/core/load.js';
import { render } from '/core/router.js';
import { navItems, pageTitle } from '/core/view.js';
import { toggleTheme, setThemePref } from '/ui/chrome.js';
import { toggleLang, toggleNav, doInstall, doSignOut } from '/ui/actions.js';

export function paletteItems() {
  const items = [];
  for (const i of navItems().concat(view.pages.filter((p) => !p.nav).map((p) => ({ id: p.id, title: pageTitle(p), href: buildHash(p.id) })))) {
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
  if (view.installPrompt) builtin.push({ id: 'install', title: t('sh.cmdInstall'), icon: 'download', run: doInstall });
  if (typeof App.signOut === 'function') builtin.push({ id: 'signout', title: t('sh.cmdSignOut'), icon: 'user', run: doSignOut });
  for (const c of [...builtin, ...commands.filter((c) => permOk(c.permission, state.home ?? { permissions: [] })).sort(byOrder)]) {
    items.push({ group: 'sh.gActions', id: 'cmd:' + c.id, title: c.title ?? t(c.titleKey), keywords: c.keywords ?? [], hint: c.hint ?? '', icon: c.icon ?? 'generic', run: c.run });
  }
  for (const e of view.entries) {
    if (!e.title) continue;
    const pid = e.card.page != null ? String(e.card.page) : 'home';
    items.push({ group: 'sh.gCards', id: 'card:' + e.card.id, title: e.title, hint: pid === 'home' ? t('sh.home') : (view.pages.find((p) => p.id === pid) ? pageTitle(view.pages.find((p) => p.id === pid)) : ''), icon: pid === 'home' ? 'home' : pid,
      run: () => { view.pendingCard = e.card.id; if (location.hash === buildHash(pid)) render(); else location.hash = buildHash(pid); } });
  }
  return items;
}
export function openPalette() {
  if (!state.home || isLoginVisible()) return;
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
export function showHelp() {
  const k = (keys, text) => `<tr><td>${keys.map((x) => `<kbd>${x}</kbd>`).join(' ')}</td><td>${esc(text)}</td></tr>`;
  openModal({
    title: t('sh.helpTitle'), actions: [{ label: t('sh.close'), value: true, primary: true }],
    bodyHtml: `<table class="kbd-table">${k(['Ctrl/Cmd', 'K'], t('sh.kPalette'))}${k(['/'], t('sh.kSearch'))}${k(['g', '1-9'], t('sh.kGo'))}${k(['['], t('sh.kNav'))}${k(['?'], t('sh.kHelp'))}${k(['Esc'], t('sh.kEsc'))}</table>`,
  });
}
