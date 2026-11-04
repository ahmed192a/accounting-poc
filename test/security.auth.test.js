import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, addUser, roleId, OWNER_PW, DEMO_PASSWORD } from './security.helpers.js';
import { totp, base32Decode } from '../src/modules/auth/totp.js';

const withApp = (opts, fn) => async () => {
  const app = await boot(opts);
  try { await fn(app); } finally { await app.close(); }
};
const codeNow = (app, secret, shift = 0) => totp(base32Decode(secret), app.ctx.now() + shift);

test('demo mode: x-user-id identity works exactly as before, sessions are optional', withApp({}, async (app) => {
  const users = await app.call('GET', '/api/demo-users');
  assert.equal(users.body.length, 6);
  assert.equal((await app.call('GET', '/api/home')).body.error.code, 'UNKNOWN_USER');   // no identity: same error as before
  assert.equal((await app.call('GET', '/api/home', { as: 1 })).status, 200);
  assert.equal((await app.call('GET', '/api/reports', { as: 3 })).status, 403);          // clerk still denied
  assert.equal((await app.call('GET', '/api/home', { as: 999 })).body.error.code, 'UNKNOWN_USER');
  assert.equal((await app.call('POST', '/api/dev/advance-clock', { as: 1, body: { hours: 1 } })).status, 201);
  // a demo user can also sign in for real with the documented demo credentials
  const r = await app.login('owner@demo.test', DEMO_PASSWORD);
  assert.equal(r.status, 200);
  assert.equal((await app.call('GET', '/api/auth/me')).body.via, 'session');
}));

test('headers: CSP without unsafe-inline scripts, nosniff, frame-ancestors none, referrer policy, request id', withApp({}, async (app) => {
  for (const path of ['/', '/api/demo-users', '/app.js']) {
    const r = await app.call('GET', path);
    const csp = r.headers.get('content-security-policy');
    const script = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src'));
    assert.equal(script, "script-src 'self'", path);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.ok(r.headers.get('x-request-id'));
  }
  const mine = await app.call('GET', '/api/home', { headers: { 'x-request-id': 'trace-abc-12345' } });
  assert.equal(mine.headers.get('x-request-id'), 'trace-abc-12345');
  assert.equal(mine.body.error.requestId, 'trace-abc-12345');
  assert.notEqual((await app.call('GET', '/healthz', { headers: { 'x-request-id': 'bad id!' } })).headers.get('x-request-id'), 'bad id!');
}));

test('errors never leak stack traces; the client gets a request id and the log gets the stack', withApp({}, async (app) => {
  app.ctx.registry.routes.push({ method: 'GET', path: '/api/boom', re: /^\/api\/boom$/, names: [], isPublic: true, meta: {}, handler: () => { throw new Error('db password is hunter2'); } });
  const origErr = console.error; console.error = () => {};
  try {
    const r = await app.call('GET', '/api/boom');
    assert.equal(r.status, 500);
    assert.equal(r.body.error.code, 'INTERNAL');
    assert.ok(!r.text.includes('hunter2') && !r.text.includes('at ') && !r.text.includes('.js'));
    assert.ok(app.logs.some((l) => l.level === 'error' && l.msg.includes('hunter2') && l.requestId === r.body.error.requestId));
  } finally { console.error = origErr; }
}));

test('structured request log: one line per request with id, status, no query string', withApp({}, async (app) => {
  await app.call('GET', '/api/audit?q=secret-search-term', { as: 1 });
  const line = app.logs.find((l) => l.path === '/api/audit');
  assert.ok(line);
  assert.equal(line.method, 'GET'); assert.equal(line.status, 200); assert.equal(line.user, 1); assert.equal(line.via, 'header');
  assert.match(line.requestId, /[0-9a-f-]{8,}/);
  assert.ok(!JSON.stringify(app.logs).includes('secret-search-term'));
}));

test('required mode: header identity is refused, status and static stay public, demo list is hidden', withApp({ required: true }, async (app) => {
  const r = await app.call('GET', '/api/home', { as: 1 });
  assert.equal(r.status, 401); assert.equal(r.body.error.code, 'AUTH_REQUIRED');
  assert.equal((await app.call('GET', '/api/home')).body.error.code, 'AUTH_REQUIRED');
  assert.deepEqual((await app.call('GET', '/api/demo-users')).body, []);
  assert.equal((await app.call('GET', '/healthz')).status, 200);
  assert.equal((await app.call('GET', '/')).status, 200);
  assert.deepEqual((await app.call('GET', '/api/auth/status')).body, { authRequired: true, setupNeeded: false, demoCredentials: false });
}));

test('required mode: AUTH_REQUIRED must be exactly "1" (anything else keeps demo identity)', async () => {
  const app = await boot({ env: { AUTH_REQUIRED: 'true' }, authRequired: undefined });
  try { assert.equal((await app.call('GET', '/api/home', { as: 1 })).status, 200); } finally { await app.close(); }
});

