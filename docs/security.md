# Security module (`auth`, `core`, `server.js`)

Dependency-free: `node:crypto` only. Two modes.

| Mode | How | Identity |
| --- | --- | --- |
| Demo (default) | `AUTH_REQUIRED` unset (anything but exactly `1`) | `x-user-id` header works exactly as before. Sessions and API keys also work. Demo credentials are seeded. |
| Required | `AUTH_REQUIRED=1` | `x-user-id` is **ignored**. A session cookie or API key is needed, otherwise `401 AUTH_REQUIRED`. |

## Demo credentials (demo mode only)
Seeded once per database when `AUTH_REQUIRED` is not `1`: `owner@demo.test`, `manager@demo.test`, `clerk@demo.test`,
`accountant@demo.test`, `auditor@demo.test`, `admin@demo.test`, all with the password `Demo-Pass-2026`.
They are public knowledge: never use demo mode with real data. Starting with `AUTH_REQUIRED=1` disables every demo
credential left in an older database, and never seeds new ones. `/api/demo-users` returns `[]` in required mode.

## First run in required mode
No default passwords exist. Either set `INITIAL_OWNER_PASSWORD` (and optionally `INITIAL_OWNER_EMAIL`, default
`owner@accounting.local`, and `INITIAL_OWNER_NAME`) for the first start, or start without it: a one-time setup token is
printed to the server log and `POST /api/auth/setup { token, email, password, name }` (or the "First-time setup" box on
the login screen) creates the owner. The token is stored hashed, is single use, and a restart issues a new one.
Remove `INITIAL_OWNER_PASSWORD` after the first start.

## Authentication
- Passwords: scrypt (N=16384, r=8, p=1, random 16-byte salt). Policy: 12 to 128 characters, not a common password, no
  e-mail name or first name inside, at least two character kinds (or 20+ characters).
- Login `POST /api/auth/login { email, password, code?, backupCode? }`. Unknown e-mail and wrong password give the same
  error and similar timing. If MFA is enrolled and no code is sent: `401 MFA_REQUIRED` (no session is created).
- Lockout: 5 failures lock the account for 60 s, doubling with each further failure up to 30 min (`429 ACCOUNT_LOCKED`,
  `Retry-After`). A correct password does not bypass a lock. Success resets the counter. Admin can unlock.
- Sessions: random 256-bit token in an `HttpOnly; SameSite=Lax; Path=/` cookie `acc_sid` (`Secure` on https or when
  `COOKIE_SECURE=1` / `TRUST_PROXY=1` with `x-forwarded-proto: https`). Only the sha256 is stored. Idle expiry 120 min
  (`SESSION_IDLE_MINUTES`), absolute 12 h (`SESSION_MAX_HOURS`), id rotated at login and every 15 min (old id valid 30 s).
  Password change signs out other devices. Deactivating a user kills sessions and API keys.
- MFA: TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30 s) implemented by hand, checked against RFC test vectors. Enroll
  (`/api/auth/mfa/enroll` returns the secret and an `otpauth://` URI, no QR image is generated), confirm with a first code
  (returns 10 one-time backup codes, shown once, stored hashed). +-1 step of clock skew is accepted; a used step cannot be
  replayed. Secrets are AES-256-GCM encrypted at rest (key from `AUTH_ENCRYPTION_KEY`, else a random key in the DB:
  set the env var in production). Disable needs password and a code; admin can reset a user's MFA.
- Users: `users.invite` creates a user with a role and returns a one-time invite token (7 days; no mail server in this
  build, so the admin hands it over) accepted at `/api/auth/accept-invite`. You cannot invite into a role holding
  permissions you lack. `users.manage`: deactivate (reason required), reactivate, admin password reset (temporary password,
  must be changed before anything else works), reset MFA, unlock.

## API keys (`apikeys.manage`)
`acck_<10 hex>_<32 chars>`, sent as `Authorization: Bearer ...` or `x-api-key`. Hashed at rest, shown once, scoped to
permission atoms and always capped by the owner's current role (shrinks when the role shrinks), optional expiry, last-used
timestamp, revocable. No CSRF header needed. A key cannot hold permissions its creator lacks.

