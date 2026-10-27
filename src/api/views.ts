import type { CanonicalAccount, CanonicalTransaction } from '../core/canonical.ts';
import type { Cents } from '../core/money.ts';
import { institutionKey } from '../core/names.ts';
import { localDay } from '../core/time.ts';
import { summarizeAccounts } from '../reconcile/accounts.ts';
import { quotaReport } from '../scheduler/quota.ts';
import type { Store } from '../store/store.ts';

/** Every view says when it was built and how old the oldest data behind it is. */
export interface Stamped {
  generatedAt: string;
  /** Oldest "last synced" time among the accounts used, or null when no source reported one. */
  oldestDataAt: string | null;
}

function stamp(accounts: CanonicalAccount[], now: Date): Stamped {
  const times = accounts.map((a) => a.balanceAsOf).filter((t): t is string => t !== null).sort();
  return { generatedAt: now.toISOString(), oldestDataAt: times[0] ?? null };
}

const isBank = (a: CanonicalAccount) => a.kind !== 'credit_card';

/** Categories that move money between the user's own accounts or pay a card bill, not spending. */
const NON_SPENDING = [/mesma titularidade/, /pagamento de cart/, /credit card payment/, /investiment/, /investment/];

export function isNonSpending(category: string | null): boolean {
  if (category === null) return false;
  const text = category.toLowerCase();
  return NON_SPENDING.some((pattern) => pattern.test(text));
}

const isOwnTransfer = (category: string | null) => category !== null && /mesma titularidade/i.test(category);

export interface DateRange {
  /** First local day, inclusive (YYYY-MM-DD). */
  from: string;
  /** Last local day, inclusive. */
  to: string;
}

