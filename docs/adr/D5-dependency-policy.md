# D5: Dependency policy

Status: proposed — awaiting owner confirmation

Proposed outcome: **Zero by default; a named, reviewed exception list**

## Context

The project has zero npm dependencies today, which keeps it fast to run and easy to audit. A few future needs may not be reasonable to write from scratch: an MCP server SDK (design plan 4.3 says it is the first place a dependency is justified), PDF generation, and a cryptographic or OCR binding.

## Decision

**Zero dependencies by default.** A dependency is allowed only if it is on a **named, reviewed exception list** kept in this folder (or in a section of this file once the first one is added), each entry giving: the package and exact version, why it cannot reasonably be written in-house, its licence, its maintenance status and transitive dependency count, and who approved it. Candidates named so far, none yet accepted: the MCP SDK, a PDF library, a crypto or OCR binding. `scripts/check-repo.js` keeps failing on any dependency that is not on the list.

## Consequences

Positive: small attack surface, reproducible installs, no supply-chain drift by default.
Negative: some features (MCP, PDF, OCR) cost more to build, or wait for an approved exception.
Needs from the owner: confirmation that a short reviewed list is acceptable (design plan section 11, item 4).

## References

Design plan 1.3, 4.3, 5.9, 11.
