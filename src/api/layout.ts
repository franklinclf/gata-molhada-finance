import type { Store } from '../store/store.ts';

export const WIDGET_IDS = ['balances', 'cards', 'cashflow', 'spending', 'installments', 'budget', 'networth', 'goals', 'summary', 'upcoming', 'calendar', 'trend', 'review', 'recent', 'freshness', 'findings'] as const;
export type WidgetId = (typeof WIDGET_IDS)[number];

export const GRID_COLUMNS = 12;
const MAX_ITEMS = 40;
const MAX_ROWS = 500;
const MAX_HEIGHT = 40;

/** Size a new widget starts with, in grid cells (12 columns). */
export const DEFAULT_SIZES: Record<WidgetId, { w: number; h: number }> = {
  balances: { w: 4, h: 5 },
  cards: { w: 4, h: 6 },
  cashflow: { w: 4, h: 5 },
  spending: { w: 4, h: 6 },
  installments: { w: 4, h: 5 },
  budget: { w: 4, h: 5 },
  networth: { w: 4, h: 5 },
  goals: { w: 4, h: 5 },
  summary: { w: 4, h: 4 },
  upcoming: { w: 4, h: 6 },
  calendar: { w: 4, h: 7 },
  trend: { w: 4, h: 5 },
  review: { w: 4, h: 4 },
  recent: { w: 4, h: 6 },
  freshness: { w: 4, h: 5 },
  findings: { w: 4, h: 5 },
};

/** One widget on the dashboard. The same widget can appear more than once, each with its own settings. */
export interface LayoutItem {
  id: string;
  widget: WidgetId;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Settings of this widget, for example its period. */
  config?: Record<string, string>;
}

export interface Layout {
  version: 2;
  items: LayoutItem[];
}

const KEY = 'dashboard_layout';
const isWidgetId = (value: unknown): value is WidgetId => typeof value === 'string' && (WIDGET_IDS as readonly string[]).includes(value);
const isInt = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/** Puts widgets side by side, left to right and then down. */
function flow(widgets: WidgetId[]): LayoutItem[] {
  const items: LayoutItem[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const widget of widgets) {
    const { w, h } = DEFAULT_SIZES[widget];
    if (x + w > GRID_COLUMNS) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    items.push({ id: widget, widget, x, y, w, h });
    x += w;
    rowHeight = Math.max(rowHeight, h);
  }
  return items;
}

export function defaultLayout(): Layout {
  return { version: 2, items: flow([...WIDGET_IDS]) };
}

function parseConfig(value: unknown): Record<string, string> | undefined | null {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 10) return null;
  const out: Record<string, string> = {};
  for (const [key, v] of entries) {
    if (typeof v !== 'string' || v.length > 60 || key.length > 30) return null;
    out[key] = v;
  }
  return out;
}

/**
 * Accepts the current layout, and the older list of { id, hidden } (hidden ones are dropped, the rest are placed in order).
 * Returns null when the shape is wrong. Unknown widgets are dropped.
 */
export function parseLayout(value: unknown): Layout | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as { version?: unknown; items?: unknown; widgets?: unknown };

  if (Array.isArray(record.widgets) && record.items === undefined) {
    const seen = new Set<WidgetId>();
    const order: WidgetId[] = [];
    for (const entry of record.widgets) {
      if (entry === null || typeof entry !== 'object') return null;
      const { id, hidden } = entry as { id?: unknown; hidden?: unknown };
      if (typeof hidden !== 'boolean') return null;
      if (isWidgetId(id) && !seen.has(id) && !hidden) {
        seen.add(id);
        order.push(id);
      }
    }
    return { version: 2, items: flow(order) };
  }

  if (record.version !== 2 || !Array.isArray(record.items) || record.items.length > MAX_ITEMS) return null;
  const ids = new Set<string>();
  const items: LayoutItem[] = [];
  for (const raw of record.items) {
    if (raw === null || typeof raw !== 'object') return null;
    const { id, widget, x, y, w, h, config } = raw as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(id) || ids.has(id)) return null;
    if (!isInt(x, 0, GRID_COLUMNS - 1) || !isInt(y, 0, MAX_ROWS) || !isInt(w, 1, GRID_COLUMNS) || !isInt(h, 1, MAX_HEIGHT) || x + w > GRID_COLUMNS) return null;
    const parsedConfig = parseConfig(config);
    if (parsedConfig === null) return null;
    if (!isWidgetId(widget)) continue;
    ids.add(id);
    items.push(parsedConfig === undefined ? { id, widget, x, y, w, h } : { id, widget, x, y, w, h, config: parsedConfig });
  }
  return { version: 2, items };
}

export function loadLayout(store: Store): Layout {
  const raw = store.getSetting(KEY);
  if (raw === null) return defaultLayout();
  try {
    return parseLayout(JSON.parse(raw)) ?? defaultLayout();
  } catch {
    return defaultLayout();
  }
}

export function saveLayout(store: Store, layout: Layout, now: Date): void {
  store.setSetting(KEY, JSON.stringify(layout), now.toISOString());
}
