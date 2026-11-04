// DOM-side UI primitives: toasts, accessible modal dialogs (focus trap), confirm/prompt, table enhancement.
// Pure logic they depend on lives in focus.js / html.js and is unit tested; this file is verified in a real browser.
import { nextIndex } from './focus.js';
import { esc, field } from './html.js';
import { icon } from './icons.js';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
export const focusables = (root) => [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest('[hidden]') && el.getClientRects().length);

// ---------- toasts ----------
export function createToaster(container, { dismissLabel = () => 'Dismiss' } = {}) {
  return function toast(message, ok = false, { timeout = 4500 } = {}) {
    const item = document.createElement('div');
    item.className = 'toast-item ' + (ok ? 'ok' : 'err');
    const text = document.createElement('span'); text.textContent = String(message ?? '');
    const close = document.createElement('button'); close.type = 'button'; close.setAttribute('aria-label', dismissLabel()); close.innerHTML = icon('close', { size: 14 });
    item.append(text, close);
    container.className = ok ? 'ok' : 'err'; // class mirrors the newest toast
    container.append(item);
    while (container.children.length > 4) container.firstElementChild.remove();
    const remove = () => { clearTimeout(timer); item.remove(); if (!container.children.length) container.className = ''; };
    const timer = setTimeout(remove, timeout);
    close.addEventListener('click', remove);
    return remove;
  };
}

// ---------- modal ----------
const stack = [];
export const modalDepth = () => stack.length;
let idSeq = 0;

/**
 * Open an accessible modal. Returns { promise, close(value), el }. The promise resolves with the value of the
 * action pressed, or `dismissValue` on Escape / backdrop click.
 * options: { title, bodyHtml, actions:[{label,value,primary,danger,autofocus}], dismissible, dismissValue, className,
 *            ariaLabel, raw, beforeClose(value, el) -> boolean|Promise, onOpen(el, ctl), appRoot, overlayRoot }
 */
export function openModal(options) {
  const { title = '', bodyHtml = '', actions = [], dismissible = true, dismissValue = undefined, className = '', ariaLabel = '', raw = false,
    beforeClose, onOpen, appRoot = document.getElementById('app'), overlayRoot = document.getElementById('overlay-root') } = options;
  const id = `dlg${++idSeq}`;
  const opener = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'overlay' + (className.includes('palette') ? ' top' : '');
  const dlg = document.createElement('div');
  dlg.className = 'dialog ' + className;
  dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true');
  if (ariaLabel) dlg.setAttribute('aria-label', ariaLabel); else if (title) dlg.setAttribute('aria-labelledby', `${id}-t`);
  dlg.innerHTML = raw ? bodyHtml
    : `${title ? `<h2 id="${id}-t">${esc(title)}</h2>` : ''}<div class="dialog-body">${bodyHtml}</div>`
      + (actions.length ? `<div class="dialog-actions">${actions.map((a, i) => `<button type="button" class="${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}" data-modal-i="${i}"${a.autofocus ? ' data-autofocus' : ''}>${esc(a.label)}</button>`).join('')}</div>` : '');
  overlay.append(dlg);
  stack.forEach((m) => { m.overlay.inert = true; });
  if (appRoot) appRoot.inert = true;
  overlayRoot.append(overlay);

  let closed = false; let resolveFn;
  const promise = new Promise((r) => { resolveFn = r; });
  const finish = (value) => {
    if (closed) return; closed = true;
    const i = stack.findIndex((m) => m.overlay === overlay); if (i >= 0) stack.splice(i, 1);
    overlay.remove();
    if (stack.length) stack[stack.length - 1].overlay.inert = false; else if (appRoot) appRoot.inert = false;
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    resolveFn(value);
  };
  const ctl = { el: dlg, overlay, promise, close: finish };
  const attempt = async (value) => { if (beforeClose && (await beforeClose(value, dlg)) === false) return; finish(value); };
  ctl.attempt = attempt;

  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (dismissible) { e.preventDefault(); e.stopPropagation(); finish(dismissValue); } return; }
    if (e.key !== 'Tab') return;
    const els = focusables(dlg); if (!els.length) { e.preventDefault(); return; }
    const cur = els.indexOf(document.activeElement);
    const n = nextIndex(cur, els.length, e.shiftKey);
    if (cur === -1 || (!e.shiftKey && cur === els.length - 1) || (e.shiftKey && cur === 0)) { e.preventDefault(); els[n].focus(); }
  });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && dismissible) finish(dismissValue); });
  dlg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-modal-i]'); if (!b) return;
    attempt(actions[Number(b.dataset.modalI)].value);
  });
  stack.push(ctl);
  const first = dlg.querySelector('[data-autofocus]') ?? focusables(dlg).find((el) => !el.matches('.danger')) ?? focusables(dlg)[0];
  (first ?? dlg).focus?.();
  if (!first) { dlg.tabIndex = -1; dlg.focus(); }
  onOpen?.(dlg, ctl);
  return ctl;
}

