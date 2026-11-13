# Architecture and ownership rules

The app is a zero-dependency Node 22 ESM project (built-in `node:sqlite`, `node:http`, `node:test`, vanilla JS UI).
It is organised so that several agents can add features **in parallel without touching the same files**. Everything
a feature needs plugs in through four extension points: migrations, backend modules, UI modules and tests.

```
src/migrations/NNN_name.js        schema, auto-discovered, applied in filename order
src/modules/<name>/index.js       backend module, auto-discovered
public/modules/<name>.js          UI module, auto-discovered through GET /api/ui-modules
test/<name>.<topic>.test.js       tests, auto-discovered by the glob in package.json
```

## Ownership: who may edit what

A feature agent owns **only**:

1. its own folder `src/modules/<name>/`
2. its own file `public/modules/<name>.js` (or several, all prefixed with its module name)
3. its own migration number range (below)
4. its own test files `test/<name>.*.test.js`

These shared files are owned by named owners and **must not be edited by other agents**. If you need a change in one of
them, ask the owner (or put the logic in your own module):

`src/db.js`, `src/ledger.js`, `src/permissions.js`, `src/server.js`, `src/modules.js`, `src/errors.js`,
`public/index.html`, `public/app.js`, `public/style.css`, `package.json`, `README.md`, `docs/`, `.github/`, `e2e/`,
and the existing migrations and modules of other agents.

Nothing in the shared files needs editing to add a feature: routes, permissions, role grants, home widgets, seeds,
export tables, schema, UI cards and translations are all contributed from your own files.

## Migrations

`src/migrations/NNN_name.js`, three digits, lowercase name. Each file exports:

```js
export const id = '205_stock_levels';          // must equal the file name without .js
export function up(db) { db.exec(`CREATE TABLE stock_levels (...)`); }
```

`openDb()` applies every migration not yet in the `schema_migrations` table, in filename order, each in its own
transaction (a failing one rolls back and stops startup). Running twice is a no-op. Never edit a migration that has been
merged; add a new one. Two files with the same number fail at startup, so stay inside your range:

| Range   | Owner                           |
| ------- | ------------------------------- |
| 001-099 | core                            |
| 100-199 | banking                         |
| 200-299 | inventory                       |
| 300-399 | multi-entity and currency       |
| 400-499 | auth and security               |
| 500-599 | tax and compliance              |
| 600-699 | reports                         |
| 700-799 | approvals and AI review         |
| 800-899 | reserved                        |
| 900-919 | tenancy (per-tenant databases) |

`001_core` holds the original schema unchanged (including the append-only triggers); `002_module_seeds` tracks which
module seeds already ran. Prefix your tables with your area (`inventory_*`, `bank_*`) so names never clash.

## Backend module contract

`src/modules/<name>/index.js` default-exports one object. The folder name must equal `name`.

```js
export default {
  name: 'hello',                                   // required, equals the folder name
  permissions: { 'hello.view': 'See greetings' },  // atom -> description; atoms look like "area.action"
  roleGrants: { manager: ['hello.view'] },         // built-in role -> atoms (owner always gets every atom)
  roleLimits: { manager: { 'hello.create': 500000 } }, // optional: built-in role -> { atom: max piastres }
  exportTables: ['hello_greetings'],               // optional: tables added to GET /api/export
  routes: [
    {
      method: 'GET',                               // GET POST PUT PATCH DELETE
      path: '/api/hello/:id',                      // :params are decoded into params
      handler: (ctx, user, { params, query, body }) => result,   // sync; return value is sent as JSON
      public: false,                               // true = no x-user-id needed, `user` is null
      meta: { summary: 'One greeting', permission: 'hello.view' }, // documentation only, not enforced
    },
  ],
  widgets: (ctx, user) => ({ hello: { count: 1 } }),  // merged into GET /api/home `widgets`
  seed: (ctx) => { /* demo data */ },                 // runs once per database, core first
};
```

What the loader (`src/modules.js`) does with it:

- **routes**: merged into the HTTP router. POST answers 201, everything else 200. `AppError` becomes
  `{ error: { code, message } }` with its status. Two modules declaring the same `METHOD path` fail at startup.
