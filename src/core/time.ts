export const BRAZIL_OFFSET_MS = 3 * 3_600_000;

/** Day the app starts caring about. Older source records stay stored, but reconciliation and the views leave them out. */
export const DATA_START = '2026-01-01';
export const DATA_START_MONTH = DATA_START.slice(0, 7);

/** UTC instant at which a Brazil-time day (UTC-3) starts. */
export function startOfLocalDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + BRAZIL_OFFSET_MS).toISOString();
}

/** Calendar day in Brazil (UTC-3, no daylight saving), which is how purchases are dated on statements. */
export function localDay(instant: string): string {
  return new Date(new Date(instant).getTime() - BRAZIL_OFFSET_MS).toISOString().slice(0, 10);
}

/** Calendar month (YYYY-MM) in Brazil. Bank request limits renew on the first day of each month. */
export function localMonth(instant: string): string {
  return localDay(instant).slice(0, 7);
}
