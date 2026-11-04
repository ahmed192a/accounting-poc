import * as s from './service.js';
import * as fx from './fx.js';
import * as coa from './coa.js';
import * as cons from './consolidation.js';
import { seed } from './seed.js';
import { requireAny } from '../../permissions.js';

// Multi-entity, multi-currency, consolidation and chart-of-accounts management. See docs/entities.md.
// Entity selection: `entityId` in the body or query (default 1). The X-Entity-Id header is a request for the security agent.
const route = (method, path, summary, permission, handler) => ({ method, path, handler, meta: { summary, permission } });

export default {
  name: 'entities',
  permissions: {
    'entities.view': 'See entities, rates and the consolidated report',
    'entities.manage': 'Create and edit entities, entity access and fiscal year settings',
    'currency.manage': 'Manage currencies and exchange rates, run FX revaluation',
    'coa.manage': 'Add, rename, deactivate and import chart-of-accounts accounts',
  },
  roleGrants: {
    manager: ['entities.view'],
    accountant: ['entities.view', 'currency.manage', 'coa.manage'],
    auditor: ['entities.view'],
  },
  routes: [
    route('GET', '/api/entities', 'List the entities you can access', 'entities.view', (c, u) => s.listEntities(c, u)),
    route('POST', '/api/entities', 'Create a company or branch', 'entities.manage', (c, u, r) => s.createEntity(c, u, r.body)),
    route('PATCH', '/api/entities/:id', 'Rename or (de)activate an entity', 'entities.manage', (c, u, r) => s.updateEntity(c, u, Number(r.params.id), r.body)),
    route('PUT', '/api/entities/:id/users', 'Set which users may enter an entity', 'entities.manage', (c, u, r) => s.setEntityUsers(c, u, Number(r.params.id), r.body.userIds)),
    route('PUT', '/api/entities/:id/fiscal', 'Set the fiscal year start month', 'entities.manage', (c, u, r) => s.setFiscal(c, u, Number(r.params.id), r.body)),
    route('GET', '/api/entities/consolidation', 'Consolidated trial balance with intercompany elimination', 'entities.view', (c, u, r) => cons.consolidate(c, u, { asOf: r.query.asOf, currency: r.query.currency, entityIds: r.query.entityIds })),
    route('POST', '/api/entities/intercompany', 'Post a mirrored intercompany transaction in two entities', 'ledger.post', (c, u, r) => cons.postIntercompany(c, u, r.body)),
    route('GET', '/api/entities/intercompany', 'List intercompany transactions', 'entities.view', (c, u) => cons.listIntercompany(c, u)),
    route('POST', '/api/entities/intercompany/:id/reverse', 'Reverse both sides of an intercompany transaction', 'ledger.reverse', (c, u, r) => cons.reverseIntercompany(c, u, Number(r.params.id), r.body.reason)),

    route('GET', '/api/currencies', 'List currencies', 'currency.manage', (c, u) => fx.listCurrencies(c, u)),
    route('POST', '/api/currencies', 'Add a currency', 'currency.manage', (c, u, r) => fx.addCurrency(c, u, r.body)),
    route('PATCH', '/api/currencies/:code', 'Activate or deactivate a currency', 'currency.manage', (c, u, r) => fx.setCurrencyActive(c, u, r.params.code, !!r.body.active)),
    route('GET', '/api/fx/rates', 'Exchange rate history', 'currency.manage', (c, u, r) => fx.listRates(c, u, r.query)),
    route('POST', '/api/fx/rates', 'Enter an exchange rate by date', 'currency.manage', (c, u, r) => fx.setRate(c, u, r.body)),
    route('GET', '/api/fx/latest', 'Latest rate per currency', 'entities.view', (c, u, r) => fx.latestRates(c, u, r.query.date)),
    route('POST', '/api/fx/rates/fetch', 'Fetch rates from a provider (mock by default)', 'currency.manage', (c, u, r) => fx.fetchRates(c, u, r.body)),
    route('GET', '/api/fx/convert', 'Convert an amount between currencies', 'entities.view', (c, u, r) => fx.convert(c, u, r.query)),
    route('POST', '/api/fx/revalue', 'Revalue foreign balances to 4900 FX gain / 5900 FX loss', 'currency.manage', (c, u, r) => fx.revalue(c, u, r.body)),

    route('GET', '/api/coa', 'Chart of accounts with hierarchy and status', 'coa.manage', (c, u) => coa.listAccounts(c, u)),
    route('POST', '/api/coa', 'Add an account', 'coa.manage', (c, u, r) => coa.addAccount(c, u, r.body)),
    route('PATCH', '/api/coa/:code', 'Rename, re-parent, deactivate or reactivate an account', 'coa.manage', (c, u, r) => coa.updateAccount(c, u, r.params.code, r.body)),
    route('DELETE', '/api/coa/:code', 'Delete an unused account (never one with history)', 'coa.manage', (c, u, r) => coa.deleteAccount(c, u, r.params.code)),
    route('POST', '/api/coa/import', 'Import accounts from CSV (all or nothing)', 'coa.manage', (c, u, r) => coa.importCsv(c, u, r.body)),
    route('GET', '/api/coa/template', 'Egyptian small-business starter chart (English and Arabic)', 'coa.manage', (c, u) => coa.starterTemplate(c, u)),
    route('POST', '/api/coa/template/apply', 'Add the starter chart (existing codes are skipped)', 'coa.manage', (c, u, r) => coa.applyStarterTemplate(c, u, r.body)),
  ],
  // Small widget: the entities the user can enter and the currencies, for the entity switcher and forms.
  widgets: (ctx, user) => {
    try { requireAny(user, ['entities.view', 'entities.manage', 'ledger.view', 'ledger.post']); } catch { return {}; }
    return { entities: { list: s.listEntities(ctx, user).map((e) => ({ id: e.id, code: e.code, name: e.name, nameAr: e.nameAr, currency: e.currency, active: e.active })) } };
  },
  seed,
};