- **permissions**: merged into the global registry in `src/permissions.js` (`PERMISSIONS`, `ALL_PERMISSIONS`). An atom
  may only be declared by one module. Enforce them in your handlers with `requirePerm(user, 'hello.view')`,
  `requireAny`, and `limitFor` for amount limits.
- **roleGrants / roleLimits**: merged into the built-in roles `owner manager clerk accountant auditor admin`.
  On **every startup** the built-in roles in the database are re-synced: missing roles are created, newly added atoms
  and limits are added. The sync is add-only and idempotent, never removes anything and never touches custom roles
  (rows with `builtin = 0`). So a persistent database picks up your new atoms on the next start.
- **widgets**: called for every `/api/home`; return `{}` when the user lacks the permission. A widget key may only be
  produced by one module (a clash throws). Decide with `user.permissions.has(...)`, not role names.
- **seed**: runs once per module per database inside a transaction, after the `core` seed (core, then alphabetical).
  Recorded in `module_seeds`, so a module added later is seeded on its first startup without re-seeding the others.
  A seed must not assume another module seeded before it, except that `core` (users) runs first.
- **exportTables**: plain table names, appended to the core export list so the full-fidelity export stays complete.

A handler receives `ctx = { db, now(), registry, offsetMs }`. Always use `ctx.now()` (never `Date.now()`) so the demo
clock works, and `ctx.db` (a `node:sqlite` `DatabaseSync`). Put business logic in `src/modules/<name>/service.js` and keep
`index.js` a thin declaration; tests then import the service functions directly.

Cross-module calls: import another module's exported functions (for example `sales` imports `eta/adapter.js`), but do
not write to another module's tables. Prefer exposing a small function from the owning module.

### Minimal copy-paste module (backend, migration, UI, test)

`src/migrations/800_hello_example.js` (use your own range)

```js
export const id = '800_hello_example';
export function up(db) {
  db.exec(`CREATE TABLE hello_greetings (id INTEGER PRIMARY KEY, text TEXT NOT NULL, created_by INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
}
```

`src/modules/hello/service.js`

```js
import { AppError } from '../../errors.js';
import { audit } from '../../ledger.js';
import { requirePerm } from '../../permissions.js';

export function addGreeting(ctx, user, { text }) {
  requirePerm(user, 'hello.create');
  if (!text || !String(text).trim()) throw new AppError(400, 'BAD_INPUT', 'Text is required');
  const res = ctx.db.prepare('INSERT INTO hello_greetings (text, created_by, created_at) VALUES (?,?,?)').run(String(text), user.id, ctx.now());
  const id = Number(res.lastInsertRowid);
  audit(ctx, { userId: user.id, action: 'hello.created', type: 'hello', id, newValue: { text } });
  return { id };
}

export function listGreetings(ctx, user) {
  requirePerm(user, 'hello.view');
  return ctx.db.prepare('SELECT id, text FROM hello_greetings ORDER BY id DESC LIMIT 20').all();
}

export const widgets = (ctx, user) => (user.permissions.has('hello.view') ? { hello: { items: listGreetings(ctx, user).slice(0, 5) } } : {});
```

`src/modules/hello/index.js`

```js
import * as s from './service.js';

