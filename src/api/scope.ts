import type { CanonicalAccount, CanonicalTransaction, LimitGroup } from '../core/canonical.ts';
import { normalizeName } from '../core/names.ts';
import { roleOf, type Role } from './roles.ts';
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
  /** Card payment, own transfer or investment: not spending or income. Does not depend on the category shown. */
  role: Role | null;
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
  const installmentOverrides = store.listInstallmentOverrides();
  return store
    .listCanonicalTransactions({ accountId: options.accountId, includeExcluded: options.includeExcluded })
    .filter((t) => ids.has(t.accountId))
    .map((t) => {
      let category = t.category;
      let origin: CategoryOrigin = 'source';
      const override = overrides.get(t.id);
      const rule = rules.get(ruleKey(t.description));
      const suggested = ai.get(ruleKey(t.description));
      if (override !== undefined) [category, origin] = [override, 'override'];
      else if (rule !== undefined) [category, origin] = [rule, 'rule'];
      else if (suggested?.status === 'applied') [category, origin] = [suggested.category, 'ai'];
      const installment = installmentOverrides.get(t.id) ?? t.installment;
      return { ...t, installment, category, categoryOrigin: origin, sourceCategory: t.category, role: roleOf({ sourceCategory: t.category, description: t.description, category, categoryOrigin: origin }) };
    });
}
