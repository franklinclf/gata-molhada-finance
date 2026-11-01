/** Calendar arithmetic on plain days (YYYY-MM-DD) and months (YYYY-MM). One copy, so every screen counts the same way. */

const DAY_MS = 86_400_000;

/** Days since 1970-01-01 of a day (a longer text, such as an ISO instant, is cut to its first ten characters). */
export function dayNumber(day: string): number {
  return Math.round(Date.parse(`${day.slice(0, 10)}T00:00:00Z`) / DAY_MS);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

export const nextMonth = (month: string): string => addMonths(month, 1);

/** Last day (YYYY-MM-DD) of a month. */
export function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
