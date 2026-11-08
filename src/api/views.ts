import type { CanonicalAccount } from '../core/canonical.ts';
import { formatBRL, type Cents } from '../core/money.ts';
import { institutionKey } from '../core/names.ts';
import { categoryParents } from './category-groups.ts';
import { merchantOf } from '../core/merchant.ts';
import { addDays } from '../core/dates.ts';
import { DATA_START, localDay } from '../core/time.ts';
import { summarizeAccounts } from '../reconcile/accounts.ts';
import { addMonthsToDay, cyclesFor, type Cycle } from './cycles.ts';
import { estimatedTransactions, installments } from './installments.ts';
import { quotaReport } from '../scheduler/quota.ts';
import type { Store } from '../store/store.ts';
import { readAlerts } from '../http/pluggy-hook.ts';
import { stamp, type Stamped } from './stamp.ts';
import { effectiveTransactions, visibleAccounts, visibleLimitGroups, type EffectiveTransaction, type ViewOptions } from './scope.ts';

const isBank = (a: CanonicalAccount) => a.kind !== 'credit_card';

/** Card payments, moves between own accounts and investments are not spending. See roles.ts. */
export const isNonSpending = (t: { role: string | null }): boolean => t.role !== null;

const isOwnTransfer = (t: { role: string | null }): boolean => t.role === 'own_transfer';

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

/**
 * The one date window of the analysis views (spending, cash flow, trends, budgets, calendar) and of the explorer: nothing
 * before DATA_START, because older records only exist for installments and bills. The ceiling is the range's own `to`, so
 * a caller that means "so far" passes today (see `untilToday`) and a caller that looks ahead on purpose passes a later day.
 */
export function inWindow(day: string, range: DateRange): boolean {
  return day >= DATA_START && day >= range.from && day <= range.to;
}

/** A range cut at today, for views that must not count purchases dated in the future (planned installments). */
export function untilToday(range: DateRange, now: Date): DateRange {
  const today = localDay(now.toISOString());
  return { from: range.from, to: range.to < today ? range.to : today };
}

function liveTransactions(store: Store, range: DateRange, opts: ViewOptions): EffectiveTransaction[] {
  return effectiveTransactions(store, opts).filter((t) => !t.excluded && inWindow(localDay(t.occurredAt), range));
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
  /** Installments of earlier purchases that belong to the open bill and that the bank has not listed as charges yet (in `total`, not in `posted`). */
  plannedInstallments: Cents;
  /** True when `total` is worked out from the issuer's balance (the balance minus installments that belong to later bills). */
  estimated: boolean;
  /** Installments of purchases already made that will be charged in bills after the open cycle. The issuer counts them in its balance. */
  futureInstallments: Cents;
  /** Closed bills still unpaid, whatever cycle is chosen. */
  outstanding: Cents;
  /** What is still unpaid on the chosen view: the open bill (not paid yet by definition) plus the closed bills that were not paid. Zero for a card that owes nothing. */
  toPay: Cents;
  /** Due date to pay next: the oldest unpaid bill, else the open cycle. */
  nextDueDate: string | null;
  minimumPayment: Cents | null;
}

export interface CardsView extends Stamped {
  /** `open` is each card's current open cycle; otherwise a due month (YYYY-MM). */
  cycle: string;
  /** Due months that exist for at least one card, newest first. */
  cycles: string[];
  totals: { cycleTotal: Cents; /** The same total split by due month: cards close on different days, so one view holds bills of more than one month. */ byMonth: Record<string, { total: Cents; cards: number }>; /** Part of cycleTotal the issuer's balance implies but no listed charge explains (shared limits only). */ unexplained: Cents; outstanding: Cents; /** Everything not yet paid in the chosen view: open bills plus closed bills still unpaid. */ toPay: Cents; futureInstallments: Cents; reportedByIssuer: Cents; creditLimit: Cents; used: Cents; available: Cents; nextDueDate: string | null };
  cards: CardRow[];
  /** Cards that share one limit appear here once, so the limit is not counted twice. */
  limitGroups: Array<{ id: string; institution: string; creditLimit: Cents; used: Cents; available: Cents; cardIds: string[]; openEstimate: Cents; unexplained: Cents }>;
}

