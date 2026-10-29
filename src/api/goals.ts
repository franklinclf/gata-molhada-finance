import { localDay } from '../core/time.ts';
import type { Goal, Store } from '../store/store.ts';
import { cleanCategoryName } from './mutations.ts';
import { netWorth, valueOn } from './networth.ts';
import { visibleAccounts } from './scope.ts';

export type GoalResult<T = Record<string, never>> = { ok: true; value: T } | { ok: false; status: number; error: string };

const MAX_TARGET = 100_000_000_000;
const MAX_GOALS = 50;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type GoalStatus = 'achieved' | 'overdue' | 'ahead' | 'on_track' | 'behind' | 'open';

export interface GoalView extends Goal {
  /** Where the goal stands now, from what it follows (or the typed amount when the link is gone). */
  current: number;
  /** True when the followed item no longer exists and the typed amount is used. */
  linkLost: boolean;
  /** How much of the target is reached, 0 to 1. */
  progress: number;
  status: GoalStatus;
  remaining: number;
  /** What to put aside each month to arrive on time; null without a date, or once achieved. */
  requiredMonthly: number | null;
}

const dayNumber = (day: string): number => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

/** Where a goal stands today. */
export function currentAmount(store: Store, goal: Goal, today: string, net: () => number): { amount: number; linkLost: boolean } {
  if (goal.track === 'networth') return { amount: net(), linkLost: false };
  if (goal.track === 'account') {
    const account = store.listCanonicalAccounts().find((a) => a.id === goal.trackRef);
    return account ? { amount: account.kind === 'credit_card' ? -account.balance : account.balance, linkLost: false } : { amount: goal.saved, linkLost: true };
  }
  if (goal.track === 'asset') {
    const asset = store.listAssets().find((a) => String(a.id) === goal.trackRef);
    const value = asset ? valueOn(asset.values, today) : null;
    return value !== null ? { amount: value, linkLost: false } : { amount: goal.saved, linkLost: asset === undefined };
  }
  return { amount: goal.saved, linkLost: false };
}

export function evaluate(goal: Goal, current: number, linkLost: boolean, today: string): GoalView {
  const progress = Math.min(1, Math.max(0, current / goal.target));
  // The pace is judged on the distance walked since the goal began, so a goal that started with money in it is not ahead by default.
  const span = goal.target - goal.initial;
  const walked = span <= 0 ? 1 : Math.min(1, Math.max(0, (current - goal.initial) / span));
  const remaining = Math.max(0, goal.target - current);
  let status: GoalStatus;
  if (current >= goal.target) status = 'achieved';
  else if (!goal.targetDay) status = 'open';
  else if (today > goal.targetDay) status = 'overdue';
  else {
    const total = dayNumber(goal.targetDay) - dayNumber(goal.createdDay);
    const expected = total <= 0 ? 1 : Math.min(1, Math.max(0, (dayNumber(today) - dayNumber(goal.createdDay)) / total));
    status = walked - expected > 0.1 ? 'ahead' : expected - walked > 0.05 ? 'behind' : 'on_track';
  }
  let requiredMonthly: number | null = null;
  if (goal.targetDay && status !== 'achieved' && status !== 'overdue') {
    const months = Math.max(1, Math.ceil((dayNumber(goal.targetDay) - dayNumber(today)) / 30.44));
    requiredMonthly = Math.ceil(remaining / months);
  }
  return { ...goal, current, linkLost, progress, status, remaining, requiredMonthly };
}

export function listGoals(store: Store, now: Date): GoalView[] {
  const today = localDay(now.toISOString());
  let cached: number | null = null;
  const net = () => (cached ??= netWorth(store, now).net);
  return store.listGoals().map((g) => {
    const { amount, linkLost } = currentAmount(store, g, today, net);
    return evaluate(g, amount, linkLost, today);
  });
}