export function monthRange(now: Date): DateRange {
  const today = localDay(now.toISOString());
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

function inRange(t: CanonicalTransaction, range: DateRange): boolean {
  const day = localDay(t.occurredAt);
  return day >= range.from && day <= range.to;
}

function liveTransactions(store: Store, range: DateRange): CanonicalTransaction[] {
  return store.listCanonicalTransactions().filter((t) => !t.excluded && inRange(t, range));
}

// ---------- balances ----------

export interface BalancesView extends Stamped {
  total: Cents;
  institutions: Array<{ institution: string; balance: Cents; share: number; accounts: number; asOf: string | null }>;
  accounts: Array<{ id: string; institution: string; name: string; kind: string; last4: string | null; balance: Cents; asOf: string | null }>;
}

export function balances(store: Store, now: Date): BalancesView {
  const accounts = store.listCanonicalAccounts().filter(isBank);
  const total = accounts.reduce((sum, a) => sum + a.balance, 0);
  const byInstitution = new Map<string, { institution: string; balance: Cents; accounts: number; times: string[] }>();
  for (const a of accounts) {
    const key = institutionKey(a.institution);
    const row = byInstitution.get(key) ?? { institution: a.institution, balance: 0, accounts: 0, times: [] };
    row.balance += a.balance;
    row.accounts += 1;
    if (a.balanceAsOf) row.times.push(a.balanceAsOf);
    byInstitution.set(key, row);
  }
  return {
    ...stamp(accounts, now),
    total,
    institutions: [...byInstitution.values()]
      .sort((a, b) => b.balance - a.balance)
      .map((r) => ({ institution: r.institution, balance: r.balance, share: total > 0 ? r.balance / total : 0, accounts: r.accounts, asOf: r.times.sort()[0] ?? null })),
    accounts: accounts.map((a) => ({ id: a.id, institution: a.institution, name: a.name, kind: a.kind, last4: a.last4, balance: a.balance, asOf: a.balanceAsOf })),
  };
}

// ---------- cards ----------

export interface CardsView extends Stamped {
  totals: { owed: Cents; creditLimit: Cents; used: Cents; available: Cents };
  cards: Array<{
    id: string;
    institution: string;
    name: string;
    last4: string | null;
    balance: Cents;
    creditLimit: Cents | null;
    availableLimit: Cents | null;
    limitGroupId: string | null;
    dueDate: string | null;
    minimumPayment: Cents | null;
    asOf: string | null;
  }>;
  /** Cards that share one limit appear here once, so the limit is not counted twice. */
  limitGroups: Array<{ id: string; institution: string; creditLimit: Cents; used: Cents; available: Cents; cardIds: string[] }>;
}

export function cards(store: Store, now: Date): CardsView {
  const all = store.listCanonicalAccounts();
  const cardAccounts = all.filter((a) => a.kind === 'credit_card');
  const totals = summarizeAccounts(all);
  const byId = new Map(cardAccounts.map((a) => [a.id, a]));
  const limitGroups = store.listLimitGroups().map((g) => {
    const first = byId.get(g.memberIds[0] ?? '');
    const available = first?.availableLimit ?? g.creditLimit - (first?.balance ?? 0);
    return { id: g.id, institution: g.institution, creditLimit: g.creditLimit, used: g.creditLimit - available, available, cardIds: g.memberIds };
  });
  return {
    ...stamp(cardAccounts, now),
    totals: { owed: totals.cardOwed, creditLimit: totals.creditLimit, used: totals.creditUsed, available: totals.creditAvailable },
    cards: cardAccounts.map((a) => ({
      id: a.id,
      institution: a.institution,
      name: a.name,
      last4: a.last4,
      balance: a.balance,
      creditLimit: a.creditLimit,
      availableLimit: a.availableLimit,
      limitGroupId: a.limitGroupId,
      dueDate: a.dueDate,
      minimumPayment: a.minimumPayment,
      asOf: a.balanceAsOf,
    })),
    limitGroups,
  };
}

// ---------- transactions ----------

export interface TransactionsQuery extends DateRange {
  accountId?: string;
  limit: number;
  offset: number;
  includeExcluded: boolean;
}

export interface TransactionsView extends Stamped {
  total: number;
  items: CanonicalTransaction[];
}

export function transactions(store: Store, query: TransactionsQuery, now: Date): TransactionsView {
  const matching = store
    .listCanonicalTransactions({ accountId: query.accountId, includeExcluded: query.includeExcluded })
    .filter((t) => inRange(t, query))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
  const accounts = store.listCanonicalAccounts();
  return { ...stamp(accounts, now), total: matching.length, items: matching.slice(query.offset, query.offset + query.limit) };
}

// ---------- cash flow ----------

export interface CashFlowView extends Stamped, DateRange {
  inflow: Cents;
  outflow: Cents;
  net: Cents;
  days: Array<{ day: string; inflow: Cents; outflow: Cents }>;
}

/** Money that enters and leaves bank accounts. Card purchases count when the bill is paid; moves between own accounts are left out. */
export function cashFlow(store: Store, range: DateRange, now: Date): CashFlowView {
  const accounts = store.listCanonicalAccounts();
  const bankIds = new Set(accounts.filter(isBank).map((a) => a.id));
  const perDay = new Map<string, { inflow: Cents; outflow: Cents }>();
  for (const t of liveTransactions(store, range)) {
    if (!bankIds.has(t.accountId) || isOwnTransfer(t.category)) continue;
    const day = localDay(t.occurredAt);
    const row = perDay.get(day) ?? { inflow: 0, outflow: 0 };
    if (t.amount >= 0) row.inflow += t.amount;
    else row.outflow += -t.amount;
    perDay.set(day, row);
  }
  const days = [...perDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, ...v }));
  const inflow = days.reduce((s, d) => s + d.inflow, 0);
  const outflow = days.reduce((s, d) => s + d.outflow, 0);
  return { ...stamp(accounts.filter(isBank), now), ...range, inflow, outflow, net: inflow - outflow, days };
}

// ---------- spending ----------

export type SpendingGroup = 'category' | 'merchant';

