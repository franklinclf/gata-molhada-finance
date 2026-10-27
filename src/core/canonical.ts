import type { Cents } from './money.ts';
import type { AccountKind, SourceId, TransactionStatus } from './types.ts';

export type AccountRole = 'member' | 'duplicate';

export interface AccountRef {
  sourceId: SourceId;
  externalId: string;
  /** `member` is the source's chosen copy; `duplicate` is another copy of the same account in that source. */
  role: AccountRole;
}

export interface CanonicalAccount {
  id: string;
  institution: string;
  kind: AccountKind;
  name: string;
  last4: string | null;
  balance: Cents;
  balanceSourceId: SourceId | null;
  /** When the source last synced this institution, if the source reports it. */
  balanceAsOf: string | null;
  creditLimit: Cents | null;
  availableLimit: Cents | null;
  minimumPayment: Cents | null;
  dueDate: string | null;
  limitGroupId: string | null;
  refs: AccountRef[];
}

export interface LimitGroup {
  id: string;
  institution: string;
  creditLimit: Cents;
  memberIds: string[];
}

export type TransactionState = 'confirmed' | 'single_source' | 'conflict' | 'stale_pending';

export interface CanonicalTransaction {
  id: string;
  accountId: string;
  occurredAt: string;
  amount: Cents;
  description: string;
  descriptionRaw: string | null;
  status: TransactionStatus;
  installment: { number: number; total: number } | null;
  category: string | null;
  state: TransactionState;
  /** Sources that report this transaction. */
  sourceIds: SourceId[];
  /** True for stale pending entries, which are kept for review but left out of totals. */
  excluded: boolean;
}

export interface TransactionLink {
  sourceId: SourceId;
  externalId: string;
  transactionId: string;
  /** 0 = first record of the group; 1 = same instant; 2 = same day; 3 = installment; 4 = same amount within 36 hours. */
  matchPass: number;
}

export type FindingKind = 'missing_in_source' | 'not_yet_synced' | 'status_conflict' | 'stale_pending';
export type FindingSeverity = 'info' | 'warning';

export interface Finding {
  id: string;
  kind: FindingKind;
  severity: FindingSeverity;
  accountId: string;
  transactionId: string;
  summary: string;
  details: Record<string, unknown>;
}
