import type { CalendarDay, ProjectedItem } from '../../src/api/calendar.ts';

/** Windows the calendar offers for "what is coming", in days. Any whole number from 1 to MAX_WINDOW also works. */
export const WINDOW_PRESETS = [7, 14, 30, 60] as const;
export const DEFAULT_WINDOW = 14;
export const MAX_WINDOW = 90;

/** The window saved in the widget settings, or the default when it is missing or out of range. */
export function parseWindow(value: string | undefined): number {
  const days = Number(value);
  return Number.isInteger(days) && days >= 1 && days <= MAX_WINDOW ? days : DEFAULT_WINDOW;
}

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The months (YYYY-MM) that hold the days from `today` to the end of the window, in order. */
export function monthsCovering(today: string, windowDays: number): string[] {
  const out: string[] = [];
  const last = addDays(today, windowDays).slice(0, 7);
  let [year, month] = today.split('-').map(Number) as [number, number];
  for (;;) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    out.push(key);
    if (key >= last) return out;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
}

export interface Upcoming extends ProjectedItem {
  day: string;
}

/** What is expected from today to the end of the window, by day. A day that appears twice (two months fetched around a boundary) counts once. */
export function upcomingItems(days: CalendarDay[], today: string, windowDays: number): Upcoming[] {
  const limit = addDays(today, windowDays);
  const seen = new Set<string>();
  const items: Upcoming[] = [];
  for (const d of [...days].sort((a, b) => a.day.localeCompare(b.day))) {
    if (d.day < today || d.day > limit || seen.has(d.day)) continue;
    seen.add(d.day);
    for (const p of d.projected) items.push({ ...p, day: d.day });
  }
  return items;
}

/** The sums the summary shows: what leaves, what arrives and how many items. */
export function upcomingTotals(items: Upcoming[]): { out: number; in: number; count: number } {
  return {
    out: items.filter((p) => p.direction === 'out').reduce((s, p) => s + p.amount, 0),
    in: items.filter((p) => p.direction === 'in').reduce((s, p) => s + p.amount, 0),
    count: items.length,
  };
}

/** "14 dias" or "1 dia". */
export const windowLabel = (days: number): string => `${days} ${days === 1 ? 'dia' : 'dias'}`;
