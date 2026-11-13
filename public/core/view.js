// Derived view model: which cards and pages the current user sees, and the navigation items.
import { esc, cardTitle } from '/lib/html.js';
import { parseHash, buildHash } from '/lib/router.js';
import { buildPages, fallbackTitle } from '/lib/nav.js';
import { t } from '/core/i18n.js';
import { view } from '/core/host.js';
import { cards, fullPages, byOrder, permOk } from '/core/registry.js';

export function computeEntries(home) {
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
export function computePages(home) {
  const fp = fullPages.map((p) => ({ id: p.id, titleKey: p.titleKey, order: p.order, nav: p.nav, allowed: permOk(p.permission, home) }));
  return buildPages(view.entries.map((e) => ({ id: e.card.id, page: e.card.page, pageTitleKey: e.card.pageTitleKey, order: e.card.order })), fp);
}
export const pageTitle = (p) => (p.titleKey ? t(p.titleKey) : fallbackTitle(p.id));
export const routeNow = () => parseHash(location.hash);
export const navItems = () => [{ id: 'home', title: t('sh.home'), href: '#/' }, ...view.pages.filter((p) => p.nav).map((p) => ({ id: p.id, title: pageTitle(p), href: buildHash(p.id) }))];
