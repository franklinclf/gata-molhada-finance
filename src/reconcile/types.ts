import type { CanonicalAccount, LimitGroup } from '../core/canonical.ts';
import type { Cents } from '../core/money.ts';
import type { Freshness, SourceAccount, SourceId, SourceTransaction } from '../core/types.ts';

/** One source as the reconciliation sees it. A lower `priority` number wins ties. */
export interface SourceView {
  sourceId: SourceId;
  priority: number;
  accounts: SourceAccount[];
  transactions: SourceTransaction[];
  freshness: Freshness[];
}

export interface AccountReconciliation {
  accounts: CanonicalAccount[];
  groups: LimitGroup[];
  notes: string[];
}

export interface AccountTotals {
  /** Checking and savings balances. */
  bankBalance: Cents;
  /** Amount owed on credit cards, counting a shared limit group once. */
  cardOwed: Cents;
  creditLimit: Cents;
  creditUsed: Cents;
  creditAvailable: Cents;
}
