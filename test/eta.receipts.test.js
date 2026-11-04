import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError } from './helpers.js';
import * as etaSvc from '../src/modules/eta/service.js';
import * as sales from '../src/modules/sales/service.js';
import { accountBalance } from '../src/ledger.js';

test('online sale is submitted to the (mock) ETA immediately', () => {
  const { ctx, as } = setup();
  const r = sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'TEA-250', qty: 2 }] });
  assert.equal(r.receipt.status, 'submitted');
  const q = etaSvc.etaQueue(ctx, as('clerk'));
  assert.equal(q.counts.submitted, 1);
  assert.ok(q.receipts[0].uuid);
});

test('offline: the sale completes and posts, the receipt waits in the queue, then syncs', () => {
  const { ctx, as } = setup();
  etaSvc.etaSetOnline(ctx, as('manager'), false);
  const cashBefore = accountBalance(ctx.db, '1000').net;

  const r1 = sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'RICE-1K', qty: 3 }] });
  const r2 = sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'OIL-1L', qty: 1 }] });
  assert.equal(r1.receipt.status, 'queued');
  assert.equal(r2.receipt.status, 'queued');
  assert.equal(accountBalance(ctx.db, '1000').net, cashBefore + r1.sale.total + r2.sale.total); // the business kept trading

  assert.deepEqual(etaSvc.etaSync(ctx, as('clerk')), { submitted: 0, rejected: 0, stillQueued: 2 }); // still offline

  etaSvc.etaSetOnline(ctx, as('manager'), true);
  assert.deepEqual(etaSvc.etaSync(ctx, as('clerk')), { submitted: 2, rejected: 0, stillQueued: 0 });
  const q = etaSvc.etaQueue(ctx, as('clerk'));
  assert.equal(q.counts.waiting, 0);
});

test('the 24-hour window: queued receipts warn when due soon and flag overdue', () => {
  const { ctx, as } = setup();
  etaSvc.etaSetOnline(ctx, as('manager'), false);
  sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'TEA-250', qty: 1 }] });

  assert.equal(etaSvc.etaQueue(ctx, as('clerk')).receipts[0].state, 'queued');
  ctx.offsetMs += 21 * 3600 * 1000; // 21h later: inside the final 4h
  assert.equal(etaSvc.etaQueue(ctx, as('clerk')).receipts[0].state, 'due_soon');
  assert.equal(etaSvc.etaQueue(ctx, as('clerk')).counts.dueSoon, 1);
  ctx.offsetMs += 4 * 3600 * 1000; // 25h
  const q = etaSvc.etaQueue(ctx, as('clerk'));
  assert.equal(q.receipts[0].state, 'overdue');
  assert.equal(q.counts.overdue, 1);
});

test('a missing item code is rejected with a clear reason, and the sale still stands', () => {
  const { ctx, as } = setup();
  const r = sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'SPICE-LOOSE', qty: 1 }] });
  assert.equal(r.receipt.status, 'rejected');
  const row = etaSvc.etaQueue(ctx, as('clerk')).receipts[0];
  assert.match(row.reject_reason, /Missing EGS\/GS1 item code/);
  assert.ok(row.msLeft > 0); // still time to fix it
});

test('only users with the right permission can change the ETA connection', () => {
  const { ctx, as } = setup();
  expectError(() => etaSvc.etaSetOnline(ctx, as('clerk'), false), 'FORBIDDEN');
  expectError(() => etaSvc.etaQueue(ctx, as('admin')) && sales.quickSale(ctx, as('admin'), { items: [{ sku: 'TEA-250', qty: 1 }] }), 'FORBIDDEN');
});

test('quick sale validates input', () => {
  const { ctx, as } = setup();
  expectError(() => sales.quickSale(ctx, as('clerk'), { items: [] }), 'BAD_INPUT');
  expectError(() => sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'NOPE', qty: 1 }] }), 'UNKNOWN_ITEM');
  expectError(() => sales.quickSale(ctx, as('clerk'), { items: [{ sku: 'TEA-250', qty: 0 }] }), 'BAD_INPUT');
});
