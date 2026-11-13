# D3: Front-end approach

Status: proposed — awaiting owner confirmation

Proposed outcome: **No build step, ES modules, two shells**

## Context

The requirements proposed a React-like PWA. The app is vanilla JavaScript with no build step, but `public/app.js` has grown into a single file (design plan 5.8).

## Decision

Keep the **no-build approach** and pay down the single-file debt: split `public/app.js` into ES modules (`core/api.js`, `core/state.js`, `core/router.js`, `ui/kit.js`, `i18n.js`); a small shared component kit; two shells (the full-mode shell and a simple-mode shell in `public/simple/`) sharing the kit and the offline client; one deterministic readiness signal for browser tests; performance budgets enforced in CI.

## Consequences

Positive: nothing to install or compile, which suits an on-premise or offline box; fast iteration.
Negative: no ecosystem tooling for components or type checks; discipline is needed to keep the kit small.

## References

Design plan 1.3, 5.8. Related: D5.
