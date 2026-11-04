import { isoDate } from '../../ledger.js';
import { vatOf } from './common.js';
import { balanceOf, listCustomers, aging } from './customers.js';
import { listInvoices } from './invoices.js';
import { listQuotes } from './quotes.js';
import { listSales, listParked } from './quick.js';
import { listItems } from './items.js';

// Facade: the original exports (createInvoice, payInvoice, quickSale, listInvoices, listItems, widgets, vatOf)
// keep their names and import path; the implementation lives in the files below.
export { vatOf };
export * from './customers.js';
export * from './invoices.js';
export * from './quotes.js';
export * from './quick.js';
export * from './items.js';
export * from './settings.js';
export { printInvoice } from './print.js';

// Home widgets: receivables (needs reports.view) and today's sales.
export function widgets(ctx, user) {
  const { db } = ctx;
  const has = (p) => user.permissions.has(p);
  const w = {};
  if (has('reports.view')) {
    const today = isoDate(ctx.now());
    const open = db.prepare("SELECT * FROM invoices WHERE status IN ('issued','partially_paid') ORDER BY due_date").all().filter((i) => balanceOf(i) > 0);
    w.receivables = {
      total: open.reduce((s, r) => s + balanceOf(r), 0), count: open.length,
      overdue: open.filter((r) => r.due_date < today).length,
      invoices: open.map((i) => ({ id: i.id, number: i.number, customer: i.customer, total: balanceOf(i), invoiceTotal: i.total, status: i.status, due_date: i.due_date })),
    };
  }
  if (has('sales.view')) {
    const start = Date.parse(isoDate(ctx.now()));
    const r = db.prepare('SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS n FROM sales WHERE created_at >= ? AND refunded = 0').get(start);
    w.todaySales = { total: r.total, count: r.n };
  }
  // One payload for the Sales cards, so the UI needs no extra requests (and never renders stale data after a user switch).
  if (has('sales.view')) {
    w.salesDesk = {
      items: listItems(ctx, user, has('sales.configure') ? { all: 1 } : {}),
      customers: listCustomers(ctx, user), aging: aging(ctx, user), quotes: listQuotes(ctx, user),
      invoices: listInvoices(ctx, user).slice(0, 12), recent: listSales(ctx, user).slice(0, 8),
      parked: has('sales.create') ? listParked(ctx, user) : [],
    };
  } else if (has('sales.create')) {
    w.salesDesk = { items: listItems(ctx, user), customers: [], aging: null, quotes: [], invoices: [], recent: [], parked: listParked(ctx, user) };
  }
  return w;
}
