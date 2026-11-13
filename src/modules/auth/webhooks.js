import { AppError } from '../../errors.js';
import { tx, audit } from '../../ledger.js';
import { EVENTS } from '../../hooks.js';
import { requirePerm } from '../../permissions.js';
import { cfg } from './config.js';
import { randomToken, hmacHex, encryptSecret, decryptSecret } from './crypto.js';
import { assertSafeUrlSyntax, assertSafeUrl } from './ssrf.js';
import { enqueue } from '../jobs/queue.js';

// Outbound webhooks. Subscribed to the module hook events (src/hooks.js). A hook enqueues one delivery row per
// subscribed webhook INSIDE the emitting transaction (a rolled-back sale delivers nothing). Delivery itself is
// asynchronous: processDeliveries() runs on demand (POST /api/webhooks/deliveries/process) and on an unref'd interval.
//
// Signature: header  x-webhook-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
// Delivery is a job of the jobs kernel (src/modules/jobs, docs/jobs.md): kind 'webhooks.deliver', woken whenever a delivery row is added and
// on a schedule. auth_webhook_deliveries is this feature's outbox (one row per endpoint, own retry state and delivery log).
// Receivers should recompute it over the raw body and reject timestamps older than a few minutes.

export const SIGNATURE_HEADER = 'x-webhook-signature';
export const sign = (secret, timestampSec, body) => `t=${timestampSec},v1=${hmacHex(secret, `${timestampSec}.${body}`)}`;

const validEvents = (events) => {
  const list = events == null ? ['*'] : events;
  if (!Array.isArray(list) || !list.length) throw new AppError(400, 'BAD_INPUT', 'events must be a non-empty list or ["*"]');
  for (const e of list) if (e !== '*' && !EVENTS.includes(e)) throw new AppError(400, 'BAD_INPUT', `Unknown event "${e}" (known: ${EVENTS.join(', ')})`);
  return [...new Set(list)];
};

const view = (w) => ({ id: w.id, url: w.url, events: JSON.parse(w.events), description: w.description, active: !!w.active, createdAt: w.created_at });

export function createWebhook(ctx, actor, { url, events, description } = {}) {
  requirePerm(actor, 'webhooks.manage');
  const u = assertSafeUrlSyntax(url, { allowHttp: cfg(ctx).webhook.allowHttp });
  const list = validEvents(events);
  const secret = `whsec_${randomToken(24)}`;
  return tx(ctx.db, () => {
    const id = Number(ctx.db.prepare('INSERT INTO auth_webhooks (url, secret_enc, events, description, created_by, created_at) VALUES (?,?,?,?,?,?)')
      .run(u.href, encryptSecret(ctx, secret), JSON.stringify(list), String(description ?? '').slice(0, 200), actor.id, ctx.now()).lastInsertRowid);
    audit(ctx, { userId: actor.id, action: 'webhook.created', type: 'webhook', id, newValue: { url: u.href, events: list } });
    return { id, url: u.href, events: list, secret, note: 'Copy the signing secret now: it is not shown again.' };
  });
}

export function listWebhooks(ctx, actor) {
  requirePerm(actor, 'webhooks.manage');
  return ctx.db.prepare('SELECT * FROM auth_webhooks ORDER BY id').all().map((w) => ({
    ...view(w),
    pending: ctx.db.prepare("SELECT COUNT(*) AS n FROM auth_webhook_deliveries WHERE webhook_id = ? AND status = 'pending'").get(w.id).n,
    dead: ctx.db.prepare("SELECT COUNT(*) AS n FROM auth_webhook_deliveries WHERE webhook_id = ? AND status = 'dead'").get(w.id).n,
  }));
}

export function updateWebhook(ctx, actor, id, patch = {}) {
  requirePerm(actor, 'webhooks.manage');
  const w = ctx.db.prepare('SELECT * FROM auth_webhooks WHERE id = ?').get(id);
  if (!w) throw new AppError(404, 'NOT_FOUND', 'Webhook not found');
  const next = { url: w.url, events: JSON.parse(w.events), active: !!w.active, description: w.description };
  if (patch.url != null) next.url = assertSafeUrlSyntax(patch.url, { allowHttp: cfg(ctx).webhook.allowHttp }).href;
  if (patch.events != null) next.events = validEvents(patch.events);
  if (patch.active != null) next.active = !!patch.active;
  if (patch.description != null) next.description = String(patch.description).slice(0, 200);
  return tx(ctx.db, () => {
    ctx.db.prepare('UPDATE auth_webhooks SET url = ?, events = ?, active = ?, description = ? WHERE id = ?').run(next.url, JSON.stringify(next.events), next.active ? 1 : 0, next.description, id);
    audit(ctx, { userId: actor.id, action: 'webhook.updated', type: 'webhook', id, oldValue: view(w), newValue: next });
    return { id, ...next };
  });
}

