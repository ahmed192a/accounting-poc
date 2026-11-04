import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError } from './helpers.js';
import { postEntry, reverseEntry, trialBalance, accountBalance, recentEntries } from '../src/ledger.js';
import * as ent from '../src/modules/entities/service.js';
import * as ledger from '../src/modules/ledger/service.js';

const make = (ctx, as, over = {}) => ent.createEntity(ctx, as('owner'), { code: 'BR1', name: 'Alexandria branch', nameAr: 'فرع الإسكندرية', kind: 'branch', ...over });

test('entities: the default entity exists and legacy posting still lands in it', () => {
  const { ctx } = setup();
  assert.equal(ctx.db.prepare('SELECT entity_id FROM journal_entries').get().entity_id, 1);
  const e = postEntry(ctx, { userId: 4, lines: [{ account: '5100', debit: 100 }, { account: '1000', credit: 100 }] });
  assert.equal(ctx.db.prepare('SELECT entity_id FROM journal_entries WHERE id = ?').get(e.id).entity_id, 1);
  assert.equal(ent.listEntities(ctx, setup().as('owner')).length, 1);
});

test('entities: create is validated, audited and needs entities.manage', () => {
  const { ctx, as } = setup();
  expectError(() => ent.createEntity(ctx, as('accountant'), { code: 'X', name: 'X' }), 'FORBIDDEN');
  expectError(() => ent.createEntity(ctx, as('owner'), { code: '', name: 'X' }), 'BAD_INPUT');
  expectError(() => ent.createEntity(ctx, as('owner'), { code: 'a b', name: 'X' }), 'BAD_INPUT');
  expectError(() => ent.createEntity(ctx, as('owner'), { code: 'X', name: 'X', currency: 'ZZZ' }), 'UNKNOWN_CURRENCY');
  expectError(() => ent.createEntity(ctx, as('owner'), { code: 'X', name: 'X', fiscalYearStartMonth: 13 }), 'BAD_INPUT');
  const { id } = make(ctx, as);
  expectError(() => make(ctx, as), 'DUPLICATE');
  const row = ctx.db.prepare("SELECT user_id, new_value FROM audit_log WHERE action = 'entity.created'").get();
  assert.equal(row.user_id, 1);
  assert.equal(JSON.parse(row.new_value).code, 'BR1');
  assert.ok(id > 1);
});

test('entities: postings and reports are scoped per entity, the whole ledger stays balanced', () => {
  const { ctx, as } = setup();
  const { id } = make(ctx, as);
  postEntry(ctx, { userId: 4, entityId: id, lines: [{ account: '1000', debit: 70000 }, { account: '4000', credit: 70000 }] });
  postEntry(ctx, { userId: 4, lines: [{ account: '5100', debit: 3000 }, { account: '1000', credit: 3000 }] });
  assert.equal(accountBalance(ctx.db, '1000', { entityId: id }).net, 70000);
  assert.equal(accountBalance(ctx.db, '1000', { entityId: 1 }).net, 1000000 - 3000);
  assert.equal(trialBalance(ctx.db, { entityId: id }).rows.find((r) => r.code === '4000').credit, 70000);
  assert.equal(trialBalance(ctx.db, { entityId: id }).rows.find((r) => r.code === '5100').debit, 0);
  assert.ok(trialBalance(ctx.db, { entityId: id }).balanced && trialBalance(ctx.db, { entityId: 1 }).balanced && trialBalance(ctx.db).balanced);
  assert.equal(recentEntries(ctx.db, 10, { entityId: id }).length, 1);
  // the report route-level function defaults to entity 1 and accepts entityId
  assert.equal(ledger.reports(ctx, as('auditor'), {}).trialBalance.rows.find((r) => r.code === '4000').credit, 0);
  assert.equal(ledger.reports(ctx, as('auditor'), { entityId: String(id) }).profitAndLoss.totalRevenue, 70000);
  assert.equal(ledger.reports(ctx, as('auditor'), { entityId: String(id), asOf: '2000-01-01' }).profitAndLoss.totalRevenue, 0);
});

