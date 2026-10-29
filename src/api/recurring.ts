import { merchantOf } from '../core/merchant.ts';
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
}

const DAY = 86_400_000;
const dayNumber = (day: string): number => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY);
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

const nextMonth = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${Math.floor((y * 12 + m) / 12)}-${String(((y * 12 + m) % 12) + 1).padStart(2, '0')}`;
};

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
    groups.set(key, [...(groups.get(key) ?? []), { day: dayNumber(day), amount: Math.abs(t.amount), category: t.category, name, month: day.slice(0, 7), card: cardIds.has(t.accountId) }]);
  }
  const items: RecurringItem[] = [];
  for (const [key, list] of groups) {
    if (ignored.has(key) || list.length < MIN_OCCURRENCES || new Set(list.map((o) => o.month)).size < MIN_OCCURRENCES) continue;
    const sorted = [...list].sort((a, b) => a.day - b.day);
    const gaps = sorted.slice(1).map((o, i) => o.day - sorted[i]!.day).filter((g) => g > 0);
    if (gaps.length < MIN_OCCURRENCES - 1) continue;
    const regular = gaps.filter((g) => g >= INTERVAL.low && g <= INTERVAL.high).length / gaps.length;
    const interval = median(gaps);
    if (regular < 0.7 || interval < INTERVAL.low || interval > INTERVAL.high) continue;
    const amounts = sorted.map((o) => o.amount);
    const typical = median(amounts);
    const near = (band: number) => amounts.filter((a) => Math.abs(a - typical) <= typical * band).length / amounts.length;
    const kind = near(0.1) >= 0.7 ? 'fixed' : near(0.45) >= 0.8 ? 'variable' : null;
    if (kind === null) continue;
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
    const name = sorted.at(-1)!.name;
    items.push({ key, name, direction: key.startsWith('out') ? 'out' : 'in', amount: typical, kind, dayOfMonth, occurrences: sorted.length, lastDay: dayString(last.day), nextDay: next, late: dayNumber(today) - dayNumber(next) > LATE_AFTER_DAYS, category: last.category, account: sorted.filter((o) => o.card).length > sorted.length / 2 ? 'card' : 'bank' });
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
