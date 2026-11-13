// Hook between full mode and the simple-mode shell in public/simple/ (DESIGN_PLAN 4.1).
// Setting `ui.mode = simple | full` per user is kept in this browser's storage (key acct.ui.mode.<userId>, or .session when signed in
// with a real session). UNVERIFIED limitation: it is per device, not per account on the server; a server-side user setting needs a
// small API addition that is left for a follow-up. The simple shell writes the key; this file only reads it and offers the link.
export default function register(App) {
  const { state, i18n } = App;
  i18n.add('en', { simpleMode: 'Simple mode' });
  i18n.add('ar', { simpleMode: 'الوضع المبسط' });
  const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const key = () => `acct.ui.mode.${state.users.length ? state.userId : 'session'}`;

  // Opened from the simple shell's "Full mode" link (?full=1): stay here. Otherwise a user whose mode is simple goes to the simple shell.
  const stay = /[?&]full=1\b/.test(location.search);
  App.onLoad(() => { if (!stay && get(key()) === 'simple') location.replace('/simple/'); });

  App.addHeader({ id: 'simple.link', order: 5, render: () => `<a class="btn ghost" id="simple-link" href="/simple/">${App.t('simpleMode')}</a>` });
}
