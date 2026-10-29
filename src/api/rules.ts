import { localDay } from '../core/time.ts';
import type { Store } from '../store/store.ts';
import { cleanCategoryName } from './mutations.ts';
import { conditionsError, matches, sortRules, type Rule, type RuleConditions } from './rules-engine.ts';
import { effectiveTransactions, ruleSubjectOf } from './scope.ts';

export type RuleResult<T = Record<string, never>> = { ok: true; value: T } | { ok: false; status: number; error: string };

const MAX_NAME = 80;
const MAX_RULES = 200;

interface RuleInput {
  name: string;
  active: boolean;
  priority: number | undefined;
  conditions: RuleConditions;
  actions: { category: string };
}

function parseInput(body: Record<string, unknown>): RuleResult<RuleInput> {
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 1 || name.length > MAX_NAME) return { ok: false, status: 400, error: `name must be text of 1 to ${MAX_NAME} characters` };
  const problem = conditionsError(body.conditions);
  if (problem) return { ok: false, status: 400, error: problem };
  const actions = body.actions as Record<string, unknown> | undefined;
  const category = cleanCategoryName(actions?.category);
  if (category === null) return { ok: false, status: 400, error: 'the rule needs a category' };
  const priority = typeof body.priority === 'number' && Number.isFinite(body.priority) ? Math.round(body.priority) : undefined;
  return { ok: true, value: { name, active: body.active !== false, priority, conditions: body.conditions as RuleConditions, actions: { category } } };
}

function ensureCategory(store: Store, category: string, now: Date): void {
  const known = new Set([...effectiveTransactions(store, { includeHidden: true, includeExcluded: true }).map((t) => t.category), ...store.listCustomCategories()]);
  if (!known.has(category)) store.addCustomCategory(category, now.toISOString());
}

export interface RuleRow extends Rule {
  /** Transactions the conditions match right now, whatever rule wins. */
  matches: number;
}

export function listRules(store: Store): RuleRow[] {
  const rules = sortRules(store.listRules());
  const transactions = effectiveTransactions(store, { includeHidden: true });
  const institutions = new Map(store.listCanonicalAccounts().map((a) => [a.id, a.institution]));
  const subjects = transactions.map((t) => ruleSubjectOf(t, institutions.get(t.accountId) ?? ''));
  const regexes = new Map<string, RegExp | null>();
  return rules.map((r) => ({ ...r, matches: subjects.filter((s) => matches(s, r.conditions, regexes)).length }));
}

export function createRule(store: Store, body: Record<string, unknown>, now: Date): RuleResult<Rule> {
  const input = parseInput(body);
  if (!input.ok) return input;
  const existing = store.listRules();
  if (existing.length >= MAX_RULES) return { ok: false, status: 400, error: `at most ${MAX_RULES} rules` };
  if (existing.some((r) => r.name.toLowerCase() === input.value.name.toLowerCase())) return { ok: false, status: 409, error: 'a rule with this name already exists' };
  ensureCategory(store, input.value.actions.category, now);
  const priority = input.value.priority ?? Math.max(0, ...existing.map((r) => r.priority)) + 10;
  return { ok: true, value: store.saveRule({ name: input.value.name, priority, active: input.value.active, conditions: input.value.conditions, actions: input.value.actions }, now.toISOString()) };
}

export function updateRule(store: Store, id: number, body: Record<string, unknown>, now: Date): RuleResult<Rule> {
  const current = store.listRules().find((r) => r.id === id);
  if (!current) return { ok: false, status: 404, error: 'not_found' };
  const input = parseInput({ name: current.name, active: current.active, conditions: current.conditions, actions: current.actions, priority: current.priority, ...body });
  if (!input.ok) return input;
  if (store.listRules().some((r) => r.id !== id && r.name.toLowerCase() === input.value.name.toLowerCase())) return { ok: false, status: 409, error: 'a rule with this name already exists' };
  ensureCategory(store, input.value.actions.category, now);
  return { ok: true, value: store.saveRule({ id, name: input.value.name, priority: input.value.priority ?? current.priority, active: input.value.active, conditions: input.value.conditions, actions: input.value.actions }, now.toISOString()) };
}

