import type { Option } from './select-model.ts';

interface CategoryLike {
  name: string;
  parent: string | null;
  count: number;
  custom: boolean;
}

export const OTHER_GROUP = 'Sem grupo';

/**
 * Categories as options, under their group. Groups come in order of how much they are used, and so do the categories
 * inside them. The ones that stand alone go last, under "Sem grupo".
 */
export function categoryOptions(items: readonly CategoryLike[]): Option[] {
  const weight = new Map<string, number>();
  for (const c of items) {
    const key = c.parent ?? OTHER_GROUP;
    weight.set(key, (weight.get(key) ?? 0) + c.count);
  }
  const groups = [...weight.keys()].sort((a, b) => (a === OTHER_GROUP ? 1 : b === OTHER_GROUP ? -1 : (weight.get(b) ?? 0) - (weight.get(a) ?? 0) || a.localeCompare(b)));
  return groups.flatMap((group) =>
    items
      .filter((c) => (c.parent ?? OTHER_GROUP) === group)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .map((c): Option => ({ value: c.name, label: c.name, group, hint: c.custom ? 'sua' : c.count > 0 ? String(c.count) : undefined })),
  );
}

/** The groups that exist, as options, for choosing where a category goes. */
export function groupOptions(items: readonly CategoryLike[]): Option[] {
  return [...new Set(items.map((c) => c.parent).filter((g): g is string => g !== null))].sort((a, b) => a.localeCompare(b)).map((g) => ({ value: g, label: g }));
}
