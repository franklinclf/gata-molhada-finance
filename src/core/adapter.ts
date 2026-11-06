import type { Freshness, SourceAccount, SourceBill, SourceId, SourceTransaction } from './types.ts';

export interface AdapterCapabilities {
  refreshOnDemand: boolean;
  pendingTransactions: boolean;
  creditLimits: boolean;
  rawDescription: boolean;
  installments: boolean;
}

export interface RefreshHandle {
  requestedAt: string;
}

/** What a transaction read got, account by account, so one failing account does not hide the others. */
export interface TransactionRead {
  transactions: SourceTransaction[];
  /** Accounts whose read finished. Only these can have records pruned afterwards. */
  readAccountIds: string[];
  /** Accounts whose read failed. Their records are left as they were. */
  failed: Array<{ accountId: string; label: string; error: unknown }>;
}

export interface SourceAdapter {
  readonly id: SourceId;
  readonly capabilities: AdapterCapabilities;
  fetchAccounts(): Promise<{ accounts: SourceAccount[]; freshness: Freshness[] }>;
  /** A cheap read of when each institution was last synced, safe to poll often. Does not touch the banks. */
  fetchFreshness?(): Promise<Freshness[]>;
  fetchTransactions(since: Date): Promise<SourceTransaction[]>;
  /** Like fetchTransactions, but a failing account is reported in `failed` instead of ending the whole read. */
  fetchTransactionRead?(since: Date): Promise<TransactionRead>;
  fetchBills(): Promise<SourceBill[]>;
  /** Present only when capabilities.refreshOnDemand is true. */
  requestRefresh?(): Promise<RefreshHandle>;
  /** Returns and clears notes about records the adapter skipped, for the sync report. */
  drainWarnings?(): string[];
}
