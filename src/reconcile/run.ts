import type { Store } from '../store/store.ts';
import { reconcileAccounts } from './accounts.ts';
import type { AccountReconciliation, SourceView } from './types.ts';

/** Earlier entries win ties. Pierre is the primary source for recent data and Pluggy the cross-check. */
export const DEFAULT_SOURCE_PRIORITY: readonly string[] = ['pierre', 'pluggy'];

export interface RunOptions {
  priority?: readonly string[];
  now?: () => Date;
}

/** Sources that have never been synced are left out, so they do not make every account look incomplete. */
export function loadSourceViews(store: Store, priority: readonly string[]): SourceView[] {
  const freshness = store.listFreshness();
  const views: SourceView[] = [];
  priority.forEach((sourceId, index) => {
    const accounts = store.listSourceAccounts(sourceId);
    if (accounts.length === 0) return;
    views.push({
      sourceId,
      priority: index,
      accounts,
      transactions: store.listSourceTransactions(sourceId),
      freshness: freshness.filter((f) => f.sourceId === sourceId),
    });
  });
  return views;
}

/** Rebuilds the canonical accounts from the stored source records and saves them. */
export function runAccountReconciliation(store: Store, options: RunOptions = {}): AccountReconciliation {
  const now = options.now ?? (() => new Date());
  const result = reconcileAccounts(loadSourceViews(store, options.priority ?? DEFAULT_SOURCE_PRIORITY));
  store.replaceCanonicalAccounts(result.accounts, result.groups, now().toISOString());
  return result;
}
