import type { Store } from '../store/store.ts';
import { AI_JOB_KEY } from '../api/ai.ts';
import { categorizePending, type CategorizerResult } from './categorizer.ts';
import { openRouterClient, type AiClient } from './openrouter.ts';

export interface AiConfig {
  enabled: boolean;
  apiKey: string | null;
  models: string[];
  monthlyBudgetUsd: number;
}

export function loadAiConfig(env: Record<string, string | undefined>): AiConfig {
  const budget = Number(env.AI_MONTHLY_BUDGET_USD ?? '2');
  return {
    enabled: ['on', '1', 'true'].includes((env.AI_ENABLED ?? '').trim().toLowerCase()),
    apiKey: (env.OPENROUTER_API_KEY ?? '').trim() || null,
    models: [env.AI_MODEL?.trim() || 'anthropic/claude-haiku-5.5', env.AI_FALLBACK_MODEL?.trim() || 'openai/gpt-6-luna'],
    monthlyBudgetUsd: Number.isFinite(budget) && budget >= 0 ? budget : 2,
  };
}

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
    const result = await categorizePending(store, { client: client ?? openRouterClient(config.apiKey!), models: config.models, now, monthlyBudgetUsd: config.monthlyBudgetUsd });
    save(describe(result));
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
