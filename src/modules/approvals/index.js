import * as eng from './engine.js';
import * as rules from './rules.js';
import * as del from './delegations.js';
import * as notes from './notifications.js';
import { seed } from './seed.js';

const r = (method, path, summary, permission, handler) => ({ method, path, handler, meta: { summary, permission } });

// Configurable approval rules, ordered steps (sequential or parallel), delegation, escalation, separation of duties,
// history and in-app notifications. Bills are the first document type; the engine is generic over `doc_type`.
export default {
  name: 'approvals',
  permissions: {
    'approvals.view': 'See approval requests, rules, delegations and your own notifications',
    'approvals.configure': 'Create and edit approval rules, run escalations, delegate for others',
    'approvals.delegate': 'Delegate your own approvals to someone while you are away',
  },
  roleGrants: {
    manager: ['approvals.view', 'approvals.delegate'],
    clerk: ['approvals.view'],
    accountant: ['approvals.view'],
    auditor: ['approvals.view'],
  },
  routes: [
    r('GET', '/api/approvals', 'List approval requests (?status, ?mine=1 for the ones you can act on)', 'approvals.view', (ctx, u, q) => eng.listRequests(ctx, u, { status: q.query.status, mine: q.query.mine === '1' })),
    r('GET', '/api/approvals/:id', 'One request with steps and full history', 'approvals.view', (ctx, u, q) => eng.getRequestDetail(ctx, u, Number(q.params.id))),
    r('POST', '/api/approvals/:id/approve', 'Approve the open step you are responsible for (or hold by delegation)', 'purchases.approve', (ctx, u, q) => eng.approveStep(ctx, u, Number(q.params.id), q.body)),
    r('POST', '/api/approvals/:id/reject', 'Reject the request (reason required)', 'purchases.approve', (ctx, u, q) => eng.rejectStep(ctx, u, Number(q.params.id), q.body)),
    r('POST', '/api/approvals/escalations/run', 'Escalate steps that waited longer than their limit (on demand)', 'approvals.configure', (ctx, u) => eng.processEscalations(ctx, u)),

    r('GET', '/api/approval-rules', 'List approval rules with their steps', 'approvals.view', (ctx, u) => rules.listRules(ctx, u)),
    r('POST', '/api/approval-rules', 'Create an approval rule', 'approvals.configure', (ctx, u, q) => rules.createRule(ctx, u, q.body)),
    r('PUT', '/api/approval-rules/:id', 'Replace a rule (requests in flight are unaffected)', 'approvals.configure', (ctx, u, q) => rules.updateRule(ctx, u, Number(q.params.id), q.body)),
    r('DELETE', '/api/approval-rules/:id', 'Deactivate a rule', 'approvals.configure', (ctx, u, q) => rules.deactivateRule(ctx, u, Number(q.params.id))),

    r('GET', '/api/approval-delegations', 'List delegations (all for administrators, else yours)', 'approvals.view', (ctx, u) => del.listDelegations(ctx, u)),
    r('POST', '/api/approval-delegations', 'Delegate approvals for a date range', 'approvals.delegate', (ctx, u, q) => del.createDelegation(ctx, u, q.body)),
    r('POST', '/api/approval-delegations/:id/revoke', 'Revoke a delegation', 'approvals.delegate', (ctx, u, q) => del.revokeDelegation(ctx, u, Number(q.params.id))),

    r('GET', '/api/notifications', 'Your in-app notifications', 'approvals.view', (ctx, u, q) => notes.listNotifications(ctx, u, { unread: q.query.unread === '1' })),
    r('POST', '/api/notifications/read-all', 'Mark all your notifications read', 'approvals.view', (ctx, u) => notes.markAllRead(ctx, u)),
    r('POST', '/api/notifications/:id/read', 'Mark one notification read', 'approvals.view', (ctx, u, q) => notes.markRead(ctx, u, Number(q.params.id))),
  ],
  exportTables: ['approvals_rules', 'approvals_rule_steps', 'approvals_requests', 'approvals_request_steps', 'approvals_delegations', 'approvals_history', 'approvals_notifications'],
  widgets: (ctx, user) => {
    if (!user.permissions.has('approvals.view')) return {};
    const n = notes.listNotifications(ctx, user);
    const todo = eng.listRequests(ctx, user, { status: 'pending', mine: true });
    return { approvalsInbox: { unread: n.unread, toAct: todo.length, items: n.items.slice(0, 5), todo, rules: rules.listRules(ctx, user), delegations: del.listDelegations(ctx, user) } };
  },
  seed,
};
