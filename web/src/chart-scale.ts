/**
 * The lowest and highest value a line chart draws.
 * `zero` (a running total) always includes zero, so the line starts on the floor. `fit` follows the data, which shows a trend in a
 * figure that moves little against its size (a net worth); the axis labels then say where the floor is.
 */
export function lineExtent(points: number[], scale: 'zero' | 'fit'): { min: number; max: number } {
  if (scale === 'fit' && points.length > 0) {
    const min = Math.min(...points);
    const max = Math.max(...points);
    // A flat series would divide by zero: give it a range, so the line sits in the middle.
    return min === max ? { min: min - 1, max: max + 1 } : { min, max };
  }
  return { min: Math.min(0, ...points), max: Math.max(1, ...points) };
}
