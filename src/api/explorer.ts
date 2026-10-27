import type { TransactionState } from '../core/canonical.ts';
import type { Cents } from '../core/money.ts';
import { localDay } from '../core/time.ts';
import type { Store } from '../store/store.ts';
import { cyclesFor } from './cycles.ts';
import { effectiveTransactions, visibleAccounts, type EffectiveTransaction, type ViewOptions } from './scope.ts';
import { isNonSpending } from './views.ts';
import { stamp, type Stamped } from './stamp.ts';

export type SortKey = 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc';

export interface ExplorerQuery {
  from?: string;
  to?: string;
  accountIds?: string[];
  institutions?: string[];
  /** Category names. The empty string stands for "no category". */
  categories?: string[];
  kind: 'all' | 'expense' | 'income';
  /** Text searched in the description, the raw description and the category. */
  q?: string;
  status?: 'pending' | 'posted';
  states?: TransactionState[];
  /** Bounds on the absolute amount, in cents. */
  min?: Cents;
  max?: Cents;
  /** `open` or a due month (YYYY-MM): keeps only card transactions inside that billing cycle. */
  cycle?: string;
  /** Leave out card payments, moves between own accounts and investments, as the spending view does. */
  spendingOnly?: boolean;
  sort: SortKey;
  limit: number;
  offset: number;
  includeExcluded?: boolean;
}

export interface ExplorerRow extends EffectiveTransaction {
  account: { institution: string; name: string; last4: string | null; kind: string };
}

export interface Facet {
  name: string;
  count: number;
  /** Money out minus money in for the group, positive when it is mostly spending. */
  amount: Cents;
}

export interface ExplorerResult extends Stamped {
  total: number;
  items: ExplorerRow[];
  sums: { count: number; income: Cents; expense: Cents; net: Cents };
  /** Counts for each filter option. A facet ignores its own filter, so the other options stay visible. */
  facets: { categories: Facet[]; accounts: Array<Facet & { id: string }>; institutions: Facet[] };
  /** Date range of each card cycle chosen, for the screen to show. */
  cycleRanges: Record<string, { from: string; to: string; dueDate: string }>;
}

type Dimension = 'category' | 'account' | 'institution';

export function explore(store: Store, query: ExplorerQuery, now: Date, opts: ViewOptions = {}): ExplorerResult {
  const accounts = visibleAccounts(store, opts);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const all = effectiveTransactions(store, { ...opts, includeExcluded: query.includeExcluded }, accounts);
  const today = localDay(now.toISOString());

  const cycleRanges: ExplorerResult['cycleRanges'] = {};
  if (query.cycle !== undefined) {
    for (const account of accounts.filter((a) => a.kind === 'credit_card')) {
      const cycles = cyclesFor(store, account, all, today);
      const chosen = query.cycle === 'open' ? cycles.find((c) => c.status === 'open') : cycles.find((c) => c.key === query.cycle);
      if (chosen) cycleRanges[account.id] = { from: chosen.from, to: chosen.to, dueDate: chosen.dueDate };
    }
  }

  const text = query.q?.trim().toLowerCase();
  const wanted = (skip?: Dimension) => (t: EffectiveTransaction): boolean => {
    const account = byId.get(t.accountId);
    if (!account) return false;
    const day = localDay(t.occurredAt);
    if (query.from !== undefined && day < query.from) return false;
    if (query.to !== undefined && day > query.to) return false;
    if (skip !== 'account' && query.accountIds?.length && !query.accountIds.includes(t.accountId)) return false;
    if (skip !== 'institution' && query.institutions?.length && !query.institutions.includes(account.institution)) return false;
    if (skip !== 'category' && query.categories?.length && !query.categories.includes(t.category ?? '')) return false;
    if (query.kind === 'expense' && t.amount >= 0) return false;
    if (query.kind === 'income' && t.amount <= 0) return false;
    if (query.status !== undefined && t.status !== query.status) return false;
    if (query.states?.length && !query.states.includes(t.state)) return false;
    const size = Math.abs(t.amount);
    if (query.min !== undefined && size < query.min) return false;
    if (query.max !== undefined && size > query.max) return false;
    if (query.spendingOnly && isNonSpending(t.category)) return false;
    if (query.cycle !== undefined) {
      const range = cycleRanges[t.accountId];
      if (!range || day < range.from || day > range.to) return false;
    }
    if (text) {
      const haystack = `${t.description} ${t.descriptionRaw ?? ''} ${t.category ?? ''}`.toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  };

  const matching = all.filter(wanted());
  const order: Record<SortKey, (a: EffectiveTransaction, b: EffectiveTransaction) => number> = {
    date_desc: (a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id),
    date_asc: (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id),
    amount_desc: (a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.id.localeCompare(b.id),
    amount_asc: (a, b) => Math.abs(a.amount) - Math.abs(b.amount) || a.id.localeCompare(b.id),
  };
  matching.sort(order[query.sort]);

  let income = 0;
  let expense = 0;
  for (const t of matching) {
    if (t.amount >= 0) income += t.amount;
    else expense += -t.amount;
  }

  const facet = (skip: Dimension, key: (t: EffectiveTransaction) => string): Map<string, Facet> => {
    const map = new Map<string, Facet>();
    for (const t of all.filter(wanted(skip))) {
      const name = key(t);
      const entry = map.get(name) ?? { name, count: 0, amount: 0 };
      entry.count += 1;
      entry.amount += -t.amount;
      map.set(name, entry);
    }
    return map;
  };
  const sortFacets = (map: Map<string, Facet>) => [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const accountFacets = facet('account', (t) => t.accountId);

  const items = matching.slice(query.offset, query.offset + query.limit).map((t) => {
    const a = byId.get(t.accountId)!;
    return { ...t, account: { institution: a.institution, name: a.name, last4: a.last4, kind: a.kind } };
  });

  return {
    ...stamp(accounts, now),
    total: matching.length,
    items,
    sums: { count: matching.length, income, expense, net: income - expense },
    facets: {
      categories: sortFacets(facet('category', (t) => t.category ?? '')),
      accounts: [...accountFacets.values()].map((f) => ({ ...f, id: f.name, name: `${byId.get(f.name)?.institution ?? ''} ${byId.get(f.name)?.name ?? ''}`.trim() })).sort((a, b) => b.count - a.count),
      institutions: sortFacets(facet('institution', (t) => byId.get(t.accountId)?.institution ?? '')),
    },
    cycleRanges,
  };
}
