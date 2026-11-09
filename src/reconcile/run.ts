import { PDF_SOURCE } from '../core/sources.ts';
import { DATA_START, startOfLocalDay } from '../core/time.ts';
import type { SourceAccount, SourceBill, SourceTransaction } from '../core/types.ts';
import type { Store } from '../store/store.ts';
import { proveByBills } from './bill-proof.ts';
import { reconcileAccounts, type AccountPin } from './accounts.ts';
import { reconcileTransactions, type TransactionReconciliation } from './transactions.ts';
import type { AccountReconciliation, SourceView } from './types.ts';

/**
 * Order of precedence between sources, earlier entries win. Meu Pluggy is the only aggregator today; 'pierre' stays in the
 * list so records saved from it (a backup restored, an old copy) still rank first if they ever come back. Statements the
 * owner uploads as PDF come last: on a charge both have, Pluggy's day, amount and text win, and the PDF adds what Pluggy lacks.
 */
export const DEFAULT_SOURCE_PRIORITY: readonly string[] = ['pierre', 'pluggy', PDF_SOURCE];

/** The listed sources that exist, in order, then any other registered source (a new adapter is never silently ignored). */
export function sourcePriority(store: Store, base: readonly string[] = DEFAULT_SOURCE_PRIORITY): string[] {
  return rank(store.listSourceIds(), base);
}

function rank(registered: readonly string[], base: readonly string[]): string[] {
  return [...base.filter((id) => registered.includes(id)), ...registered.filter((id) => !base.includes(id)).sort()];
}

export interface RunOptions {
  priority?: readonly string[];
  now?: () => Date;
}

/**
 * What one source would hold after a change that is not saved yet: a statement being previewed. Its saved records on
 * `dropBillId` are left out (the earlier copy of the same statement), and the given ones are added.
 */
export interface SourceOverride {
  sourceId: string;
  dropBillId: string | null;
  accounts: SourceAccount[];
  transactions: SourceTransaction[];
  bills: SourceBill[];
  /** Pins of this source's accounts, replacing the saved ones of the same accounts. */
  pins: AccountPin[];
}

/** Sources that have never been synced are left out, so they do not make every account look incomplete. */
export function loadSourceViews(store: Store, priority: readonly string[], override?: SourceOverride): SourceView[] {
  const freshness = store.listFreshness();
  const views: SourceView[] = [];
  priority.forEach((sourceId, index) => {
    let accounts: SourceAccount[] = store.listSourceAccounts(sourceId);
    let transactions: SourceTransaction[] = store.listSourceTransactions(sourceId);
    if (override?.sourceId === sourceId) {
      const replaced = new Set(override.accounts.map((a) => a.externalId));
      const added = new Set(override.transactions.map((t) => t.externalId));
      accounts = [...accounts.filter((a) => !replaced.has(a.externalId)), ...override.accounts];
      transactions = [...transactions.filter((t) => !added.has(t.externalId) && (override.dropBillId === null || t.parties?.billId !== override.dropBillId)), ...override.transactions];
    }
    if (accounts.length === 0) return;
    views.push({
      sourceId,
      priority: index,
      accounts,
      transactions,
      freshness: freshness.filter((f) => f.sourceId === sourceId),
    });
  });
  return views;
}

/** The owner's ties between a PDF card and a card of another source. */
function pinsOf(store: Store, override?: SourceOverride): AccountPin[] {
  const saved: AccountPin[] = store.listBillImportAccounts().map((p) => ({ sourceId: PDF_SOURCE, externalId: p.pdfAccountExternalId, targetSourceId: p.targetSourceId, targetExternalId: p.targetExternalId }));
  if (!override) return saved;
  const replaced = new Set(override.pins.map((p) => `${p.sourceId}|${p.externalId}`));
  return [...saved.filter((p) => !replaced.has(`${p.sourceId}|${p.externalId}`)), ...override.pins];
}

/** Registered sources, with the override's source added when it is not registered yet (the first statement). */
function registeredWith(store: Store, override?: SourceOverride): string[] {
  const ids = store.listSourceIds();
  return override && !ids.includes(override.sourceId) ? [...ids, override.sourceId] : ids;
}

