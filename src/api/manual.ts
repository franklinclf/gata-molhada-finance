import { localDay } from '../core/time.ts';
import { DEFAULT_DATA_START, manualId, runReconciliation } from '../reconcile/run.ts';
import type { ManualTransaction, Store } from '../store/store.ts';

export type ManualResult<T = Record<string, never>> = { ok: true; value: T } | { ok: false; status: number; error: string };

const MAX_AMOUNT = 100_000_000_000;
const MAX_TEXT = 200;
const MAX_NOTES = 1000;

export const isManualId = (id: string): boolean => /^man_\d+$/.test(id);
export const manualNumber = (id: string): number => Number(id.slice(4));

function parse(store: Store, body: Record<string, unknown>, now: Date, current?: ManualTransaction): ManualResult<Omit<ManualTransaction, 'id'>> {
  const merged = { ...(current ?? {}), ...body } as Record<string, unknown>;
  const accountId = merged.accountId;
  if (typeof accountId !== 'string' || !store.listCanonicalAccounts().some((a) => a.id === accountId)) return { ok: false, status: 400, error: 'accountId must be one of your accounts' };
  const day = merged.day;
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return { ok: false, status: 400, error: 'day must look like 2026-10-28' };
  if (day < DEFAULT_DATA_START) return { ok: false, status: 400, error: `the app only keeps data from ${DEFAULT_DATA_START}` };
  if (day > localDay(now.toISOString())) return { ok: false, status: 400, error: 'a transaction cannot be dated in the future' };
  const amount = merged.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount === 0 || Math.abs(amount) > MAX_AMOUNT) return { ok: false, status: 400, error: 'amount must be a non-zero whole number of cents' };
  const description = typeof merged.description === 'string' ? merged.description.trim().replace(/\s+/g, ' ') : '';
  if (description.length < 1 || description.length > MAX_TEXT) return { ok: false, status: 400, error: `description must be text of 1 to ${MAX_TEXT} characters` };
  const category = typeof merged.category === 'string' && merged.category.trim() !== '' ? merged.category.trim().replace(/\s+/g, ' ') : null;
  if (category !== null && category.length > 60) return { ok: false, status: 400, error: 'category must be at most 60 characters' };
  const notes = typeof merged.notes === 'string' && merged.notes.trim() !== '' ? merged.notes.trim() : null;
  if (notes !== null && notes.length > MAX_NOTES) return { ok: false, status: 400, error: `notes must be at most ${MAX_NOTES} characters` };
  return { ok: true, value: { accountId, day, amount, description, category, notes } };
}

function rebuild(store: Store, now: Date): void {
  runReconciliation(store, { now: () => now });
}

export function createManual(store: Store, body: Record<string, unknown>, now: Date): ManualResult<{ id: string }> {
  const parsed = parse(store, body, now);
  if (!parsed.ok) return parsed;
  const saved = store.saveManualTransaction(parsed.value, now.toISOString());
  if (saved.category !== null && !store.listCustomCategories().includes(saved.category)) store.addCustomCategory(saved.category, now.toISOString());
  rebuild(store, now);
  return { ok: true, value: { id: manualId(saved.id) } };
}

export function updateManual(store: Store, id: string, body: Record<string, unknown>, now: Date): ManualResult {
  const current = isManualId(id) ? store.listManualTransactions().find((m) => m.id === manualNumber(id)) : undefined;
  if (!current) return { ok: false, status: 404, error: 'not_found' };
  const parsed = parse(store, body, now, current);
  if (!parsed.ok) return parsed;
  store.saveManualTransaction({ id: current.id, ...parsed.value }, now.toISOString());
  if (parsed.value.category !== null && !store.listCustomCategories().includes(parsed.value.category)) store.addCustomCategory(parsed.value.category, now.toISOString());
  rebuild(store, now);
  return { ok: true, value: {} };
}

export function deleteManual(store: Store, id: string, now: Date): ManualResult {
  const current = isManualId(id) ? store.listManualTransactions().find((m) => m.id === manualNumber(id)) : undefined;
  if (!current) return { ok: false, status: 404, error: 'not_found' };
  store.deleteManualTransaction(current.id);
  rebuild(store, now);
  return { ok: true, value: {} };
}
