# Security

## Status: proof of concept

This project is **not production-ready**. Do not store real customer, financial or tax-authority data in it, and do not expose a
public instance that holds anything you care about.

Known gaps (by design at this stage unless the auth work has been merged and says otherwise in `docs/`):

- Identification is a trusted `x-user-id` header and a user switcher. Without the auth module enabled there is no real
  authentication, session handling or MFA, and anyone who can reach the server can act as any user.
- No tenant isolation, no rate limiting, no TLS termination (use a reverse proxy), no brute-force protection.
- The ETA integration is a mock. Real tax-authority credentials must never be placed in this version.
- The `POST /api/dev/advance-clock` endpoint is demo-only and must not be reachable in a real deployment.
- No external security review or penetration test has been done.

What does exist: permission atoms enforced on every route, separation-of-duties warnings, an append-only journal and audit log
enforced by database triggers, input validation, static-file path-traversal protection, and a CI secrets-pattern scan
(`npm run check`). CodeQL is not enabled.

## Reporting a vulnerability

Please report privately through GitHub's "Report a vulnerability" (Security tab) on this repository, or contact the repository owner
directly. Include steps to reproduce and the affected version. Do not post exploits publicly. This is a volunteer-run PoC, so
there is no guaranteed response time or bounty; reports will be acknowledged on a best-effort basis.

## Secrets

Never commit secrets. Configure `INITIAL_OWNER_PASSWORD`, `TAX_SECRET_KEY` and similar values through your host's secret store
(see [docs/DEPLOY.md](docs/DEPLOY.md)). If a secret is committed, rotate it; removing the commit is not enough.
