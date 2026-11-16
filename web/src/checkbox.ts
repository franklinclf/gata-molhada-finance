import type { CheckState } from './inst-tree.ts';

/** The state of a "select all" box: all of the rows, some of them, or none. */
export function boxState(selected: number, total: number): CheckState {
  if (selected <= 0 || total <= 0) return 'off';
  return selected >= total ? 'on' : 'some';
}

/** What a click does: a partly checked box (and an unchecked one) turns fully on, a full one turns off. */
export const nextCheck = (state: CheckState): boolean => state !== 'on';

/** The value for aria-checked. */
export const ariaChecked = (state: CheckState): 'true' | 'false' | 'mixed' => (state === 'on' ? 'true' : state === 'some' ? 'mixed' : 'false');

