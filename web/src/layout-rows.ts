import type { WidgetId } from './api.ts';
import { packStack, reflow, type Box } from './grid.ts';

const reading = (a: Box, b: Box) => a.y - b.y || a.x - b.x;

export interface WidgetRow<T> {
  widget: WidgetId;
  /** The item on the dashboard, or null when the widget is hidden. */
  item: T | null;
  canUp: boolean;
  canDown: boolean;
}

/** Every widget for the customize list: the ones on the dashboard in reading order, then the hidden ones. */
export function widgetRows<T extends Box & { widget: WidgetId }>(items: T[], all: readonly WidgetId[], narrow: boolean): Array<WidgetRow<T>> {
  const shown = [...(narrow ? packStack(items) : items)].sort(reading);
  const rows: Array<WidgetRow<T>> = shown.map((item, n) => ({ widget: item.widget, item, canUp: n > 0, canDown: n < shown.length - 1 }));
  for (const widget of all) if (!items.some((i) => i.widget === widget)) rows.push({ widget, item: null, canUp: false, canDown: false });
  return rows;
}

/** A widget moved one step in reading order on the wide grid (-1 up, 1 down); the others are packed again in that order. */
export function shiftReading<T extends Box>(items: T[], id: string, delta: -1 | 1, columns: number): T[] {
  const ordered = [...items].sort(reading);
  const from = ordered.findIndex((i) => i.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ordered.length) return items;
  const [moved] = ordered.splice(from, 1);
  ordered.splice(to, 0, moved!);
  // Each widget takes the sort key of its new index, then the grid packs them in that order.
  const packed = reflow(ordered.map((item, index) => ({ ...item, x: 0, y: index })), columns);
  return items.map((i) => packed.find((p) => p.id === i.id)!);
}
