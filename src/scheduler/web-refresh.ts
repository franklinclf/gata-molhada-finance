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
  /** refused: the source does not take refresh requests (Meu Pluggy updates by itself once a day). */
  result: 'completed' | 'timeout' | 'failed' | 'refused' | null;
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

const REFUSED_MEMORY_MS = 6 * 3_600_000;

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
      const refused = error instanceof Error && error.name === 'RefreshRefusedError';
      state = { ...state, running: false, finishedAt: now().toISOString(), result: refused ? 'refused' : 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    state: () => state,
    start() {
      // The source said no a moment ago: asking again would only repeat it.
      if (state.result === 'refused' && state.finishedAt !== null && now().getTime() - Date.parse(state.finishedAt) < REFUSED_MEMORY_MS) return { started: false, reasons: ['the source does not accept refresh requests'] };
      if (state.running) return { started: false, reasons: ['another refresh is still running'] };
      const decision = canRequestRefresh({ now: now(), lastRefresh: store.lastRefresh(adapter.id), budget: quotaReport(store, now()) });
      if (!decision.allowed) return { started: false, reasons: decision.reasons };
      state = { running: true, startedAt: now().toISOString(), finishedAt: null, result: null, timedOut: [], error: null };
      void job();
      return { started: true };
    },
  };
}
