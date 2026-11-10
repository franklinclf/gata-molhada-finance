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

/** Smallest size a box can take unless its widget says otherwise. */
export const DEFAULT_MIN: { w: number; h: number } = { w: 2, h: 2 };

export function clampBox<T extends Box>(box: T, columns = COLUMNS, minW = DEFAULT_MIN.w, minH = DEFAULT_MIN.h, maxH = 40): T {
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
export function place<T extends Box>(items: T[], id: string, target: Partial<Omit<Box, 'id'>>, columns = COLUMNS, min: { w: number; h: number } = DEFAULT_MIN): T[] {
  const current = items.find((i) => i.id === id);
  if (!current) return items;
  const moved = clampBox({ ...current, ...target }, columns, Math.min(min.w, columns), min.h);
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
/** The look of a widget one row tall: the title and the key figure, nothing else. */
export function isTinyPx(height: number): boolean {
  return height <= 100;
}

export function sizeClassPx(width: number, height: number): SizeClass {
  if ((width <= 360 && height <= 360) || (height <= 260 && width < 600)) return 'sm';
  if ((width >= 880 && height >= 500) || (width >= 660 && height >= 590)) return 'lg';
  return 'md';
}

/** Narrowest a grid column gets (px) before the grid drops columns instead: 12 of them plus 11 gaps of 14 px fit from 922 px. */
export const MIN_SLOT = 64;

/**
 * Columns of the grid for a container: shrink first, then wrap.
 * The count is the one the widest layout has: 12, and more where a wide screen has room for slots of `slot` px (`max` caps it; 12 when the grid
 * should not grow). Narrowing the window keeps that count and only makes the columns thinner, down to `minSlot`. Below that the count drops, in
 * steps of 4 (12, 8, 4) so the usual 4-wide widgets stay lined up, and never under 4.
 */
export function columnsFor(width: number, gap: number, slot = 112, max = 36, minSlot = MIN_SLOT): number {
  const grown = Math.min(max, Math.max(COLUMNS, Math.floor((width + gap) / (slot + gap))));
  const fits = Math.floor((width + gap) / (minSlot + gap));
  const count = Math.min(grown, fits);
  return count >= COLUMNS ? count : Math.max(4, Math.floor(count / 4) * 4);
}

/**
 * Phone stack: items in reading order (top to bottom, left to right), one or two half columns wide. A half-width item takes the next
 * half-width one beside it; anything else gets a row of its own. Rows are as tall as their tallest item, so no two items share a cell.
 */
export function packStack<T extends Box>(items: T[], columns = 2): T[] {
  const ordered = [...items].sort(byPosition);
  const placed = new Map<string, T>();
  let y = 0;
  let x = 0;
  let rowHeight = 0;
  for (const item of ordered) {
    const w = Math.min(Math.max(item.w, 1), columns);
    if (x + w > columns) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    placed.set(item.id, { ...item, w, x, y });
    x += w;
    rowHeight = Math.max(rowHeight, item.h);
  }
  return items.map((i) => placed.get(i.id)!);
}

/** The stack moved one step in reading order (-1 up, 1 down); at the edge it stays as it is. */
export function shiftInStack<T extends Box>(items: T[], id: string, delta: -1 | 1, columns = 2): T[] {
  const ordered = [...packStack(items, columns)].sort(byPosition);
  const from = ordered.findIndex((i) => i.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ordered.length) return items;
  const [moved] = ordered.splice(from, 1);
  ordered.splice(to, 0, moved!);
  // Positions follow the new order: each item takes the sort key of its index.
  return packStack(ordered.map((item, index) => ({ ...item, x: 0, y: index })), columns);
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

/**
 * A saved layout shown inside `columns`. A layout saved on a wider screen has widgets past the last column; those are
 * put in the first free place (narrowed if they are wider than the grid) and everything that already fits stays where it
 * is, so no two widgets share a cell. Nothing is saved: on the wide screen the layout is still the one that was saved.
 */
export function fitToColumns<T extends Box>(items: T[], columns: number): T[] {
  const inside = items.filter((i) => i.x + i.w <= columns);
  if (inside.length === items.length) return items;
  if (inside.some((a, n) => inside.some((b, m) => n < m && collides(a, b)))) return reflow(items, columns);
  const placed: T[] = [...inside];
  const moved = new Map<string, T>();
  for (const item of items.filter((i) => i.x + i.w > columns).sort(byPosition)) {
    const w = Math.min(item.w, columns);
    const next = { ...item, w, ...freeSlot(placed, w, item.h, columns) };
    placed.push(next);
    moved.set(item.id, next);
  }
  return items.map((i) => moved.get(i.id) ?? i);
}

/** Rows a widget with nothing to show keeps: one when it is wide enough to say so beside its title, two otherwise. */
export function collapsedHeight(w: number): number {
  return w >= 3 ? 1 : 2;
}

/** The layout with the widgets that have nothing to show shrunk to a line, and the ones below them moved up. */
export function collapseEmpty<T extends Box>(items: T[], empty: ReadonlySet<string>): T[] {
  if (empty.size === 0) return items;
  return compact(items.map((i) => (empty.has(i.id) ? { ...i, h: Math.min(i.h, collapsedHeight(i.w)) } : i)));
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
