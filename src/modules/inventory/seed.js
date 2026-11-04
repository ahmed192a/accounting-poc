import { ensureAccounts } from './service.js';

// The schema migration already created the default warehouse and units. This seed adds accounts 1300 and 5300.
// The setting inventory.allow_negative defaults to true when absent. No demo stock: module seeds run
// alphabetically, so `inventory` runs before `sales` (items) and `ledger` (account 2000), and a receipt
// cannot be posted yet. Receive stock through the UI or POST /api/inventory/receive.
export function seed(ctx) {
  ensureAccounts(ctx.db);
}