test('first run: INITIAL_OWNER_PASSWORD creates the owner; demo credentials from a demo database are disabled', withApp({ required: true }, async (app) => {
  // the database was seeded in demo mode, so demo logins existed until the required-mode start disabled them
  assert.equal((await app.login('owner@demo.test', DEMO_PASSWORD)).status, 401);
  assert.equal((await app.login('admin@demo.test', DEMO_PASSWORD)).status, 401);
  assert.equal(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM auth_credentials WHERE demo = 1 AND password_hash IS NOT NULL').get().n, 0);
  assert.equal((await app.login('owner@example.test', 'wrong-password-123')).status, 401);
  const ok = await app.loginOwner();
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, 'owner');
  assert.equal((await app.call('GET', '/api/home')).status, 200);
}));

test('first run without a password: a one-time setup token is logged and sets up the owner once', async () => {
  const lines = [];
  const app = await boot({ required: true, env: { INITIAL_OWNER_PASSWORD: '' }, logger: (e) => lines.push(e.msg ?? '') });
  try {
    const token = lines.join('\n').match(/setup_[\w-]+/)?.[0];
    assert.ok(token, 'token printed to the log');
    assert.equal((await app.call('GET', '/api/auth/status')).body.setupNeeded, true);
    const bad = await app.call('POST', '/api/auth/setup', { body: { token: 'setup_nope', email: 'o@example.test', password: OWNER_PW }, csrf: false });
    assert.equal(bad.body.error.code, 'INVALID_SETUP_TOKEN');
    const weak = await app.call('POST', '/api/auth/setup', { body: { token, email: 'o@example.test', password: 'weak' }, csrf: false });
    assert.equal(weak.body.error.code, 'WEAK_PASSWORD');
    assert.equal((await app.call('POST', '/api/auth/setup', { body: { token, email: 'o@example.test', password: OWNER_PW, name: 'Founder' }, csrf: false })).status, 200);
    assert.equal((await app.call('POST', '/api/auth/setup', { body: { token, email: 'x@example.test', password: OWNER_PW }, csrf: false })).status, 403, 'token is single use');
    const r = await app.login('o@example.test', OWNER_PW);
    assert.equal(r.body.user.name, 'Founder');
    assert.ok(!JSON.stringify(app.ctx.db.prepare('SELECT * FROM auth_secrets').all()).includes(token), 'only a hash of the token is kept');
  } finally { await app.close(); }
});

test('login and logout: HttpOnly SameSite=Lax cookie, hashed session at rest, logout revokes', withApp({ required: true }, async (app) => {
  const r = await app.loginOwner();
  const sid = r.setCookie.find((c) => c.startsWith('acc_sid='));
  assert.match(sid, /HttpOnly/); assert.match(sid, /SameSite=Lax/); assert.match(sid, /Path=\//); assert.match(sid, /Max-Age=\d+/);
  assert.ok(!r.setCookie.find((c) => c.startsWith('acc_csrf=')).includes('HttpOnly'), 'csrf copy must be readable by the UI');
  const token = app.jar.get('acc_sid');
  assert.ok(!JSON.stringify(app.ctx.db.prepare('SELECT * FROM auth_sessions').all()).includes(token), 'DB stores only a hash');
  assert.equal((await app.call('GET', '/api/auth/me')).body.user.email, 'owner@example.test');
  const out = await app.call('POST', '/api/auth/logout');
  assert.equal(out.status, 200);
  assert.equal((await app.call('GET', '/api/home')).body.error.code, 'AUTH_REQUIRED');
  app.jar.set('acc_sid', token); // replaying the old cookie must not work
  assert.equal((await app.call('GET', '/api/home')).body.error.code, 'AUTH_REQUIRED');
}));

test('login failures: unknown e-mail and wrong password look the same; inputs validated', withApp({ required: true }, async (app) => {
  const a = await app.login('nobody@example.test', 'Whatever-Password-1');
  const b = await app.login('owner@example.test', 'Whatever-Password-1');
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.body.error.code, b.body.error.code); assert.equal(a.body.error.message, b.body.error.message);
  assert.equal((await app.call('POST', '/api/auth/login', { body: {}, csrf: false })).body.error.code, 'BAD_INPUT');
}));

