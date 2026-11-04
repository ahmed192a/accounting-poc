import * as s from './service.js';
import { seed } from './seed.js';
import { hooks } from './reactions.js';

const id = (r) => Number(r.params.id);

// Sales: customers, quotes, invoices (lifecycle, payments, credit notes, print), quick sale, items.
export default {
  name: 'sales',
  permissions: {
    'sales.view': 'See invoices, quotes, customers and sales',
    'sales.create': 'Create invoices, quick sales and record payments',
    'sales.credit': 'Issue credit notes, void invoices, refund quick sales and override customer credit limits',
    'sales.discount': 'Give discounts on quick sales (up to the role limit)',
    'sales.configure': 'Manage the item catalogue and numbering/print settings',
    'customers.manage': 'Create and edit customers',
    'quotes.manage': 'Create, edit and convert quotes',
  },
  roleGrants: {
    manager: ['sales.view', 'sales.create', 'sales.credit', 'sales.discount', 'sales.configure', 'customers.manage', 'quotes.manage'],
    clerk: ['sales.view', 'sales.create', 'sales.discount', 'customers.manage', 'quotes.manage'],
    accountant: ['sales.view', 'sales.credit'],
    auditor: ['sales.view'],
  },
  roleLimits: { clerk: { 'sales.discount': 5000 } }, // clerks: up to 50.00 EGP off a sale; managers unlimited
  exportTables: ['sales_customers', 'sales_sequences', 'sales_payments', 'sales_payment_allocations', 'sales_credit_notes', 'sales_quotes', 'sales_parked'],
  hooks,
  routes: [
    // items catalogue
    { method: 'GET', path: '/api/items', handler: (ctx, u, r) => s.listItems(ctx, u, r.query), meta: { summary: 'Item catalogue (active items; ?all=1 for every item)', permission: 'sales.view' } },
    { method: 'POST', path: '/api/items', handler: (ctx, u, r) => s.createItem(ctx, u, r.body), meta: { summary: 'Create a catalogue item', permission: 'sales.configure' } },
    { method: 'PATCH', path: '/api/items/:sku', handler: (ctx, u, r) => s.updateItem(ctx, u, r.params.sku, r.body), meta: { summary: 'Edit an item (price, names, ETA code, active flag)', permission: 'sales.configure' } },
    { method: 'DELETE', path: '/api/items/:sku', handler: (ctx, u, r) => s.deleteItem(ctx, u, r.params.sku), meta: { summary: 'Delete an item never sold', permission: 'sales.configure' } },
    // settings
    { method: 'GET', path: '/api/sales/settings', handler: (ctx, u) => s.getSettings(ctx, u), meta: { summary: 'Numbering sequences and print settings', permission: 'sales.view' } },
    { method: 'PUT', path: '/api/sales/settings', handler: (ctx, u, r) => s.updateSettings(ctx, u, r.body), meta: { summary: 'Change numbering sequences and print settings', permission: 'sales.configure' } },
    // customers (static paths before :id)
    { method: 'GET', path: '/api/customers', handler: (ctx, u, r) => s.listCustomers(ctx, u, r.query), meta: { summary: 'List customers with balances', permission: 'sales.view' } },
    { method: 'POST', path: '/api/customers', handler: (ctx, u, r) => s.createCustomer(ctx, u, r.body), meta: { summary: 'Create a customer', permission: 'customers.manage' } },
    { method: 'GET', path: '/api/customers/aging', handler: (ctx, u, r) => s.aging(ctx, u, r.query), meta: { summary: 'Receivables aging: current, 1-30, 31-60, 61+ days past due', permission: 'sales.view' } },
    { method: 'GET', path: '/api/customers/:id', handler: (ctx, u, r) => s.getCustomer(ctx, u, id(r)), meta: { summary: 'One customer with balance', permission: 'sales.view' } },
    { method: 'PATCH', path: '/api/customers/:id', handler: (ctx, u, r) => s.updateCustomer(ctx, u, id(r), r.body), meta: { summary: 'Edit or deactivate a customer', permission: 'customers.manage' } },
    { method: 'DELETE', path: '/api/customers/:id', handler: (ctx, u, r) => s.deleteCustomer(ctx, u, id(r)), meta: { summary: 'Delete a customer without documents', permission: 'customers.manage' } },
    { method: 'GET', path: '/api/customers/:id/statement', handler: (ctx, u, r) => s.statement(ctx, u, id(r), r.query), meta: { summary: 'Customer statement with running balance', permission: 'sales.view' } },
    { method: 'GET', path: '/api/customers/:id/reminder', handler: (ctx, u, r) => s.reminder(ctx, u, id(r), r.query), meta: { summary: 'WhatsApp payment reminder (wa.me link, Arabic or English); nothing is sent', permission: 'sales.view' } },
    // quotes
    { method: 'GET', path: '/api/quotes', handler: (ctx, u) => s.listQuotes(ctx, u), meta: { summary: 'List quotes', permission: 'sales.view' } },
    { method: 'POST', path: '/api/quotes', handler: (ctx, u, r) => s.createQuote(ctx, u, r.body), meta: { summary: 'Create a quote with a valid-until date', permission: 'quotes.manage' } },
    { method: 'GET', path: '/api/quotes/:id', handler: (ctx, u, r) => s.getQuote(ctx, u, id(r)), meta: { summary: 'One quote', permission: 'sales.view' } },
    { method: 'PATCH', path: '/api/quotes/:id', handler: (ctx, u, r) => s.updateQuote(ctx, u, id(r), r.body), meta: { summary: 'Edit an open quote', permission: 'quotes.manage' } },
    { method: 'POST', path: '/api/quotes/:id/status', handler: (ctx, u, r) => s.setQuoteStatus(ctx, u, id(r), r.body.status), meta: { summary: 'Mark a quote accepted or declined', permission: 'quotes.manage' } },
    { method: 'POST', path: '/api/quotes/:id/convert', handler: (ctx, u, r) => s.convertQuote(ctx, u, id(r), r.body), meta: { summary: 'Convert a quote into an invoice', permission: 'quotes.manage' } },
    // invoices
    { method: 'GET', path: '/api/invoices', handler: (ctx, u, r) => s.listInvoices(ctx, u, r.query), meta: { summary: 'List invoices (?status=, ?customerId=)', permission: 'sales.view' } },
    { method: 'POST', path: '/api/invoices', handler: (ctx, u, r) => s.createInvoice(ctx, u, r.body), meta: { summary: 'Create an invoice (issued, or draft with draft:true); credit-limit checked', permission: 'sales.create' } },
    { method: 'GET', path: '/api/invoices/:id', handler: (ctx, u, r) => s.getInvoice(ctx, u, id(r)), meta: { summary: 'One invoice with payments and credit notes', permission: 'sales.view' } },
    { method: 'PATCH', path: '/api/invoices/:id', handler: (ctx, u, r) => s.updateDraft(ctx, u, id(r), r.body), meta: { summary: 'Edit a draft invoice', permission: 'sales.create' } },
    { method: 'POST', path: '/api/invoices/:id/issue', handler: (ctx, u, r) => s.issueInvoice(ctx, u, id(r), r.body), meta: { summary: 'Issue a draft invoice (posts to the ledger)', permission: 'sales.create' } },
    { method: 'POST', path: '/api/invoices/:id/pay', handler: (ctx, u, r) => s.payInvoice(ctx, u, id(r)), meta: { summary: 'Pay the open balance of an invoice', permission: 'sales.create' } },
    { method: 'POST', path: '/api/invoices/:id/void', handler: (ctx, u, r) => s.voidInvoice(ctx, u, id(r), r.body), meta: { summary: 'Void an invoice (draft closed; issued via full credit note)', permission: 'sales.credit' } },
    { method: 'POST', path: '/api/invoices/:id/credit-notes', handler: (ctx, u, r) => s.createCreditNote(ctx, u, id(r), r.body), meta: { summary: 'Issue a (partial) credit note against an invoice', permission: 'sales.credit' } },
    { method: 'GET', path: '/api/invoices/:id/print', handler: (ctx, u, r) => s.printInvoice(ctx, u, id(r), r.query), meta: { summary: 'Printable bilingual invoice HTML (JSON { html }), with QR placeholder', permission: 'sales.view' } },
    // credit notes and payments
    { method: 'GET', path: '/api/credit-notes', handler: (ctx, u) => s.listCreditNotes(ctx, u), meta: { summary: 'List credit notes', permission: 'sales.view' } },
    { method: 'GET', path: '/api/credit-notes/:id', handler: (ctx, u, r) => s.getCreditNote(ctx, u, id(r)), meta: { summary: 'One credit note', permission: 'sales.view' } },
    { method: 'GET', path: '/api/payments', handler: (ctx, u, r) => s.listPayments(ctx, u, r.query), meta: { summary: 'List customer payments with allocations', permission: 'sales.view' } },
    { method: 'POST', path: '/api/payments', handler: (ctx, u, r) => s.recordPayment(ctx, u, r.body), meta: { summary: 'Record a payment and allocate it across invoices', permission: 'sales.create' } },
    // quick sale
    { method: 'GET', path: '/api/sales', handler: (ctx, u) => s.listSales(ctx, u), meta: { summary: 'Recent quick sales', permission: 'sales.view' } },
    { method: 'POST', path: '/api/sales/quick', handler: (ctx, u, r) => s.quickSale(ctx, u, r.body), meta: { summary: 'Quick sale (optional discount): posts to the ledger and queues an e-receipt', permission: 'sales.create' } },
    { method: 'GET', path: '/api/sales/parked', handler: (ctx, u) => s.listParked(ctx, u), meta: { summary: 'Parked (held) sales', permission: 'sales.create' } },
    { method: 'POST', path: '/api/sales/parked', handler: (ctx, u, r) => s.parkSale(ctx, u, r.body), meta: { summary: 'Park a sale for later', permission: 'sales.create' } },
    { method: 'POST', path: '/api/sales/parked/:id/checkout', handler: (ctx, u, r) => s.checkoutParked(ctx, u, id(r)), meta: { summary: 'Complete a parked sale', permission: 'sales.create' } },
    { method: 'DELETE', path: '/api/sales/parked/:id', handler: (ctx, u, r) => s.discardParked(ctx, u, id(r)), meta: { summary: 'Discard a parked sale', permission: 'sales.create' } },
    { method: 'POST', path: '/api/sales/:id/refund', handler: (ctx, u, r) => s.refundSale(ctx, u, id(r), r.body), meta: { summary: 'Refund a quick sale (ledger reversal, emits sale.refunded)', permission: 'sales.credit' } },
  ],
  widgets: s.widgets,
  seed,
};
