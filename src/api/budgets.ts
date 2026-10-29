import { localDay } from '../core/time.ts';
import type { BudgetRow, BudgetScope, Store } from '../store/store.ts';
import { categoryParents } from './category-groups.ts';
import { cleanCategoryName } from './mutations.ts';
import { spending } from './views.ts';

export type BudgetResult<T = Record<string, never>> = { ok: true; value: T } | { ok: false; status: number; error: string };

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_AMOUNT = 1_000_000_000; // R$ 10 million, in cents
/** The first month the app holds data for. Averages never look before it. */
const DATA_START_MONTH = '2026-01';

export const addMonths = (month: string, n: number): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
export const lastDay = (month: string): string => {
  const next = addMonths(month, 1);
  return new Date(Date.parse(`${next}-01T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
};
const daysIn = (month: string): number => Number(lastDay(month).slice(8, 10));

export interface Resolved {
  amount: number;
  /** Where the amount comes from: a row for this exact month, or the latest recurring row before it. */
  source: 'month' | 'recurring';
  /** The month of the row that gives the amount. */
  from: string;
  recurring: boolean;
}

/** The budget of a target in a month: the row of that month, else the latest recurring row before it, else none. */
export function resolveBudget(rows: readonly BudgetRow[], scope: BudgetScope, name: string, month: string): Resolved | null {
  const mine = rows.filter((r) => r.scope === scope && r.name === name);
  const exact = mine.find((r) => r.month === month);
  if (exact) return { amount: exact.amount, source: 'month', from: exact.month, recurring: exact.recurring };
  const before = mine.filter((r) => r.recurring && r.month < month).sort((a, b) => b.month.localeCompare(a.month))[0];
  return before ? { amount: before.amount, source: 'recurring', from: before.month, recurring: true } : null;
}

export interface BudgetLine {
  scope: BudgetScope;
  name: string;
  budget: number | null;
  source: Resolved['source'] | null;
  recurring: boolean;
  /** Net spending of the month (refunds subtract). */
  actual: number;
  /** What the month would end at, at the pace so far. Equals `actual` for a past month. */
  pace: number;
  /** Spending of the month before. */
  previous: number;
  /** actual / budget, null without a budget. */
  used: number | null;
}

export interface BudgetsView {
  month: string;
  /** Days of the month already gone (the whole month for a past one, 0 for a future one). */
  elapsedDays: number;
  totalDays: number;
  lines: BudgetLine[];
  totals: { budget: number; actual: number; pace: number; over: number };
}

export function monthActuals(store: Store, month: string, now: Date): { byCategory: Map<string, number>; byGroup: Map<string, number> } {
  const view = spending(store, { from: `${month}-01`, to: lastDay(month) }, 'category', now);
  const byCategory = new Map<string, number>();
  const byGroup = new Map<string, number>();
  for (const g of view.groups) {
    byCategory.set(g.name, g.amount);
    if (g.parent) byGroup.set(g.parent, (byGroup.get(g.parent) ?? 0) + g.amount);
  }
  return { byCategory, byGroup };
}

export function budgetsFor(store: Store, month: string, now: Date): BudgetsView {
  const rows = store.listBudgets();
  const today = localDay(now.toISOString());
  const currentMonth = today.slice(0, 7);
  const totalDays = daysIn(month);
  const elapsedDays = month < currentMonth ? totalDays : month === currentMonth ? Number(today.slice(8, 10)) : 0;
  const current = monthActuals(store, month, now);
  const before = monthActuals(store, addMonths(month, -1), now);
  const paceOf = (actual: number) => (elapsedDays === 0 ? 0 : elapsedDays >= totalDays ? actual : Math.round((actual / elapsedDays) * totalDays));

  const targets = new Map<string, { scope: BudgetScope; name: string }>();
  for (const r of rows) if (resolveBudget(rows, r.scope, r.name, month)) targets.set(`${r.scope}|${r.name}`, { scope: r.scope, name: r.name });
  const parents = categoryParents(store);
  const budgetedGroups = new Set([...targets.values()].filter((t) => t.scope === 'group').map((t) => t.name));
  // Spending in a category that has no budget of its own and is not inside a budgeted group shows up as an unbudgeted line.
  for (const [name, amount] of current.byCategory) {
    const parent = parents.get(name);
    if (amount > 0 && !targets.has(`category|${name}`) && !(parent && budgetedGroups.has(parent))) targets.set(`category|${name}`, { scope: 'category', name });
  }

  const lines: BudgetLine[] = [...targets.values()].map((t) => {
    const resolved = resolveBudget(rows, t.scope, t.name, month);
    const actual = (t.scope === 'group' ? current.byGroup : current.byCategory).get(t.name) ?? 0;
    const previous = (t.scope === 'group' ? before.byGroup : before.byCategory).get(t.name) ?? 0;
    return { scope: t.scope, name: t.name, budget: resolved?.amount ?? null, source: resolved?.source ?? null, recurring: resolved?.recurring ?? false, actual, pace: paceOf(actual), previous, used: resolved ? actual / resolved.amount : null };
  });
  lines.sort((a, b) => (a.budget === null ? 1 : 0) - (b.budget === null ? 1 : 0) || (b.used ?? 0) - (a.used ?? 0) || b.actual - a.actual || a.name.localeCompare(b.name));
  const budgeted = lines.filter((l) => l.budget !== null);
  return {
    month,
    elapsedDays,
    totalDays,
    lines,
    totals: {
      budget: budgeted.reduce((s, l) => s + (l.budget ?? 0), 0),
      actual: budgeted.reduce((s, l) => s + l.actual, 0),
      pace: budgeted.reduce((s, l) => s + l.pace, 0),
      over: budgeted.filter((l) => l.actual > (l.budget ?? 0)).length,
    },
  };
}

function checkTarget(store: Store, scope: unknown, nameInput: unknown): BudgetResult<{ scope: BudgetScope; name: string }> {
  if (scope !== 'category' && scope !== 'group') return { ok: false, status: 400, error: 'scope must be category or group' };
  const name = cleanCategoryName(nameInput);
  if (name === null) return { ok: false, status: 400, error: 'name must be text of 1 to 60 characters' };
  return { ok: true, value: { scope, name } };
}

/** A category and the group it sits in must not both have a budget, or the same money would be counted twice. */
function overlapError(store: Store, scope: BudgetScope, name: string): string | null {
  const rows = store.listBudgets();
  const parents = categoryParents(store);
  if (scope === 'category') {
    const parent = parents.get(name);
    if (parent && rows.some((r) => r.scope === 'group' && r.name === parent)) return `o grupo ${parent} já tem orçamento; use um ou outro`;
  } else {
    const child = rows.find((r) => r.scope === 'category' && parents.get(r.name) === name);
    if (child) return `a categoria ${child.name}, que está neste grupo, já tem orçamento; use um ou outro`;
  }
  return null;
}

export function setBudget(store: Store, body: Record<string, unknown>, now: Date): BudgetResult {
  const target = checkTarget(store, body.scope, body.name);
  if (!target.ok) return target;
  if (typeof body.month !== 'string' || !MONTH.test(body.month)) return { ok: false, status: 400, error: 'month must look like 2026-10' };
  const amount = body.amount;
  if (amount !== null && (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0 || amount > MAX_AMOUNT)) return { ok: false, status: 400, error: 'amount must be a whole number of cents above zero, or null to remove' };
  if (amount !== null) {
    const clash = overlapError(store, target.value.scope, target.value.name);
    if (clash) return { ok: false, status: 409, error: clash };
  }
  store.setBudget(target.value.scope, target.value.name, body.month, amount, body.recurring === true, now.toISOString());
  return { ok: true, value: {} };
}

export interface SuggestionLine {
  name: string;
  /** Average net spending over the complete months, rounded to R$ 10. */
  amount: number;
  months: number;
  hasBudget: boolean;
}

const NOT_BUDGETABLE = new Set(['Estorno', 'Renda', 'Sem categoria']);

/** An average of the last complete months before `month`, per category. A half month never lowers it. */
export function suggestBudgets(store: Store, month: string, months: number, now: Date): SuggestionLine[] {
  const rows = store.listBudgets();
  const today = localDay(now.toISOString());
  const currentMonth = today.slice(0, 7);
  const window = Array.from({ length: months }, (_, i) => addMonths(month, -(i + 1))).filter((m) => m >= DATA_START_MONTH && m < currentMonth);
  if (window.length === 0) return [];
  const sums = new Map<string, number>();
  for (const m of window) for (const [name, amount] of monthActuals(store, m, now).byCategory) sums.set(name, (sums.get(name) ?? 0) + amount);
  const parents = categoryParents(store);
  const budgetedGroups = new Set(rows.filter((r) => r.scope === 'group').map((r) => r.name));
  return [...sums]
    .filter(([name, sum]) => sum > 0 && !NOT_BUDGETABLE.has(name))
    .map(([name, sum]) => ({
      name,
      amount: Math.max(1000, Math.round(sum / window.length / 1000) * 1000),
      months: window.length,
      hasBudget: resolveBudget(rows, 'category', name, month) !== null || budgetedGroups.has(parents.get(name) ?? ''),
    }))
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
}

export function createBudgets(store: Store, month: unknown, items: unknown, now: Date): BudgetResult<{ created: number }> {
  if (typeof month !== 'string' || !MONTH.test(month)) return { ok: false, status: 400, error: 'month must look like 2026-10' };
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) return { ok: false, status: 400, error: 'items must be a list of 1 to 100 budgets' };
  const seen = new Set<string>();
  const wanted: Array<{ name: string; amount: number }> = [];
  for (const raw of items as Array<Record<string, unknown>>) {
    const name = cleanCategoryName(raw?.name);
    if (name === null || typeof raw.amount !== 'number' || !Number.isInteger(raw.amount) || raw.amount <= 0 || raw.amount > MAX_AMOUNT) return { ok: false, status: 400, error: 'every item needs a name and an amount in cents' };
    if (seen.has(name)) continue;
    seen.add(name);
    wanted.push({ name, amount: raw.amount });
  }
  // All or nothing: one clash stops the whole batch before anything is saved.
  const rows = store.listBudgets();
  for (const w of wanted) {
    if (resolveBudget(rows, 'category', w.name, month)) return { ok: false, status: 409, error: `${w.name} já tem orçamento neste mês` };
    const clash = overlapError(store, 'category', w.name);
    if (clash) return { ok: false, status: 409, error: clash };
  }
  for (const w of wanted) store.setBudget('category', w.name, month, w.amount, true, now.toISOString());
  return { ok: true, value: { created: wanted.length } };
}

/** Copies what one month resolves to into another month, as that month's own rows, with an adjustment in percent. */
export function copyBudgets(store: Store, body: Record<string, unknown>, now: Date): BudgetResult<{ copied: number; skipped: number }> {
  const { from, to } = body;
  if (typeof from !== 'string' || typeof to !== 'string' || !MONTH.test(from) || !MONTH.test(to)) return { ok: false, status: 400, error: 'from and to must look like 2026-10' };
  if (from === to) return { ok: false, status: 400, error: 'from and to must be different months' };
  const adjust = typeof body.adjustPercent === 'number' && Number.isFinite(body.adjustPercent) ? body.adjustPercent : 0;
  if (adjust < -100 || adjust > 1000) return { ok: false, status: 400, error: 'adjustPercent must be between -100 and 1000' };
  const rows = store.listBudgets();
  const targets = new Map(rows.map((r) => [`${r.scope}|${r.name}`, { scope: r.scope, name: r.name }]));
  let copied = 0;
  let skipped = 0;
  for (const t of targets.values()) {
    const source = resolveBudget(rows, t.scope, t.name, from);
    if (!source) continue;
    const amount = Math.floor((source.amount * (100 + adjust)) / 100 + 0.5);
    if (amount <= 0 || amount > MAX_AMOUNT) {
      skipped++;
      continue;
    }
    const exact = rows.find((r) => r.scope === t.scope && r.name === t.name && r.month === to);
    const inherited = resolveBudget(rows, t.scope, t.name, to);
    // A target that already has a row for the month is kept unless asked; one that already resolves to the new amount needs no row.
    if ((exact && body.overwrite !== true) || (!exact && inherited?.amount === amount)) {
      skipped++;
      continue;
    }
    store.setBudget(t.scope, t.name, to, amount, false, now.toISOString());
    copied++;
  }
  return { ok: true, value: { copied, skipped } };
}