## Webhooks (`webhooks.manage`)
Subscribe to any module hook event (`src/hooks.js`, plus `auth.*`) or `*`. A delivery row is queued inside the emitting
transaction (rollback = nothing sent). Headers: `x-webhook-id`, `x-webhook-event`, `x-webhook-timestamp`,
`x-webhook-signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`. Retries: 30 s * 2^(n-1), capped at 6 h,
dead after 8 attempts; processed on demand (`POST /api/webhooks/deliveries/process`, `/api/webhooks/:id/test`) and by an
unref'd 30 s interval. Redirects are never followed. SSRF guard: https only, no credentials in the URL, refuses
loopback, private, link-local (incl. cloud metadata), CGNAT, multicast, reserved, IPv4-mapped/NAT64/6to4 IPv6 forms and
internal names (`localhost`, `.local`, `.internal`, single-label); names are resolved before every delivery and refused if
any answer is private. LIMIT: fetch resolves again when connecting, so DNS rebinding is not fully closed; use an egress
proxy or firewall in production. `createApp(ctx, { fetch, resolve })` injects both (tests never touch the network).

## Rate limits (published at `GET /api/security/limits`)
Token bucket per API key, else per client IP: capacity and refill 600/min (`RATE_LIMIT_PER_MIN`). Sign-in routes
(`/api/auth/login|setup|accept-invite`) additionally 10/min per IP. Headers on every limited route:
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (seconds until full); `429 RATE_LIMITED` with
`Retry-After`. `/healthz` is exempt. In memory, per process.

## HTTP hardening
CSP `script-src 'self'` (no inline scripts; `style-src` keeps `'unsafe-inline'` because UI modules set `style=""`),
`frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`; `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `Permissions-Policy`, COOP/CORP same-origin, HSTS on https. CSRF for cookie sessions:
non-GET requests need header `x-csrf-token` equal to the session token (returned by login and `/api/auth/me`, also in the
readable `acc_csrf` cookie) and a matching `Origin` if one is sent (`403 CSRF_FAILED`). Body limit 1 MiB (`413 TOO_LARGE`).
Every response carries `x-request-id` (a sane incoming one is kept); errors never include stack traces, only the request id.
`createApp(ctx, { logger })` receives one JSON object per request (no query strings); the CLI logs to stdout
(`REQUEST_LOG=0` silences it).

## Audit integrity
`auth_audit_chain` holds `HMAC-SHA256(key, prevHash | canonical(audit row))` for every `audit_log` row (the ledger's table
is untouched). Sealing runs after every write request, on verify and on a timer. `GET /api/audit/verify`
(`security.view`) re-computes the chain and reports `row_modified`, `row_deleted`, `row_inserted` or `chain_link_broken`
per audit id, plus `head` to anchor externally. Tests tamper with a `VACUUM INTO` copy whose triggers were dropped.
LIMIT: rows written since the last seal are not yet chained; with the default key stored in the same database, an attacker
who can rewrite the whole database can also recompute the chain: set `AUDIT_CHAIN_KEY` outside the DB and anchor `head`.

## Permissions
`users.invite`, `apikeys.manage`, `webhooks.manage`, `security.view` (admin: all four; auditor: `security.view`; owner: all).
New SoD pair: `apikeys.manage` + `ledger.post`. `PATCH /api/roles/:id` edits custom roles only and refuses permissions the
editor does not hold. Every write is audited (secrets never are).

## Events added
`auth.user_invited`, `auth.user_deactivated`, `auth.password_reset`, `auth.lockout`, `auth.apikey_created`.

## Known limits
No e-mail delivery, no QR code image, no WebAuthn, no per-tenant isolation (see `docs/tenancy.md`), single-process rate
limiter and sessions in SQLite, webhook signing secrets are recoverable by the server (needed to sign).
