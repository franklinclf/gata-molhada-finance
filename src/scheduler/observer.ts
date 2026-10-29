import type { SourceAdapter } from '../core/adapter.ts';
import type { SourceId } from '../core/types.ts';
import type { Store } from '../store/store.ts';
import { syncSource, type SyncResult } from '../sync/sync.ts';

export type ObserverEvent =
  | { type: 'checked'; sourceId: SourceId }
  | { type: 'changed'; sourceId: SourceId; institutions: string[] }
  | { type: 'synced'; sourceId: SourceId; result: SyncResult }
  | { type: 'error'; sourceId: SourceId; message: string; retryInMs: number };

export interface ObservedSource {
  adapter: SourceAdapter;
  intervalMs: number;
}

export interface ObserverDeps {
  store: Store;
  sources: ObservedSource[];
  /** Runs after a source was synced, to rebuild the canonical data. */
  reconcile: () => void;
  now?: () => Date;
  /** Resolves after `ms`, or earlier when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onEvent?: (event: ObserverEvent) => void;
  /** Days of transactions to re-read when a source reports new data. Defaults to 14. */
  lookbackDays?: number;
  /** Longest wait after repeated failures. Defaults to 30 minutes. */
  maxBackoffMs?: number;
}

interface SourceState {
  failures: number;
  nextDueAt: number;
  /** A change was seen but the sync that should follow it did not finish. */
  needsSync: boolean;
  /** The provider said transactions changed, so the next check reads them even if the sync time did not move. */
  forceSync: boolean;
  /** A wake arrived while a check was running, so another check is due right after it. */
  rewake: boolean;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Watches when each source last synced each bank. That check is cheap and does not touch the banks.
 * When a source reports newer data, the observer reads it and rebuilds the canonical data.
 */
export class Observer {
  private readonly deps: ObserverDeps;
  private readonly now: () => Date;
  private readonly states = new Map<SourceId, SourceState>();
  private wakeUp: (() => void) | null = null;

  constructor(deps: ObserverDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    for (const s of deps.sources) this.states.set(s.adapter.id, { failures: 0, nextDueAt: 0, needsSync: false, forceSync: false, rewake: false });
  }

  private emit(event: ObserverEvent): void {
    this.deps.onEvent?.(event);
  }

  /** One check of one source. Failures are reported as events and delay the next check. */
  async tick(source: ObservedSource): Promise<void> {
    const { adapter, intervalMs } = source;
    const state = this.states.get(adapter.id) as SourceState;
    if (!adapter.fetchFreshness) return;
    state.rewake = false;
    try {
      const freshness = await adapter.fetchFreshness();
      const changed = freshness.filter((f) => this.deps.store.upsertFreshness(f).changed);
      if (changed.length === 0 && !state.needsSync && !state.forceSync) {
        this.emit({ type: 'checked', sourceId: adapter.id });
      } else {
        if (changed.length > 0) this.emit({ type: 'changed', sourceId: adapter.id, institutions: changed.map((c) => c.institution) });
        state.needsSync = true;
        state.forceSync = false;
        const since = new Date(this.now().getTime() - (this.deps.lookbackDays ?? 14) * 86_400_000);
        const result = await syncSource(adapter, { store: this.deps.store, now: this.now }, since);
        this.deps.reconcile();
        this.emit({ type: 'synced', sourceId: adapter.id, result });
        state.needsSync = result.errors.length > 0;
      }
      state.failures = 0;
      state.nextDueAt = state.rewake ? 0 : this.now().getTime() + intervalMs;
    } catch (error) {
      state.failures++;
      const retryInMs = Math.min(intervalMs * 2 ** state.failures, this.deps.maxBackoffMs ?? 30 * 60_000);
      state.nextDueAt = this.now().getTime() + retryInMs;
      this.emit({ type: 'error', sourceId: adapter.id, message: error instanceof Error ? error.message : String(error), retryInMs });
    }
  }

  /** Makes a source due now, for example because its provider said something changed. `sync` also forces a read when no newer sync time shows. */
  wake(sourceId: SourceId, sync = false): void {
    const state = this.states.get(sourceId);
    if (!state) return;
    state.nextDueAt = 0;
    state.rewake = true;
    if (sync) state.forceSync = true;
    this.wakeUp?.();
  }

  /** Checks every source when it is due, until the signal aborts. */
  async run(signal: AbortSignal): Promise<void> {
    const sleep = this.deps.sleep ?? defaultSleep;
    while (!signal.aborted) {
      for (const source of this.deps.sources) {
        const state = this.states.get(source.adapter.id) as SourceState;
        if (!signal.aborted && state.nextDueAt <= this.now().getTime()) await this.tick(source);
      }
      const next = Math.min(...[...this.states.values()].map((s) => s.nextDueAt));
      // A wake during the pause ends it early. The pause itself is the injected sleep, so tests keep their clock.
      const pause = new AbortController();
      this.wakeUp = () => pause.abort();
      const stop = () => pause.abort();
      signal.addEventListener('abort', stop, { once: true });
      await sleep(Math.max(0, next - this.now().getTime()), pause.signal);
      signal.removeEventListener('abort', stop);
      this.wakeUp = null;
    }
  }
}
