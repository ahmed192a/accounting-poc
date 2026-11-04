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
//   banking.imported / banking.reconciled / banking.invoice_settled / banking.bill_settled / banking.settlement_reversed (see docs/banking.md)
export const EVENTS = ['entry.posted', 'sale.created', 'invoice.created', 'invoice.paid', 'bill.created', 'bill.approved'];

EVENTS.push('banking.imported', 'banking.reconciled', 'banking.invoice_settled', 'banking.bill_settled', 'banking.settlement_reversed');

export function emit(ctx, event, payload) {
  for (const h of ctx.registry?.hooks?.[event] ?? []) h.fn(ctx, payload);
}
