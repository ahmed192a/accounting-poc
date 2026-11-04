/* Service worker: caches ONLY the static shell (html, js, css, icons, manifest) so the app opens offline.
   The API is NEVER cached or intercepted: /api/* and every non-GET request go straight to the network.
   There is deliberately no offline data queue here; that is a later wave and is not faked. */
const CACHE = 'acct-shell-v1';
const PRECACHE = [
  '/', '/app.js', '/style.css', '/manifest.json',
  '/lib/format.js', '/lib/router.js', '/lib/nav.js', '/lib/theme.js', '/lib/focus.js', '/lib/search.js', '/lib/shortcuts.js',
  '/lib/icons.js', '/lib/html.js', '/lib/ui.js', '/lib/design-page.js', '/lib/theme-boot.js',
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
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('acct-shell-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Network first (so deploys show up immediately), falling back to the cached copy when offline.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!isStaticAsset(url, self.location.origin)) return;
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