test('entities: unknown or inactive entities cannot be posted to, but old entries can still be reversed', () => {
  const { ctx, as } = setup();
  const { id } = make(ctx, as);
  const e = postEntry(ctx, { userId: 4, entityId: id, lines: [{ account: '1000', debit: 500 }, { account: '4000', credit: 500 }] });
  expectError(() => postEntry(ctx, { userId: 4, entityId: 99, lines: [{ account: '1000', debit: 5 }, { account: '4000', credit: 5 }] }), 'ENTITY_NOT_FOUND');
  ent.updateEntity(ctx, as('owner'), id, { active: false });
  expectError(() => postEntry(ctx, { userId: 4, entityId: id, lines: [{ account: '1000', debit: 5 }, { account: '4000', credit: 5 }] }), 'ENTITY_INACTIVE');
  reverseEntry(ctx, 4, e.id, 'Opened by mistake');
  assert.equal(accountBalance(ctx.db, '1000', { entityId: id }).net, 0);
  expectError(() => ent.updateEntity(ctx, as('owner'), 1, { active: false }), 'ENTITY_PROTECTED');
});

test('entities: user access restricts an entity; the owner (entities.manage) always gets in', () => {
  const { ctx, as } = setup();
  const { id } = make(ctx, as);
  const input = { entityId: id, lines: [{ account: '1000', debit: 100 }, { account: '4000', credit: 100 }] };
  assert.ok(ledger.manualEntry(ctx, as('accountant'), input).id, 'open to everyone while no access rows exist');
  ent.setEntityUsers(ctx, as('owner'), id, [1]);
  expectError(() => ledger.manualEntry(ctx, as('accountant'), input), 'ENTITY_FORBIDDEN');
  expectError(() => ledger.reports(ctx, as('accountant'), { entityId: id }), 'ENTITY_FORBIDDEN');
  assert.ok(ledger.manualEntry(ctx, as('owner'), input).id);
  assert.deepEqual(ent.listEntities(ctx, as('accountant')).map((e) => e.id), [1]);
  ent.setEntityUsers(ctx, as('owner'), id, [1, 4]);
  assert.ok(ledger.manualEntry(ctx, as('accountant'), input).id);
  // an entry in the restricted entity cannot be reversed by someone without access
  ent.setEntityUsers(ctx, as('owner'), id, [1]);
  const last = ctx.db.prepare('SELECT MAX(id) AS id FROM journal_entries').get().id;
  expectError(() => ledger.reverse(ctx, as('accountant'), last, 'x'), 'ENTITY_FORBIDDEN');
  expectError(() => ent.setEntityUsers(ctx, as('accountant'), id, [4]), 'FORBIDDEN');
  expectError(() => ent.setEntityUsers(ctx, as('owner'), id, [999]), 'NOT_FOUND');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'entity.access_changed'").get().n, 3);
});

test('entities: fiscal year settings and ranges', () => {
  const { ctx, as } = setup();
  assert.deepEqual(ent.fiscalRange(1, 2025), { start: '2025-01-01', end: '2025-12-31' });
  assert.deepEqual(ent.fiscalRange(7, 2026), { start: '2025-07-01', end: '2026-06-30' });
  assert.deepEqual(ent.fiscalRange(3, 2024), { start: '2023-03-01', end: '2024-02-29' });
  assert.equal(ent.fiscalYearOf(7, '2025-07-01'), 2026);
  assert.equal(ent.fiscalYearOf(7, '2026-06-30'), 2026);
  assert.equal(ent.fiscalYearOf(1, '2026-06-30'), 2026);
  ent.setFiscal(ctx, as('owner'), 1, { startMonth: 7 });
  assert.equal(ent.getFiscal(ctx, as('accountant'), 1).startMonth, 7);
  expectError(() => ent.setFiscal(ctx, as('owner'), 1, { startMonth: 0 }), 'BAD_INPUT');
  expectError(() => ent.setFiscal(ctx, as('accountant'), 1, { startMonth: 2 }), 'FORBIDDEN');
});

test('ledger: manual entry validates the entity and lines before touching the database', () => {
  const { ctx, as } = setup();
  expectError(() => ledger.manualEntry(ctx, as('clerk'), { lines: [] }), 'FORBIDDEN');
  expectError(() => ledger.manualEntry(ctx, as('accountant'), { lines: 'nope' }), 'BAD_ENTRY');
  expectError(() => ledger.manualEntry(ctx, as('accountant'), { entityId: 42, lines: [{ account: '1000', debit: 1 }, { account: '4000', credit: 1 }] }), 'ENTITY_NOT_FOUND');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, 1);
});
