import type { Store } from '../store/store.ts';

export const WIDGET_IDS = ['balances', 'cards', 'cashflow', 'spending', 'installments', 'recent', 'freshness', 'findings'] as const;
export type WidgetId = (typeof WIDGET_IDS)[number];

export interface WidgetSlot {
  id: WidgetId;
  hidden: boolean;
}

export interface Layout {
  widgets: WidgetSlot[];
}

const KEY = 'dashboard_layout';
const isWidgetId = (value: unknown): value is WidgetId => typeof value === 'string' && (WIDGET_IDS as readonly string[]).includes(value);

/** Keeps the order given, drops unknown and repeated ids, and appends widgets that are missing so new ones show up. Returns null when the shape is wrong. */
export function parseLayout(value: unknown): Layout | null {
  if (value === null || typeof value !== 'object') return null;
  const widgets = (value as { widgets?: unknown }).widgets;
  if (!Array.isArray(widgets) || widgets.length > 50) return null;
  const seen = new Set<WidgetId>();
  const result: WidgetSlot[] = [];
  for (const item of widgets) {
    if (item === null || typeof item !== 'object') return null;
    const { id, hidden } = item as { id?: unknown; hidden?: unknown };
    if (typeof hidden !== 'boolean') return null;
    if (!isWidgetId(id) || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, hidden });
  }
  for (const id of WIDGET_IDS) if (!seen.has(id)) result.push({ id, hidden: false });
  return { widgets: result };
}

export function defaultLayout(): Layout {
  return { widgets: WIDGET_IDS.map((id) => ({ id, hidden: false })) };
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