export function deleteWebhook(ctx, actor, id) {
  requirePerm(actor, 'webhooks.manage');
  const w = ctx.db.prepare('SELECT * FROM auth_webhooks WHERE id = ?').get(id);
  if (!w) throw new AppError(404, 'NOT_FOUND', 'Webhook not found');
  return tx(ctx.db, () => {
    ctx.db.prepare('DELETE FROM auth_webhooks WHERE id = ?').run(id);
    ctx.db.prepare("UPDATE auth_webhook_deliveries SET status = 'dead', last_error = 'webhook deleted' WHERE webhook_id = ? AND status = 'pending'").run(id);
    audit(ctx, { userId: actor.id, action: 'webhook.deleted', type: 'webhook', id, oldValue: view(w) });
    return { id, deleted: true };
  });
}

export function listDeliveries(ctx, actor, { webhookId, status, limit = 50 } = {}) {
  requirePerm(actor, 'webhooks.manage');
  const rows = ctx.db.prepare(`SELECT id, webhook_id, event, status, attempts, next_attempt_at, last_status, last_error, created_at, delivered_at
                               FROM auth_webhook_deliveries WHERE (? IS NULL OR webhook_id = ?) AND (? IS NULL OR status = ?) ORDER BY id DESC LIMIT ?`)
    .all(webhookId ?? null, webhookId ?? null, status ?? null, status ?? null, Math.min(Number(limit) || 50, 200));
  return rows.map((r) => ({ id: r.id, webhookId: r.webhook_id, event: r.event, status: r.status, attempts: r.attempts, nextAttemptAt: r.status === 'pending' ? r.next_attempt_at : null,
    lastStatus: r.last_status, lastError: r.last_error, createdAt: r.created_at, deliveredAt: r.delivered_at }));
}

/** Called by the module hooks: queue the event for every active subscribed webhook. Never throws into the emitter. */
export function enqueueEvent(ctx, event, data) {
  try {
    const hooks = ctx.db.prepare('SELECT id, events FROM auth_webhooks WHERE active = 1').all()
      .filter((w) => { const e = JSON.parse(w.events); return e.includes('*') || e.includes(event); });
    if (!hooks.length) return 0;
    const now = ctx.now();
    const ins = ctx.db.prepare("INSERT INTO auth_webhook_deliveries (webhook_id, event, payload, status, next_attempt_at, created_at) VALUES (?,?,?,'pending',?,?)");
    for (const w of hooks) ins.run(w.id, event, JSON.stringify({ event, createdAt: new Date(now).toISOString(), data }), now, now);
    wake(ctx);
    return hooks.length;
  } catch {
    return 0; // delivery plumbing must never break the business operation that emitted the event
  }
}

/** Ask the jobs kernel to deliver soon. Never throws (delivery plumbing must not break the caller). */
export function wake(ctx) {
  try { enqueue(ctx, 'webhooks.deliver', {}, { uniqueKey: 'webhooks.deliver' }); } catch { /* the schedule still picks the rows up */ }
}

/** Job handler: deliver what is due; if rows remain pending for later (backoff), ask to run again then. */
export async function deliverJob(ctx) {
  const res = await processDeliveries(ctx, { fetchImpl: cfg(ctx).fetch ?? globalThis.fetch, resolve: cfg(ctx).resolve });
  const next = ctx.db.prepare("SELECT MIN(next_attempt_at) AS t FROM auth_webhook_deliveries WHERE status = 'pending'").get().t;
  return next == null ? res : { ...res, rerunAt: Math.max(next, ctx.now() + 1000) };
}

