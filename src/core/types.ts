import type { Cents } from './money.ts';

export type SourceId = string;
export type AccountKind = 'checking' | 'savings' | 'credit_card';
export type TransactionStatus = 'pending' | 'posted';

export interface Freshness {
  sourceId: SourceId;
  /** Institution as the source names it, for example the bank or card issuer. */
  institution: string;
  /** When the source last synced this institution with the bank (ISO 8601 UTC). */
  lastUpdatedAt: string;
  /** When our observer saw that value (ISO 8601 UTC). */
  observedAt: string;
}

export interface SourceAccount {
  externalId: string;
  externalItemId: string;
  institution: string;
  kind: AccountKind;
  name: string;
  last4: string | null;
  balance: Cents;
  creditLimit: Cents | null;
  availableLimit: Cents | null;
  minimumPayment: Cents | null;
  dueDate: string | null;
}

export interface SourceTransaction {
  externalId: string;
  accountExternalId: string;
  /** Instant the source reports for the transaction (ISO 8601 UTC). */
  occurredAt: string;
  amount: Cents;
  description: string;
  descriptionRaw: string | null;
  status: TransactionStatus;
  installment: { number: number; total: number } | null;
  category: string | null;
}

export interface SourceBill {
  externalId: string;
  accountExternalId: string;
  dueDate: string;
  closingDate: string | null;
  total: Cents;
  minimumPayment: Cents | null;
}
