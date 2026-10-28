import { CATEGORY_NAMES } from '../ai/taxonomy.ts';
import { localMonth } from '../core/time.ts';
import type { Store } from '../store/store.ts';
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

export function aiView(store: Store, now: Date): AiView {
  const raw = store.getSetting(AI_JOB_KEY);
  const job = raw ? (JSON.parse(raw) as AiView['job'] & { monthlyBudget?: number }) : { enabled: false, model: null, lastRunAt: null, lastResult: null };
  const entries = [...store.listAiCategories().values()];
  const transactions = effectiveTransactions(store, { includeHidden: true });
  const byKey = new Map<string, { count: number; id: string; sourceCategory: string | null; at: string }>();
  for (const t of transactions) {
    const key = ruleKey(t.description);
    const row = byKey.get(key) ?? { count: 0, id: t.id, sourceCategory: t.sourceCategory, at: t.occurredAt };
    row.count += 1;
    if (t.occurredAt > row.at) Object.assign(row, { id: t.id, sourceCategory: t.sourceCategory, at: t.occurredAt });
    byKey.set(key, row);
  }
  const suggestions = entries
    .filter((e) => e.status === 'suggested' && byKey.has(e.matchKey))
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
