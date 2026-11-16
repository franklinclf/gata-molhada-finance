/** Press-and-hold to start selecting: how long, and how far a finger may drift (scrolling) before the hold is cancelled. */
export const HOLD_MS = 450;
export const HOLD_TOLERANCE = 10;

export function movedTooFar(start: { x: number; y: number }, now: { x: number; y: number }, tolerance = HOLD_TOLERANCE): boolean {
  return Math.hypot(now.x - start.x, now.y - start.y) > tolerance;
}

/** The ids from `a` to `b` (both included) in list order; an id that is not in the list gives just the other one. */
export function idsBetween(order: string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return [a, b].filter((id) => order.includes(id));
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** Adds a range to a selection without repeating ids, keeping the order of the list. */
export function withRange(selected: string[], order: string[], a: string, b: string): string[] {
  const set = new Set([...selected, ...idsBetween(order, a, b)]);
  return order.filter((id) => set.has(id)).concat(selected.filter((id) => !order.includes(id)));
}

export const toggleId = (selected: string[], id: string): string[] => (selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

/** Next row for Shift+arrow / arrow moves, kept inside the list. */
export const stepIndex = (index: number, delta: number, length: number): number => Math.min(Math.max(index + delta, 0), length - 1);

/** Rows to append from a new page: those not already loaded (the list can shift while pages load). */
export function newRows<T extends { id: string }>(loaded: T[], page: T[]): T[] {
  const have = new Set(loaded.map((r) => r.id));
  return page.filter((r) => !have.has(r.id));
}
