import { localDay } from '../core/time.ts';
import type { Store } from '../store/store.ts';
import { addMonths, monthActuals } from './budgets.ts';
import { categoryParents } from './category-groups.ts';

export interface TrendRow {
  name: string;
  parent: string | null;
  /** Net spending per month, oldest first, in the order of `months`. */
  points: number[];
  /** The last point, which is the current month so far. */
  current: number;
  /** Average of the complete months. */
  average: number;
}

export interface TrendView {
  months: string[];
  rows: TrendRow[];
}

const NOT_SPENDING = new Set(['Estorno', 'Renda', 'Sem categoria']);

/** Spending per category over the last months, so a category that is creeping up shows. */
export function categoryTrend(store: Store, now: Date, months: number): TrendView {
  const currentMonth = localDay(now.toISOString()).slice(0, 7);
  const list = Array.from({ length: months }, (_, i) => addMonths(currentMonth, i - (months - 1)));
  const perMonth = list.map((m) => monthActuals(store, m, now).byCategory);
  const parents = categoryParents(store);
  const names = new Set(perMonth.flatMap((m) => [...m.keys()]));
  const rows: TrendRow[] = [...names]
    .filter((name) => !NOT_SPENDING.has(name))
    .map((name) => {
      const points = perMonth.map((m) => Math.max(0, m.get(name) ?? 0));
      const complete = points.slice(0, -1);
      return { name, parent: parents.get(name) ?? null, points, current: points.at(-1) ?? 0, average: complete.length > 0 ? Math.round(complete.reduce((s, v) => s + v, 0) / complete.length) : 0 };
    })
    .filter((r) => r.points.some((p) => p > 0))
    .sort((a, b) => b.points.reduce((s, v) => s + v, 0) - a.points.reduce((s, v) => s + v, 0) || a.name.localeCompare(b.name));
  return { months: list, rows };
}
