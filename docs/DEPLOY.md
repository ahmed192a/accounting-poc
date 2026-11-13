# Deploying

The app is one Node 22 process (built-in SQLite, no npm install, no build step) that serves the API and the UI.
It is a **proof of concept**: do not put real customer data or real tax credentials on a public demo.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. Render and most hosts set it for you. |
| `DB_PATH` | `:memory:` | SQLite file. Unset means in-memory: all data is lost on restart. Set to a file on a persistent disk to keep data. |
| `AUTH_REQUIRED` | unset | Read by the auth module once it is merged. When `true`, the demo user switcher stops being enough and sign-in is enforced. Check `docs/auth.md` for the exact behaviour in your version. |
| `INITIAL_OWNER_PASSWORD` | unset | Password given to the owner account the first time a database is created, instead of a demo default. Needs `AUTH_REQUIRED`. |
| `TAX_SECRET_KEY` | unset | Key the tax module uses to protect stored tax-authority credentials. Use a long random value and keep it out of git. Losing it makes stored credentials unreadable. |
| `TENANTS_DIR` | unset | Turns on multi-tenancy: a folder holding `registry.db` and one SQLite file per company (`tenant-<id>.db`) plus `backups/`. Put it on a persistent disk and back it up together with `DB_PATH`. Unset keeps the app single-tenant. See `docs/tenancy.md`. |
| `TENANT_MAX_OPEN` | `50` | How many tenant database files stay open at once; idle ones are closed least-recently-used and reopened on demand. |

Variables owned by modules that are not merged yet are simply ignored. Never commit values; use the host's secret store.

## Render (free tier)

1. Sign in at https://render.com with GitHub. New + > Blueprint > pick this repository. `render.yaml` does the rest.
2. Open the URL Render shows. Health check: `/healthz`.

Honest caveats of the free plan:
- Instances **sleep after about 15 minutes idle**; the next request waits roughly a minute.
- There is **no persistent disk** on the free plan. Without `DB_PATH` the database is in memory and **resets on every
  restart and deploy**. Pointing `DB_PATH` at the instance's local filesystem does not help: that storage is ephemeral too.
- Free-plan limits (hours per month, bandwidth) change; check Render's current pricing page.

## Docker

```
docker build -t accounting-poc .
docker run --rm -p 3000:3000 accounting-poc                                  # in-memory data
docker run --rm -p 3000:3000 -v accounting-data:/data -e DB_PATH=/data/accounting.db accounting-poc   # data kept in a volume
```

The image is `node:22-alpine`, runs as the unprivileged `node` user and has a `HEALTHCHECK` on `/healthz`.
Behind a reverse proxy, terminate TLS there: the app speaks plain HTTP and has no rate limiting yet.

## Other free or cheap options (all with caveats)

| Option | Fit | Caveats |
| --- | --- | --- |
| Fly.io | Runs the Dockerfile; volumes give persistence. | Requires a card for sign-up in many regions; the free allowance has changed several times, check current terms. |
| Railway | Simple GitHub deploy. | Free usage is a small trial credit, not an ongoing free tier. |
| Koyeb, Northflank and similar | Docker or buildpack deploy. | Free tiers are small and have changed; verify before relying on them. |
| A small VPS (any provider) | Best for real persistence: Docker plus a volume, or systemd with `DB_PATH` on disk. | Costs a few dollars a month; you handle TLS, backups and updates. |
| GitHub Pages / Netlify static hosting | **Not possible**: the app needs a Node server. | None. |

Prices and plans were not re-verified for this document (UNVERIFIED); treat the table as a starting point.

## Persistence and backups

- SQLite with `DB_PATH` on a real disk or volume survives restarts. Back the file up (copy it while the app is idle, or use
  `sqlite3 file ".backup out.db"`). The in-app "Export everything" action gives a full JSON export including the audit log.
- File databases run in write-ahead-log (WAL) mode with a 5 s busy timeout (set in `openDb`). A WAL database has `-wal` and
  `-shm` files next to it: copy the file with `sqlite3 file ".backup out.db"` or the tenant backup action (`VACUUM INTO`), not
  by copying the main file alone while the app runs.
- **Restore drill.** `npm run restore-drill` provisions a company, backs it up, restores the backup into a fresh database and
  checks that the audit hash chain verifies and the ledger totals match the source (exit 1 if not). Run
  `node scripts/restore-drill.js --backup FILE` to restore and check a real backup file (integrity, chain, balanced ledger).
  CI runs it on every change to `src/` and monthly (`.github/workflows/restore-drill.yml`). A backup that has not been restored
  is not a backup.
- Only run **one** instance per database file; SQLite is not designed for several app servers writing the same file.
- The journal and audit log are append-only by database triggers, so restoring an old backup also removes newer entries:
  keep several generations.

## Checks before and after deploying

```
npm run smoke      # starts the server and requires 200 from /healthz, / and /api/ui-modules
npm run check      # repository conventions
```

CI runs the same commands (`.github/workflows/checks.yml`).
