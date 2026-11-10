import { useEffect, useState } from 'preact/hooks';
import type { WidgetId } from './api.ts';

export interface PanelRow {
  widget: WidgetId;
  title: string;
  /** Id of the widget on the dashboard, or null while it is hidden. */
  id: string | null;
  /** Value of the size list, '' when the widget has a size that is not in the list. */
  size: string;
  sizes: Array<[string, string]>;
  canUp: boolean;
  canDown: boolean;
}

/** What the dashboard offers to the customize panel in the menu. It exists only while the dashboard is the open page. */
export interface DashControls {
  deviceName: string;
  /** The phone has no "Largura total". */
  canWiden: boolean;
  wide: boolean;
  setWide: (on: boolean) => void;
  rows: PanelRow[];
  toggle: (row: PanelRow) => void;
  setSize: (row: PanelRow, value: string) => void;
  shift: (row: PanelRow, delta: -1 | 1) => void;
  /** Null when the grid has no more than 12 columns. */
  spread: (() => void) | null;
  restore: () => void;
}

let current: DashControls | null = null;
const listeners = new Set<() => void>();

/** The dashboard publishes its controls when they change, and withdraws them with null when it closes. */
export function publishControls(next: DashControls | null) {
  current = next;
  listeners.forEach((l) => l());
}

export function useControls(): DashControls | null {
  const [value, setValue] = useState(current);
  useEffect(() => {
    const on = () => setValue(current);
    listeners.add(on);
    on();
    return () => void listeners.delete(on);
  }, []);
  return value;
}
