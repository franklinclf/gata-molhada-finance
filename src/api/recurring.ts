import { previousBusinessDay } from '../core/business-days.ts';
import { merchantOf } from '../core/merchant.ts';
import { dayNumber, nextMonth } from '../core/dates.ts';
import { localDay } from '../core/time.ts';
import type { RecurringOverride, Store } from '../store/store.ts';
import { cleanCategoryName } from './mutations.ts';
import { effectiveTransactions, type ViewOptions } from './scope.ts';

export interface RecurringItem {
  /** Stable key: direction and merchant. A payer that pays twice a month gives two items with the same key, one per day of the month. */
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
  /** The day the next one is expected. For a credit it is the business day before when the typical day is a weekend or holiday. */
  nextDay: string;
  /** True when the expected day has passed by more than a few days and nothing came. */
  late: boolean;
  category: string | null;
  /** Where it mostly happens: a card charge is inside the card bill and not a separate payment from the bank. */
  account: 'bank' | 'card';
  /** What the owner called it, or charges of a subscription category: a subscription, another recurring charge, or neither said. */
  label: 'subscription' | 'recurring' | null;
  /** True when the owner corrected the name, amount or day of this expense (`PUT /api/recurring/override`). */
  edited: boolean;
  /** True when the owner marked it, so it is listed even before the app has enough charges to detect it. */
  manual: boolean;
  /** The charges come about once a month. False for a marked item whose history says otherwise: its day and next date are not a promise, and it is not projected or counted as a monthly weight. */
  regular: boolean;
  /** Rent paid in parts: what is still due this month when part of it was already paid. The next day is then in this month. Null otherwise. */
  rest: number | null;
  /** A marked item that stopped: nothing came for more than two intervals. It stays listed so the owner sees it and can remove the mark, but is not expected any more. */
  stale: boolean;
}

/** An item the projections can count on: one that comes about every month and has not stopped. */
export const isExpected = (r: RecurringItem): boolean => r.regular && !r.stale;

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
/** Days of the month this close are the same day that moved (a weekend, a holiday). */
const SAME_DAY_SPREAD = 5;
/** A payer whose credits come less than this many days apart (median) pays more than once a month. */
const SPLIT_BELOW_DAYS = 20;
/** Categories paid every month by nature: two payments in two months in a row are enough. */
const RENT_CATEGORIES = new Set(['Aluguel']);
/** Categories that are a subscription without the owner saying so. */
const SUBSCRIPTION_CATEGORIES = new Set(['Assinaturas e streaming', 'Academia']);

