import { AppError } from '../../errors.js';
import { EVENTS } from '../../hooks.js';
import { requirePerm } from '../../permissions.js';
import { cfg } from './config.js';
import * as s from './service.js';
import * as keys from './apikeys.js';
import * as hooks from './webhooks.js';
import { verifyAudit } from './auditchain.js';
import { overview, publishedLimits } from './overview.js';

const login = (ctx, _u, { body, http }) => {
  const r = s.login(ctx, body, { ip: http.ip, userAgent: http.userAgent });
  http.setSession(r.session.token, r.session.maxAgeSec, r.session.csrf);
  return { user: r.user, csrfToken: r.session.csrf, mustChangePassword: r.mustChangePassword, mfaEnabled: r.mfaEnabled, expiresAt: r.session.expiresAt };
};

const processNow = (ctx) => hooks.processDeliveries(ctx, { fetchImpl: cfg(ctx).fetch ?? globalThis.fetch, resolve: cfg(ctx).resolve });
const OK = 200;
const R = (method, path, handler, meta, extra = {}) => ({ method, path, handler, meta, ...extra });

export default {
  name: 'auth',
  permissions: {
    'users.invite': 'Invite users and give them a role',
    'apikeys.manage': 'Create, list and revoke API keys',
    'webhooks.manage': 'Manage outbound webhooks and read the delivery log',
    'security.view': 'See the security overview and verify audit-log integrity',
  },
  roleGrants: {
    admin: ['users.invite', 'apikeys.manage', 'webhooks.manage', 'security.view'],
    auditor: ['security.view'],
  },
  exportTables: ['auth_audit_chain'],
  routes: [
    R('GET', '/api/auth/status', (ctx) => s.status(ctx), { summary: 'Is sign-in required, is first-run setup pending' }, { public: true }),
    R('POST', '/api/auth/login', login, { summary: 'Sign in with e-mail, password and (if enrolled) a TOTP or backup code', status: OK }, { public: true }),
    R('POST', '/api/auth/setup', (ctx, _u, { body }) => s.completeSetup(ctx, body), { summary: 'First-run owner setup with the one-time setup token', status: OK }, { public: true }),
    R('POST', '/api/auth/accept-invite', (ctx, _u, { body }) => s.acceptInvite(ctx, body), { summary: 'Accept an invitation and choose a password', status: OK }, { public: true }),
    R('GET', '/api/auth/me', (ctx, u, { http }) => s.me(ctx, u, http.via, http.session), { summary: 'Who am I: identity, csrf token, MFA state' }),
    R('POST', '/api/auth/logout', (ctx, _u, { http }) => { const r = s.logout(ctx, http.sessionToken); http.clearSession(); return r; }, { summary: 'Sign out (revokes the session)', status: OK }),
    R('POST', '/api/auth/logout-all', (ctx, u, { http }) => { const r = s.logoutEverywhere(ctx, u); http.clearSession(); return r; }, { summary: 'Sign out everywhere', status: OK }),
    R('POST', '/api/auth/password', (ctx, u, { body, http }) => s.changePassword(ctx, u, { current: body.current, next: body.next }, http.session), { summary: 'Change own password', status: OK }),
    R('POST', '/api/auth/mfa/enroll', (ctx, u) => s.mfaEnroll(ctx, u), { summary: 'Start TOTP enrollment: secret and otpauth URI', status: OK }),
    R('POST', '/api/auth/mfa/confirm', (ctx, u, { body }) => s.mfaConfirm(ctx, u, body.code), { summary: 'Confirm enrollment with a first code; returns one-time backup codes', status: OK }),
    R('POST', '/api/auth/mfa/disable', (ctx, u, { body }) => s.mfaDisable(ctx, u, body), { summary: 'Disable MFA (password and code required)', status: OK }),
    R('POST', '/api/auth/mfa/backup-codes', (ctx, u, { body }) => s.mfaNewBackupCodes(ctx, u, body), { summary: 'Replace backup codes (password and code required)', status: OK }),

    R('GET', '/api/auth/users', (ctx, u) => s.listUsers(ctx, u), { summary: 'Users with sign-in state', permission: 'users.invite' }),
    R('POST', '/api/auth/users', (ctx, u, { body }) => s.inviteUser(ctx, u, body), { summary: 'Invite a user with a role (returns a one-time invite token)', permission: 'users.invite' }),
    R('POST', '/api/auth/users/:id/deactivate', (ctx, u, { params, body }) => s.setActive(ctx, u, Number(params.id), false, body.reason), { summary: 'Deactivate a user and revoke sessions and keys', permission: 'users.manage', status: OK }),
    R('POST', '/api/auth/users/:id/reactivate', (ctx, u, { params }) => s.setActive(ctx, u, Number(params.id), true), { summary: 'Reactivate a user', permission: 'users.manage', status: OK }),
    R('POST', '/api/auth/users/:id/reset-password', (ctx, u, { params }) => s.adminResetPassword(ctx, u, Number(params.id)), { summary: 'Admin password reset: temporary password, must change at next login', permission: 'users.manage', status: OK }),
    R('POST', '/api/auth/users/:id/reset-mfa', (ctx, u, { params }) => s.adminResetMfa(ctx, u, Number(params.id)), { summary: 'Admin: remove a user\'s MFA enrollment', permission: 'users.manage', status: OK }),
    R('POST', '/api/auth/users/:id/unlock', (ctx, u, { params }) => s.unlockUser(ctx, u, Number(params.id)), { summary: 'Admin: clear a lockout', permission: 'users.manage', status: OK }),

    R('GET', '/api/apikeys', (ctx, u) => keys.listApiKeys(ctx, u), { summary: 'List API keys (never the secret)', permission: 'apikeys.manage' }),
    R('POST', '/api/apikeys', (ctx, u, { body }) => keys.createApiKey(ctx, u, body), { summary: 'Create a scoped API key (shown once)', permission: 'apikeys.manage' }),
    R('DELETE', '/api/apikeys/:id', (ctx, u, { params }) => keys.revokeApiKey(ctx, u, Number(params.id)), { summary: 'Revoke an API key', permission: 'apikeys.manage' }),

    R('GET', '/api/webhooks', (ctx, u) => ({ webhooks: hooks.listWebhooks(ctx, u), events: EVENTS }), { summary: 'List webhooks and the subscribable events', permission: 'webhooks.manage' }),
    R('POST', '/api/webhooks', (ctx, u, { body }) => hooks.createWebhook(ctx, u, body), { summary: 'Register a webhook (signing secret shown once)', permission: 'webhooks.manage' }),
    R('PATCH', '/api/webhooks/:id', (ctx, u, { params, body }) => hooks.updateWebhook(ctx, u, Number(params.id), body), { summary: 'Edit or pause a webhook', permission: 'webhooks.manage' }),
    R('DELETE', '/api/webhooks/:id', (ctx, u, { params }) => hooks.deleteWebhook(ctx, u, Number(params.id)), { summary: 'Delete a webhook', permission: 'webhooks.manage' }),
    R('POST', '/api/webhooks/:id/test', async (ctx, u, { params }) => {
      const q = hooks.sendTest(ctx, u, Number(params.id));
      return { ...q, result: await processNow(ctx) };
    }, { summary: 'Send a signed test event now', permission: 'webhooks.manage', status: OK }),
    R('GET', '/api/webhooks/deliveries', (ctx, u, { query }) => hooks.listDeliveries(ctx, u, { webhookId: query.webhookId ? Number(query.webhookId) : undefined, status: query.status, limit: query.limit }), { summary: 'Delivery log', permission: 'webhooks.manage' }),
    R('POST', '/api/webhooks/deliveries/process', async (ctx, u) => { requirePerm(u, 'webhooks.manage'); return processNow(ctx); }, { summary: 'Deliver due webhooks now', permission: 'webhooks.manage', status: OK }),
    R('POST', '/api/webhooks/deliveries/:id/retry', (ctx, u, { params }) => hooks.retryDelivery(ctx, u, Number(params.id)), { summary: 'Re-queue a failed delivery', permission: 'webhooks.manage', status: OK }),

    R('GET', '/api/audit/verify', (ctx, u) => { requirePerm(u, 'security.view'); return verifyAudit(ctx); }, { summary: 'Verify the audit-log hash chain; lists any tampered rows', permission: 'security.view' }),
    R('GET', '/api/security/overview', (ctx, u) => overview(ctx, u), { summary: 'Security posture: MFA coverage, lockouts, sessions, keys, webhooks', permission: 'security.view' }),
    R('GET', '/api/security/limits', (ctx) => publishedLimits(ctx), { summary: 'Published rate limits and session policy' }, { public: true }),
  ],
  hooks: Object.fromEntries(EVENTS.map((e) => [e, (ctx, payload) => { hooks.enqueueEvent(ctx, e, payload); }])),
  seed: (ctx) => s.seedDemoCredentials(ctx),
};
