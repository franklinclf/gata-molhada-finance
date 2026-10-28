import type { SourceAdapter } from '../core/adapter.ts';
import { runReconciliation } from '../reconcile/run.ts';
import type { Store } from '../store/store.ts';
import { syncSource } from '../sync/sync.ts';
import { canRequestRefresh } from './budget.ts';
import { quotaReport } from './quota.ts';
import { RefreshBlockedError, requestManualRefresh } from './refresh.ts';

export interface RefreshState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  result: 'completed' | 'timeout' | 'failed' | null;
  /** Institutions that did not report a new sync time in time. */
  timedOut: string[];
  error: string | null;
}

export type StartResult = { started: true } | { started: false; reasons: string[] };

/** Lets the web app ask for a refresh. It runs in the background and follows the same budget rules as the command line. */
export interface Refresher {
  state(): RefreshState;
  start(): StartResult;
}

const IDLE: RefreshState = { running: false, startedAt: null, finishedAt: null, result: null, timedOut: [], error: null };

export function createRefresher(deps: { store: Store; adapter: SourceAdapter; now?: () => Date; waitMs?: number; pollMs?: number }): Refresher {
  const { store, adapter } = deps;
  const now = deps.now ?? (() => new Date());
  let state: RefreshState = IDLE;

  async function job(): Promise<void> {
    try {
      const outcome = await requestManualRefresh({ store, adapter, now, waitMs: deps.waitMs, pollMs: deps.pollMs });
      const result = await syncSource(adapter, { store }, new Date(now().getTime() - 14 * 86_400_000));
      runReconciliation(store);
      const failed = result.errors.length > 0;
      state = { ...state, running: false, finishedAt: now().toISOString(), result: failed ? 'failed' : outcome.timedOut.length > 0 ? 'timeout' : 'completed', timedOut: outcome.timedOut, error: failed ? result.errors[0]! : null };
    } catch (error) {
      state = { ...state, running: false, finishedAt: now().toISOString(), result: 'failed', error: error instanceof RefreshBlockedError ? error.message : error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    state: () => state,
    start() {
      if (state.running) return { started: false, reasons: ['another refresh is still running'] };
      const decision = canRequestRefresh({ now: now(), lastRefresh: store.lastRefresh(adapter.id), budget: quotaReport(store, now()) });
      if (!decision.allowed) return { started: false, reasons: decision.reasons };
      state = { running: true, startedAt: now().toISOString(), finishedAt: null, result: null, timedOut: [], error: null };
      void job();
      return { started: true };
    },
  };
}
