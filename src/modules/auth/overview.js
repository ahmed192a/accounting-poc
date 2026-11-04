import { requirePerm } from '../../permissions.js';
import { cfg } from './config.js';

export function publishedLimits(ctx) {
  const c = cfg(ctx);
  return {
    authRequired: !!c.required,
    rateLimit: { algorithm: 'token bucket per API key, else per client IP', capacity: c.rateLimit.capacity, refillPerMinute: c.rateLimit.perMinute,
      headers: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset (seconds until the bucket is full)', 'Retry-After (on 429)'] },
    loginRateLimit: { appliesTo: 'POST /api/auth/login, /setup, /accept-invite, per IP', capacity: c.loginRateLimit.capacity, refillPerMinute: c.loginRateLimit.perMinute },
    lockout: { afterFailures: c.lockThreshold, firstLockSeconds: c.lockBaseMs / 1000, doubles: true, maxLockSeconds: c.lockMaxMs / 1000 },
    session: { idleMinutes: c.sessionIdleMs / 60000, absoluteHours: c.sessionAbsoluteMs / 3600000, rotateMinutes: c.rotateEveryMs / 60000 },
    maxBodyBytes: c.maxBodyBytes,
  };
}

export function overview(ctx, user) {
  requirePerm(user, 'security.view');
  const { db } = ctx, now = ctx.now();
  const n = (sql, ...a) => db.prepare(sql).get(...a).n;
  const people = n('SELECT COUNT(*) AS n FROM auth_credentials WHERE active = 1 AND password_hash IS NOT NULL');
  return {
    ...publishedLimits(ctx),
    users: { withPassword: people, mfaEnabled: n('SELECT COUNT(*) AS n FROM auth_credentials WHERE active = 1 AND mfa_enabled = 1'),
      locked: n('SELECT COUNT(*) AS n FROM auth_credentials WHERE locked_until > ?', now), deactivated: n('SELECT COUNT(*) AS n FROM auth_credentials WHERE active = 0 AND demo = 0'),
      demoCredentials: n('SELECT COUNT(*) AS n FROM auth_credentials WHERE demo = 1 AND password_hash IS NOT NULL') },
    sessions: { active: n('SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ? AND absolute_expires_at > ?', now, now) },
    apiKeys: { active: n('SELECT COUNT(*) AS n FROM auth_api_keys WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)', now), revoked: n('SELECT COUNT(*) AS n FROM auth_api_keys WHERE revoked_at IS NOT NULL') },
    webhooks: { active: n('SELECT COUNT(*) AS n FROM auth_webhooks WHERE active = 1'), pending: n("SELECT COUNT(*) AS n FROM auth_webhook_deliveries WHERE status = 'pending'"), dead: n("SELECT COUNT(*) AS n FROM auth_webhook_deliveries WHERE status = 'dead'") },
    audit: { rows: n('SELECT COUNT(*) AS n FROM audit_log'), sealed: n('SELECT COUNT(*) AS n FROM auth_audit_chain') },
  };
}
