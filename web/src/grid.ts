/** A widget's rectangle on the dashboard grid, in cells. */
export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const COLUMNS = 12;

export function collides(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

const byPosition = (a: Box, b: Box) => a.y - b.y || a.x - b.x;

/** Moves every box up as far as it goes without touching another one, keeping the left-to-right order. */
export function compact<T extends Box>(items: T[]): T[] {
  const placed: T[] = [];
  for (const item of [...items].sort(byPosition)) {
    let y = 0;
    const candidate = { ...item };
    for (;;) {
      candidate.y = y;
      const hit = placed.filter((p) => collides(p, candidate));
      if (hit.length === 0) break;
      y = Math.max(...hit.map((p) => p.y + p.h));
    }
    placed.push(candidate);
  }
  return items.map((original) => placed.find((p) => p.id === original.id)!);
}

export function clampBox<T extends Box>(box: T, columns = COLUMNS, minW = 2, minH = 2, maxH = 40): T {
  const w = Math.min(Math.max(Math.round(box.w), minW), columns);
  const h = Math.min(Math.max(Math.round(box.h), minH), maxH);
  const x = Math.min(Math.max(Math.round(box.x), 0), columns - w);
  const y = Math.max(Math.round(box.y), 0);
  return { ...box, x, y, w, h };
}

/**
 * Puts one box at a new place or size. Boxes in the way are pushed down, then everything settles upward.
 * The moved box wins ties, so it stays where it was dropped when possible.
 */
export function place<T extends Box>(items: T[], id: string, target: Partial<Omit<Box, 'id'>>, columns = COLUMNS): T[] {
  const current = items.find((i) => i.id === id);
  if (!current) return items;
  const moved = clampBox({ ...current, ...target }, columns);
  const others = items.filter((i) => i.id !== id).map((i) => ({ ...i })).sort(byPosition);
  const fixed: T[] = [moved];
  for (const item of others) {
    for (;;) {
      const hit = fixed.filter((f) => collides(f, item));
      if (hit.length === 0) break;
      item.y = Math.max(...hit.map((f) => f.y + f.h));
    }
    fixed.push(item);
  }
  // Compaction sorts by position, so give the moved box a half-row head start on ties.
  const settled = compact(fixed.map((f) => (f.id === id ? { ...f, y: f.y - 0.5 } : f))).map((f) => ({ ...f, y: Math.round(f.y) }));
  return items.map((original) => settled.find((s) => s.id === original.id)!);
}

/** First free spot, scanning rows from the top, for a new box of this size. */
export function freeSlot(items: Box[], w: number, h: number, columns = COLUMNS): { x: number; y: number } {
  for (let y = 0; ; y++) {
    for (let x = 0; x + w <= columns; x++) {
      const probe: Box = { id: '', x, y, w, h };
      if (!items.some((i) => collides(i, probe))) return { x, y };
    }
  }
}

export type SizeClass = 'sm' | 'md' | 'lg';

/** The look a widget takes at a size: sm shows the key figure, md adds a chart and a few rows, lg shows more. */
export function sizeClass(w: number, h: number): SizeClass {
  if (w <= 3 || h <= 3) return 'sm';
  if (w >= 8 && h >= 6) return 'lg';
  return w >= 6 && h >= 7 ? 'lg' : 'md';
}

/** The same choice from the size on screen, so a widget fits its real room whatever the column width is. A wide, short widget still gets the fuller look, and a narrow but tall one does too, since its content fits in 355 px on a phone. */
export function sizeClassPx(width: number, height: number): SizeClass {
  if ((width <= 360 && height <= 360) || (height <= 260 && width < 600)) return 'sm';
  if ((width >= 880 && height >= 500) || (width >= 660 && height >= 590)) return 'lg';
  return 'md';
}

/** Columns that fit a container: about as wide as the 12 of the normal layout, never fewer than 12. */
export function columnsFor(width: number, gap: number, slot = 112, max = 36): number {
  return Math.min(max, Math.max(COLUMNS, Math.floor((width + gap) / (slot + gap))));
}

/** Spreads boxes over the given number of columns, keeping their sizes and reading order. */
export function reflow<T extends Box>(items: T[], columns: number): T[] {
  const placed: T[] = [];
  for (const item of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const w = Math.min(item.w, columns);
    placed.push({ ...item, w, ...freeSlot(placed, w, item.h, columns) });
  }
  return items.map((i) => placed.find((p) => p.id === i.id)!);
}

/** How many list rows fit in a widget of this height, after the header, the key figure and the footer. */
export function rowsFit(h: number, reserved = 3): number {
  return Math.max(Math.floor((h - reserved) * 1.6), 0);
}

/** A widget's size on screen, in pixels. Unknown where the widget is as tall as its content (the phone stack). */
export interface Pixels {
  width: number;
  height: number;
}

/** Height for a chart that takes the room left after `reserved` px of other content, kept between `min` and `max`. Without a known size it keeps `min`. */
export function chartHeight(pixels: Pixels | undefined, reserved: number, min: number, max: number): number {
  if (!pixels) return min;
  return Math.round(Math.min(max, Math.max(min, pixels.height - reserved)));
}

/** "<1%" for a positive share that rounds to nothing, so a real amount never sits beside "0%". */
export function shareLabel(fraction: number): string {
  if (fraction > 0 && fraction < 0.005) return '<1%';
  return `${Math.round(fraction * 100)}%`;
}
