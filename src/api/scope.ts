import type { CanonicalAccount, CanonicalTransaction, LimitGroup } from '../core/canonical.ts';
import { normalizeName } from '../core/names.ts';
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
}

/** Key that a category rule matches on. */
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
  return store
    .listCanonicalTransactions({ accountId: options.accountId, includeExcluded: options.includeExcluded })
    .filter((t) => ids.has(t.accountId))
    .map((t) => {
      const override = overrides.get(t.id);
      if (override !== undefined) return { ...t, category: override, categoryOrigin: 'override' as const, sourceCategory: t.category };
      const rule = rules.get(ruleKey(t.description));
      if (rule !== undefined) return { ...t, category: rule, categoryOrigin: 'rule' as const, sourceCategory: t.category };
      const suggested = ai.get(ruleKey(t.description));
      if (suggested?.status === 'applied') return { ...t, category: suggested.category, categoryOrigin: 'ai' as const, sourceCategory: t.category };
      return { ...t, categoryOrigin: 'source' as const, sourceCategory: t.category };
    });
}
