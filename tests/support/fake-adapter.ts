import type { AdapterCapabilities, RefreshHandle, SourceAdapter } from '../../src/core/adapter.ts';
import type { Freshness, SourceAccount, SourceBill, SourceTransaction } from '../../src/core/types.ts';

export interface FakeData {
  accounts?: SourceAccount[];
  freshness?: Freshness[];
  transactions?: SourceTransaction[];
  bills?: SourceBill[];
}

export class FakeAdapter implements SourceAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;
  readonly refreshCalls: string[] = [];
  private readonly data: FakeData;

  constructor(id: string, data: FakeData = {}, capabilities: Partial<AdapterCapabilities> = {}) {
    this.id = id;
    this.data = data;
    this.capabilities = {
      refreshOnDemand: false,
      pendingTransactions: true,
      creditLimits: true,
      rawDescription: true,
      installments: true,
      ...capabilities,
    };
    if (this.capabilities.refreshOnDemand) {
      this.requestRefresh = async (): Promise<RefreshHandle> => {
        const requestedAt = new Date().toISOString();
        this.refreshCalls.push(requestedAt);
        return { requestedAt };
      };
    }
  }

  requestRefresh?: () => Promise<RefreshHandle>;

  async fetchAccounts() {
    return { accounts: this.data.accounts ?? [], freshness: this.data.freshness ?? [] };
  }

  async fetchTransactions(since: Date): Promise<SourceTransaction[]> {
    return (this.data.transactions ?? []).filter((t) => new Date(t.occurredAt) >= since);
  }

  async fetchBills(): Promise<SourceBill[]> {
    return this.data.bills ?? [];
  }
}
