const monthEnd = (day: string) => {
  const [y, m] = day.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
const fromDayNumber = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);
const monthIndex = (day: string) => {
  const [y, m] = day.split('-').map(Number) as [number, number];
  return y * 12 + (m - 1);
};
const monthStartOf = (index: number) => `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-01`;

/**
 * The range one step back (-1) or forward (+1) of the same length. A range of whole months moves by that many months, so
 * "October" becomes "September" and not "the 31 days before October 1". The current month is cut at today. Null when the
 * step would start after today.
 */
export function shiftRange(from: string, to: string, direction: -1 | 1, today: string): { from: string; to: string } | null {
  const wholeMonths = from.endsWith('-01') && (to === monthEnd(to) || to === today);
  let next: { from: string; to: string };
  if (wholeMonths) {
    const count = monthIndex(to) - monthIndex(from) + 1;
    const start = monthIndex(from) + direction * count;
    const end = monthEnd(monthStartOf(start + count - 1));
    next = { from: monthStartOf(start), to: end };
  } else {
    const length = dayNumber(to) - dayNumber(from) + 1;
    next = { from: fromDayNumber(dayNumber(from) + direction * length), to: fromDayNumber(dayNumber(to) + direction * length) };
  }
  if (next.from > today) return null;
  return { from: next.from, to: next.to > today ? today : next.to };
}

