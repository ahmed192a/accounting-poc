// Persisted preferences and the one mutable state object shared by every shell file.
import { formatMoney, localeTag, parseAmountToPiastres, normalizeDigits } from '/lib/format.js';
import { normalizePref } from '/lib/theme.js';

export const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
export const state = {
  lang: store.get('acct.lang') ?? ((globalThis.navigator?.language ?? 'en').toLowerCase().startsWith('ar') ? 'ar' : 'en'),
  userId: 3, users: [], home: null,
  digits: normalizeDigits(store.get('acct.digits')),
  themePref: normalizePref(store.get('acct.theme')),
};
if (state.lang !== 'ar') state.lang = 'en';


export const has = (p) => state.home?.permissions.includes(p) ?? false;
export const loc = () => localeTag(state.lang, state.digits);
export const money = (p) => formatMoney(p, state.lang, state.digits);
export const toPiastres = (v) => parseAmountToPiastres(v);
