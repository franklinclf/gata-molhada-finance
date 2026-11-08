import type { Option } from './select-model.ts';

interface CategoryLike {
  name: string;
  parent: string | null;
  count: number;
  custom: boolean;
}

export const OTHER_GROUP = 'Sem grupo';

/** Money that moves rather than gets spent. These pile up the biggest counts, so they stay out of the "most used" shortcut unless a transaction suggests them. */
const MOVEMENT = new Set(['Transferências', 'Transferência entre minhas contas', 'Pagamento de fatura']);

/**
 * Categories as options, under their group. Groups come in order of how much they are used, and so do the categories
 * inside them. The ones that stand alone go last, under "Sem grupo". With `top`, a first group repeats the categories
 * suggested for the transaction at hand and then the ones used most, so the usual pick does not need a search.
 */
export function categoryOptions(items: readonly CategoryLike[], { suggested = [], top = 0 }: { suggested?: readonly string[]; top?: number } = {}): Option[] {
  const weight = new Map<string, number>();
  for (const c of items) {
    const key = c.parent ?? OTHER_GROUP;
    weight.set(key, (weight.get(key) ?? 0) + c.count);
  }
  const groups = [...weight.keys()].sort((a, b) => (a === OTHER_GROUP ? 1 : b === OTHER_GROUP ? -1 : (weight.get(b) ?? 0) - (weight.get(a) ?? 0) || a.localeCompare(b)));
  const hint = (c: CategoryLike) => (c.count > 0 ? String(c.count) : c.custom ? 'sua' : undefined);
  const listed = groups.flatMap((group) =>
    items
      .filter((c) => (c.parent ?? OTHER_GROUP) === group)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .map((c): Option => ({ value: c.name, label: c.name, group, hint: hint(c) })),
  );
  const first = suggested.flatMap((name) => items.filter((c) => c.name === name));
  const usual = [...items].filter((c) => c.count > 0 && !MOVEMENT.has(c.name) && !first.includes(c)).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const shortcuts = [...first, ...usual.slice(0, top)];
  if (shortcuts.length === 0) return listed;
  const label = first.length > 0 ? 'Sugeridas e mais usadas' : 'Mais usadas';
  return [...shortcuts.map((c): Option => ({ value: c.name, label: c.name, group: label, hint: hint(c), shortcut: true })), ...listed];
}

/** The groups that exist, as options, for choosing where a category goes. */
export function groupOptions(items: readonly CategoryLike[]): Option[] {
  return [...new Set(items.map((c) => c.parent).filter((g): g is string => g !== null))].sort((a, b) => a.localeCompare(b)).map((g) => ({ value: g, label: g }));
}
