// WCAG 2.x contrast math, used by tests to prove the design tokens meet AA.
export function parseHex(hex) {
  const h = String(hex).trim().replace(/^#/, '');
  const f = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  if (!/^[0-9a-f]{6}$/i.test(f)) return null;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
}
export function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrastRatio(fg, bg) {
  const a = parseHex(fg); const b = parseHex(bg);
  if (!a || !b) return NaN;
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
export const meetsAA = (fg, bg, large = false) => contrastRatio(fg, bg) >= (large ? 3 : 4.5);
