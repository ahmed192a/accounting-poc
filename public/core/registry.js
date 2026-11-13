// Registries filled by UI modules (cards, pages, commands, handlers, hooks) and their validation.
import { isPageId } from '/lib/nav.js';

export const cards = [];
export const headerItems = [];
export const footerItems = [];
export const fullPages = [];
export const commands = [];
export const handlers = { click: {}, change: {}, input: {} };
export const loadHooks = [];
export const userChangeHooks = [];

export const byOrder = (a, b) => (a.order - b.order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function addItem(list, kind, item) {
  if (!item || typeof item.id !== 'string' || typeof item.render !== 'function') throw new Error(`${kind} needs { id, render }`);
  if (list.some((c) => c.id === item.id)) throw new Error(`${kind} id "${item.id}" is already registered`);
  list.push({ order: 100, ...item });
}
export function addHandler(kind, action, fn) {
  if (typeof action !== 'string' || typeof fn !== 'function') throw new Error(`App.${kind}(action, handler) needs a string and a function`);
  if (handlers[kind][action]) throw new Error(`data-act "${action}" already has a ${kind} handler`);
  handlers[kind][action] = fn;
}
export const permOk = (perm, home) => perm == null || (typeof perm === 'string' ? home.permissions.includes(perm) : !!perm(home));

export function addCard(card) {
  if (!['stats', 'main'].includes(card?.area)) throw new Error(`Card "${card?.id}" needs area 'stats' or 'main'`);
  if (card.permission != null && typeof card.permission !== 'string' && typeof card.permission !== 'function') throw new Error(`Card "${card.id}": permission must be a string or a function`);
  if (card.page != null && !isPageId(String(card.page))) throw new Error(`Card "${card.id}": page must be lowercase letters, digits, - or _`);
  addItem(cards, 'Card', card);
}
export function addPage(page) {
  if (!page || !isPageId(page.id) || typeof page.render !== 'function' || !page.titleKey) throw new Error('Page needs { id, titleKey, render } (id: lowercase letters, digits, - or _)');
  if (page.id === 'home') throw new Error('Page id "home" is reserved');
  if (page.permission != null && typeof page.permission !== 'string' && typeof page.permission !== 'function') throw new Error(`Page "${page.id}": permission must be a string or a function`);
  addItem(fullPages, 'Page', page);
}
export function addCommand(cmd) {
  if (!cmd || typeof cmd.id !== 'string' || typeof cmd.run !== 'function' || !(cmd.title || cmd.titleKey)) throw new Error('Command needs { id, title|titleKey, run }');
  if (commands.some((c) => c.id === cmd.id)) throw new Error(`Command id "${cmd.id}" is already registered`);
  commands.push({ order: 100, ...cmd });
}
