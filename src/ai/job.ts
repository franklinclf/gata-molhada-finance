import type { Store } from '../store/store.ts';
import { AI_JOB_KEY } from '../api/ai.ts';
import { runReconciliation } from '../reconcile/run.ts';
import { categorizePending, type CategorizerResult } from './categorizer.ts';
import { matchPending, type MatcherResult } from './matcher.ts';
import { openRouterClient, type AiClient } from './openrouter.ts';

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
    const result = await runCategorizerOnce(store, config, () => new Date());
    if (result && (result.asked > 0 || result.stoppedBy)) onLine(`ai: ${describe(result)}`);
  };
  setTimeout(() => void tick(), 30_000);
  const timer = setInterval(() => void tick(), intervalMs);
  signal.addEventListener('abort', () => clearInterval(timer));
}
