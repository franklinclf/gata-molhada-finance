import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../../src/auth/password.ts';
import { generateRecoveryCodes, hashRecoveryCode } from '../../src/auth/recovery.ts';
import { base32Decode, base32Encode, hotp, verifyTotp } from '../../src/auth/totp.ts';

test('HOTP matches the RFC 4226 test vectors', () => {
  const secret = Buffer.from('12345678901234567890');
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  expected.forEach((code, counter) => assert.equal(hotp(secret, counter), code));
});

test('TOTP matches the RFC 6238 SHA-1 vector at time 59 (last 6 digits of 94287082)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(verifyTotp(secret, '287082', 59_000), 1);
});

test('TOTP accepts the neighbour windows and rejects the ones further away', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const code = hotp(Buffer.from('12345678901234567890'), 1);
  assert.equal(verifyTotp(secret, code, 59_000 + 30_000), 1);
  assert.equal(verifyTotp(secret, code, 59_000 + 90_000), null);
  assert.equal(verifyTotp(secret, '12345', 59_000), null);
  assert.equal(verifyTotp(secret, 'abcdef', 59_000), null);
});

test('base32 round-trips', () => {
  const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 7, 8, 9, 10]);
  assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  assert.throws(() => base32Decode('not*base32'));
});

test('password hashes verify only the right password and use a new salt each time', () => {
  const a = hashPassword('correct horse battery');
  assert.notEqual(a, hashPassword('correct horse battery'));
  assert.equal(verifyPassword('correct horse battery', a), true);
  assert.equal(verifyPassword('wrong', a), false);
  assert.equal(verifyPassword('x', 'garbage'), false);
});

test('recovery codes are unique, and hashing ignores case and dashes', () => {
  const codes = generateRecoveryCodes();
  assert.equal(new Set(codes).size, 10);
  assert.match(codes[0]!, /^[0-9a-f]{5}-[0-9a-f]{5}$/);
  assert.equal(hashRecoveryCode('AB12C-34DEF'), hashRecoveryCode('ab12c34def'));
});
