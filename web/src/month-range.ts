import { monthBounds } from './format.ts';

/** The app browses nothing before this year (DATA_START in src/core/time.ts); the web keeps its own copy to stay free of server code. */
export const FIRST_YEAR = 2026;

export const MONTH_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

export const monthKey = (year: number, month: number): string => `${year}-${String(month).padStart(2, '0')}`;

export interface Range {
  from?: string;
  to?: string;
}

/** A month (YYYY-MM) as a day range, cut at `today` for the current month like the rest of the app (later months stay whole). */
export const monthRange = (key: string, today: string): { from: string; to: string } => {
  const whole = monthBounds(key, '9999-12-31');
  return key === today.slice(0, 7) ? { from: whole.from, to: today } : whole;
};

export const yearRange = (year: number, today: string): { from: string; to: string } => ({
  from: `${year}-01-01`,
  to: monthRange(`${year}-12`, today).to,
});

/**
 * Month clicks: the first one picks that whole month and waits for a second; the second one covers both months and any between.
 * `anchor` is the month waiting for its pair, null when the next click starts again.
 */
export function pickMonth(anchor: string | null, clicked: string, today: string): { anchor: string | null; range: { from: string; to: string } } {
  if (anchor === null) return { anchor: clicked, range: monthRange(clicked, today) };
  const [first, last] = anchor <= clicked ? [anchor, clicked] : [clicked, anchor];
  return { anchor: null, range: { from: monthRange(first, today).from, to: monthRange(last, today).to } };
}

/** How much of a month a range covers: all of it, a part, or nothing. */
export function coverage(key: string, range: Range, today: string): 'full' | 'part' | 'none' {
  const month = monthRange(key, today);
  const from = range.from ?? '0000-01-01';
  const to = range.to ?? '9999-12-31';
  if (to < month.from || from > month.to) return 'none';
  return from <= month.from && to >= month.to ? 'full' : 'part';
}

/** True when the range is exactly the whole of that year (December is not cut). */
export function isWholeYear(year: number, range: Range, today: string): boolean {
  const whole = yearRange(year, today);
  return range.from === whole.from && range.to === whole.to;
}

/** Number of days of a month (YYYY-MM), leap years included. */
export const daysInMonth = (key: string): number => new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).getUTCDate();

/** The last day a month offers: its real length, but not past today for the current month (the app has no future days there). */
export const lastDayOf = (key: string, today: string): number => (key === today.slice(0, 7) ? Number(today.slice(8, 10)) : daysInMonth(key));

/**
 * The days the "De" and "Até" pickers offer, as numbers 1..31 limited to the month's real length. Inside a single month the two sides
 * cannot cross. Empty when the range has no start and end yet (no month chosen).
 */
export function dayBounds(range: Range, side: 'from' | 'to', today: string): { min: number; max: number } | null {
  if (range.from === undefined || range.to === undefined) return null;
  const key = (side === 'from' ? range.from : range.to).slice(0, 7);
  const sameMonth = range.from.slice(0, 7) === range.to.slice(0, 7);
  const min = side === 'to' && sameMonth ? Number(range.from.slice(8, 10)) : 1;
  const max = side === 'from' && sameMonth ? Number(range.to.slice(8, 10)) : lastDayOf(key, today);
  return { min, max };
}

/** Sets the start or end day inside the month it already has; a day outside what the month offers is pulled in. */
export function withDay(range: Range, side: 'from' | 'to', day: number, today: string): Range {
  const bounds = dayBounds(range, side, today);
  if (!bounds) return range;
  const current = side === 'from' ? range.from! : range.to!;
  const clamped = Math.min(Math.max(day, bounds.min), bounds.max);
  const next = `${current.slice(0, 8)}${String(clamped).padStart(2, '0')}`;
  return side === 'from' ? { from: next, to: range.to } : { from: range.from, to: next };
}

/** YYYY-MM-DD as dd/mm/aaaa; empty for no day. */
export const formatDay = (day: string | undefined): string => (day ? `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}` : '');

export interface RangePreset {
  id: string;
  label: string;
  range: (today: string) => Range;
}

const monthsBack = (today: string, back: number): string => {
  const index = Number(today.slice(0, 4)) * 12 + (Number(today.slice(5, 7)) - 1) - back;
  return monthKey(Math.floor(index / 12), (index % 12) + 1);
};

export const RANGE_PRESETS: RangePreset[] = [
  { id: 'month', label: 'Este mês', range: (t) => monthRange(t.slice(0, 7), t) },
  { id: 'last', label: 'Mês passado', range: (t) => monthRange(monthsBack(t, 1), t) },
  { id: '3m', label: 'Últimos 3 meses', range: (t) => ({ from: monthRange(monthsBack(t, 2), t).from, to: monthRange(t.slice(0, 7), t).to }) },
  { id: 'year', label: 'Este ano', range: (t) => yearRange(Number(t.slice(0, 4)), t) },
  { id: 'all', label: 'Tudo', range: () => ({}) },
];

/** The preset a range equals, if any. */
export function activePreset(range: Range, today: string): RangePreset | undefined {
  return RANGE_PRESETS.find((p) => {
    const r = p.range(today);
    return r.from === range.from && r.to === range.to;
  });
}

/** Short text for the button: a month, a year, whole months, or two days. */
export function rangeLabel(range: Range, today: string): string {
  const { from, to } = range;
  if (from === undefined && to === undefined) return 'Todo o período';
  if (from !== undefined && to !== undefined) {
    const startMonth = from.slice(0, 7);
    const endMonth = to.slice(0, 7);
    const wholeMonths = from === `${startMonth}-01` && to === monthRange(endMonth, today).to;
    if (wholeMonths && from.slice(0, 4) === to.slice(0, 4) && from.endsWith('-01-01') && to === yearRange(Number(from.slice(0, 4)), today).to) return from.slice(0, 4);
    if (wholeMonths) {
      const name = (key: string) => `${MONTH_SHORT[Number(key.slice(5, 7)) - 1]}/${key.slice(0, 4)}`;
      return startMonth === endMonth ? name(startMonth) : `${name(startMonth)} a ${name(endMonth)}`;
    }
  }
  return `${from ? formatDay(from) : 'início'} a ${to ? formatDay(to) : 'hoje'}`;
}
