import { createHash, timingSafeEqual } from 'node:crypto';

/** True when `given` is the secret. Both sides are hashed first so the comparison takes the same time whatever the length. */
export function tokenMatches(given: string, secret: string): boolean {
  if (secret === '') return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

export interface PluggyEvent {
  event: string;
  itemId: string;
  /** Present on item/error. */
  errorCode: string | null;
  errorMessage: string | null;
}

/** Reads the fields this app uses from a Pluggy webhook body. Null when it is not an item event. */
export function parsePluggyEvent(payload: unknown): PluggyEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.event !== 'string' || typeof p.itemId !== 'string' || p.itemId === '') return null;
  const error = typeof p.error === 'object' && p.error !== null ? (p.error as Record<string, unknown>) : null;
  return {
    event: p.event,
    itemId: p.itemId,
    errorCode: typeof error?.code === 'string' ? error.code : null,
    errorMessage: typeof error?.message === 'string' ? error.message : null,
  };
}

export type EventEffect = {
  /** Read the source now. `sync` forces a read even when the item reports no newer sync time. */
  wake: false | 'check' | 'sync';
  /** The connection needs the owner, or is fine again. */
  alert: 'raise' | 'clear' | null;
};

/** What each event means for the app. Events not listed here are acknowledged and ignored. */
export function effectOf(event: string): EventEffect {
  switch (event) {
    case 'item/created':
    case 'item/updated':
    case 'item/login_succeeded':
      return { wake: 'check', alert: 'clear' };
    case 'transactions/created':
    case 'transactions/updated':
    case 'transactions/deleted':
      return { wake: 'sync', alert: null };
    case 'item/error':
    case 'item/waiting_user_input':
    case 'item/waiting_user_action':
      return { wake: false, alert: 'raise' };
    default:
      return { wake: false, alert: null };
  }
}

export interface PluggyHook {
  secret: string;
  /** Called after the response is decided. Must be quick and must not throw. */
  onEvent: (event: PluggyEvent) => void;
}

/** A connection that needs the owner. Kept until a later event shows it works again. */
export interface ConnectionAlert {
  institution: string;
  event: string;
  code: string | null;
  message: string | null;
  at: string;
}

const ALERTS_KEY = 'pluggy_connection_alerts';

type AlertStore = { getSetting(key: string): string | null; setSetting(key: string, value: string, updatedAt: string): void };

export function readAlerts(store: AlertStore): Record<string, ConnectionAlert> {
  const raw = store.getSetting(ALERTS_KEY);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, ConnectionAlert>) : {};
  } catch {
    return {};
  }
}

export function recordAlert(store: AlertStore, itemId: string, alert: ConnectionAlert | null, now: Date): void {
  const alerts = readAlerts(store);
  if (alert === null) {
    if (!(itemId in alerts)) return;
    delete alerts[itemId];
  } else {
    alerts[itemId] = alert;
  }
  store.setSetting(ALERTS_KEY, JSON.stringify(alerts), now.toISOString());
}
