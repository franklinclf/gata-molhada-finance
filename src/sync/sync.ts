import type { SourceAdapter, TransactionRead } from '../core/adapter.ts';
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
export interface SyncOptions {
  /** Remove what the source no longer returns without the guard against a bad read. Used by a hard reset, only after a complete read. */
  fullWindow?: boolean;
}

export function syncSource(adapter: SourceAdapter, deps: SyncDeps, since: Date, options: SyncOptions = {}): Promise<SyncResult> {
  // The observer, the refresh button and the command line share one adapter and one database. Two syncs of the same
  // source at once could write an older answer over a newer one, so they run one after the other.
  const previous = running.get(adapter.id) ?? Promise.resolve();
  const next = previous.then(() => runSync(adapter, deps, since, options), () => runSync(adapter, deps, since, options));
  running.set(adapter.id, next.catch(() => undefined));
  return next;
}

const running = new Map<string, Promise<unknown>>();

async function runSync(adapter: SourceAdapter, deps: SyncDeps, since: Date, options: SyncOptions): Promise<SyncResult> {
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
    // An account the provider no longer lists (a reconnected item gets new ids) goes away with its records, so it cannot double a balance.
    if (accounts.length > 0) {
      const pruned = store.pruneUnseenSourceAccounts(adapter.id, seenAt, options.fullWindow === true);
      if (pruned.skipped) result.warnings.push('accounts: several saved accounts were not listed this time, so none were removed');
    }
  } catch (error) {
    result.errors.push(`accounts: ${describe(error)}`);
  }

  try {
    const read = await readTransactions(adapter, store, since);
    const seenAt = now().toISOString();
    store.upsertSourceTransactions(adapter.id, read.transactions, seenAt);
    result.transactions = read.transactions.length;
    // An account that failed keeps what it had, and the note says which one it was, so the owner knows why its numbers are old.
    for (const failure of read.failed) result.warnings.push(`${failure.label}: não foi possível ler as transações (${describe(failure.error)}), então esta conta ficou como estava`);
    if (read.failed.length > 0 && read.readAccountIds.length === 0) result.errors.push(`transactions: ${describe(read.failed[0]!.error)}`);
    // The read covers every date from `since` to today, so a record in that range that did not come back is gone at the
    // source (deleted, or re-created under a new id when it posted). The first day stays out as a margin for the time zone.
    // Only accounts read to the end are checked, and an account that came back empty or lost most of its records is kept.
    if (!result.errors.some((e) => e.startsWith('accounts:')) && read.readAccountIds.length > 0) {
      const pruned = store.pruneUnseenSourceTransactions(adapter.id, read.readAccountIds, new Date(since.getTime() + 86_400_000).toISOString(), seenAt, seenAt, options.fullWindow === true);
      if (pruned.skipped.length > 0) {
        const names = new Map(store.listSourceAccounts(adapter.id).map((a) => [a.externalId, `${a.institution} / ${a.name}`]));
        for (const skip of pruned.skipped) {
          const label = names.get(skip.accountId) ?? skip.accountId;
          result.warnings.push(
            skip.reason === 'empty'
              ? `${label}: nenhuma transação voltou na leitura, então os ${skip.unseen} registros salvos foram mantidos`
              : `${label}: a maior parte dos registros recentes não voltou na leitura, então nenhum dos ${skip.unseen} foi removido`,
          );
        }
      }
    }
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

  result.warnings.push(...(adapter.drainWarnings?.() ?? []));
  trimStorage(store, adapter.id, now(), result);
  return result;
}

/** Reads per account when the adapter can; otherwise the one list it returns counts for every account it knows. */
async function readTransactions(adapter: SourceAdapter, store: Store, since: Date): Promise<TransactionRead> {
  if (adapter.fetchTransactionRead) return adapter.fetchTransactionRead(since);
  const transactions = await adapter.fetchTransactions(since);
  return { transactions, readAccountIds: store.listSourceAccounts(adapter.id).map((a) => a.externalId), failed: [] };
}

/** Raw responses kept: the last few complete reads and one per month. A pause this long separates one read from the next. */
const KEEP_RAW_READS = 3;
const READ_GAP_MS = 15 * 60_000;

/** Old raw responses are the bulk of the file, and the records already hold what was derived from them. Never fails the sync. */
function trimStorage(store: Store, sourceId: SourceId, at: Date, result: SyncResult): void {
  try {
    store.pruneSnapshots(sourceId, KEEP_RAW_READS, READ_GAP_MS);
    store.reclaimSpace(at.toISOString());
  } catch (error) {
    result.warnings.push(`limpeza de respostas antigas falhou: ${describe(error)}`);
  }
}
