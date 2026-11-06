import { useEffect, useState } from 'preact/hooks';

/** Every section of the top bar of a wide screen, in the default order. */
export const NAV: Array<[string, string]> = [
  ['', 'Dashboard'],
  ['transactions', 'Transações'],
  ['spending', 'Gastos'],
  ['cards', 'Cartões'],
  ['budgets', 'Orçamento'],
  ['accounts', 'Contas'],
  ['chat', 'Analista'],
  ['goals', 'Metas'],
  ['calendar', 'Calendário'],
  ['settings', 'Ajustes'],
];

const KEY = 'gmf-nav-order';

/** The saved order with unknown ids dropped and any new section placed at the end. */
export function applyNavOrder(saved: string[], known: string[]): string[] {
  return [...saved.filter((id, i) => known.includes(id) && saved.indexOf(id) === i), ...known.filter((id) => !saved.includes(id))];
}

/** Moves one id up (-1) or down (+1); at the edge the list stays as it was. */
export function shiftNavItem(ids: string[], id: string, delta: -1 | 1): string[] {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** Puts `id` right before `before`, for the drag on a wide screen. */
export function moveNavItem(ids: string[], id: string, before: string): string[] {
  if (id === before || !ids.includes(id) || !ids.includes(before)) return ids;
  const next = ids.filter((x) => x !== id);
  next.splice(next.indexOf(before), 0, id);
  return next;
}

function read(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

let saved: string[] | null = null;
const listeners = new Set<() => void>();

function write(next: string[]): void {
  saved = next;
  if (next.length === 0) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, JSON.stringify(next));
  listeners.forEach((l) => l());
}

/** The top bar order, shared by the bar (drag) and Settings, Appearance (buttons), so both stay in step. */
export function useNavOrder() {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
  saved ??= read();
  const known = NAV.map(([id]) => id);
  const ids = applyNavOrder(saved, known);
  return {
    ids,
    items: ids.map((id) => NAV.find(([x]) => x === id)!),
    custom: saved.length > 0,
    move: (id: string, before: string) => write(moveNavItem(ids, id, before)),
    shift: (id: string, delta: -1 | 1) => write(shiftNavItem(ids, id, delta)),
    reset: () => write([]),
  };
}
