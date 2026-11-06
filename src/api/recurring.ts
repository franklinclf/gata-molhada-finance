import { merchantOf } from '../core/merchant.ts';
import { dayNumber, nextMonth } from '../core/dates.ts';
import { localDay } from '../core/time.ts';
import type { Store } from '../store/store.ts';
import { effectiveTransactions, type ViewOptions } from './scope.ts';

export interface RecurringItem {
  /** Stable key: direction and merchant. */
  key: string;
  name: string;
  direction: 'in' | 'out';
  /** Typical amount in cents, positive. */
  amount: number;
  /** fixed: the amount is almost always the same. variable: it moves, like a utility bill. */
  kind: 'fixed' | 'variable';
  /** Typical day of the month. */
  dayOfMonth: number;
  occurrences: number;
  lastDay: string;
  /** The day the next one is expected. */
  nextDay: string;
  /** True when the expected day has passed by more than a few days and nothing came. */
  late: boolean;
  category: string | null;
  /** Where it mostly happens: a card charge is inside the card bill and not a separate payment from the bank. */
  account: 'bank' | 'card';
  /** What the owner called it, or `Assinaturas e streaming` charges: a subscription, another recurring charge, or neither said. */
  label: 'subscription' | 'recurring' | null;
  /** True when the owner marked it, so it is listed even before the app has enough charges to detect it. */
  manual: boolean;
}

const DAY = 86_400_000;
const dayString = (n: number): string => new Date(n * DAY).toISOString().slice(0, 10);
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

const MIN_OCCURRENCES = 3;
const INTERVAL = { low: 24, high: 38 };
/** A late item is one the expected day passed by this many days. */
const LATE_AFTER_DAYS = 5;

