import type { CanonicalAccount, CanonicalTransaction, Finding, LimitGroup, TransactionLink } from '../core/canonical.ts';
import type { Freshness, SourceAccount, SourceBill, SourceId, SourceTransaction } from '../core/types.ts';

export interface NewSnapshot {
  sourceId: SourceId;
  endpoint: string;
  fetchedAt: string;
  httpStatus: number;
  body: unknown;
}

export interface Snapshot extends NewSnapshot {
  id: number;
  sha256: string;
}

export interface SourceRegistration {
  id: SourceId;
  kind: string;
  capabilities: Record<string, boolean>;
}

export interface Seen {
  sourceId: SourceId;
  firstSeenAt: string;
  lastSeenAt: string;
}

export type StoredSourceAccount = SourceAccount & Seen;
export type StoredSourceTransaction = SourceTransaction & Seen;
export type StoredSourceBill = SourceBill & Seen;

export interface StoredFinding extends Finding {
  openedAt: string;
  lastSeenAt: string;
  /** Set when the problem stopped showing up in a later reconciliation. */
  resolvedAt: string | null;
}

export type RefreshStatus = 'requested' | 'completed' | 'timeout' | 'failed';

export interface RefreshLogEntry {
  id: number;
  sourceId: SourceId;
  requestedAt: string;
  finishedAt: string | null;
  status: RefreshStatus;
  detail: Record<string, unknown>;
}

export interface Store {
  schemaVersion(): number;
  registerSource(source: SourceRegistration, now: string): void;
  saveSnapshot(snapshot: NewSnapshot): number;
  latestSnapshot(sourceId: SourceId, endpoint: string): Snapshot | null;
  /**
   * Saves what a source reports for an institution. `changed` is true when the last-synced time differs from
   * the one saved before (or none was saved). Each distinct time is also counted as one bank read for the month.
   */
  upsertFreshness(freshness: Freshness): { changed: boolean; previous: string | null };
  /** Bank reads seen in a month (YYYY-MM), per institution key, summed over all sources. */
  quotaUsage(month: string): Array<{ institutionKey: string; events: number }>;
  startRefresh(sourceId: SourceId, requestedAt: string): number;
  finishRefresh(id: number, finishedAt: string, status: RefreshStatus, detail: Record<string, unknown>): void;
  lastRefresh(sourceId: SourceId): RefreshLogEntry | null;
  listFreshness(): Freshness[];
  /** Inserts new records and refreshes existing ones; first_seen_at is kept, last_seen_at becomes seenAt. */
  upsertSourceAccounts(sourceId: SourceId, accounts: SourceAccount[], seenAt: string): void;
  upsertSourceTransactions(sourceId: SourceId, transactions: SourceTransaction[], seenAt: string): void;
  upsertSourceBills(sourceId: SourceId, bills: SourceBill[], seenAt: string): void;
  listSourceAccounts(sourceId: SourceId): StoredSourceAccount[];
  listSourceTransactions(sourceId: SourceId): StoredSourceTransaction[];
  listSourceBills(sourceId: SourceId): StoredSourceBill[];
  /** Replaces all canonical accounts, limit groups and source references in one transaction. */
  replaceCanonicalAccounts(accounts: CanonicalAccount[], groups: LimitGroup[], builtAt: string): void;
  listCanonicalAccounts(): CanonicalAccount[];
  listLimitGroups(): LimitGroup[];
  /** Replaces all canonical transactions and their source links in one transaction. */
  replaceCanonicalTransactions(transactions: CanonicalTransaction[], links: TransactionLink[], builtAt: string): void;
  listCanonicalTransactions(options?: { accountId?: string; includeExcluded?: boolean }): CanonicalTransaction[];
  /** Upserts the current findings, keeps their opening time, and marks the ones no longer present as resolved. */
  syncFindings(findings: Finding[], now: string): void;
  listFindings(options?: { includeResolved?: boolean }): StoredFinding[];
  createSession(tokenHash: string, createdAt: string, expiresAt: string): void;
  /** True when the session exists and has not expired at `now`. */
  hasValidSession(tokenHash: string, now: string): boolean;
  deleteSession(tokenHash: string): void;
  purgeExpiredSessions(now: string): void;
  isRecoveryCodeUsed(codeHash: string): boolean;
  /** Marks a recovery code as used. Returns false when it was already used. */
  useRecoveryCode(codeHash: string, usedAt: string): boolean;
  getAuthState(key: string): string | null;
  setAuthState(key: string, value: string): void;
  getSetting(key: string): string | null;
  setSetting(key: string, value: string, updatedAt: string): void;
  close(): void;
}
