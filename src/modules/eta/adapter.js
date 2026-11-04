import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors.js';
import { audit } from '../../ledger.js';

// MOCK of the Egyptian Tax Authority e-receipt flow. It does NOT implement the real ETA
// protocol (signing, auth, schemas). It exists to prove the offline queue, the 24-hour
// submission window, and rejection handling, behind an adapter the real client can replace.
export const RECEIPT_WINDOW_MS = 24 * 3600 * 1000;
export const WARN_MS = 4 * 3600 * 1000;

export const isOnline = (db) => db.prepare("SELECT value FROM settings WHERE key = 'eta_online'").get()?.value === '1';

export function setOnline(ctx, userId, online) {
  ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('eta_online', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(online ? '1' : '0');
  audit(ctx, { userId, action: 'eta.connection', newValue: { online } });
  return { online };
}

export function buildReceipt(sale, items, issuedAtMs) {
  return {
    receiptNumber: `R-${sale.id}`,
    dateTimeIssued: new Date(issuedAtMs).toISOString(),
    currency: 'EGP',
    items: items.map((i) => ({ description: i.name, itemCode: i.eta_code, quantity: i.qty, unitPrice: i.price })),
    totalSales: sale.subtotal,
    vat: sale.vat,
    total: sale.total,
    mock: true,
  };
}

// Adapter interface: submit(db, payload) -> { status: 'Valid', uuid } | { status: 'Rejected', reason }; throws ETA_UNREACHABLE.
export function mockSubmit(db, payload) {
  if (!isOnline(db)) throw new AppError(503, 'ETA_UNREACHABLE', 'ETA is unreachable');
  const missing = payload.items.filter((i) => !i.itemCode);
  if (missing.length) {
    return { status: 'Rejected', reason: `Missing EGS/GS1 item code for: ${missing.map((i) => i.description).join(', ')}` };
  }
  return { status: 'Valid', uuid: randomUUID() };
}

function attempt(ctx, row) {
  let res;
  try {
    res = mockSubmit(ctx.db, JSON.parse(row.payload));
  } catch (e) {
    if (e.code === 'ETA_UNREACHABLE') return 'queued';
    throw e;
  }
  if (res.status === 'Valid') {
    ctx.db.prepare("UPDATE receipts SET status = 'submitted', uuid = ?, submitted_at = ?, reject_reason = NULL WHERE id = ?").run(res.uuid, ctx.now(), row.id);
    audit(ctx, { action: 'receipt.submitted', type: 'receipt', id: row.id, newValue: { uuid: res.uuid } });
    return 'submitted';
  }
  ctx.db.prepare("UPDATE receipts SET status = 'rejected', reject_reason = ? WHERE id = ?").run(res.reason, row.id);
  audit(ctx, { action: 'receipt.rejected', type: 'receipt', id: row.id, newValue: { reason: res.reason } });
  return 'rejected';
}

export function queueReceipt(ctx, sale, items) {
  const now = ctx.now();
  const payload = buildReceipt(sale, items, now);
  const res = ctx.db
    .prepare("INSERT INTO receipts (sale_id, payload, status, created_at, deadline_at) VALUES (?,?, 'queued', ?, ?)")
    .run(sale.id, JSON.stringify(payload), now, now + RECEIPT_WINDOW_MS);
  const id = Number(res.lastInsertRowid);
  const status = attempt(ctx, { id, payload: JSON.stringify(payload) });
  return { id, status };
}

// Process everything still queued, oldest first. Stops quietly if ETA is unreachable.
export function syncQueue(ctx) {
  const rows = ctx.db.prepare("SELECT id, payload FROM receipts WHERE status = 'queued' ORDER BY id").all();
  const result = { submitted: 0, rejected: 0, stillQueued: 0 };
  for (const row of rows) {
    const s = attempt(ctx, row);
    if (s === 'submitted') result.submitted++;
    else if (s === 'rejected') result.rejected++;
    else result.stillQueued++;
  }
  return result;
}

export function queueView(ctx) {
  const now = ctx.now();
  const rows = ctx.db
    .prepare('SELECT id, sale_id, status, uuid, reject_reason, created_at, deadline_at, submitted_at FROM receipts ORDER BY id DESC LIMIT 50')
    .all()
    .map((r) => {
      const msLeft = r.status === 'submitted' ? null : r.deadline_at - now;
      let state = r.status;
      if (r.status === 'queued') state = msLeft < 0 ? 'overdue' : msLeft <= WARN_MS ? 'due_soon' : 'queued';
      if (r.status === 'rejected' && msLeft < 0) state = 'overdue';
      return { ...r, msLeft, state };
    });
  const waiting = rows.filter((r) => r.status !== 'submitted');
  return {
    online: isOnline(ctx.db),
    counts: {
      submitted: rows.filter((r) => r.status === 'submitted').length,
      waiting: waiting.length,
      overdue: rows.filter((r) => r.state === 'overdue').length,
      dueSoon: rows.filter((r) => r.state === 'due_soon').length,
    },
    receipts: rows,
  };
}
