// Loading data: toast, run(action), load() = /api/home + module load hooks + render. Readiness is tracked here.
import { createToaster } from '/lib/ui.js';
import { errorState, skeleton } from '/lib/html.js';
import { state } from '/core/state.js';
import { t } from '/core/i18n.js';
import { $ } from '/core/host.js';
import { api } from '/core/api.js';
import { loadHooks } from '/core/registry.js';
import { render } from '/core/router.js';
import { tracked } from '/core/ready.js';

export const toastEl = () => document.getElementById('toast');
let toaster;
export function toast(msg, ok = false) { (toaster ??= createToaster(toastEl(), { dismissLabel: () => t('sh.dismiss') }))(msg, ok); }

// Run an action; toast okMsg on success or the error message on failure; reload the home data and re-render.
export async function run(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg, true); await load(); return r; }
  catch (e) { if (e.code !== 'AUTH_REQUIRED') toast(e.message); }
}

export const load = () => tracked(loadHome);

async function loadHome() {
  if (!state.home) { $('main').innerHTML = skeleton({ cards: 4 }); }
  try {
    const uid = state.userId;
    const home = await api('GET', '/api/home');
    if (uid !== state.userId) return; // the user switched while this was loading; a newer load is running
    state.home = home; // set first: load hooks call has(), which must see the NEW user's permissions (was the source of 403 noise)
    for (const hook of loadHooks) { if (uid !== state.userId) return; await hook(home); }
    render();
  } catch (e) {
    if (e.code === 'AUTH_REQUIRED') return;
    if (!state.home) {
      $('main').innerHTML = errorState({ title: t('sh.loadFailed'), text: e.message, retryLabel: t('sh.retry'), retryAct: 'retry' });
    }
    throw e;
  }
}
