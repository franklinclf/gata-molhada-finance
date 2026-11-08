import { addMonths, lastDayOf } from '../core/dates.ts';
import type { Cents } from '../core/money.ts';
import { merchantOf } from '../core/merchant.ts';
import { DATA_START_MONTH, localDay } from '../core/time.ts';
import type { Store } from '../store/store.ts';
import type { EffectiveTransaction, ViewOptions } from './scope.ts';
import { spendingTransactions } from './views.ts';

export interface CompareLine {
  name: string;
  current: Cents;
  previous: Cents;
  /** Average of the same stretch in the closed months before; null when there is no such month. */
  average: Cents | null;
  /** Current minus previous. */
  delta: Cents;
}

export interface CompareDriver {
  category: string;
  delta: Cents;
  /** The merchants that explain most of the rise, biggest first. */
  merchants: Array<{ name: string; current: Cents; previous: Cents; delta: Cents; count: number }>;
}

export interface CompareView {
  month: string;
  /** The stretch of the month being compared, first and last day inclusive. */
  from: string;
  to: string;
  /** The same stretch of the month before. */
  previous: { from: string; to: string };
  /** The closed months the average is made of, oldest first. */
  baselineMonths: string[];
  total: { current: Cents; previous: Cents; average: Cents | null; delta: Cents; deltaAverage: Cents | null };
  /** Every category with spending in either stretch, the biggest rise first. */
  categories: CompareLine[];
  /** The categories that rose against the month before, with the merchants behind each rise. */
  drivers: CompareDriver[];
  /** Merchants with spending now and none in the three months before. */
  newMerchants: Array<{ name: string; amount: Cents; count: number }>;
  /** Purchases well above what that merchant (or category) usually costs. */
  bigPurchases: Array<{ id: string; day: string; merchant: string; category: string; amount: Cents; usual: Cents; times: number }>;
}

const BASELINE_MONTHS = 3;
const DRIVER_CATEGORIES = 5;
const DRIVER_MERCHANTS = 3;
/** A purchase is out of pattern above this many times the usual one. */
const BIG_FACTOR = 3;
/** Below this a purchase is never called big, whatever the ratio (R$ 50). */
const BIG_FLOOR: Cents = 5000;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isMonth = (value: string): boolean => MONTH.test(value);

const net = (t: EffectiveTransaction): Cents => -t.amount;

