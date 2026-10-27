import type { CanonicalAccount, CanonicalTransaction } from '../core/canonical.ts';
import type { Cents } from '../core/money.ts';
import { institutionKey } from '../core/names.ts';
import { localDay } from '../core/time.ts';
import { summarizeAccounts } from '../reconcile/accounts.ts';
import { cyclesFor, type Cycle } from './cycles.ts';
import { quotaReport } from '../scheduler/quota.ts';
import type { Store } from '../store/store.ts';
import { stamp, type Stamped } from './stamp.ts';
import { effectiveTransactions, visibleAccounts, visibleLimitGroups, type EffectiveTransaction, type ViewOptions } from './scope.ts';

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

function liveTransactions(store: Store, range: DateRange, opts: ViewOptions): EffectiveTransaction[] {
  return effectiveTransactions(store, opts).filter((t) => !t.excluded && inRange(t, range));
}

// ---------- balances ----------

export type { Stamped };

export interface BalancesView extends Stamped {
  total: Cents;
  institutions: Array<{ institution: string; balance: Cents; share: number; accounts: number; asOf: string | null }>;
  accounts: Array<{ id: string; institution: string; name: string; kind: string; last4: string | null; balance: Cents; asOf: string | null }>;
}

export function balances(store: Store, now: Date, opts: ViewOptions = {}): BalancesView {
  const accounts = visibleAccounts(store, opts).filter(isBank);
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

export interface CardRow {
  id: string;
  institution: string;
  name: string;
  last4: string | null;
  /** Amount the issuer reports as owed now. For cards on a shared limit this is the total of the group. */
  balance: Cents;
  creditLimit: Cents | null;
  availableLimit: Cents | null;
  limitGroupId: string | null;
  asOf: string | null;
  /** The cycle chosen on the screen, or null when the card has no bills yet. */
  cycle: Cycle | null;
  /** Amount of the chosen cycle: the published bill, or for the open cycle the issuer's estimate (see `estimated`). */
  total: Cents;
  /** Net purchases already posted in the chosen cycle. */
  posted: Cents;
  /** True when `total` comes from the issuer's balance and can include installments that are not posted yet. */
  estimated: boolean;
  /** Closed bills still unpaid, whatever cycle is chosen. */
  outstanding: Cents;
  /** Due date to pay next: the oldest unpaid bill, else the open cycle. */
  nextDueDate: string | null;
  minimumPayment: Cents | null;
}

export interface CardsView extends Stamped {
  /** `open` is each card's current open cycle; otherwise a due month (YYYY-MM). */
  cycle: string;
  /** Due months that exist for at least one card, newest first. */
  cycles: string[];
  totals: { cycleTotal: Cents; outstanding: Cents; reportedByIssuer: Cents; creditLimit: Cents; used: Cents; available: Cents; nextDueDate: string | null };
  cards: CardRow[];
  /** Cards that share one limit appear here once, so the limit is not counted twice. */
  limitGroups: Array<{ id: string; institution: string; creditLimit: Cents; used: Cents; available: Cents; cardIds: string[]; openEstimate: Cents }>;
}

export function cards(store: Store, now: Date, opts: ViewOptions = {}, cycleChoice = 'open'): CardsView {
  const accounts = visibleAccounts(store, opts);
  const cardAccounts = accounts.filter((a) => a.kind === 'credit_card');
  const today = localDay(now.toISOString());
  const transactions = effectiveTransactions(store, opts, accounts);
  const allCycles = new Map(cardAccounts.map((a) => [a.id, cyclesFor(store, a, transactions, today)]));
  const groups = visibleLimitGroups(store, accounts);
  const groupOf = new Map(cardAccounts.filter((a) => a.limitGroupId !== null).map((a) => [a.id, a.limitGroupId as string]));

  const outstandingOf = (id: string) => (allCycles.get(id) ?? []).reduce((s, c) => s + c.outstanding, 0);
  const nextDueOf = (id: string): string | null => {
    const list = allCycles.get(id) ?? [];
    const unpaid = list.filter((c) => c.outstanding > 0).sort((x, y) => x.dueDate.localeCompare(y.dueDate))[0];
    return unpaid?.dueDate ?? list.find((c) => c.status === 'open')?.dueDate ?? null;
  };

  const rows: CardRow[] = cardAccounts.map((a) => {
    const list = allCycles.get(a.id) ?? [];
    const cycle = (cycleChoice === 'open' ? list.find((c) => c.status === 'open') : list.find((c) => c.key === cycleChoice)) ?? null;
    const outstanding = outstandingOf(a.id);
    const posted = cycle ? cycle.charges - cycle.credits : 0;
    let total = a.balance;
    let estimated = false;
    if (cycle) {
      if (cycle.billTotal !== null) total = cycle.billTotal;
      else if (a.limitGroupId === null) {
        total = Math.max(a.balance - outstanding, posted);
        estimated = total !== posted;
      } else total = posted;
    }
    return {
      id: a.id,
      institution: a.institution,
      name: a.name,
      last4: a.last4,
      balance: a.balance,
      creditLimit: a.creditLimit,
      availableLimit: a.availableLimit,
      limitGroupId: a.limitGroupId,
      asOf: a.balanceAsOf,
      cycle,
      total,
      posted,
      estimated,
      outstanding,
      nextDueDate: nextDueOf(a.id) ?? a.dueDate,
      minimumPayment: a.minimumPayment,
    };
  });

  const byId = new Map(cardAccounts.map((a) => [a.id, a]));
  const limitGroups = groups.map((g) => {
    const first = byId.get(g.memberIds[0] ?? '');
    const available = first?.availableLimit ?? g.creditLimit - (first?.balance ?? 0);
    const members = g.memberIds.reduce((s, id) => s + outstandingOf(id), 0);
    return { id: g.id, institution: g.institution, creditLimit: g.creditLimit, used: g.creditLimit - available, available, cardIds: g.memberIds, openEstimate: Math.max((first?.balance ?? 0) - members, 0) };
  });

  // A shared limit reports one balance for all its cards, so in the open cycle the group counts once.
  let cycleTotal = 0;
  const countedGroups = new Set<string>();
  for (const row of rows) {
    const gid = groupOf.get(row.id);
    if (gid !== undefined && row.cycle !== null && row.cycle.billTotal === null) {
      if (countedGroups.has(gid)) continue;
      countedGroups.add(gid);
      cycleTotal += limitGroups.find((g) => g.id === gid)?.openEstimate ?? 0;
    } else cycleTotal += row.total;
  }
  const summary = summarizeAccounts(accounts);
  const dues = rows.map((r) => r.nextDueDate).filter((d): d is string => d !== null).sort();
  const months = new Set<string>();
  for (const list of allCycles.values()) for (const c of list) if (c.status !== 'open') months.add(c.key);

  return {
    ...stamp(cardAccounts, now),
    cycle: cycleChoice,
    cycles: [...months].sort().reverse(),
    totals: {
      cycleTotal,
      outstanding: rows.reduce((s, r) => s + r.outstanding, 0),
      reportedByIssuer: summary.cardOwed,
      creditLimit: summary.creditLimit,
      used: summary.creditUsed,
      available: summary.creditAvailable,
      nextDueDate: dues[0] ?? null,
    },
    cards: rows,
    limitGroups,
  };
}

// ---------- cash flow ----------

export interface CashFlowView extends Stamped, DateRange {
  inflow: Cents;
  outflow: Cents;
  net: Cents;
  days: Array<{ day: string; inflow: Cents; outflow: Cents }>;
}

/** Money that enters and leaves bank accounts. Card purchases count when the bill is paid; moves between own accounts are left out. */
export function cashFlow(store: Store, range: DateRange, now: Date, opts: ViewOptions = {}): CashFlowView {
  const accounts = visibleAccounts(store, opts);
  const bankIds = new Set(accounts.filter(isBank).map((a) => a.id));
  const perDay = new Map<string, { inflow: Cents; outflow: Cents }>();
  for (const t of liveTransactions(store, range, opts)) {
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
  /** Spending per day (net of refunds), oldest first, for a running-total chart. */
  daily: Array<{ day: string; amount: Cents }>;
}

/** What was spent, dated by purchase (accrual): card purchases on the purchase day, bank outflows on their day. Refunds subtract. */
export function spending(store: Store, range: DateRange, groupBy: SpendingGroup, now: Date, opts: ViewOptions = {}): SpendingView {
  const accounts = visibleAccounts(store, opts);
  const bankIds = new Set(accounts.filter(isBank).map((a) => a.id));
  const rows = new Map<string, { amount: Cents; count: number }>();
  const perDay = new Map<string, Cents>();
  for (const t of liveTransactions(store, range, opts)) {
    if (isNonSpending(t.category)) continue;
    // Money coming into a bank account is income. Only card credits (refunds) reduce spending.
    if (t.amount > 0 && bankIds.has(t.accountId)) continue;
    const day = localDay(t.occurredAt);
    perDay.set(day, (perDay.get(day) ?? 0) - t.amount);
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
  return { ...stamp(accounts, now), ...range, total, groupBy, groups: groups.map((g) => ({ ...g, share: total > 0 ? g.amount / total : 0 })),
    daily: [...perDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, amount]) => ({ day, amount })) };
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

export function installments(store: Store, now: Date, opts: ViewOptions = {}): InstallmentsView {
  const accounts = visibleAccounts(store, opts);
  const latest = new Map<string, CanonicalTransaction>();
  for (const t of effectiveTransactions(store, opts, accounts)) {
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
