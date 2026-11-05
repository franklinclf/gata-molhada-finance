import { CATEGORY_NAMES } from '../ai/taxonomy.ts';
import { runReconciliation } from '../reconcile/run.ts';
import type { Store } from '../store/store.ts';
import { isManualId, manualNumber } from './manual.ts';
import { categoryParents } from './category-groups.ts';
import { effectiveTransactions, resolveAlias, ruleKey } from './scope.ts';
import { cyclesFor } from './cycles.ts';
import { localDay } from '../core/time.ts';

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
  // A transaction typed in by hand has no source record to hang an override on: its category is part of the transaction.
  if (isManualId(transactionId)) {
    const manual = store.listManualTransactions().find((m) => m.id === manualNumber(transactionId));
    if (!manual) return { ok: false, status: 404, error: 'not_found' };
    const name = category === null ? null : cleanCategoryName(category);
    if (category !== null && name === null) return { ok: false, status: 400, error: `category must be text of 1 to ${MAX_NAME} characters` };
    if (name !== null && !store.listCustomCategories().includes(name)) store.addCustomCategory(name, at);
    store.saveManualTransaction({ ...manual, category: name }, at);
    if (applyToSimilar) store.setCategoryRule(ruleKey(transaction.description), name, at);
    rebuild(store, now);
    return { ok: true };
  }
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
  /** A label a source sent that is neither ours nor yours. It has no equivalent yet; mapping it with a rule gives it one. */
  fromSource: boolean;
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
    const row = rows.get(t.category) ?? { name: t.category, count: 0, custom: custom.has(t.category), builtin: CATEGORY_NAMES.includes(t.category), fromSource: !custom.has(t.category) && !CATEGORY_NAMES.includes(t.category), amount: 0, parent: parents.get(t.category) ?? null };
    row.count += 1;
    row.amount += -t.amount;
    rows.set(t.category, row);
  }
  for (const name of custom) if (!rows.has(name)) rows.set(name, { name, count: 0, custom: true, builtin: false, fromSource: false, amount: 0, parent: parents.get(name) ?? null });
  for (const name of CATEGORY_NAMES) if (!rows.has(name)) rows.set(name, { name, count: 0, custom: false, builtin: true, fromSource: false, amount: 0, parent: parents.get(name) ?? null });
  // A category renamed or merged into another no longer exists under its old name.
  const aliases = store.listCategoryAliases();
  return [...rows.values()].filter((r) => !aliases.has(r.name)).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

const FIXED_NAMES = new Set(['Pagamento de fatura', 'Transferência entre minhas contas', 'Investimentos']);

/**
 * Renames a category, or merges it into another one when the new name already exists. Built-in, custom and source
 * categories can all be renamed: the old name is replaced by the new one on every transaction, rule, budget and group,
 * and "Desfazer" brings it back. The three that mean a role (card payment, move between your accounts, investment) keep their names.
 */
export function renameCategory(store: Store, from: unknown, to: unknown, now: Date): MutationResult {
  const oldName = cleanCategoryName(from);
  const newName = cleanCategoryName(to);
  if (oldName === null || newName === null) return { ok: false, status: 400, error: `names must be text of 1 to ${MAX_NAME} characters` };
  if (oldName === newName) return { ok: false, status: 400, error: 'the new name is the same' };
  const listed = listCategories(store);
  if (!listed.some((c) => c.name === oldName)) return { ok: false, status: 404, error: 'not_found' };
  if (FIXED_NAMES.has(oldName) || FIXED_NAMES.has(newName)) return { ok: false, status: 400, error: 'this name means card payment, move between your accounts or investment, and stays as it is' };
  const parents = categoryParents(store);
  if ([...parents.values()].includes(oldName) || [...parents.values()].includes(newName)) return { ok: false, status: 400, error: 'this name is a group that holds other categories' };
  if (resolveAlias(store.listCategoryAliases(), newName) === oldName) return { ok: false, status: 400, error: 'that would make a loop' };
  const at = now.toISOString();
  const target = resolveAlias(store.listCategoryAliases(), newName);
  if (!listed.some((c) => c.name === target)) store.addCustomCategory(target, at);
  store.setCategoryAlias(oldName, target, at);
  // The new name keeps the group the old one was in, unless it already has its own.
  const parent = parents.get(oldName);
  if (parent && !parents.has(target)) store.setCategoryParent(target, parent, at);
  store.renameBudgetCategory(oldName, target);
  if (store.listCustomCategories().includes(oldName)) store.deleteCustomCategory(oldName);
  return { ok: true };
}

