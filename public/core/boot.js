// Boot: discover and register UI modules, load the first view, then signal readiness.
import { registerDesignPage } from '/lib/design-page.js';
import { state, store } from '/core/state.js';
import { t } from '/core/i18n.js';
import { App } from '/core/host.js';
import { load } from '/core/load.js';
import { renderChrome } from '/ui/chrome.js';
import { markReady } from '/core/ready.js';

export async function boot() {
  registerDesignPage(App, { t });
  document.body.classList.toggle('nav-collapsed', store.get('acct.nav') === 'collapsed');
  renderChrome('');
  try { const r = await fetch('/api/demo-users', { credentials: 'same-origin' }); state.users = r.ok ? await r.json() : []; } catch { state.users = []; }
  if (!Array.isArray(state.users)) state.users = [];
  let files = [];
  try { files = await (await fetch('/api/ui-modules', { credentials: 'same-origin' })).json(); } catch (err) { console.warn('Could not list UI modules:', err); }
  const loaded = await Promise.all(files.filter((f) => /^[\w.-]+\.js$/.test(f)).map(async (f) => {
    try { return { f, mod: await import('/modules/' + f) }; }
    catch (err) { console.error(`UI module ${f} failed to load:`, err); return null; }
  }));
  for (const m of loaded) {
    if (!m) continue;
    try { m.mod.default(App); } catch (err) { console.error(`UI module ${m.f} failed to register:`, err); }
  }
  let failed = false;
  try { await load(); } catch { failed = true; /* error state is on screen */ }
  markReady(failed);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker not registered:', err.message));
}
