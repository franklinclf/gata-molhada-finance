import type { SourceAdapter } from '../core/adapter.ts';
import { SourceHttpError, type SnapshotSink } from '../core/http.ts';
import type { SourceId } from '../core/types.ts';
import type { Store } from '../store/store.ts';

export interface SyncDeps {
  store: Store;
  now?: () => Date;
}

export interface SyncResult {
  sourceId: SourceId;
  accounts: number;
  transactions: number;
  bills: number;
  freshness: number;
  warnings: string[];
  errors: string[];
}

/** Registers the source so snapshots and records can reference it. Safe to call repeatedly. */
export function registerAdapter(adapter: SourceAdapter, store: Store, now: Date): void {
  store.registerSource(
    { id: adapter.id, kind: 'aggregator', capabilities: { ...adapter.capabilities } },
    now.toISOString(),
  );
}

/** Builds the sink an adapter uses to store every raw response it receives. */
export function createSnapshotSink(store: Store, sourceId: SourceId, now: () => Date = () => new Date()): SnapshotSink {
  return (snapshot) => {
    store.saveSnapshot({
      sourceId,
      endpoint: snapshot.endpoint,
      fetchedAt: now().toISOString(),
      httpStatus: snapshot.httpStatus,
      body: snapshot.body,
    });
  };
}

function describe(error: unknown): string {
  if (error instanceof SourceHttpError) {
    const path = error.url.split('?')[0] ?? error.url;
    return `HTTP ${error.status} from ${path}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Pulls accounts, transactions and bills from one source and stores them.
 * A failing step is reported and does not stop the steps after it.
 */
export async function syncSource(adapter: SourceAdapter, deps: SyncDeps, since: Date): Promise<SyncResult> {
  const now = deps.now ?? (() => new Date());
  const { store } = deps;
  registerAdapter(adapter, store, now());

  const result: SyncResult = {
    sourceId: adapter.id,
    accounts: 0,
    transactions: 0,
    bills: 0,
    freshness: 0,
    warnings: [],
    errors: [],
  };

  try {
    const { accounts, freshness } = await adapter.fetchAccounts();
    const seenAt = now().toISOString();
    store.upsertSourceAccounts(adapter.id, accounts, seenAt);
    for (const entry of freshness) store.upsertFreshness(entry);
    result.accounts = accounts.length;
    result.freshness = freshness.length;
  } catch (error) {
    result.errors.push(`accounts: ${describe(error)}`);
  }

  try {
    const transactions = await adapter.fetchTransactions(since);
    store.upsertSourceTransactions(adapter.id, transactions, now().toISOString());
    result.transactions = transactions.length;
  } catch (error) {
    result.errors.push(`transactions: ${describe(error)}`);
  }

  try {
    const bills = await adapter.fetchBills();
    store.upsertSourceBills(adapter.id, bills, now().toISOString());
    result.bills = bills.length;
  } catch (error) {
    result.errors.push(`bills: ${describe(error)}`);
  }

  result.warnings = adapter.drainWarnings?.() ?? [];
  return result;
}
