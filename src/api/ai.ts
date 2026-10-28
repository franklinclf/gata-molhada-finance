import { mapSourceCategory } from '../ai/source-map.ts';
import { CATEGORY_NAMES } from '../ai/taxonomy.ts';
import { localMonth } from '../core/time.ts';
import type { AiStatus, Store } from '../store/store.ts';
import { cleanCategoryName, type MutationResult } from './mutations.ts';
import { effectiveTransactions, ruleKey } from './scope.ts';

export interface Suggestion {
  key: string;
  sample: string;
  category: string;
  confidence: 'high' | 'medium' | 'low';
  /** How many transactions carry this description. */
  count: number;
  /** What the source called it, from the newest transaction. */
  sourceCategory: string | null;
  sampleTransactionId: string | null;
}

export interface AiView {
  /** Written by the background job each run: whether it is on, and when it last ran. */
  job: { enabled: boolean; model: string | null; lastRunAt: string | null; lastResult: string | null };
  spentThisMonth: number;
  monthlyBudget: number | null;
  /** Descriptions the AI categorized by itself, and ones waiting for the user. */
  applied: number;
  suggestions: Suggestion[];
  matches: {
    /** Pairs the AI joined by itself, newest first. Each can be separated. */
    joined: Array<{ findingId: string; transactionId: string | null; a: string; b: string; confidence: string; model: string; decidedAt: string }>;
    /** What the AI thought of each open "may be the same" suggestion. */
    opinions: Record<string, { verdict: 'yes' | 'no'; confidence: string }>;
    counts: { joined: number; dismissed: number; undone: number };
  };
}

export const AI_JOB_KEY = 'ai_job';

export interface Decision {
  key: string;
  sample: string;
  category: string;
  confidence: 'high' | 'medium' | 'low';
  status: 'applied' | 'accepted' | 'rejected' | 'skipped';
  model: string;
  decidedAt: string;
  count: number;
  sourceCategory: string | null;
  /** For accepted ones, the rule that was created from it (it can differ from the AI's category if the user changed it). */
  rule: string | null;
  sampleTransactionId: string | null;
}

export type DecisionStatus = Decision['status'];

/** What was decided about each description so far, newest first, to review or undo. */
export function listDecisions(store: Store, filter: { status?: DecisionStatus; q?: string; limit?: number }): { items: Decision[]; counts: Record<DecisionStatus, number> } {
  const transactions = effectiveTransactions(store, { includeHidden: true });
  const byKey = new Map<string, { count: number; id: string; sourceCategory: string | null }>();
  for (const t of transactions) {
    const key = ruleKey(t.description);
    const row = byKey.get(key) ?? { count: 0, id: t.id, sourceCategory: t.sourceCategory };
    row.count += 1;
    byKey.set(key, row);
  }
  const rules = store.listCategoryRules();
  const counts: Record<DecisionStatus, number> = { applied: 0, accepted: 0, rejected: 0, skipped: 0 };
  const wanted = (filter.q ?? '').trim().toLowerCase();
  const items: Decision[] = [];
  for (const e of store.listAiCategories().values()) {
    if (e.status === 'suggested') continue;
    counts[e.status]++;
    if (filter.status && e.status !== filter.status) continue;
    if (wanted && !`${e.sample} ${e.category}`.toLowerCase().includes(wanted)) continue;
    const seen = byKey.get(e.matchKey);
    items.push({ key: e.matchKey, sample: e.sample, category: e.category, confidence: e.confidence, status: e.status, model: e.model, decidedAt: e.decidedAt, count: seen?.count ?? 0, sourceCategory: seen?.sourceCategory ?? null, rule: e.status === 'accepted' ? (rules.get(e.matchKey) ?? null) : null, sampleTransactionId: seen?.id ?? null });
  }
  items.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt) || a.sample.localeCompare(b.sample));
  return { items: items.slice(0, filter.limit ?? 300), counts };
}

/** Changes the decision about one description: accept (optionally with another category), reject, or forget it. */
export function decide(store: Store, key: unknown, action: unknown, category: unknown, now: Date): MutationResult {
  if (typeof key !== 'string') return { ok: false, status: 400, error: 'key is required' };
  const entry = store.listAiCategories().get(key);
  if (!entry) return { ok: false, status: 404, error: 'not_found' };
  const iso = now.toISOString();
  if (action === 'accept') {
    const chosen = category === undefined || category === null ? entry.category : cleanCategoryName(category);
    if (chosen === null) return { ok: false, status: 400, error: 'category must be text of 1 to 60 characters' };
    const known = new Set([...effectiveTransactions(store, { includeHidden: true }).map((t) => t.category), ...store.listCustomCategories()]);
    if (!known.has(chosen) && !isBuiltin(chosen)) store.addCustomCategory(chosen, iso);
    store.setCategoryRule(key, chosen, iso);
    store.setAiCategoryStatus(key, 'accepted');
    return { ok: true };
  }
  if (action === 'reject') {
    if (entry.status === 'accepted') store.setCategoryRule(key, null, iso);
    store.setAiCategoryStatus(key, 'rejected');
    return { ok: true };
  }
  if (action === 'reset') {
    if (entry.status === 'accepted') store.setCategoryRule(key, null, iso);
    store.deleteAiCategory(key);
    return { ok: true };
  }
  return { ok: false, status: 400, error: 'action must be accept, reject or reset' };
}

