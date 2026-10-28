import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeCbor, encodeCbor } from '../../src/auth/cbor.ts';
import { authenticationOptions, newChallenge, registrationOptions, relyingPartyFor, verifyAssertion, verifyRegistration } from '../../src/auth/webauthn.ts';
import { SoftAuthenticator, type Kind } from '../support/authenticator.ts';

const rp = relyingPartyFor('https://finance.example.com')!;

function register(kind: Kind = 'ES256') {
  const device = new SoftAuthenticator(rp.id, rp.origin, kind);
  const challenge = newChallenge();
  const registration = verifyRegistration(device.create(challenge), challenge, rp);
  return { device, registration };
}

test('CBOR round-trips the shapes WebAuthn uses and refuses what it does not understand', () => {
  const value = new Map<unknown, unknown>([['fmt', 'none'], [1, -7], [-2, Buffer.from([1, 2, 3])], ['list', [1, 2, 300, 70000]]]);
  const back = decodeCbor(encodeCbor(value as never)) as Map<unknown, unknown>;
  assert.equal(back.get('fmt'), 'none');
  assert.equal(back.get(1), -7);
  assert.deepEqual([...(back.get(-2) as Uint8Array)], [1, 2, 3]);
  assert.deepEqual(back.get('list'), [1, 2, 300, 70000]);
  assert.throws(() => decodeCbor(Buffer.from([0x5f, 0x41, 0x01, 0xff])), /unsupported/);
  assert.throws(() => decodeCbor(Buffer.from([0x01, 0x02])), /extra bytes/);
  assert.throws(() => decodeCbor(Buffer.from([0x42, 0x01])), /unexpected end/);
});

test('relyingPartyFor accepts https and localhost only', () => {
  assert.deepEqual(relyingPartyFor('https://finance.example.com/some/path'), { id: 'finance.example.com', origin: 'https://finance.example.com', name: 'Gata Molhada Finance' });
  assert.equal(relyingPartyFor('http://localhost:5173')?.id, 'localhost');
  assert.equal(relyingPartyFor('http://finance.example.com'), null);
  assert.equal(relyingPartyFor('not a url'), null);
  assert.equal(relyingPartyFor(undefined), null);
});

for (const kind of ['ES256', 'RS256', 'EdDSA'] as Kind[]) {
  test(`registration and login work with a ${kind} passkey, and the counter must go up`, () => {
    const { device, registration } = register(kind);
    assert.equal(registration.credentialId, device.credentialId.toString('base64url'));
    const stored = { credentialId: registration.credentialId, publicKey: registration.publicKey, alg: registration.alg, signCount: registration.signCount };
    const challenge = newChallenge();
    const first = verifyAssertion(device.get(challenge), challenge, rp, stored);
    assert.equal(first.signCount, 1);
    const next = newChallenge();
    assert.throws(() => verifyAssertion(device.get(next, { counter: 1 }), next, rp, { ...stored, signCount: 1 }), /counter/);
    assert.equal(verifyAssertion(device.get(next, { counter: 2 }), next, rp, { ...stored, signCount: 1 }).signCount, 2);
  });
}

test('a small RSA key is refused', () => {
  const device = new SoftAuthenticator(rp.id, rp.origin, 'RS256', 1024);
  const challenge = newChallenge();
  assert.throws(() => verifyRegistration(device.create(challenge), challenge, rp), /unsupported public key/);
});

test('a synced passkey that always reports 0 is accepted', () => {
  const { device, registration } = register();
  const stored = { credentialId: registration.credentialId, publicKey: registration.publicKey, alg: registration.alg, signCount: 0 };
  const challenge = newChallenge();
  assert.equal(verifyAssertion(device.get(challenge, { counter: 0 }), challenge, rp, stored).signCount, 0);
});

test('registration refuses a wrong challenge, origin, ceremony flags and a mismatched credential id', () => {
  const device = new SoftAuthenticator(rp.id, rp.origin);
  const challenge = newChallenge();
  assert.throws(() => verifyRegistration(device.create(challenge, { challenge: newChallenge() }), challenge, rp), /challenge/);
  assert.throws(() => verifyRegistration(device.create(challenge, { origin: 'https://evil.example.com' }), challenge, rp), /origin/);
  assert.throws(() => verifyRegistration(device.create(challenge, { flags: 0x01 }), challenge, rp), /verification/);
  assert.throws(() => verifyRegistration(device.create(challenge, { flags: 0x04 }), challenge, rp), /presence/);
  const other = new SoftAuthenticator('other.example.com', rp.origin);
  assert.throws(() => verifyRegistration(other.create(challenge), challenge, rp), /relying party/);
  const forged = { ...device.create(challenge), rawId: Buffer.from('x'.repeat(32)).toString('base64url') };
  assert.throws(() => verifyRegistration(forged, challenge, rp), /credential id/);
  assert.throws(() => verifyRegistration({ ...device.create(challenge), type: 'password' }, challenge, rp), /public-key/);
});

test('login refuses a bad signature, another key, a wrong challenge or origin, and missing verification', () => {
  const { device, registration } = register();
  const stored = { credentialId: registration.credentialId, publicKey: registration.publicKey, alg: registration.alg, signCount: 0 };
  const challenge = newChallenge();
  assert.throws(() => verifyAssertion(device.get(challenge, { challenge: newChallenge() }), challenge, rp, stored), /challenge/);
  assert.throws(() => verifyAssertion(device.get(challenge, { origin: 'https://evil.example.com' }), challenge, rp, stored), /origin/);
  assert.throws(() => verifyAssertion(device.get(challenge, { flags: 0x01 }), challenge, rp, stored), /verification/);

  const assertion = device.get(challenge);
  const tampered = { ...assertion, response: { ...assertion.response, signature: Buffer.alloc(70, 1).toString('base64url') } };
  assert.throws(() => verifyAssertion(tampered, challenge, rp, stored));
  const attacker = new SoftAuthenticator(rp.id, rp.origin);
  const challenge2 = newChallenge();
  const forged = { ...attacker.get(challenge2), id: stored.credentialId, rawId: stored.credentialId };
  assert.throws(() => verifyAssertion(forged, challenge2, rp, stored), /signature/);
  assert.throws(() => verifyAssertion(device.get(challenge), challenge, rp, { ...stored, credentialId: 'other' }), /credential/);
});

test('option builders ask for a user-verified discoverable passkey and exclude the ones already registered', () => {
  const reg = registrationOptions(rp, 'c', 'u', ['a', 'b']) as { authenticatorSelection: { residentKey: string; userVerification: string }; excludeCredentials: unknown[]; attestation: string; pubKeyCredParams: Array<{ alg: number }> };
  assert.deepEqual([reg.authenticatorSelection.residentKey, reg.authenticatorSelection.userVerification, reg.excludeCredentials.length, reg.attestation], ['required', 'required', 2, 'none']);
  assert.deepEqual(reg.pubKeyCredParams.map((p) => p.alg), [-7, -257, -8]);
  const auth = authenticationOptions(rp, 'c') as { rpId: string; userVerification: string; allowCredentials?: unknown };
  assert.deepEqual([auth.rpId, auth.userVerification, auth.allowCredentials], ['finance.example.com', 'required', undefined]);
});