export function deleteRule(store: Store, id: number): RuleResult {
  if (!store.listRules().some((r) => r.id === id)) return { ok: false, status: 404, error: 'not_found' };
  store.deleteRule(id);
  return { ok: true, value: {} };
}

export function reorderRules(store: Store, ids: unknown, now: Date): RuleResult {
  const known = new Set(store.listRules().map((r) => r.id));
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'number' || !known.has(i)) || new Set(ids).size !== ids.length) return { ok: false, status: 400, error: 'ids must be a list of existing rule ids, without repeats' };
  store.reorderRules(ids as number[], now.toISOString());
  return { ok: true, value: {} };
}

export interface RulePreview {
  matched: number;
  /** Matches whose category is not the rule's category yet. */
  willChange: number;
  sample: Array<{ id: string; description: string; date: string; amount: number; category: string | null; newCategory: string }>;
}

/** What a rule would do, without saving it. Uses the same matching as the real thing. */
export function previewRule(store: Store, body: Record<string, unknown>): RuleResult<RulePreview> {
  const problem = conditionsError(body.conditions);
  if (problem) return { ok: false, status: 400, error: problem };
  const category = cleanCategoryName((body.actions as Record<string, unknown> | undefined)?.category) ?? '';
  const conditions = body.conditions as RuleConditions;
  const institutions = new Map(store.listCanonicalAccounts().map((a) => [a.id, a.institution]));
  const regexes = new Map<string, RegExp | null>();
  const hits = effectiveTransactions(store, { includeHidden: true })
    .filter((t) => !t.excluded)
    .filter((t) => matches(ruleSubjectOf(t, institutions.get(t.accountId) ?? ''), conditions, regexes))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
  const changing = hits.filter((t) => category !== '' && t.category !== category);
  return {
    ok: true,
    value: {
      matched: hits.length,
      willChange: changing.length,
      sample: hits.slice(0, 15).map((t) => ({ id: t.id, description: t.description, date: localDay(t.occurredAt), amount: t.amount, category: t.category, newCategory: category })),
    },
  };
}

export const EXPORT_FORMAT = 'gmf-rules';

export function exportRules(store: Store) {
  return { format: EXPORT_FORMAT, version: 1, rules: sortRules(store.listRules()).map((r) => ({ name: r.name, priority: r.priority, active: r.active, conditions: r.conditions, actions: r.actions })) };
}

export interface ImportReport {
  imported: number;
  overwritten: number;
  skipped: Array<{ name: string; reason: string }>;
}

/** Replaces the rules with the ones in the file. Refused when rules exist, unless `overwrite`. If nothing in the file is usable, the current rules stay. */
export function importRules(store: Store, body: Record<string, unknown>, now: Date): RuleResult<ImportReport> {
  if (body.format !== EXPORT_FORMAT || !Array.isArray(body.rules)) return { ok: false, status: 400, error: `this is not a ${EXPORT_FORMAT} file` };
  const existing = store.listRules();
  if (existing.length > 0 && body.overwrite !== true) return { ok: false, status: 409, error: 'there are rules already; confirm to replace them' };
  const skipped: ImportReport['skipped'] = [];
  const valid: RuleInput[] = [];
  const seen = new Set<string>();
  for (const raw of body.rules.slice(0, MAX_RULES) as unknown[]) {
    const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const label = typeof record.name === 'string' ? record.name : '(no name)';
    const parsed = parseInput(record);
    if (!parsed.ok) skipped.push({ name: label, reason: parsed.error });
    else if (seen.has(parsed.value.name.toLowerCase())) skipped.push({ name: label, reason: 'repeated name' });
    else {
      seen.add(parsed.value.name.toLowerCase());
      valid.push(parsed.value);
    }
  }
  if (valid.length === 0) return { ok: true, value: { imported: 0, overwritten: 0, skipped } };
  for (const r of existing) store.deleteRule(r.id);
  valid.forEach((r, i) => {
    ensureCategory(store, r.actions.category, now);
    store.saveRule({ name: r.name, priority: r.priority ?? (i + 1) * 10, active: r.active, conditions: r.conditions, actions: r.actions }, now.toISOString());
  });
  return { ok: true, value: { imported: valid.length, overwritten: existing.length, skipped } };
}
