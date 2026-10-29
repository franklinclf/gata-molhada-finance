import { localDay } from '../core/time.ts';
import type { Store } from '../store/store.ts';
import { cleanCategoryName } from './mutations.ts';
import { effectiveTransactions, visibleAccounts, type ViewOptions } from './scope.ts';
import { cards } from './views.ts';

export type AssetResult<T = Record<string, never>> = { ok: true; value: T } | { ok: false; status: number; error: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_VALUE = 100_000_000_000; // R$ 1 billion, in cents
const DATA_START_MONTH = '2026-01';
const MAX_ASSETS = 100;

export interface NetWorthItem {
  name: string;
  kind: 'bank' | 'card' | 'manual';
  /** Positive amount in cents. */
  value: number;
  liability: boolean;
  /** Id of the manual asset, for editing. */
  assetId?: number;
}

export interface NetWorthPoint {
  /** Last day of the month, or today for the current one. */
  day: string;
  assets: number;
  liabilities: number;
  net: number;
}

export interface NetWorthView {
  generatedAt: string;
  assets: number;
  liabilities: number;
  net: number;
  items: NetWorthItem[];
  /** Month ends, oldest first, rebuilt from today's balances by undoing the later transactions. */
  history: NetWorthPoint[];
  manual: Array<{ id: number; name: string; kind: 'asset' | 'liability'; archived: boolean; values: Array<{ day: string; value: number }> }>;
}

const lastDayOf = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const addMonths = (month: string, n: number): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

/** Latest value on or before the day, or null when the asset had no value yet. */
export function valueOn(values: ReadonlyArray<{ day: string; value: number }>, day: string): number | null {
  let found: number | null = null;
  for (const v of values) if (v.day <= day) found = v.value;
  return found;
}

export function netWorth(store: Store, now: Date, opts: ViewOptions = {}, months = 12): NetWorthView {
  const today = localDay(now.toISOString());
  const accounts = visibleAccounts(store, opts);
  const bank = accounts.filter((a) => a.kind !== 'credit_card');
  const cardIds = new Set(accounts.filter((a) => a.kind === 'credit_card').map((a) => a.id));
  const bankIds = new Set(bank.map((a) => a.id));
  const debtNow = cards(store, now, opts).totals.reportedByIssuer;
  const manual = store.listAssets();
  const active = manual.filter((a) => !a.archived);

  const items: NetWorthItem[] = [
    ...bank.map((a): NetWorthItem => ({ name: `${a.institution} · ${a.name}`, kind: 'bank', value: Math.max(a.balance, 0), liability: false })),
    ...bank.filter((a) => a.balance < 0).map((a): NetWorthItem => ({ name: `${a.institution} · ${a.name} (saldo negativo)`, kind: 'bank', value: -a.balance, liability: true })),
    ...(debtNow > 0 ? [{ name: 'Faturas de cartão', kind: 'card' as const, value: debtNow, liability: true }] : []),
    ...active.flatMap((a): NetWorthItem[] => {
      const value = valueOn(a.values, today);
      return value === null ? [] : [{ name: a.name, kind: 'manual', value, liability: a.kind === 'liability', assetId: a.id }];
    }),
  ];
  const assets = items.filter((i) => !i.liability).reduce((s, i) => s + i.value, 0);
  const liabilities = items.filter((i) => i.liability).reduce((s, i) => s + i.value, 0);

  // Going back in time from today's balances: undo every posted transaction after the day.
  const posted = effectiveTransactions(store, opts).filter((t) => !t.excluded && t.status === 'posted').map((t) => ({ day: localDay(t.occurredAt), amount: t.amount, accountId: t.accountId }));
  const bankNow = bank.reduce((s, a) => s + a.balance, 0);
  const firstDay = posted.reduce((min, t) => (t.day < min ? t.day : min), today);
  const firstMonth = [firstDay.slice(0, 7), DATA_START_MONTH].sort().at(-1)!;
  const currentMonth = today.slice(0, 7);
  const start = [addMonths(currentMonth, -(months - 1)), firstMonth].sort().at(-1)!;
  const history: NetWorthPoint[] = [];
  for (let m = start; m <= currentMonth; m = addMonths(m, 1)) {
    const day = m === currentMonth ? today : lastDayOf(m);
    const after = posted.filter((t) => t.day > day);
    const bankAt = bankNow - after.filter((t) => bankIds.has(t.accountId)).reduce((s, t) => s + t.amount, 0);
    const debtAt = Math.max(0, debtNow + after.filter((t) => cardIds.has(t.accountId)).reduce((s, t) => s + t.amount, 0));
    let a = Math.max(bankAt, 0);
    let l = debtAt + Math.max(-bankAt, 0);
    for (const asset of active) {
      const v = valueOn(asset.values, day);
      if (v === null) continue;
      if (asset.kind === 'asset') a += v;
      else l += v;
    }
    history.push({ day, assets: a, liabilities: l, net: a - l });
  }
  return { generatedAt: now.toISOString(), assets, liabilities, net: assets - liabilities, items, history, manual };
}

export function addAsset(store: Store, body: Record<string, unknown>, now: Date): AssetResult<{ id: number }> {
  const name = cleanCategoryName(body.name);
  if (name === null) return { ok: false, status: 400, error: 'name must be text of 1 to 60 characters' };
  if (body.kind !== 'asset' && body.kind !== 'liability') return { ok: false, status: 400, error: 'kind must be asset or liability' };
  const existing = store.listAssets();
  if (existing.length >= MAX_ASSETS) return { ok: false, status: 400, error: `at most ${MAX_ASSETS} items` };
  if (existing.some((a) => a.name.toLowerCase() === name.toLowerCase())) return { ok: false, status: 409, error: 'an item with this name already exists' };
  const id = store.addAsset(name, body.kind, now.toISOString());
  if (body.value !== undefined && body.value !== null) {
    const set = setAssetValue(store, id, { day: body.day ?? localDay(now.toISOString()), value: body.value }, now);
    if (!set.ok) {
      store.deleteAsset(id);
      return set;
    }
  }
  return { ok: true, value: { id } };
}

export function updateAsset(store: Store, id: number, body: Record<string, unknown>): AssetResult {
  const asset = store.listAssets().find((a) => a.id === id);
  if (!asset) return { ok: false, status: 404, error: 'not_found' };
  if (body.name !== undefined) {
    const name = cleanCategoryName(body.name);
    if (name === null) return { ok: false, status: 400, error: 'name must be text of 1 to 60 characters' };
    if (store.listAssets().some((a) => a.id !== id && a.name.toLowerCase() === name.toLowerCase())) return { ok: false, status: 409, error: 'an item with this name already exists' };
    store.renameAsset(id, name);
  }
  if (typeof body.archived === 'boolean') store.setAssetArchived(id, body.archived);
  return { ok: true, value: {} };
}

export function deleteAsset(store: Store, id: number): AssetResult {
  if (!store.listAssets().some((a) => a.id === id)) return { ok: false, status: 404, error: 'not_found' };
  store.deleteAsset(id);
  return { ok: true, value: {} };
}

export function setAssetValue(store: Store, id: number, body: Record<string, unknown>, now: Date): AssetResult {
  if (!store.listAssets().some((a) => a.id === id)) return { ok: false, status: 404, error: 'not_found' };
  const day = body.day;
  if (typeof day !== 'string' || !DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return { ok: false, status: 400, error: 'day must look like 2026-10-28' };
  if (day > localDay(now.toISOString())) return { ok: false, status: 400, error: 'a value cannot be dated in the future' };
  const value = body.value;
  if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_VALUE)) return { ok: false, status: 400, error: 'value must be a whole number of cents, or null to remove the day' };
  store.setAssetValue(id, day, value as number | null);
  return { ok: true, value: {} };
}
