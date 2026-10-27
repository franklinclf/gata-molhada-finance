const BRAZIL_OFFSET_MS = 3 * 3_600_000;

/** Calendar day in Brazil (UTC-3, no daylight saving), which is how purchases are dated on statements. */
export function localDay(instant: string): string {
  return new Date(new Date(instant).getTime() - BRAZIL_OFFSET_MS).toISOString().slice(0, 10);
}

/** Calendar month (YYYY-MM) in Brazil. Bank request limits renew on the first day of each month. */
export function localMonth(instant: string): string {
  return localDay(instant).slice(0, 7);
}
