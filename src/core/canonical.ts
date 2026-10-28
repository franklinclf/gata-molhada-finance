import type { Cents } from './money.ts';
import type { AccountKind, SourceId, TransactionStatus } from './types.ts';

export interface RecordRef {
  sourceId: SourceId;
  externalId: string;
}

/** Choices the user made in the app. They survive every rebuild. */
export interface ManualMapping {
  /** Two records, from different sources, that the user says are the same transaction. */
  pairs: Array<[RecordRef, RecordRef]>;
  /** Records the user wants left out of every total. */
  ignored: RecordRef[];
}

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

/**
 * confirmed: more than one source reports it. single_source: only one does, which is common and not a problem.
 * stale_pending: pending for longer than the banks keep things pending, so left out of totals.
 * billed: it was pending and seen by one source only, but a card bill (or a repeat of a bill-proven charge) shows it is real.
 * ignored: set aside by the user. conflict is no longer produced (a posted report always wins) and only exists in old data.
 */
export type TransactionState = 'confirmed' | 'single_source' | 'conflict' | 'stale_pending' | 'billed' | 'ignored';

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
  /** 0 = first record of the group; 1 = same instant; 2 = same day; 3 = installment; 4 = same amount within 36 hours; 9 = joined by the user. */
  matchPass: number;
}

/** The only open question left for the user: two records from different sources that may be the same transaction. */
export type FindingKind = 'possible_match';
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
