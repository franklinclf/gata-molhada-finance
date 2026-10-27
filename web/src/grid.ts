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

/** How many list rows fit in a widget of this height, after the header, the key figure and the footer. */
export function rowsFit(h: number, reserved = 3): number {
  return Math.max(Math.floor((h - reserved) * 1.6), 0);
}
