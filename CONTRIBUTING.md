# Contributing

Thanks for helping. This is a proof of concept with strict engineering rules because it models accounting software.

## Setup

Node 22.13+ (CI also runs 24). No `npm install`: the project has **no dependencies, ever** (`npm run check` fails if
any appear). Browser checks need Python Playwright: `pip install playwright && playwright install chromium`.

## Before you open a pull request

```
npm test                  # must be green
npm run check             # syntax, dependencies, secrets, module and migration conventions
npm run coverage          # thresholds live in scripts/coverage-check.js
python3 e2e/run_all.py    # when the UI changed (set POC_PORT if 3100 is busy)
```

## Ownership model

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Each feature owns its own `src/modules/<name>/`, `public/modules/<name>.js`,
migration range (`NNN_name.js`, `id` equals the file name) and `test/<name>.*.test.js`. Shared files belong to their owners;
if you need a change there, ask the owner or work around it with hooks, your own tables or your own routes. Do not edit merged migrations.

## Rules a reviewer will check

- Money is integer piastres. Use `ctx.now()`, never `Date.now()`. Multi-step writes go in `tx()`.
- Validate every input and throw `AppError` with a clear code. Every write records `audit(...)`.
- Never edit or delete journal rows; corrections are reversals. Post only through `postEntry`.
- Every route is permission-gated (`requirePerm`), registered as an `area.action` atom, and has `meta.summary`.
- UI: English and Arabic strings, RTL-safe CSS (logical properties), escape user text with `esc()`, no inline secrets.
- Tests: happy path, permission denial, validation errors, rollback, audit entries, edge cases. Deterministic and independent.
- Be honest: mocked or unverified behaviour (tax rules, ETA/ZATCA formats, rates) is labelled MOCK or UNVERIFIED.

## Commits and pull requests

Small commits with clear messages. Fill in the pull request template. CI must be green: `test` (Node 22 and 24), `checks`, `e2e`.

## Security issues

Do not open a public issue; see [SECURITY.md](SECURITY.md).
