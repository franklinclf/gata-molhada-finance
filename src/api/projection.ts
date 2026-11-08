import type { CanonicalAccount } from '../core/canonical.ts';
import { addMonths } from '../core/dates.ts';
import type { Cents } from '../core/money.ts';
import type { Store } from '../store/store.ts';
import { cyclesFor } from './cycles.ts';
import { dayInMonth, isExpected, type RecurringItem } from './recurring.ts';
import type { EffectiveTransaction } from './scope.ts';

/** The open bill of cards that share a limit: one bill for the group, named by the cards and dated by the earliest due date. */
export interface GroupBill {
  label: string;
  /** The earliest due date among the open bills of the members: the most careful date to plan around. */
  dueDate: string;
  /** Closing day of the member bill with that due date. */
  closing: string;
}

export function groupBill(store: Store, group: { institution: string; cardIds: string[] }, cardAccounts: CanonicalAccount[], transactions: EffectiveTransaction[], today: string): GroupBill | null {
  const members = cardAccounts.filter((a) => group.cardIds.includes(a.id));
  let first: { dueDate: string; closing: string } | null = null;
  for (const member of members) {
    const open = cyclesFor(store, member, transactions, today).find((c) => c.status === 'open');
    if (open && (first === null || open.dueDate < first.dueDate)) first = { dueDate: open.dueDate, closing: open.to };
  }
  if (first === null) return null;
  const ends = members.map((a) => a.last4 ?? a.name).join(' + ');
  return { ...first, label: `Fatura ${group.institution}, limite compartilhado ${ends}` };
}

/** Dates of a monthly item inside [from, until], starting from its next expected day. */
export function monthlyDays(next: string, dayOfMonth: number, from: string, until: string): string[] {
  const days: string[] = [];
  let month = next.slice(0, 7);
  let day = next;
  while (day <= until) {
    if (day >= from) days.push(day);
    month = addMonths(month, 1);
    day = dayInMonth(month, dayOfMonth);
  }
  return days;
}

export interface IncomeEvent {
  day: string;
  name: string;
  amount: Cents;
  origin: string;
  estimate: boolean;
}

/**
 * Money expected to arrive from `today` until `until`, the same for the outlook and the calendar: the income the owner
 * registered (paid after today), else the credits that come back every month in the bank accounts (today included, since
 * they have not shown up yet). A late credit is not counted.
 */
export function incomeEvents(store: Store, recurring: RecurringItem[], today: string, until: string): { source: 'registered' | 'recurring' | 'none'; events: IncomeEvent[] } {
  const events: IncomeEvent[] = [];
  const registered = store.listIncome();
  const credits = recurring.filter((r) => r.direction === 'in' && r.account === 'bank' && isExpected(r));
  const source: 'registered' | 'recurring' | 'none' = registered.length > 0 ? 'registered' : credits.length > 0 ? 'recurring' : 'none';
  if (source === 'registered') {
    for (let m = today.slice(0, 7); m <= until.slice(0, 7); m = addMonths(m, 1)) {
      for (const item of registered) {
        if ((item.fromMonth !== null && item.fromMonth > m) || (item.untilMonth !== null && item.untilMonth < m)) continue;
        const day = dayInMonth(m, item.dayOfMonth);
        if (day > today && day <= until) events.push({ day, name: item.name, amount: item.amount, origin: 'renda cadastrada', estimate: false });
      }
    }
  } else if (source === 'recurring') {
    for (const r of credits) {
      if (r.late) continue;
      for (const day of monthlyDays(r.nextDay, r.dayOfMonth, today, until)) events.push({ day, name: r.name, amount: r.amount, origin: `entrada que se repete todo mês, dia ${r.dayOfMonth}`, estimate: r.kind === 'variable' });
    }
  }
  return { source, events };
}
