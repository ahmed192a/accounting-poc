import { AppError } from '../../errors.js';
import { audit } from '../../ledger.js';
import { emit } from '../../hooks.js';
import { refreshInvoice } from './invoices.js';

// Reversals are the only way to undo ledger postings. When a reversal of an entry that belongs to a sales
// document is posted (by this module or by the ledger module), keep the business rows in step and tell
// other modules. Runs inside the reversal's transaction: if it throws, the reversal is rolled back too.
export const hooks = {
  'entry.posted': (ctx, p) => {
    if (!p.reversesId) return;
    const { db } = ctx;
    const orig = p.reversesId;

    const sale = db.prepare('SELECT * FROM sales WHERE entry_id = ?').get(orig);
    if (sale) {
      const reason = db.prepare('SELECT reason FROM journal_entries WHERE id = ?').get(p.entryId)?.reason ?? null;
      db.prepare('UPDATE sales SET refunded = 1, refund_entry_id = ?, refund_reason = ?, refunded_at = ?, refunded_by = ? WHERE id = ?')
        .run(p.entryId, reason, ctx.now(), p.userId, sale.id);
      audit(ctx, { userId: p.userId, action: 'sale.refunded', type: 'sale', id: sale.id, newValue: { refundEntryId: p.entryId, total: sale.total }, reason });
      const receipt = db.prepare('SELECT id, status, uuid FROM receipts WHERE sale_id = ?').get(sale.id) ?? null;
      emit(ctx, 'sale.refunded', {
        sale: { id: sale.id, subtotal: sale.subtotal, vat: sale.vat, total: sale.total },
        items: JSON.parse(sale.items), entryId: p.entryId, originalEntryId: orig, reason, receipt, userId: p.userId,
      });
      return;
    }

    const cn = db.prepare('SELECT * FROM sales_credit_notes WHERE entry_id = ?').get(orig);
    if (cn) {
      db.prepare("UPDATE sales_credit_notes SET status = 'reversed' WHERE id = ?").run(cn.id);
      refreshInvoice(ctx, cn.invoice_id);
      audit(ctx, { userId: p.userId, action: 'credit_note.reversed', type: 'credit_note', id: cn.id, newValue: { reversalEntryId: p.entryId } });
      return;
    }

    const pay = db.prepare('SELECT * FROM sales_payments WHERE entry_id = ?').get(orig);
    if (pay) {
      db.prepare("UPDATE sales_payments SET status = 'reversed' WHERE id = ?").run(pay.id);
      for (const a of db.prepare('SELECT invoice_id FROM sales_payment_allocations WHERE payment_id = ?').all(pay.id)) refreshInvoice(ctx, a.invoice_id);
      audit(ctx, { userId: p.userId, action: 'payment.reversed', type: 'payment', id: pay.id, newValue: { reversalEntryId: p.entryId } });
      return;
    }

    const inv = db.prepare('SELECT * FROM invoices WHERE entry_id = ?').get(orig);
    if (inv) {
      if (inv.amount_paid > 0 || inv.amount_credited > 0) {
        throw new AppError(409, 'INVOICE_HAS_ACTIVITY', `Invoice ${inv.number} has payments or credit notes; reverse those first, or issue a credit note instead`);
      }
      db.prepare('UPDATE invoices SET entry_reversed = 1 WHERE id = ?').run(inv.id);
      refreshInvoice(ctx, inv.id);
      audit(ctx, { userId: p.userId, action: 'invoice.voided', type: 'invoice', id: inv.id, newValue: { reversalEntryId: p.entryId } });
    }
  },
};
