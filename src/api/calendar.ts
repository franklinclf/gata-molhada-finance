import { localDay } from '../core/time.ts';
import type { Store } from '../store/store.ts';
import { cyclesFor } from './cycles.ts';
import { dayInMonth, detectRecurring, type RecurringItem } from './recurring.ts';
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

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const lastDayOf = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const nextMonth = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const t = y * 12 + m;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

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
  for (const r of recurring) {
    if (r.account === 'card') continue;
    let day = r.nextDay;
    let month = day.slice(0, 7);
    // An item whose day has passed without it showing up is still expected: it lands today once, and the next ones keep their days.
    if (day < today) {
      add(day, { name: r.name, amount: r.amount, direction: r.direction, kind: 'recurring', late: r.late });
      month = nextMonth(day.slice(0, 7));
      day = dayInMonth(month, r.dayOfMonth);
    }
    while (day <= until) {
      if (day >= today) add(day, { name: r.name, amount: r.amount, direction: r.direction, kind: 'recurring', late: false });
      month = nextMonth(month);
      day = dayInMonth(month, r.dayOfMonth);
    }
  }
  const accounts = visibleAccounts(store, opts).filter((a) => a.kind === 'credit_card');
  const transactions = effectiveTransactions(store, opts);
  const openTotal = new Map(cards(store, now, opts, 'open').cards.map((c) => [c.id, c.total]));
  for (const account of accounts) {
    for (const cycle of cyclesFor(store, account, transactions, today)) {
      const label = `Fatura ${account.institution}${account.last4 ? ` ${account.last4}` : ''}`;
      if (cycle.status === 'open') {
        const total = openTotal.get(account.id) ?? 0;
        if (total > 100 && cycle.dueDate >= today) add(cycle.dueDate, { name: label, amount: total, direction: 'out', kind: 'bill', late: false });
      } else if (cycle.outstanding > 100 && (cycle.status === 'unpaid' || cycle.status === 'overdue' || cycle.status === 'partial')) {
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
