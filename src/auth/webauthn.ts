import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type KeyObject } from 'node:crypto';
import { decodeCbor, decodeCborPrefix, type CborValue } from './cbor.ts';

/**
 * Passkeys (WebAuthn), verified with node:crypto and no library. Registration asks for no attestation, so a
 * registration proves possession of a new key, not which device made it. Only user-verified (biometric or PIN)
 * ceremonies are accepted.
 */

export const ALGORITHMS = [-7, -257, -8] as const; // ES256, RS256, EdDSA
export type CoseAlgorithm = (typeof ALGORITHMS)[number];

const b64 = (data: Uint8Array | Buffer) => Buffer.from(data).toString('base64url');
const fromB64 = (text: string) => Buffer.from(text, 'base64url');
const sha256 = (data: Uint8Array | Buffer) => createHash('sha256').update(data).digest();

export function newChallenge(): string {
  return b64(randomBytes(32));
}

export interface RelyingParty {
  /** Domain the passkeys belong to, for example gm-finance.example.com. Changing it makes every passkey unusable. */
  id: string;
  /** Exact origin the browser reports, for example https://gm-finance.example.com. */
  origin: string;
  name: string;
}

/** Builds the relying party from a public origin. http is allowed only for localhost, as browsers require. */
export function relyingPartyFor(publicOrigin: string | undefined, name = 'Gata Molhada Finance'): RelyingParty | null {
  if (!publicOrigin) return null;
  try {
    const url = new URL(publicOrigin);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
    return { id: url.hostname, origin: url.origin, name };
  } catch {
    return null;
  }
}

interface AuthData {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  rest: Buffer;
}

function parseAuthData(data: Buffer): AuthData {
  if (data.length < 37) throw new Error('authenticator data is too short');
  return { rpIdHash: data.subarray(0, 32), flags: data[32]!, signCount: data.readUInt32BE(33), rest: data.subarray(37) };
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

function checkClientData(clientDataJSON: string, type: 'webauthn.create' | 'webauthn.get', expectedChallenge: string, rp: RelyingParty): Buffer {
  const raw = fromB64(clientDataJSON);
  let data: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('client data is not JSON');
  }
  if (data.type !== type) throw new Error('wrong ceremony type');
  if (typeof data.challenge !== 'string' || !safeEqual(data.challenge, expectedChallenge)) throw new Error('challenge does not match');
  if (data.origin !== rp.origin) throw new Error('origin does not match');
  if (data.crossOrigin === true) throw new Error('cross-origin ceremonies are refused');
  return raw;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function checkAuthData(auth: AuthData, rp: RelyingParty): void {
  if (!timingSafeEqual(auth.rpIdHash, sha256(Buffer.from(rp.id)))) throw new Error('relying party does not match');
  if (!(auth.flags & FLAG_UP)) throw new Error('user presence is missing');
  if (!(auth.flags & FLAG_UV)) throw new Error('user verification (biometric or PIN) is required');
}

/** Turns a COSE public key into a key node:crypto can verify with. */
function coseToKey(cose: CborValue): { key: KeyObject; alg: CoseAlgorithm } {
  if (!(cose instanceof Map)) throw new Error('public key is not a COSE map');
  const get = (k: number) => cose.get(k);
  const alg = get(3);
  const kty = get(1);
  if (alg === -7 && kty === 2 && get(-1) === 1 && get(-2) instanceof Uint8Array && get(-3) instanceof Uint8Array) {
    return { alg: -7, key: createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64(get(-2) as Uint8Array), y: b64(get(-3) as Uint8Array) }, format: 'jwk' }) };
  }
  if (alg === -257 && kty === 3 && get(-1) instanceof Uint8Array && (get(-1) as Uint8Array).length >= 256 && get(-2) instanceof Uint8Array) {
    return { alg: -257, key: createPublicKey({ key: { kty: 'RSA', n: b64(get(-1) as Uint8Array), e: b64(get(-2) as Uint8Array) }, format: 'jwk' }) };
  }
  if (alg === -8 && kty === 1 && get(-1) === 6 && get(-2) instanceof Uint8Array) {
    return { alg: -8, key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64(get(-2) as Uint8Array) }, format: 'jwk' }) };
  }
  throw new Error('unsupported public key type');
}