export default {
  name: 'hello',
  permissions: { 'hello.view': 'See greetings', 'hello.create': 'Add greetings' },
  roleGrants: { clerk: ['hello.view', 'hello.create'], auditor: ['hello.view'] },
  exportTables: ['hello_greetings'],
  routes: [
    { method: 'GET', path: '/api/hello', handler: (ctx, u) => s.listGreetings(ctx, u), meta: { summary: 'List greetings', permission: 'hello.view' } },
    { method: 'POST', path: '/api/hello', handler: (ctx, u, r) => s.addGreeting(ctx, u, r.body), meta: { summary: 'Add a greeting', permission: 'hello.create' } },
  ],
  widgets: s.widgets,
  seed: (ctx) => ctx.db.prepare("INSERT INTO hello_greetings (text, created_by, created_at) VALUES ('Hello', 1, ?)").run(ctx.now()),
};
```

`public/modules/hello.js`

```js
export default function register(App) {
  const { t, esc, has, api, run } = App;
  App.i18n.add('en', { hello: 'Greetings', helloAdd: 'Add' });
  App.i18n.add('ar', { hello: 'التحيات', helloAdd: 'إضافة' });

  App.addCard({
    id: 'hello.list', area: 'main', order: 110, permission: 'hello.view',
    render: ({ widgets: w }) => !w.hello ? '' : `<div class="card"><h2>${t('hello')}</h2>
      <table>${w.hello.items.map((g) => `<tr><td>${esc(g.text)}</td></tr>`).join('')}</table>
      ${has('hello.create') ? `<div class="row"><input type="text" id="hello-text"><button class="primary" data-act="hello-add">${t('helloAdd')}</button></div>` : ''}</div>`,
  });
  App.on('hello-add', () => run(() => api('POST', '/api/hello', { text: document.getElementById('hello-text').value }), t('saved')));
}
```

`test/hello.greetings.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectError } from './helpers.js';
import * as hello from '../src/modules/hello/service.js';