function sumBy(list: EffectiveTransaction[], key: (t: EffectiveTransaction) => string): Map<string, { amount: Cents; count: number }> {
  const out = new Map<string, { amount: Cents; count: number }>();
  for (const t of list) {
    const row = out.get(key(t)) ?? { amount: 0, count: 0 };
    row.amount += net(t);
    row.count += 1;
    out.set(key(t), row);
  }
  return out;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * What changed in a month so far: the month up to today (or the whole month, if it is over) against the same days of the month before
 * and against the average of the same days in the three closed months before that. Spending is the one the Gastos screen counts (purchase date).
 */
export function compareMonths(store: Store, month: string, now: Date, opts: ViewOptions = {}): CompareView {
  const today = localDay(now.toISOString());
  const last = lastDayOf(month);
  const to = today < last ? today : last;
  const upTo = Number(to.slice(8, 10));
  // Same days in another month, capped at its length (day 31 against a 30-day month).
  const stretch = (m: string) => {
    const end = lastDayOf(m);
    const day = `${m}-${String(upTo).padStart(2, '0')}`;
    return { from: `${m}-01`, to: day < end ? day : end };
  };
  const prevMonth = addMonths(month, -1);
  const baseline = Array.from({ length: BASELINE_MONTHS }, (_, i) => addMonths(month, i - BASELINE_MONTHS)).filter((m) => m >= DATA_START_MONTH);
  const historyFrom = `${addMonths(month, -BASELINE_MONTHS)}-01`;
  const historyTo = lastDayOf(prevMonth);

  const current = spendingTransactions(store, { from: `${month}-01`, to }, now, opts);
  const history = spendingTransactions(store, { from: historyFrom, to: historyTo }, now, opts);
  const within = (list: EffectiveTransaction[], range: { from: string; to: string }) => list.filter((t) => {
    const day = localDay(t.occurredAt);
    return day >= range.from && day <= range.to;
  });
  const previousRange = stretch(prevMonth);
  const previous = within(history, previousRange);
  const baselineTx = baseline.map((m) => within(history, stretch(m)));

  const sum = (list: EffectiveTransaction[]) => list.reduce((s, t) => s + net(t), 0);
  const average = (read: (list: EffectiveTransaction[]) => number): number | null => (baseline.length === 0 ? null : Math.round(baselineTx.reduce((s, list) => s + read(list), 0) / baseline.length));

  const categoryOf = (t: EffectiveTransaction) => t.category ?? 'Sem categoria';
  const nowByCategory = sumBy(current, categoryOf);
  const prevByCategory = sumBy(previous, categoryOf);
  const baselineByCategory = baselineTx.map((list) => sumBy(list, categoryOf));
  const categoryNames = new Set([...nowByCategory.keys(), ...prevByCategory.keys()]);
  const categories: CompareLine[] = [...categoryNames]
    .map((name) => {
      const cur = nowByCategory.get(name)?.amount ?? 0;
      const prev = prevByCategory.get(name)?.amount ?? 0;
      return { name, current: cur, previous: prev, average: baseline.length === 0 ? null : Math.round(baselineByCategory.reduce((s, m) => s + (m.get(name)?.amount ?? 0), 0) / baseline.length), delta: cur - prev };
    })
    .filter((l) => l.current !== 0 || l.previous !== 0)
    .sort((a, b) => b.delta - a.delta || a.name.localeCompare(b.name));

  const drivers: CompareDriver[] = categories
    .filter((l) => l.delta > 0)
    .slice(0, DRIVER_CATEGORIES)
    .map((line) => {
      const inCategory = (t: EffectiveTransaction) => categoryOf(t) === line.name;
      const nowM = sumBy(current.filter(inCategory), merchantOf);
      const prevM = sumBy(previous.filter(inCategory), merchantOf);
      const merchants = [...nowM.keys()]
        .map((name) => ({ name, current: nowM.get(name)!.amount, previous: prevM.get(name)?.amount ?? 0, count: nowM.get(name)!.count }))
        .map((m) => ({ ...m, delta: m.current - m.previous }))
        .filter((m) => m.delta > 0)
        .sort((a, b) => b.delta - a.delta || a.name.localeCompare(b.name))
        .slice(0, DRIVER_MERCHANTS);
      return { category: line.name, delta: line.delta, merchants };
    });

  // New means absent from every month of the history, not only from the stretch compared.
  const known = new Set(history.map(merchantOf));
  // With no history at all every merchant would be new, which says nothing.
  const newMerchants = [...sumBy(current, merchantOf)]
    .filter(([name, v]) => history.length > 0 && v.amount > 0 && !known.has(name))
    .map(([name, v]) => ({ name, amount: v.amount, count: v.count }))
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name))
    .slice(0, 5);

  // The usual purchase is the median of that merchant's purchases in the history; a merchant seen fewer than twice falls back to its category.
  const purchases = (list: EffectiveTransaction[]) => list.filter((t) => t.amount < 0);
  const usualBy = (key: (t: EffectiveTransaction) => string, minSamples: number) => {
    const groups = new Map<string, number[]>();
    for (const t of purchases(history)) groups.set(key(t), [...(groups.get(key(t)) ?? []), -t.amount]);
    return (name: string): number | null => {
      const values = groups.get(name);
      return values && values.length >= minSamples ? median(values) : null;
    };
  };
  const merchantUsual = usualBy(merchantOf, 2);
  const categoryUsual = usualBy(categoryOf, 3);
  const bigPurchases = purchases(current)
    .flatMap((t) => {
      const usual = merchantUsual(merchantOf(t)) ?? categoryUsual(categoryOf(t));
      const size = -t.amount;
      if (usual === null || usual <= 0 || size < BIG_FLOOR || size < usual * BIG_FACTOR) return [];
      return [{ id: t.id, day: localDay(t.occurredAt), merchant: merchantOf(t), category: categoryOf(t), amount: size, usual: Math.round(usual), times: Math.round((size / usual) * 10) / 10 }];
    })
    .sort((a, b) => b.amount - a.amount || a.id.localeCompare(b.id))
    .slice(0, 5);

  const totalNow = sum(current);
  const totalPrev = sum(previous);
  const totalAvg = average(sum);
  return {
    month,
    from: `${month}-01`,
    to,
    previous: previousRange,
    baselineMonths: baseline,
    total: { current: totalNow, previous: totalPrev, average: totalAvg, delta: totalNow - totalPrev, deltaAverage: totalAvg === null ? null : totalNow - totalAvg },
    categories,
    drivers,
    newMerchants,
    bigPurchases,
  };
}
