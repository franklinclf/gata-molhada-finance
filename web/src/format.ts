const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const MASK = 'R$ ••••';

export function brl(cents: number, hidden = false): string {
  return hidden ? MASK : BRL.format(cents / 100);
}

/** Whole reais, for chart labels. */
export function brlShort(cents: number, hidden = false): string {
  if (hidden) return '••••';
  const reais = cents / 100;
  if (Math.abs(reais) >= 1000) return `${(reais / 1000).toFixed(1).replace('.', ',')} mil`;
  return String(Math.round(reais));
}

export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** "há 5 min", "há 3 h", "há 2 dias". Returns "sem data" when the time is missing. */
export function ago(iso: string | null, now: Date): string {
  if (!iso) return 'sem data';
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `há ${hours} h`;
  return `há ${Math.round(hours / 24)} dias`;
}

/** Data older than this is shown as stale. */
export const STALE_AFTER_HOURS = 6;

export function isStale(iso: string | null, now: Date): boolean {
  return iso === null || now.getTime() - Date.parse(iso) > STALE_AFTER_HOURS * 3_600_000;
}

/** "27/10" from YYYY-MM-DD. */
export function dayMonth(day: string): string {
  return `${day.slice(8, 10)}/${day.slice(5, 7)}`;
}

/** Local (Brazil, UTC-3) calendar day of an instant. */
export function localDay(iso: string): string {
  return new Date(Date.parse(iso) - 3 * 3_600_000).toISOString().slice(0, 10);
}

export type PeriodId = 'month' | '3m' | '6m' | '1y';
export const PERIODS: Array<{ id: PeriodId; label: string }> = [
  { id: 'month', label: 'Este mês' },
  { id: '3m', label: '3 meses' },
  { id: '6m', label: '6 meses' },
  { id: '1y', label: '1 ano' },
];

/** From/to local days for a period ending today. Month-based periods start on the first day of the month. */
export function periodRange(period: PeriodId, now: Date): { from: string; to: string } {
  const to = localDay(now.toISOString());
  const back = { month: 0, '3m': 2, '6m': 5, '1y': 11 }[period];
  const [year, month] = to.split('-').map(Number) as [number, number];
  const index = year * 12 + (month - 1) - back;
  const from = `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-01`;
  return { from, to };
}

/** Running total of daily amounts over every day of the range, so a line chart has a point per day. */
export function cumulative(daily: Array<{ day: string; amount: number }>, from: string, to: string): number[] {
  const byDay = new Map(daily.map((d) => [d.day, d.amount]));
  const out: number[] = [];
  let sum = 0;
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    sum += byDay.get(new Date(t).toISOString().slice(0, 10)) ?? 0;
    out.push(sum);
  }
  return out;
}
