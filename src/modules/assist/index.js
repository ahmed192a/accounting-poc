import * as s from './service.js';
import { providerNames } from './providers.js';
import { requirePerm } from '../../permissions.js';

const r = (method, path, summary, permission, handler) => ({ method, path, handler, meta: { summary, permission } });

// Document intake with a MOCK extractor (no OCR, no real AI): suggestions are reviewed by a person and never post on their own.
export default {
  name: 'assist',
  permissions: {
    'assist.use': 'Paste receipt text into the intake queue and see your own items',
    'assist.review': 'Review, edit, accept, reject and undo suggestions; see accuracy and learned rules',
  },
  roleGrants: {
    clerk: ['assist.use', 'assist.review'],
    accountant: ['assist.use'],
  },
  exportTables: ['assist_items', 'assist_rules'],
  routes: [
    r('POST', '/api/assist/items', 'Submit pasted receipt / OCR text; returns a MOCK suggestion', 'assist.use', (ctx, u, q) => s.submitIntake(ctx, u, q.body)),
    r('GET', '/api/assist/items', 'The review queue (?status); without assist.review only your own items', 'assist.use', (ctx, u, q) => s.listItems(ctx, u, q.query)),
    r('GET', '/api/assist/items/:id', 'One item with confidence and reasons', 'assist.use', (ctx, u, q) => s.getItem(ctx, u, Number(q.params.id))),
    r('POST', '/api/assist/items/:id/accept', 'Accept (optionally with edits): creates a bill that still needs approval', 'assist.review', (ctx, u, q) => s.acceptItem(ctx, u, Number(q.params.id), q.body)),
    r('POST', '/api/assist/items/:id/reject', 'Reject a suggestion (reason required)', 'assist.review', (ctx, u, q) => s.rejectItem(ctx, u, Number(q.params.id), q.body)),
    r('POST', '/api/assist/items/:id/undo', 'Undo an accepted suggestion by voiding its bill (reversal)', 'assist.review', (ctx, u, q) => s.undoItem(ctx, u, Number(q.params.id), q.body)),
    r('GET', '/api/assist/stats', 'Accuracy: accepted unchanged / edited / rejected, with sample size', 'assist.review', (ctx, u) => s.accuracyStats(ctx, u)),
    r('GET', '/api/assist/rules', 'Learned supplier -> category rules', 'assist.review', (ctx, u) => s.listRules(ctx, u)),
    r('DELETE', '/api/assist/rules/:id', 'Forget a learned rule', 'assist.review', (ctx, u, q) => s.deleteRule(ctx, u, Number(q.params.id))),
    { method: 'GET', path: '/api/assist/providers', handler: (ctx, u) => { requirePerm(u, 'assist.use'); return providerNames(); }, meta: { summary: 'Registered extraction providers (only a MOCK ships)', permission: 'assist.use' } },
  ],
  widgets: s.widgets,
};
