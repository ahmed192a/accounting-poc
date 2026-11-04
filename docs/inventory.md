# Inventory module

Warehouses, units, barcodes, reorder levels, append-only stock movements, weighted-average costing, COGS on sale,
stocktake and a valuation that reconciles to ledger account 1300. Code: `src/modules/inventory/`, UI:
`public/modules/inventory.js`, migration `200_inventory`.

## Model
- The sales module owns `items`. We extend by sku through `inventory_item_settings` (track, unit, barcode, reorder level and qty).
  **Only items with `track = 1` move stock.** Receiving an item switches tracking on; services and loose goods stay untracked
  and sales of them are ignored by the hook.
- `inventory_movements` is append-only (SQL triggers). Kinds: purchase, sale, adjustment, transfer, return, count. `qty` is signed,
  `value` is the signed piastre value that moved the asset (transfers net to zero), `unit_cost` is for display. `flags`
  holds `negative` and/or `cost_unknown`. View `inventory_stock_on_hand` gives qty per item and warehouse. Nothing is cached:
  quantity, value and average cost are always derived from the movements.
- Costing: weighted average per item across all warehouses. Issues take `value * qty / onHand` (BigInt, rounded half away from
  zero); the last units take the remaining value, so there is no rounding residue and the sub-ledger matches 1300 to the piastre.
- Quantities are whole numbers of the item's unit (count a kilogram item in grams if you need fractions).

## Ledger postings
| Event | Entry |
| --- | --- |
| Receive stock | Dr 1300 / Cr 2000 (source `inventory_receipt`) |
| Sale or invoice line with sku | Dr 5300 / Cr 1300 at average cost (`inventory_cogs`), same transaction as the sale |
| Adjustment out / stocktake loss | Dr 5300 / Cr 1300 |
| Adjustment in / stocktake gain / customer return | Dr 1300 / Cr 5300 |
| Return to supplier | Dr 2000 / Cr 1300 |
| Transfer | none |

Do not also enter a purchases bill for goods you received here: the receipt already credits payables (2000).

## Negative stock and unknown cost
Setting `inventory.allow_negative` (default true). When true, a sale may take stock below zero: units not covered by stock are costed at the last
known unit cost and the movement is flagged `negative`; if no cost was ever known the COGS for those units is 0 and the flag
`cost_unknown` is set (no zero-value journal line is posted). Flags show in `/api/inventory/warnings`, the home widget and the UI.
When false, a sale/adjustment/transfer/return-out beyond stock fails with `INSUFFICIENT_STOCK` and the whole sale rolls back.

## Events
Consumes `sale.created` (items `{sku, qty}`) and `invoice.created`. Invoice lines may carry an optional `sku`
(`{ description, qty, unitPrice, sku? }`); only those lines relieve stock, using `invoice.lines` from the event payload. Both
hooks are idempotent per sale/invoice id. A hook failure rolls back the emitting operation. Emits no new events.
NOTE: the sales module currently drops `sku` when it stores invoice lines, so real invoices do not carry it until sales
passes it through (listed in the request for shared files). Tested by emitting the event directly.

## API (all under /api/inventory)
GET `stock`, `stock/:sku`, `movements`, `barcode/:code`, `low-stock`, `warnings`, `counts`, `counts/:id`, `items`, `warehouses`, `units`, `settings`
(inventory.view); GET `valuation` (inventory.costs); POST `receive` (inventory.receive); POST `adjust`, `return`, `transfer`,
`counts`, `counts/:id/post`, `counts/:id/cancel`, PUT `counts/:id` (inventory.adjust); PUT `items/:sku`, POST `warehouses`,
PATCH `warehouses/:id`, POST `units`, PUT `settings` (inventory.manage). Home widget key `inventory`.

Receive body: `{ supplier, sku, qty, unitCost, warehouseId?, date?, reference? }` or `lines: [{sku, qty, unitCost}]`.
Adjust body: `{ sku, qty (signed), reason (required), warehouseId?, unitCost? }`. Stocktake: create sheet (snapshot of expected),
PUT counted quantities (uncounted lines are skipped), post: variance = counted minus on hand at posting time, one journal entry.

## Permissions
`inventory.view`, `inventory.costs` (unit costs, values, valuation: separate so clerks do not see margins), `inventory.receive`,
`inventory.adjust`, `inventory.manage`. Grants: clerk view; auditor view+costs; accountant view, costs, receive, adjust; manager all
five, with limits per document of 50,000 EGP (adjust) and 200,000 EGP (receive); owner all.

## Valuation
`GET /api/inventory/valuation`: qty, average cost, value per item; total; ledger balance of 1300; `difference` and `reconciled`;
`ledgerOther` shows the part of the 1300 balance posted outside inventory (manual journals).

## Limits
Single stocking unit per item (no unit conversions); average cost is item-wide, not per warehouse; no lots, serials or expiry;
reversing a COGS or receipt journal entry from the ledger screen does not undo the stock movement (use a return or adjustment);
no demo stock is seeded (seed order puts inventory before sales and ledger); EGP only.
