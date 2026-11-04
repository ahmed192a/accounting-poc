import * as s from './service.js';
import { EVENTS } from '../../hooks.js';
import { seedSettings } from './config.js';
import { listAdapters } from './adapters/index.js';
import { requirePerm } from '../../permissions.js';

// Tax and compliance: e-invoice documents with a hash chain, item codes, ETA registration wizard, VAT.
// EVERYTHING that talks to a tax authority is a MOCK (see docs/tax.md); formats, rates, windows are UNVERIFIED.
const id = (r) => Number(r.params.id);
const route = (method, path, permission, summary, handler) => ({ method, path, handler, meta: { summary, permission } });

export default {
  name: 'tax',
  permissions: {
    'tax.view': 'See tax documents, compliance status and VAT rates',
    'tax.submit': 'Submit, retry, cancel and correct tax documents (MOCK authority)',
    'tax.configure': 'Configure tax settings, item codes, credentials and the registration wizard',
    'tax.vat_return': 'Prepare VAT returns and record VAT on bills',
  },
  roleGrants: {
    manager: ['tax.view', 'tax.submit', 'tax.configure', 'tax.vat_return'],
    accountant: ['tax.view', 'tax.submit', 'tax.vat_return'],
    auditor: ['tax.view'],
    admin: ['tax.view', 'tax.configure'],
  },
  exportTables: ['tax_documents', 'tax_item_codes', 'tax_parties', 'tax_vat_rates', 'tax_bill_tax', 'tax_wizard_steps'], // never tax_secrets
  routes: [
    route('GET', '/api/tax/dashboard', 'tax.view', 'Compliance dashboard', (c, u) => s.dashboard(c, u)),
    route('GET', '/api/tax/settings', 'tax.view', 'Tax settings (no secrets)', (c, u) => s.getSettings(c, u)),
    route('PUT', '/api/tax/settings', 'tax.configure', 'Change tax settings, including the active adapter', (c, u, r) => s.updateSettings(c, u, r.body)),
    route('GET', '/api/tax/documents', 'tax.view', 'List tax documents', (c, u, r) => s.listDocuments(c, u, r.query)),
    route('GET', '/api/tax/documents/:id', 'tax.view', 'One tax document with its payload and QR', (c, u, r) => s.getDocument(c, u, id(r))),
    route('POST', '/api/tax/documents/:id/retry', 'tax.submit', 'Retry submitting a queued or rejected document', (c, u, r) => s.retryDocument(c, u, id(r))),
    route('POST', '/api/tax/documents/:id/cancel', 'tax.submit', 'Cancel a document within the cancellation window', (c, u, r) => s.cancelDocument(c, u, id(r), r.body.reason)),
    route('POST', '/api/tax/documents/:id/reissue', 'tax.submit', 'Reissue a rejected document after fixing the cause', (c, u, r) => s.reissueDocument(c, u, id(r))),
    route('POST', '/api/tax/documents/:id/notes', 'tax.submit', 'Credit or debit note against an invoice document', (c, u, r) => s.createNote(c, u, { ...r.body, documentId: id(r) })),
    route('POST', '/api/tax/sync', 'tax.submit', 'Submit queued documents and poll submitted ones', (c, u) => s.syncDocuments(c, u)),
    route('GET', '/api/tax/chain', 'tax.view', 'Verify the document hash chain', (c, u) => s.verifyChain(c, u)),
    route('GET', '/api/tax/export', 'tax.view', 'JSON export of submitted documents (retention)', (c, u) => s.exportDocuments(c, u)),
    route('GET', '/api/tax/adapters', 'tax.view', 'Available (mock) tax adapters', (c, u) => { requirePerm(u, 'tax.view'); return listAdapters(); }),
    route('GET', '/api/tax/items', 'tax.view', 'Items with their GS1/EGS code status', (c, u) => s.listItemCodes(c, u)),
    route('PUT', '/api/tax/items/:sku/code', 'tax.configure', 'Map an item to a GS1/EGS code', (c, u, r) => s.setItemCode(c, u, r.params.sku, r.body.code)),
    route('POST', '/api/tax/items/import', 'tax.configure', 'Bulk CSV import of item codes (all or nothing)', (c, u, r) => s.importItemCodes(c, u, r.body.csv)),
    route('GET', '/api/tax/parties', 'tax.view', 'Customer tax ids', (c, u) => s.listParties(c, u)),
    route('PUT', '/api/tax/parties', 'tax.configure', 'Set a customer tax id', (c, u, r) => s.setParty(c, u, r.body.name, r.body.taxId)),
    route('GET', '/api/tax/wizard', 'tax.view', 'Registration wizard state', (c, u) => s.wizardView(c, u)),
    route('POST', '/api/tax/wizard/reset', 'tax.configure', 'Reset the registration wizard (reason required)', (c, u, r) => s.resetWizard(c, u, r.body.reason)),
    route('POST', '/api/tax/wizard/:step', 'tax.configure', 'Complete a wizard step', (c, u, r) => s.completeStep(c, u, r.params.step, r.body)),
    route('GET', '/api/tax/secrets', 'tax.configure', 'Which credentials are set (never their values)', (c, u) => s.listSecrets(c, u)),
    route('PUT', '/api/tax/secrets/:name', 'tax.configure', 'Save a credential, stored encrypted and never returned', (c, u, r) => s.setSecret(c, u, r.params.name, r.body.value)),
    route('GET', '/api/tax/vat/rates', 'tax.view', 'VAT rates', (c, u) => s.listRates(c, u)),
    route('PUT', '/api/tax/vat/rates/:code', 'tax.configure', 'Change a VAT rate', (c, u, r) => s.setRate(c, u, r.params.code, r.body)),
    route('GET', '/api/tax/vat/return', 'tax.vat_return', 'VAT return for a period from the ledger', (c, u, r) => s.vatReturn(c, u, r.query)),
    route('GET', '/api/tax/vat/bills/:id', 'tax.view', 'VAT information on a bill', (c, u, r) => s.getBillVat(c, u, id(r))),
    route('POST', '/api/tax/vat/bills/:id', 'tax.vat_return', 'Record VAT on a bill (posts input VAT once approved)', (c, u, r) => s.recordBillVat(c, u, id(r), r.body)),
    route('GET', '/api/tax/turnover-estimate', 'tax.vat_return', 'Simplified-regime turnover tax ESTIMATE', (c, u, r) => s.turnoverEstimate(c, u, r.query)),
    route('PUT', '/api/tax/turnover-bands', 'tax.configure', 'Configure turnover tax bands', (c, u, r) => s.setTurnoverBands(c, u, r.body.bands)),
    route('GET', '/api/tax/withholding', 'tax.view', 'Withholding tax placeholder', (c, u) => s.withholding(c, u)),
    route('PUT', '/api/tax/withholding', 'tax.configure', 'Configure withholding rates (placeholder)', (c, u, r) => s.setWithholding(c, u, r.body.rates)),
  ],
  hooks: {
    'invoice.created': s.onInvoiceCreated,
    'bill.approved': s.onBillApproved,
    // Registered only when the sales module has defined the event (the loader rejects unknown events).
    ...(EVENTS.includes('credit_note.created') ? { 'credit_note.created': s.onCreditNoteCreated } : {}),
  },
  widgets: s.widgets,
  seed(ctx) {
    seedSettings(ctx.db);
    ctx.db.prepare('INSERT OR IGNORE INTO accounts (code, name, name_ar, type) VALUES (?,?,?,?)').run('1400', 'VAT input (recoverable)', 'ضريبة القيمة المضافة على المشتريات', 'asset');
  },
};