export function cards(store: Store, now: Date, opts: ViewOptions = {}, cycleChoice = 'open'): CardsView {
  const accounts = visibleAccounts(store, opts);
  const cardAccounts = accounts.filter((a) => a.kind === 'credit_card');
  const today = localDay(now.toISOString());
  const transactions = effectiveTransactions(store, opts, accounts);
  const allCycles = new Map(cardAccounts.map((a) => [a.id, cyclesFor(store, a, transactions, today)]));
  const groups = visibleLimitGroups(store, accounts);
  const groupOf = new Map(cardAccounts.filter((a) => a.limitGroupId !== null).map((a) => [a.id, a.limitGroupId as string]));

  // The issuer's balance is what the card owes in total, including installments that belong to bills not issued yet.
  const plan = installments(store, now, opts);
  // Installments of earlier purchases that belong to the open bill but that the bank has not listed as charges yet: the card
  // issuer bills them, and the plan knows them by counting months from the installments it did see.
  // Any bill, closed or open: an installment of this bill that the bank has not listed as a charge but will bill.
  const plannedOf = (id: string, key: string) => plan.purchases.filter((p) => p.accountId === id).reduce((s, p) => s + p.slots.filter((x) => x.cycle === key && x.inferred && x.status !== 'future').length * p.amount, 0);
  const futureOf = (id: string) => plan.purchases.filter((p) => p.accountId === id).reduce((s, p) => s + p.slots.filter((x) => x.status === 'future').length * p.amount, 0);

  const outstandingOf = (id: string) => (allCycles.get(id) ?? []).reduce((s, c) => s + c.outstanding, 0);
  const nextDueOf = (id: string): string | null => {
    const list = allCycles.get(id) ?? [];
    const unpaid = list.filter((c) => c.outstanding > 0).sort((x, y) => x.dueDate.localeCompare(y.dueDate))[0];
    return unpaid?.dueDate ?? list.find((c) => c.status === 'open')?.dueDate ?? null;
  };

  const rows: CardRow[] = cardAccounts.map((a) => {
    const list = allCycles.get(a.id) ?? [];
    const cycle = (cycleChoice === 'open' ? list.find((c) => c.status === 'open') : list.find((c) => c.key === cycleChoice)) ?? null;
    // Looking at one bill shows that bill only: what is owed on it and when it is due, not the card's other bills.
    const outstanding = cycleChoice === 'open' ? outstandingOf(a.id) : (cycle?.outstanding ?? 0);
    const posted = cycle ? cycle.charges - cycle.credits : 0;
    const planned = cycle ? plannedOf(a.id, cycle.key) : 0;
    // A card that has no bill in the chosen month (for example it did not exist yet) contributes nothing. Only a card
    // with no bills at all falls back to the balance the issuer reports.
    let total = list.length === 0 ? a.balance : 0;
    let estimated = false;
    if (cycle) {
      if (cycle.billTotal !== null) total = cycle.billTotal;
      // A closed month the issuer published no bill for has no balance estimate: only the open cycle is priced from the balance.
      else if (cycle.status !== 'open') total = posted + planned;
      else if (a.limitGroupId === null) {
        // The balance covers every unpaid bill of the card, so the estimate takes all of them out, also when one month is chosen.
        total = Math.max(a.balance - outstandingOf(a.id) - futureOf(a.id), posted + planned);
        estimated = total !== posted + planned;
      } else total = posted + planned;
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
      plannedInstallments: planned,
      estimated,
      futureInstallments: cycleChoice === 'open' ? futureOf(a.id) : 0,
      outstanding,
      toPay: outstanding + (cycle?.status === 'open' ? total : 0),
      nextDueDate: cycleChoice === 'open' ? (nextDueOf(a.id) ?? a.dueDate) : (cycle?.dueDate ?? null),
      minimumPayment: a.minimumPayment,
    };
  });

  const byId = new Map(cardAccounts.map((a) => [a.id, a]));
  const limitGroups = groups.map((g) => {
    const first = byId.get(g.memberIds[0] ?? '');
    const available = first?.availableLimit ?? g.creditLimit - (first?.balance ?? 0);
    const members = g.memberIds.reduce((s, id) => s + outstandingOf(id) + futureOf(id), 0);
    // The open total of a shared limit is never less than what is already posted on its cards.
    const posted = g.memberIds.reduce((s, id) => s + (rows.find((r) => r.id === id)?.posted ?? 0) + (rows.find((r) => r.id === id)?.plannedInstallments ?? 0), 0);
    return { id: g.id, institution: g.institution, creditLimit: g.creditLimit, used: g.creditLimit - available, available, cardIds: g.memberIds, openEstimate: Math.max((first?.balance ?? 0) - members, posted, 0), unexplained: Math.max((first?.balance ?? 0) - members - posted, 0) };
  });

  // A shared limit reports one balance for all its cards, so in the open cycle the group counts once.
  let cycleTotal = 0;
  const byMonth: Record<string, { total: Cents; cards: number }> = {};
  const addMonth = (key: string, amount: Cents) => {
    const slot = (byMonth[key] ??= { total: 0, cards: 0 });
    slot.total += amount;
    slot.cards += 1;
  };
  let toPay = rows.reduce((s, r) => s + r.outstanding, 0);
  let unexplained = 0;
  const countedGroups = new Set<string>();
  for (const row of rows) {
    const gid = groupOf.get(row.id);
    if (gid !== undefined && row.cycle !== null && row.cycle.billTotal === null) {
      if (countedGroups.has(gid)) continue;
      countedGroups.add(gid);
      cycleTotal += limitGroups.find((g) => g.id === gid)?.openEstimate ?? 0;
      addMonth(row.cycle.key, limitGroups.find((g) => g.id === gid)?.openEstimate ?? 0);
      if (row.cycle.status === 'open') toPay += limitGroups.find((g) => g.id === gid)?.openEstimate ?? 0;
      unexplained += limitGroups.find((g) => g.id === gid)?.unexplained ?? 0;
    } else {
      cycleTotal += row.total;
      if (row.cycle?.status === 'open') toPay += row.total;
      if (row.cycle !== null) addMonth(row.cycle.key, row.total);
    }
  }
  const summary = summarizeAccounts(accounts);
  // The next due date is that of a card with something to pay: a card with nothing owed (an unused one) says nothing about it.
  // With nothing to pay anywhere, the cards that have a bill of this amount speak; an empty bill (a card never used) does not.
  const owing = rows.filter((r) => r.toPay > 0);
  const billed = rows.filter((r) => r.total > 0);
  const dues = (owing.length > 0 ? owing : billed.length > 0 ? billed : rows).map((r) => r.nextDueDate).filter((d): d is string => d !== null).sort();
  const months = new Set<string>();
  for (const list of allCycles.values()) for (const c of list) if (c.status !== 'open') months.add(c.key);

  return {
    ...stamp(cardAccounts, now),
    cycle: cycleChoice,
    cycles: [...months].sort().reverse(),
    totals: {
      cycleTotal,
      byMonth,
      unexplained,
      toPay,
      outstanding: rows.reduce((s, r) => s + r.outstanding, 0),
      futureInstallments: rows.reduce((s, r) => s + r.futureInstallments, 0),
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

// ---------- card bills over time ----------

/** One due month for all the visible cards: the bills that are out, plus the running total of the cards that have not closed it yet. */
export interface BillBar {
  /** Cycle to select on the cards screen: a due month (YYYY-MM). */
  key: string;
  /** At least one card has not closed this month yet, so the total is still growing. */
  open: boolean;
  /** The earliest month still open: what "Em aberto (atual)" on the cards screen starts from. */
  current: boolean;
  total: Cents;
  paid: Cents;
  outstanding: Cents;
  /** Cards that still add to this month, and cards that have it as a published bill. */
  openCards: number;
  closedCards: number;
  status: 'open' | 'paid' | 'partial' | 'unpaid' | 'overdue' | 'unknown';
}

export interface BillsView extends Stamped {
  bars: BillBar[];
}

/**
 * One bar per due month with all visible cards added. Cards close on different days, so a month can hold bills that are
 * out and cards still adding to theirs; the bar shows both and says how many of each.
 */
export function cardBills(store: Store, now: Date, opts: ViewOptions = {}, months = 12): BillsView {
  const accounts = visibleAccounts(store, opts);
  const cardAccounts = accounts.filter((a) => a.kind === 'credit_card');
  const transactions = effectiveTransactions(store, opts, accounts);
  const today = localDay(now.toISOString());
  const byKey = new Map<string, BillBar>();
  const barOf = (key: string): BillBar => {
    const bar = byKey.get(key) ?? { key, open: false, current: false, total: 0, paid: 0, outstanding: 0, openCards: 0, closedCards: 0, status: 'paid' as BillBar['status'] };
    byKey.set(key, bar);
    return bar;
  };
  for (const account of cardAccounts) {
    for (const c of cyclesFor(store, account, transactions, today)) {
      if (c.status === 'open' || c.billTotal === null) continue;
      const bar = barOf(c.key);
      bar.total += c.billTotal;
      bar.paid += c.paid;
      bar.outstanding += c.outstanding;
      bar.closedCards += 1;
      if (c.status === 'overdue') bar.status = 'overdue';
      else if (c.outstanding > 0 && bar.status !== 'overdue') bar.status = c.paid > 0 ? 'partial' : 'unpaid';
      // A bill whose payment cannot be checked is still a bill: it counts in the total and only dims the colour.
      else if (c.status === 'unknown' && bar.status === 'paid') bar.status = 'unknown';
    }
  }
  const open = cards(store, now, opts, 'open');
  for (const [key, part] of Object.entries(open.totals.byMonth)) {
    const bar = barOf(key);
    bar.total += part.total;
    bar.openCards += part.cards;
    bar.open = true;
    if (bar.status !== 'overdue') bar.status = 'open';
  }
  const bars = [...byKey.values()].filter((b) => b.total > 0).sort((a, b) => a.key.localeCompare(b.key)).slice(-months);
  const current = bars.find((b) => b.open);
  if (current) current.current = true;
  return { ...stamp(cardAccounts, now), bars };
}

// ---------- cash flow ----------

export interface CashFlowView extends Stamped, DateRange {
  inflow: Cents;
  outflow: Cents;
  net: Cents;
  /** Net money put into investments in the period (applications minus redemptions); negative when more was redeemed. Not in `inflow`, `outflow` or `net`. */
  invested: Cents;
  days: Array<{ day: string; inflow: Cents; outflow: Cents }>;
}

/**
 * Money that enters and leaves bank accounts. Card purchases count when the bill is paid, so card payments stay in.
 * Moves between own accounts are left out, and so are investments: putting money away or taking it back is not spending
 * or income, and it is reported apart in `invested`.
 */
export function cashFlow(store: Store, range: DateRange, now: Date, opts: ViewOptions = {}): CashFlowView {
  const accounts = visibleAccounts(store, opts);
  const bankIds = new Set(accounts.filter(isBank).map((a) => a.id));
  const perDay = new Map<string, { inflow: Cents; outflow: Cents }>();
  let invested = 0;
  for (const t of liveTransactions(store, range, opts)) {
    if (!bankIds.has(t.accountId) || isOwnTransfer(t)) continue;
    if (t.role === 'investment') {
      invested -= t.amount;
      continue;
    }
    const day = localDay(t.occurredAt);
    const row = perDay.get(day) ?? { inflow: 0, outflow: 0 };
    if (t.amount >= 0) row.inflow += t.amount;
    else row.outflow += -t.amount;
    perDay.set(day, row);
  }
  const days = [...perDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, ...v }));
  const inflow = days.reduce((s, d) => s + d.inflow, 0);
  const outflow = days.reduce((s, d) => s + d.outflow, 0);
  return { ...stamp(accounts.filter(isBank), now), ...range, inflow, outflow, net: inflow - outflow, invested, days };
}

// ---------- spending ----------

export type SpendingGroup = 'category' | 'merchant';

export interface SpendingView extends Stamped, DateRange {
  total: Cents;
  /** Refunds in groups that have no spending of their own, already taken out of `total`. The shares are over the listed groups. */
  creditsNotListed: Cents;
  groupBy: SpendingGroup;
  groups: Array<{ name: string; amount: Cents; count: number; share: number; /** The group a category sits in; always null when grouping by merchant. */ parent: string | null }>;
  /** Spending per day (net of refunds), oldest first, for a running-total chart. */
  daily: Array<{ day: string; amount: Cents }>;
}

/** The transactions the spending view counts: no card payments or own moves, and no bank money in except a refund paired with its purchase. */
export function spendingTransactions(store: Store, range: DateRange, now: Date, opts: ViewOptions = {}): EffectiveTransaction[] {
  const bankIds = new Set(visibleAccounts(store, opts).filter(isBank).map((a) => a.id));
  const all = effectiveTransactions(store, opts);
  // The installments the bank bills but never listed count as spending too (the bill totals add them from the plan, so they are not in `all`).
  // The ones of bills that have not come (pending) are a plan: like the planned installments, they are left to the list's future option.
  const counted = [...all, ...estimatedTransactions(store, now, opts, all).filter((t) => t.status !== 'pending')];
  return counted.filter((t) => !t.excluded && inWindow(localDay(t.occurredAt), range)).filter((t) => {
    if (isNonSpending(t)) return false;
    // Money coming into a bank account is income. Only card credits (refunds) reduce spending.
    // A refund paired with its purchase is not income: it returns what the purchase spent.
    return !(t.amount > 0 && bankIds.has(t.accountId) && !t.reversal);
  });
}

/** What was spent, dated by purchase (accrual): card purchases on the purchase day, bank outflows on their day. Refunds subtract. */
export function spending(store: Store, range: DateRange, groupBy: SpendingGroup, now: Date, opts: ViewOptions = {}): SpendingView {
  const accounts = visibleAccounts(store, opts);
  const parents = categoryParents(store);
  const rows = new Map<string, { amount: Cents; count: number }>();
  const perDay = new Map<string, Cents>();
  for (const t of spendingTransactions(store, range, now, opts)) {
    const day = localDay(t.occurredAt);
    perDay.set(day, (perDay.get(day) ?? 0) - t.amount);
    const name = groupBy === 'category' ? (t.category ?? 'Sem categoria') : merchantOf(t);
    const row = rows.get(name) ?? { amount: 0, count: 0 };
    row.amount += -t.amount;
    row.count += 1;
    rows.set(name, row);
  }
  const groups = [...rows]
    .map(([name, v]) => ({ name, ...v }))
    .filter((g) => g.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  // The total is the net of every day, the same number the month bars add up. Groups that only hold refunds are not listed, so their credit is shown apart.
  const total = [...perDay.values()].reduce((s, v) => s + v, 0);
  const listed = groups.reduce((s, g) => s + g.amount, 0);
  return { ...stamp(accounts, now), ...range, total, creditsNotListed: listed - total, groupBy, groups: groups.map((g) => ({ ...g, share: listed > 0 ? g.amount / listed : 0, parent: groupBy === 'category' ? (parents.get(g.name) ?? null) : null })),
    daily: [...perDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, amount]) => ({ day, amount })) };
}

