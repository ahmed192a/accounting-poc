// Page bodies: home (cards, onboarding, workspace tiles), registered pages, not-found / no-access.
import { esc, emptyState, errorState, skeleton } from '/lib/html.js';
import { icon } from '/lib/icons.js';
import { buildHash, resolveRoute } from '/lib/router.js';
import { state, store, has } from '/core/state.js';
import { t } from '/core/i18n.js';
import { view } from '/core/host.js';
import { cards, fullPages } from '/core/registry.js';
import { pageTitle } from '/core/view.js';

export const cardSlot = (e) => `<div class="card-slot${e.card.wide ? ' slot-wide' : ''}" data-card-id="${esc(e.card.id)}">${e.html}</div>`;
export const section = (list, area) => list.filter((e) => e.card.area === area).map(cardSlot).join('');

export function stepsHtml() {
  const link = (id, text) => (view.pages.some((p) => p.id === id) ? `<a href="${buildHash(id)}">${esc(text)}</a>` : esc(text));
  const steps = [esc(t('sh.on1'))];
  if (has('sales.create')) steps.push(link('sales', t('sh.onSales')));
  if (has('users.manage')) steps.push(link('admin', t('sh.onTeam')));
  steps.push(view.installPrompt ? `${esc(t('sh.onInstall'))} <button type="button" class="small" data-sh="install">${esc(t('sh.onInstallBtn'))}</button>` : esc(t('sh.onPhone')));
  if (has('export.all')) steps.push(esc(t('sh.onExport')));
  return steps.map((s) => `<li>${s}</li>`).join('');
}
export function onboardingHtml() {
  if (store.get(`acct.onboard.${state.userId}`) === 'hidden') return '';
  return `<section class="card onboard" aria-label="${esc(t('sh.onTitle'))}"><div class="onboard-head">${icon('info')}<strong role="heading" aria-level="2">${esc(t('sh.onTitle'))}</strong>
    <button type="button" class="small ghost push-end" data-sh="onboard-hide" >${esc(t('sh.onHide'))}</button></div><ol>${stepsHtml()}</ol></section>`;
}

export function mainHtml(route) {
  const h = state.home;
  if (!h) return skeleton({ cards: 4 });
  const resolved = resolveRoute(route, view.pages.map((p) => p.id));
  if (resolved.kind === 'home') {
    const list = view.entries.filter((e) => e.card.page == null);
    const tiles = view.pages.filter((p) => p.nav);
    const body = `<div class="role-line">${t('role')}: <b>${esc(h.user.role)}</b> · ${h.permissions.length} ${t('perms')}</div>
      ${onboardingHtml()}
      ${section(list, 'stats') ? `<div class="stats">${section(list, 'stats')}</div>` : ''}
      ${section(list, 'main') ? `<div class="grid">${section(list, 'main')}</div>` : (tiles.length ? '' : emptyState({ title: t('sh.homeEmpty'), text: t('sh.homeEmptyText') }))}
      ${tiles.length ? `<h2 class="section-title">${esc(t('sh.workspaces'))}</h2><nav class="tiles" aria-label="${esc(t('sh.workspaces'))}">${tiles.map((p) => `<a class="tile" href="${buildHash(p.id)}">${icon(p.id)}${esc(pageTitle(p))}</a>`).join('')}</nav>` : ''}`;
    return `<div class="page-head"><h1 tabindex="-1" id="page-h1">${esc(t('sh.home'))}</h1></div>${body}`;
  }
  if (resolved.kind === 'page') {
    const p = view.pages.find((x) => x.id === resolved.id);
    const fp = fullPages.find((x) => x.id === p.id);
    let custom = '';
    if (fp) { try { custom = fp.render(h) || ''; } catch (err) { console.error(`Page ${fp.id} failed to render:`, err); custom = errorState({ title: t('sh.loadFailed'), text: String(err?.message ?? err) }); } }
    const list = view.entries.filter((e) => e.card.page === p.id);
    const body = `${custom}${section(list, 'stats') ? `<div class="stats">${section(list, 'stats')}</div>` : ''}${section(list, 'main') ? `<div class="grid">${section(list, 'main')}</div>` : ''}`;
    return `<div class="page-head"><h1 tabindex="-1" id="page-h1">${esc(pageTitle(p))}</h1></div>${body || emptyState({ title: t('sh.pageEmpty') })}`;
  }
  // not a known page: distinguish "exists for others" is not knowable here; both are shown as unavailable
  const known = fullPages.some((p) => p.id === route.id) || cards.some((c) => String(c.page) === route.id);
  return `<div class="page-head"><h1 tabindex="-1" id="page-h1">${esc(t(known ? 'sh.noAccess' : 'sh.notFound'))}</h1></div>`
    + emptyState({ title: t(known ? 'sh.noAccess' : 'sh.notFound'), text: known ? '' : t('sh.notFoundText'), action: { href: '#/', label: t('sh.goHome') } });
}
