import type { CanonicalAccount, CanonicalTransaction, Finding, LimitGroup, ManualMapping, TransactionLink } from '../core/canonical.ts';
import type { Rule } from '../api/rules-engine.ts';
import type { NonBusinessRule } from '../core/business-days.ts';

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

export interface ChatConversation {
  id: number;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: number;
  conversationId: number;
  role: 'user' | 'assistant';
  content: string;
  steps: Array<{ tool: string; args: Record<string, unknown>; summary: string }> | null;
  model: string | null;
  costUsd: number | null;
  createdAt: string;
}

export type ChangeStatus = 'applied' | 'undone' | 'pending' | 'declined' | 'expired' | 'conflict';

/** One change the analyst made to the owner's data, or proposed and left waiting for a tap. `before` and `after` are the values around the change, as JSON. */
export interface ChatChange {
  id: number;
  conversationId: number;
  /** The assistant answer that lists this change. Null until the answer is saved. */
  messageId: number | null;
  tool: string;
  /** What changes, in words for the owner. */
  label: string;
  count: number;
  /** The arguments as the code resolved them, to plan a pending change again. */
  args: unknown;
  before: unknown;
  after: unknown;
  status: ChangeStatus;
  destructive: boolean;
  undoable: boolean;
  createdAt: string;
  resolvedAt: string | null;
}

/** What the owner chose on one source record, read before a change so it can be put back exactly. */
export interface RecordChoice {
  category: string | null;
  ignored: boolean;
}

