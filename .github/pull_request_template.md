## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## Area (ownership)

<!-- Which module/area does this touch? Do not edit files owned by someone else; see README "Ownership model". -->

## Checklist

- [ ] `npm test` passes
- [ ] `npm run check` passes (syntax, no dependencies, no secrets, conventions)
- [ ] `python3 e2e/run_all.py` passes if the UI changed
- [ ] New routes have `meta.summary` and are permission-gated; new permissions are registered
- [ ] Money is integer piastres; ledger changes go through `postEntry`/`reverseEntry`
- [ ] Mocked or unverified behaviour (tax rules, ETA formats) is labelled MOCK or UNVERIFIED
- [ ] Migrations stay inside the module's number range
