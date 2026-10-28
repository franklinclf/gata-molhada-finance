import { CATEGORY_NAMES } from '../ai/taxonomy.ts';
import { runReconciliation } from '../reconcile/run.ts';
import type { Store } from '../store/store.ts';
import { categoryParents } from './category-groups.ts';
import { effectiveTransactions, ruleKey } from './scope.ts';

export type MutationResult = { ok: true } | { ok: false; status: number; error: string };

const MAX_NAME = 60;

export function cleanCategoryName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  // "Sem categoria" is how the screens name transactions without a category.
  return name.length >= 1 && name.length <= MAX_NAME && name.toLowerCase() !== 'sem categoria' ? name : null;
}

/** Sets or clears the category of one transaction. `applyToSimilar` also saves a rule for its description. */
export function setTransactionCategory(store: Store, transactionId: string, category: unknown, applyToSimilar: boolean, now: Date): MutationResult {
  const transaction = effectiveTransactions(store, { includeHidden: true, includeExcluded: true }).find((t) => t.id === transactionId);
  if (!transaction) return { ok: false, status: 404, error: 'not_found' };
  const at = now.toISOString();
  if (category === null) {
    store.setCategoryOverride(transactionId, null, at);
    if (applyToSimilar) store.setCategoryRule(ruleKey(transaction.description), null, at);
    return { ok: true };
  }
  const name = cleanCategoryName(category);
  if (name === null) return { ok: false, status: 400, error: `category must be text of 1 to ${MAX_NAME} characters` };
  const known = new Set([...effectiveTransactions(store, { includeHidden: true, includeExcluded: true }).map((t) => t.category), ...store.listCustomCategories()]);
  if (!known.has(name)) store.addCustomCategory(name, at);
  store.setCategoryOverride(transactionId, name, at);
  if (applyToSimilar) store.setCategoryRule(ruleKey(transaction.description), name, at);
  return { ok: true };
}

export interface CategoryRow {
  name: string;
  count: number;
  custom: boolean;
  /** Part of the standard list the AI and the screens share. */
  builtin: boolean;
  /** Spending in the category (money out minus money in), over all time. */
  amount: number;
  /** The group it sits in, or null when it stands alone. */
  parent: string | null;
}

