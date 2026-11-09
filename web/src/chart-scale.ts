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

/**
 * Which columns of a bar chart get a label under them. Every column when the labels fit side by side, otherwise every 2nd, 5th,
 * 10th or 20th, always including the first and the last. A label that would sit closer than one step to the last one is dropped,
 * so the two never touch. `width` is the width of the chart and `labelPx` the room one label needs, both in pixels.
 */
export function labelPlan(count: number, width: number, labelPx: number, gap = 0): boolean[] {
  if (count <= 0) return [];
  const column = Math.max(1, (width - gap * (count - 1)) / count + gap);
  const step = [1, 2, 5, 10, 20, 50].find((s) => s * column >= labelPx) ?? 50;
  const shown = Array.from({ length: count }, (_, i) => i % step === 0);
  shown[0] = true;
  shown[count - 1] = true;
  for (let i = count - 2; i > 0 && count - 1 - i < step; i--) shown[i] = false;
  return shown;
}
