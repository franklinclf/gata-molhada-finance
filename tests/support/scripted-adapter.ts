import type { AdapterCapabilities, RefreshHandle, SourceAdapter } from '../../src/core/adapter.ts';
import type { Freshness, SourceAccount, SourceBill, SourceTransaction } from '../../src/core/types.ts';

export interface Script {
  /** Answers of consecutive fetchFreshness calls; the last one repeats. An Error is thrown instead of returned. */
  reads?: Array<Freshness[] | Error>;
  refreshOnDemand?: boolean;
  refreshError?: Error;
  accounts?: SourceAccount[];
  transactions?: SourceTransaction[];
  bills?: SourceBill[];
  /** Makes fetchTransactions fail this many times before it works. */
  failTransactions?: number;
}

/** Adapter whose answers are scripted, to test code that polls and syncs. */
export class ScriptedAdapter implements SourceAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;
  refreshCalls = 0;
  freshnessCalls = 0;
  transactionCalls: Date[] = [];
  requestRefresh?: () => Promise<RefreshHandle>;
  private readonly script: Script;

  constructor(id: string, script: Script = {}) {
    this.id = id;
    this.script = script;
    this.capabilities = {
      refreshOnDemand: script.refreshOnDemand ?? false,
      pendingTransactions: true,
      creditLimits: true,
      rawDescription: true,
      installments: true,
    };
    if (script.refreshOnDemand) {
      this.requestRefresh = async () => {
        this.refreshCalls++;
        if (script.refreshError) throw script.refreshError;
        return { requestedAt: new Date().toISOString() };
      };
    }
  }

  async fetchFreshness(): Promise<Freshness[]> {
    const reads = this.script.reads ?? [[]];
    const next = reads[Math.min(this.freshnessCalls++, reads.length - 1)] as Freshness[] | Error;
    if (next instanceof Error) throw next;
    return next;
  }

  async fetchAccounts() {
    return { accounts: this.script.accounts ?? [], freshness: [] };
  }

  async fetchTransactions(since: Date): Promise<SourceTransaction[]> {
    this.transactionCalls.push(since);
    if ((this.script.failTransactions ?? 0) >= this.transactionCalls.length) throw new Error('transactions are down');
    return this.script.transactions ?? [];
  }

  async fetchBills(): Promise<SourceBill[]> {
    return this.script.bills ?? [];
  }
}

export const syncTime = (sourceId: string, institution: string, lastUpdatedAt: string, extra: Partial<Freshness> = {}): Freshness => ({
  sourceId,
  institution,
  lastUpdatedAt,
  observedAt: lastUpdatedAt,
  ...extra,
});
