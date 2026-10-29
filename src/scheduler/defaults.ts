import type { SourceAdapter } from '../core/adapter.ts';
import type { ObservedSource } from './observer.ts';

/** How often each source is checked. The Pluggy items are a cheap read. */
export const POLL_INTERVAL_MS: Record<string, number> = {
  pluggy: 2 * 60_000,
};

export const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;

export function observedSources(adapters: SourceAdapter[]): ObservedSource[] {
  return adapters
    .filter((adapter) => adapter.fetchFreshness !== undefined)
    .map((adapter) => ({ adapter, intervalMs: POLL_INTERVAL_MS[adapter.id] ?? DEFAULT_POLL_INTERVAL_MS }));
}
