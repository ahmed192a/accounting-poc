// Event hooks: lets one module react to what another does without editing its files.
// A module declares `hooks: { 'sale.created': (ctx, payload) => {...} }`; the emitting code calls
// emit(ctx, 'sale.created', payload) INSIDE its own transaction, so a hook that throws rolls the whole
// operation back, and a hook that writes (for example posts a journal entry) is atomic with it.
// Hooks are synchronous and run in module load order (core first, then alphabetical).
//
// Events and payloads (all money in integer piastres):
//   entry.posted     { entryId, date, lines, sourceType, sourceId, reversesId, userId }
//   sale.created     { sale: {id, subtotal, vat, total}, items: [{sku, name, qty, price, eta_code}], entryId, receipt, userId }
//   invoice.created  { invoice: {id, number, customer, lines, subtotal, vat, total, issueDate}, entryId, userId }
//   invoice.paid     { id, total, entryId, userId }
//   bill.created     { bill: {id, supplier, amount, category}, status, userId }
//   bill.approved    { bill: {id, supplier, amount, category}, entryId, userId, auto }
//   tax.document_created { id, kind, number, uuid, status, adapter }   tax.document_status { id, from, to, reason }  (MOCK tax documents)
export const EVENTS = ['entry.posted', 'sale.created', 'invoice.created', 'invoice.paid', 'bill.created', 'bill.approved',
  'tax.document_created', 'tax.document_status'];
//   banking.imported / banking.reconciled / banking.invoice_settled / banking.bill_settled / banking.settlement_reversed (see docs/banking.md)

EVENTS.push('banking.imported', 'banking.reconciled', 'banking.invoice_settled', 'banking.bill_settled', 'banking.settlement_reversed');
//   sale.refunded    { sale: {id, subtotal, vat, total}, items: [{sku, qty, price}], entryId (the reversal), originalEntryId, reason, receipt: {id, status, uuid}|null, userId }
//   credit_note.created { creditNote: {id, number, invoiceId, lines: [{description, qty, unitPrice, sku?}], subtotal, vat, total}, invoice: {id, number, customer}, entryId, voided, userId }
EVENTS.push('sale.refunded', 'credit_note.created'); // sales
//   auth.user_invited {userId,email,role,invitedBy}, auth.user_deactivated {userId,by}, auth.password_reset {userId,by}, auth.lockout {userId,until,failures}, auth.apikey_created {id,name,userId}
EVENTS.push('auth.user_invited', 'auth.user_deactivated', 'auth.password_reset', 'auth.lockout', 'auth.apikey_created');
//   approvals.requested { requestId, docType, docId, amount, userId }   approvals.completed { requestId, docType, docId, userId }
//   approvals.rejected  { requestId, docType, docId, reason, userId }   purchases.paid { paymentId, supplierId, amount, entryId, userId }
//   assist.accepted     { itemId, billId, edited, userId }               assist.undone { itemId, billId, userId }

export function emit(ctx, event, payload) {
  for (const h of ctx.registry?.hooks?.[event] ?? []) h.fn(ctx, payload);
}
EVENTS.push('approvals.requested', 'approvals.completed', 'approvals.rejected', 'purchases.paid', 'assist.accepted', 'assist.undone');
