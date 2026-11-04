// Security configuration, attached to the context as ctx.security. createApp(ctx, opts) configures it;
// service functions called directly (tests, scripts) get the defaults plus environment lazily.
const MIN = 60_000, HOUR = 60 * MIN;

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export function defaults(env = process.env) {
  return {
    required: env.AUTH_REQUIRED === '1',              // exactly '1': anything else keeps the demo x-user-id identity
    sessionIdleMs: num(env.SESSION_IDLE_MINUTES, 120) * MIN,
    sessionAbsoluteMs: num(env.SESSION_MAX_HOURS, 12) * HOUR,
    rotateEveryMs: 15 * MIN,                           // session id is re-issued after this age
    rotationGraceMs: 30_000,                           // the previous id still works this long (parallel requests)
    lockThreshold: 5,                                  // failures before the first lock
    lockBaseMs: 60_000,                                // first lock; doubles with each further failure
    lockMaxMs: 30 * MIN,
    inviteTtlMs: 7 * 24 * HOUR,
    rateLimit: { capacity: num(env.RATE_LIMIT_PER_MIN, 600), perMinute: num(env.RATE_LIMIT_PER_MIN, 600) },
    loginRateLimit: { capacity: 10, perMinute: 10 },   // per IP, on login/setup/accept-invite
    maxBodyBytes: 1024 * 1024,
    cookieSecure: env.COOKIE_SECURE === '1' ? true : null, // null = decide per request (https or trusted proxy)
    trustProxy: env.TRUST_PROXY === '1',
    webhook: { maxAttempts: 8, baseDelayMs: 30_000, maxDelayMs: 6 * HOUR, timeoutMs: 5000, allowHttp: false, intervalMs: 30_000 },
    issuer: 'Accounting',
    env,
  };
}

export function configure(ctx, opts = {}) {
  const base = defaults(opts.env ?? process.env);
  const { authRequired, webhook, rateLimit, loginRateLimit, ...rest } = opts;
  ctx.security = {
    ...base, ...rest,
    required: authRequired ?? base.required,
    webhook: { ...base.webhook, ...webhook },
    rateLimit: { ...base.rateLimit, ...rateLimit },
    loginRateLimit: { ...base.loginRateLimit, ...loginRateLimit },
  };
  return ctx.security;
}

export const cfg = (ctx) => ctx.security ?? configure(ctx);
export const authRequired = (ctx) => !!cfg(ctx).required;
