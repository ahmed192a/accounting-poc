import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hotp, totp, verifyTotp, base32Encode, base32Decode, otpauthUri, newSecret } from '../src/modules/auth/totp.js';
import { hashPassword, verifyPassword } from '../src/modules/auth/crypto.js';
import { passwordProblems } from '../src/modules/auth/policy.js';

// RFC 6238 appendix B test vectors (8 digits). Secrets are the ASCII strings from the RFC.
const K1 = Buffer.from('12345678901234567890');
const K256 = Buffer.from('12345678901234567890123456789012');
const K512 = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234');
const VECTORS = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
];

test('TOTP: RFC 6238 test vectors for SHA-1, SHA-256 and SHA-512', () => {
  for (const [t, s1, s256, s512] of VECTORS) {
    assert.equal(totp(K1, t * 1000, { digits: 8, algo: 'sha1' }), s1, `sha1 @${t}`);
    assert.equal(totp(K256, t * 1000, { digits: 8, algo: 'sha256' }), s256, `sha256 @${t}`);
    assert.equal(totp(K512, t * 1000, { digits: 8, algo: 'sha512' }), s512, `sha512 @${t}`);
  }
});

test('HOTP: RFC 4226 appendix D values and 6-digit truncation', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  expected.forEach((v, i) => assert.equal(hotp(K1, i), v));
  assert.equal(totp(K1, 59000), '287082'); // the familiar 6-digit form of the first RFC 6238 vector
});

test('TOTP verification: clock-skew window, replay protection, malformed input', () => {
  const t = 1111111111_000;
  const code = totp(K1, t);
  assert.equal(verifyTotp(K1, code, t), Math.floor(t / 30000));
  assert.notEqual(verifyTotp(K1, code, t + 30_000), null, 'one step late is accepted');
  assert.notEqual(verifyTotp(K1, code, t - 30_000), null, 'one step early is accepted');
  assert.equal(verifyTotp(K1, code, t + 90_000), null, 'three steps away is refused');
  assert.equal(verifyTotp(K1, code, t, { afterCounter: Math.floor(t / 30000) }), null, 'a used step cannot be replayed');
  assert.equal(verifyTotp(K1, '12345', t), null);
  assert.equal(verifyTotp(K1, 'abcdef', t), null);
  assert.equal(verifyTotp(K1, undefined, t), null);
});

test('base32 and otpauth URI', () => {
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(base32Decode('mzxw 6ytb-oi').toString(), 'foobar');
  assert.throws(() => base32Decode('!!'), /Invalid base32/);
  const secret = newSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  const uri = otpauthUri({ secret, account: 'a b@example.com', issuer: 'Acme & Co' });
  assert.match(uri, /^otpauth:\/\/totp\/Acme%20%26%20Co:a%20b%40example\.com\?secret=[A-Z2-7]{32}&issuer=Acme%20%26%20Co&algorithm=SHA1&digits=6&period=30$/);
});

test('passwords: scrypt hashes are salted and verify; policy rejects weak choices', () => {
  const h1 = hashPassword('Correct-Horse-Battery-9'), h2 = hashPassword('Correct-Horse-Battery-9');
  assert.match(h1, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(h1, h2);
  assert.ok(verifyPassword('Correct-Horse-Battery-9', h1));
  assert.ok(!verifyPassword('correct-horse-battery-9', h1));
  assert.ok(!verifyPassword('x', 'not-a-hash'));

  assert.ok(passwordProblems('short1A!').length);
  assert.ok(passwordProblems('password1234').length, 'common');
  assert.ok(passwordProblems('aaaaaaaaaaaaaa').length, 'one repeated character');
  assert.ok(passwordProblems('mona-is-great-2026', { email: 'mona@example.com' }).length, 'contains the e-mail name');
  assert.ok(passwordProblems('onlylowercase').length, 'single class under 20 chars');
  assert.deepEqual(passwordProblems('Correct-Horse-Battery-9', { email: 'zed@example.com', name: 'Zed' }), []);
  assert.deepEqual(passwordProblems('a very long passphrase with only lowercase'), []);
});