export interface Registration {
  credentialId: string;
  /** SPKI DER of the public key, base64. */
  publicKey: string;
  alg: CoseAlgorithm;
  signCount: number;
  transports: string[];
}

export interface RegistrationInput {
  id: string;
  rawId: string;
  type: string;
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
}

export function verifyRegistration(input: RegistrationInput, expectedChallenge: string, rp: RelyingParty): Registration {
  if (input.type !== 'public-key') throw new Error('not a public-key credential');
  checkClientData(input.response.clientDataJSON, 'webauthn.create', expectedChallenge, rp);
  const attestation = decodeCbor(fromB64(input.response.attestationObject));
  if (!(attestation instanceof Map)) throw new Error('attestation object is not a map');
  const authBytes = attestation.get('authData');
  if (!(authBytes instanceof Uint8Array)) throw new Error('attestation has no authenticator data');
  const auth = parseAuthData(Buffer.from(authBytes));
  checkAuthData(auth, rp);
  if (!(auth.flags & FLAG_AT)) throw new Error('no credential in the attestation');
  if (auth.rest.length < 18) throw new Error('credential data is too short');
  const idLength = auth.rest.readUInt16BE(16);
  if (idLength < 16 || idLength > 1023 || auth.rest.length < 18 + idLength) throw new Error('credential id has a bad length');
  const credentialId = auth.rest.subarray(18, 18 + idLength);
  if (!safeEqual(b64(credentialId), input.rawId) || input.rawId !== input.id) throw new Error('credential id does not match');
  const { value: cose } = decodeCborPrefix(auth.rest, 18 + idLength);
  const { key, alg } = coseToKey(cose);
  return {
    credentialId: b64(credentialId),
    publicKey: key.export({ type: 'spki', format: 'der' }).toString('base64'),
    alg,
    signCount: auth.signCount,
    transports: (input.response.transports ?? []).filter((t) => /^[a-z-]{2,20}$/.test(t)).slice(0, 6),
  };
}

export interface AssertionInput {
  id: string;
  rawId: string;
  type: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null };
}

export interface StoredPasskey {
  credentialId: string;
  publicKey: string;
  alg: number;
  signCount: number;
}

export function verifyAssertion(input: AssertionInput, expectedChallenge: string, rp: RelyingParty, stored: StoredPasskey): { signCount: number } {
  if (input.type !== 'public-key') throw new Error('not a public-key credential');
  if (input.rawId !== stored.credentialId) throw new Error('credential does not match');
  const clientData = checkClientData(input.response.clientDataJSON, 'webauthn.get', expectedChallenge, rp);
  const authBytes = fromB64(input.response.authenticatorData);
  const auth = parseAuthData(authBytes);
  checkAuthData(auth, rp);
  const key = createPublicKey({ key: Buffer.from(stored.publicKey, 'base64'), type: 'spki', format: 'der' });
  const signed = Buffer.concat([authBytes, sha256(clientData)]);
  const signature = fromB64(input.response.signature);
  const ok = stored.alg === -8 ? verify(null, signed, key, signature) : verify('sha256', signed, key, signature);
  if (!ok) throw new Error('signature is not valid');
  // Synced passkeys keep the counter at 0. Otherwise it must go up, or the key was cloned.
  if ((stored.signCount > 0 || auth.signCount > 0) && auth.signCount <= stored.signCount) throw new Error('signature counter did not increase');
  return { signCount: auth.signCount };
}

export function registrationOptions(rp: RelyingParty, challenge: string, userId: string, existing: string[]): Record<string, unknown> {
  return {
    challenge,
    rp: { id: rp.id, name: rp.name },
    user: { id: userId, name: 'owner', displayName: 'Dono' },
    pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    attestation: 'none',
    excludeCredentials: existing.map((id) => ({ type: 'public-key', id })),
    timeout: 120_000,
  };
}

export function authenticationOptions(rp: RelyingParty, challenge: string): Record<string, unknown> {
  return { challenge, rpId: rp.id, userVerification: 'required', timeout: 120_000 };
}