export function listCategories(store: Store): CategoryRow[] {
  const custom = new Set(store.listCustomCategories());
  const rows = new Map<string, CategoryRow>();
  const parents = categoryParents(store);
  for (const t of effectiveTransactions(store, { includeHidden: true })) {
    if (t.category === null) continue;
    const row = rows.get(t.category) ?? { name: t.category, count: 0, custom: custom.has(t.category), builtin: CATEGORY_NAMES.includes(t.category), amount: 0, parent: parents.get(t.category) ?? null };
    row.count += 1;
    row.amount += -t.amount;
    rows.set(t.category, row);
  }
  for (const name of custom) if (!rows.has(name)) rows.set(name, { name, count: 0, custom: true, builtin: false, amount: 0, parent: parents.get(name) ?? null });
  for (const name of CATEGORY_NAMES) if (!rows.has(name)) rows.set(name, { name, count: 0, custom: false, builtin: true, amount: 0, parent: parents.get(name) ?? null });
  return [...rows.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function addCategory(store: Store, name: unknown, now: Date): MutationResult {
  const clean = cleanCategoryName(name);
  if (clean === null) return { ok: false, status: 400, error: `name must be text of 1 to ${MAX_NAME} characters` };
  store.addCustomCategory(clean, now.toISOString());
  return { ok: true };
}

/** Puts a category in a group, or takes it out (`parent` null). Groups are one level deep: a group cannot sit in another group. */
export function setCategoryParent(store: Store, category: string, parent: unknown, now: Date): MutationResult {
  if (!listCategories(store).some((c) => c.name === category)) return { ok: false, status: 404, error: 'not_found' };
  if (parent === null) {
    // Built-in categories need an explicit "no group", or the default would come back.
    store.setCategoryParent(category, '', now.toISOString());
    return { ok: true };
  }
  const name = cleanCategoryName(parent);
  if (name === null) return { ok: false, status: 400, error: `parent must be text of 1 to ${MAX_NAME} characters or null` };
  if (name === category) return { ok: false, status: 400, error: 'a category cannot sit inside itself' };
  const parents = categoryParents(store);
  if (parents.has(name)) return { ok: false, status: 400, error: 'a group cannot sit inside another group' };
  if ([...parents.values()].includes(category)) return { ok: false, status: 400, error: 'this name is a group that holds other categories' };
  store.setCategoryParent(category, name, now.toISOString());
  return { ok: true };
}

export function removeCategory(store: Store, name: string): MutationResult {
  if (!store.listCustomCategories().includes(name)) return { ok: false, status: 404, error: 'only categories you created can be deleted' };
  store.deleteCustomCategory(name);
  return { ok: true };
}

export function setAccountHidden(store: Store, accountId: string, hidden: unknown, now: Date): MutationResult {
  if (typeof hidden !== 'boolean') return { ok: false, status: 400, error: 'hidden must be true or false' };
  if (!store.listCanonicalAccounts().some((a) => a.id === accountId)) return { ok: false, status: 404, error: 'not_found' };
  store.setAccountHidden(accountId, hidden, now.toISOString());
  return { ok: true };
}

// ---------- mapping between sources ----------

const rebuild = (store: Store, now: Date) => void runReconciliation(store, { now: () => now });

const knownTransaction = (store: Store, id: string) => store.listCanonicalTransactions({ includeExcluded: true }).find((t) => t.id === id);

/** Says that two canonical transactions from different sources are the same one. */
export function joinTransactions(store: Store, id: unknown, otherId: unknown, now: Date): MutationResult {
  if (typeof id !== 'string' || typeof otherId !== 'string' || id === otherId) return { ok: false, status: 400, error: 'otherId must be another transaction' };
  const a = knownTransaction(store, id);
  const b = knownTransaction(store, otherId);
  if (!a || !b) return { ok: false, status: 404, error: 'not_found' };
  if (a.accountId !== b.accountId) return { ok: false, status: 400, error: 'both transactions must be on the same account' };
  if (!store.addManualLink(id, otherId, now.toISOString())) return { ok: false, status: 400, error: 'they come from the same source, so they cannot be the same transaction' };
  rebuild(store, now);
  return { ok: true };
}

export function separateTransaction(store: Store, id: string, now: Date): MutationResult {
  if (!knownTransaction(store, id)) return { ok: false, status: 404, error: 'not_found' };
  // A join the AI made and the user undoes is remembered, so the AI does not make it again.
  if (store.manualLinkMadeBy(id) === 'ai') {
    for (const m of store.listAiMatches().values()) {
      if (m.action === 'joined' && store.transactionOfRecord(m.sourceA, m.externalA) === id) store.saveAiMatch({ ...m, action: 'undone', decidedAt: now.toISOString() });
    }
  }
  store.removeManualLinks(id);
  rebuild(store, now);
  return { ok: true };
}

/** Leaves a transaction out of every total (or brings it back). */
export function setIgnored(store: Store, id: string, ignored: unknown, now: Date): MutationResult {
  if (typeof ignored !== 'boolean') return { ok: false, status: 400, error: 'ignored must be true or false' };
  if (!knownTransaction(store, id)) return { ok: false, status: 404, error: 'not_found' };
  store.setTransactionIgnored(id, ignored, now.toISOString());
  rebuild(store, now);
  return { ok: true };
}

/** "This is not the same transaction": the suggestion does not come back. */
export function dismissSuggestion(store: Store, findingId: string, now: Date): MutationResult {
  if (!store.listFindings().some((f) => f.id === findingId)) return { ok: false, status: 404, error: 'not_found' };
  store.dismissFinding(findingId, now.toISOString());
  rebuild(store, now);
  return { ok: true };
}

export interface Candidate {
  id: string;
  occurredAt: string;
  amount: number;
  description: string;
  status: string;
  category: string | null;
  sourceIds: string[];
  /** Days apart from the transaction being mapped. */
  daysApart: number;
}

/** Transactions on the same account that only other sources report, closest first: what this one could be joined with. */
export function joinCandidates(store: Store, id: string): Candidate[] | null {
  const all = effectiveTransactions(store, { includeHidden: true, includeExcluded: true });
  const target = all.find((t) => t.id === id);
  if (!target) return null;
  const day = 86_400_000;
  return all
    .filter((t) => t.id !== id && t.accountId === target.accountId && t.state !== 'ignored' && !t.sourceIds.some((s) => target.sourceIds.includes(s)))
    .map((t) => ({
      id: t.id,
      occurredAt: t.occurredAt,
      amount: t.amount,
      description: t.description,
      status: t.status,
      category: t.category,
      sourceIds: t.sourceIds,
      daysApart: Math.round(Math.abs(new Date(t.occurredAt).getTime() - new Date(target.occurredAt).getTime()) / day),
    }))
    .filter((c) => c.daysApart <= 10)
    .sort((a, b) => (a.amount === target.amount ? 0 : 1) - (b.amount === target.amount ? 0 : 1) || a.daysApart - b.daysApart || Math.abs(a.amount - target.amount) - Math.abs(b.amount - target.amount))
    .slice(0, 12);
}

/** The user's word on a card bill: true writes off the leftover, false keeps it owed, null goes back to the automatic rule. */
export function setCycleSettled(store: Store, accountId: unknown, cycleKey: unknown, settled: unknown, now: Date): MutationResult {
  if (typeof accountId !== 'string' || typeof cycleKey !== 'string' || !/^\d{4}-\d{2}$/.test(cycleKey)) return { ok: false, status: 400, error: 'accountId and cycleKey (YYYY-MM) are required' };
  if (settled !== true && settled !== false && settled !== null) return { ok: false, status: 400, error: 'settled must be true, false or null' };
  if (!store.listCanonicalAccounts().some((a) => a.id === accountId && a.kind === 'credit_card')) return { ok: false, status: 404, error: 'not_found' };
  store.setCycleOverride(accountId, cycleKey, settled, now.toISOString());
  return { ok: true };
}

/** The user says which installment a charge is, for charges the sources deliver without it. `null` clears what was set. */
export function setTransactionInstallment(store: Store, transactionId: string, number: unknown, total: unknown, now: Date): MutationResult {
  const transaction = effectiveTransactions(store, { includeHidden: true, includeExcluded: true }).find((t) => t.id === transactionId);
  if (!transaction) return { ok: false, status: 404, error: 'not_found' };
  if (number === null && total === null) {
    store.setInstallmentOverride(transactionId, null, now.toISOString());
    return { ok: true };
  }
  if (!Number.isInteger(number) || !Number.isInteger(total) || (number as number) < 1 || (total as number) < 2 || (total as number) > 120 || (number as number) > (total as number)) {
    return { ok: false, status: 400, error: 'number must be from 1 to total, and total from 2 to 120' };
  }
  store.setInstallmentOverride(transactionId, { number: number as number, total: total as number }, now.toISOString());
  return { ok: true };
}
