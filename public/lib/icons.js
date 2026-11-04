// Inline SVG icons (24x24, stroke currentColor). Pure strings, no DOM. Unknown names get a generic square.
const P = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  sales: 'M4 20V8M10 20V4M16 20v-9M22 20H2',
  banking: 'M3 10l9-6 9 6M5 10v8M9 10v8M15 10v8M19 10v8M3 21h18',
  inventory: 'M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7M12 11v10',
  ledger: 'M5 3h12a2 2 0 012 2v16H7a2 2 0 01-2-2V3zM9 8h6M9 12h6M9 16h4',
  entities: 'M4 21V7l8-4 8 4v14M9 21v-6h6v6M9 9h.01M15 9h.01M9 12h.01M15 12h.01',
  admin: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zM9 12l2 2 4-4',
  audit: 'M10 17a7 7 0 100-14 7 7 0 000 14zM21 21l-5.5-5.5',
  eta: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h6',
  tax: 'M19 5L5 19M7.5 9a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM16.5 18a1.5 1.5 0 100-3 1.5 1.5 0 000 3z',
  reports: 'M4 4v16h16M8 16v-5M12 16V8M16 16v-3',
  purchases: 'M3 4h2l2 12h11l2-8H6M9 20h.01M17 20h.01',
  approvals: 'M5 12l5 5L20 7',
  assist: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z',
  design: 'M12 3a9 9 0 100 18c1.5 0 2-1 1.5-2-.6-1.2 0-2.5 1.5-2.5H17a4 4 0 004-4c0-5-4-9.5-9-9.5zM7.5 11h.01M10 7.5h.01M14.5 7.5h.01',
  menu: 'M4 6h16M4 12h16M4 18h16',
  search: 'M10.5 18a7.5 7.5 0 100-15 7.5 7.5 0 000 15zM21 21l-5.2-5.2',
  sun: 'M12 16a4 4 0 100-8 4 4 0 000 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5L20 7',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  info: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 16v-4M12 8h.01',
  chevron: 'M9 6l6 6-6 6',
  inbox: 'M3 13l3-8h12l3 8M3 13v6h18v-6M3 13h5l1 3h6l1-3h5',
  generic: 'M4 4h16v16H4z',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  wifi: 'M2 9a15 15 0 0120 0M5 12.5a10 10 0 0114 0M8.5 16a5 5 0 017 0M12 19.5h.01',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
};
export const iconNames = () => Object.keys(P);
export function icon(name, { size = 20, cls = '' } = {}) {
  const d = P[name] ?? P.generic;
  const flip = name === 'chevron' ? ' flip' : '';
  return `<svg class="icon${flip}${cls ? ' ' + cls : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;
}
