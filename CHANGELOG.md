# Changelog

All notable changes. Format based on Keep a Changelog; the project is pre-1.0 and versions are informal.

## [Unreleased]

### Added
- Repository tooling: `npm run coverage` (Node built-in coverage with thresholds and a job summary), `npm run check`
  (syntax, no dependencies, secrets pattern scan, module/migration/UI conventions, routes without summary), `npm run openapi`
  (generates `docs/openapi.json` from the module registry), `npm run smoke` (server deploy check).
- GitHub Actions: `test` (Node 22 and 24, coverage), `checks` (repo checks, OpenAPI artifact, deploy check), `e2e` (Playwright);
  concurrency cancellation, read-only token permissions, Dependabot for Actions.
- `e2e/smoke_all_modules.py` (six demo users, every navigation page) and `e2e/run_all.py` (runs every browser check).
- Dockerfile (node:22-alpine, non-root, healthcheck), `.dockerignore`, `docs/DEPLOY.md`.
- README rewrite, CONTRIBUTING, SECURITY, pull request and issue templates, CODEOWNERS placeholder.

## [0.1.0] - proof of concept

### Added
- Append-only double-entry ledger with reversals and period lock; granular roles with role-specific home views;
  bills with limits and approval; quick sale and invoices; mock ETA e-receipt queue with the 24-hour window;
  full export with audit log; English and Arabic RTL UI; modular architecture with auto-discovered modules and migrations.
