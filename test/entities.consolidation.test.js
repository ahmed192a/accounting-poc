import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError } from './helpers.js';
import { postEntry, trialBalance, accountBalance } from '../src/ledger.js';
import * as ent from '../src/modules/entities/service.js';
import * as fx from '../src/modules/entities/fx.js';
import * as cons from '../src/modules/entities/consolidation.js';

const D = '2099-12-31'; // after the demo opening balance, which is dated today
const sale = (ctx, entityId, amount) => postEntry(ctx, { userId: 4, entityId, date: '2026-03-01', lines: [{ account: '1000', debit: amount }, { account: '4000', credit: amount }] });
const row = (rep, code) => rep.rows.find((r) => r.code === code);

test('consolidation: EGP entities simply add up and balance', () => {
  const { ctx, as } = setup();
  const b = ent.createEntity(ctx, as('owner'), { code: 'B', name: 'Branch B' }).id;
  sale(ctx, 1, 100000);
  sale(ctx, b, 40000);
  const rep = cons.consolidate(ctx, as('auditor'), { asOf: D });
  assert.equal(row(rep, '4000').credit, 140000);
  assert.equal(row(rep, '1000').debit, 1000000 + 140000);
  assert.ok(rep.balanced);
  assert.equal(rep.netProfit, 140000);
  assert.equal(rep.translationAdjustment, 0);
  assert.deepEqual(rep.entities.map((e) => e.id), [1, b]);
  // one entity only
  assert.equal(row(cons.consolidate(ctx, as('auditor'), { asOf: D, entityIds: [b] }), '4000').credit, 40000);
});

test('consolidation: a USD entity is translated at the closing rate, the rest lands on 3100', () => {
  const { ctx, as } = setup();
  const us = ent.createEntity(ctx, as('owner'), { code: 'US', name: 'US co', currency: 'USD' }).id;
  fx.setRate(ctx, as('accountant'), { currency: 'USD', date: '2026-03-01', rate: '48.5' });
  postEntry(ctx, { userId: 4, entityId: us, date: '2026-03-01', lines: [{ account: '1000', debit: 10000 }, { account: '3000', credit: 10000 }] }); // USD 100.00
  const rep = cons.consolidate(ctx, as('auditor'), { asOf: D });
  assert.equal(row(rep, '1000').byEntity[us], 485000);
  assert.equal(row(rep, '3000').byEntity[us], -485000);
  assert.ok(rep.balanced);
  assert.equal(rep.entities.find((e) => e.id === us).rate, '48.5');
  // a P&L translated at a different average rate leaves a translation difference in 3100, not an imbalance
  sale(ctx, us, 10000);
  const avg = cons.consolidate(ctx, as('auditor'), { asOf: D, averageRates: { USD: '48' } });
  assert.equal(row(avg, '4000').credit, 480000);
  assert.equal(row(avg, '3100').credit, 5000);
  assert.equal(avg.translationAdjustment, -5000);
  assert.ok(avg.balanced);
  // report in USD instead: the EGP entity is translated the other way
  const usd = cons.consolidate(ctx, as('auditor'), { asOf: D, currency: 'USD' });
  assert.equal(row(usd, '1000').debit, Math.round(1000000 / 48.5) + 20000);
});

test('consolidation: rounding residue from translating many small balances is parked in 3100 and the report balances', () => {
  const { ctx, as } = setup();
  const us = ent.createEntity(ctx, as('owner'), { code: 'US', name: 'US co', currency: 'USD' }).id;
  fx.setRate(ctx, as('accountant'), { currency: 'USD', date: '2099-01-01', rate: '48.123456' });
  for (const [dr, cr] of [['1000', '4000'], ['1200', '4000'], ['5100', '2000'], ['5200', '2000']]) {
    postEntry(ctx, { userId: 4, entityId: us, date: '2026-03-01', lines: [{ account: dr, debit: 1 }, { account: cr, credit: 1 }] });
  }
  const rep = cons.consolidate(ctx, as('auditor'), { asOf: D, entityIds: [us] });
  assert.ok(rep.balanced);
  assert.equal(row(rep, '1000').debit, 48);        // 48.12 -> 48
  assert.equal(row(rep, '4000').credit, 96);       // 2 cents
  assert.equal(rep.translationAdjustment, (row(rep, '3100')?.debit ?? 0) - (row(rep, '3100')?.credit ?? 0));
  assert.equal(rep.totalDebit, rep.totalCredit);
});

