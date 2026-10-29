import { merchantOf } from '../core/merchant.ts';
import type { Store } from '../store/store.ts';
import { createRule, type RuleResult } from './rules.ts';
import type { Leaf } from './rules-engine.ts';
import { effectiveTransactions } from './scope.ts';

export interface RuleSuggestion {
  merchant: string;
  category: string;
  /** Transactions of this merchant. */
  count: number;
  /** How many different texts the bank used for it. */
  descriptions: number;
  /** Transactions of the merchant that sit in another category today. */
  differing: number;
}

const MIN_TRANSACTIONS = 3;
const MIN_SHARE = 0.9;
const MAX_SUGGESTIONS = 15;
const DISMISSED_KEY = 'rule_suggestions_dismissed';

const dismissedSet = (store: Store): Set<string> => {
  const raw = store.getSetting(DISMISSED_KEY);
  try {
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
};

const isMerchantRule = (leaf: Leaf | unknown, merchant: string): boolean => {
  const l = leaf as Leaf;
  return l && l.field === 'merchant' && l.operator === 'equals' && String(l.value).toLowerCase() === merchant.toLowerCase();
};

/**
 * Merchants whose transactions almost all share one category, where a rule would keep it that way: it fixes the few that
 * differ and covers the next text the bank invents for the same shop. Found by counting, with no model call. Skipped:
 * transfers and bill payments, people, merchants that already have a rule, and the ones dismissed.
 */
export function suggestRules(store: Store): RuleSuggestion[] {
  const dismissed = dismissedSet(store);
  const rules = store.listRules();
  const byMerchant = new Map<string, { name: string; categories: Map<string, number>; texts: Set<string>; total: number }>();
  for (const t of effectiveTransactions(store, { includeHidden: true })) {
    if (t.excluded || t.role !== null || !t.category || t.counterparty?.kind === 'person') continue;
    const name = merchantOf(t);
    const key = name.toLowerCase();
    const entry = byMerchant.get(key) ?? { name, categories: new Map(), texts: new Set(), total: 0 };
    entry.categories.set(t.category, (entry.categories.get(t.category) ?? 0) + 1);
    entry.texts.add(t.description.toLowerCase());
    entry.total++;
    byMerchant.set(key, entry);
  }
  const out: RuleSuggestion[] = [];
  for (const [key, e] of byMerchant) {
    if (e.total < MIN_TRANSACTIONS || dismissed.has(key)) continue;
    if (rules.some((r) => r.conditions.items.some((i) => isMerchantRule(i, e.name)))) continue;
    const [category, top] = [...e.categories].sort((a, b) => b[1] - a[1])[0]!;
    if (top / e.total < MIN_SHARE) continue;
    const differing = e.total - top;
    // Worth a rule when something needs fixing, or the bank writes the shop in several ways.
    if (differing === 0 && e.texts.size < 2) continue;
    out.push({ merchant: e.name, category, count: e.total, descriptions: e.texts.size, differing });
  }
  return out.sort((a, b) => b.differing * 3 + b.count - (a.differing * 3 + a.count) || a.merchant.localeCompare(b.merchant)).slice(0, MAX_SUGGESTIONS);
}

export function acceptRuleSuggestion(store: Store, merchant: unknown, category: unknown, now: Date): RuleResult<{ id: number }> {
  if (typeof merchant !== 'string' || typeof category !== 'string') return { ok: false, status: 400, error: 'merchant and category are required' };
  const wanted = suggestRules(store).find((s) => s.merchant.toLowerCase() === merchant.toLowerCase() && s.category === category);
  if (!wanted) return { ok: false, status: 409, error: 'this suggestion is no longer valid' };
  const names = new Set(store.listRules().map((r) => r.name.toLowerCase()));
  let name = `Estabelecimento: ${wanted.merchant}`;
  for (let n = 2; names.has(name.toLowerCase()); n++) name = `Estabelecimento: ${wanted.merchant} (${n})`;
  const made = createRule(store, { name: name.slice(0, 80), conditions: { match: 'all', items: [{ field: 'merchant', operator: 'equals', value: wanted.merchant }] }, actions: { category: wanted.category } }, now);
  return made.ok ? { ok: true, value: { id: made.value.id } } : made;
}

export function dismissRuleSuggestion(store: Store, merchant: unknown, now: Date): RuleResult {
  if (typeof merchant !== 'string' || merchant.trim() === '') return { ok: false, status: 400, error: 'merchant is required' };
  const set = dismissedSet(store);
  set.add(merchant.trim().toLowerCase());
  store.setSetting(DISMISSED_KEY, JSON.stringify([...set].slice(-500)), now.toISOString());
  return { ok: true, value: {} };
}
