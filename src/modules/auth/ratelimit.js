// Token bucket rate limiter, in memory (per process). Published in docs/security.md.
// `now` is injected (ctx.now) so tests and the demo clock stay deterministic.
export class RateLimiter {
  constructor({ capacity, perMinute, maxKeys = 20000 }) {
    this.capacity = capacity;
    this.ratePerMs = perMinute / 60_000;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  /** Take one token for `key`. Returns { allowed, limit, remaining, resetSec, retryAfterSec }. */
  take(key, nowMs) {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.#purge(nowMs);
      b = { tokens: this.capacity, at: nowMs };
      this.buckets.set(key, b);
    }
    const elapsed = Math.max(0, nowMs - b.at);
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.ratePerMs);
    b.at = nowMs;
    const allowed = b.tokens >= 1;
    if (allowed) b.tokens -= 1;
    return {
      allowed,
      limit: this.capacity,
      remaining: Math.floor(b.tokens),
      resetSec: Math.ceil((this.capacity - b.tokens) / this.ratePerMs / 1000),   // until the bucket is full again
      retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((1 - b.tokens) / this.ratePerMs / 1000)),
    };
  }

  #purge(nowMs) {
    for (const [k, b] of this.buckets) {
      if (b.tokens + (nowMs - b.at) * this.ratePerMs >= this.capacity) this.buckets.delete(k);
    }
    if (this.buckets.size >= this.maxKeys) this.buckets.clear(); // under attack: fail open on memory, not on the service
  }
}

export function rateHeaders(r) {
  return { 'x-ratelimit-limit': String(r.limit), 'x-ratelimit-remaining': String(r.remaining), 'x-ratelimit-reset': String(r.resetSec) };
}