export function sendTest(ctx, actor, id) {
  requirePerm(actor, 'webhooks.manage');
  const w = ctx.db.prepare('SELECT id FROM auth_webhooks WHERE id = ?').get(id);
  if (!w) throw new AppError(404, 'NOT_FOUND', 'Webhook not found');
  const now = ctx.now();
  const rid = Number(ctx.db.prepare("INSERT INTO auth_webhook_deliveries (webhook_id, event, payload, status, next_attempt_at, created_at) VALUES (?,?,?,'pending',?,?)")
    .run(id, 'webhook.test', JSON.stringify({ event: 'webhook.test', createdAt: new Date(now).toISOString(), data: { hello: 'from accounting' } }), now, now).lastInsertRowid);
  wake(ctx);
  return { deliveryId: rid };
}

export function retryDelivery(ctx, actor, id) {
  requirePerm(actor, 'webhooks.manage');
  const d = ctx.db.prepare('SELECT id, status FROM auth_webhook_deliveries WHERE id = ?').get(id);
  if (!d) throw new AppError(404, 'NOT_FOUND', 'Delivery not found');
  if (d.status === 'delivered') throw new AppError(409, 'ALREADY_DELIVERED', 'Already delivered');
  ctx.db.prepare("UPDATE auth_webhook_deliveries SET status = 'pending', next_attempt_at = ?, attempts = 0 WHERE id = ?").run(ctx.now(), id);
  wake(ctx);
  audit(ctx, { userId: actor.id, action: 'webhook.delivery_requeued', type: 'webhook_delivery', id });
  return { id, status: 'pending' };
}

/**
 * Deliver due webhooks. `fetchImpl` and `resolve` are injectable (tests never touch the network).
 * Redirects are never followed (a redirect could point at an internal address). Failures back off exponentially:
 * baseDelay * 2^(attempt-1), capped, and the delivery turns 'dead' after maxAttempts.
 */
export async function processDeliveries(ctx, { fetchImpl = globalThis.fetch, resolve, limit = 25 } = {}) {
  const c = cfg(ctx).webhook, { db } = ctx;
  const due = db.prepare("SELECT id FROM auth_webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?").all(ctx.now(), limit);
  const out = { attempted: 0, delivered: 0, failed: 0, dead: 0 };
  for (const { id } of due) {
    // claim with a lease so the interval and a manual run never deliver the same row twice
    const claim = db.prepare("UPDATE auth_webhook_deliveries SET next_attempt_at = ? WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?").run(ctx.now() + 60_000, id, ctx.now());
    if (!claim.changes) continue;
    const d = db.prepare('SELECT * FROM auth_webhook_deliveries WHERE id = ?').get(id);
    const w = db.prepare('SELECT * FROM auth_webhooks WHERE id = ?').get(d.webhook_id);
    out.attempted++;
    let status = null, error = null;
    if (!w || !w.active) error = 'webhook missing or disabled';
    else {
      try {
        await assertSafeUrl(w.url, { allowHttp: c.allowHttp, ...(resolve ? { resolve } : {}) });
        const t = Math.floor(ctx.now() / 1000);
        const res = await fetchImpl(w.url, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(c.timeoutMs),
          headers: {
            'content-type': 'application/json', 'user-agent': 'accounting-webhooks/1',
            'x-webhook-id': String(d.id), 'x-webhook-event': d.event, 'x-webhook-timestamp': String(t),
            [SIGNATURE_HEADER]: sign(decryptSecret(ctx, w.secret_enc), t, d.payload),
          },
          body: d.payload,
        });
        status = res.status;
        try { await res.body?.cancel?.(); } catch { /* ignore */ }
        if (status < 200 || status >= 300) error = status >= 300 && status < 400 ? `redirect (${status}) not followed` : `HTTP ${status}`;
      } catch (e) {
        error = String(e.message ?? e).slice(0, 200);
      }
    }
    const attempts = d.attempts + 1, now = ctx.now();
    if (!error) {
      db.prepare("UPDATE auth_webhook_deliveries SET status = 'delivered', attempts = ?, last_status = ?, last_error = NULL, delivered_at = ? WHERE id = ?").run(attempts, status, now, id);
      out.delivered++;
    } else if (attempts >= c.maxAttempts || !w) {
      db.prepare("UPDATE auth_webhook_deliveries SET status = 'dead', attempts = ?, last_status = ?, last_error = ? WHERE id = ?").run(attempts, status, error, id);
      out.dead++;
    } else {
      const delay = Math.min(c.baseDelayMs * 2 ** (attempts - 1), c.maxDelayMs);
      db.prepare('UPDATE auth_webhook_deliveries SET attempts = ?, last_status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?').run(attempts, status, error, now + delay, id);
      out.failed++;
    }
  }
  return out;
}
