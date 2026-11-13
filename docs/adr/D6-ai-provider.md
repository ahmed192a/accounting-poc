# D6: AI provider

Status: proposed — awaiting owner confirmation

Proposed outcome: **Pluggable, company-supplied key, propose-only default**

## Context

The assistant module has a keyword heuristic behind a provider interface; no model, OCR or voice (design plan 4.5). Cost per entry and privacy of audio and receipts depend on who holds the model key.

## Decision

Keep the **provider interface** in the assistant module. Providers: the current offline heuristic (default) and a model-backed provider configured **per company with its own key**. Every AI result is a proposal that goes through the command pipeline (4.3) and is never posted without a confirmation; the default for agents is `propose_only`. The source transcript or image is stored on the proposal.

## Consequences

Positive: no model cost or data liability on the service; a company can stay fully offline with the heuristic.
Negative: companies must obtain and manage a key; accuracy varies by provider.
Needs from the owner: whether keys are supplied by each company or by the service (design plan section 11, item 7); this record proposes the former.

## References

Design plan 4.3, 4.5, 5.9, 11.
