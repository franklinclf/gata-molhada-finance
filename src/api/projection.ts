import type { CanonicalAccount } from '../core/canonical.ts';
import { moveToBusinessDay, nonBusinessReason, type NonBusinessRule } from '../core/business-days.ts';
import { addDays, addMonths } from '../core/dates.ts';
import type { Cents } from '../core/money.ts';
import { localDay } from '../core/time.ts';
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

/**
 * Dates of a monthly item inside [from, until], starting from its next expected day. With a rule for days that are not a
 * business day, each one is moved the way a bank would; `natural` is the day of the month before the move.
 */
export function scheduledDays(next: string, dayOfMonth: number, from: string, until: string, rule: NonBusinessRule = 'keep'): Array<{ day: string; natural: string }> {
  const days: Array<{ day: string; natural: string }> = [];
  // A moved day can fall in the month before the one it belongs to, so look from the month before `next`.
  let month = rule === 'keep' ? next.slice(0, 7) : addMonths(next.slice(0, 7), -1);
  for (;;) {
    const natural = dayInMonth(month, dayOfMonth);
    const day = moveToBusinessDay(natural, rule);
    if (day > until) break;
    if (day >= next && day >= from) days.push({ day, natural });
    month = addMonths(month, 1);
  }
  return days;
}

/** Dates of a monthly item inside [from, until], starting from its next expected day. */
export const monthlyDays = (next: string, dayOfMonth: number, from: string, until: string): string[] => scheduledDays(next, dayOfMonth, from, until).map((d) => d.day);

export interface IncomeEvent {
  day: string;
  name: string;
  amount: Cents;
  origin: string;
  estimate: boolean;
  /** The expected day was yesterday and nothing came yet: it can still be posted today. */
  late: boolean;
  /** Set when the payment day was moved off a weekend or holiday, such as "antecipado: dia 10 cai no sábado". */
  note?: string;
}

/** The note for a payment that moved, or none when it kept its day. */
function movedNote(natural: string, day: string): string | undefined {
  if (natural === day) return undefined;
  return `${day < natural ? 'antecipado' : 'adiado'}: dia ${Number(natural.slice(8, 10))} cai ${nonBusinessReason(natural)}`;
}

/** A bank credit counts as the payment of an expected day when it came this many days before it or after it (the bank may post it the next morning). */
const ARRIVES_BEFORE_DAYS = 6;
const ARRIVES_AFTER_DAYS = 3;
/** A payment expected yesterday that has not shown up may still be posted today, so it stays expected for this many days. */
const POSTING_GRACE_DAYS = 1;
/** How far a credit may be from the expected amount and still be that payment. */
const ARRIVAL_TOLERANCE = 0.1;

interface Credit {
  id: string;
  day: string;
  amount: Cents;
}

/** Credits that reached a bank account until today, leaving out own transfers, card payments and what is not posted yet. */
function bankCredits(store: Store, transactions: EffectiveTransaction[], today: string): Credit[] {
  const cardIds = new Set(store.listCanonicalAccounts().filter((a) => a.kind === 'credit_card').map((a) => a.id));
  return transactions
    .filter((t) => t.amount > 0 && !t.excluded && t.role === null && t.status !== 'pending' && !cardIds.has(t.accountId))
    .map((t) => ({ id: t.id, day: localDay(t.occurredAt), amount: t.amount }))
    .filter((c) => c.day <= today);
}

/** Takes the credit that is the payment expected on `day`, if one arrived; each credit settles one payment. */
function takeArrival(credits: Credit[], taken: Set<string>, day: string, amount: Cents, tolerance: number): boolean {
  const from = addDays(day, -ARRIVES_BEFORE_DAYS);
  const to = addDays(day, ARRIVES_AFTER_DAYS);
  const hit = credits.find((c) => !taken.has(c.id) && c.day >= from && c.day <= to && Math.abs(c.amount - amount) <= amount * tolerance);
  if (hit) taken.add(hit.id);
  return hit !== undefined;
}

/**
 * Money expected to arrive from `today` until `until`, the same for the outlook and the calendar: the income the owner
 * registered, else the credits that come back every month in the bank accounts. Today's are included, since they have not
 * shown up yet, and yesterday's too, marked late, because the bank may post them this morning. A payment on a weekend or
 * holiday is moved by its rule (the business day before, for a salary). One whose credit already arrived around its day is
 * in the balance, so it is not expected again. A credit older than yesterday is not counted.
 */
export function incomeEvents(store: Store, recurring: RecurringItem[], today: string, until: string, transactions: EffectiveTransaction[]): { source: 'registered' | 'recurring' | 'none'; events: IncomeEvent[] } {
  const events: IncomeEvent[] = [];
  const registered = store.listIncome();
  const credits = recurring.filter((r) => r.direction === 'in' && r.account === 'bank' && isExpected(r));
  const source: 'registered' | 'recurring' | 'none' = registered.length > 0 ? 'registered' : credits.length > 0 ? 'recurring' : 'none';
  const arrived = bankCredits(store, transactions, today);
  const taken = new Set<string>();
  const first = addDays(today, -POSTING_GRACE_DAYS);
  if (source === 'registered') {
    // From the month before today and one past `until`: a day moved off a weekend can leave its month.
    for (let m = addMonths(today.slice(0, 7), -1); m <= addMonths(until.slice(0, 7), 1); m = addMonths(m, 1)) {
      for (const item of registered) {
        if ((item.fromMonth !== null && item.fromMonth > m) || (item.untilMonth !== null && item.untilMonth < m)) continue;
        const natural = dayInMonth(m, item.dayOfMonth);
        const day = moveToBusinessDay(natural, item.nonBusinessRule);
        if (day < first || day > until || takeArrival(arrived, taken, day, item.amount, ARRIVAL_TOLERANCE)) continue;
        events.push({ day, name: item.name, amount: item.amount, origin: 'renda cadastrada', estimate: false, late: day < today, note: movedNote(natural, day) });
      }
    }
  } else if (source === 'recurring') {
    for (const r of credits) {
      if (r.late) continue;
      // A salary comes on the business day before; a fixed amount has to match to the cent, a varying one within the tolerance.
      for (const { day, natural } of scheduledDays(r.nextDay, r.dayOfMonth, first, until, 'previous')) {
        if (takeArrival(arrived, taken, day, r.amount, r.kind === 'fixed' ? 0 : ARRIVAL_TOLERANCE)) continue;
        events.push({ day, name: r.name, amount: r.amount, origin: `entrada que se repete todo mês, dia ${r.dayOfMonth}`, estimate: r.kind === 'variable', late: day < today, note: movedNote(natural, day) });
      }
    }
  }
  return { source, events };
}