// ---------- freshness and findings ----------

/** Things that cannot be true of real finances, so they point at a problem in the data or in the rules, not at the user. */
export interface HealthIssue {
  id: string;
  message: string;
}

export function dataHealth(store: Store, now: Date): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const view = cards(store, now);
  for (const row of view.cards) {
    if (row.total < 0 || row.posted < -100) issues.push({ id: `negative-${row.id}`, message: `O ciclo em aberto do cartão ${row.institution}${row.last4 ? ` ${row.last4}` : ''} deu negativo. Provavelmente há créditos (pagamentos, estornos) lidos como compras ou o contrário.` });
    if (row.creditLimit !== null && row.outstanding > row.creditLimit) issues.push({ id: `owed-${row.id}`, message: `As faturas em aberto do cartão ${row.institution}${row.last4 ? ` ${row.last4}` : ''} somam mais que o limite dele. Confira se os pagamentos estão sendo reconhecidos.` });
  }
  // Payments beyond a bill: a bill paid twice, or a late payment of an older bill counted in this window. Shown, never moved.
  const today = localDay(now.toISOString());
  const visible = visibleAccounts(store);
  const transactions = effectiveTransactions(store, {}, visible);
  for (const account of visible.filter((a) => a.kind === 'credit_card')) {
    for (const c of cyclesFor(store, account, transactions, today)) {
      if (c.overpaid <= 0 || c.dueDate < addDays(today, -OVERPAID_LOOKBACK_DAYS)) continue;
      issues.push({ id: `overpaid-${account.id}-${c.key}`, message: `Os pagamentos do cartão ${account.institution}${account.last4 ? ` ${account.last4}` : ''} somam ${formatBRL(c.overpaid)} a mais que a fatura com vencimento em ${c.dueDate.split('-').reverse().join('/')}. Pode ser pagamento em dobro, ou pagamento de uma fatura anterior feito depois do fechamento desta.` });
    }
  }
  if (view.totals.outstanding > view.totals.creditLimit && view.totals.creditLimit > 0) issues.push({ id: 'owed-total', message: 'O total de faturas fechadas e não pagas passa do limite somado dos cartões. Isso indica pagamentos não reconhecidos.' });
  issues.push(...debtAboveIssuerBalance(view));
  issues.push(...silentAccounts(store, now));
  // A source that has not been read for far longer than its daily rhythm means the sync is stuck, not that nothing happened.
  for (const f of store.listFreshness()) {
    if (f.consentExpiresAt && Date.parse(f.consentExpiresAt) < now.getTime()) continue;
    if (!isLate(f.lastUpdatedAt, now)) continue;
    const days = Math.floor((now.getTime() - Date.parse(f.lastUpdatedAt)) / 86_400_000);
    issues.push({ id: `stale-${f.sourceId}`, message: `Os dados de ${f.institution} não são atualizados há ${days < 1 ? 'mais de 3 dias' : `${days} dia${days === 1 ? '' : 's'}`}, mais do que o esperado para uma leitura por dia. Abra o Meu Pluggy e confira se a conexão está ativa.` });
  }
  // A consent that ends makes the provider return empty reads without an error, so the owner is told ahead of time.
  for (const f of store.listFreshness()) {
    if (!f.consentExpiresAt) continue;
    const days = Math.floor((Date.parse(f.consentExpiresAt) - now.getTime()) / 86_400_000);
    if (days > CONSENT_WARNING_DAYS) continue;
    issues.push({ id: `consent-${f.institution}`, message: days < 0 ? `O consentimento de ${f.institution} venceu. Os dados dele deixaram de ser lidos até você renovar no Meu Pluggy.` : `O consentimento de ${f.institution} vence em ${days === 0 ? 'menos de 1 dia' : `${days} dia${days === 1 ? '' : 's'}`}. Renove no Meu Pluggy antes disso, senão os dados dele deixam de chegar.` });
  }
  return issues;
}

