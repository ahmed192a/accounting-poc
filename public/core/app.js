// Builds the App object handed to every UI module (docs/ARCHITECTURE.md lists the members).
import { esc, field, chip, emptyState, errorState, skeleton, table } from '/lib/html.js';
import { icon } from '/lib/icons.js';
import { formatNumber, formatDate } from '/lib/format.js';
import { buildHash } from '/lib/router.js';
import { openModal, confirmDialog, promptDialog } from '/lib/ui.js';
import { state, has, loc, money, toPiastres } from '/core/state.js';
import { t, addStrings } from '/core/i18n.js';
import { App } from '/core/host.js';
import { api } from '/core/api.js';
import { addCard, addPage, addCommand, addItem, addHandler, headerItems, footerItems, loadHooks, userChangeHooks } from '/core/registry.js';
import { setLoginScreen, showLogin, hideLogin } from '/core/login.js';
import { run, toast, load } from '/core/load.js';
import { render } from '/core/router.js';
import { shellActions } from '/ui/actions.js';
import { ready } from '/core/ready.js';

const dialogLabels = () => ({ ok: t('ok'), cancel: t('sh.cancel'), confirm: t('sh.confirm'), required: t('sh.required') });

Object.assign(App, {
  state, api, run, toast, money, esc, has, t, loc, toPiastres,
  /** Set by the security module after sign-in: sent as x-csrf-token on non-GET requests. */
  csrfToken: null,
  /** Register a dashboard card. area: 'stats' (top row) or 'main' (grid). Optional page / pageTitleKey group it on page #/<page>; wide:true spans the grid. */
  addCard,
  /** Register a full page at #/<id>. render(home) returns HTML. Optional: permission, nav:false (hide from menu), icon. */
  addPage,
  /** Command palette entry: { id, title | titleKey, keywords?, hint?, icon?, permission?, run() }. */
  addCommand,
  /** Items shown in the header after the language button / in the footer after the note. render(home) returns HTML. */
  addHeader: (item) => addItem(headerItems, 'Header item', item),
  addFooter: (item) => addItem(footerItems, 'Footer item', item),
  /** i18n.add(lang, dict): add strings for 'en' or 'ar'. Re-adding a key with different text is an error; identical text is fine. */
  i18n: { add: addStrings },
  /** Click on an element with data-act="action". handler(element, event). */
  on: (action, fn) => addHandler('click', action, fn),
  /** 'change' event on an element with data-act="action". handler(element, event). */
  onChange: (action, fn) => addHandler('change', action, fn),
  /** 'input' event on an element with data-act="action". handler(element, event). */
  onInput: (action, fn) => addHandler('input', action, fn),
  /** After /api/home loads and before rendering: async hook(home) for fetching extra data. */
  onLoad: (fn) => loadHooks.push(fn),
  /** When the user switcher changes: hook() to reset per-user UI state. */
  onUserChange: (fn) => userChangeHooks.push(fn),
  reload: () => load(),
  render: () => render(),
  // ----- navigation, dialogs, auth plumbing, design-system helpers -----
  /** Go to a page id ('home' or a registered page): sets the hash so back/forward work. */
  navigate: (id, rest = []) => { location.hash = buildHash(id, rest); },
  /** Replaces window.confirm. confirm({ title, message, confirmLabel, cancelLabel, danger }) -> Promise<boolean>. */
  confirm: (opts = {}) => confirmDialog(opts, dialogLabels()),
  /** Replaces window.prompt. prompt({ title, message, label, value, type, required, validate(v)->error|'' }) -> Promise<string|null>. */
  prompt: (opts = {}) => promptDialog(opts, dialogLabels()),
  /** Open a custom accessible modal (focus trap, Escape, restores focus). See /lib/ui.js openModal. */
  modal: (opts) => openModal(opts),
  /** Register the sign-in screen: fn(App) returns HTML. Shown on 401 AUTH_REQUIRED. */
  setLoginScreen,
  /** Call after a successful sign-in: hides the login screen and reloads the data. */
  async loginDone() { hideLogin(); state.home = null; await load(); },
  showLogin: () => showLogin(true),
  /** Optional: the auth module may set App.signOut = async () => {...}; the account menu then offers "Sign out". */
  signOut: undefined,
  ui: { field, chip, emptyState, errorState, skeleton, table, icon },
  fmt: { number: (n, o) => formatNumber(n, state.lang, state.digits, o), date: (d, o) => formatDate(d, state.lang, state.digits, o) },
  /** Resolves when the shell and the first view have finished loading (see core/ready.js). */
  ready,
  shellActions, // the design page registers its demo actions here (internal)
});
