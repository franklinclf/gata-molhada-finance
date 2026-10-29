import type { CanonicalAccount, CanonicalTransaction, Finding, LimitGroup, ManualMapping, TransactionLink } from '../core/canonical.ts';
import type { Rule } from '../api/rules-engine.ts';

export interface ManualAsset {
  id: number;
  name: string;
  kind: 'asset' | 'liability';
  archived: boolean;
  /** Dated values, oldest first. */
  values: Array<{ day: string; value: number }>;
}

export interface ManualTransaction {
  id: number;
  accountId: string;
  /** Local day, YYYY-MM-DD. */
  day: string;
  /** Cents, with the sign of cash flow: money out (or a card purchase) is negative. */
  amount: number;
  description: string;
  category: string | null;
  notes: string | null;
}

export interface Goal {
  id: number;
  name: string;
  /** Cents. */
  target: number;
  targetDay: string | null;
  track: 'manual' | 'account' | 'asset' | 'networth';
  /** Account id or manual asset id, depending on `track`. */
  trackRef: string | null;
  /** The amount typed by hand, used when `track` is manual or when the linked item is gone. */
  saved: number;
  initial: number;
  createdDay: string;
  archived: boolean;
}

export type BudgetScope = 'category' | 'group';
export interface BudgetRow {
  scope: BudgetScope;
  name: string;
  month: string;
  amount: number;
  recurring: boolean;
}
import type { Parties } from '../core/parties.ts';
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

/** skipped: the model could not tell, so nothing is applied and nothing is asked of the user. */
export type AiStatus = 'applied' | 'suggested' | 'accepted' | 'rejected' | 'skipped';

export interface AiCategory {
  matchKey: string;
  sample: string;
  category: string;
  confidence: 'high' | 'medium' | 'low';
  status: AiStatus;
  model: string;
  taxonomy: string;
  decidedAt: string;
}

export type SessionStrength = 'password' | 'passkey' | 'device';

export interface SessionInfo {
  strength: SessionStrength;
  deviceId: string | null;
  createdAt: string;
}