/** Money can be off by a few cents or a rounding on the issuer's side; below this the two figures count as equal. */
const DEBT_TOLERANCE_CENTS = 1000;
const DEBT_TOLERANCE_SHARE = 0.02;

/**
 * The issuer's balance holds everything a card owes: open bill, closed bills not paid and installments still to come. So what
 * the app adds up for a card (or for a group that shares one limit, which reports a single balance) cannot be more than that
 * balance. When it is, a payment was probably not recognized, was made twice, or a bill was published wrong.
 */
function debtAboveIssuerBalance(view: CardsView): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const nameOf = (row: CardRow) => `${row.institution}${row.last4 ? ` ${row.last4}` : ''}`;
  const check = (id: string, label: string, appOwes: Cents, issuerOwes: Cents) => {
    if (appOwes <= issuerOwes + Math.max(DEBT_TOLERANCE_CENTS, issuerOwes * DEBT_TOLERANCE_SHARE)) return false;
    issues.push({ id, message: `O app soma ${formatBRL(appOwes)} de dívida ${label}, mas o banco informa que você deve ${formatBRL(issuerOwes)}. Confira se há fatura paga que não foi reconhecida, pagamento em dobro ou fatura publicada com valor errado.` });
    return true;
  };
  const grouped = new Set(view.limitGroups.flatMap((g) => g.cardIds));
  const openPart = (row: CardRow) => (row.cycle?.status === 'open' ? row.posted + row.plannedInstallments : 0);
  let any = false;
  for (const row of view.cards) {
    if (grouped.has(row.id) || row.cycle === null) continue;
    any = check(`debt-${row.id}`, `no cartão ${nameOf(row)}`, row.outstanding + row.futureInstallments + openPart(row), row.balance) || any;
  }
  for (const g of view.limitGroups) {
    const members = view.cards.filter((r) => g.cardIds.includes(r.id));
    const first = members[0];
    if (!first || members.some((r) => r.cycle === null)) continue;
    const appOwes = members.reduce((s, r) => s + r.outstanding + r.futureInstallments + openPart(r), 0);
    any = check(`debt-group-${g.id}`, `nos cartões de ${g.institution} que dividem o mesmo limite`, appOwes, first.balance) || any;
  }
  // The same comparison for the whole app, shown on its own only when no single card already explains it.
  if (!any) check('debt-total', 'em faturas fechadas e não pagas', view.totals.outstanding, view.totals.reportedByIssuer);
  return issues;
}

