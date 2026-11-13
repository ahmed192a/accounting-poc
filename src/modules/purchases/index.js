import * as s from './service.js';
import * as sup from './suppliers.js';
import * as po from './orders.js';
import * as pay from './payments.js';
import * as rep from './reports.js';
import * as att from './attachments.js';
import * as rec from './recurring.js';
import { seed, demoSeed } from './seed.js';

const EGP = 100;
const r = (method, path, summary, permission, handler) => ({ method, path, handler, meta: { summary, permission } });

// Suppliers, purchase orders, bills (with 3-way match, attachments, approval via the approvals module),
// supplier payments, statements, AP aging and recurring bills.
export default {
  name: 'purchases',
  permissions: {
    'purchases.view': 'See bills, suppliers, purchase orders and payments',
    'purchases.create': 'Create bills and purchase orders (amount-limited)',
    'purchases.approve': 'Approve bills (amount-limited)',
    'purchases.pay': 'Pay suppliers (amount-limited)',
    'suppliers.manage': 'Create and edit suppliers (tax id, payment terms)',
  },
  // The manager approves but does not create bills, so it holds no separation-of-duties conflict.
  roleGrants: {
    manager: ['purchases.view', 'purchases.approve', 'purchases.pay', 'suppliers.manage'],
    clerk: ['purchases.view', 'purchases.create'],
    accountant: ['purchases.view', 'purchases.pay', 'suppliers.manage'],
    auditor: ['purchases.view'],
  },
  roleLimits: {
    manager: { 'purchases.approve': 20000 * EGP, 'purchases.pay': 20000 * EGP },
    clerk: { 'purchases.create': 5000 * EGP },
  },
  exportTables: [
    'purchases_suppliers', 'purchases_orders', 'purchases_order_lines', 'purchases_bill_lines', 'purchases_attachments_export',
    'purchases_payments', 'purchases_payment_allocations', 'purchases_recurring',
  ],
  routes: [
    r('GET', '/api/bills', 'List bills (?status, ?supplierId)', 'purchases.view', (ctx, u, q) => s.listBills(ctx, u, q.query)),
    r('POST', '/api/bills', 'Create a bill (auto-approved under the threshold, else sent to the approval rules)', 'purchases.create', (ctx, u, q) => s.createBill(ctx, u, q.body)),
    r('GET', '/api/bills/:id', 'One bill with lines, attachments, payments and its approval request', 'purchases.view', (ctx, u, q) => s.getBill(ctx, u, Number(q.params.id))),
    r('POST', '/api/bills/:id/submit', 'Send a draft bill for approval', 'purchases.create', (ctx, u, q) => s.submitBill(ctx, u, Number(q.params.id))),
    r('POST', '/api/bills/:id/approve', 'Approve the open step of a pending bill', 'purchases.approve', (ctx, u, q) => s.approveBill(ctx, u, Number(q.params.id), q.body)),
    r('POST', '/api/bills/:id/reject', 'Reject a pending bill (reason required)', 'purchases.approve', (ctx, u, q) => s.rejectBill(ctx, u, Number(q.params.id), q.body)),
    r('POST', '/api/bills/:id/void', 'Void a bill (reverses its ledger entry; reason required)', 'purchases.approve', (ctx, u, q) => s.voidBill(ctx, u, Number(q.params.id), q.body)),
    r('POST', '/api/bills/:id/attachments', 'Attach a file (PDF, PNG, JPEG, text; size limited) as base64', 'purchases.create', (ctx, u, q) => att.addAttachment(ctx, u, Number(q.params.id), q.body)),
    r('GET', '/api/bills/:id/attachments/:aid', 'Download an attachment as base64', 'purchases.view', (ctx, u, q) => att.getAttachment(ctx, u, Number(q.params.id), Number(q.params.aid))),

    r('GET', '/api/suppliers', 'List suppliers with what is owed to each', 'purchases.view', (ctx, u) => sup.listSuppliers(ctx, u)),
    r('POST', '/api/suppliers', 'Create a supplier', 'suppliers.manage', (ctx, u, q) => sup.createSupplier(ctx, u, q.body)),
    r('GET', '/api/suppliers/:id', 'One supplier', 'purchases.view', (ctx, u, q) => sup.getSupplier(ctx, u, Number(q.params.id))),
    r('PATCH', '/api/suppliers/:id', 'Edit a supplier', 'suppliers.manage', (ctx, u, q) => sup.updateSupplier(ctx, u, Number(q.params.id), q.body)),
    r('GET', '/api/suppliers/:id/statement', 'Supplier statement with running balance (?from, ?to)', 'purchases.view', (ctx, u, q) => rep.supplierStatement(ctx, u, Number(q.params.id), q.query)),

    r('GET', '/api/purchase-orders', 'List purchase orders', 'purchases.view', (ctx, u) => po.listPurchaseOrders(ctx, u)),
    r('POST', '/api/purchase-orders', 'Create a purchase order', 'purchases.create', (ctx, u, q) => po.createPurchaseOrder(ctx, u, q.body)),
    r('GET', '/api/purchase-orders/:id', 'One purchase order with line quantities', 'purchases.view', (ctx, u, q) => po.getPurchaseOrder(ctx, u, Number(q.params.id))),
    r('POST', '/api/purchase-orders/:id/receive', 'Record goods received (for the 3-way match)', 'purchases.create', (ctx, u, q) => po.receivePurchaseOrder(ctx, u, Number(q.params.id), q.body)),
    r('POST', '/api/purchase-orders/:id/cancel', 'Cancel an untouched purchase order', 'purchases.create', (ctx, u, q) => po.cancelPurchaseOrder(ctx, u, Number(q.params.id), q.body.reason)),

    r('GET', '/api/supplier-payments', 'List supplier payments', 'purchases.view', (ctx, u, q) => pay.listPayments(ctx, u, q.query)),
    r('POST', '/api/supplier-payments', 'Pay a supplier, allocated to bills (partial payments allowed)', 'purchases.pay', (ctx, u, q) => pay.paySupplier(ctx, u, q.body)),
    r('POST', '/api/supplier-payments/:id/void', 'Void a payment by reversal', 'purchases.pay', (ctx, u, q) => pay.voidPayment(ctx, u, Number(q.params.id), q.body)),

    r('GET', '/api/purchases/ap-aging', 'Accounts payable aging by supplier (?asOf)', 'purchases.view', (ctx, u, q) => rep.apAging(ctx, u, q.query)),

    r('GET', '/api/recurring-bills', 'List recurring bill templates', 'purchases.view', (ctx, u) => rec.listRecurring(ctx, u)),
    r('POST', '/api/recurring-bills', 'Create a recurring bill template', 'purchases.create', (ctx, u, q) => rec.createRecurring(ctx, u, q.body)),
    r('POST', '/api/recurring-bills/run', 'Generate the bills that are due now', 'purchases.create', (ctx, u) => rec.runRecurring(ctx, u)),
    r('POST', '/api/recurring-bills/:id/stop', 'Stop a recurring template', 'purchases.create', (ctx, u, q) => rec.stopRecurring(ctx, u, Number(q.params.id))),
  ],
  widgets: s.widgets,
  seed,
  demoSeed,
};
