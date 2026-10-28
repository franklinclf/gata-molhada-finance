import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SessionStrength, Store } from '../store/store.ts';
import { hashRecoveryCode } from './recovery.ts';
import { verifyPassword } from './password.ts';
import { verifyTotp } from './totp.ts';
import {
  authenticationOptions,
  newChallenge,
  registrationOptions,
  verifyAssertion,
  verifyRegistration,
  type AssertionInput,
  type RegistrationInput,
  type RelyingParty,
} from './webauthn.ts';

export interface AuthConfig {
  passwordHash: string;
  totpSecret: string;
  /** SHA-256 hex of each recovery code. */
  recoveryHashes: string[];
}

/** Returns null when login is not set up, which keeps the whole API closed. */
export function loadAuthConfig(env: Record<string, string | undefined>): AuthConfig | null {
  const passwordHash = (env.AUTH_PASSWORD_HASH ?? '').trim();
  const totpSecret = (env.AUTH_TOTP_SECRET ?? '').trim();
  if (!passwordHash || !totpSecret) return null;
  const recoveryHashes = (env.AUTH_RECOVERY_HASHES ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  return { passwordHash, totpSecret, recoveryHashes };
}

export interface Issued {
  token: string;
  expiresAt: string;
  /** Set when this device was marked as trusted: the long-lived cookie to send. */
  device?: { token: string; maxAgeSeconds: number };
}

export type LoginResult =
  | ({ ok: true } & Issued)
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'locked'; retryAfterSeconds: number }
  | { ok: false; reason: 'not_configured' };

export interface AuthOptions {
  sessionHours: number;
  maxFailures: number;
  lockMinutes: number;
  /** A trusted device stays trusted this long after its last use... */
  deviceDays: number;
  /** ...but never longer than this from the day it was trusted. */
  deviceMaxDays: number;
  /** Passkey ceremonies must finish within this time. */
  challengeMinutes: number;
  /** Adding or removing ways to sign in needs a sign-in this recent. */
  freshMinutes: number;
  /** How long the device token from before a rotation still works. */
  graceSeconds: number;
}

