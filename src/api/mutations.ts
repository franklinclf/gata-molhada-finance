import type { Store } from '../store/store.ts';
import { effectiveTransactions, ruleKey } from './scope.ts';

export type MutationResult = { ok: true } | { ok: false; status: number; error: string };

const MAX_NAME = 60;

export function cleanCategoryName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  return name.length >= 1 && name.length <= MAX_NAME ? name : null;
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
  /** Spending in the category (money out minus money in), over all time. */
  amount: number;
}

export function listCategories(store: Store): CategoryRow[] {
  const custom = new Set(store.listCustomCategories());
  const rows = new Map<string, CategoryRow>();
  for (const t of effectiveTransactions(store, { includeHidden: true })) {
    if (t.category === null) continue;
    const row = rows.get(t.category) ?? { name: t.category, count: 0, custom: custom.has(t.category), amount: 0 };
    row.count += 1;
    row.amount += -t.amount;
    rows.set(t.category, row);
  }
  for (const name of custom) if (!rows.has(name)) rows.set(name, { name, count: 0, custom: true, amount: 0 });
  return [...rows.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function addCategory(store: Store, name: unknown, now: Date): MutationResult {
  const clean = cleanCategoryName(name);
  if (clean === null) return { ok: false, status: 400, error: `name must be text of 1 to ${MAX_NAME} characters` };
  store.addCustomCategory(clean, now.toISOString());
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
