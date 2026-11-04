// Pure hash routing: "#/banking" <-> { id: 'banking', rest: [], query: {} }. Home is "#/" (or empty).

const ID = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export function parseHash(hash) {
  let h = String(hash ?? '').replace(/^#/, '');
  const qi = h.indexOf('?');
  const queryText = qi >= 0 ? h.slice(qi + 1) : '';
  if (qi >= 0) h = h.slice(0, qi);
  const segs = h.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const query = {};
  for (const [k, v] of new URLSearchParams(queryText)) query[k] = v;
  if (!segs.length) return { id: 'home', rest: [], query, valid: true };
  const id = segs[0].toLowerCase();
  return { id, rest: segs.slice(1), query, valid: ID.test(id) };
}

export function buildHash(id, rest = [], query = {}) {
  const base = !id || id === 'home' ? '#/' : '#/' + [id, ...rest].map(encodeURIComponent).join('/');
  const q = new URLSearchParams(query).toString();
  return q ? `${base}?${q}` : base;
}

/** Resolve a route against known page ids: { kind: 'home' | 'page' | 'missing', id }. */
export function resolveRoute(route, pageIds) {
  if (route.id === 'home' && route.valid) return { kind: 'home', id: 'home' };
  if (!route.valid || !pageIds.includes(route.id)) return { kind: 'missing', id: route.id };
  return { kind: 'page', id: route.id };
}