test('intercompany: two mirrored entries tied by a group id; eliminations net to zero', () => {
  const { ctx, as } = setup();
  const b = ent.createEntity(ctx, as('owner'), { code: 'B', name: 'Branch B' }).id;
  const r = cons.postIntercompany(ctx, as('accountant'), { fromEntityId: 1, toEntityId: b, date: '2026-03-05', amount: 250000, memo: 'Working capital loan' });
  const g = ctx.db.prepare('SELECT * FROM entities_ic_groups WHERE id = ?').get(r.groupId);
  assert.deepEqual([g.from_entity_id, g.to_entity_id, g.amount_from, g.amount_to], [1, b, 250000, 250000]);
  const entries = ctx.db.prepare("SELECT id, entity_id, source_type, source_id FROM journal_entries WHERE source_type = 'intercompany' ORDER BY id").all();
  assert.deepEqual(entries.map((e) => [e.entity_id, e.source_id]), [[1, r.groupId], [b, r.groupId]]);
  assert.equal(accountBalance(ctx.db, '1500', { entityId: 1 }).net, 250000);
  assert.equal(accountBalance(ctx.db, '2500', { entityId: b }).net, -250000);
  assert.ok(trialBalance(ctx.db, { entityId: 1 }).balanced && trialBalance(ctx.db, { entityId: b }).balanced);
  const rep = cons.consolidate(ctx, as('auditor'), { asOf: D });
  assert.deepEqual(rep.eliminations, { receivable: 250000, payable: 250000, difference: 0 });
  assert.equal(row(rep, '1500'), undefined);
  assert.equal(row(rep, '2500'), undefined);
  assert.equal(row(rep, '1000').debit, 1000000 - 250000 + 250000); // cash left one entity and arrived in the other
  assert.ok(rep.balanced);
});

test('intercompany: across currencies the receivable and payable still eliminate after translation', () => {
  const { ctx, as } = setup();
  const us = ent.createEntity(ctx, as('owner'), { code: 'US', name: 'US co', currency: 'USD' }).id;
  fx.setRate(ctx, as('accountant'), { currency: 'USD', date: '2026-03-01', rate: '48.5' });
  const r = cons.postIntercompany(ctx, as('accountant'), { fromEntityId: 1, toEntityId: us, date: '2026-03-05', amount: 485000 });
  assert.equal(r.amountTo, 10000); // EGP 4,850.00 -> USD 100.00
  const rep = cons.consolidate(ctx, as('auditor'), { asOf: D });
  assert.equal(rep.eliminations.difference, 0);
  assert.ok(rep.balanced);
});

test('intercompany: reversing the group reverses both sides and the report is clean again', () => {
  const { ctx, as } = setup();
  const b = ent.createEntity(ctx, as('owner'), { code: 'B', name: 'Branch B' }).id;
  const r = cons.postIntercompany(ctx, as('accountant'), { fromEntityId: 1, toEntityId: b, amount: 1000, date: '2026-03-05' });
  expectError(() => cons.reverseIntercompany(ctx, as('accountant'), r.groupId, ''), 'REASON_REQUIRED');
  const rev = cons.reverseIntercompany(ctx, as('accountant'), r.groupId, 'Booked in error');
  assert.equal(rev.reversalIds.length, 2);
  assert.equal(accountBalance(ctx.db, '1500').net, 0);
  assert.equal(accountBalance(ctx.db, '2500').net, 0);
  expectError(() => cons.reverseIntercompany(ctx, as('accountant'), r.groupId, 'again'), 'ALREADY_REVERSED');
});

test('intercompany: a failing second leg rolls back the first (atomic) and bad input is refused', () => {
  const { ctx, as } = setup();
  const b = ent.createEntity(ctx, as('owner'), { code: 'B', name: 'Branch B' }).id;
  const count = () => ctx.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n;
  const before = count();
  expectError(() => cons.postIntercompany(ctx, as('accountant'), { fromEntityId: 1, toEntityId: b, amount: 500, borrowerAccount: '9999' }), 'UNKNOWN_ACCOUNT');
  assert.equal(count(), before);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM entities_ic_groups').get().n, 0);
  expectError(() => cons.postIntercompany(ctx, as('accountant'), { fromEntityId: 1, toEntityId: 1, amount: 500 }), 'BAD_INPUT');
  expectError(() => cons.postIntercompany(ctx, as('accountant'), { fromEntityId: 1, toEntityId: b, amount: 5.5 }), 'BAD_INPUT');
  ent.updateEntity(ctx, as('owner'), b, { active: false });
  expectError(() => cons.postIntercompany(ctx, as('accountant'), { fromEntityId: 1, toEntityId: b, amount: 500 }), 'ENTITY_INACTIVE');
  assert.equal(count(), before);
});

test('consolidation and intercompany permission denials', () => {
  const { ctx, as } = setup();
  const b = ent.createEntity(ctx, as('owner'), { code: 'B', name: 'Branch B' }).id;
  expectError(() => cons.consolidate(ctx, as('clerk'), {}), 'FORBIDDEN');
  expectError(() => cons.postIntercompany(ctx, as('auditor'), { fromEntityId: 1, toEntityId: b, amount: 5 }), 'FORBIDDEN');
  ent.setEntityUsers(ctx, as('owner'), b, [1]);
  expectError(() => cons.postIntercompany(ctx, as('accountant'), { fromEntityId: 1, toEntityId: b, amount: 5 }), 'ENTITY_FORBIDDEN');
  expectError(() => cons.consolidate(ctx, as('auditor'), { entityIds: [1, b] }), 'ENTITY_FORBIDDEN');
  // without an explicit list, the report covers only what the user may see
  assert.deepEqual(cons.consolidate(ctx, as('auditor'), {}).entities.map((e) => e.id), [1]);
  expectError(() => cons.consolidate(ctx, as('auditor'), { asOf: 'yesterday' }), 'BAD_DATE');
});
