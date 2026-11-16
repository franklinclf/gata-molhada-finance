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

/** Reads dd/mm/aaaa (day and month may have one digit) as YYYY-MM-DD; null when it is not a real day or is before the first year. */
export function parseDay(text: string): string | null {
  const m = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})\s*$/.exec(text);
  if (!m) return null;
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < FIRST_YEAR || month < 1 || month > 12 || day < 1) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > last) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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
