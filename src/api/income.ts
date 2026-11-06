import type { IncomeItem, Store } from '../store/store.ts';
import { cleanCategoryName } from './mutations.ts';

export type IncomeResult<T = Record<string, never>> = { ok: true; value: T } | { ok: false; status: number; error: string };

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_AMOUNT = 1_000_000_000;
const MAX_ITEMS = 30;

/** Reads the typed fields of an income item, or says what is wrong with them. */
function read(input: Record<string, unknown>): IncomeResult<Omit<IncomeItem, 'id'>> {
  const name = cleanCategoryName(input.name);
  if (name === null) return { ok: false, status: 400, error: 'name must be text of 1 to 60 characters' };
  const amount = input.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) return { ok: false, status: 400, error: 'amount must be a whole number of cents above zero' };
  const day = input.dayOfMonth;
  if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 31) return { ok: false, status: 400, error: 'dayOfMonth must be 1 to 31' };
  const month = (value: unknown, label: string): IncomeResult<string | null> => {
    if (value === undefined || value === null || value === '') return { ok: true, value: null };
    return typeof value === 'string' && MONTH.test(value) ? { ok: true, value } : { ok: false, status: 400, error: `${label} must be YYYY-MM` };
  };
  const from = month(input.fromMonth, 'fromMonth');
  if (!from.ok) return from;
  const until = month(input.untilMonth, 'untilMonth');
  if (!until.ok) return until;
  if (from.value !== null && until.value !== null && from.value > until.value) return { ok: false, status: 400, error: 'fromMonth must not be after untilMonth' };
  return { ok: true, value: { name, amount, dayOfMonth: day, fromMonth: from.value, untilMonth: until.value } };
}

export function saveIncome(store: Store, id: number | null, input: Record<string, unknown>, now: Date): IncomeResult<{ id: number }> {
  const item = read(input);
  if (!item.ok) return item;
  const items = store.listIncome();
  if (id === null && items.length >= MAX_ITEMS) return { ok: false, status: 400, error: `at most ${MAX_ITEMS} income items` };
  if (id !== null && !items.some((i) => i.id === id)) return { ok: false, status: 404, error: 'not_found' };
  return { ok: true, value: { id: store.saveIncome({ ...item.value, ...(id !== null ? { id } : {}) }, now.toISOString()) } };
}

export function deleteIncome(store: Store, id: number): IncomeResult {
  return store.deleteIncome(id) ? { ok: true, value: {} } : { ok: false, status: 404, error: 'not_found' };
}

/** What the registered items bring in a month (YYYY-MM). */
export function incomeIn(items: readonly IncomeItem[], month: string): number {
  return items.filter((i) => (i.fromMonth === null || i.fromMonth <= month) && (i.untilMonth === null || i.untilMonth >= month)).reduce((s, i) => s + i.amount, 0);
}