/** The same day of the month in a month, clamped to the month length. */
export function dayInMonth(month: string, day: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(Math.min(day, last)).padStart(2, '0')}`;
}


/**
 * Charges and credits that come back about every month with a steady amount, found from the transactions themselves:
 * at least three, in three different months, a gap of about a month between them, an amount that stays within 10%
 * (fixed) or 45% (variable), and a last one recent enough that it was not cancelled. Installments have their own plan
 * and are left out, and so are moves the app does not count as spending or income.
 */
export function detectRecurring(store: Store, now: Date, opts: ViewOptions = {}): RecurringItem[] {
  const today = localDay(now.toISOString());
  const ignored = store.listRecurringIgnored();
  const cardIds = new Set(store.listCanonicalAccounts().filter((a) => a.kind === 'credit_card').map((a) => a.id));
  const groups = new Map<string, Array<{ day: number; amount: number; category: string | null; name: string; month: string; card: boolean }>>();
  for (const t of effectiveTransactions(store, opts)) {
    if (t.excluded || t.role !== null || t.installment || t.status === 'pending') continue;
    const name = merchantOf(t);
    if (name.length < 2) continue;
    const key = `${t.amount < 0 ? 'out' : 'in'}|${name.toLowerCase()}`;
    const day = localDay(t.occurredAt);
    // A charge dated ahead (scheduled debit, planned entry) has not happened: counting it as the last one would push the next
    // expected date a month ahead, and the calendar would show neither the real charge nor the expected one.
    if (day > today) continue;
    groups.set(key, [...(groups.get(key) ?? []), { day: dayNumber(day), amount: Math.abs(t.amount), category: t.category, name, month: day.slice(0, 7), card: cardIds.has(t.accountId) }]);
  }
  const marks = store.listRecurringMarks();
  const items: RecurringItem[] = [];
  for (const [key, list] of groups) {
    const mark = marks.get(key) ?? null;
    if (ignored.has(key) && mark === null) continue;
    const sorted = [...list].sort((a, b) => a.day - b.day);
    const gaps = sorted.slice(1).map((o, i) => o.day - sorted[i]!.day).filter((g) => g > 0);
    const amounts = sorted.map((o) => o.amount);
    const typical = median(amounts);
    const near = (band: number) => amounts.filter((a) => Math.abs(a - typical) <= typical * band).length / amounts.length;
    let interval = gaps.length > 0 ? median(gaps) : 30;
    let kind: 'fixed' | 'variable' | null = near(0.1) >= 0.7 ? 'fixed' : near(0.45) >= 0.8 ? 'variable' : null;
    if (mark === null) {
      // Detected from the charges alone.
      if (list.length < MIN_OCCURRENCES || new Set(list.map((o) => o.month)).size < MIN_OCCURRENCES || gaps.length < MIN_OCCURRENCES - 1) continue;
      const regular = gaps.filter((g) => g >= INTERVAL.low && g <= INTERVAL.high).length / gaps.length;
      if (regular < 0.7 || interval < INTERVAL.low || interval > INTERVAL.high || kind === null) continue;
    } else {
      // The owner said it is recurring: it is listed from the first charge, assumed monthly unless the gaps say otherwise.
      if (interval < INTERVAL.low || interval > INTERVAL.high) interval = 30;
      kind ??= 'variable';
    }
    const last = sorted.at(-1)!;
    if (dayNumber(today) - last.day > interval * 2.2) continue;
    const dayOfMonth = median(sorted.map((o) => Number(dayString(o.day).slice(8, 10))));
    // The next one is the typical day of the month after the last one, or if that is not later, the month after.
    let month = dayString(last.day).slice(0, 7);
    let next = dayInMonth(month, dayOfMonth);
    if (next <= dayString(last.day)) {
      month = nextMonth(month);
      next = dayInMonth(month, dayOfMonth);
    }
    const category = [...sorted].reverse().find((o) => o.category !== null)?.category ?? null;
    const label = mark ?? (category === 'Assinaturas e streaming' ? 'subscription' : null);
    items.push({
      key,
      name: last.name,
      direction: key.startsWith('out') ? 'out' : 'in',
      amount: typical,
      kind,
      dayOfMonth,
      occurrences: sorted.length,
      lastDay: dayString(last.day),
      nextDay: next,
      late: sorted.length >= 2 && dayNumber(today) - dayNumber(next) > LATE_AFTER_DAYS,
      category,
      account: sorted.filter((o) => o.card).length > sorted.length / 2 ? 'card' : 'bank',
      label,
      manual: mark !== null,
    });
  }
  return items.sort((a, b) => a.nextDay.localeCompare(b.nextDay) || a.name.localeCompare(b.name));
}

export type RecurringResult = { ok: true } | { ok: false; status: number; error: string };

export function ignoreRecurring(store: Store, key: unknown, ignored: unknown, now: Date): RecurringResult {
  if (typeof key !== 'string' || !/^(in|out)\|.{1,120}$/.test(key)) return { ok: false, status: 400, error: 'key is not a recurring item key' };
  if (typeof ignored !== 'boolean') return { ok: false, status: 400, error: 'ignored must be true or false' };
  store.setRecurringIgnored(key, ignored, now.toISOString());
  return { ok: true };
}

/** The key a charge has among recurring items: direction and merchant. */
export function recurringKeyOf(t: { amount: number; description: string; counterparty?: { name: string | null } | null; sourceLabels?: string[]; mcc?: string | null; operation?: string | null }): string {
  return `${t.amount < 0 ? 'out' : 'in'}|${merchantOf(t as Parameters<typeof merchantOf>[0]).toLowerCase()}`;
}

/**
 * The owner says what a merchant's charges are: `subscription`, `recurring` (rent, a utility, a fee), `none` (not
 * recurring: the same as "Não é recorrente"), or null to go back to what the app detects.
 */
export function markRecurring(store: Store, key: unknown, label: unknown, now: Date): RecurringResult {
  if (typeof key !== 'string' || !/^(in|out)\|.{1,120}$/.test(key)) return { ok: false, status: 400, error: 'key is not a recurring item key' };
  if (label !== 'subscription' && label !== 'recurring' && label !== 'none' && label !== null) return { ok: false, status: 400, error: 'label must be subscription, recurring, none or null' };
  const at = now.toISOString();
  store.setRecurringMark(key, label === 'subscription' || label === 'recurring' ? label : null, at);
  store.setRecurringIgnored(key, label === 'none', at);
  return { ok: true };
}
