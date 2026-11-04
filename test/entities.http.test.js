import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, createSeededContext } from '../src/server.js';
import { startApp } from './helpers.js';

const OWNER = 1, MANAGER = 2, CLERK = 3, ACCOUNTANT = 4, AUDITOR = 5;

test('HTTP: entities, scoped entries and reports, access denial and the permission gates', async () => {
  const { server, call } = await startApp(createApp, createSeededContext());
  try {
    assert.equal((await call('GET', '/api/entities', CLERK)).status, 403);
    assert.equal((await call('POST', '/api/entities', ACCOUNTANT, { code: 'B', name: 'B' })).status, 403);
    const made = await call('POST', '/api/entities', OWNER, { code: 'B', name: 'Branch B', nameAr: 'فرع ب' });
    assert.equal(made.status, 201);
    const id = made.body.id;
    assert.equal((await call('GET', '/api/entities', AUDITOR)).body.length, 2);

    const posted = await call('POST', '/api/entries', ACCOUNTANT, { entityId: id, memo: 'Branch sale', lines: [{ account: '1000', debit: 5000 }, { account: '4000', credit: 5000 }] });
    assert.equal(posted.status, 201);
    assert.equal((await call('GET', `/api/reports?entityId=${id}`, AUDITOR)).body.profitAndLoss.totalRevenue, 5000);
    assert.equal((await call('GET', '/api/reports', AUDITOR)).body.profitAndLoss.totalRevenue, 0);
    assert.equal((await call('GET', `/api/entries?entityId=${id}`, ACCOUNTANT)).body.length, 1);

    await call('PUT', `/api/entities/${id}/users`, OWNER, { userIds: [OWNER] });
    const denied = await call('GET', `/api/reports?entityId=${id}`, AUDITOR);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'ENTITY_FORBIDDEN');
    assert.equal((await call('GET', '/api/entities/consolidation', AUDITOR)).body.entities.length, 1);
    assert.equal((await call('GET', '/api/entities/consolidation', OWNER)).body.entities.length, 2);
  } finally { server.close(); }
});

test('HTTP: currencies, rates, FX conversion, revaluation and the mock provider', async () => {
  const { server, call } = await startApp(createApp, createSeededContext());
  try {
    assert.equal((await call('POST', '/api/fx/rates', CLERK, { currency: 'USD', date: '2026-01-01', rate: '48' })).status, 403);
    assert.equal((await call('POST', '/api/fx/rates', ACCOUNTANT, { currency: 'USD', date: '2026-01-01', rate: '48' })).status, 201);
    assert.equal((await call('GET', '/api/fx/convert?amount=100&from=USD&to=EGP&date=2026-01-02', AUDITOR)).body.amount, 4800);
    assert.equal((await call('GET', '/api/fx/convert?amount=100&from=USD&to=EGP&date=2020-01-02', AUDITOR)).body.error.code, 'NO_RATE');
    const fetched = await call('POST', '/api/fx/rates/fetch', ACCOUNTANT, { date: '2026-02-01', currencies: ['USD'] });
    assert.equal(fetched.body.mock, true);
    assert.equal((await call('GET', '/api/fx/latest?date=2026-02-01', AUDITOR)).body.USD.rate.length > 0, true);
    await call('POST', '/api/entries', ACCOUNTANT, { date: '2026-01-02', lines: [{ account: '1000', currency: 'USD', fxAmount: 10000, side: 'debit' }, { account: '3000', credit: 480000 }] });
    assert.equal((await call('POST', '/api/fx/revalue', AUDITOR, { asOf: '2026-02-01' })).status, 403);
    const rv = await call('POST', '/api/fx/revalue', ACCOUNTANT, { asOf: '2026-02-01' });
    assert.equal(rv.status, 201);
    assert.equal(rv.body.gain + rv.body.loss > 0, true);
    assert.equal((await call('GET', '/api/reports', AUDITOR)).body.trialBalance.balanced, true);
  } finally { server.close(); }
});

test('HTTP: chart of accounts, CSV import, template, deletion rules and year-end closing', async () => {
  const { server, call } = await startApp(createApp, createSeededContext());
  try {
    assert.equal((await call('GET', '/api/coa', CLERK)).status, 403);
    assert.equal((await call('POST', '/api/coa', ACCOUNTANT, { code: '5990', name: 'Misc', nameAr: 'متفرقات', type: 'expense' })).status, 201);
    assert.equal((await call('POST', '/api/coa/import', ACCOUNTANT, { csv: 'code,name,type\n6100,Staff,expense\n6200,Bad,nope\n' })).body.error.code, 'IMPORT_INVALID');
    assert.equal((await call('GET', '/api/coa', ACCOUNTANT)).body.some((a) => a.code === '6100'), false);
    assert.equal((await call('POST', '/api/coa/template/apply', ACCOUNTANT, {})).status, 201);
    assert.equal((await call('GET', '/api/coa/template', ACCOUNTANT)).body.accounts.length > 25, true);
    await call('POST', '/api/entries', ACCOUNTANT, { date: '2025-05-05', lines: [{ account: '5990', debit: 700 }, { account: '1000', credit: 700 }] });
    const del = await call('DELETE', '/api/coa/5990', ACCOUNTANT);
    assert.equal(del.status, 409);
    assert.equal(del.body.error.code, 'ACCOUNT_HAS_HISTORY');
    assert.equal((await call('PATCH', '/api/coa/5990', ACCOUNTANT, { active: false })).body.active, false);
    assert.equal((await call('POST', '/api/entries', ACCOUNTANT, { lines: [{ account: '5990', debit: 5 }, { account: '1000', credit: 5 }] })).body.error.code, 'ACCOUNT_INACTIVE');

    assert.equal((await call('POST', '/api/ledger/close-year', ACCOUNTANT, { fiscalYear: 2025 })).status, 403);
    const closed = await call('POST', '/api/ledger/close-year', MANAGER, { fiscalYear: 2025 });
    assert.equal(closed.status, 201);
    assert.equal(closed.body.netProfit, -700);
    assert.equal((await call('GET', '/api/ledger/closings', AUDITOR)).body[0].reversed, false);
    const rr = await call('POST', `/api/ledger/closings/${closed.body.id}/reverse`, MANAGER, { reason: 'Reopen' }); assert.equal(rr.status, 201, JSON.stringify(rr.body));
    assert.equal((await call('GET', '/api/ledger/closings', AUDITOR)).body[0].reversed, true);
    assert.equal((await call('GET', '/api/ledger/fiscal', AUDITOR)).body.startMonth, 1);
  } finally { server.close(); }
});