const DEFAULTS: AuthOptions = { sessionHours: 12, maxFailures: 5, lockMinutes: 15, deviceDays: 30, deviceMaxDays: 90, challengeMinutes: 5, freshMinutes: 15, graceSeconds: 60 };
const LAST_TOTP_KEY = 'last_totp_counter';
const MAX_CHALLENGES = 100;
const MAX_PASSKEY_FAILURES = 30;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class AuthService {
  private readonly store: Store;
  private readonly config: AuthConfig | null;
  private readonly now: () => Date;
  private readonly options: AuthOptions;
  /** Failure times (ms). One account, so one shared counter; behind the proxy a per-address limit would not work. */
  private failures: number[] = [];
  /** Wrong passkey signatures cannot be guessed, so they do not lock the password login; they only slow a flood. */
  private passkeyFailures: number[] = [];

  private readonly rp: RelyingParty | null;
  /** Challenges handed out and not used yet. In memory on purpose: a restart only means asking the browser again. */
  private readonly challenges = new Map<string, { purpose: 'register' | 'login'; expires: number }>();

  constructor(store: Store, config: AuthConfig | null, now: () => Date, options: Partial<AuthOptions> = {}, rp: RelyingParty | null = null) {
    this.store = store;
    this.config = config;
    this.now = now;
    this.options = { ...DEFAULTS, ...options };
    this.rp = rp;
  }

  get passkeysAvailable(): boolean {
    return this.rp !== null && this.config !== null;
  }

  get configured(): boolean {
    return this.config !== null;
  }

  private lockedFor(): number | null {
    const nowMs = this.now().getTime();
    const windowMs = this.options.lockMinutes * 60_000;
    this.failures = this.failures.filter((t) => nowMs - t < windowMs);
    if (this.failures.length < this.options.maxFailures) return null;
    return Math.max(1, Math.ceil((this.failures[0]! + windowMs - nowMs) / 1000));
  }

  private fail(): void {
    this.failures.push(this.now().getTime());
  }

  private startSession(strength: SessionStrength, deviceId: string | null = null): { token: string; expiresAt: string } {
    const nowIso = this.now().toISOString();
    this.store.purgeExpiredSessions(nowIso);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + this.options.sessionHours * 3_600_000).toISOString();
    this.store.createSession(hashToken(token), nowIso, expiresAt, strength, deviceId);
    return { token, expiresAt };
  }

  /** Marks the device as trusted and returns the cookie value to keep it signed in. */
  private issueDevice(name: string): NonNullable<Issued['device']> & { id: string } {
    const nowMs = this.now().getTime();
    const token = randomBytes(32).toString('base64url');
    const idle = this.options.deviceDays * 86_400_000;
    const id = randomUUID();
    this.store.addDevice({
      id,
      tokenHash: hashToken(token),
      name: cleanName(name, 'Aparelho'),
      createdAt: new Date(nowMs).toISOString(),
      lastUsedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + idle).toISOString(),
      absoluteExpiresAt: new Date(nowMs + this.options.deviceMaxDays * 86_400_000).toISOString(),
    });
    return { token, maxAgeSeconds: Math.floor(idle / 1000), id };
  }

  login(password: string, code: string, trust?: { name: string } | null): LoginResult {
    if (!this.config) return { ok: false, reason: 'not_configured' };
    const locked = this.lockedFor();
    if (locked !== null) return { ok: false, reason: 'locked', retryAfterSeconds: locked };

    // Both factors are always checked, so the response time does not say which one was wrong.
    const passwordOk = verifyPassword(password, this.config.passwordHash);
    const second = this.checkSecondFactor(code.trim(), this.now().getTime());
    if (!passwordOk || !second.ok) {
      this.fail();
      return { ok: false, reason: 'invalid' };
    }
    second.consume();
    this.failures = [];
    const device = trust ? this.issueDevice(trust.name) : null;
    const session = this.startSession('password', device?.id ?? null);
    return { ok: true, ...session, ...(device ? { device: { token: device.token, maxAgeSeconds: device.maxAgeSeconds } } : {}) };
  }

  private checkSecondFactor(code: string, nowMs: number): { ok: true; consume: () => void } | { ok: false } {
    const config = this.config!;
    if (/^\d{6}$/.test(code)) {
      const counter = verifyTotp(config.totpSecret, code, nowMs);
      const last = Number(this.store.getAuthState(LAST_TOTP_KEY) ?? '-1');
      if (counter === null || counter <= last) return { ok: false };
      return { ok: true, consume: () => this.store.setAuthState(LAST_TOTP_KEY, String(counter)) };
    }
    const hash = hashRecoveryCode(code);
    if (!config.recoveryHashes.includes(hash) || this.store.isRecoveryCodeUsed(hash)) return { ok: false };
    return { ok: true, consume: () => void this.store.useRecoveryCode(hash, this.now().toISOString()) };
  }

  verifySession(token: string | null): boolean {
    return this.sessionInfo(token) !== null;
  }

  sessionInfo(token: string | null) {
    if (!token) return null;
    return this.store.getSession(hashToken(token), this.now().toISOString());
  }

  /**
   * Changing how you can sign in (passkeys, trusted devices) needs a session that started with a password or a passkey,
   * not one restored from a trusted device, and started recently. Someone holding a copied session cookie then cannot
   * turn a few hours of access into permanent access.
   */
  isFullSession(token: string | null): boolean {
    const info = this.sessionInfo(token);
    if (info === null || info.strength === 'device') return false;
    return this.now().getTime() - Date.parse(info.createdAt) <= this.options.freshMinutes * 60_000;
  }

  logout(token: string | null, deviceToken?: string | null): void {
    if (token) this.store.deleteSession(hashToken(token));
    // Signing out also forgets this device, or the next page load would sign straight back in.
    if (deviceToken) {
      const device = this.store.findDevice(hashToken(deviceToken), this.now().toISOString());
      if (device) {
        this.store.deleteSessionsOfDevice(device.id);
        this.store.deleteDevice(device.id);
      }
    }
  }

  // ---------- trusted devices ----------

  /** Trust the device of a session that started with a password or passkey. */
  trustDevice(token: string | null, name: string): NonNullable<Issued['device']> | null {
    if (!token || !this.isFullSession(token)) return null;
    const device = this.issueDevice(name);
    this.store.setSessionDevice(hashToken(token), device.id);
    return { token: device.token, maxAgeSeconds: device.maxAgeSeconds };
  }

  /**
   * A valid device cookie becomes a new session, and the cookie is replaced by a new one. The previous cookie keeps
   * working for a minute (requests sent in parallel carry it). After that, seeing it again means it was copied, so the
   * device is revoked.
   */
  restoreFromDevice(deviceToken: string | null): Issued | null {
    if (!deviceToken || !this.config) return null;
    const nowMs = this.now().getTime();
    const found = this.store.findDevice(hashToken(deviceToken), new Date(nowMs).toISOString());
    if (!found) return null;
    if (found.via === 'previous') {
      const rotatedAt = found.rotatedAt ? Date.parse(found.rotatedAt) : 0;
      if (nowMs - rotatedAt > this.options.graceSeconds * 1000) {
        this.store.deleteSessionsOfDevice(found.id);
        this.store.deleteDevice(found.id);
        return null;
      }
      return this.startSession('device', found.id);
    }
    const next = randomBytes(32).toString('base64url');
    const idle = this.options.deviceDays * 86_400_000;
    const expires = Math.min(nowMs + idle, Date.parse(found.absoluteExpiresAt));
    this.store.replaceDeviceToken(found.id, hashToken(next), new Date(nowMs).toISOString(), new Date(expires).toISOString());
    const session = this.startSession('device', found.id);
    return { ...session, device: { token: next, maxAgeSeconds: Math.max(1, Math.floor((expires - nowMs) / 1000)) } };
  }

  listDevices(currentDeviceId: string | null) {
    return this.store.listDevices(this.now().toISOString()).map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt, expiresAt: d.expiresAt, current: d.id === currentDeviceId }));
  }

  forgetDevice(token: string | null, id: string): boolean {
    if (!this.isFullSession(token)) return false;
    this.store.deleteSessionsOfDevice(id);
    return this.store.deleteDevice(id);
  }

  // ---------- passkeys ----------

  private userHandle(): string {
    let id = this.store.getAuthState('webauthn_user_id');
    if (!id) {
      id = randomBytes(32).toString('base64url');
      this.store.setAuthState('webauthn_user_id', id);
    }
    return id;
  }

  private remember(purpose: 'register' | 'login'): string {
    const nowMs = this.now().getTime();
    for (const [c, v] of this.challenges) if (v.expires < nowMs) this.challenges.delete(c);
    // Anyone can ask for a login challenge, so the pile is capped; the oldest go first.
    while (this.challenges.size >= MAX_CHALLENGES) this.challenges.delete(this.challenges.keys().next().value as string);
    const challenge = newChallenge();
    this.challenges.set(challenge, { purpose, expires: nowMs + this.options.challengeMinutes * 60_000 });
    return challenge;
  }

  /** A challenge works once, for the purpose it was made for, within a few minutes. */
  private take(clientDataJSON: string, purpose: 'register' | 'login'): string | null {
    let challenge: unknown;
    try {
      challenge = (JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as { challenge?: unknown }).challenge;
    } catch {
      return null;
    }
    if (typeof challenge !== 'string') return null;
    const entry = this.challenges.get(challenge);
    this.challenges.delete(challenge);
    return entry && entry.purpose === purpose && entry.expires >= this.now().getTime() ? challenge : null;
  }

  private passkeyLockedFor(): number | null {
    const nowMs = this.now().getTime();
    const windowMs = this.options.lockMinutes * 60_000;
    this.passkeyFailures = this.passkeyFailures.filter((t) => nowMs - t < windowMs);
    if (this.passkeyFailures.length < MAX_PASSKEY_FAILURES) return null;
    return Math.max(1, Math.ceil((this.passkeyFailures[0]! + windowMs - nowMs) / 1000));
  }

  passkeyLoginOptions(): { options: Record<string, unknown> } | { locked: number } | null {
    if (!this.rp || !this.config) return null;
    const locked = this.passkeyLockedFor();
    if (locked !== null) return { locked };
    return { options: authenticationOptions(this.rp, this.remember('login')) };
  }

  passkeyLogin(credential: AssertionInput, trust?: { name: string } | null): LoginResult {
    if (!this.rp || !this.config) return { ok: false, reason: 'not_configured' };
    const locked = this.passkeyLockedFor();
    if (locked !== null) return { ok: false, reason: 'locked', retryAfterSeconds: locked };
    try {
      const challenge = this.take(credential.response.clientDataJSON, 'login');
      const stored = this.store.listPasskeys().find((p) => p.credentialId === credential.rawId);
      if (!challenge || !stored) throw new Error('unknown challenge or passkey');
      const { signCount } = verifyAssertion(credential, challenge, this.rp, stored);
      this.store.updatePasskeyUse(stored.credentialId, signCount, this.now().toISOString());
    } catch {
      this.passkeyFailures.push(this.now().getTime());
      return { ok: false, reason: 'invalid' };
    }
    this.passkeyFailures = [];
    const device = trust ? this.issueDevice(trust.name) : null;
    const session = this.startSession('passkey', device?.id ?? null);
    return { ok: true, ...session, ...(device ? { device: { token: device.token, maxAgeSeconds: device.maxAgeSeconds } } : {}) };
  }

  listPasskeys() {
    return this.store.listPasskeys().map((p) => ({ id: p.credentialId, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt, transports: p.transports }));
  }

  passkeyRegisterOptions(token: string | null): Record<string, unknown> | null {
    if (!this.rp || !this.isFullSession(token)) return null;
    return registrationOptions(this.rp, this.remember('register'), this.userHandle(), this.store.listPasskeys().map((p) => p.credentialId));
  }

  passkeyRegister(token: string | null, credential: RegistrationInput, name: string): { ok: true } | { ok: false; error: string } {
    if (!this.rp) return { ok: false, error: 'passkeys_not_configured' };
    if (!this.isFullSession(token)) return { ok: false, error: 'reauth_required' };
    try {
      const challenge = this.take(credential.response.clientDataJSON, 'register');
      if (!challenge) return { ok: false, error: 'challenge_expired' };
      const registration = verifyRegistration(credential, challenge, this.rp);
      if (this.store.listPasskeys().some((p) => p.credentialId === registration.credentialId)) return { ok: false, error: 'already_registered' };
      this.store.addPasskey({
        credentialId: registration.credentialId,
        name: cleanName(name, 'Passkey'),
        publicKey: registration.publicKey,
        alg: registration.alg,
        signCount: registration.signCount,
        transports: registration.transports,
        createdAt: this.now().toISOString(),
        lastUsedAt: null,
      });
      return { ok: true };
    } catch {
      return { ok: false, error: 'invalid_passkey' };
    }
  }

  removePasskey(token: string | null, id: string): boolean {
    return this.isFullSession(token) && this.store.deletePasskey(id);
  }
}

function cleanName(value: string, fallback: string): string {
  const name = value.trim().replace(/\s+/g, ' ').slice(0, 40);
  return name === '' ? fallback : name;
}