test('hello: clerk adds a greeting, auditor can only read', () => {
  const { ctx, as } = setup();
  hello.addGreeting(ctx, as('clerk'), { text: 'Hi' });
  assert.equal(hello.listGreetings(ctx, as('auditor'))[0].text, 'Hi');
  expectError(() => hello.addGreeting(ctx, as('auditor'), { text: 'x' }), 'FORBIDDEN');
});
```

That is the whole change: no shared file is edited. (The example is documentation; do not commit a `hello` module.)

## UI module contract

`public/index.html` is a small shell. `public/app.js` is the entry point; the shell it starts (client layout below) creates the
`App` object, calls `GET /api/ui-modules` (public; the file names in `public/modules`), dynamically imports each and calls its
default export once, then loads `/api/home` and renders. A module that throws while loading or registering is logged to the console and skipped; the rest still work.

```js
export default function register(App) { ... }
```

| `App` member | Purpose |
| --- | --- |
| `addCard({ id, area, order, permission?, render(home) })` | Dashboard card. `area`: `'stats'` (top row) or `'main'` (grid). `order`: lower first (core cards use 10-100 in steps of 10; pick 110+ or a free number). `permission`: an atom, or `(home) => bool`; omit to always call `render`. `render` returns an HTML string; return `''` to hide the card. `home` is the `/api/home` payload (`home.widgets`, `home.permissions`, `home.user`, `home.limits`, `home.vatRateBp`). Ids are unique (`<module>.<card>`). |
| `addHeader({ id, order, render(home) })`, `addFooter(...)` | Small items in the header (after the language button) or in the footer (after the note). |
| `i18n.add('en' \| 'ar', { key: text })` | Translations. Add **both** languages. Re-adding a key with different text throws, identical text is fine; prefix keys with your module name when in doubt. |
| `on(action, handler)` | Click on an element with `data-act="action"`; `handler(element, event)`; read `element.dataset`. One handler per action name across all modules, so prefix action names (`'hello-add'`). |
| `onChange(action, handler)`, `onInput(action, handler)` | The same for `change` and `input` events (selects, live totals). |
| `onLoad(async (home) => {})` | Runs after `/api/home` loads and before rendering: fetch extra data your cards need. |
| `onUserChange(() => {})` | Reset per-user UI state when the user switcher changes. |
| `api(method, path, body)` | `fetch` wrapper that adds `x-user-id`, parses JSON and throws `Error(message)` with `.code` on failure. |
| `run(fn, okMessage?)` | Run an action; on success toast `okMessage` and reload and re-render; on failure toast the error. |
| `toast(message, ok = false)` | Bottom-corner message. |
| `money(piastres)`, `toPiastres(egpString)` | Format integer piastres for the current language; parse user input to piastres. |
| `esc(text)` | HTML-escape. **Always** escape data you put into HTML. |
| `has(atom)`, `t(key)`, `loc()` | Permission check on the current user, translate, current locale. |
| `state` | `{ lang, userId, users, home }`. Keep your own UI state in module-level variables, not in `state`. |
| `reload()`, `render()` | Re-fetch and render / render only. |

Rules: reuse the classes in `public/style.css` (`card`, `big`, `sub`, `row`, `chip good|warn|bad|mute`, `note`, `num`, `empty`)
instead of adding CSS. Use logical properties if you must add style (`margin-inline-start`, not `margin-left`) so Arabic
RTL keeps working. Show the card from the permission/widget, and show each write control only when `has(...)` the write permission (read-only roles must see no buttons), never from a role name.

`public/` is served statically (js, css, html, json, svg, png, ico, txt, woff2 with correct content types). Path traversal,
dotfiles and unknown extensions are refused. Only `GET`/`HEAD`.

## Client layout (the shell, no bundler)

The shell is plain ES modules served as they are; there is no build step and no dependency. Imports use absolute paths
(`/core/state.js`). Function-level import cycles are intended (render calls chrome, chrome calls navigation); nothing may use
another module's export while its own module is still being evaluated.

```
public/app.js              entry point only: imports core/ready, core/app, core/events, then boot()
public/core/ready.js       readiness signal (below); loaded first
public/core/state.js       store (localStorage, failure-safe), the shared `state`, has/loc/money/toPiastres
public/core/i18n.js        string tables (en, ar), t(), addStrings
public/core/host.js        the empty `App` object, `view` (derived cards/pages), `$`
public/core/registry.js    cards, pages, commands, handlers, hooks and their validation
public/core/api.js         api(): identity header, CSRF, idempotency key, offline queue hook, 401 -> login
public/core/login.js       sign-in screen plumbing
public/core/view.js        which cards and pages the user sees, nav items
public/core/load.js        toast, run(), load() (= /api/home + onLoad hooks + render)
public/core/router.js      render(): chrome + page, keeps scroll, focus and selection
public/core/events.js      delegated click/change/input/keydown listeners, hashchange, online/offline
public/core/app.js         assembles the `App` object (the contract in the table above)
public/core/boot.js        discovers and registers UI modules, first load, markReady
public/ui/chrome.js        theme, top bar, side and bottom nav, account menu
public/ui/pages.js         home, registered pages, onboarding, not-found
public/ui/palette.js       command palette and shortcut help
public/ui/actions.js       data-sh actions (language, nav drawer, install, sign-out)
public/lib/*.js            pure logic (unit tested without a DOM) and DOM primitives (ui.js)
public/modules/*.js        feature UI modules (unchanged contract)
```

Adding a shell file means three edits, and `test/client.layout.test.js` fails until all are done: the file itself, its entry in
`PRECACHE` in `public/sw.js` (so the installed app opens offline), and a `<link rel="modulepreload">` in `public/index.html`.
Bump `CACHE` in `public/sw.js` whenever the list changes.

**Readiness signal.** Browser tests and the performance check never wait on timers:

| Signal | Meaning |
| --- | --- |
| `<html data-ready="loading\|ready">` | `ready` only when the shell and first view are loaded **and** no `api()` call or data load is in flight |
| `<html data-route="#/sales">` | route of the last render |
| `window.__appReady` | `false` until the first load finished (also `true` when it failed; `<html data-ready-error>` is then set) |
| `App.ready` | promise resolving at the same moment |
| user-timing marks `acct:boot`, `acct:modules`, `acct:home`, `acct:hooks`, `acct:render`, `acct:ready` | boot phases, for profiling |

`e2e/helpers.py` wraps this (`ready(page)`, `go(page, '#/sales')`, `stable(page, '#nav')`). Use CSS attribute selectors, not
`wait_for_function`: the app sends a strict CSP and Playwright evaluates predicates with `eval`.

**Start-up speed without a bundler.** `index.html` preloads the shell graph (`modulepreload`) and the two boot requests
(`/api/demo-users`, `/api/ui-modules`); `lib/preload-modules.js` preloads the feature modules as soon as their list arrives; boot
requests `/api/home` while the modules download. None of this changes what the app does, only when files are fetched.

**Performance budget.** `python3 e2e/perf_budget.py` (separate `perf` job in `.github/workflows/e2e.yml`, not part of
`run_all.py`): 390x800 phone, CPU x3, +40 ms RTT, 12 Mbit/s, cold cache, median of 7 runs. Budgets: first interaction (navigation
to ready) under 1000 ms, tap response under 200 ms, quick-sale submit (tap to confirmation) under 300 ms, app bytes under 400 KB.
Override the profile with `PERF_CPU`, `PERF_LATENCY_MS`, `PERF_DOWN_MBPS`, `PERF_RUNS`; scale all budgets with `PERF_SCALE`.

## Money

Money is **integer piastres** (1 EGP = 100) everywhere: database columns, API payloads, JavaScript. Never a float, never
a decimal string. Convert only at the screen edge (`App.money`, `App.toPiastres`). VAT is
`Math.round(subtotal * vat_rate_bp / 10000)`. Validate with `posInt` from `src/errors.js`. Foreign-currency amounts need
an explicit `currency` column next to the integer minor units (the 300-399 range owns that design).

## Append-only ledger rules

- `journal_entries`, `journal_lines` and `audit_log` can never be updated or deleted: SQLite triggers abort it.
  Do not write migrations that drop those triggers, and never try to "fix" a row.
- Post only through `postEntry(ctx, { userId, date, memo, sourceType, sourceId, lines })` from `src/ledger.js`. It checks
  the entry balances, every line has one positive whole-piastre amount, the date, and the period lock (soft lock needs
  confirmation and a reason, hard lock refuses).
- Corrections are **reversals** via `reverseEntry` (reason required), which post a mirrored entry that points at the
  original. A reversal cannot be reversed; post a new entry instead.
- Write business rows and their ledger entry in one `tx(db, () => {...})` (re-entrant) so they succeed or fail together.
- Every state change writes an `audit(ctx, { userId, action, type, id, oldValue, newValue, reason })` row.
- Changing the period lock needs a reason and is audited.

## Running tests and the e2e check

```
npm test                       # node --test "test/**/*.test.js": new test files are picked up with no config change
node --no-warnings --test test/sales.invoices.test.js   # one file
python3 e2e/ui_check.py        # browser end-to-end (Python Playwright + Chromium), prints ALL UI CHECKS PASSED
python3 e2e/run_all.py         # every browser check; python3 e2e/perf_budget.py is the separate performance budget
```

`e2e/ui_check.py` starts the server itself. Environment: `POC_DIR` (repo to test, default: the repo containing the script),
`POC_PORT` (default 3100), `POC_SHOTS` (screenshot folder, default `e2e/shots`, git-ignored).

Tests use `test/helpers.js`: `setup()` returns `{ ctx, as }` on a fresh seeded in-memory database (`as('clerk')` loads a
demo user: owner 1, manager 2, clerk 3, accountant 4, auditor 5, admin 6); `expectError(fn, code)`;
`tempModules({ 'fake/index.js': source })` writes a throwaway modules folder (with `{"type":"module"}`) to load through
`loadModules([MODULES_DIR, dir])`; `startApp(createApp, ctx)` starts the HTTP server on a random port.
Name files `<module>.<topic>.test.js`. Tests must not depend on other files' state or on wall-clock time (use `ctx.now()`
and `ctx.offsetMs`).

## Startup sequence (for reference)

`createSeededContext(path)` in `src/server.js`: `openDb` (run pending migrations) -> `createContext` -> `initContext`
(register permissions and role grants from all modules, sync built-in roles in the database, run pending seeds) ->
`createApp(ctx)` (routes from the registry, then static files from `public/`).

## Event hooks (react to other modules without editing them)

A backend module may export `hooks: { '<event>': (ctx, payload) => {...} }`. Emitters call
`emit(ctx, event, payload)` from `src/hooks.js` inside their own transaction, so a hook that throws rolls
the whole operation back and a hook that posts a journal entry is atomic with the triggering action.
Hooks are synchronous, run in module load order, and must be idempotent-safe (never assume you run last).
The full list of events and payloads is documented at the top of `src/hooks.js`:
`entry.posted`, `sale.created`, `invoice.created`, `invoice.paid`, `bill.created`, `bill.approved`.
Need a new event? Add it to `EVENTS` in `src/hooks.js` and emit it from your own module's code; do not
edit another module's service to call yours.