/** A card or account that gets no new transactions for a month while another account of the same bank does. */
const SILENT_DAYS = 35;
const SIBLING_ACTIVE_DAYS = 7;
const CARD_BILL_LOOKBACK_DAYS = 90;
/**
 * A bank account has a pace when it had transactions in at least 3 of the 4 months before it went quiet; a card, when it had
 * purchases in at least 2 of the 3. A savings account used now and then, or a card kept for rare use, has no pace to fall behind.
 */
const ACCOUNT_PACE = { months: 4, needed: 3 };
const CARD_PACE = { months: 3, needed: 2 };

function silentAccounts(store: Store, now: Date): HealthIssue[] {
  const today = localDay(now.toISOString());
  const accounts = visibleAccounts(store, {});
  const transactions = effectiveTransactions(store, {}, accounts).filter((t) => !t.excluded);
  const silentSince = addDays(today, -SILENT_DAYS);
  const lastOf = new Map<string, { day: string }>();
  // Months with a transaction (and with a purchase, for cards) in the stretch before the account went quiet.
  const activeMonths = new Map<string, { any: Set<string>; purchases: Set<string> }>();
  const paceFrom = addMonthsToDay(silentSince, 1 - Math.max(ACCOUNT_PACE.months, CARD_PACE.months)).slice(0, 7);
  for (const t of transactions) {
    const day = localDay(t.occurredAt);
    if (day > today) continue;
    const prev = lastOf.get(t.accountId);
    lastOf.set(t.accountId, { day: prev && prev.day > day ? prev.day : day });
    if (day.slice(0, 7) < paceFrom) continue;
    const months = activeMonths.get(t.accountId) ?? { any: new Set<string>(), purchases: new Set<string>() };
    months.any.add(day.slice(0, 7));
    if (t.amount < 0) months.purchases.add(day.slice(0, 7));
    activeMonths.set(t.accountId, months);
  }
  // The `count` calendar months that end with the month the quiet stretch began.
  const monthsWithin = (set: Set<string> | undefined, count: number) => {
    const from = addMonthsToDay(silentSince, 1 - count).slice(0, 7);
    return [...(set ?? [])].filter((m) => m >= from).length;
  };
  const siblingSince = addDays(today, -SIBLING_ACTIVE_DAYS);
  const billsSince = addDays(today, -CARD_BILL_LOOKBACK_DAYS);
  const issues: HealthIssue[] = [];
  for (const a of accounts) {
    if (a.kind !== 'credit_card' && a.kind !== 'checking') continue;
    const mine = lastOf.get(a.id);
    if (mine && mine.day >= silentSince) continue;
    const months = activeMonths.get(a.id);
    const hasPace = a.kind === 'credit_card'
      ? monthsWithin(months?.purchases, CARD_PACE.months) >= CARD_PACE.needed && cyclesFor(store, a, transactions, today).some((c) => c.billTotal !== null && c.billTotal > 0 && c.dueDate >= billsSince)
      : monthsWithin(months?.any, ACCOUNT_PACE.months) >= ACCOUNT_PACE.needed;
    if (!hasPace) continue;
    const key = institutionKey(a.institution);
    const siblingActive = accounts.some((o) => o.id !== a.id && institutionKey(o.institution) === key && (lastOf.get(o.id)?.day ?? '') >= siblingSince);
    if (!siblingActive) continue;
    const name = `${a.kind === 'credit_card' ? 'O cartão' : 'A conta'} ${a.institution}${a.last4 ? ` ${a.last4}` : ` ${a.name}`}`;
    issues.push({ id: `silent-${a.id}`, message: `${name} não recebe transações novas ${mine ? `desde ${mine.day.split('-').reverse().join('/')}` : `há mais de ${SILENT_DAYS} dias`}, enquanto outras contas do mesmo banco recebem. Confira no Meu Pluggy se esse item ainda está conectado.` });
  }
  return issues;
}

