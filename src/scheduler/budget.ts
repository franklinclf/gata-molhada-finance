import type { RefreshLogEntry } from '../store/store.ts';

/** Reads the bank network allows per month for one institution and product (transactions). */
export const MONTHLY_LIMIT = 240;

export type BudgetLevel = 'ok' | 'warn' | 'blocked';

export interface BudgetOptions {
  monthlyLimit?: number;
  /** Fraction of the limit at which a warning starts. Defaults to 0.7. */
  warnAt?: number;
  /** Fraction of the limit at which manual refreshes are blocked. Defaults to 0.9. */
  blockAt?: number;
}

export interface InstitutionBudget {
  institutionKey: string;
  institution: string;
  used: number;
  limit: number;
  level: BudgetLevel;
  /** The source reported that the bank refused further reads this month. */
  exhausted: boolean;
}

export interface BudgetInput {
  institutionKey: string;
  institution: string;
  used: number;
  exhausted: boolean;
}

export function assessBudget(inputs: BudgetInput[], options: BudgetOptions = {}): InstitutionBudget[] {
  const limit = options.monthlyLimit ?? MONTHLY_LIMIT;
  const warnAt = options.warnAt ?? 0.7;
  const blockAt = options.blockAt ?? 0.9;
  return inputs.map((i) => {
    const ratio = i.used / limit;
    const level: BudgetLevel = i.exhausted || ratio >= blockAt ? 'blocked' : ratio >= warnAt ? 'warn' : 'ok';
    return { ...i, limit, level };
  });
}

export interface RefreshPolicyInput {
  now: Date;
  lastRefresh: RefreshLogEntry | null;
  budget: InstitutionBudget[];
  /** Skip the spacing and budget checks. A refresh that is still running always blocks. */
  force?: boolean;
  /** Minimum gap between two refresh requests. Defaults to 15 minutes. */
  minIntervalMs?: number;
  /** How long a refresh without a finish time is considered still running. Defaults to 5 minutes. */
  runningMs?: number;
}

export interface RefreshDecision {
  allowed: boolean;
  reasons: string[];
}

export function canRequestRefresh(input: RefreshPolicyInput): RefreshDecision {
  const minIntervalMs = input.minIntervalMs ?? 15 * 60_000;
  const runningMs = input.runningMs ?? 5 * 60_000;
  const reasons: string[] = [];
  const last = input.lastRefresh;

  if (last !== null) {
    const age = input.now.getTime() - new Date(last.requestedAt).getTime();
    if (last.status === 'requested' && age < runningMs) {
      return { allowed: false, reasons: [`another refresh is still running (requested at ${last.requestedAt})`] };
    }
    if (!input.force && age < minIntervalMs) {
      reasons.push(`the last refresh was ${Math.floor(age / 60_000)} minutes ago (minimum ${Math.round(minIntervalMs / 60_000)})`);
    }
  }

  if (!input.force) {
    const exhausted = input.budget.filter((b) => b.exhausted).map((b) => b.institution);
    if (exhausted.length > 0) reasons.push(`the bank read limit was reached for ${exhausted.join(', ')}`);
    const nearly = input.budget.filter((b) => b.level === 'blocked' && !b.exhausted).map((b) => `${b.institution} (${b.used} of ${b.limit})`);
    if (nearly.length > 0) reasons.push(`almost all bank reads of the month are used for ${nearly.join(', ')}`);
  }
  return { allowed: reasons.length === 0, reasons };
}
