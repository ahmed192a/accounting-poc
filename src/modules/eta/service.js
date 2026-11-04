import { requirePerm, requireAny } from '../../permissions.js';
import * as eta from './adapter.js';

export function etaQueue(ctx, user) {
  requireAny(user, ['sales.view', 'sales.create', 'eta.manage']);
  return eta.queueView(ctx);
}
export function etaSync(ctx, user) {
  requireAny(user, ['sales.create', 'eta.manage']);
  return eta.syncQueue(ctx);
}
export function etaSetOnline(ctx, user, online) {
  requirePerm(user, 'eta.manage');
  return eta.setOnline(ctx, user.id, !!online);
}

export function widgets(ctx, user) {
  const has = (p) => user.permissions.has(p);
  return has('sales.create') || has('eta.manage') ? { eta: eta.queueView(ctx) } : {};
}