/**
 * Hours between two reads that a source is expected to keep: Meu Pluggy reads each bank once a day (around 14:30 UTC),
 * and the read shown can be a day and a half old before the next one. Used when there is no better history.
 */
export const EXPECTED_READ_HOURS = 36;
/** Extra hours granted on top of two expected intervals before a source counts as late. */
const LATE_GRACE_HOURS = 6;

/** A source is late when it is older than two expected intervals plus a grace, not merely older than a few hours. */
export function isLate(lastUpdatedAt: string, now: Date, expectedHours = EXPECTED_READ_HOURS): boolean {
  return (now.getTime() - Date.parse(lastUpdatedAt)) / 3_600_000 > 2 * expectedHours + LATE_GRACE_HOURS;
}
/** Overpaid bills older than this are history, not a warning. */
const OVERPAID_LOOKBACK_DAYS = 240;

/** How long before a consent ends the owner is warned. */
const CONSENT_WARNING_DAYS = 30;

export interface FreshnessView {
  generatedAt: string;
  health: HealthIssue[];
  sources: Array<{ sourceId: string; institution: string; lastUpdatedAt: string; observedAt: string; quotaExhausted: boolean; consentExpiresAt: string | null; nextSyncAt: string | null; /** Hours between reads the source is expected to keep. */ expectedEveryHours: number; /** The last read is older than the expected rhythm allows: the sync is stuck, not just a day old. */ late: boolean; /** The page of this connection at Meu Pluggy, where the owner can update it. */ link: string }>;
  /** Connections the provider said need the owner (login expired, consent to renew). */
  connectionAlerts: Array<{ institution: string; event: string; code: string | null; message: string | null; at: string }>;
  quota: ReturnType<typeof quotaReport>;
}

