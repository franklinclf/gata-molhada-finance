const toBytes = (text: string): ArrayBuffer => {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
};

const toText = (buffer: ArrayBuffer): string => {
  let raw = '';
  for (const byte of new Uint8Array(buffer)) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const passkeysSupported = (): boolean => typeof window !== 'undefined' && 'PublicKeyCredential' in window && !!navigator.credentials;

type Json = Record<string, unknown>;

/** Asks the browser to make a passkey (Touch ID, Windows Hello, the phone's lock screen, a password manager). */
export async function createPasskey(options: Json): Promise<Json> {
  const publicKey = {
    ...options,
    challenge: toBytes(options.challenge as string),
    user: { ...(options.user as Json), id: toBytes((options.user as Json).id as string) },
    excludeCredentials: ((options.excludeCredentials as Json[]) ?? []).map((c) => ({ ...c, id: toBytes(c.id as string) })),
  } as unknown as PublicKeyCredentialCreationOptions;
  const credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!credential) throw new Error('cancelled');
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: toText(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toText(response.clientDataJSON),
      attestationObject: toText(response.attestationObject),
      transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
    },
  };
}

/** Asks the browser to sign in with a passkey it holds for this site. */
export async function usePasskey(options: Json): Promise<Json> {
  const publicKey = { ...options, challenge: toBytes(options.challenge as string) } as unknown as PublicKeyCredentialRequestOptions;
  const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!credential) throw new Error('cancelled');
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: toText(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toText(response.clientDataJSON),
      authenticatorData: toText(response.authenticatorData),
      signature: toText(response.signature),
      userHandle: response.userHandle ? toText(response.userHandle) : null,
    },
  };
}

/** A readable name for this device, from the browser's own description. */
export function guessDeviceName(): string {
  const ua = navigator.userAgent;
  const system = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Aparelho';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${system} (${browser})` : system;
}
