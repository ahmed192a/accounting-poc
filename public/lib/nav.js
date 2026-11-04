// Pure navigation model. Cards that carry `page: 'x'` are grouped into page x; cards without a page stay on Home.
// A page shows in the nav only when at least one card on it is visible to the user (non-empty).

const orderOf = (x) => (Number.isFinite(x?.order) ? x.order : 100);
const cmp = (a, b) => (a.order - b.order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const isPageId = (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,40}$/.test(id);

/**
 * @param shown   [{ id, page?, pageTitleKey?, order }]  cards that are permitted AND rendered non-empty
 * @param fullPages [{ id, titleKey, order, nav? , allowed }] pages registered with App.addPage
 * @returns [{ id, titleKey, order, cardIds, full, nav }] sorted by minimum order (Home is not included)
 */
export function buildPages(shown, fullPages = []) {
  const pages = new Map();
  for (const c of [...shown].filter((c) => c.page != null).sort(cmp)) {
    const id = String(c.page);
    if (!isPageId(id)) continue;
    let p = pages.get(id);
    if (!p) { p = { id, titleKey: null, order: orderOf(c), cardIds: [], full: false, nav: true }; pages.set(id, p); }
    if (!p.titleKey && c.pageTitleKey) p.titleKey = c.pageTitleKey;
    p.order = Math.min(p.order, orderOf(c));
    p.cardIds.push(c.id);
  }
  for (const fp of fullPages) {
    if (!fp.allowed || !isPageId(fp.id)) continue;
    const p = pages.get(fp.id);
    if (p) { p.full = true; p.titleKey = fp.titleKey ?? p.titleKey; p.order = Math.min(p.order, orderOf(fp)); p.nav = fp.nav !== false; }
    else pages.set(fp.id, { id: fp.id, titleKey: fp.titleKey ?? null, order: orderOf(fp), cardIds: [], full: true, nav: fp.nav !== false });
  }
  return [...pages.values()].sort(cmp);
}

/** Cards of the Home route: no `page`. */
export const homeCards = (shown) => shown.filter((c) => c.page == null);

/** Readable fallback title for a page that has no pageTitleKey. */
export const fallbackTitle = (id) => String(id).replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Split the nav into the entries that fit a phone bottom bar and the rest ("More"). */
export function splitBottomNav(items, max = 5) {
  if (items.length <= max) return { bar: items, more: [] };
  return { bar: items.slice(0, max - 1), more: items.slice(max - 1) };
}
