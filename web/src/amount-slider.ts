/**
 * Maps a slider position (0..1000) to an amount in cents and back. The scale is logarithmic so that R$ 5 and R$ 50 stay
 * selectable when the largest amount is in the tens of thousands; the amount is rounded to a step that grows with it.
 */
export const STEPS = 1000;

/** Smallest amount the log scale starts from; position 0 always means `min`. */
const FLOOR = 100;

function roundAmount(cents: number): number {
  // R$ 1 steps up to R$ 100, R$ 5 up to R$ 1.000, R$ 10 up to R$ 10.000, R$ 50 above.
  const step = cents < 10_000 ? 100 : cents < 100_000 ? 500 : cents < 1_000_000 ? 1000 : 5000;
  return Math.round(cents / step) * step;
}

export function positionToCents(position: number, min: number, max: number): number {
  if (max <= min) return min;
  const p = Math.min(Math.max(position, 0), STEPS) / STEPS;
  if (p === 0) return min;
  if (p === 1) return max;
  const low = Math.max(min, FLOOR);
  const value = low * Math.pow(Math.max(max, low + 1) / low, p);
  return Math.min(max, Math.max(min, roundAmount(value)));
}

export function centsToPosition(cents: number, min: number, max: number): number {
  if (max <= min || cents <= min) return 0;
  if (cents >= max) return STEPS;
  const low = Math.max(min, FLOOR);
  if (cents <= low) return 0;
  return Math.round((Math.log(cents / low) / Math.log(Math.max(max, low + 1) / low)) * STEPS);
}

/** Keeps the two handles in order, at least one position apart unless they already sit at an end. */
export function clampHandles(low: number, high: number, moved: 'low' | 'high'): [number, number] {
  const a = Math.min(Math.max(low, 0), STEPS);
  const b = Math.min(Math.max(high, 0), STEPS);
  if (a <= b) return [a, b];
  return moved === 'low' ? [b, b] : [a, a];
}
