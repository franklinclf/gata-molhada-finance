import type { SourceAdapter } from '../core/adapter.ts';
import type { ObservedSource } from './observer.ts';

/** How often each source is checked. The Pluggy items are a cheap read. */
export const POLL_INTERVAL_MS: Record<string, number> = {
  pluggy: 2 * 60_000,
};

/** With a webhook the provider says when something changed, so the check only guards against a lost delivery. */
export const WEBHOOK_POLL_INTERVAL_MS: Record<string, number> = {
  pluggy: 30 * 60_000,
};

export const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;

/**
 * Days of transactions re-read whenever a source reports new data. A card purchase can stay pending for the whole
 * statement and change on posting, so the window has to reach back past one statement, not two weeks.
 */
export const SYNC_LOOKBACK_DAYS = 45;

/** Setting that is '1' while a change a source reported has not been read yet. It survives a restart. */
export const pendingSyncKey = (sourceId: string): string => `observer_pending_sync:${sourceId}`;

export function observedSources(adapters: SourceAdapter[], withWebhook: ReadonlySet<string> = new Set()): ObservedSource[] {
  return adapters
    .filter((adapter) => adapter.fetchFreshness !== undefined)
    .map((adapter) => ({ adapter, intervalMs: (withWebhook.has(adapter.id) ? WEBHOOK_POLL_INTERVAL_MS : POLL_INTERVAL_MS)[adapter.id] ?? DEFAULT_POLL_INTERVAL_MS }));
}
