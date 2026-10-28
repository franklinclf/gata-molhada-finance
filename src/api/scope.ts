import type { CanonicalAccount, CanonicalTransaction, LimitGroup } from '../core/canonical.ts';
import { normalizeName } from '../core/names.ts';
import { mapSourceCategory } from '../ai/source-map.ts';
import { ownerNames, roleOf, type Role } from './roles.ts';
import type { Store } from '../store/store.ts';

export interface ViewOptions {
  /** Include the accounts the user chose to hide. Off by default, so every total ignores them. */
  includeHidden?: boolean;
}

export type CategoryOrigin = 'source' | 'override' | 'rule' | 'ai';

/** A canonical transaction with the category the user sees: a manual choice, then a rule, then what the source said. */
export interface EffectiveTransaction extends CanonicalTransaction {
  categoryOrigin: CategoryOrigin;
  sourceCategory: string | null;
  /** Every label the sources gave this transaction, the one in `sourceCategory` first. */
  sourceLabels: string[];
  /** Card payment, own transfer or investment: not spending or income. Does not depend on the category shown. */
  role: Role | null;
}

/** Key that a category rule matches on. */
const ROLE_CATEGORY: Record<Role, string> = { card_payment: 'Pagamento de fatura', own_transfer: 'Transferência entre minhas contas', investment: 'Investimentos' };

export function ruleKey(description: string): string {
  // "Store 03/12" and "Store 04/12" are the same shop, so the installment number is not part of the key.
  return normalizeName(description.replace(/\s*\d{1,2}\s*\/\s*\d{1,2}\s*$/, ''));
}

export function visibleAccounts(store: Store, options: ViewOptions = {}): CanonicalAccount[] {
  const all = store.listCanonicalAccounts();
  if (options.includeHidden) return all;
  const hidden = store.listHiddenAccountIds();
  return all.filter((a) => !hidden.has(a.id));
}

/** Limit groups with their hidden members removed. A group with no visible member disappears. */
export function visibleLimitGroups(store: Store, accounts: CanonicalAccount[]): LimitGroup[] {
  const ids = new Set(accounts.map((a) => a.id));
  return store
    .listLimitGroups()
    .map((g) => ({ ...g, memberIds: g.memberIds.filter((id) => ids.has(id)) }))
    .filter((g) => g.memberIds.length > 0);
}

export function effectiveTransactions(
  store: Store,
  options: ViewOptions & { accountId?: string; includeExcluded?: boolean } = {},
  accounts: CanonicalAccount[] = visibleAccounts(store, options),
): EffectiveTransaction[] {
  const ids = new Set(accounts.map((a) => a.id));
  const overrides = store.listCategoryOverrides();
  const rules = store.listCategoryRules();
  const ai = store.listAiCategories();
  const installmentOverrides = store.listInstallmentOverrides();
  const all = store.listCanonicalTransactions({ accountId: options.accountId, includeExcluded: options.includeExcluded });
  const labelsOf = labelsByTransaction(store);
  const owners = ownerNames(store.listCanonicalTransactions({ includeExcluded: true }).map((t) => ({ sourceCategory: t.category, labels: mergeLabels(t.category, labelsOf.get(t.id)), description: t.description })));
  return all
    .filter((t) => ids.has(t.accountId))
    .map((t) => {
      const labels = mergeLabels(t.category, labelsOf.get(t.id));
      let category = t.category;
      let origin: CategoryOrigin = 'source';
      const override = overrides.get(t.id);
      const rule = rules.get(ruleKey(t.description));
      const suggested = ai.get(ruleKey(t.description));
      if (override !== undefined) [category, origin] = [override, 'override'];
      else if (rule !== undefined) [category, origin] = [rule, 'rule'];
      else if (labels.some((l) => mapSourceCategory(l) !== null)) category = labels.map((l) => mapSourceCategory(l)).find((c) => c !== null) ?? category;
      else if (suggested?.status === 'applied') [category, origin] = [suggested.category, 'ai'];
      const installment = installmentOverrides.get(t.id) ?? t.installment;
      const role = roleOf({ sourceCategory: t.category, labels, description: t.description, category, categoryOrigin: origin, owners });
      // What the source or the AI called it must agree with what it is for the arithmetic.
      if (role && (origin === 'source' || origin === 'ai')) category = ROLE_CATEGORY[role];
      return { ...t, installment, category, categoryOrigin: origin, sourceCategory: t.category, sourceLabels: labels, role };
    });
}

/** Labels of the source records behind each canonical transaction. */
function labelsByTransaction(store: Store): Map<string, string[]> {
  const byRecord = new Map<string, string>();
  for (const sourceId of ['pierre', 'pluggy']) for (const r of store.listSourceTransactions(sourceId)) if (r.category) byRecord.set(`${sourceId}|${r.externalId}`, r.category);
  const result = new Map<string, string[]>();
  for (const l of store.listAllTransactionLinks()) {
    const label = byRecord.get(`${l.sourceId}|${l.externalId}`);
    if (label) result.set(l.transactionId, [...(result.get(l.transactionId) ?? []), label]);
  }
  return result;
}

function mergeLabels(primary: string | null, others: string[] | undefined): string[] {
  return [...new Set([...(primary ? [primary] : []), ...(others ?? [])])];
}