/** A reversal choice as it is stored: on source records, not on canonical ids. */
export interface ReversalRow {
  chargeSource: string;
  chargeExternal: string;
  refundSource: string;
  refundExternal: string;
  linked: boolean;
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

export interface TransactionOverride {
  status: 'pending' | 'posted' | null;
  /** Due month (YYYY-MM) of the card bill the transaction belongs to. */
  cycleKey: string | null;
}

/** What the owner changed on a card bill. A null field follows the issuer and the app. */
export interface BillEdit {
  total: number | null;
  closingDate: string | null;
  dueDate: string | null;
  status: 'paid' | 'unpaid' | null;
}

/** A regular income the owner typed in. It repeats every month from `fromMonth` to `untilMonth` (both optional, YYYY-MM). */
export interface IncomeItem {
  id: number;
  name: string;
  amount: number;
  dayOfMonth: number;
  /** Where the payment falls when `dayOfMonth` is a weekend or a bank holiday. */
  nonBusinessRule: NonBusinessRule;
  fromMonth: string | null;
  untilMonth: string | null;
}

/** A card account of the PDF source that the owner tied to a card account of another source. */
export interface BillImportAccount {
  pdfAccountExternalId: string;
  targetSourceId: SourceId;
  targetExternalId: string;
}

/** One statement file applied. `removedManual` are the typed-in transactions the owner dropped because the file brings them. */
export interface BillImport {
  id: number;
  fileHash: string;
  billId: string;
  issuer: string;
  dueDate: string;
  closingDate: string | null;
  total: number;
  cardFinals: string[];
  lineCount: number;
  method: 'text' | 'vision';
  removedManual: Array<Omit<ManualTransaction, 'id'>>;
  status: 'applied' | 'replaced' | 'undone';
  appliedAt: string;
  resolvedAt: string | null;
}

export interface PruneResult {
  removed: number;
  /** True when the removal was refused because it looked like a failed read. */
  skipped: boolean;
}

export interface AccountPruneResult {
  removed: number;
  /** Accounts left alone: `empty` came back with nothing in the window, `dropped` lost most of it at once. */
  skipped: Array<{ accountId: string; reason: 'empty' | 'dropped'; unseen: number }>;
}

export interface PurgeReport {
  sourceId: SourceId;
  applied: boolean;
  /** Rows removed (or that would be), by table. */
  removed: Record<string, number>;
  /** Choices moved to another source's record of the same transaction before the removal. */
  moved: { categoryOverrides: number; installmentOverrides: number };
}

export interface Store {
  schemaVersion(): number;
  registerSource(source: SourceRegistration, now: string): void;
  saveSnapshot(snapshot: NewSnapshot): number;
  latestSnapshot(sourceId: SourceId, endpoint: string): Snapshot | null;
  /** Every saved snapshot of a source whose endpoint starts with the prefix, oldest first. */
  listSnapshots(sourceId: SourceId, endpointPrefix: string): Snapshot[];
  /**
   * Deletes old raw responses of a source and returns how many rows went. Responses are grouped into reads (runs with no
   * pause longer than `gapMs`). Kept: the last `keepReads` complete reads, the last complete read of each month, and every
   * read after the oldest of those. Nothing is deleted when the source has no complete read.
   */
  pruneSnapshots(sourceId: SourceId, keepReads: number, gapMs: number): number;
  /** Runs VACUUM when at least `minFreeShare` of the file is free pages and the last run was more than `minGapMs` ago. Returns whether it ran. */
  reclaimSpace(now: string, minFreeShare?: number, minGapMs?: number): boolean;
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
  /** Every registered source, active or retired. */
  listSourceIds(): SourceId[];
  /**
   * Removes the saved records of a retired source: its transactions, accounts, bills, raw answers, sync times and the
   * choices that point at its records. A choice made on a transaction that another source also saw moves to that
   * source's record first. `apply: false` only counts. The canonical data is rebuilt by the next reconciliation.
   */
  purgeSource(sourceId: SourceId, apply: boolean): PurgeReport;
  listFreshness(): Freshness[];
  /** Inserts new records and refreshes existing ones; first_seen_at is kept, last_seen_at becomes seenAt. */
  upsertSourceAccounts(sourceId: SourceId, accounts: SourceAccount[], seenAt: string): void;
  /** Fills who paid, who received and the merchant code on a record that was saved before they were read. */
  setSourceTransactionParties(sourceId: SourceId, externalId: string, parties: Parties): void;
  /** Corrects the amount of a saved record. */
  setSourceTransactionAmount(sourceId: SourceId, externalId: string, amount: number): void;
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
  /** Categories the owner renamed or merged: old name to new name. */
  listCategoryAliases(): Map<string, string>;
  setCategoryAlias(from: string, to: string | null, now: string): void;
  /** Runs several store calls as one commit: if `work` throws, none of them is kept. Calls inside it join the same transaction. */
  transaction(work: () => void): void;
  /** Moves the budgets of a category to its new name (a budget the new name already has is kept). */
  renameBudgetCategory(from: string, to: string): void;
  listCategoryParents(): Map<string, string>;
  /** Sets the group of a category; null forgets the choice and goes back to the default. */
  setCategoryParent(category: string, parent: string | null, now: string): void;
  listChatConversations(): ChatConversation[];
  createChatConversation(title: string, now: string): number;
  deleteChatConversation(id: number): void;
  listChatMessages(conversationId: number): ChatMessage[];
  addChatMessage(m: Omit<ChatMessage, 'id'>): number;
  /** Saves a change of the analyst and returns its id. */
  addChatChange(change: Omit<ChatChange, 'id'>): number;
  /** The changes of a conversation, oldest first. */
  listChatChanges(conversationId: number): ChatChange[];
  getChatChange(id: number): ChatChange | null;
  /** Moves a change to a new status. `after` is replaced only when given. */
  updateChatChange(id: number, patch: { status: ChangeStatus; resolvedAt: string | null; after?: unknown; args?: unknown; label?: string; count?: number; before?: unknown }): void;
  /** Ties changes made while an answer was being built to the saved answer. */
  linkChatChanges(ids: number[], messageId: number): void;
  listGoals(): Goal[];
  saveGoal(goal: Omit<Goal, 'id'> & { id?: number }): Goal;
  deleteGoal(id: number): void;
  listRecurringIgnored(): Set<string>;
  /** The owner's word on a recurring key: a subscription or another recurring charge. */
  listRecurringMarks(): Map<string, 'subscription' | 'recurring'>;
  setRecurringMark(key: string, label: 'subscription' | 'recurring' | null, now: string): void;
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
  /**
   * Drops source transactions inside a window that the latest read did not return, account by account (`seenAt` is the
   * stamp that read gave to every record it returned). Pass only accounts that were read to the end. A record the provider
   * deleted, or re-created under a new id when it posted, would otherwise stay forever. An account that came back empty is
   * never touched, and one that lost most of its window is left alone unless `force` is set.
   */
  pruneUnseenSourceTransactions(sourceId: SourceId, accountIds: string[], from: string, to: string, seenAt: string, force?: boolean): AccountPruneResult;
  /** The oldest date among these source records, or null when none is saved. Tells how far back a read must go to see them again. */
  earliestSourceTransactionAt(sourceId: SourceId, externalIds: string[]): string | null;
  /**
   * Drops source accounts the latest complete read of the accounts did not return, with their transactions and bills (a
   * reconnected item gets new account ids and leaves the old ones behind). Refuses when it would remove most accounts.
   */
  pruneUnseenSourceAccounts(sourceId: SourceId, seenAt: string, force?: boolean): PruneResult;
  /** Removes one statement of a source: the transactions that carry its bill id and the bill itself. */
  deleteSourceBillRecords(sourceId: SourceId, billId: string): { transactions: number; bills: number };
  /** Removes the accounts of a source that have no transaction and no bill left. Returns how many went. */
  deleteEmptySourceAccounts(sourceId: SourceId): number;
  listBillImportAccounts(): BillImportAccount[];
  setBillImportAccount(pin: BillImportAccount, now: string): void;
  /** Statement files applied, newest first. */
  listBillImports(): BillImport[];
  addBillImport(row: Omit<BillImport, 'id' | 'status' | 'resolvedAt'>): number;
  setBillImportStatus(id: number, status: BillImport['status'], at: string): void;
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
  /** What the owner says about each transaction: its status (pending or posted) and the card bill (due month) it belongs to. */
  listTransactionOverrides(): Map<string, TransactionOverride>;
  /** The category choice and the set-aside flag of one source record. */
  recordChoice(sourceId: string, externalId: string): RecordChoice;
  /** Sets the given fields of one source record; a null category clears the choice. */
  setRecordChoice(sourceId: string, externalId: string, patch: Partial<RecordChoice>, now: string): void;
  /** Sets the given fields and leaves the others alone; `null` clears a field. */
  setTransactionOverride(transactionId: string, patch: Partial<TransactionOverride>, now: string): void;
  /** Edits the owner made to card bills, by `accountId|cycleKey`. */
  listIncome(): IncomeItem[];
  /** Adds an item (no id) or replaces one (with id). Returns the id. */
  saveIncome(item: Omit<IncomeItem, 'id'> & { id?: number }, now: string): number;
  deleteIncome(id: number): boolean;
  listBillEdits(): Map<string, BillEdit>;
  /** Saves the edit of one bill; `null` forgets all of it. */
  setBillEdit(accountId: string, cycleKey: string, edit: BillEdit | null, now: string): void;
  /** The owner's word on which credit returned which purchase (linked), or that a guessed pair is wrong (not linked). */
  listReversalLinks(): Array<{ chargeId: string; refundId: string; linked: boolean }>;
  /** The reversal choices that involve any of these source records, as stored. */
  listReversalRows(records: Array<{ sourceId: string; externalId: string }>): ReversalRow[];
  /** Writes (or with null removes) one stored reversal choice, whatever else is linked. */
  setReversalRow(row: Omit<ReversalRow, 'linked'>, linked: boolean | null, now: string): void;
  /** Links a purchase and its refund, marks the guess as wrong (false), or forgets the choice (null). False when a side has no source record (typed in by hand). */
  setReversalLink(chargeId: string, refundId: string, linked: boolean | null, now: string): boolean;
  /** Restores pending transactions that a card bill proved real: they count again. */
  markTransactionsBilled(ids: string[]): void;
  /** Counts every row the database changed since it was opened, so a view computed at one count is stale at another. */
  changeCount(): number;
  getSetting(key: string): string | null;
  setSetting(key: string, value: string, updatedAt: string): void;
  /** Writes a consistent copy of the whole database to a new file (VACUUM INTO). */
  copyTo(path: string): void;
  close(): void;
}
