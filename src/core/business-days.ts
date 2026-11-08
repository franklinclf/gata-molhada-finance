/** Brazilian bank business days: Monday to Friday, except the national holidays on which banks are closed. Days are YYYY-MM-DD. */
import { addDays } from './dates.ts';

/** What a payment fixed on a day of the month does when that day is not a business day. */
export type NonBusinessRule = 'previous' | 'next' | 'keep';

export const NON_BUSINESS_RULES: readonly NonBusinessRule[] = ['previous', 'next', 'keep'];

/** Holidays on the same day every year, as MM-DD. */
const FIXED_HOLIDAYS: Array<[string, string]> = [
  ['01-01', 'Confraternização Universal'],
  ['04-21', 'Tiradentes'],
  ['05-01', 'Dia do Trabalho'],
  ['09-07', 'Independência'],
  ['10-12', 'Nossa Senhora Aparecida'],
  ['11-02', 'Finados'],
  ['11-15', 'Proclamação da República'],
  ['11-20', 'Consciência Negra'],
  ['12-25', 'Natal'],
];

/** Easter Sunday of a year (Gregorian calendar, Meeus/Jones/Butcher algorithm). */
export function easterOf(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const cache = new Map<number, Map<string, string>>();

/** The bank holidays of a year (day to name): the fixed ones and the ones counted from Easter. */
export function bankHolidays(year: number): Map<string, string> {
  const known = cache.get(year);
  if (known) return known;
  const easter = easterOf(year);
  const holidays = new Map<string, string>(FIXED_HOLIDAYS.map(([md, name]) => [`${year}-${md}`, name]));
  holidays.set(addDays(easter, -48), 'Carnaval');
  holidays.set(addDays(easter, -47), 'Carnaval');
  holidays.set(addDays(easter, -2), 'Sexta-feira Santa');
  holidays.set(addDays(easter, 60), 'Corpus Christi');
  cache.set(year, holidays);
  return holidays;
}

const WEEKDAY_NAMES = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const weekdayOf = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();

export function isBusinessDay(day: string): boolean {
  const weekday = weekdayOf(day);
  return weekday !== 0 && weekday !== 6 && !bankHolidays(Number(day.slice(0, 4))).has(day);
}

/** The closest business day on or before `day`. */
export function previousBusinessDay(day: string): string {
  let d = day;
  while (!isBusinessDay(d)) d = addDays(d, -1);
  return d;
}

/** The closest business day on or after `day`. */
export function nextBusinessDay(day: string): string {
  let d = day;
  while (!isBusinessDay(d)) d = addDays(d, 1);
  return d;
}

/** Where a payment fixed on `day` falls under the rule. */
export function moveToBusinessDay(day: string, rule: NonBusinessRule): string {
  return rule === 'previous' ? previousBusinessDay(day) : rule === 'next' ? nextBusinessDay(day) : day;
}

/** Why a day is not a business day, as in "dia 10 cai no sábado": "no sábado", "no domingo" or "no feriado (Natal)". Null on a business day. */
export function nonBusinessReason(day: string): string | null {
  if (isBusinessDay(day)) return null;
  const holiday = bankHolidays(Number(day.slice(0, 4))).get(day);
  return holiday ? `no feriado (${holiday})` : `no ${WEEKDAY_NAMES[weekdayOf(day)]}`;
}