/** Forgets decisions in bulk, so the model is asked again. Accepted ones also lose the rule made from them. */
export function resetDecisions(store: Store, statuses: unknown, now: Date): { ok: true; reset: number } | { ok: false; status: number; error: string } {
  const all: AiStatus[] = ['applied', 'suggested', 'accepted', 'rejected', 'skipped'];
  const wanted: AiStatus[] = statuses === 'all' ? all : Array.isArray(statuses) ? (statuses.filter((s): s is AiStatus => all.includes(s as AiStatus))) : [];
  if (wanted.length === 0) return { ok: false, status: 400, error: 'statuses must be "all" or a list of applied, suggested, accepted, rejected, skipped' };
  if (wanted.includes('accepted')) {
    for (const e of store.listAiCategories().values()) if (e.status === 'accepted') store.setCategoryRule(e.matchKey, null, now.toISOString());
  }
  return { ok: true, reset: store.deleteAiCategoriesByStatus(wanted) };
}

export function aiView(store: Store, now: Date): AiView {
  const raw = store.getSetting(AI_JOB_KEY);
  const job = raw ? (JSON.parse(raw) as AiView['job'] & { monthlyBudget?: number }) : { enabled: false, model: null, lastRunAt: null, lastResult: null };
  const entries = [...store.listAiCategories().values()];
  const transactions = effectiveTransactions(store, { includeHidden: true });
  const byKey = new Map<string, { count: number; id: string; sourceCategory: string | null; at: string; settled: boolean }>();
  for (const t of transactions) {
    const key = ruleKey(t.description);
    // A description whose label a table translates, or that has a role, no longer needs a suggestion.
    const row = byKey.get(key) ?? { count: 0, id: t.id, sourceCategory: t.sourceCategory, at: t.occurredAt, settled: t.sourceLabels.some((l) => mapSourceCategory(l) !== null) || t.role !== null };
    row.count += 1;
    if (t.occurredAt > row.at) Object.assign(row, { id: t.id, sourceCategory: t.sourceCategory, at: t.occurredAt });
    byKey.set(key, row);
  }
  const suggestions = entries
    .filter((e) => e.status === 'suggested' && byKey.has(e.matchKey) && !byKey.get(e.matchKey)!.settled)
    .map((e) => ({ key: e.matchKey, sample: e.sample, category: e.category, confidence: e.confidence, count: byKey.get(e.matchKey)!.count, sourceCategory: byKey.get(e.matchKey)!.sourceCategory, sampleTransactionId: byKey.get(e.matchKey)!.id }))
    .sort((a, b) => b.count - a.count || a.sample.localeCompare(b.sample));
  return {
    job: { enabled: job.enabled, model: job.model, lastRunAt: job.lastRunAt, lastResult: job.lastResult },
    spentThisMonth: store.aiSpent(localMonth(now.toISOString())),
    monthlyBudget: (job as { monthlyBudget?: number }).monthlyBudget ?? null,
    applied: entries.filter((e) => e.status === 'applied').length,
    suggestions,
    matches: matchesView(store),
  };
}

function matchesView(store: Store): AiView['matches'] {
  const all = [...store.listAiMatches().values()];
  const joined = all
    .filter((m) => m.action === 'joined')
    .sort((x, y) => y.decidedAt.localeCompare(x.decidedAt))
    .slice(0, 20)
    .map((m) => ({ findingId: m.findingId, transactionId: store.transactionOfRecord(m.sourceA, m.externalA), a: m.sampleA, b: m.sampleB, confidence: m.confidence, model: m.model, decidedAt: m.decidedAt }));
  const opinions: AiView['matches']['opinions'] = {};
  for (const m of all) if (m.action === 'suggested' || m.action === 'undone') opinions[m.findingId] = { verdict: m.verdict, confidence: m.confidence };
  const count = (action: string) => all.filter((m) => m.action === action).length;
  return { joined, opinions, counts: { joined: count('joined'), dismissed: count('dismissed'), undone: count('undone') } };
}

/** The user agrees (optionally with another category): the suggestion becomes a rule of theirs, which beats the AI. */
export function acceptSuggestion(store: Store, key: unknown, category: unknown, now: Date): MutationResult {
  if (typeof key !== 'string') return { ok: false, status: 400, error: 'key is required' };
  const entry = store.listAiCategories().get(key);
  if (!entry || entry.status !== 'suggested') return { ok: false, status: 404, error: 'not_found' };
  const chosen = category === undefined || category === null ? entry.category : cleanCategoryName(category);
  if (chosen === null) return { ok: false, status: 400, error: 'category must be text of 1 to 60 characters' };
  const known = new Set([...effectiveTransactions(store, { includeHidden: true }).map((t) => t.category), ...store.listCustomCategories()]);
  if (!known.has(chosen) && !isBuiltin(chosen)) store.addCustomCategory(chosen, now.toISOString());
  store.setCategoryRule(key, chosen, now.toISOString());
  store.setAiCategoryStatus(key, 'accepted');
  return { ok: true };
}

/** "Not this": the description keeps what the source said and is not asked again. */
export function rejectSuggestion(store: Store, key: unknown): MutationResult {
  if (typeof key !== 'string') return { ok: false, status: 400, error: 'key is required' };
  const entry = store.listAiCategories().get(key);
  if (!entry || entry.status !== 'suggested') return { ok: false, status: 404, error: 'not_found' };
  store.setAiCategoryStatus(key, 'rejected');
  return { ok: true };
}

/** Accepts every suggestion of the given confidence (or better) in one go. */
export function acceptAll(store: Store, minimum: 'medium' | 'low', now: Date): number {
  const wanted = minimum === 'low' ? ['high', 'medium', 'low'] : ['high', 'medium'];
  let accepted = 0;
  for (const e of store.listAiCategories().values()) {
    if (e.status === 'suggested' && wanted.includes(e.confidence) && acceptSuggestion(store, e.matchKey, null, now).ok) accepted++;
  }
  return accepted;
}

const isBuiltin = (name: string) => CATEGORY_NAMES.includes(name);
