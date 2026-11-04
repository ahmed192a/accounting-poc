// Sign-in screen, first-run setup, invitation acceptance, MFA enrollment, password change and sign-out.
// Contract with the shell: App.setLoginScreen(fn) (fn(App) returns html), App.loginDone(), App.csrfToken.
// Works with an older shell too: without setLoginScreen only the account card is registered.
export default function register(App) {
  const { t, esc, api, run, toast } = App;

  App.i18n.add('en', {
    authPage: 'Security', authSignIn: 'Sign in', authEmail: 'E-mail', authPassword: 'Password', authCode: 'Authenticator code (6 digits)', authBackup: 'or a backup code',
    authSetup: 'First-time setup', authSetupToken: 'Setup token (printed in the server log)', authName: 'Your name', authCreateOwner: 'Create owner account',
    authInvite: 'Accept an invitation', authInviteToken: 'Invitation token', authChoosePw: 'Choose a password (12+ characters)', authAccept: 'Set password',
    authSignOut: 'Sign out', authAccount: 'My account and sign-in security', authMfa: 'Two-step verification (TOTP)', authMfaOn: 'On', authMfaOff: 'Off',
    authEnable: 'Set up', authConfirm: 'Confirm', authSecret: 'Secret (type it into your authenticator app)', authUri: 'Or open this otpauth link', authBackupTitle: 'Backup codes: save them now, each works once',
    authDisable: 'Turn off', authChangePw: 'Change password', authCurrent: 'Current password', authNew: 'New password', authMustChange: 'You must choose a new password before continuing.',
    authDemoHint: 'Demo mode: demo accounts use owner@demo.test, manager@demo.test, clerk@demo.test ... with the demo password in docs/security.md.', authBack: 'Sign-in', authAllDevices: 'Sign out everywhere',
  });
  App.i18n.add('ar', {
    authPage: 'الأمان', authSignIn: 'تسجيل الدخول', authEmail: 'البريد الإلكتروني', authPassword: 'كلمة المرور', authCode: 'رمز المصادقة (6 أرقام)', authBackup: 'أو رمز احتياطي',
    authSetup: 'الإعداد الأول', authSetupToken: 'رمز الإعداد (في سجل الخادم)', authName: 'اسمك', authCreateOwner: 'إنشاء حساب المالك',
    authInvite: 'قبول دعوة', authInviteToken: 'رمز الدعوة', authChoosePw: 'اختر كلمة مرور (12 حرفاً على الأقل)', authAccept: 'تعيين كلمة المرور',
    authSignOut: 'تسجيل الخروج', authAccount: 'حسابي وأمان الدخول', authMfa: 'التحقق بخطوتين (TOTP)', authMfaOn: 'مفعّل', authMfaOff: 'غير مفعّل',
    authEnable: 'إعداد', authConfirm: 'تأكيد', authSecret: 'المفتاح (أدخله في تطبيق المصادقة)', authUri: 'أو افتح رابط otpauth هذا', authBackupTitle: 'رموز احتياطية: احفظها الآن، كل رمز يعمل مرة واحدة',
    authDisable: 'إيقاف', authChangePw: 'تغيير كلمة المرور', authCurrent: 'كلمة المرور الحالية', authNew: 'كلمة المرور الجديدة', authMustChange: 'يجب اختيار كلمة مرور جديدة قبل المتابعة.',
    authDemoHint: 'الوضع التجريبي: حسابات owner@demo.test وغيرها بكلمة المرور التجريبية في docs/security.md.', authBack: 'الدخول', authAllDevices: 'الخروج من كل الأجهزة',
  });

  let me = null, enroll = null, backupCodes = null, accountMsg = null;
  const val = (id) => document.getElementById(id)?.value ?? '';
  const post = async (path, body) => {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(App.csrfToken ? { 'x-csrf-token': App.csrfToken } : {}) }, credentials: 'same-origin', body: JSON.stringify(body ?? {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error?.message ?? 'Error'); e.code = data.error?.code; throw e; }
    return data;
  };
  const setErr = (msg) => { const el = document.getElementById('auth-err'); if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; } };
  const field = (id, label, type = 'text', extra = '') => `<label style="display:block;margin-top:8px">${label}<br><input type="${type}" id="${id}" ${extra} style="width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:6px"></label>`;

  const loginScreen = () => `<div class="card" style="max-width:420px;margin:40px auto">
    <h2>${t('authSignIn')}</h2>
    ${field('auth-email', t('authEmail'), 'email', 'autocomplete="username"')}${field('auth-pw', t('authPassword'), 'password', 'autocomplete="current-password"')}
    <div id="auth-mfa" style="display:none">${field('auth-code', t('authCode'), 'text', 'inputmode="numeric" autocomplete="one-time-code"')}${field('auth-backup', t('authBackup'))}</div>
    <div class="note bad" id="auth-err" style="display:none"></div>
    <div class="row"><button class="primary" data-act="auth-login">${t('authSignIn')}</button></div>
    <details style="margin-top:14px"><summary>${t('authSetup')}</summary>
      ${field('auth-s-token', t('authSetupToken'))}${field('auth-s-name', t('authName'))}${field('auth-s-email', t('authEmail'), 'email')}${field('auth-s-pw', t('authChoosePw'), 'password', 'autocomplete="new-password"')}
      <div class="row"><button data-act="auth-setup">${t('authCreateOwner')}</button></div></details>
    <details style="margin-top:8px"><summary>${t('authInvite')}</summary>
      ${field('auth-i-token', t('authInviteToken'))}${field('auth-i-pw', t('authChoosePw'), 'password', 'autocomplete="new-password"')}
      <div class="row"><button data-act="auth-accept">${t('authAccept')}</button></div></details>
    <p class="sub">${t('authDemoHint')}</p></div>`;

  const finish = (data) => { App.csrfToken = data.csrfToken; me = null; App.loginDone?.(); };
  if (App.setLoginScreen) App.setLoginScreen(loginScreen);

  App.on('auth-login', async () => {
    setErr('');
    try {
      const code = val('auth-code').trim(), backup = val('auth-backup').trim();
      finish(await post('/api/auth/login', { email: val('auth-email'), password: val('auth-pw'), ...(code ? { code } : {}), ...(backup ? { backupCode: backup } : {}) }));
    } catch (e) {
      if (e.code === 'MFA_REQUIRED') { document.getElementById('auth-mfa').style.display = 'block'; setErr(t('authCode')); } else setErr(e.message);
    }
  });
  App.on('auth-setup', async () => {
    setErr('');
    try {
      await post('/api/auth/setup', { token: val('auth-s-token'), name: val('auth-s-name'), email: val('auth-s-email'), password: val('auth-s-pw') });
      finish(await post('/api/auth/login', { email: val('auth-s-email'), password: val('auth-s-pw') }));
    } catch (e) { setErr(e.message); }
  });
  App.on('auth-accept', async () => {
    setErr('');
    try { const r = await post('/api/auth/accept-invite', { token: val('auth-i-token'), password: val('auth-i-pw') }); document.getElementById('auth-email').value = r.email; setErr(''); toast(t('saved'), true); }
    catch (e) { setErr(e.message); }
  });

  App.onLoad(async () => {
    try { me = await api('GET', '/api/auth/me'); if (me.csrfToken) App.csrfToken = me.csrfToken; } catch { me = null; }
  });

  App.addHeader({ id: 'auth.signout', order: 900, render: () => (me?.via === 'session' ? `<button data-act="auth-logout">${t('authSignOut')}</button>` : '') });
  App.on('auth-logout', async () => { try { await post('/api/auth/logout'); } catch { /* already signed out */ } App.csrfToken = null; location.reload(); });
  App.on('auth-logout-all', async () => { try { await post('/api/auth/logout-all'); } catch { /* ignore */ } App.csrfToken = null; location.reload(); });

  App.addCard({
    id: 'auth.account', area: 'main', order: 300, page: 'security', pageTitleKey: 'authPage',
    render: () => {
      if (!me?.hasPassword) return '';
      const msg = accountMsg ? `<div class="note ${accountMsg.cls}">${esc(accountMsg.text)}</div>` : '';
      const mfa = me.mfaEnabled
        ? `<div class="row"><span class="chip good">${t('authMfaOn')}</span></div>${field('auth-d-pw', t('authPassword'), 'password')}${field('auth-d-code', t('authCode'))}<div class="row"><button data-act="auth-mfa-off">${t('authDisable')}</button></div>`
        : enroll
          ? `<p class="sub">${t('authSecret')}</p><div><code>${esc(enroll.secret)}</code></div><p class="sub">${t('authUri')}</p><div class="sub" style="word-break:break-all">${esc(enroll.otpauthUri)}</div>
             ${field('auth-m-code', t('authCode'))}<div class="row"><button class="primary" data-act="auth-mfa-confirm">${t('authConfirm')}</button></div>`
          : `<div class="row"><span class="chip mute">${t('authMfaOff')}</span><button data-act="auth-mfa-on">${t('authEnable')}</button></div>`;
      const codes = backupCodes ? `<div class="note warn"><b>${t('authBackupTitle')}</b><br><code>${backupCodes.map(esc).join(' &nbsp; ')}</code></div>` : '';
      return `<div class="card"><h2>${t('authAccount')}</h2><div class="sub">${esc(me.user.email ?? '')}</div>
        ${me.mustChangePassword ? `<div class="note warn">${t('authMustChange')}</div>` : ''}
        <h2 style="margin-top:12px">${t('authMfa')}</h2>${mfa}${codes}
        <h2 style="margin-top:12px">${t('authChangePw')}</h2>${field('auth-c-cur', t('authCurrent'), 'password')}${field('auth-c-new', t('authNew'), 'password')}
        <div class="row"><button data-act="auth-pw">${t('authChangePw')}</button>${me.via === 'session' ? `<button data-act="auth-logout-all">${t('authAllDevices')}</button>` : ''}</div>${msg}</div>`;
    },
  });
  App.onUserChange(() => { enroll = null; backupCodes = null; accountMsg = null; });

  const act = (fn, ok) => run(async () => { try { await fn(); accountMsg = ok ? { cls: 'good', text: ok } : null; } catch (e) { accountMsg = { cls: 'bad', text: e.message }; } });
  App.on('auth-mfa-on', () => act(async () => { enroll = await api('POST', '/api/auth/mfa/enroll'); }));
  App.on('auth-mfa-confirm', () => act(async () => { backupCodes = (await api('POST', '/api/auth/mfa/confirm', { code: val('auth-m-code') })).backupCodes; enroll = null; }, t('saved')));
  App.on('auth-mfa-off', () => act(async () => { await api('POST', '/api/auth/mfa/disable', { password: val('auth-d-pw'), code: val('auth-d-code') }); backupCodes = null; }, t('saved')));
  App.on('auth-pw', () => act(async () => { await api('POST', '/api/auth/password', { current: val('auth-c-cur'), next: val('auth-c-new') }); }, t('saved')));
}