export interface PasskeyRecord {
  credentialId: string;
  name: string;
  publicKey: string;
  alg: number;
  signCount: number;
  transports: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface DeviceRecord {
  id: string;
  tokenHash: string;
  name: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  absoluteExpiresAt: string;
}

export type MatchAction = 'joined' | 'dismissed' | 'suggested' | 'undone';

export interface AiMatch {
  findingId: string;
  verdict: 'yes' | 'no';
  confidence: 'high' | 'medium' | 'low';
  action: MatchAction;
  model: string;
  sampleA: string;
  sampleB: string;
  /** One record of the pair, to find the joined transaction again after ids are rebuilt. */
  sourceA: string;
  externalA: string;
  decidedAt: string;
}

export interface Store {
  schemaVersion(): number;
  registerSource(source: SourceRegistration, now: string): void;
  saveSnapshot(snapshot: NewSnapshot): number;
  latestSnapshot(sourceId: SourceId, endpoint: string): Snapshot | null;
  /** Every saved snapshot of a source whose endpoint starts with the prefix, oldest first. */
  listSnapshots(sourceId: SourceId, endpointPrefix: string): Snapshot[];
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
  /** Marks every source that is not in the list as retired: its saved records stay, but it no longer reports freshness. Returns the ones retired now. */
  retireSourcesExcept(activeIds: SourceId[]): SourceId[];
  listFreshness(): Freshness[];
  /** Inserts new records and refreshes existing ones; first_seen_at is kept, last_seen_at becomes seenAt. */
  upsertSourceAccounts(sourceId: SourceId, accounts: SourceAccount[], seenAt: string): void;
  /** Fills who paid, who received and the merchant code on a record that was saved before they were read. */
  setSourceTransactionParties(sourceId: SourceId, externalId: string, parties: Parties): void;
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
  createSession(tokenHash: string, createdAt: string, expiresAt: string, strength?: SessionStrength, deviceId?: string | null): void;
  getSession(tokenHash: string, now: string): SessionInfo | null;
  listPasskeys(): PasskeyRecord[];
  addPasskey(passkey: PasskeyRecord): void;
  updatePasskeyUse(credentialId: string, signCount: number, usedAt: string): void;
  deletePasskey(credentialId: string): boolean;
  addDevice(device: DeviceRecord): void;
  /** Finds a device by its current token, or by the token it had before the last rotation. */
  findDevice(tokenHash: string, now: string): (DeviceRecord & { via: 'current' | 'previous'; rotatedAt: string | null }) | null;
  replaceDeviceToken(id: string, tokenHash: string, usedAt: string, expiresAt: string): void;
  /** Ties a session to a trusted device, so forgetting the device ends the session too. */
  setSessionDevice(sessionTokenHash: string, deviceId: string): void;
  listDevices(now: string): DeviceRecord[];
  deleteDevice(id: string): boolean;
  /** Ends every session that came from a device (used when the device is forgotten). */
  deleteSessionsOfDevice(deviceId: string): void;
  /** True when the session exists and has not expired at `now`. */
  hasValidSession(tokenHash: string, now: string): boolean;
  deleteSession(tokenHash: string): void;
  purgeExpiredSessions(now: string): void;
  isRecoveryCodeUsed(codeHash: string): boolean;
  /** Marks a recovery code as used. Returns false when it was already used. */
  useRecoveryCode(codeHash: string, usedAt: string): boolean;
  getAuthState(key: string): string | null;
  setAuthState(key: string, value: string): void;
  /** Canonical account ids the user chose to hide. */
  listHiddenAccountIds(): Set<string>;
  setAccountHidden(accountId: string, hidden: boolean, now: string): void;
  /** Every link between a source record and a canonical transaction. */
  listAllTransactionLinks(): Array<{ sourceId: SourceId; externalId: string; transactionId: string }>;
  listTransactionLinks(transactionId: string): Array<{ sourceId: SourceId; externalId: string; matchPass: number }>;
  /** Manual category per canonical transaction id (taken from the newest override among its source records). */
  listCategoryOverrides(): Map<string, string>;
  /** Sets (or with null clears) the category on every source record of a canonical transaction. */
  setCategoryOverride(transactionId: string, category: string | null, now: string): void;
  listCategoryRules(): Map<string, string>;
  setCategoryRule(matchKey: string, category: string | null, now: string): void;
  /** The user's choices of group per category. An empty parent means no group. */
  listCategoryParents(): Map<string, string>;
  /** Sets the group of a category; null forgets the choice and goes back to the default. */
  setCategoryParent(category: string, parent: string | null, now: string): void;
  listGoals(): Goal[];
  saveGoal(goal: Omit<Goal, 'id'> & { id?: number }): Goal;
  deleteGoal(id: number): void;
  listRecurringIgnored(): Set<string>;
  setRecurringIgnored(key: string, ignored: boolean, now: string): void;
  listManualTransactions(): ManualTransaction[];
  /** Saves a manual transaction: without an id it is created. Returns the saved one. */
  saveManualTransaction(t: Omit<ManualTransaction, 'id'> & { id?: number }, now: string): ManualTransaction;
  deleteManualTransaction(id: number): void;
  listAssets(): ManualAsset[];
  /** Creates the asset (throws when the name is taken) and returns its id. */
  addAsset(name: string, kind: 'asset' | 'liability', now: string): number;
  renameAsset(id: number, name: string): void;
  setAssetArchived(id: number, archived: boolean): void;
  deleteAsset(id: number): void;
  /** Sets the value of an asset on a day; a null value removes that day. */
  setAssetValue(id: number, day: string, value: number | null): void;
  listBudgets(): BudgetRow[];
  /** Sets the budget of a target for a month; a null amount removes the row of that month. */
  setBudget(scope: BudgetScope, name: string, month: string, amount: number | null, recurring: boolean, now: string): void;
  listRules(): Rule[];
  /** Creates the rule (id 0) or updates the one with that id. Returns the saved rule. Throws when the name is taken. */
  saveRule(rule: Omit<Rule, 'id'> & { id?: number }, now: string): Rule;
  deleteRule(id: number): void;
  /** Gives the rules the priorities 10, 20, 30 ... in the order of the ids. Ids that are not listed keep their place after the listed ones. */
  reorderRules(ids: number[], now: string): void;
  listCustomCategories(): string[];
  addCustomCategory(name: string, now: string): void;
  /** Removes a custom category and every override and rule that points to it. */
  deleteCustomCategory(name: string): void;
  listManualMapping(): ManualMapping;
  /** Joins two canonical transactions of different sources: every record of one is tied to every record of the other. */
  addManualLink(transactionA: string, transactionB: string, now: string, madeBy?: 'user' | 'ai'): boolean;
  /** Who made the manual joins that involve this transaction: the user, the AI, or nobody. */
  manualLinkMadeBy(transactionId: string): 'user' | 'ai' | null;
  /** Canonical transaction that currently holds a source record. */
  transactionOfRecord(sourceId: string, externalId: string): string | null;
  listAiMatches(): Map<string, AiMatch>;
  saveAiMatch(match: AiMatch): void;
  /** Undoes the manual joins that involve any record of a canonical transaction. */
  removeManualLinks(transactionId: string): void;
  /** Sets aside (or brings back) every record of a canonical transaction. */
  setTransactionIgnored(transactionId: string, ignored: boolean, now: string): void;
  dismissFinding(findingId: string, now: string): void;
  listDismissedFindingIds(): Set<string>;
  /** Hard-deletes source transactions dated before the instant. Returns how many were removed. */
  deleteSourceTransactionsBefore(instant: string): number;
  /** Map of `${accountId}|${cycleKey}` to true (settled by hand) or false (kept as owed by hand). */
  listCycleOverrides(): Map<string, boolean>;
  /** Saves the user's word on a bill; null removes it. */
  setCycleOverride(accountId: string, cycleKey: string, settled: boolean | null, now: string): void;
  listAiCategories(): Map<string, AiCategory>;
  saveAiCategory(entry: AiCategory): void;
  setAiCategoryStatus(matchKey: string, status: AiStatus): void;
  /** Forgets what was decided about a description, so the model is asked again. */
  deleteAiCategory(matchKey: string): void;
  deleteAiCategoriesByStatus(statuses: AiStatus[]): number;
  recordAiUsage(entry: { kind: string; model: string; items: number; costUsd: number; at: string }): void;
  /** Money spent on model calls in a month (YYYY-MM). */
  aiSpent(month: string): number;
  /** Installment the user set by hand, per canonical transaction id. */
  listInstallmentOverrides(): Map<string, { number: number; total: number }>;
  /** Sets (or with null clears) the installment on every source record of a canonical transaction. */
  setInstallmentOverride(transactionId: string, installment: { number: number; total: number } | null, now: string): void;
  /** Restores pending transactions that a card bill proved real: they count again. */
  markTransactionsBilled(ids: string[]): void;
  getSetting(key: string): string | null;
  setSetting(key: string, value: string, updatedAt: string): void;
  /** Writes a consistent copy of the whole database to a new file (VACUUM INTO). */
  copyTo(path: string): void;
  close(): void;
}
