import { dayMonth, monthName } from './format.ts';

export interface FlowColumn {
  key: string;
  /** Short label under the bars. The chart decides which ones fit. */
  label: string;
  tip: string;
  inflow: number;
  outflow: number;
}

const DAY = 86_400_000;

/**
 * What went in and out of the accounts as chart columns: one per day for a single month, one per month for longer spans.
 * Days with no movement still get a column, so the chart keeps the real shape of the period.
 */
export function flowColumns(days: Array<{ day: string; inflow: number; outflow: number }>, from: string, to: string, daily: boolean): FlowColumn[] {
  const byDay = new Map(days.map((d) => [d.day, d]));
  if (daily) {
    const out: FlowColumn[] = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`) && out.length < 62; t += DAY) {
      const day = new Date(t).toISOString().slice(0, 10);
      const entry = byDay.get(day);
      out.push({ key: day, label: String(Number(day.slice(8))), tip: dayMonth(day), inflow: entry?.inflow ?? 0, outflow: entry?.outflow ?? 0 });
    }
    return out;
  }
  const months = new Map<string, FlowColumn>();
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) {
    const month = new Date(t).toISOString().slice(0, 7);
    if (!months.has(month)) months.set(month, { key: month, label: monthName(month).slice(0, 3), tip: monthName(month), inflow: 0, outflow: 0 });
  }
  for (const d of days) {
    const column = months.get(d.day.slice(0, 7));
    if (column) {
      column.inflow += d.inflow;
      column.outflow += d.outflow;
    }
  }
  return [...months.values()];
}
