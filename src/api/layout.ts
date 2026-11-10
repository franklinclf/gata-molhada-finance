import type { Store } from '../store/store.ts';

export const WIDGET_IDS = ['outlook', 'balances', 'cards', 'cashflow', 'spending', 'installments', 'budget', 'networth', 'goals', 'summary', 'upcoming', 'calendar', 'trend', 'review', 'recent', 'freshness', 'findings'] as const;
export type WidgetId = (typeof WIDGET_IDS)[number];

/** Columns of the reference desktop grid (see COLUMNS in web/src/grid.ts). */
export const GRID_COLUMNS = 13;
/** A wide screen shows more columns; a saved widget may sit in any of them. */
export const MAX_GRID_COLUMNS = 36;
/** The phone layout is a stack with two half-width columns: a widget takes one or both. */
export const MOBILE_COLUMNS = 2;
/** A viewport narrower than this (px) uses the mobile layout; wider ones use the desktop layout. The web app reads it for its media query. */
export const MOBILE_BREAKPOINT = 700;
const MAX_ITEMS = 40;
const MAX_ROWS = 500;
const MAX_HEIGHT = 40;

/** The environments that keep a layout of their own. */
export const DEVICES = ['desktop', 'mobile'] as const;
export type Device = (typeof DEVICES)[number];
export const isDevice = (value: unknown): value is Device => typeof value === 'string' && (DEVICES as readonly string[]).includes(value);

type Size = { w: number; h: number };

/**
 * Size a new widget starts with on the desktop, in grid cells (13 columns, 72 px rows).
 * Widgets that are one figure start small (a tile 3 wide and 2 tall shows the figure and one line); the rest keep room for a chart or a list.
 */
export const DEFAULT_SIZES: Record<WidgetId, Size> = {
  outlook: { w: 4, h: 7 },
  balances: { w: 3, h: 2 },
  cards: { w: 4, h: 6 },
  cashflow: { w: 4, h: 6 },
  spending: { w: 4, h: 6 },
  installments: { w: 3, h: 2 },
  budget: { w: 4, h: 5 },
  networth: { w: 3, h: 2 },
  goals: { w: 4, h: 4 },
  summary: { w: 3, h: 2 },
  upcoming: { w: 4, h: 6 },
  calendar: { w: 4, h: 7 },
  trend: { w: 4, h: 5 },
  review: { w: 2, h: 2 },
  recent: { w: 4, h: 6 },
  freshness: { w: 2, h: 2 },
  findings: { w: 2, h: 2 },
};

/**
 * Smallest size of each widget, desktop columns. A widget that is one figure or one status fits 1x1 (a short title and the figure); the other lists and charts fit 2x1 (title and figure); the ones that need a list or a calendar to make sense start higher.
 * The phone layout also uses the height (compact below 3 rows) and a width of 1 or 2 half columns.
 */
export const MIN_SIZES: Record<WidgetId, Size> = {
  outlook: { w: 2, h: 2 },
  balances: { w: 1, h: 1 },
  cards: { w: 2, h: 1 },
  cashflow: { w: 2, h: 1 },
  spending: { w: 2, h: 1 },
  installments: { w: 1, h: 1 },
  budget: { w: 2, h: 1 },
  networth: { w: 1, h: 1 },
  goals: { w: 2, h: 1 },
  summary: { w: 1, h: 1 },
  upcoming: { w: 2, h: 1 },
  calendar: { w: 3, h: 4 },
  trend: { w: 2, h: 2 },
  review: { w: 1, h: 1 },
  recent: { w: 2, h: 2 },
  freshness: { w: 1, h: 1 },
  findings: { w: 1, h: 1 },
};

/** The phone stack in reading order, with each widget's width in half columns (2 = full width) and height: 2 rows or less is the compact look. */
const MOBILE_DEFAULT: Array<[WidgetId, number, number]> = [
  ['cards', 2, 6],
  ['outlook', 2, 6],
  ['balances', 2, 2],
  ['upcoming', 2, 5],
  ['summary', 1, 2],
  ['networth', 1, 2],
  ['installments', 1, 2],
  ['review', 1, 2],
  ['findings', 1, 2],
  ['freshness', 1, 2],
  ['cashflow', 2, 6],
  ['spending', 2, 6],
  ['budget', 2, 5],
  ['goals', 2, 4],
  ['calendar', 2, 7],
  ['trend', 2, 5],
  ['recent', 2, 6],
];

/** Size a widget starts with when it is added to the phone layout. */
export const MOBILE_SIZES: Record<WidgetId, Size> = Object.fromEntries(MOBILE_DEFAULT.map(([id, w, h]) => [id, { w, h }])) as Record<WidgetId, Size>;

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

