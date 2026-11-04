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
//   sale.refunded    { sale: {id, subtotal, vat, total}, items: [{sku, qty, price}], entryId (the reversal), originalEntryId, reason, receipt: {id, status, uuid}|null, userId }
//   credit_note.created { creditNote: {id, number, invoiceId, subtotal, vat, total}, invoice: {id, number, customer}, entryId, voided, userId }
export const EVENTS = ['entry.posted', 'sale.created', 'invoice.created', 'invoice.paid', 'bill.created', 'bill.approved'];
EVENTS.push('sale.refunded', 'credit_note.created'); // sales (see the doc comment lines below)

export function emit(ctx, event, payload) {
  for (const h of ctx.registry?.hooks?.[event] ?? []) h.fn(ctx, payload);
}
