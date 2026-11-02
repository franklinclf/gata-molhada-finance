import { DATA_START, startOfLocalDay } from '../core/time.ts';
import type { Store } from '../store/store.ts';
import { proveByBills } from './bill-proof.ts';
import { reconcileAccounts } from './accounts.ts';
import { reconcileTransactions, type TransactionReconciliation } from './transactions.ts';
import type { AccountReconciliation, SourceView } from './types.ts';

/**
 * Order of precedence between sources, earlier entries win. Today Meu Pluggy is the only source; 'pierre' stays in the
 * list so records saved from it (a backup restored, an old copy) still rank first if they ever come back.
 */
export const DEFAULT_SOURCE_PRIORITY: readonly string[] = ['pierre', 'pluggy'];

/** The listed sources that exist, in order, then any other registered source (a new adapter is never silently ignored). */
export function sourcePriority(store: Store, base: readonly string[] = DEFAULT_SOURCE_PRIORITY): string[] {
  const registered = store.listSourceIds();
  return [...base.filter((id) => registered.includes(id)), ...registered.filter((id) => !base.includes(id)).sort()];
}

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
  const result = reconcileAccounts(loadSourceViews(store, options.priority ?? sourcePriority(store)));
  store.replaceCanonicalAccounts(result.accounts, result.groups, now().toISOString());
  return result;
}

export interface FullReconciliation {
  accounts: AccountReconciliation;
  transactions: TransactionReconciliation;
}

export { DATA_START as DEFAULT_DATA_START, startOfLocalDay };

export const manualId = (id: number): string => `man_${id}`;

/** Rebuilds canonical accounts, then canonical transactions and findings, and saves all of them. */
export function runReconciliation(store: Store, options: RunOptions & { staleDays?: number; dataStart?: string } = {}): FullReconciliation {
  const now = options.now ?? (() => new Date());
  const dataStart = options.dataStart ?? DATA_START;
  store.deleteSourceTransactionsBefore(startOfLocalDay(dataStart));
  const accounts = runAccountReconciliation(store, options);
  const views = loadSourceViews(store, options.priority ?? sourcePriority(store));
  const transactions = reconcileTransactions({
    accounts: accounts.accounts,
    sources: views.map((v) => ({ sourceId: v.sourceId, priority: v.priority, transactions: v.transactions, freshness: v.freshness })),
    now: now(),
    staleDays: options.staleDays,
    dataStart,
    billsAfterStart: new Set(store.listSourceIds().flatMap((id) => store.listSourceBills(id)).filter((b) => b.dueDate >= dataStart).map((b) => b.externalId)),
    manual: store.listManualMapping(),
  });
  // What the owner typed in is added after the sources are matched. It has no source record, so no link.
  const known = new Set(accounts.accounts.map((a) => a.id));
  for (const m of store.listManualTransactions()) {
    if (!known.has(m.accountId)) continue;
    transactions.transactions.push({ id: manualId(m.id), accountId: m.accountId, occurredAt: `${m.day}T15:00:00.000Z`, amount: m.amount, description: m.description, descriptionRaw: null, status: 'posted', installment: null, category: m.category, state: 'confirmed', sourceIds: ['manual'], excluded: false });
  }
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
