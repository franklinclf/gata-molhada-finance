import type { Cents } from './money.ts';
import type { AccountKind, SourceId } from './types.ts';

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