/** The same day of the month in a month, clamped to the month length. */
export function dayInMonth(month: string, day: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

interface Occurrence {
  day: number;
  amount: number;
  category: string | null;
  name: string;
  month: string;
  card: boolean;
}

const dayOfMonthOf = (o: Occurrence): number => Number(dayString(o.day).slice(8, 10));

/** Charges of one merchant on the same day are one occurrence (two payments of one bill, a second purchase in the same visit), oldest first. */
function mergeSameDay(list: Occurrence[]): Occurrence[] {
  const out: Occurrence[] = [];
  for (const o of [...list].sort((a, b) => a.day - b.day)) {
    const last = out.at(-1);
    if (last && last.day === o.day) out[out.length - 1] = { ...o, amount: last.amount + o.amount, category: o.category ?? last.category };
    else out.push(o);
  }
  return out;
}

/** Credits of one payer split by the day of the month they come on: a salary paid around the 10th and around the 25th is two monthly items. */
function byDayOfMonth(list: Occurrence[]): Occurrence[][] {
  const clusters: Occurrence[][] = [];
  for (const o of [...list].sort((a, b) => dayOfMonthOf(a) - dayOfMonthOf(b))) {
    const last = clusters.at(-1);
    if (last && dayOfMonthOf(o) - dayOfMonthOf(last.at(-1)!) <= SAME_DAY_SPREAD) last.push(o);
    else clusters.push([o]);
  }
  // The end of a month and the start of the next are close too.
  if (clusters.length > 1 && dayOfMonthOf(clusters[0]![0]!) + 31 - dayOfMonthOf(clusters.at(-1)!.at(-1)!) <= SAME_DAY_SPREAD) clusters[0]!.push(...clusters.pop()!);
  return clusters.map((c) => c.sort((a, b) => a.day - b.day));
}

/**
 * Rent paid in two months in a row with about the same total (one month may be split in two payments): the latest month's total.
 * When the latest month is the current one and only part of it is paid, the rhythm is judged on the last two complete months
 * instead, and `rest` is what is still due this month.
 */
function rentAmount(sorted: Occurrence[], today: string): { amount: number; rest: number | null } | null {
  if (!sorted.some((o) => o.category !== null && RENT_CATEGORIES.has(o.category))) return null;
  const totals = new Map<string, number>();
  for (const o of sorted) totals.set(o.month, (totals.get(o.month) ?? 0) + o.amount);
  const months = [...totals.keys()].sort();
  const judge = (list: string[]): number | null => {
    if (list.length < 2 || nextMonth(list.at(-2)!) !== list.at(-1)) return null;
    const [a, b] = [totals.get(list.at(-2)!)!, totals.get(list.at(-1)!)!];
    return Math.abs(a - b) <= Math.max(a, b) * 0.1 ? b : null;
  };
  const whole = judge(months);
  if (whole !== null) return { amount: whole, rest: null };
  const current = today.slice(0, 7);
  if (months.at(-1) !== current) return null;
  const complete = judge(months.filter((m) => m < current));
  if (complete === null) return null;
  const rest = complete - totals.get(current)!;
  return { amount: complete, rest: rest > 0 ? rest : null };
}

/**
 * Charges and credits that come back about every month with a steady amount, found from the transactions themselves:
 * at least three, in three different months, a gap of about a month between them, an amount that stays within 10%
 * (fixed) or 45% (variable), and a last one recent enough that it was not cancelled. Rent needs only two months in a row.
 * A payer that pays more than once a month is split by the day of the month, also when the owner marked it. Installments have their own plan and are
 * left out, and so are moves the app does not count as spending or income.
 */
export function detectRecurring(store: Store, now: Date, opts: ViewOptions = {}): RecurringItem[] {
  return detect(store, now, opts, false);
}

/** The items the owner said are not recurring, as the app would list them otherwise, so one can be brought back. */
export function ignoredRecurring(store: Store, now: Date, opts: ViewOptions = {}): RecurringItem[] {
  return detect(store, now, opts, true);
}

function detect(store: Store, now: Date, opts: ViewOptions, onlyIgnored: boolean): RecurringItem[] {
  const today = localDay(now.toISOString());
  const ignored = store.listRecurringIgnored();
  const overrides = store.listRecurringOverrides();
  const cardIds = new Set(store.listCanonicalAccounts().filter((a) => a.kind === 'credit_card').map((a) => a.id));
  const groups = new Map<string, Occurrence[]>();
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
  const gapsOf = (sorted: Occurrence[]) => sorted.slice(1).map((o, i) => o.day - sorted[i]!.day);
  for (const [key, list] of groups) {
    const mark = marks.get(key) ?? null;
    if (onlyIgnored ? !(ignored.has(key) && mark === null) : ignored.has(key) && mark === null) continue;
    const merged = mergeSameDay(list);
    const gaps = gapsOf(merged);
    const split = key.startsWith('in|') && gaps.length >= MIN_OCCURRENCES && median(gaps) < SPLIT_BELOW_DAYS ? byDayOfMonth(merged) : [merged];
    // A marked payer is split too, or marking it would turn two monthly credits into one with gaps of two weeks. Only when the split
    // finds two rhythms with more than one credit each, so scattered days are not turned into several items.
    const parts = mark === null || split.filter((c) => c.length >= 2).length >= 2 ? split : [merged];
    for (const sorted of parts) {
      const item = itemOf(key, sorted, gapsOf(sorted), mark, today, overrides.get(key) ?? null);
      if (item) items.push(item);
    }
  }
  return items.sort((a, b) => a.nextDay.localeCompare(b.nextDay) || a.name.localeCompare(b.name));
}

function itemOf(key: string, sorted: Occurrence[], gaps: number[], mark: 'subscription' | 'recurring' | null, today: string, override: RecurringOverride | null): RecurringItem | null {
  const amounts = sorted.map((o) => o.amount);
  let amount = median(amounts);
  const near = (band: number) => amounts.filter((a) => Math.abs(a - amount) <= amount * band).length / amounts.length;
  let interval = gaps.length > 0 ? median(gaps) : 30;
  let kind: 'fixed' | 'variable' | null = near(0.1) >= 0.7 ? 'fixed' : near(0.45) >= 0.8 ? 'variable' : null;
  const monthly = gaps.length > 0 && gaps.filter((g) => g >= INTERVAL.low && g <= INTERVAL.high).length / gaps.length >= 0.7 && interval >= INTERVAL.low && interval <= INTERVAL.high;
  let regular = true;
  // The part of this month's rent still to pay: the typical day and the next date then come from the complete months.
  let rest: number | null = null;
  if (mark === null) {
    // Detected from the charges alone.
    const enough = sorted.length >= MIN_OCCURRENCES && new Set(sorted.map((o) => o.month)).size >= MIN_OCCURRENCES;
    const rent = key.startsWith('out|') ? rentAmount(sorted, today) : null;
    if (!(enough && monthly && kind !== null)) {
      if (rent === null) return null;
      [amount, kind, interval, rest] = [rent.amount, 'fixed', 30, rent.rest];
    }
  } else {
    // The owner said it is recurring: it is listed from the first charge, assumed monthly unless the gaps say otherwise.
    regular = gaps.length === 0 || monthly;
    if (!monthly) interval = 30;
    kind ??= 'variable';
  }
  const last = sorted.at(-1)!;
  const stale = dayNumber(today) - last.day > interval * 2.2;
  if (stale && mark === null) return null;
  // The typical day comes from the last three; when they are far apart (or across the turn of a month) the last one is the best guess.
  const basis = rest === null ? sorted : sorted.filter((o) => o.month < today.slice(0, 7));
  const anchor = basis.at(-1)!;
  const recent = basis.slice(-3).map(dayOfMonthOf);
  const detectedDay = Math.max(...recent) - Math.min(...recent) > SAME_DAY_SPREAD ? recent.at(-1)! : median(recent);
  // The owner's corrections apply to expenses only; an income is corrected through the registered income.
  const edit = key.startsWith('out|') ? override : null;
  const dayOfMonth = edit?.dayOfMonth ?? detectedDay;
  // The next one is the typical day in the month of the last one, moved a month ahead until it is a real interval after the last one.
  // A credit (a salary, say) on a weekend or holiday comes on the business day before; a payment keeps its day.
  const incoming = key.startsWith('in|');
  const dayOf = (m: string): string => (incoming ? previousBusinessDay(dayInMonth(m, dayOfMonth)) : dayInMonth(m, dayOfMonth));
  let month = dayString(anchor.day).slice(0, 7);
  let next = dayOf(month);
  while (dayNumber(next) - anchor.day < INTERVAL.low) {
    month = nextMonth(month);
    next = dayOf(month);
  }
  const category = [...sorted].reverse().find((o) => o.category !== null)?.category ?? null;
  const label = mark ?? (category !== null && SUBSCRIPTION_CATEGORIES.has(category) ? 'subscription' : null);
  return {
    key,
    name: edit?.name ?? last.name,
    direction: key.startsWith('out') ? 'out' : 'in',
    amount: edit?.amount ?? amount,
    kind,
    dayOfMonth,
    occurrences: sorted.length,
    lastDay: dayString(last.day),
    nextDay: next,
    late: regular && !stale && sorted.length >= 2 && dayNumber(today) - dayNumber(next) > LATE_AFTER_DAYS,
    category,
    account: sorted.filter((o) => o.card).length > sorted.length / 2 ? 'card' : 'bank',
    label,
    edited: edit !== null,
    manual: mark !== null,
    regular,
    rest,
    stale,
  };
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

/**
 * Corrects what the list shows for a detected expense: its name, expected amount (cents) and day of the month. A field that is
 * null or missing goes back to what the app detected, and with all three empty the correction is removed. Incomes are not
 * corrected here: they have their own registration (`/api/income`).
 */
export function overrideRecurring(store: Store, input: Record<string, unknown>, now: Date): RecurringResult {
  const { key } = input;
  if (typeof key !== 'string' || !/^out\|.{1,120}$/.test(key)) return { ok: false, status: 400, error: 'key must be the key of a detected expense' };
  const empty = (v: unknown) => v === undefined || v === null || v === '';
  let name: string | null = null;
  if (!empty(input.name)) {
    name = cleanCategoryName(input.name);
    if (name === null) return { ok: false, status: 400, error: 'name must be text of 1 to 60 characters' };
  }
  const amount = empty(input.amount) ? null : input.amount;
  if (amount !== null && (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0 || amount > 1_000_000_000)) return { ok: false, status: 400, error: 'amount must be a whole number of cents above zero' };
  const day = empty(input.dayOfMonth) ? null : input.dayOfMonth;
  if (day !== null && (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 31)) return { ok: false, status: 400, error: 'dayOfMonth must be 1 to 31' };
  store.setRecurringOverride(key, name === null && amount === null && day === null ? null : { name, amount: amount as number | null, dayOfMonth: day as number | null }, now.toISOString());
  return { ok: true };
}