test('lockout: five failures lock the account with doubling backoff; a correct password does not bypass it', withApp({ required: true }, async (app) => {
  for (let i = 1; i <= 4; i++) assert.equal((await app.login('owner@example.test', 'bad-password-' + i)).body.error.code, 'INVALID_CREDENTIALS');
  const fifth = await app.login('owner@example.test', 'bad-password-5');
  assert.equal(fifth.status, 429); assert.equal(fifth.body.error.code, 'ACCOUNT_LOCKED');
  assert.equal(fifth.body.error.retryAfter, 60);
  assert.equal(fifth.headers.get('retry-after'), '60');
  assert.equal((await app.loginOwner()).body.error.code, 'ACCOUNT_LOCKED', 'right password, still locked');
  app.ctx.offsetMs += 61_000;
  assert.equal((await app.login('owner@example.test', 'bad-password-6')).body.error.retryAfter, 120, 'second lock is twice as long');
  app.ctx.offsetMs += 121_000;
  assert.equal((await app.loginOwner()).status, 200);
  assert.equal(app.ctx.db.prepare('SELECT failed_count FROM auth_credentials WHERE email = ?').get('owner@example.test').failed_count, 0, 'success resets the counter');
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'auth.locked'").get());
}));

test('admin can unlock a locked user', withApp({ required: true }, async (app) => {
  await app.loginOwner();
  const u = await addUser(app, { name: 'Sara', email: 'sara@example.test', roleId: roleId(app.ctx, 'clerk') });
  for (let i = 0; i < 5; i++) await app.call('POST', '/api/auth/login', { body: { email: u.email, password: 'wrong-wrong-wrong-1' }, csrf: false });
  assert.equal((await app.call('POST', '/api/auth/login', { body: { email: u.email, password: u.password }, csrf: false })).status, 429);
  assert.equal((await app.call('POST', `/api/auth/users/${u.id}/unlock`)).status, 200);
  assert.equal((await app.call('POST', '/api/auth/login', { body: { email: u.email, password: u.password }, csrf: false })).status, 200);
}));

test('sessions: idle expiry slides with use, absolute expiry does not move', withApp({ required: true }, async (app) => {
  await app.loginOwner();
  const idle = app.ctx.security.sessionIdleMs;
  app.ctx.offsetMs += idle - 60_000;
  assert.equal((await app.call('GET', '/api/home')).status, 200, 'still inside the idle window; activity extends it');
  app.ctx.offsetMs += idle - 60_000;
  assert.equal((await app.call('GET', '/api/home')).status, 200, 'extended by the previous request');
  app.ctx.offsetMs += idle + 1000;
  const gone = await app.call('GET', '/api/home');
  assert.equal(gone.status, 401); assert.equal(gone.body.error.code, 'AUTH_REQUIRED'); assert.equal(gone.body.error.reason, 'session_expired');
  assert.ok(gone.setCookie.some((c) => c.startsWith('acc_sid=;') && /Max-Age=0/.test(c)), 'expired cookie is cleared');

  await app.loginOwner();
  const abs = app.ctx.security.sessionAbsoluteMs;
  for (let spent = 0; spent + 3_600_000 < abs; spent += 3_600_000) { app.ctx.offsetMs += 3_600_000; assert.equal((await app.call('GET', '/api/home')).status, 200); }
  app.ctx.offsetMs += 3_600_000 + 1000;
  assert.equal((await app.call('GET', '/api/home')).body.error.code, 'AUTH_REQUIRED', 'absolute lifetime ends even with constant activity');
}));

test('sessions: id is rotated periodically; the old id survives only a short grace period', withApp({ required: true }, async (app) => {
  await app.loginOwner();
  const first = app.jar.get('acc_sid');
  app.ctx.offsetMs += app.ctx.security.rotateEveryMs + 1000;
  const r = await app.call('GET', '/api/home');
  assert.equal(r.status, 200);
  const second = app.jar.get('acc_sid');
  assert.notEqual(first, second);
  assert.ok(r.setCookie.some((c) => c.startsWith('acc_sid=')));
  app.jar.set('acc_sid', first);
  assert.equal((await app.call('GET', '/api/home')).status, 200, 'parallel request with the old id inside the grace period');
  app.ctx.offsetMs += app.ctx.security.rotationGraceMs + 1000;
  assert.equal((await app.call('GET', '/api/home')).status, 401, 'old id dead after the grace period');
  app.jar.set('acc_sid', second);
  assert.equal((await app.call('GET', '/api/home')).status, 200);
  assert.notEqual(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 0);
}));

test('CSRF: cookie sessions need the x-csrf-token on writes; keys and GETs do not', withApp({ required: true }, async (app) => {
  await app.loginOwner();
  const body = { name: 'ci', permissions: ['audit.view'] };
  const none = await app.call('POST', '/api/apikeys', { body, csrf: false });
  assert.equal(none.status, 403); assert.equal(none.body.error.code, 'CSRF_FAILED');
  assert.equal((await app.call('POST', '/api/apikeys', { body, csrf: 'wrong-token' })).body.error.code, 'CSRF_FAILED');
  assert.equal((await app.call('POST', '/api/apikeys', { body: { ...body, name: 'x' }, headers: { origin: 'https://evil.example' } })).body.error.code, 'CSRF_FAILED', 'foreign Origin refused even with the token');
  const ok = await app.call('POST', '/api/apikeys', { body });
  assert.equal(ok.status, 201);
  assert.equal((await app.call('GET', '/api/apikeys', { csrf: false })).status, 200, 'safe methods need no token');
  const me = await app.call('GET', '/api/auth/me');
  assert.equal(me.body.csrfToken, app.state.csrf, 'the UI can recover the token after a reload');
  // an API key is not ambient browser authority: no CSRF header needed
  app.jar.clear();
  assert.equal((await app.call('GET', '/api/audit', { key: ok.body.key, csrf: false })).status, 200);
}));

