// Sign-in screen plumbing: the auth module registers the screen, a 401 AUTH_REQUIRED shows it.
import { esc } from '/lib/html.js';
import { t } from '/core/i18n.js';
import { App } from '/core/host.js';

let loginFn = null;
let loginVisible = false;
export const isLoginVisible = () => loginVisible;
export function setLoginScreen(fn) { if (typeof fn !== 'function') throw new Error('setLoginScreen(fn) needs a function'); loginFn = fn; if (loginVisible) showLogin(true); }
export function showLogin(force = false) {
  if (loginVisible && !force) return;
  loginVisible = true;
  const root = document.getElementById('login');
  let html;
  try { html = loginFn ? loginFn(App) : ''; } catch (e) { console.error('Login screen failed to render:', e); html = ''; }
  root.innerHTML = `<div class="login-screen"><div class="login-box">${html || `<h1>${esc(t('sh.authTitle'))}</h1><p>${esc(t('sh.authNone'))}</p>`}</div></div>`;
  root.hidden = false; document.getElementById('app').hidden = true;
  if (!force || !root.contains(document.activeElement)) (root.querySelector('input,button,a[href]') ?? root).focus?.();
}
export function hideLogin() { loginVisible = false; document.getElementById('login').hidden = true; document.getElementById('login').innerHTML = ''; document.getElementById('app').hidden = false; }
