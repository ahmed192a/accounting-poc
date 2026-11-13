# D4: Sync model

Status: proposed — awaiting owner confirmation

Proposed outcome: **Operation log**

## Context

Offline sync today queues HTTP requests and replays them with idempotency keys: one device, order blocking, and the server computes totals the client only estimated (design plan 5.5).

## Decision

Move in two steps. **1. Operation log:** the client records domain operations (for example `sale.create` with a client-generated id, lines, prices as seen, device id, local time), not raw requests. The server accepts each operation exactly once, records any difference as a conflict note on the entry rather than rejecting the sale, and returns a cursor; reads sync by cursor per collection. **2. Multi-device:** several tills per shop, receipt numbers allocated in per-device blocks, stock conflicts become negative-stock flags.

A sale made offline is never refused later for a reason the clerk could not have known.

## Consequences

Positive: correct behaviour for several devices and long offline periods; conflicts become notes for the owner instead of lost sales.
Negative: a new client data model and server endpoint set; the existing request queue must be migrated.

## References

Design plan 1.3, 5.5.
