import type { Store } from '../store/store.ts';
import { proveByBills } from './bill-proof.ts';
import { reconcileAccounts } from './accounts.ts';
import { reconcileTransactions, type TransactionReconciliation } from './transactions.ts';
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

export interface FullReconciliation {
  accounts: AccountReconciliation;
  transactions: TransactionReconciliation;
}

/** Day the app starts caring about. Older source records are deleted, because they only add noise. */
export const DEFAULT_DATA_START = '2026-01-01';

/** UTC instant at which a Brazil-time day (UTC-3) starts. */
export function startOfLocalDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 3 * 3_600_000).toISOString();
}

/** Rebuilds canonical accounts, then canonical transactions and findings, and saves all of them. */
export function runReconciliation(store: Store, options: RunOptions & { staleDays?: number; dataStart?: string } = {}): FullReconciliation {
  const now = options.now ?? (() => new Date());
  const dataStart = options.dataStart ?? DEFAULT_DATA_START;
  store.deleteSourceTransactionsBefore(startOfLocalDay(dataStart));
  const accounts = runAccountReconciliation(store, options);
  const views = loadSourceViews(store, options.priority ?? DEFAULT_SOURCE_PRIORITY);
  const transactions = reconcileTransactions({
    accounts: accounts.accounts,
    sources: views.map((v) => ({ sourceId: v.sourceId, priority: v.priority, transactions: v.transactions, freshness: v.freshness })),
    now: now(),
    staleDays: options.staleDays,
    dataStart,
    manual: store.listManualMapping(),
  });
  const dismissed = store.listDismissedFindingIds();
  const stamp = now().toISOString();
  store.replaceCanonicalTransactions(transactions.transactions, transactions.links, stamp);
  store.syncFindings(transactions.findings.filter((f) => !dismissed.has(f.id)), stamp);
  // Card bills settle what the pending rule set aside: restore the charges they prove.
  const restored = proveByBills(store, now());
  if (restored.length > 0) {
    const byId = new Set(restored);
    for (const t of transactions.transactions) if (byId.has(t.id)) Object.assign(t, { state: 'billed', excluded: false });
    transactions.stats.byState.stale_pending -= restored.length;
    transactions.stats.byState.billed += restored.length;
  }
  return { accounts, transactions };
}