/** The desktop layout keeps the key it always had, so a layout saved before the phone one existed still loads. */
const KEYS: Record<Device, string> = { desktop: 'dashboard_layout', mobile: 'dashboard_layout_mobile' };
const isWidgetId = (value: unknown): value is WidgetId => typeof value === 'string' && (WIDGET_IDS as readonly string[]).includes(value);
const isInt = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/** Puts widgets side by side, left to right and then down. */
function flow(entries: Array<[WidgetId, number, number]>, columns: number): LayoutItem[] {
  const items: LayoutItem[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const [widget, w, h] of entries) {
    if (x + w > columns) {
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

const sized = (widgets: readonly WidgetId[], sizes: Record<WidgetId, Size> = DEFAULT_SIZES): Array<[WidgetId, number, number]> => widgets.map((id) => [id, sizes[id].w, sizes[id].h]);

/**
 * Desktop default, 13 columns, every row full: a band of four figures (4+3+3+3), then rows of 4+4+5 and 4+4+4 plus a rail of three 1x2 tiles,
 * 4+4+5 again, and the recent transactions across the whole width.
 */
const DESKTOP_DEFAULT: Array<[WidgetId, number, number, number, number]> = [
  ['balances', 0, 0, 4, 2],
  ['summary', 4, 0, 3, 2],
  ['networth', 7, 0, 3, 2],
  ['installments', 10, 0, 3, 2],
  ['outlook', 0, 2, 4, 7],
  ['upcoming', 4, 2, 4, 7],
  ['calendar', 8, 2, 5, 7],
  ['cards', 0, 9, 4, 6],
  ['cashflow', 4, 9, 4, 6],
  ['spending', 8, 9, 4, 6],
  ['review', 12, 9, 1, 2],
  ['findings', 12, 11, 1, 2],
  ['freshness', 12, 13, 1, 2],
  ['budget', 0, 15, 4, 5],
  ['goals', 4, 15, 4, 5],
  ['trend', 8, 15, 5, 5],
  ['recent', 0, 20, 13, 5],
];

export function defaultLayout(device: Device = 'desktop'): Layout {
  return device === 'mobile' ? { version: 2, items: flow(MOBILE_DEFAULT, MOBILE_COLUMNS) } : { version: 2, items: DESKTOP_DEFAULT.map(([widget, x, y, w, h]) => ({ id: widget, widget, x, y, w, h })) };
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
export function parseLayout(value: unknown, device: Device = 'desktop'): Layout | null {
  const columns = device === 'mobile' ? MOBILE_COLUMNS : MAX_GRID_COLUMNS;
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
    return { version: 2, items: device === 'mobile' ? flow(sized(order, MOBILE_SIZES), MOBILE_COLUMNS) : flow(sized(order), GRID_COLUMNS) };
  }

  if (record.version !== 2 || !Array.isArray(record.items) || record.items.length > MAX_ITEMS) return null;
  const ids = new Set<string>();
  const items: LayoutItem[] = [];
  for (const raw of record.items) {
    if (raw === null || typeof raw !== 'object') return null;
    const { id, widget, x, y, w, h, config } = raw as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(id) || ids.has(id)) return null;
    if (!isInt(x, 0, columns - 1) || !isInt(y, 0, MAX_ROWS) || !isInt(w, 1, columns) || !isInt(h, 1, MAX_HEIGHT) || x + w > columns) return null;
    const parsedConfig = parseConfig(config);
    if (parsedConfig === null) return null;
    if (!isWidgetId(widget)) continue;
    // A widget cannot be saved smaller than its minimum (the phone layout has its own sizes).
    if (device === 'desktop' && (w < MIN_SIZES[widget].w || h < MIN_SIZES[widget].h)) return null;
    ids.add(id);
    items.push(parsedConfig === undefined ? { id, widget, x, y, w, h } : { id, widget, x, y, w, h, config: parsedConfig });
  }
  return { version: 2, items };
}

/** The saved layout of this environment, or its default when nothing valid is saved. */
export function loadLayout(store: Store, device: Device = 'desktop'): Layout {
  const raw = store.getSetting(KEYS[device]);
  if (raw === null) return defaultLayout(device);
  try {
    return parseLayout(JSON.parse(raw), device) ?? defaultLayout(device);
  } catch {
    return defaultLayout(device);
  }
}

export function saveLayout(store: Store, layout: Layout, now: Date, device: Device = 'desktop'): void {
  store.setSetting(KEYS[device], JSON.stringify(layout), now.toISOString());
}
