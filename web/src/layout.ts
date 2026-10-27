import type { Layout } from '../../src/api/layout.ts';

export function moveWidget(layout: Layout, id: string, direction: -1 | 1): Layout {
  const index = layout.widgets.findIndex((w) => w.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= layout.widgets.length) return layout;
  const widgets = [...layout.widgets];
  [widgets[index], widgets[target]] = [widgets[target]!, widgets[index]!];
  return { widgets };
}

export function toggleWidget(layout: Layout, id: string): Layout {
  return { widgets: layout.widgets.map((w) => (w.id === id ? { ...w, hidden: !w.hidden } : w)) };
}