/** Brings back a category that was renamed or merged: its old name shows again. */
export function undoRename(store: Store, from: unknown): MutationResult {
  const name = cleanCategoryName(from);
  if (name === null || !store.listCategoryAliases().has(name)) return { ok: false, status: 404, error: 'not_found' };
  store.setCategoryAlias(name, null, new Date().toISOString());
  return { ok: true };
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
  // A rule that points to a removed category would give transactions a category that no longer exists. It is switched off, not deleted.
  for (const rule of store.listRules()) if (rule.actions.category === name && rule.active) store.saveRule({ ...rule, active: false }, new Date().toISOString());
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
  if (isManualId(id)) return { ok: false, status: 400, error: 'a transaction you typed in is removed by deleting it' };
  store.setTransactionIgnored(id, ignored, now.toISOString());
  rebuild(store, now);
  return { ok: true };
}

/** The owner says a transaction is pending or posted, over what the source says. `null` goes back to the source. */
export function setTransactionStatus(store: Store, id: string, status: unknown, now: Date): MutationResult {
  if (status !== 'pending' && status !== 'posted' && status !== null) return { ok: false, status: 400, error: 'status must be pending, posted or null' };
  if (!knownTransaction(store, id)) return { ok: false, status: 404, error: 'not_found' };
  if (isManualId(id)) return { ok: false, status: 400, error: 'a transaction you typed in is edited directly' };
  store.setTransactionOverride(id, { status }, now.toISOString());
  rebuild(store, now);
  return { ok: true };
}