test('MFA: enroll, confirm with a TOTP code, login needs the code, replay and wrong codes fail, backup code works once', withApp({ required: true }, async (app) => {
  await app.loginOwner();
  const enr = await app.call('POST', '/api/auth/mfa/enroll');
  assert.match(enr.body.otpauthUri, /^otpauth:\/\/totp\/Accounting:owner%40example\.test\?secret=[A-Z2-7]{32}&issuer=Accounting/);
  assert.equal((await app.call('POST', '/api/auth/mfa/confirm', { body: { code: '000000' } })).body.error.code, 'INVALID_MFA_CODE');
  const conf = await app.call('POST', '/api/auth/mfa/confirm', { body: { code: codeNow(app, enr.body.secret) } });
  assert.equal(conf.status, 200); assert.equal(conf.body.backupCodes.length, 10);
  assert.match(conf.body.backupCodes[0], /^[0-9a-f]{5}-[0-9a-f]{5}$/);
  const dbText = JSON.stringify(app.ctx.db.prepare('SELECT * FROM auth_credentials').all()) + JSON.stringify(app.ctx.db.prepare('SELECT * FROM auth_backup_codes').all());
  assert.ok(!dbText.includes(enr.body.secret), 'TOTP secret is encrypted at rest');
  assert.ok(!dbText.includes(conf.body.backupCodes[0]), 'backup codes are hashed');
  assert.equal((await app.call('POST', '/api/auth/mfa/enroll')).body.error.code, 'MFA_ALREADY_ENABLED');
  await app.call('POST', '/api/auth/logout');

  app.ctx.offsetMs += 31_000; // a fresh time step: the enrollment code is spent
  assert.equal((await app.loginOwner()).body.error.code, 'MFA_REQUIRED');
  assert.equal((await app.login('owner@example.test', OWNER_PW, { code: '123456' })).body.error.code, 'INVALID_MFA_CODE');
  assert.equal((await app.login('owner@example.test', 'wrong-pass-xx-1', { code: codeNow(app, enr.body.secret) })).body.error.code, 'INVALID_CREDENTIALS');
  const good = codeNow(app, enr.body.secret);
  assert.equal((await app.login('owner@example.test', OWNER_PW, { code: good })).status, 200);
  await app.call('POST', '/api/auth/logout');
  assert.equal((await app.login('owner@example.test', OWNER_PW, { code: good })).body.error.code, 'INVALID_MFA_CODE', 'same code cannot be replayed');
  app.ctx.offsetMs += 60_000;
  assert.equal((await app.login('owner@example.test', OWNER_PW, { code: codeNow(app, enr.body.secret, -30_000) })).status, 200, 'one step of clock skew is tolerated');
  await app.call('POST', '/api/auth/logout');

  const backup = conf.body.backupCodes[3];
  assert.equal((await app.login('owner@example.test', OWNER_PW, { backupCode: backup })).status, 200);
  await app.call('POST', '/api/auth/logout');
  assert.equal((await app.login('owner@example.test', OWNER_PW, { backupCode: backup })).body.error.code, 'INVALID_MFA_CODE', 'backup codes are one-time');
}));

test('MFA: admin reset removes enrollment; disabling needs password and code', withApp({ required: true }, async (app) => {
  await app.loginOwner();
  const enr = await app.call('POST', '/api/auth/mfa/enroll');
  await app.call('POST', '/api/auth/mfa/confirm', { body: { code: codeNow(app, enr.body.secret) } });
  app.ctx.offsetMs += 31_000;
  assert.equal((await app.call('POST', '/api/auth/mfa/disable', { body: { password: OWNER_PW, code: '000000' } })).body.error.code, 'INVALID_MFA_CODE');
  assert.equal((await app.call('POST', '/api/auth/mfa/disable', { body: { password: 'nope-nope-nope-1', code: codeNow(app, enr.body.secret) } })).body.error.code, 'INVALID_CREDENTIALS');
  assert.equal((await app.call('POST', '/api/auth/mfa/disable', { body: { password: OWNER_PW, code: codeNow(app, enr.body.secret) } })).status, 200);
  assert.equal((await app.call('GET', '/api/auth/me')).body.mfaEnabled, false);
}));
