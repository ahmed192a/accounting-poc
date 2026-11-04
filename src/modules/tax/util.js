import { createHash } from 'node:crypto';

// Canonical JSON: keys sorted at every level, so the same document always hashes the same.
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const GENESIS = '0'.repeat(64);

// Integer piastres -> "12.34" without floats.
export function fmtAmount(p) {
  const neg = p < 0, a = Math.abs(p);
  return `${neg ? '-' : ''}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}
