import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../../src/auth/password.ts';
import { hashRecoveryCode } from '../../src/auth/recovery.ts';
import { AuthService, loadAuthConfig, type AuthConfig } from '../../src/auth/service.ts';
import { base32Decode, generateTotpSecret, hotp, totpCounter } from '../../src/auth/totp.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const PASSWORD = 'a long test password';
const RECOVERY = 'abcde-12345';

function setup() {
  const secret = generateTotpSecret();
  const config: AuthConfig = { passwordHash: hashPassword(PASSWORD), totpSecret: secret, recoveryHashes: [hashRecoveryCode(RECOVERY)] };
  const clock = { ms: Date.parse('2026-10-27T12:00:00Z') };
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const auth = new AuthService(store, config, () => new Date(clock.ms));
  const code = (offset = 0) => hotp(base32Decode(secret), totpCounter(clock.ms) + offset);
  return { auth, store, clock, code };
}

test('login with the right password and code creates a session that works until it expires', () => {
  const { auth, clock, code } = setup();
  const result = auth.login(PASSWORD, code());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(auth.verifySession(result.token), true);
  assert.equal(auth.verifySession('other'), false);
  assert.equal(auth.verifySession(null), false);
  clock.ms += 13 * 3_600_000;
  assert.equal(auth.verifySession(result.token), false);
});

test('wrong password or wrong code gives the same answer', () => {
  const { auth, code } = setup();
  assert.deepEqual(auth.login('wrong password!!', code()), { ok: false, reason: 'invalid' });
  assert.deepEqual(auth.login(PASSWORD, '000000'), { ok: false, reason: 'invalid' });
});

test('a TOTP code cannot be used twice, but the next window works', () => {
  const { auth, code } = setup();
  assert.equal(auth.login(PASSWORD, code()).ok, true);
  assert.deepEqual(auth.login(PASSWORD, code()), { ok: false, reason: 'invalid' });
  assert.equal(auth.login(PASSWORD, code(1)).ok, true);
});

test('a failed password does not burn the TOTP code', () => {
  const { auth, code } = setup();
  assert.equal(auth.login('wrong password!!', code()).ok, false);
  assert.equal(auth.login(PASSWORD, code()).ok, true);
});

test('a recovery code works once', () => {
  const { auth } = setup();
  assert.equal(auth.login(PASSWORD, 'ABCDE-12345').ok, true);
  assert.deepEqual(auth.login(PASSWORD, RECOVERY), { ok: false, reason: 'invalid' });
});

test('five failures lock login, even with the right credentials, until the window passes', () => {
  const { auth, clock, code } = setup();
  for (let i = 0; i < 5; i++) auth.login('wrong password!!', '000000');
  const locked = auth.login(PASSWORD, code());
  assert.equal(locked.ok, false);
  assert.equal(!locked.ok && locked.reason, 'locked');
  assert.equal(!locked.ok && locked.reason === 'locked' && locked.retryAfterSeconds, 900);
  clock.ms += 15 * 60_000 + 1000;
  assert.equal(auth.login(PASSWORD, code(1)).ok, true);
});

test('logout removes the session', () => {
  const { auth, code } = setup();
  const result = auth.login(PASSWORD, code());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  auth.logout(result.token);
  assert.equal(auth.verifySession(result.token), false);
});

test('without configuration nobody can log in', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const auth = new AuthService(store, null, () => new Date());
  assert.deepEqual(auth.login(PASSWORD, '123456'), { ok: false, reason: 'not_configured' });
});

test('loadAuthConfig needs both the hash and the secret', () => {
  assert.equal(loadAuthConfig({}), null);
  assert.equal(loadAuthConfig({ AUTH_PASSWORD_HASH: 'x' }), null);
  assert.deepEqual(loadAuthConfig({ AUTH_PASSWORD_HASH: 'h', AUTH_TOTP_SECRET: 's', AUTH_RECOVERY_HASHES: 'a, b,' }), { passwordHash: 'h', totpSecret: 's', recoveryHashes: ['a', 'b'] });
});
