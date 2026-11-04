// Pure HTML string builders for the design system (no DOM access). Everything user-supplied is escaped.
import { icon } from './icons.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const attrs = (o = {}) => Object.entries(o).filter(([, v]) => v !== false && v != null)
  .map(([k, v]) => (v === true ? ` ${k}` : ` ${esc(k)}="${esc(v)}"`)).join('');

/** A labelled form control with optional hint and validation message wired by aria-describedby. */
export function field({ id, label, type = 'text', value = '', hint = '', error = '', required = false, name, placeholder = '', options = [], rows = 3, attrs: extra = {} }) {
  if (!id) throw new Error('field needs an id');
  const hintId = `${id}-hint`; const errId = `${id}-err`;
  const described = [hint ? hintId : '', error ? errId : ''].filter(Boolean).join(' ');
  const common = { id, name: name ?? id, required, 'aria-invalid': error ? 'true' : false, 'aria-describedby': described || false, ...extra };
  let control;
  if (type === 'select') {
    control = `<select${attrs(common)}>${options.map((o) => { const v = typeof o === 'object' ? o.value : o; const l = typeof o === 'object' ? o.label : o; return `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;
  } else if (type === 'textarea') {
    control = `<textarea${attrs({ ...common, rows, placeholder })}>${esc(value)}</textarea>`;
  } else {
    control = `<input${attrs({ ...common, type, value, placeholder })}>`;
  }
  return `<div class="field${error ? ' has-error' : ''}"><label for="${esc(id)}">${esc(label)}${required ? '<span class="req" aria-hidden="true"> *</span>' : ''}</label>${control}`
    + (hint ? `<p class="field-hint" id="${hintId}">${esc(hint)}</p>` : '')
    + (error ? `<p class="field-error" id="${errId}" role="alert">${icon('alert', { size: 14 })}<span>${esc(error)}</span></p>` : '') + '</div>';
}

export const chip = (text, kind = '') => `<span class="chip${kind ? ' ' + esc(kind) : ''}">${esc(text)}</span>`;

/** Empty state. action = { href?, act?, label } rendered as a link (href) or a button (data-sh action). */
export function emptyState({ title, text = '', iconName = 'inbox', action } = {}) {
  const a = !action ? '' : action.href
    ? `<a class="btn" href="${esc(action.href)}">${esc(action.label)}</a>`
    : `<button type="button" class="btn" data-sh="${esc(action.act)}">${esc(action.label)}</button>`;
  return `<div class="state state-empty">${icon(iconName, { size: 32 })}<h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${a}</div>`;
}

export function errorState({ title, text = '', retryLabel = '', retryAct = 'retry' } = {}) {
  return `<div class="state state-error" role="alert">${icon('alert', { size: 32 })}<h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}`
    + (retryLabel ? `<button type="button" class="btn" data-sh="${esc(retryAct)}">${esc(retryLabel)}</button>` : '') + '</div>';
}

/** Loading skeleton: `cards` placeholder cards with `lines` text lines each. aria-busy marks it for assistive tech. */
export function skeleton({ cards = 3, lines = 3 } = {}) {
  const card = `<div class="card skel-card" aria-hidden="true"><div class="skel skel-title"></div>${'<div class="skel skel-line"></div>'.repeat(lines)}</div>`;
  return `<div class="grid" role="status" aria-busy="true" aria-live="polite"><span class="sr-only">Loading</span>${card.repeat(cards)}</div>`;
}

/** Simple table. columns: [{ key, label, num? }]; rows: array of objects (values escaped unless { html }). */
export function table({ columns, rows, caption = '' }) {
  const cell = (v) => (v && typeof v === 'object' && 'html' in v ? v.html : esc(v));
  return `<table>${caption ? `<caption class="sr-only">${esc(caption)}</caption>` : ''}<tr>${columns.map((c) => `<th${c.num ? ' class="num"' : ''} scope="col">${esc(c.label)}</th>`).join('')}</tr>`
    + rows.map((r) => `<tr>${columns.map((c) => `<td${c.num ? ' class="num"' : ''}>${cell(r[c.key])}</td>`).join('')}</tr>`).join('') + '</table>';
}

/** Plain text of an HTML fragment's first element matching <h2>; used to index card titles for search. */
export function textOf(html) {
  return String(html ?? '').replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]))
    .replace(/\s+/g, ' ').trim();
}
export function cardTitle(html) {
  const m = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(String(html ?? ''));
  return m ? textOf(m[1]) : '';
}
