// Pure fuzzy search used by the command palette and global search. Handles Arabic normalisation.

/** Lowercase, strip diacritics/tatweel, unify alef/yeh/teh-marbuta forms, collapse spaces. */
export function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[آأإ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 0 = no match; higher is better. */
export function score(query, text) {
  const q = normalize(query); const t = normalize(text);
  if (!q) return 1;
  if (!t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 90;
  if (t.split(' ').some((w) => w.startsWith(q))) return 75;
  if (t.includes(q)) return 60;
  let i = 0;
  for (const ch of t) if (ch === q[i] && ++i === q.length) return 30;
  return 0;
}

/** items filtered and ordered by best score over getTexts(item); ties keep input order. */
export function rank(items, query, getTexts = (x) => [x.title]) {
  return items
    .map((item, idx) => ({ item, idx, s: Math.max(...getTexts(item).map((tx) => score(query, tx)), 0) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => (b.s - a.s) || (a.idx - b.idx))
    .map((r) => r.item);
}