/** Replacement for window.confirm. Resolves true / false. */
export function confirmDialog({ title, message = '', confirmLabel, cancelLabel, danger = false }, labels) {
  return openModal({
    title: title ?? labels.confirm, bodyHtml: message ? `<p>${esc(message)}</p>` : '', dismissValue: false,
    actions: [{ label: cancelLabel ?? labels.cancel, value: false, autofocus: danger }, { label: confirmLabel ?? labels.ok, value: true, primary: !danger, danger, autofocus: !danger }],
  }).promise;
}

/** Replacement for window.prompt. Resolves the entered string, or null when cancelled. validate(value) may return an error string. */
export function promptDialog({ title, message = '', label, value = '', type = 'text', required = true, validate, confirmLabel, cancelLabel, placeholder = '' }, labels) {
  const inputId = 'sh-prompt-input';
  const body = (err = '', v = value) => `<form id="sh-prompt-form" novalidate>${message ? `<p>${esc(message)}</p>` : ''}${field({ id: inputId, label: label ?? title ?? '', type, value: v, error: err, required, placeholder, attrs: { 'data-autofocus': true, autocomplete: 'off' } })}</form>`;
  const ctl = openModal({
    title: title ?? label ?? '', bodyHtml: body(), dismissValue: null,
    actions: [{ label: cancelLabel ?? labels.cancel, value: null }, { label: confirmLabel ?? labels.ok, value: '__ok__', primary: true }],
    async beforeClose(v, el) {
      if (v !== '__ok__') return true;
      const input = el.querySelector('#' + inputId); const val = input.value;
      const err = required && !val.trim() ? labels.required : (validate ? validate(val) || '' : '');
      if (err) { el.querySelector('.dialog-body').innerHTML = body(err, val); const i2 = el.querySelector('#' + inputId); i2.focus(); i2.select?.(); return false; }
      return true;
    },
  });
  ctl.el.addEventListener('submit', (e) => { e.preventDefault(); ctl.attempt('__ok__'); });
  return ctl.promise.then((v) => (v === '__ok__' ? ctl.el.querySelector('#' + inputId)?.value ?? '' : null)).catch(() => null);
}

// ---------- tables ----------
/** Wrap tables for sticky headers + horizontal scroll, and add data-label cells so phones can stack rows. */
export function enhanceTables(root) {
  for (const tbl of root.querySelectorAll('table:not([data-enh])')) {
    tbl.dataset.enh = '1';
    const rows = [...tbl.rows];
    const head = rows.find((r) => r.cells.length && [...r.cells].every((c) => c.tagName === 'TH'));
    if (head) {
      const labels = [...head.cells].map((c) => c.textContent.trim());
      head.classList.add('th-row');
      for (const r of rows) {
        if (r === head) continue;
        [...r.cells].forEach((c, i) => { if (c.tagName === 'TD' && !c.hasAttribute('data-label')) c.setAttribute('data-label', labels[i] ?? ''); });
      }
      tbl.classList.add('stack');
    }
    if (!tbl.parentElement.classList.contains('table-wrap')) {
      const wrap = document.createElement('div'); wrap.className = 'table-wrap';
      tbl.replaceWith(wrap); wrap.append(tbl);
    }
  }
}
