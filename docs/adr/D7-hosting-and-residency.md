# D7: Hosting and residency

Status: proposed — awaiting owner confirmation

Proposed outcome: **Open until counsel answers**

## Context

The only hosting today is a free-tier demo blueprint with no persistent disk. Where real merchant data may live depends on Egyptian privacy law and any ETA or contractual requirement, which have not been reviewed (design plan 1.3, section 11).

## Decision

**No decision yet.** Until counsel answers, do not host real merchant data anywhere other than a place the merchant controls (their own machine or a VPS they choose). Keep everything portable: a company is one file plus registry row, so it can be moved or exported on request.

## Consequences

Positive: avoids committing to a region or provider before the legal answer.
Negative: blocks a hosted pilot with real data.
Needs from the owner: engage counsel for privacy law and data residency (design plan section 11, item 5).

## References

Design plan 1.3, 5.7, 11.
