// Deterministic readiness signal, so browser tests and performance checks never wait on timers.
//   <html data-ready="loading|ready">   "ready" only while no request or data load is in flight
//   window.__appReady                   false until the shell and the first view finished loading, then true
//   App.ready                           promise that resolves at that same moment (also when the first load failed:
//                                       the error state is then on screen and data-ready-error is set)
// <html data-route="#/sales"> is updated on every render, so a test can wait for a navigation to show.
let busy = 0;
let first = true;
let settle;
export const ready = new Promise((resolve) => { settle = resolve; });
const root = () => document.documentElement;
function sync() { root().dataset.ready = busy || first ? 'loading' : 'ready'; }

window.__appReady = false;
sync();

/** Run fn (sync or async) and count it as busy until it settles. */
export async function tracked(fn) {
  busy++; sync();
  try { return await fn(); } finally { busy--; sync(); }
}

/** Boot calls this once, after the first load. */
export function markReady(error) {
  first = false;
  if (error) root().dataset.readyError = '1';
  sync();
  window.__appReady = true;
  settle();
}
