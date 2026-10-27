import { createHash, randomBytes } from 'node:crypto';
import type { Store } from '../store/store.ts';
import { hashRecoveryCode } from './recovery.ts';
import { verifyPassword } from './password.ts';
import { verifyTotp } from './totp.ts';

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

export type LoginResult =
  | { ok: true; token: string; expiresAt: string }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'locked'; retryAfterSeconds: number }
  | { ok: false; reason: 'not_configured' };

export interface AuthOptions {
  sessionHours: number;
  maxFailures: number;
  lockMinutes: number;
}

const DEFAULTS: AuthOptions = { sessionHours: 12, maxFailures: 5, lockMinutes: 15 };
const LAST_TOTP_KEY = 'last_totp_counter';

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

  constructor(store: Store, config: AuthConfig | null, now: () => Date, options: Partial<AuthOptions> = {}) {
    this.store = store;
    this.config = config;
    this.now = now;
    this.options = { ...DEFAULTS, ...options };
  }

  get configured(): boolean {
    return this.config !== null;
  }

  login(password: string, code: string): LoginResult {
    if (!this.config) return { ok: false, reason: 'not_configured' };
    const nowMs = this.now().getTime();
    const windowMs = this.options.lockMinutes * 60_000;
    this.failures = this.failures.filter((t) => nowMs - t < windowMs);
    if (this.failures.length >= this.options.maxFailures) {
      const oldest = this.failures[0]!;
      return { ok: false, reason: 'locked', retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000)) };
    }

    // Both factors are always checked, so the response time does not say which one was wrong.
    const passwordOk = verifyPassword(password, this.config.passwordHash);
    const second = this.checkSecondFactor(code.trim(), nowMs);
    if (!passwordOk || !second.ok) {
      this.failures.push(nowMs);
      return { ok: false, reason: 'invalid' };
    }
    second.consume();
    this.failures = [];

    const nowIso = this.now().toISOString();
    this.store.purgeExpiredSessions(nowIso);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(nowMs + this.options.sessionHours * 3_600_000).toISOString();
    this.store.createSession(hashToken(token), nowIso, expiresAt);
    return { ok: true, token, expiresAt };
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
    if (!token) return false;
    return this.store.hasValidSession(hashToken(token), this.now().toISOString());
  }

  logout(token: string | null): void {
    if (token) this.store.deleteSession(hashToken(token));
  }
}
