import type { SourceAdapter } from '../core/adapter.ts';
import { institutionKey } from '../core/names.ts';
import type { Store } from '../store/store.ts';
import { canRequestRefresh } from './budget.ts';
import { quotaReport } from './quota.ts';

export class RefreshBlockedError extends Error {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(`Refresh blocked: ${reasons.join('; ')}`);
    this.name = 'RefreshBlockedError';
    this.reasons = reasons;
  }
}

export interface RefreshDeps {
  store: Store;
  adapter: SourceAdapter;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Skip the spacing and budget checks. A refresh already running still blocks. */
  force?: boolean;
  /** How long to wait for every institution to report a new sync time. Defaults to 3 minutes. */
  waitMs?: number;
  /** Pause between two reads of the sync times. Defaults to 5 seconds. */
  pollMs?: number;
  onProgress?: (message: string) => void;
}

export interface InstitutionOutcome {
  institution: string;
  updated: boolean;
  seconds: number | null;
}

export interface RefreshOutcome {
  institutions: InstitutionOutcome[];
  /** Institutions that did not report a new sync time in time. Their old data stays in use. */
  timedOut: string[];
}

/**
 * Asks the source to sync every bank now and waits until each institution reports a newer sync time.
 * The request is sent once and never repeated, because every refresh uses bank read quota.
 */
export async function requestManualRefresh(deps: RefreshDeps): Promise<RefreshOutcome> {
  const { store, adapter } = deps;
  if (!adapter.capabilities.refreshOnDemand || !adapter.requestRefresh || !adapter.fetchFreshness) {
    throw new Error(`${adapter.id} cannot refresh on demand`);
  }
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitMs = deps.waitMs ?? 180_000;
  const pollMs = deps.pollMs ?? 5_000;
  const progress = deps.onProgress ?? (() => {});

  const decision = canRequestRefresh({ now: now(), lastRefresh: store.lastRefresh(adapter.id), budget: quotaReport(store, now()), force: deps.force });
  if (!decision.allowed) throw new RefreshBlockedError(decision.reasons);

  const before = await adapter.fetchFreshness();
  for (const f of before) store.upsertFreshness(f);
  const baseline = new Map(before.map((f) => [institutionKey(f.institution), { name: f.institution, at: f.lastUpdatedAt }]));

  const logId = store.startRefresh(adapter.id, now().toISOString());
  const startedAt = now().getTime();
  try {
    await adapter.requestRefresh();
  } catch (error) {
    store.finishRefresh(logId, now().toISOString(), 'failed', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  progress(`refresh requested for ${baseline.size} institutions`);

  const done = new Map<string, number>();
  while (done.size < baseline.size && now().getTime() - startedAt < waitMs) {
    await sleep(pollMs);
    let current;
    try {
      current = await adapter.fetchFreshness();
    } catch (error) {
      progress(`could not read the sync times, trying again (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    for (const f of current) {
      store.upsertFreshness(f);
      const key = institutionKey(f.institution);
      const base = baseline.get(key);
      if (base && f.lastUpdatedAt !== base.at && !done.has(key)) {
        const seconds = Math.round((now().getTime() - startedAt) / 1000);
        done.set(key, seconds);
        progress(`${f.institution} updated after ${seconds}s`);
      }
    }
  }

  const institutions: InstitutionOutcome[] = [...baseline].map(([key, base]) => ({
    institution: base.name,
    updated: done.has(key),
    seconds: done.get(key) ?? null,
  }));
  const timedOut = institutions.filter((i) => !i.updated).map((i) => i.institution);
  store.finishRefresh(logId, now().toISOString(), timedOut.length > 0 ? 'timeout' : 'completed', { institutions, timedOut });
  return { institutions, timedOut };
}
