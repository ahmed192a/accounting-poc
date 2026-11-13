# D8: API versioning

Status: proposed — awaiting owner confirmation

Proposed outcome: **`/api/v1` now; unversioned paths kept as aliases through the pilot**

## Context

The API is unversioned (`/api/...`). The command pipeline and MCP surface (design plan 4.3) add new routes under `/api/v1`, and integrations already depend on the existing paths.

## Decision

Introduce **`/api/v1`** now. The existing unversioned `/api/...` paths stay as **aliases** that behave identically through the pilot, then are announced as deprecated with a published date before any removal. Breaking changes go to a new version prefix; additive changes do not.

## Consequences

Positive: integrations get a stable contract; room to change later.
Negative: two path families to document and test until the aliases are retired.

## References

Design plan 4.3, 5.9.
