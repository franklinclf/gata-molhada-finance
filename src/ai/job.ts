import type { Store } from '../store/store.ts';
import { AI_JOB_KEY, resetDecisions } from '../api/ai.ts';
import { effectiveTransactions, ruleKey } from '../api/scope.ts';
import { runReconciliation } from '../reconcile/run.ts';
import { categorizePending, type CategorizerResult } from './categorizer.ts';
import { matchPending, type MatcherResult } from './matcher.ts';
import { openRouterClient, type AiClient } from './openrouter.ts';
import { refreshKeyUsage } from './spend.ts';

export interface AiConfig {
  enabled: boolean;
  apiKey: string | null;
  models: string[];
  /** Models for judging pairs of records. A cheaper, more careful pair than the categorizer's. */
  matchModels: string[];
  /** The analyst chat: a cheap model for everyday questions and a stronger one for open questions. */
  analystModels: { routine: string[]; deep: string[] };
  monthlyBudgetUsd: number;
}

export function loadAiConfig(env: Record<string, string | undefined>): AiConfig {
  const budget = Number(env.AI_MONTHLY_BUDGET_USD ?? '2');
  return {
    enabled: ['on', '1', 'true'].includes((env.AI_ENABLED ?? '').trim().toLowerCase()),
    apiKey: (env.OPENROUTER_API_KEY ?? '').trim() || null,
    models: [env.AI_MODEL?.trim() || 'anthropic/claude-haiku-5.5', env.AI_FALLBACK_MODEL?.trim() || 'openai/gpt-6-luna'],
    matchModels: [env.AI_MATCH_MODEL?.trim() || 'openai/gpt-6-luna', 'google/gemini-3.1-flash-lite'],
    analystModels: {
      routine: [env.AI_ANALYST_MODEL?.trim() || 'anthropic/claude-haiku-5.5', 'openai/gpt-5.6-luna'],
      deep: [env.AI_ANALYST_DEEP_MODEL?.trim() || 'anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5'],
    },
    monthlyBudgetUsd: Number.isFinite(budget) && budget >= 0 ? budget : 2,
  };
}

const describeMatch = (r: MatcherResult) => (r.asked === 0 && r.stoppedBy === null ? '' : `; pairs: asked ${r.asked}, joined ${r.joined}, dismissed ${r.dismissed}, left to you ${r.suggested}${r.stoppedBy ? `, stopped by ${r.stoppedBy}` : ''}`);

const describe = (r: CategorizerResult) =>
  r.asked === 0 && r.stoppedBy === null ? 'nothing new to categorize' : `asked ${r.asked}, applied ${r.applied}, suggested ${r.suggested}, dropped ${r.dropped}, cost US$ ${r.costUsd.toFixed(4)}${r.stoppedBy ? `, stopped by ${r.stoppedBy}` : ''}`;

/** One pass of the categorizer, with the outcome saved where the screens can show it. */
export async function runCategorizerOnce(store: Store, config: AiConfig, now: () => Date, client?: AiClient): Promise<CategorizerResult | null> {
  const save = (lastResult: string) => store.setSetting(AI_JOB_KEY, JSON.stringify({ enabled: config.enabled && config.apiKey !== null, model: config.models[0], monthlyBudget: config.monthlyBudgetUsd, lastRunAt: now().toISOString(), lastResult }), now().toISOString());
  if (!config.enabled || (!config.apiKey && !client)) {
    store.setSetting(AI_JOB_KEY, JSON.stringify({ enabled: false, model: config.models[0], monthlyBudget: config.monthlyBudgetUsd, lastRunAt: null, lastResult: config.enabled ? 'no API key' : 'off' }), now().toISOString());
    return null;
  }
  try {
    const ai = client ?? openRouterClient(config.apiKey!);
    const result = await categorizePending(store, { client: ai, models: config.models, now, monthlyBudgetUsd: config.monthlyBudgetUsd });
    const matched = await matchPending(store, { client: ai, models: config.matchModels, now, monthlyBudgetUsd: config.monthlyBudgetUsd, rebuild: () => void runReconciliation(store, { now }) });
    save(describe(result) + describeMatch(matched));
    return result;
  } catch (error) {
    save(`failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Runs the categorizer now and then every `intervalMs`, until the signal aborts. Cheap when nothing is new. */
export function startAiLoop(store: Store, config: AiConfig, signal: AbortSignal, onLine: (line: string) => void, intervalMs = 10 * 60_000): void {
  const tick = async () => {
    if (signal.aborted) return;
    // Read the key's real spend first, so the budget check in this pass sees calls made outside the app too.
    if (config.enabled && config.apiKey) await refreshKeyUsage(store, config.apiKey, new Date());
    const result = await runCategorizerOnce(store, config, () => new Date());
    if (result && (result.asked > 0 || result.stoppedBy)) onLine(`ai: ${describe(result)}`);
  };
  setTimeout(() => void tick(), 30_000);
  const timer = setInterval(() => void tick(), intervalMs);
  signal.addEventListener('abort', () => clearInterval(timer));
}

export type AiRunScope = { kind: 'pending' } | { kind: 'all' } | { kind: 'transaction'; id: string };

export interface AiRunReply extends CategorizerResult {
  scope: AiRunScope['kind'];
}

/** Passes in one "all" run; each pass handles up to 200 descriptions, and the budget stops it sooner. */
const MAX_PASSES = 5;

/**
 * Asks the model on demand. `pending`: what has no answer yet. `all`: forgets the answers the model gave and the
 * ones it left to the owner (kept: what the owner accepted or rejected), then asks again. `transaction`: asks about
 * the description of one transaction, again, even when it was answered before.
 */
export async function runCategorizerNow(store: Store, config: AiConfig, now: () => Date, scope: AiRunScope, client?: AiClient): Promise<AiRunReply> {
  if (!config.enabled || (!config.apiKey && !client)) throw new RangeError('A IA está desligada');
  const ai = client ?? openRouterClient(config.apiKey!);
  const options = { client: ai, models: config.models, now, monthlyBudgetUsd: config.monthlyBudgetUsd };
  if (scope.kind === 'transaction') {
    const found = effectiveTransactions(store, { includeHidden: true, includeExcluded: true }).find((t) => t.id === scope.id);
    const key = found ? ruleKey(found.description) : '';
    if (!found || key === '') throw new RangeError('Transação não encontrada');
    return { ...(await categorizePending(store, { ...options, only: key })), scope: 'transaction' };
  }
  if (scope.kind === 'all') resetDecisions(store, ['applied', 'suggested', 'skipped'], now());
  const total: AiRunReply = { scope: scope.kind, asked: 0, applied: 0, suggested: 0, dropped: 0, costUsd: 0, stoppedBy: null };
  for (let pass = 0; pass < (scope.kind === 'all' ? MAX_PASSES : 1); pass++) {
    const result = await categorizePending(store, options);
    total.asked += result.asked;
    total.applied += result.applied;
    total.suggested += result.suggested;
    total.dropped += result.dropped;
    total.costUsd += result.costUsd;
    total.stoppedBy = result.stoppedBy;
    if (result.asked === 0 || result.stoppedBy) break;
  }
  store.setSetting(AI_JOB_KEY, JSON.stringify({ enabled: true, model: config.models[0], monthlyBudget: config.monthlyBudgetUsd, lastRunAt: now().toISOString(), lastResult: describe(total) }), now().toISOString());
  return total;
}
