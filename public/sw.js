/* Service worker.
   1. Static shell (html, js, css, icons, manifest, UI modules): network first, cached copy when offline, so the app opens offline.
   2. Read-only API data (API_GET below): stale-while-revalidate in a separate cache, keyed per x-user-id (demo identity), so the
      quick-sale screen, items, customers and recent sales still render offline. When the background refresh differs from what was shown,
      clients get a message ('acct-api-updated') so the UI can offer "newer data available" instead of silently re-rendering a form.
   3. Any successful write (non-GET /api/*) empties the API cache, so the next read is fresh and never shows pre-write balances.
   Writes are never queued or replayed here: the offline write queue lives in the page (public/offline-queue.js, IndexedDB) because it
   needs the user's identity headers and a visible "pending" list. Nothing is cached for /api/auth/*, /api/admin/* or any other path. */
const CACHE = 'acct-shell-v3'; // bumped: the shell moved from one app.js to /core and /ui modules
const API_CACHE = 'acct-api-v1';
/* Exact paths whose GET responses may be served stale while offline (data the offline quick-sale / lookup screens need). */
const API_GET = ['/api/home', '/api/items', '/api/customers', '/api/sales', '/api/invoices', '/api/bills', '/api/suppliers', '/api/demo-users', '/api/ui-modules'];
/* The shell. Keep in step with public/core, public/ui and public/lib: test/client.layout.test.js fails when a file is missing here. */
const PRECACHE = [
  '/', '/app.js', '/style.css', '/manifest.json',
  '/core/ready.js', '/core/state.js', '/core/i18n.js', '/core/host.js', '/core/registry.js', '/core/login.js', '/core/api.js',
  '/core/view.js', '/core/load.js', '/core/router.js', '/core/events.js', '/core/app.js', '/core/boot.js',
  '/ui/chrome.js', '/ui/pages.js', '/ui/palette.js', '/ui/actions.js',
  '/lib/format.js', '/lib/router.js', '/lib/nav.js', '/lib/theme.js', '/lib/focus.js', '/lib/search.js', '/lib/shortcuts.js',
  '/offline-queue.js', '/lib/icons.js', '/lib/html.js', '/lib/ui.js', '/lib/design-page.js', '/lib/theme-boot.js', '/lib/preload-modules.js',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png',
];
const STATIC_EXT = /\.(?:js|css|html|svg|png|ico|woff2)$/i;

function isStaticAsset(url, origin) {
  if (url.origin !== origin) return false;
  const p = url.pathname;
  if (p.startsWith('/api/')) return false;
  return p === '/' || p === '/manifest.json' || STATIC_EXT.test(p);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(PRECACHE.map((u) => cache.add(u).catch(() => {}))); // one missing file must not block install
    try { // UI modules too, so every card exists offline on the first controlled load
      const list = await (await fetch('/api/ui-modules')).json();
      await Promise.all(list.filter((f) => /^[\w.-]+\.js$/.test(f)).map((f) => cache.add('/modules/' + f).catch(() => {})));
    } catch { /* offline install: modules get cached as they are fetched */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if ((k.startsWith('acct-shell-') && k !== CACHE) || (k.startsWith('acct-api-') && k !== API_CACHE)) await caches.delete(k);
    await self.clients.claim();
  })());
});

const isApiGet = (url) => url.origin === self.location.origin && API_GET.includes(url.pathname);
/** Cache key: the URL plus the demo identity, so one user's cached data is never served to another. */
function apiKey(req) {
  const u = new URL(req.url);
  u.searchParams.set('__u', req.headers.get('x-user-id') ?? 's');
  return u.href;
}
async function clearApiCache() { await caches.delete(API_CACHE); }

async function notifyUpdated(path) {
  for (const c of await self.clients.matchAll()) c.postMessage({ type: 'acct-api-updated', path });
}

async function staleWhileRevalidate(req, event) {
  const cache = await caches.open(API_CACHE);
  const key = apiKey(req);
  const cached = await cache.match(key);
  const refresh = (async () => {
    const res = await fetch(req);
    if (res.ok) {
      const fresh = res.clone();
      if (cached) { // tell the page when the refreshed data differs from what it was just shown
        const [a, b] = await Promise.all([cached.clone().text(), res.clone().text()]);
        if (a !== b) event.waitUntil(notifyUpdated(new URL(req.url).pathname));
      }
      await cache.put(key, fresh);
    } else if (res.status === 401 || res.status === 403) await cache.delete(key); // signed out / lost access: stop serving it
    return res;
  })();
  if (cached) { event.waitUntil(refresh.catch(() => {})); return cached; } // stale now, fresh next time
  return refresh; // nothing cached: a network failure propagates, so the app shows its normal "no connection" state
}

self.addEventListener('message', (event) => { if (event.data?.type === 'acct-clear-api') event.waitUntil(clearApiCache()); });

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.method !== 'GET') {
    if (url.pathname.startsWith('/api/') && req.method !== 'HEAD') {
      event.respondWith(fetch(req).then((res) => { if (res.ok) event.waitUntil(clearApiCache()); return res; }));
    }
    return;
  }
  if (isApiGet(url)) { event.respondWith(staleWhileRevalidate(req, event)); return; }
  if (!isStaticAsset(url, self.location.origin)) return;
  // Static: network first (so deploys show up immediately), falling back to the cached copy when offline.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true }) ?? (req.mode === 'navigate' ? await cache.match('/') : undefined);
      if (hit) return hit;
      throw err;
    }
  })());
});

// Test hook (node:test loads this file in a vm with a fake `self`); inert in browsers.
if (self.__SW_TEST__) self.__sw = { apiKey, isApiGet, isStaticAsset, API_GET, CACHE, API_CACHE };
