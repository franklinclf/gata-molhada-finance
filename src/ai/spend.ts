import { localMonth } from '../core/time.ts';
import type { Store } from '../store/store.ts';
import { costOfFailure, fetchKeyUsage } from './openrouter.ts';

const KEY_USAGE = 'ai_key_usage';

interface SavedKeyUsage {
  monthlyUsd: number;
  dailyUsd: number;
  fetchedAt: string;
}

export interface MonthSpend {
  /** What this app recorded from each response. */
  recorded: number;
  /** What OpenRouter says the key spent this month, when it was last asked. Includes tests and evaluations run with the same key. */
  keyTotal: number | null;
  keyFetchedAt: string | null;
  /** The larger of the two. This is what the budget is checked against. */
  spent: number;
}

/** Month spend for the budget. The key total is used only when it was read in the same month as `month`. */
export function monthSpend(store: Store, month: string): MonthSpend {
  const recorded = store.aiSpent(month);
  const raw = store.getSetting(KEY_USAGE);
  let saved: SavedKeyUsage | null = null;
  try {
    saved = raw ? (JSON.parse(raw) as SavedKeyUsage) : null;
  } catch {
    saved = null;
  }
  const fresh = saved !== null && localMonth(saved.fetchedAt) === month ? saved : null;
  return { recorded, keyTotal: fresh?.monthlyUsd ?? null, keyFetchedAt: fresh?.fetchedAt ?? null, spent: Math.max(recorded, fresh?.monthlyUsd ?? 0) };
}

/** Reads the key's spend from OpenRouter and keeps it for the budget and the screens. A failure keeps the last value. */
export async function refreshKeyUsage(store: Store, apiKey: string, now: Date, http?: typeof fetch): Promise<boolean> {
  try {
    const usage = await fetchKeyUsage(apiKey, http);
    store.setSetting(KEY_USAGE, JSON.stringify({ monthlyUsd: usage.monthlyUsd, dailyUsd: usage.dailyUsd, fetchedAt: now.toISOString() } satisfies SavedKeyUsage), now.toISOString());
    return true;
  } catch {
    return false;
  }
}

/** Records what a failed call cost, if it cost anything. */
export function recordFailedCost(store: Store, entry: { kind: string; model: string; items: number; at: string }, error: unknown): void {
  const costUsd = costOfFailure(error);
  if (costUsd > 0) store.recordAiUsage({ ...entry, costUsd });
}