/** Every source's bills, as they would be after the override. */
function allBills(store: Store, override?: SourceOverride): Array<SourceBill & { sourceId: string }> {
  return registeredWith(store, override).flatMap((sourceId) => {
    const saved = store.listSourceBills(sourceId);
    if (override?.sourceId !== sourceId) return saved;
    const added = new Set(override.bills.map((b) => b.externalId));
    return [...saved.filter((b) => !added.has(b.externalId) && b.externalId !== override.dropBillId), ...override.bills.map((b) => ({ ...b, sourceId }))];
  });
}

/** Rebuilds the canonical accounts from the stored source records and saves them. */
export function runAccountReconciliation(store: Store, options: RunOptions = {}): AccountReconciliation {
  const now = options.now ?? (() => new Date());
  const result = reconcileAccounts(loadSourceViews(store, options.priority ?? sourcePriority(store)), pinsOf(store));
  store.replaceCanonicalAccounts(result.accounts, result.groups, now().toISOString());
  return result;
}

export interface FullReconciliation {
  accounts: AccountReconciliation;
  transactions: TransactionReconciliation;
}

export { DATA_START as DEFAULT_DATA_START, startOfLocalDay };

export const manualId = (id: number): string => `man_${id}`;

type FullOptions = RunOptions & { staleDays?: number; dataStart?: string };

/**
 * Canonical accounts, transactions and findings computed from the stored records, without saving anything. With an
 * override, from what one source would hold after an unsaved change, so a statement preview shows exactly what applying
 * it does. Transactions typed in by hand are not included.
 */
export function planReconciliation(store: Store, options: FullOptions = {}, override?: SourceOverride): FullReconciliation {
  const now = options.now ?? (() => new Date());
  // Records older than the start stay in the store (nothing is lost); only the window below leaves them out of the canonical data.
  const dataStart = options.dataStart ?? DATA_START;
  const views = loadSourceViews(store, options.priority ?? rank(registeredWith(store, override), DEFAULT_SOURCE_PRIORITY), override);
  const accounts = reconcileAccounts(views, pinsOf(store, override));
  const bills = allBills(store, override);
  const transactions = reconcileTransactions({
    accounts: accounts.accounts,
    sources: views.map((v) => ({ sourceId: v.sourceId, priority: v.priority, transactions: v.transactions, freshness: v.freshness })),
    now: now(),
    staleDays: options.staleDays,
    dataStart,
    billsAfterStart: new Set(bills.filter((b) => b.dueDate >= dataStart).map((b) => b.externalId)),
    billMonths: new Map(bills.map((b) => [`${b.sourceId}|${b.externalId}`, b.dueDate.slice(0, 7)])),
    manual: store.listManualMapping(),
  });
  return { accounts, transactions };
}

/** Rebuilds canonical accounts, then canonical transactions and findings, and saves all of them. */
export function runReconciliation(store: Store, options: FullOptions = {}): FullReconciliation {
  const now = options.now ?? (() => new Date());
  const { accounts, transactions } = planReconciliation(store, options);
  store.replaceCanonicalAccounts(accounts.accounts, accounts.groups, now().toISOString());
  // What the owner typed in is added after the sources are matched. It has no source record, so no link.
  const known = new Set(accounts.accounts.map((a) => a.id));
  for (const m of store.listManualTransactions()) {
    if (!known.has(m.accountId)) continue;
    transactions.transactions.push({ id: manualId(m.id), accountId: m.accountId, occurredAt: `${m.day}T15:00:00.000Z`, amount: m.amount, description: m.description, descriptionRaw: null, status: 'posted', installment: null, category: m.category, state: 'confirmed', sourceIds: ['manual'], excluded: false });
  }
  const dismissed = store.listDismissedFindingIds();
  const stamp = now().toISOString();
  store.replaceCanonicalTransactions(transactions.transactions, transactions.links, stamp);
  store.syncFindings(transactions.findings.filter((f) => !dismissed.has(f.id)), stamp);
  // Card bills settle what the pending rule set aside: restore the charges they prove.
  const restored = proveByBills(store, now());
  if (restored.length > 0) {
    const byId = new Set(restored);
    for (const t of transactions.transactions) if (byId.has(t.id)) Object.assign(t, { state: 'billed', excluded: false });
    transactions.stats.byState.stale_pending -= restored.length;
    transactions.stats.byState.billed += restored.length;
  }
  return { accounts, transactions };
}