/** The owner moves a card charge to another bill (named by its due month, YYYY-MM). `null` goes back to following its date. */
export function setTransactionCycle(store: Store, id: string, cycleKey: unknown, now: Date): MutationResult {
  if (cycleKey !== null && (typeof cycleKey !== 'string' || !/^\d{4}-\d{2}$/.test(cycleKey))) return { ok: false, status: 400, error: 'cycleKey must be YYYY-MM or null' };
  const transaction = effectiveTransactions(store, { includeHidden: true, includeExcluded: true }).find((t) => t.id === id);
  if (!transaction) return { ok: false, status: 404, error: 'not_found' };
  if (isManualId(id)) return { ok: false, status: 400, error: 'a transaction you typed in is edited directly' };
  if (!store.listCanonicalAccounts().some((a) => a.id === transaction.accountId && a.kind === 'credit_card')) return { ok: false, status: 400, error: 'only card charges belong to a bill' };
  store.setTransactionOverride(id, { cycleKey }, now.toISOString());
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
  /** The standard name shown on screen. */
  title: string;
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
      title: t.title,
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

/**
 * Transactions on the same account with exactly the same amount within five days, from any source, that this one could be a
 * copy of (the bank's pending debit and its posted twin, two texts for one card payment). Saying "this is the copy" is
 * "ignore this one": it leaves the totals and the other one stays.
 */
export function duplicateCandidates(store: Store, id: string): Candidate[] | null {
  const all = effectiveTransactions(store, { includeHidden: true, includeExcluded: true });
  const target = all.find((t) => t.id === id);
  if (!target) return null;
  const day = 86_400_000;
  return all
    .filter((t) => t.id !== id && t.accountId === target.accountId && t.state !== 'ignored' && t.amount === target.amount)
    .map((t) => ({
      id: t.id,
      title: t.title,
      occurredAt: t.occurredAt,
      amount: t.amount,
      description: t.description,
      status: t.status,
      category: t.category,
      sourceIds: t.sourceIds,
      daysApart: Math.round(Math.abs(new Date(t.occurredAt).getTime() - new Date(target.occurredAt).getTime()) / day),
    }))
    .filter((c) => c.daysApart <= 5)
    .sort((a, b) => a.daysApart - b.daysApart)
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
  if (isManualId(transactionId)) return { ok: false, status: 400, error: 'a transaction you typed in is edited directly' };
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

/**
 * Says which purchase a refund returned. `otherId` links this transaction with it (the credit is the refund, the debit is the
 * purchase). `null` says this transaction is not a reversal: the pair the app guessed, or the one the owner made, is undone and
 * the guess does not come back.
 */
export function setReversal(store: Store, id: string, otherId: unknown, now: Date): MutationResult {
  if (otherId !== null && typeof otherId !== 'string') return { ok: false, status: 400, error: 'otherId must be a transaction id or null' };
  const all = effectiveTransactions(store, { includeHidden: true, includeExcluded: true });
  const me = all.find((t) => t.id === id);
  if (!me) return { ok: false, status: 404, error: 'not_found' };
  const iso = now.toISOString();
  if (otherId === null) {
    if (!me.reversal) return { ok: true };
    const [chargeId, refundId] = me.reversal.side === 'charge' ? [me.id, me.reversal.otherId] : [me.reversal.otherId, me.id];
    return store.setReversalLink(chargeId, refundId, false, iso) ? { ok: true } : { ok: false, status: 400, error: 'a transaction you typed in cannot be paired' };
  }
  const other = all.find((t) => t.id === otherId);
  if (!other) return { ok: false, status: 404, error: 'not_found' };
  if (other.id === me.id || other.amount === 0 || me.amount === 0 || other.amount > 0 === me.amount > 0) return { ok: false, status: 400, error: 'a purchase pairs with a credit, not with another purchase' };
  const [charge, refund] = me.amount < 0 ? [me, other] : [other, me];
  return store.setReversalLink(charge.id, refund.id, true, iso) ? { ok: true } : { ok: false, status: 400, error: 'a transaction you typed in cannot be paired' };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The owner changes a card bill: its total, closing day, due day, or whether it is paid. A field left out keeps what it had, `null`
 * clears that field, and `reset: true` forgets every edit of the bill. Only bills that have closed can be edited.
 */
export function editBill(store: Store, input: Record<string, unknown>, now: Date): MutationResult {
  const { accountId, cycleKey } = input;
  if (typeof accountId !== 'string' || typeof cycleKey !== 'string' || !/^\d{4}-\d{2}$/.test(cycleKey)) return { ok: false, status: 400, error: 'accountId and cycleKey (YYYY-MM) are required' };
  const account = store.listCanonicalAccounts().find((a) => a.id === accountId && a.kind === 'credit_card');
  if (!account) return { ok: false, status: 404, error: 'not_found' };
  const iso = now.toISOString();
  if (input.reset === true) {
    store.setBillEdit(accountId, cycleKey, null, iso);
    return { ok: true };
  }
  const before = store.listBillEdits().get(`${accountId}|${cycleKey}`) ?? { total: null, closingDate: null, dueDate: null, status: null };
  const next = { ...before };
  if ('total' in input) {
    if (input.total !== null && (!Number.isInteger(input.total) || (input.total as number) < 0 || (input.total as number) > 100_000_000)) return { ok: false, status: 400, error: 'total must be a whole number of cents, 0 or more' };
    next.total = input.total as number | null;
  }
  for (const [field, column] of [['closingDate', 'closingDate'], ['dueDate', 'dueDate']] as const) {
    if (!(field in input)) continue;
    const value = input[field];
    if (value !== null && (typeof value !== 'string' || !DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))) return { ok: false, status: 400, error: `${field} must be YYYY-MM-DD or null` };
    next[column] = value as string | null;
  }
  if ('status' in input) {
    if (input.status !== null && input.status !== 'paid' && input.status !== 'unpaid') return { ok: false, status: 400, error: 'status must be paid, unpaid or null' };
    next.status = input.status as 'paid' | 'unpaid' | null;
  }
  const cycle = cyclesFor(store, account, effectiveTransactions(store, { includeHidden: true }), localDay(now.toISOString())).find((c) => c.key === cycleKey);
  if (!cycle) return { ok: false, status: 404, error: 'not_found' };
  if (cycle.status === 'open') return { ok: false, status: 400, error: 'a bill that has not closed cannot be edited' };
  if (next.closingDate !== null && next.dueDate !== null && next.dueDate < next.closingDate) return { ok: false, status: 400, error: 'the due day cannot come before the closing day' };
  store.setBillEdit(accountId, cycleKey, next, iso);
  return { ok: true };
}
