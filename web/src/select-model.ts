/** One choice in a Select. `group` puts it under a heading; options with the same group sit together, in the order the groups first appear. */
export interface Option {
  value: string;
  label: string;
  group?: string;
  /** Small text on the right, such as a count. */
  hint?: string;
  /** Extra words the search also looks in. */
  keywords?: string;
}

export type Row = { kind: 'group'; label: string } | { kind: 'option'; option: Option };

export const fold = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** The options that contain every word of the query, in label, group or keywords. Accents and case do not matter. */
export function filterOptions(options: readonly Option[], query: string): Option[] {
  const words = fold(query).split(' ').filter(Boolean);
  if (words.length === 0) return [...options];
  return options.filter((o) => {
    const text = fold(`${o.label} ${o.group ?? ''} ${o.keywords ?? ''}`);
    return words.every((w) => text.includes(w));
  });
}

/** Rows to draw: a heading before the first option of each group. Options with no group come first, without a heading. */
export function toRows(options: readonly Option[]): Row[] {
  const order: string[] = [];
  const byGroup = new Map<string, Option[]>();
  for (const o of options) {
    const key = o.group ?? '';
    if (!byGroup.has(key)) {
      byGroup.set(key, []);
      order.push(key);
    }
    byGroup.get(key)!.push(o);
  }
  order.sort((a, b) => (a === '' ? -1 : b === '' ? 1 : 0));
  return order.flatMap((key) => [...(key === '' ? [] : [{ kind: 'group', label: key } as Row]), ...byGroup.get(key)!.map((option): Row => ({ kind: 'option', option }))]);
}

/** Moves the highlight by `delta` among `count` options, wrapping at the ends. */
export function step(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((current + delta) % count) + count) % count;
}

/** True when the typed text can become a new option: it is not empty and no option already has that name. */
export function canCreate(options: readonly Option[], query: string): boolean {
  const text = fold(query);
  return text !== '' && !options.some((o) => fold(o.label) === text || fold(o.value) === text);
}