function parse(store: Store, body: Record<string, unknown>, now: Date, current?: Goal): GoalResult<Omit<Goal, 'id'>> {
  const merged = { ...(current ?? {}), ...body } as Record<string, unknown>;
  const today = localDay(now.toISOString());
  const name = cleanCategoryName(merged.name);
  if (name === null) return { ok: false, status: 400, error: 'name must be text of 1 to 60 characters' };
  if (store.listGoals().some((g) => g.id !== current?.id && g.name.toLowerCase() === name.toLowerCase())) return { ok: false, status: 409, error: 'a goal with this name already exists' };
  const target = merged.target;
  if (typeof target !== 'number' || !Number.isInteger(target) || target <= 0 || target > MAX_TARGET) return { ok: false, status: 400, error: 'target must be a whole number of cents above zero' };
  const targetDay = merged.targetDay === null || merged.targetDay === undefined || merged.targetDay === '' ? null : merged.targetDay;
  if (targetDay !== null && (typeof targetDay !== 'string' || !DAY.test(targetDay) || Number.isNaN(Date.parse(`${targetDay}T00:00:00Z`)))) return { ok: false, status: 400, error: 'targetDay must look like 2027-06-30' };
  if (typeof targetDay === 'string' && current === undefined && targetDay <= today) return { ok: false, status: 400, error: 'the date must be in the future' };
  const track = merged.track;
  if (track !== 'manual' && track !== 'account' && track !== 'asset' && track !== 'networth') return { ok: false, status: 400, error: 'track must be manual, account, asset or networth' };
  let trackRef: string | null = null;
  if (track === 'account') {
    trackRef = typeof merged.trackRef === 'string' ? merged.trackRef : '';
    if (!visibleAccounts(store, { includeHidden: true }).some((a) => a.id === trackRef)) return { ok: false, status: 400, error: 'trackRef must be one of your accounts' };
  }
  if (track === 'asset') {
    trackRef = String(merged.trackRef ?? '');
    if (!store.listAssets().some((a) => String(a.id) === trackRef)) return { ok: false, status: 400, error: 'trackRef must be one of your assets' };
  }
  const saved = merged.saved ?? 0;
  if (typeof saved !== 'number' || !Number.isInteger(saved) || saved < 0 || saved > MAX_TARGET) return { ok: false, status: 400, error: 'saved must be a whole number of cents, zero or more' };
  return { ok: true, value: { name, target, targetDay: targetDay as string | null, track, trackRef, saved, initial: current?.initial ?? 0, createdDay: current?.createdDay ?? today, archived: merged.archived === true } };
}

export function createGoal(store: Store, body: Record<string, unknown>, now: Date): GoalResult<{ id: number }> {
  if (store.listGoals().length >= MAX_GOALS) return { ok: false, status: 400, error: `at most ${MAX_GOALS} goals` };
  const parsed = parse(store, body, now);
  if (!parsed.ok) return parsed;
  // The goal starts from where the followed amount is today, so progress is the distance walked and not the whole balance.
  const today = localDay(now.toISOString());
  const draft: Goal = { ...parsed.value, id: 0, initial: 0 };
  const start = currentAmount(store, draft, today, () => netWorth(store, now).net).amount;
  const saved = store.saveGoal({ ...parsed.value, initial: Math.min(start, parsed.value.target) });
  return { ok: true, value: { id: saved.id } };
}

export function updateGoal(store: Store, id: number, body: Record<string, unknown>, now: Date): GoalResult {
  const current = store.listGoals().find((g) => g.id === id);
  if (!current) return { ok: false, status: 404, error: 'not_found' };
  const parsed = parse(store, body, now, current);
  if (!parsed.ok) return parsed;
  store.saveGoal({ ...parsed.value, id });
  return { ok: true, value: {} };
}

export function deleteGoal(store: Store, id: number): GoalResult {
  if (!store.listGoals().some((g) => g.id === id)) return { ok: false, status: 404, error: 'not_found' };
  store.deleteGoal(id);
  return { ok: true, value: {} };
}
