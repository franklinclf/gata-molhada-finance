import { brl, monthName } from './format.ts';

const abbreviation = (key: string): string => monthName(key).slice(0, 3);

/** The months a run of bills covers, as "mar a set"; the year is written only when the run crosses it. */
export function monthSpan(fromKey: string, toKey: string): string {
  if (fromKey === toKey) return abbreviation(fromKey);
  if (fromKey.slice(0, 4) === toKey.slice(0, 4)) return `${abbreviation(fromKey)} a ${abbreviation(toKey)}`;
  return `${monthName(fromKey)} a ${monthName(toKey)}`;
}

/** The difference between the app and the bank in words, so the sign never has to be read: "o app tem R$ 250,58 a menos que o banco". */
export function gapText(gap: number, hidden = false): string {
  return `o app tem ${brl(Math.abs(gap), hidden)} a ${gap < 0 ? 'menos' : 'mais'} que o banco`;
}

/** The same, short enough for the value column of a table: "R$ 250,58 a menos no app". */
export function gapShort(gap: number, hidden = false): string {
  return `${brl(Math.abs(gap), hidden)} a ${gap < 0 ? 'menos' : 'mais'} no app`;
}
