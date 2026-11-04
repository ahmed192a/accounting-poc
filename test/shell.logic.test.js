import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolveTheme, nextPref, normalizePref } from '../public/lib/theme.js';
import { rank, score, normalize } from '../public/lib/search.js';
import { createShortcuts } from '../public/lib/shortcuts.js';
import { nextIndex } from '../public/lib/focus.js';
import { contrastRatio, meetsAA } from '../public/lib/contrast.js';
import { field, emptyState, esc, cardTitle, textOf, table, skeleton } from '../public/lib/html.js';

test('theme: system follows the OS, explicit wins, toggle flips what is seen', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(nextPref('system', true), 'light');
  assert.equal(nextPref('dark', false), 'light');
  assert.equal(normalizePref('weird'), 'system');
});
test('search: ranks prefix over substring and normalises Arabic forms', () => {
  assert.ok(score('rec', 'Receivables') > score('ceiv', 'Receivables'));
  assert.equal(score('zzz', 'Receivables'), 0);
  assert.equal(normalize('إِيرادات'), normalize('ايرادات'));
  const items = [{ title: 'Cash' }, { title: 'Bank cash flow' }, { title: 'Ledger' }];
  assert.deepEqual(rank(items, 'cash').map((i) => i.title), ['Cash', 'Bank cash flow']);
  assert.equal(rank(items, '').length, 3);
});
test('shortcuts: mod+k, slash, g-then-digit with timeout, ignored while typing', () => {
  const s = createShortcuts({ timeout: 1000 });
  assert.equal(s.handle({ key: 'k', ctrlKey: true, typing: true }, 1).action, 'palette');
  assert.equal(s.handle({ key: '/' }, 2).action, 'palette');
  assert.equal(s.handle({ key: '/', typing: true }, 3), null);
  assert.equal(s.handle({ key: 'g' }, 100), null);
  assert.deepEqual(s.handle({ key: '3' }, 200), { action: 'goto', index: 2 });
  s.handle({ key: 'g' }, 1000); assert.equal(s.handle({ key: '3' }, 5000), null);
  assert.equal(s.handle({ key: '?' }, 6000).action, 'help');
});
test('focus: wraps forwards and backwards', () => {
  assert.equal(nextIndex(2, 3), 0); assert.equal(nextIndex(0, 3, true), 2);
  assert.equal(nextIndex(-1, 3), 0); assert.equal(nextIndex(-1, 3, true), 2); assert.equal(nextIndex(0, 0), -1);
});
test('design tokens: every text/background pair meets WCAG AA in light and dark', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const vars = (b) => Object.fromEntries([...b.matchAll(/--([\w-]+):\s*(#[0-9a-f]{3,6})/gi)].map((m) => [m[1], m[2]]));
  const light = vars(css.match(/:root \{([\s\S]*?)\n\}/)[1]);
  const dark = { ...light, ...vars(css.match(/html\[data-theme="dark"\] \{([\s\S]*?)\n\}/)[1]) };
  const pairs = [['ink', 'bg'], ['ink', 'surface'], ['muted', 'surface'], ['muted', 'bg'], ['muted', 'surface-2'], ['accent', 'surface'], ['on-accent', 'accent-fill'],
    ['good', 'good-bg'], ['warn', 'warn-bg'], ['bad', 'bad-bg'], ['accent', 'accent-bg'], ['muted', 'mute-bg'], ['good', 'surface'], ['warn', 'surface'], ['bad', 'surface'], ['toast-ink', 'toast-bg'], ['card', 'bad']];
  for (const [name, th] of [['light', light], ['dark', dark]]) for (const [a, b] of pairs) assert.ok(meetsAA(th[a], th[b]), `${name} ${a} on ${b} = ${contrastRatio(th[a], th[b]).toFixed(2)}`);
  assert.ok(contrastRatio('#000000', '#ffffff') > 20.9);
});
test('html builders: escape user text, wire aria for errors, strip card titles', () => {
  const f = field({ id: 'x', label: '<b>L</b>', error: 'Bad "value"', hint: 'h', required: true });
  assert.ok(f.includes('&lt;b&gt;') && f.includes('aria-invalid="true"') && f.includes('aria-describedby="x-hint x-err"') && f.includes('role="alert"'));
  assert.throws(() => field({ label: 'no id' }));
  assert.equal(esc('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  assert.equal(cardTitle('<div class="card"><h2>Bank &amp; cash <span>x</span></h2></div>'), 'Bank & cash x');
  assert.equal(textOf('<p>a</p><p>b</p>'), 'a b');
  assert.ok(emptyState({ title: '<x>', action: { href: '#/', label: 'Go' } }).includes('&lt;x&gt;'));
  assert.ok(table({ columns: [{ key: 'a', label: 'A' }], rows: [{ a: '<i>' }] }).includes('&lt;i&gt;'));
  assert.ok(skeleton().includes('aria-busy="true"'));
});

function loadSw() {
  const listeners = {}; const self = { location: { origin: 'http://x' }, addEventListener: (n, f) => { listeners[n] = f; }, skipWaiting() {}, clients: { claim() {} } };
  vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, URL, caches: { open: async () => ({ match: async () => undefined, put() {}, add: async () => {} }), keys: async () => [], delete: async () => true }, fetch: async () => ({ ok: true, type: 'basic', clone() { return this; } }) });
  return listeners;
}
const fetchEvent = (url, method = 'GET') => { const e = { request: { url: 'http://x' + url, method, mode: 'cors' }, responded: false, respondWith(p) { this.responded = true; Promise.resolve(p).catch(() => {}); }, waitUntil() {} }; return e; };
test('service worker: only the listed read-only API endpoints are cached (stale-while-revalidate), static assets handled, the rest untouched', () => {
  const { fetch: onFetch } = loadSw();
  for (const [u, m] of [['/api/auth/me', 'GET'], ['/api/journal', 'GET'], ['/app.js', 'POST']]) { const e = fetchEvent(u, m); onFetch(e); assert.equal(e.responded, false, `${m} ${u}`); }
  for (const [u, m] of [['/api/home', 'GET'], ['/api/ui-modules', 'GET'], ['/api/sales/quick', 'POST']]) { const e = fetchEvent(u, m); e.request.headers = { get: () => null }; onFetch(e); assert.equal(e.responded, true, `${m} ${u} (offline module)`); }
  for (const u of ['/', '/app.js', '/style.css', '/lib/ui.js', '/modules/sales.js', '/icons/icon.svg', '/manifest.json']) { const e = fetchEvent(u); onFetch(e); assert.equal(e.responded, true, u); }
  const cross = { request: { url: 'http://evil/app.js', method: 'GET' }, respondWith() { assert.fail('cross-origin'); } }; onFetch(cross);
});
test('manifest: webmanifest and json copy are identical and installable', () => {
  const a = readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8');
  assert.equal(a, readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'));
  const m = JSON.parse(a);
  assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some((i) => i.purpose === 'maskable') && m.icons.some((i) => i.sizes === '512x512'));
});
