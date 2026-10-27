import type { CanonicalAccount } from '../core/canonical.ts';

/** Every view says when it was built and how old the oldest data behind it is. */
export interface Stamped {
  generatedAt: string;
  /** Oldest "last synced" time among the accounts used, or null when no source reported one. */
  oldestDataAt: string | null;
}

export function stamp(accounts: CanonicalAccount[], now: Date): Stamped {
  const times = accounts.map((a) => a.balanceAsOf).filter((t): t is string => t !== null).sort();
  return { generatedAt: now.toISOString(), oldestDataAt: times[0] ?? null };
}
