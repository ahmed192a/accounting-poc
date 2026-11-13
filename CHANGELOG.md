# Changelog

All notable changes. Format based on Keep a Changelog; the project is pre-1.0 and versions are informal.

## [Unreleased]

### Changed
- UI shell: `public/app.js` (600 lines) is split into ES modules under `public/core/` and `public/ui/` (no bundler, no behavior
  change). The service worker precaches the new files (shell cache `acct-shell-v3`); `index.html` preloads the module graph and the
  two boot requests; `/api/home` is requested while the UI modules load.
- Browser checks wait on a deterministic readiness signal (`<html data-ready>`, `data-route`, `window.__appReady`, `App.ready`)
  instead of timeouts (`e2e/helpers.py`).

### Added
- `e2e/perf_budget.py` and a separate `perf` CI job: first interaction, tap response, quick-sale submit and app bytes on a
  throttled mid-range phone profile.

### Added
- Roadmap, plan, step-by-step run guide, screenshots and demo video (`scripts/capture-media.py`).

### Added
- Repository tooling: `npm run coverage` (Node built-in coverage with thresholds and a job summary), `npm run check`
  (syntax, no dependencies, secrets pattern scan, module/migration/UI conventions, routes without summary), `npm run openapi`
  (generates `docs/openapi.json` from the module registry), `npm run smoke` (server deploy check).
- GitHub Actions: `test` (Node 22 and 24, coverage), `checks` (repo checks, OpenAPI artifact, deploy check), `e2e` (Playwright);
  concurrency cancellation, read-only token permissions, Dependabot for Actions.
- `e2e/smoke_all_modules.py` (six demo users, every navigation page) and `e2e/run_all.py` (runs every browser check).
- Dockerfile (node:22-alpine, non-root, healthcheck), `.dockerignore`, `docs/DEPLOY.md`.
- README rewrite, CONTRIBUTING, SECURITY, pull request and issue templates, CODEOWNERS placeholder.

## [0.5.0] - pilot preparation (in progress)
Offline queue with idempotent replay, live ETA adapter (unverified), per-company databases, fix for 403 noise on user switch.

## [0.4.0] - control and experience
Sign-in with MFA, API keys, signed webhooks, audit hash chain (`security`); approval chains, purchase orders with 3-way match,
suggestion-only assistant (`approvals`).

## [0.3.0] - core accounting
Banking, inventory, multi-entity and currency, customers/quotes/credit notes, reports and dashboards, navigation shell and PWA.

## [0.2.0] - modular foundation
Module loader, migrations, event hooks, CI workflows, Docker, Render blueprint, tax module (mock adapters).

## [0.1.0] - proof of concept

### Added
- Append-only double-entry ledger with reversals and period lock; granular roles with role-specific home views;
  bills with limits and approval; quick sale and invoices; mock ETA e-receipt queue with the 24-hour window;
  full export with audit log; English and Arabic RTL UI; modular architecture with auto-discovered modules and migrations.
