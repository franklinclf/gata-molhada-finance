import type { SourceAdapter } from '../core/adapter.ts';
import { DATA_START, startOfLocalDay } from '../core/time.ts';
import { resetDecisions } from '../api/ai.ts';
import { runReconciliation } from '../reconcile/run.ts';
import type { Store } from '../store/store.ts';
import { syncSource } from './sync.ts';

export type ResetMode = 'soft' | 'hard';

export interface ResetState {
  running: boolean;
  mode: ResetMode | null;
  /** What the job is doing now, for the screen. */
  step: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  result: 'completed' | 'failed' | null;
  /** What the last run did. */
  summary: string | null;
  error: string | null;
}

export type StartResult = { started: true } | { started: false; reason: string };

export interface Resetter {
  state(): ResetState;
  start(mode: ResetMode): StartResult;
}

export interface ResetDeps {
  store: Store;
  adapter: SourceAdapter;
  now?: () => Date;
  /** Writes a copy of the database before a hard reset; returns where it went. Absent: a hard reset refuses to run. */
  backup?: () => string;
  /** Runs the categorizer after the rebuild. Absent when the AI is off. */
  categorize?: () => Promise<string | null>;
}

const IDLE: ResetState = { running: false, mode: null, step: null, startedAt: null, finishedAt: null, result: null, summary: null, error: null };

/**
 * Reads everything the source still has since the data start and passes it through reconciliation and categorization
 * again, in the background.
 * - soft: reads and rebuilds, as any read does (what the source no longer returns is removed, unless most of the records
 *   vanish at once, which looks like a bad read and only gives a warning), and what the AI decided by itself is asked again.
 * - hard: the same without that guard, after a copy of the database, so the saved records match what the source has now.
 *   The removal happens only after the read worked, never before.
 * The owner's own choices (categories, rules, overrides, manual transactions) are kept in both.
 */
export function createResetter(deps: ResetDeps): Resetter {
  const { store, adapter } = deps;
  const now = deps.now ?? (() => new Date());
  let state: ResetState = IDLE;

  const progress = (step: string) => {
    state = { ...state, step };
  };

  async function job(mode: ResetMode): Promise<void> {
    const parts: string[] = [];
    try {
      if (mode === 'hard') {
        // A hard reset removes records, so it never runs without a copy to go back to.
        if (!deps.backup) throw new Error('a leitura completa precisa de uma cópia do banco antes de remover registros, e a cópia não está disponível');
        progress('Guardando uma cópia do banco');
        parts.push(`cópia em ${deps.backup()}`);
      }
      progress('Lendo tudo que o Meu Pluggy tem desde o início dos dados');
      const since = new Date(startOfLocalDay(DATA_START));
      const result = await syncSource(adapter, { store, now }, since, { fullWindow: mode === 'hard' });
      if (result.errors.length > 0) throw new Error(result.errors.join('; '));
      parts.push(`${result.transactions} transações, ${result.accounts} contas e ${result.bills} faturas lidas`);
      if (result.warnings.length > 0) parts.push(result.warnings.join('; '));

      progress('Refazendo contas, transações e conferências');
      runReconciliation(store, { now });

      progress('Esquecendo o que a IA decidiu sozinha');
      const reset = resetDecisions(store, ['applied', 'suggested', 'skipped'], now());
      if (reset.ok) parts.push(`${reset.reset} decisões da IA para refazer`);

      if (deps.categorize) {
        progress('Categorizando de novo');
        const line = await deps.categorize();
        if (line) parts.push(line);
      }
      state = { ...state, running: false, step: null, finishedAt: now().toISOString(), result: 'completed', summary: parts.join(' · '), error: null };
    } catch (error) {
      state = { ...state, running: false, step: null, finishedAt: now().toISOString(), result: 'failed', summary: parts.join(' · ') || null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    state: () => state,
    start(mode) {
      if (state.running) return { started: false, reason: 'another reset is still running' };
      state = { running: true, mode, step: 'Começando', startedAt: now().toISOString(), finishedAt: null, result: null, summary: null, error: null };
      void job(mode);
      return { started: true };
    },
  };
}