export interface SpendingView extends Stamped, DateRange {
  total: Cents;
  groupBy: SpendingGroup;
  groups: Array<{ name: string; amount: Cents; count: number; share: number }>;
}

/** What was spent, dated by purchase (accrual): card purchases on the purchase day, bank outflows on their day. Refunds subtract. */
export function spending(store: Store, range: DateRange, groupBy: SpendingGroup, now: Date): SpendingView {
  const accounts = store.listCanonicalAccounts();
  const rows = new Map<string, { amount: Cents; count: number }>();
  for (const t of liveTransactions(store, range)) {
    if (isNonSpending(t.category)) continue;
    const name = groupBy === 'category' ? (t.category ?? 'Sem categoria') : t.description;
    const row = rows.get(name) ?? { amount: 0, count: 0 };
    row.amount += -t.amount;
    row.count += 1;
    rows.set(name, row);
  }
  const groups = [...rows]
    .map(([name, v]) => ({ name, ...v }))
    .filter((g) => g.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const total = groups.reduce((s, g) => s + g.amount, 0);
  return { ...stamp(accounts, now), ...range, total, groupBy, groups: groups.map((g) => ({ ...g, share: total > 0 ? g.amount / total : 0 })) };
}

// ---------- installments ----------

export interface InstallmentsView extends Stamped {
  /** Sum of one installment of every purchase that still has installments after the latest one seen. */
  monthlyCommitment: Cents;
  remainingTotal: Cents;
  items: Array<{ accountId: string; description: string; number: number; total: number; installmentAmount: Cents; remainingCount: number; remainingAmount: Cents; lastMonth: string }>;
}

function addMonths(day: string, months: number): string {
  const [y, m] = day.split('-').map(Number) as [number, number];
  const index = y * 12 + (m - 1) + months;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

export function installments(store: Store, now: Date): InstallmentsView {
  const accounts = store.listCanonicalAccounts();
  const latest = new Map<string, CanonicalTransaction>();
  for (const t of store.listCanonicalTransactions()) {
    if (!t.installment || t.excluded || t.installment.total < 2) continue;
    const key = `${t.accountId}|${t.description}|${t.installment.total}|${-t.amount}`;
    const current = latest.get(key);
    if (!current || t.installment.number > current.installment!.number) latest.set(key, t);
  }
  const items = [...latest.values()]
    .filter((t) => t.installment!.number < t.installment!.total)
    .map((t) => {
      const { number, total } = t.installment!;
      const remainingCount = total - number;
      return {
        accountId: t.accountId,
        description: t.description,
        number,
        total,
        installmentAmount: -t.amount,
        remainingCount,
        remainingAmount: remainingCount * -t.amount,
        lastMonth: addMonths(localDay(t.occurredAt), remainingCount),
      };
    })
    .sort((a, b) => b.remainingAmount - a.remainingAmount);
  return {
    ...stamp(accounts, now),
    monthlyCommitment: items.reduce((s, i) => s + i.installmentAmount, 0),
    remainingTotal: items.reduce((s, i) => s + i.remainingAmount, 0),
    items,
  };
}

// ---------- freshness and findings ----------

export interface FreshnessView {
  generatedAt: string;
  sources: Array<{ sourceId: string; institution: string; lastUpdatedAt: string; observedAt: string; quotaExhausted: boolean }>;
  quota: ReturnType<typeof quotaReport>;
}

export function freshness(store: Store, now: Date): FreshnessView {
  return {
    generatedAt: now.toISOString(),
    sources: store.listFreshness().map((f) => ({ sourceId: f.sourceId, institution: f.institution, lastUpdatedAt: f.lastUpdatedAt, observedAt: f.observedAt, quotaExhausted: f.quotaExhausted === true })),
    quota: quotaReport(store, now),
  };
}

export function findings(store: Store, includeResolved: boolean) {
  return store.listFindings({ includeResolved });
}
