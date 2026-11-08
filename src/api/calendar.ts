import { addDays, lastDayOf } from '../core/dates.ts';
import { localDay } from '../core/time.ts';
import type { Store } from '../store/store.ts';
import { cyclesFor } from './cycles.ts';
import { groupBill, incomeEvents, monthlyDays } from './projection.ts';
import { detectRecurring, isExpected, type RecurringItem } from './recurring.ts';
import { effectiveTransactions, visibleAccounts, type ViewOptions } from './scope.ts';
import { cards, cashFlow } from './views.ts';

export interface ProjectedItem {
  name: string;
  /** Positive amount in cents. */
  amount: number;
  direction: 'in' | 'out';
  kind: 'recurring' | 'bill';
  /** The item was due before today and has not shown up. */
  late: boolean;
}

export interface CalendarDay {
  day: string;
  /** What really went through the bank accounts that day. */
  inflow: number;
  outflow: number;
  projected: ProjectedItem[];
  /** Bank balance at the end of the day: a projection from today on, null before today. */
  balance: number | null;
}

export interface CalendarView {
  month: string;
  today: string;
  bankBalance: number;
  days: CalendarDay[];
  recurring: RecurringItem[];
}


const MAX_AHEAD_DAYS = 100;

/** Everything expected to happen from tomorrow on, by day: recurring items paid from the bank, and the card bills. */
function projectedByDay(store: Store, recurring: RecurringItem[], now: Date, opts: ViewOptions, until: string): Map<string, ProjectedItem[]> {
  const today = localDay(now.toISOString());
  const out = new Map<string, ProjectedItem[]>();
  const add = (day: string, item: ProjectedItem) => {
    // Something already late is expected today: it can still arrive.
    const at = day < today ? today : day;
    if (at > until) return;
    out.set(at, [...(out.get(at) ?? []), item]);
  };
  // Money out of the bank: recurring payments. One that is late has not shown up and is still expected today, once; the next ones keep their days.
  for (const r of recurring) {
    if (r.account === 'card' || r.direction !== 'out' || !isExpected(r)) continue;
    if (r.nextDay < today) add(r.nextDay, { name: r.name, amount: r.amount, direction: 'out', kind: 'recurring', late: r.late });
    for (const day of monthlyDays(r.nextDay, r.dayOfMonth, today, until)) add(day, { name: r.name, amount: r.amount, direction: 'out', kind: 'recurring', late: false });
  }
  // Money in: the same rule as the outlook (the income the owner registered, else the credits that repeat every month).
  for (const e of incomeEvents(store, recurring, today, until).events) add(e.day, { name: e.name, amount: e.amount, direction: 'in', kind: 'recurring', late: false });
  const accounts = visibleAccounts(store, opts).filter((a) => a.kind === 'credit_card');
  const transactions = effectiveTransactions(store, opts);
  const view = cards(store, now, opts, 'open');
  const openTotal = new Map(view.cards.map((c) => [c.id, c.total]));
  // Cards on a shared limit have one open total, the same estimate the cards screen uses. It is one bill for the group, named by its cards and dated by the earliest due date.
  const shared = new Map<string, ReturnType<typeof groupBill>>();
  for (const g of view.limitGroups) {
    g.cardIds.forEach((id, i) => openTotal.set(id, i === 0 ? g.openEstimate : 0));
    shared.set(g.cardIds[0] ?? '', groupBill(store, g, accounts, transactions, today));
  }
  for (const account of accounts) {
    for (const cycle of cyclesFor(store, account, transactions, today)) {
      const label = `Fatura ${account.institution}${account.last4 ? ` ${account.last4}` : ''}`;
      if (cycle.status === 'open') {
        const total = openTotal.get(account.id) ?? 0;
        const group = shared.get(account.id);
        const dueDate = group?.dueDate ?? cycle.dueDate;
        // An open bill already past its due date is late like a closed one: `add` moves it to today.
        if (total > 0) add(dueDate, { name: group?.label ?? label, amount: total, direction: 'out', kind: 'bill', late: dueDate < today });
      } else if (cycle.outstanding > 0 && (cycle.status === 'unpaid' || cycle.status === 'overdue' || cycle.status === 'partial')) {
        add(cycle.dueDate, { name: label, amount: cycle.outstanding, direction: 'out', kind: 'bill', late: cycle.dueDate < today });
      }
    }
  }
  return out;
}

export function calendar(store: Store, month: string, now: Date, opts: ViewOptions = {}): CalendarView {
  const today = localDay(now.toISOString());
  const accounts = visibleAccounts(store, opts).filter((a) => a.kind !== 'credit_card');
  const bankBalance = accounts.reduce((s, a) => s + a.balance, 0);
  const monthStart = `${month}-01`;
  const monthEnd = lastDayOf(month);
  const recurring = detectRecurring(store, now, opts);
  const horizon = addDays(today, MAX_AHEAD_DAYS);
  const projected = projectedByDay(store, recurring, now, opts, monthEnd < horizon ? monthEnd : horizon);
  const actual = new Map(cashFlow(store, { from: monthStart, to: monthEnd < today ? monthEnd : today }, now, opts).days.map((d) => [d.day, d]));

  // The projected balance starts from today's balance and walks forward, through the days before the month if it is ahead.
  let balance = bankBalance;
  const balanceAt = new Map<string, number>();
  for (let day = today; day <= monthEnd && day <= horizon; day = addDays(day, 1)) {
    for (const item of projected.get(day) ?? []) balance += item.direction === 'in' ? item.amount : -item.amount;
    balanceAt.set(day, balance);
  }
  const days: CalendarDay[] = [];
  for (let day = monthStart; day <= monthEnd; day = addDays(day, 1)) {
    const real = actual.get(day);
    days.push({ day, inflow: real?.inflow ?? 0, outflow: real?.outflow ?? 0, projected: projected.get(day) ?? [], balance: balanceAt.get(day) ?? null });
  }
  return { month, today, bankBalance, days, recurring };
}
