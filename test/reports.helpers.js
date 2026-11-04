import { postEntry } from '../src/ledger.js';

export function rng(seed) { // mulberry32: deterministic
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const CODES = ['1000', '1200', '2000', '2100', '3000', '4000', '5000', '5100', '5200'];
export const pad = (n) => String(n).padStart(2, '0');

/** Post `n` random balanced entries between 2025-01-01 and 2026-06-30 through the real posting engine. */
export function randomEntries(ctx, seed, n) {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    const k = 2 + Math.floor(r() * 3);
    const lines = [];
    let sum = 0;
    for (let j = 0; j < k - 1; j++) {
      const amt = 1 + Math.floor(r() * 500000);
      const debit = r() < 0.5;
      lines.push({ account: CODES[Math.floor(r() * CODES.length)], [debit ? 'debit' : 'credit']: amt });
      sum += debit ? amt : -amt;
    }
    if (sum === 0) { lines.push({ account: '1000', debit: 100 }, { account: '4000', credit: 100 }); }
    else lines.push({ account: CODES[Math.floor(r() * CODES.length)], [sum > 0 ? 'credit' : 'debit']: Math.abs(sum) });
    const month = 1 + Math.floor(r() * 18); // 2025-01 .. 2026-06
    const y = 2025 + Math.floor((month - 1) / 12), m = ((month - 1) % 12) + 1;
    postEntry(ctx, { userId: 1, date: `${y}-${pad(m)}-${pad(1 + Math.floor(r() * 28))}`, memo: `random ${i}`, lines, sourceType: r() < 0.5 ? 'manual' : 'sale' });
  }
}