export const MEU_PLUGGY_CONNECTIONS = 'https://meu.pluggy.ai/connections';
export const MEU_PLUGGY_LINKS_KEY = 'meupluggy_links';

/** The owner's page for each connection at Meu Pluggy, by institution. Only pages of meu.pluggy.ai are kept. */
export function meuPluggyLinks(store: Store): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(store.getSetting(MEU_PLUGGY_LINKS_KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].startsWith('https://meu.pluggy.ai/')));
  } catch {
    return {};
  }
}

export function freshness(store: Store, now: Date): FreshnessView {
  return {
    generatedAt: now.toISOString(),
    health: dataHealth(store, now),
    sources: store.listFreshness().map((f) => ({ sourceId: f.sourceId, institution: f.institution, lastUpdatedAt: f.lastUpdatedAt, observedAt: f.observedAt, quotaExhausted: f.quotaExhausted === true, consentExpiresAt: f.consentExpiresAt ?? null, nextSyncAt: f.nextSyncAt ?? null, expectedEveryHours: EXPECTED_READ_HOURS, late: isLate(f.lastUpdatedAt, now), link: meuPluggyLinks(store)[f.institution] ?? MEU_PLUGGY_CONNECTIONS })),
    connectionAlerts: Object.values(readAlerts(store)).sort((a, b) => a.institution.localeCompare(b.institution)),
    quota: quotaReport(store, now),
  };
}

export function findings(store: Store, includeResolved: boolean) {
  return store.listFindings({ includeResolved });
}
