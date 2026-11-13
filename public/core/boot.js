// Boot: discover and register UI modules, load the first view, then signal readiness.
import { registerDesignPage } from '/lib/design-page.js';
import { state, store } from '/core/state.js';
import { t } from '/core/i18n.js';
import { App } from '/core/host.js';
import { load, prefetch } from '/core/load.js';
import { api } from '/core/api.js';
import { renderChrome } from '/ui/chrome.js';
import { markReady } from '/core/ready.js';

export async function boot() {
  performance.mark('acct:boot');
  registerDesignPage(App, { t });
  document.body.classList.toggle('nav-collapsed', store.get('acct.nav') === 'collapsed');
  renderChrome('');
  // Independent requests, started together: the user list (identity header) and the list of UI modules.
  const [users, files] = await Promise.all([
    fetch('/api/demo-users', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    fetch('/api/ui-modules', { credentials: 'same-origin' }).then((r) => r.json()).catch((err) => { console.warn('Could not list UI modules:', err); return []; }),
  ]);
  state.users = Array.isArray(users) ? users : [];
  // /api/home only needs the identity header, so it travels while the module files download and register.
  prefetch.home = api('GET', '/api/home'); prefetch.home.catch(() => {}); // a failure is reported by the first load() that awaits it
  const loaded = await Promise.all((Array.isArray(files) ? files : []).filter((f) => /^[\w.-]+\.js$/.test(f)).map(async (f) => {
    try { return { f, mod: await import('/modules/' + f) }; }
    catch (err) { console.error(`UI module ${f} failed to load:`, err); return null; }
  }));
  for (const m of loaded) {
    if (!m) continue;
    try { m.mod.default(App); } catch (err) { console.error(`UI module ${m.f} failed to register:`, err); }
  }
  performance.mark('acct:modules');
  let failed = false;
  try { await load(); } catch { failed = true; /* error state is on screen */ }
  markReady(failed);
  performance.mark('acct:ready');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker not registered:', err.message));
}
