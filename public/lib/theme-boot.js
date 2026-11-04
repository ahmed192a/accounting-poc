/* Classic script (no module, no inline code, so a strict CSP works): applies the saved theme and language
   before first paint to avoid a flash. app.js owns everything after boot. */
(function () {
  try {
    var pref = localStorage.getItem('acct.theme');
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = pref === 'light' || pref === 'dark' ? pref : (dark ? 'dark' : 'light');
    var root = document.documentElement;
    root.setAttribute('data-theme', theme);
    var lang = localStorage.getItem('acct.lang');
    if (lang === 'ar') { root.lang = 'ar'; root.dir = 'rtl'; }
    if (localStorage.getItem('acct.nav') === 'collapsed') document.addEventListener('DOMContentLoaded', function () { document.body.classList.add('nav-collapsed'); });
  } catch (e) { /* storage blocked: defaults apply */ }
})();
