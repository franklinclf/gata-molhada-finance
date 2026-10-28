import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { encodeCbor } from '../../src/auth/cbor.ts';

const b64 = (d: Uint8Array | Buffer) => Buffer.from(d).toString('base64url');
const sha256 = (d: Uint8Array | Buffer) => createHash('sha256').update(d).digest();

export type Kind = 'ES256' | 'RS256' | 'EdDSA';

/** A software passkey, to test the server without a browser. It signs what a real authenticator would. */
export class SoftAuthenticator {
  readonly credentialId = randomBytes(32);
  readonly kind: Kind;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  counter = 0;
  flags = 0x05; // user present + user verified
  rpId: string;
  origin: string;

  constructor(rpId: string, origin: string, kind: Kind = 'ES256', rsaBits = 2048) {
    this.rpId = rpId;
    this.origin = origin;
    this.kind = kind;
    const pair = kind === 'ES256' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : kind === 'RS256' ? generateKeyPairSync('rsa', { modulusLength: rsaBits }) : generateKeyPairSync('ed25519');
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  private cose(): Buffer {
    const jwk = this.publicKey.export({ format: 'jwk' }) as { x?: string; y?: string; n?: string; e?: string };
    const bytes = (s: string | undefined) => Buffer.from(s ?? '', 'base64url');
    if (this.kind === 'ES256') return encodeCbor(new Map<number, number | Buffer>([[1, 2], [3, -7], [-1, 1], [-2, bytes(jwk.x)], [-3, bytes(jwk.y)]]) as never);
    if (this.kind === 'RS256') return encodeCbor(new Map<number, number | Buffer>([[1, 3], [3, -257], [-1, bytes(jwk.n)], [-2, bytes(jwk.e)]]) as never);
    return encodeCbor(new Map<number, number | Buffer>([[1, 1], [3, -8], [-1, 6], [-2, bytes(jwk.x)]]) as never);
  }

  private authData(withCredential: boolean, flags = this.flags): Buffer {
    const head = Buffer.alloc(37);
    sha256(Buffer.from(this.rpId)).copy(head, 0);
    head[32] = flags | (withCredential ? 0x40 : 0);
    head.writeUInt32BE(this.counter, 33);
    if (!withCredential) return head;
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    return Buffer.concat([head, Buffer.alloc(16), idLength, this.credentialId, this.cose()]);
  }

  private clientData(type: string, challenge: string, origin = this.origin): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  create(challenge: string, overrides: { origin?: string; flags?: number; challenge?: string } = {}) {
    const attestation = encodeCbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', this.authData(true, overrides.flags)]]) as never);
    return {
      id: b64(this.credentialId),
      rawId: b64(this.credentialId),
      type: 'public-key',
      response: { clientDataJSON: b64(this.clientData('webauthn.create', overrides.challenge ?? challenge, overrides.origin)), attestationObject: b64(attestation), transports: ['internal', 'hybrid'] },
    };
  }

  get(challenge: string, overrides: { origin?: string; flags?: number; challenge?: string; counter?: number } = {}) {
    if (overrides.counter !== undefined) this.counter = overrides.counter;
    else this.counter += 1;
    const authData = this.authData(false, overrides.flags);
    const clientData = this.clientData('webauthn.get', overrides.challenge ?? challenge, overrides.origin);
    const data = Buffer.concat([authData, sha256(clientData)]);
    const signature = this.kind === 'EdDSA' ? sign(null, data, this.privateKey) : sign('sha256', data, this.privateKey);
    return {
      id: b64(this.credentialId),
      rawId: b64(this.credentialId),
      type: 'public-key',
      response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(signature), userHandle: null },
    };
  }
}
