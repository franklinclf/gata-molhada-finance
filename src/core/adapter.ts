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

export interface SourceAdapter {
  readonly id: SourceId;
  readonly capabilities: AdapterCapabilities;
  fetchAccounts(): Promise<{ accounts: SourceAccount[]; freshness: Freshness[] }>;
  fetchTransactions(since: Date): Promise<SourceTransaction[]>;
  fetchBills(): Promise<SourceBill[]>;
  /** Present only when capabilities.refreshOnDemand is true. */
  requestRefresh?(): Promise<RefreshHandle>;
  /** Returns and clears notes about records the adapter skipped, for the sync report. */
  drainWarnings?(): string[];
}
